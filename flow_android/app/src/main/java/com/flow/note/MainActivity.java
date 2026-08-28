package com.flow.note;

import android.app.Activity;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.content.SharedPreferences;
import android.text.format.Formatter;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
    private WebView mWebView;
    private final int TARGET_PORT = 3939;
    private AtomicBoolean found = new AtomicBoolean(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        mWebView = new WebView(this);
        setContentView(mWebView);

        WebSettings webSettings = mWebView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
        
        mWebView.setWebViewClient(new WebViewClient());
        
        String loadingHtml = "<html><body style='display:flex;justify-content:center;align-items:center;height:100%;font-family:sans-serif;background:#242424;color:white;text-align:center;'><h2>Scanning Wi-Fi Network<br>for Flow Whiteboard...</h2></body></html>";
        mWebView.loadData(loadingHtml, "text/html", "UTF-8");

        scanNetwork();
    }

    private void scanNetwork() {
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        int ipAddress = wm.getConnectionInfo().getIpAddress();
        
        if (ipAddress == 0) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, "Please connect to Wi-Fi!", Toast.LENGTH_LONG).show();
                }
            });
            return;
        }
        
        // Deprecated but completely functional for simple local network IP gathering
        @SuppressWarnings("deprecation")
        String ipString = Formatter.formatIpAddress(ipAddress);
        Log.d("FlowApp", "My IP: " + ipString);
        
        final String prefix = ipString.substring(0, ipString.lastIndexOf('.') + 1);
        Log.d("FlowApp", "Scanning subnet: " + prefix + "x");
        
        // 40 threads to aggressively scan the local subnet
        ExecutorService executor = Executors.newFixedThreadPool(40);
        
        for (int i = 1; i <= 254; i++) {
            final String targetIp = prefix + i;
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    if (found.get()) return;
                    
                    try {
                        Socket socket = new Socket();
                        // Try to connect to port 3939 with a 600ms timeout
                        socket.connect(new InetSocketAddress(targetIp, TARGET_PORT), 600);
                        socket.close();
                        
                        if (found.compareAndSet(false, true)) {
                            final String url = "http://" + targetIp + ":" + TARGET_PORT;
                            Log.d("FlowApp", "Found server at: " + url);
                            
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    Toast.makeText(MainActivity.this, "Found Server!", Toast.LENGTH_SHORT).show();
                                    mWebView.loadUrl(url);
                                }
                            });
                        }
                    } catch (Exception e) {
                        // Port is closed or timeout, silently ignore
                    }
                }
            });
        }
    }
}
