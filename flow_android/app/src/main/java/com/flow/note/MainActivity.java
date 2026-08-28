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
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.widget.Toast;

import java.io.InputStream;
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
        
        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                String path = request.getUrl().getPath();
                
                // Only intercept our own server port requests to guarantee offline loading
                if (url.contains(":" + TARGET_PORT)) {
                    try {
                        if (path.equals("/") || path.equals("/index.html")) {
                            InputStream is = getAssets().open("web/index.html");
                            return new WebResourceResponse("text/html", "UTF-8", is);
                        } else if (path.equals("/app.js")) {
                            InputStream is = getAssets().open("web/app.js");
                            return new WebResourceResponse("application/javascript", "UTF-8", is);
                        } else if (path.equals("/style.css")) {
                            InputStream is = getAssets().open("web/style.css");
                            return new WebResourceResponse("text/css", "UTF-8", is);
                        }
                    } catch (Exception e) {
                        Log.e("FlowApp", "Asset load error: " + e.getMessage());
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }
        });
        
        String loadingHtml = "<html><body style='display:flex;justify-content:center;align-items:center;height:100%;font-family:sans-serif;background:#242424;color:white;text-align:center;'><h2>Scanning Wi-Fi Network<br>for Flow Whiteboard...</h2></body></html>";
        mWebView.loadData(loadingHtml, "text/html", "UTF-8");

        scanNetwork();
    }

    private void scanNetwork() {
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        int ipAddress = wm.getConnectionInfo().getIpAddress();
        final SharedPreferences prefs = getSharedPreferences("FlowPrefs", MODE_PRIVATE);
        final String lastIp = prefs.getString("last_ip", null);
        
        if (ipAddress == 0) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (lastIp != null) {
                        Toast.makeText(MainActivity.this, "Offline mode. Loading local app copy...", Toast.LENGTH_LONG).show();
                        mWebView.loadUrl("http://" + lastIp + ":" + TARGET_PORT);
                    } else {
                        Toast.makeText(MainActivity.this, "Please connect to Wi-Fi!", Toast.LENGTH_LONG).show();
                    }
                }
            });
            return;
        }
        
        @SuppressWarnings("deprecation")
        String ipString = Formatter.formatIpAddress(ipAddress);
        final String prefix = ipString.substring(0, ipString.lastIndexOf('.') + 1);
        
        ExecutorService executor = Executors.newFixedThreadPool(40);
        
        for (int i = 1; i <= 254; i++) {
            final String targetIp = prefix + i;
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    if (found.get()) return;
                    
                    try {
                        Socket socket = new Socket();
                        socket.connect(new InetSocketAddress(targetIp, TARGET_PORT), 600);
                        socket.close();
                        
                        if (found.compareAndSet(false, true)) {
                            prefs.edit().putString("last_ip", targetIp).apply();
                            final String url = "http://" + targetIp + ":" + TARGET_PORT;
                            
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    Toast.makeText(MainActivity.this, "Connected!", Toast.LENGTH_SHORT).show();
                                    mWebView.loadUrl(url);
                                }
                            });
                        }
                    } catch (Exception e) {}
                }
            });
        }
        
        // Timeout fallback for when connected to WiFi but server is down
        new Thread(new Runnable() {
            @Override
            public void run() {
                try { Thread.sleep(2000); } catch (Exception e) {}
                if (!found.get() && lastIp != null) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "Server not found. Loading local app copy...", Toast.LENGTH_LONG).show();
                            mWebView.loadUrl("http://" + lastIp + ":" + TARGET_PORT);
                        }
                    });
                }
            }
        }).start();
    }
}
