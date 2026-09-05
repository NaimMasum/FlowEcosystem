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
import android.app.ProgressDialog;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.provider.Settings;
import android.widget.EditText;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

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
    private final static int INSTALL_PERMISSION_REQUEST_CODE = 1002;

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

        @JavascriptInterface
        public void checkForUpdate() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    String lastIp = getSharedPreferences("FlowPrefs", MODE_PRIVATE).getString("last_ip", "");
                    if (!lastIp.isEmpty()) {
                        checkAppUpdate(lastIp, true);
                    } else {
                        Toast.makeText(MainActivity.this, "Please connect to a server first", Toast.LENGTH_SHORT).show();
                    }
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

                    // Automatically check if an updated APK is available on the server
                    checkAppUpdate(ip, false);
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

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Flow Whiteboard Menu");

        String connectLabel = lastIp.isEmpty() ? "🔌 Connect to IP" : "🔌 Connect to " + lastIp;
        String[] options = new String[] {
            connectLabel,
            "🚀 Check for App Update",
            "🔍 Rescan Local Network",
            "📴 Offline Mode"
        };

        builder.setItems(options, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                if (which == 0) {
                    promptEnterIp();
                } else if (which == 1) {
                    if (!lastIp.isEmpty()) {
                        checkAppUpdate(lastIp, true);
                    } else {
                        Toast.makeText(MainActivity.this, "Please connect to a server first", Toast.LENGTH_SHORT).show();
                        promptEnterIp();
                    }
                } else if (which == 2) {
                    scanNetwork();
                } else if (which == 3) {
                    Toast.makeText(MainActivity.this, "Offline mode active.", Toast.LENGTH_SHORT).show();
                    loadApp(lastIp.isEmpty() ? "127.0.0.1" : lastIp);
                }
            }
        });

        builder.setNegativeButton("Close", null);
        builder.show();
    }

    private void promptEnterIp() {
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
        builder.setTitle("Connect to Server");
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

        builder.setNegativeButton("Cancel", null);
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

    // ─────────────────────────────────────────────────────────────
    // IN-APP UPDATE SYSTEM
    // ─────────────────────────────────────────────────────────────
    private void checkAppUpdate(final String ip, final boolean userTriggered) {
        if (userTriggered) {
            Toast.makeText(this, "Checking for update on " + ip + "...", Toast.LENGTH_SHORT).show();
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    URL url = new URL("http://" + ip + ":" + NOTE_PORT + "/api/app-version");
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(4000);
                    conn.setReadTimeout(5000);

                    if (conn.getResponseCode() != 200) {
                        if (userTriggered) {
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    Toast.makeText(MainActivity.this, "Server does not support update check", Toast.LENGTH_SHORT).show();
                                }
                            });
                        }
                        return;
                    }

                    InputStream is = conn.getInputStream();
                    byte[] buffer = new byte[1024];
                    StringBuilder sb = new StringBuilder();
                    int read;
                    while ((read = is.read(buffer)) != -1) {
                        sb.append(new String(buffer, 0, read));
                    }
                    is.close();

                    JSONObject json = new JSONObject(sb.toString());
                    boolean available = json.optBoolean("available", false);
                    if (!available) {
                        if (userTriggered) {
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    Toast.makeText(MainActivity.this, "No APK build found on server", Toast.LENGTH_SHORT).show();
                                }
                            });
                        }
                        return;
                    }

                    final long serverMtime = json.optLong("mtime", 0);
                    final String serverMd5 = json.optString("md5", "");
                    final long size = json.optLong("size", 0);
                    final String dateStr = json.optString("date", "");
                    final String apkUrl = json.optString("url", "/app.apk");

                    SharedPreferences prefs = getSharedPreferences("FlowPrefs", MODE_PRIVATE);
                    long lastInstalledMtime = prefs.getLong("last_installed_apk_mtime", 0);
                    String lastInstalledMd5 = prefs.getString("last_installed_apk_md5", "");
                    long appUpdateTime = 0;
                    try {
                        PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
                        appUpdateTime = pInfo.lastUpdateTime;
                    } catch (Exception ignored) {}

                    // A new build is available if server mtime is newer than installed app time and different MD5
                    boolean isNewer = (serverMtime > (appUpdateTime + 5000)) && (serverMtime > lastInstalledMtime) && !serverMd5.equals(lastInstalledMd5);

                    if (!isNewer) {
                        if (userTriggered) {
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    Toast.makeText(MainActivity.this, "Flow Note is already up to date!", Toast.LENGTH_SHORT).show();
                                }
                            });
                        }
                        return;
                    }

                    final String sizeMb = String.format(Locale.US, "%.1f MB", size / (1024.0 * 1024.0));

                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            new AlertDialog.Builder(MainActivity.this)
                                .setTitle("🚀 App Update Available")
                                .setMessage("A newer build of Flow Note is available on your PC server.\n\n"
                                        + "• Size: " + sizeMb + "\n"
                                        + (dateStr.isEmpty() ? "" : "• Build Time: " + dateStr + "\n")
                                        + "\nWould you like to download and install this update now?")
                                .setPositiveButton("Update Now", new DialogInterface.OnClickListener() {
                                    @Override
                                    public void onClick(DialogInterface dialog, int which) {
                                        downloadAndInstallApk(ip, apkUrl, serverMtime, serverMd5);
                                    }
                                })
                                .setNegativeButton("Later", null)
                                .show();
                        }
                    });

                } catch (final Exception e) {
                    Log.e("FlowApp", "Update check failed", e);
                    if (userTriggered) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                Toast.makeText(MainActivity.this, "Update check error: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                            }
                        });
                    }
                }
            }
        }).start();
    }

    private void downloadAndInstallApk(final String ip, final String apkUrl, final long serverMtime, final String serverMd5) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!getPackageManager().canRequestPackageInstalls()) {
                new AlertDialog.Builder(this)
                    .setTitle("Permission Required")
                    .setMessage("Android requires permission to install updates from Flow Note. Please enable 'Install unknown apps' in settings, then tap Update again.")
                    .setPositiveButton("Open Settings", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getPackageName()));
                            startActivityForResult(intent, INSTALL_PERMISSION_REQUEST_CODE);
                        }
                    })
                    .setNegativeButton("Cancel", null)
                    .show();
                return;
            }
        }

        final ProgressDialog progressDialog = new ProgressDialog(this);
        progressDialog.setTitle("Updating Flow Note");
        progressDialog.setMessage("Downloading update from server...");
        progressDialog.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        progressDialog.setIndeterminate(false);
        progressDialog.setMax(100);
        progressDialog.setCancelable(false);
        progressDialog.show();

        new Thread(new Runnable() {
            @Override
            public void run() {
                File apkFile = new File(getCacheDir(), "update.apk");
                try {
                    URL url = new URL("http://" + ip + ":" + NOTE_PORT + apkUrl);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(30000);
                    int fileLength = conn.getContentLength();

                    InputStream input = conn.getInputStream();
                    FileOutputStream output = new FileOutputStream(apkFile);

                    byte[] data = new byte[8192];
                    long total = 0;
                    int count;
                    while ((count = input.read(data)) != -1) {
                        total += count;
                        output.write(data, 0, count);
                        if (fileLength > 0) {
                            final int progress = (int) (total * 100 / fileLength);
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    progressDialog.setProgress(progress);
                                }
                            });
                        }
                    }

                    output.flush();
                    output.close();
                    input.close();

                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            progressDialog.dismiss();
                            launchApkInstaller(apkFile, serverMtime, serverMd5);
                        }
                    });

                } catch (final Exception e) {
                    Log.e("FlowApp", "Update download failed", e);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            progressDialog.dismiss();
                            Toast.makeText(MainActivity.this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
                        }
                    });
                }
            }
        }).start();
    }

    private void launchApkInstaller(File apkFile, long serverMtime, String serverMd5) {
        try {
            getSharedPreferences("FlowPrefs", MODE_PRIVATE).edit()
                    .putLong("last_installed_apk_mtime", serverMtime)
                    .putString("last_installed_apk_md5", serverMd5)
                    .apply();

            Uri apkUri = Uri.parse("content://" + GenericFileProvider.AUTHORITY + "/" + apkFile.getName());
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Log.e("FlowApp", "Failed to launch installer", e);
            Toast.makeText(this, "Could not open installer: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
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
        } else if (requestCode == INSTALL_PERMISSION_REQUEST_CODE) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (getPackageManager().canRequestPackageInstalls()) {
                    Toast.makeText(this, "Permission granted! Tap Check for Update to install.", Toast.LENGTH_SHORT).show();
                    String lastIp = getSharedPreferences("FlowPrefs", MODE_PRIVATE).getString("last_ip", "");
                    if (!lastIp.isEmpty()) {
                        checkAppUpdate(lastIp, true);
                    }
                } else {
                    Toast.makeText(this, "Install permission was not granted.", Toast.LENGTH_SHORT).show();
                }
            }
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
