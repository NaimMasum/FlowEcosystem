package com.flow.note;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import org.json.JSONArray;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
    private WebView mWebView;
    private final int NOTE_PORT = 3939;
    private final int PDF_PORT = 4040;
    private AtomicBoolean found = new AtomicBoolean(false);
    private ValueCallback<Uri[]> mUploadMessage;
    private final static int FILECHOOSER_RESULTCODE = 1;

    public class WebAppInterface {
        @JavascriptInterface
        public void showServerDialog() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    promptManualIp();
                }
            });
        }

        @JavascriptInterface
        public void rescan() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    scanNetwork();
                }
            });
        }
    }

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
        
        mWebView.addJavascriptInterface(new WebAppInterface(), "AndroidBridge");

        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (mUploadMessage != null) {
                    mUploadMessage.onReceiveValue(null);
                }
                mUploadMessage = filePathCallback;

                Intent contentSelectionIntent = new Intent(Intent.ACTION_GET_CONTENT);
                contentSelectionIntent.addCategory(Intent.CATEGORY_OPENABLE);
                contentSelectionIntent.setType("*/*");

                Intent chooserIntent = new Intent(Intent.ACTION_CHOOSER);
                chooserIntent.putExtra(Intent.EXTRA_INTENT, contentSelectionIntent);
                chooserIntent.putExtra(Intent.EXTRA_TITLE, "Choose File");

                startActivityForResult(chooserIntent, FILECHOOSER_RESULTCODE);
                return true;
            }
        });
        
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
                                WebResourceResponse response = new WebResourceResponse(mime, "UTF-8", new FileInputStream(localFile));
                                java.util.Map<String, String> headers = new java.util.HashMap<>();
                                headers.put("Access-Control-Allow-Origin", "*");
                                headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                                headers.put("Access-Control-Allow-Headers", "*");
                                response.setResponseHeaders(headers);
                                return response;
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
                        
                        WebResourceResponse response = new WebResourceResponse(mime, "UTF-8", is);
                        java.util.Map<String, String> headers = new java.util.HashMap<>();
                        headers.put("Access-Control-Allow-Origin", "*");
                        headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                        headers.put("Access-Control-Allow-Headers", "*");
                        response.setResponseHeaders(headers);
                        return response;
                    }
                } catch (Exception e) {
                    Log.e("FlowApp", "Asset load error: " + e.getMessage());
                }
                
                return super.shouldInterceptRequest(view, request);
            }
        });
        
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

    private Set<String> getSubnetPrefixes() {
        Set<String> prefixes = new LinkedHashSet<>();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces != null) {
                while (interfaces.hasMoreElements()) {
                    NetworkInterface iface = interfaces.nextElement();
                    if (iface.isLoopback() || !iface.isUp()) continue;
                    Enumeration<InetAddress> addresses = iface.getInetAddresses();
                    while (addresses.hasMoreElements()) {
                        InetAddress addr = addresses.nextElement();
                        if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                            String host = addr.getHostAddress();
                            if (host != null && !host.startsWith("127.")) {
                                int lastDot = host.lastIndexOf('.');
                                if (lastDot > 0) {
                                    prefixes.add(host.substring(0, lastDot + 1));
                                }
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            Log.e("FlowApp", "Error discovering subnets", e);
        }

        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null && wm.getConnectionInfo() != null) {
                int ip = wm.getConnectionInfo().getIpAddress();
                if (ip != 0) {
                    String ipStr = String.format(Locale.US, "%d.%d.%d.%d",
                            (ip & 0xff), (ip >> 8 & 0xff), (ip >> 16 & 0xff), (ip >> 24 & 0xff));
                    int lastDot = ipStr.lastIndexOf('.');
                    if (lastDot > 0) prefixes.add(ipStr.substring(0, lastDot + 1));
                }
            }
        } catch (Exception ignored) {}

        return prefixes;
    }

    private void scanNetwork() {
        found.set(false);
        final SharedPreferences prefs = getSharedPreferences("FlowPrefs", MODE_PRIVATE);
        final String lastIp = prefs.getString("last_ip", null);

        String scanningHtml = "<html><body style='display:flex;flex-direction:column;justify-content:center;align-items:center;height:100%;font-family:sans-serif;background:#242424;color:white;text-align:center;margin:0;padding:20px;box-sizing:border-box;'>"
                + "<div style='font-size:36px;margin-bottom:16px;'>&#128269;</div>"
                + "<h2 style='margin:0 0 10px 0;'>Connecting to Flow Whiteboard...</h2>"
                + "<p style='color:#aaa;margin:0;font-size:14px;'>Searching on current network &amp; Tailscale</p>"
                + "</body></html>";
        mWebView.loadData(scanningHtml, "text/html", "UTF-8");

        final ExecutorService executor = Executors.newFixedThreadPool(60);

        // 1. High-priority check for last known IP if available
        if (lastIp != null && !lastIp.isEmpty()) {
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    checkAndConnect(lastIp, "Reconnected to last server", 600);
                }
            });
        }

        // 2. High-priority check for known Tailscale IP
        final String tailscaleIp = "100.100.40.92";
        executor.execute(new Runnable() {
            @Override
            public void run() {
                checkAndConnect(tailscaleIp, "Connected via Tailscale! Syncing...", 1000);
            }
        });

        // 3. Discover and scan all active network subnets
        Set<String> prefixes = getSubnetPrefixes();
        if (lastIp != null && lastIp.contains(".")) {
            int lastDot = lastIp.lastIndexOf('.');
            if (lastDot > 0) prefixes.add(lastIp.substring(0, lastDot + 1));
        }

        // Build list of target host numbers in prioritized order
        List<Integer> hostOrder = new ArrayList<>();
        // Priority 1: Common DHCP pool start (100 to 115)
        for (int i = 100; i <= 115; i++) hostOrder.add(i);
        // Priority 2: Low IPs (2 to 30)
        for (int i = 2; i <= 30; i++) hostOrder.add(i);
        // Priority 3: Gateway (1)
        hostOrder.add(1);
        // Priority 4: Rest of subnet (31 to 99, 116 to 254)
        for (int i = 31; i <= 99; i++) hostOrder.add(i);
        for (int i = 116; i <= 254; i++) hostOrder.add(i);

        for (String prefix : prefixes) {
            for (int hostNum : hostOrder) {
                final String targetIp = prefix + hostNum;
                executor.execute(new Runnable() {
                    @Override
                    public void run() {
                        checkAndConnect(targetIp, "Connected via Wi-Fi! Syncing...", 450);
                    }
                });
            }
        }

        // 4. Fallback handler after scan finishes or times out
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    executor.shutdown();
                    executor.awaitTermination(3800, TimeUnit.MILLISECONDS);
                } catch (Exception ignored) {}

                if (!found.get()) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            promptManualIp();
                        }
                    });
                }
            }
        }).start();
    }

    private void checkAndConnect(final String ip, final String successMsg, int timeoutMs) {
        if (found.get()) return;
        try {
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress(ip, NOTE_PORT), timeoutMs);
            socket.close();

            if (found.compareAndSet(false, true)) {
                getSharedPreferences("FlowPrefs", MODE_PRIVATE).edit().putString("last_ip", ip).apply();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, successMsg, Toast.LENGTH_SHORT).show();
                        loadApp(ip);
                        syncOfflineFiles(ip);
                    }
                });
            }
        } catch (Exception ignored) {}
    }

    private void promptManualIp() {
        final SharedPreferences prefs = getSharedPreferences("FlowPrefs", MODE_PRIVATE);
        final String lastIp = prefs.getString("last_ip", "");
        
        Set<String> prefixes = getSubnetPrefixes();
        StringBuilder hint = new StringBuilder();
        if (!prefixes.isEmpty()) {
            hint.append("Detected subnets: ");
            for (String p : prefixes) {
                hint.append(p).append("x ");
            }
        }

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Connect to Flow Whiteboard");
        builder.setMessage((hint.length() > 0 ? hint.toString() + "\n\n" : "") + "Enter PC IP Address (e.g. 192.168.0.102):");

        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_PHONE | InputType.TYPE_CLASS_TEXT);
        input.setHint("e.g. 192.168.0.102");
        if (!lastIp.isEmpty()) {
            input.setText(lastIp);
            input.setSelection(input.getText().length());
        } else if (!prefixes.isEmpty()) {
            input.setText(prefixes.iterator().next());
            input.setSelection(input.getText().length());
        }
        builder.setView(input);

        builder.setPositiveButton("Connect", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                final String enteredIp = input.getText().toString().trim();
                if (!enteredIp.isEmpty()) {
                    testAndConnect(enteredIp);
                }
            }
        });

        builder.setNeutralButton("Rescan", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                scanNetwork();
            }
        });

        builder.setNegativeButton("Offline Mode", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                Toast.makeText(MainActivity.this, "Offline mode active.", Toast.LENGTH_SHORT).show();
                loadApp(lastIp.isEmpty() ? "127.0.0.1" : lastIp);
            }
        });

        builder.setCancelable(false);
        builder.show();
    }

    private void testAndConnect(final String ip) {
        Toast.makeText(this, "Testing " + ip + "...", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                boolean reachable = false;
                try {
                    Socket socket = new Socket();
                    socket.connect(new InetSocketAddress(ip, NOTE_PORT), 1500);
                    socket.close();
                    reachable = true;
                } catch (Exception ignored) {}

                final boolean success = reachable;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (success) {
                            found.set(true);
                            getSharedPreferences("FlowPrefs", MODE_PRIVATE).edit().putString("last_ip", ip).apply();
                            Toast.makeText(MainActivity.this, "Connected to " + ip + "!", Toast.LENGTH_SHORT).show();
                            loadApp(ip);
                            syncOfflineFiles(ip);
                        } else {
                            Toast.makeText(MainActivity.this, "Could not reach " + ip + ":" + NOTE_PORT + ". Make sure PC server is running!", Toast.LENGTH_LONG).show();
                            promptManualIp();
                        }
                    }
                });
            }
        }).start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent intent) {
        if (requestCode == FILECHOOSER_RESULTCODE) {
            if (null == mUploadMessage) return;
            Uri result = intent == null || resultCode != RESULT_OK ? null : intent.getData();
            if (result != null) {
                mUploadMessage.onReceiveValue(new Uri[]{result});
            } else {
                mUploadMessage.onReceiveValue(null);
            }
            mUploadMessage = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (mWebView != null && mWebView.canGoBack()) {
            mWebView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
