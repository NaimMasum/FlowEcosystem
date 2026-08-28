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

import org.json.JSONArray;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
    private WebView mWebView;
    private final int NOTE_PORT = 3939;
    private final int PDF_PORT = 3940;
    private AtomicBoolean found = new AtomicBoolean(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        mWebView = new WebView(this);
        setContentView(mWebView);

        WebSettings webSettings = mWebView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setAllowFileAccessFromFileURLs(true);
        webSettings.setAllowUniversalAccessFromFileURLs(true);
        
        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                String path = request.getUrl().getPath();
                
                try {
                    // Intercept Flow Note (3939)
                    if (url.contains(":" + NOTE_PORT)) {
                        if (path.startsWith("/uploads/")) {
                            File localFile = new File(getFilesDir() + path);
                            if (localFile.exists()) {
                                String mime = "application/octet-stream";
                                if (path.endsWith(".png")) mime = "image/png";
                                else if (path.endsWith(".jpg") || path.endsWith(".jpeg")) mime = "image/jpeg";
                                else if (path.endsWith(".pdf")) mime = "application/pdf";
                                return new WebResourceResponse(mime, "UTF-8", new FileInputStream(localFile));
                            }
                        } else if (path.equals("/") || path.equals("/index.html")) {
                            InputStream is = getAssets().open("web/index.html");
                            return new WebResourceResponse("text/html", "UTF-8", is);
                        } else if (path.equals("/app.js")) {
                            InputStream is = getAssets().open("web/app.js");
                            return new WebResourceResponse("application/javascript", "UTF-8", is);
                        } else if (path.equals("/style.css")) {
                            InputStream is = getAssets().open("web/style.css");
                            return new WebResourceResponse("text/css", "UTF-8", is);
                        }
                    }
                    
                    // Intercept Flow PDF Viewer (3940)
                    if (url.contains(":" + PDF_PORT)) {
                        String assetPath = "pdf" + (path.equals("/") ? "/web/viewer.html" : path);
                        InputStream is = getAssets().open(assetPath);
                        
                        String mime = "application/octet-stream";
                        if (path.endsWith(".html")) mime = "text/html";
                        else if (path.endsWith(".js") || path.endsWith(".mjs")) mime = "application/javascript";
                        else if (path.endsWith(".css")) mime = "text/css";
                        else if (path.endsWith(".png")) mime = "image/png";
                        else if (path.endsWith(".json") || path.endsWith(".map")) mime = "application/json";
                        
                        return new WebResourceResponse(mime, "UTF-8", is);
                    }
                } catch (Exception e) {
                    Log.e("FlowApp", "Asset load error: " + e.getMessage());
                }
                
                return super.shouldInterceptRequest(view, request);
            }
        });
        
        String loadingHtml = "<html><body style='display:flex;justify-content:center;align-items:center;height:100%;font-family:sans-serif;background:#242424;color:white;text-align:center;'><h2>Scanning Wi-Fi Network<br>for Flow Whiteboard...</h2></body></html>";
        mWebView.loadData(loadingHtml, "text/html", "UTF-8");

        scanNetwork();
    }

    private void syncOfflineFiles(final String ip) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File uploadsDir = new File(getFilesDir(), "uploads");
                    if (!uploadsDir.exists()) uploadsDir.mkdirs();

                    URL url = new URL("http://" + ip + ":" + NOTE_PORT + "/api/files");
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(3000);
                    InputStream is = conn.getInputStream();
                    
                    int size = is.available();
                    byte[] buffer = new byte[1024];
                    StringBuilder sb = new StringBuilder();
                    int read;
                    while ((read = is.read(buffer)) != -1) {
                        sb.append(new String(buffer, 0, read));
                    }
                    is.close();
                    
                    JSONArray files = new JSONArray(sb.toString());
                    for (int i = 0; i < files.length(); i++) {
                        String filename = files.getString(i);
                        File localFile = new File(uploadsDir, filename);
                        if (!localFile.exists()) {
                            URL fileUrl = new URL("http://" + ip + ":" + NOTE_PORT + "/uploads/" + filename);
                            HttpURLConnection fileConn = (HttpURLConnection) fileUrl.openConnection();
                            InputStream fileIs = fileConn.getInputStream();
                            FileOutputStream fos = new FileOutputStream(localFile);
                            byte[] dlBuffer = new byte[4096];
                            int dlRead;
                            while ((dlRead = fileIs.read(dlBuffer)) != -1) {
                                fos.write(dlBuffer, 0, dlRead);
                            }
                            fos.close();
                            fileIs.close();
                            Log.d("FlowApp", "Downloaded offline file: " + filename);
                        }
                    }
                    
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "Offline Sync Complete", Toast.LENGTH_SHORT).show();
                        }
                    });
                } catch (Exception e) {
                    Log.e("FlowApp", "Sync error", e);
                }
            }
        }).start();
    }

    private void loadApp(String ip) {
        try {
            InputStream is = getAssets().open("web/index.html");
            int size = is.available();
            byte[] buffer = new byte[size];
            is.read(buffer);
            is.close();
            String html = new String(buffer, "UTF-8");
            
            String baseUrl = "http://" + ip + ":" + NOTE_PORT + "/";
            mWebView.loadDataWithBaseURL(baseUrl, html, "text/html", "UTF-8", null);
        } catch (Exception e) {
            Log.e("FlowApp", "Failed to load local HTML", e);
            mWebView.loadUrl("http://" + ip + ":" + NOTE_PORT);
        }
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
                        Toast.makeText(MainActivity.this, "Offline mode. Local files ready.", Toast.LENGTH_LONG).show();
                        loadApp(lastIp);
                    } else {
                        Toast.makeText(MainActivity.this, "Offline mode. Initializing local database...", Toast.LENGTH_LONG).show();
                        loadApp("127.0.0.1");
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
                        socket.connect(new InetSocketAddress(targetIp, NOTE_PORT), 600);
                        socket.close();
                        
                        if (found.compareAndSet(false, true)) {
                            prefs.edit().putString("last_ip", targetIp).apply();
                            
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    Toast.makeText(MainActivity.this, "Connected! Syncing files...", Toast.LENGTH_SHORT).show();
                                    loadApp(targetIp);
                                    syncOfflineFiles(targetIp);
                                }
                            });
                        }
                    } catch (Exception e) {}
                }
            });
        }
        
        new Thread(new Runnable() {
            @Override
            public void run() {
                try { Thread.sleep(2000); } catch (Exception e) {}
                if (!found.get() && lastIp != null) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "Server not found. Local files ready.", Toast.LENGTH_LONG).show();
                            loadApp(lastIp);
                        }
                    });
                } else if (!found.get()) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "Server not found. Initializing local database...", Toast.LENGTH_LONG).show();
                            loadApp("127.0.0.1");
                        }
                    });
                }
            }
        }).start();
    }
}
