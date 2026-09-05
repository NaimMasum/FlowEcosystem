package com.flow.note;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
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
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashSet;
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
    private final int DEFAULT_PORT = 3939;
    private final int[] CANDIDATE_PORTS = new int[] { 3939, 3940, 3941, 3942 };
    private final int PDF_PORT = 4040;
    private AtomicBoolean found = new AtomicBoolean(false);
    private ValueCallback<Uri[]> mUploadMessage;
    private final static int FILECHOOSER_RESULTCODE = 1;
    private final static int INSTALL_PERMISSION_REQUEST_CODE = 1002;

    public static class ServerEntry {
        public String ip;
        public int port;
        public String branch;
        public String name;
        public String version;

        public ServerEntry(String ip, int port, String branch, String name, String version) {
            this.ip = ip;
            this.port = port;
            this.branch = (branch != null && !branch.isEmpty()) ? branch : "unknown";
            this.name = (name != null && !name.isEmpty()) ? name : "Flow Whiteboard";
            this.version = (version != null) ? version : "";
        }
    }

    private int getConnectedPort() {
        return getSharedPreferences("FlowPrefs", MODE_PRIVATE).getInt("last_port", DEFAULT_PORT);
    }

    private String getConnectedIp() {
        return getSharedPreferences("FlowPrefs", MODE_PRIVATE).getString("last_ip", "");
    }

    private void setConnectedServer(String ip, int port, String branch) {
        SharedPreferences.Editor editor = getSharedPreferences("FlowPrefs", MODE_PRIVATE).edit();
        editor.putString("last_ip", ip);
        editor.putInt("last_port", port);
        if (branch != null && !branch.isEmpty()) {
            editor.putString("last_branch", branch);
        }
        editor.apply();
    }

    private ServerEntry fetchServerInfo(String ip, int port, int timeoutMs) {
        try {
            URL url = new URL("http://" + ip + ":" + port + "/api/server-info");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            if (conn.getResponseCode() == 200) {
                InputStream is = conn.getInputStream();
                byte[] buffer = new byte[1024];
                StringBuilder sb = new StringBuilder();
                int read;
                while ((read = is.read(buffer)) != -1) {
                    sb.append(new String(buffer, 0, read));
                }
                is.close();
                JSONObject json = new JSONObject(sb.toString());
                String branch = json.optString("branch", "unknown");
                String name = json.optString("name", "Flow Whiteboard");
                String version = json.optString("version", "");
                return new ServerEntry(ip, port, branch, name, version);
            }
        } catch (Exception ignored) {}
        return null;
    }

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
                    String lastIp = getConnectedIp();
                    int lastPort = getConnectedPort();
                    if (!lastIp.isEmpty()) {
                        checkAppUpdate(lastIp, lastPort, true);
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
                    // Check if request targets Note server on current or candidate ports
                    int connectedPort = getConnectedPort();
                    boolean isNotePort = url.contains(":" + connectedPort);
                    if (!isNotePort) {
                        for (int p : CANDIDATE_PORTS) {
                            if (url.contains(":" + p)) {
                                isNotePort = true;
                                break;
                            }
                        }
                    }

                    if (isNotePort) {
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
                    
                    // Intercept Flow PDF Viewer (4040)
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

    private void syncOfflineFiles(final String ip, final int port) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File uploadsDir = new File(getFilesDir(), "uploads");
                    if (!uploadsDir.exists()) uploadsDir.mkdirs();

                    URL url = new URL("http://" + ip + ":" + port + "/api/files");
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
                            URL fileUrl = new URL("http://" + ip + ":" + port + "/uploads/" + filename);
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

                    // Automatically check if an updated APK is available on this branch server
                    checkAppUpdate(ip, port, false);
                } catch (Exception e) {
                    Log.e("FlowApp", "Sync error", e);
                }
            }
        }).start();
    }

    private void loadApp(String ip, int port) {
        try {
            InputStream is = getAssets().open("web/index.html");
            int size = is.available();
            byte[] buffer = new byte[size];
            is.read(buffer);
            is.close();
            String html = new String(buffer, "UTF-8");
            
            String baseUrl = "http://" + ip + ":" + port + "/";
            mWebView.loadDataWithBaseURL(baseUrl, html, "text/html", "UTF-8", null);
        } catch (Exception e) {
            Log.e("FlowApp", "Failed to load local HTML", e);
            mWebView.loadUrl("http://" + ip + ":" + port);
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
        final String lastIp = getConnectedIp();
        final int lastPort = getConnectedPort();

        String scanningHtml = "<html><body style='display:flex;flex-direction:column;justify-content:center;align-items:center;height:100%;font-family:sans-serif;background:#242424;color:white;text-align:center;margin:0;padding:20px;box-sizing:border-box;'>"
                + "<div style='font-size:36px;margin-bottom:16px;'>&#128269;</div>"
                + "<h2 style='margin:0 0 10px 0;'>Connecting to Flow Whiteboard...</h2>"
                + "<p style='color:#aaa;margin:0;font-size:14px;'>Searching running branch servers on network &amp; Tailscale</p>"
                + "</body></html>";
        mWebView.loadData(scanningHtml, "text/html", "UTF-8");

        final ExecutorService executor = Executors.newFixedThreadPool(60);

        // 1. High-priority check for last known IP and port
        if (!lastIp.isEmpty()) {
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    checkAndConnect(lastIp, lastPort, "Reconnected to last server", 600);
                }
            });

            // Also probe other candidate ports on last known IP
            for (final int p : CANDIDATE_PORTS) {
                if (p != lastPort) {
                    executor.execute(new Runnable() {
                        @Override
                        public void run() {
                            checkAndConnect(lastIp, p, "Connected to server on port " + p, 500);
                        }
                    });
                }
            }
        }

        // 2. High-priority check for known Tailscale IP across ports
        final String tailscaleIp = "100.100.40.92";
        executor.execute(new Runnable() {
            @Override
            public void run() {
                checkAndConnect(tailscaleIp, lastPort, "Connected via Tailscale!", 1000);
            }
        });
        executor.execute(new Runnable() {
            @Override
            public void run() {
                checkAndConnect(tailscaleIp, DEFAULT_PORT, "Connected via Tailscale!", 1000);
            }
        });

        // 3. Discover and scan all active network subnets
        Set<String> prefixes = getSubnetPrefixes();
        if (lastIp != null && lastIp.contains(".")) {
            int lastDot = lastIp.lastIndexOf('.');
            if (lastDot > 0) prefixes.add(lastIp.substring(0, lastDot + 1));
        }

        List<Integer> hostOrder = new ArrayList<>();
        for (int i = 100; i <= 115; i++) hostOrder.add(i);
        for (int i = 2; i <= 30; i++) hostOrder.add(i);
        hostOrder.add(1);
        for (int i = 31; i <= 99; i++) hostOrder.add(i);
        for (int i = 116; i <= 254; i++) hostOrder.add(i);

        for (String prefix : prefixes) {
            for (int hostNum : hostOrder) {
                final String targetIp = prefix + hostNum;
                for (final int portToScan : new int[] { DEFAULT_PORT, 3940 }) {
                    executor.execute(new Runnable() {
                        @Override
                        public void run() {
                            checkAndConnect(targetIp, portToScan, "Connected via Wi-Fi!", 450);
                        }
                    });
                }
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

    private void checkAndConnect(final String ip, final int port, final String successMsg, int timeoutMs) {
        if (found.get()) return;
        try {
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress(ip, port), timeoutMs);
            socket.close();

            if (found.compareAndSet(false, true)) {
                ServerEntry entry = fetchServerInfo(ip, port, 1000);
                final String branch = (entry != null && entry.branch != null) ? entry.branch : "";
                setConnectedServer(ip, port, branch);

                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        String msg = successMsg;
                        if (!branch.isEmpty()) {
                            msg = "Connected: [" + branch + "] (" + ip + ":" + port + ")";
                        }
                        Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                        loadApp(ip, port);
                        syncOfflineFiles(ip, port);
                    }
                });
            }
        } catch (Exception ignored) {}
    }

    private void promptManualIp() {
        final String lastIp = getConnectedIp();
        final int lastPort = getConnectedPort();
        final String lastBranch = getSharedPreferences("FlowPrefs", MODE_PRIVATE).getString("last_branch", "");

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Flow Whiteboard Menu");

        String currentLabel = lastIp.isEmpty() ? "🔌 Connect to IP:Port" : "🔌 Connect to " + lastIp + ":" + lastPort + (lastBranch.isEmpty() ? "" : " [" + lastBranch + "]");
        
        String[] options = new String[] {
            "🔀 Switch Server / Branch",
            currentLabel,
            "🚀 Check for App Update",
            "🔍 Rescan Local Network",
            "📴 Offline Mode"
        };

        builder.setItems(options, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                if (which == 0) {
                    scanAndSelectBranchServer();
                } else if (which == 1) {
                    promptEnterIp();
                } else if (which == 2) {
                    if (!lastIp.isEmpty()) {
                        checkAppUpdate(lastIp, lastPort, true);
                    } else {
                        Toast.makeText(MainActivity.this, "Please connect to a server first", Toast.LENGTH_SHORT).show();
                        promptEnterIp();
                    }
                } else if (which == 3) {
                    scanNetwork();
                } else if (which == 4) {
                    Toast.makeText(MainActivity.this, "Offline mode active.", Toast.LENGTH_SHORT).show();
                    loadApp(lastIp.isEmpty() ? "127.0.0.1" : lastIp, lastPort);
                }
            }
        });

        builder.setNegativeButton("Close", null);
        builder.show();
    }

    private void scanAndSelectBranchServer() {
        final ProgressDialog progressDialog = new ProgressDialog(this);
        progressDialog.setTitle("Scanning Branches...");
        progressDialog.setMessage("Detecting running Flow servers & branches...");
        progressDialog.setIndeterminate(true);
        progressDialog.setCancelable(true);
        progressDialog.show();

        final List<ServerEntry> discovered = Collections.synchronizedList(new ArrayList<ServerEntry>());
        final ExecutorService exec = Executors.newFixedThreadPool(30);

        // 1. Probe lastIp on all candidate ports
        final String lastIp = getConnectedIp();
        if (!lastIp.isEmpty()) {
            for (int port : CANDIDATE_PORTS) {
                final int p = port;
                exec.execute(new Runnable() {
                    @Override
                    public void run() {
                        ServerEntry entry = probeServer(lastIp, p, 700);
                        if (entry != null) discovered.add(entry);
                    }
                });
            }
        }

        // 2. Probe Tailscale IP on candidate ports
        final String tailscaleIp = "100.100.40.92";
        for (int port : CANDIDATE_PORTS) {
            final int p = port;
            exec.execute(new Runnable() {
                @Override
                public void run() {
                    ServerEntry entry = probeServer(tailscaleIp, p, 1000);
                    if (entry != null) discovered.add(entry);
                }
            });
        }

        // 3. Probe active subnets on ports 3939 & 3940
        Set<String> prefixes = getSubnetPrefixes();
        if (lastIp != null && lastIp.contains(".")) {
            int lastDot = lastIp.lastIndexOf('.');
            if (lastDot > 0) prefixes.add(lastIp.substring(0, lastDot + 1));
        }

        List<Integer> hostOrder = new ArrayList<>();
        for (int i = 100; i <= 115; i++) hostOrder.add(i);
        for (int i = 2; i <= 30; i++) hostOrder.add(i);
        hostOrder.add(1);
        for (int i = 31; i <= 99; i++) hostOrder.add(i);
        for (int i = 116; i <= 254; i++) hostOrder.add(i);

        for (String prefix : prefixes) {
            for (int hostNum : hostOrder) {
                final String targetIp = prefix + hostNum;
                if (targetIp.equals(lastIp)) continue;
                exec.execute(new Runnable() {
                    @Override
                    public void run() {
                        for (int p : new int[] { DEFAULT_PORT, 3940 }) {
                            ServerEntry entry = probeServer(targetIp, p, 400);
                            if (entry != null) {
                                discovered.add(entry);
                                break;
                            }
                        }
                    }
                });
            }
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    exec.shutdown();
                    exec.awaitTermination(3500, TimeUnit.MILLISECONDS);
                } catch (Exception ignored) {}

                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (progressDialog.isShowing()) {
                            progressDialog.dismiss();
                        }
                        if (discovered.isEmpty()) {
                            Toast.makeText(MainActivity.this, "No running branch servers found.", Toast.LENGTH_SHORT).show();
                            promptEnterIp();
                        } else {
                            showBranchSelectionDialog(discovered);
                        }
                    }
                });
            }
        }).start();
    }

    private ServerEntry probeServer(String ip, int port, int timeoutMs) {
        try {
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress(ip, port), timeoutMs);
            socket.close();
            ServerEntry entry = fetchServerInfo(ip, port, timeoutMs + 500);
            if (entry != null) return entry;
            return new ServerEntry(ip, port, port == DEFAULT_PORT ? "master" : "port " + port, "Flow Whiteboard", "");
        } catch (Exception ignored) {}
        return null;
    }

    private void showBranchSelectionDialog(final List<ServerEntry> servers) {
        final List<ServerEntry> uniqueList = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (ServerEntry s : servers) {
            String key = s.ip + ":" + s.port;
            if (seen.add(key)) {
                uniqueList.add(s);
            }
        }

        String currentIp = getConnectedIp();
        int currentPort = getConnectedPort();

        String[] itemLabels = new String[uniqueList.size() + 1];
        for (int i = 0; i < uniqueList.size(); i++) {
            ServerEntry s = uniqueList.get(i);
            boolean isCurrent = s.ip.equals(currentIp) && s.port == currentPort;
            itemLabels[i] = "🌿 " + s.branch + "  (" + s.ip + ":" + s.port + ")" + (isCurrent ? "  ★ Current" : "");
        }
        itemLabels[uniqueList.size()] = "➕ Custom IP:Port...";

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Select Running Branch");
        builder.setItems(itemLabels, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                if (which < uniqueList.size()) {
                    ServerEntry selected = uniqueList.get(which);
                    connectToSelectedServer(selected);
                } else {
                    promptEnterIp();
                }
            }
        });
        builder.setNegativeButton("Cancel", null);
        builder.show();
    }

    private void connectToSelectedServer(ServerEntry entry) {
        found.set(true);
        setConnectedServer(entry.ip, entry.port, entry.branch);
        Toast.makeText(this, "Connecting to [" + entry.branch + "] on port " + entry.port + "...", Toast.LENGTH_SHORT).show();
        loadApp(entry.ip, entry.port);
        syncOfflineFiles(entry.ip, entry.port);
    }

    private void promptEnterIp() {
        final String lastIp = getConnectedIp();
        final int lastPort = getConnectedPort();

        Set<String> prefixes = getSubnetPrefixes();
        StringBuilder hint = new StringBuilder();
        if (!prefixes.isEmpty()) {
            hint.append("Detected subnets: ");
            for (String p : prefixes) {
                hint.append(p).append("x ");
            }
        }

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Connect to Server / Branch");
        builder.setMessage((hint.length() > 0 ? hint.toString() + "\n\n" : "") + "Enter PC IP and optional Port (e.g. 192.168.0.102:3939 or 192.168.0.102:3940):");

        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_PHONE | InputType.TYPE_CLASS_TEXT);
        input.setHint("192.168.0.102:3939");
        if (!lastIp.isEmpty()) {
            String prefill = lastIp + (lastPort != DEFAULT_PORT ? ":" + lastPort : "");
            input.setText(prefill);
            input.setSelection(input.getText().length());
        } else if (!prefixes.isEmpty()) {
            input.setText(prefixes.iterator().next());
            input.setSelection(input.getText().length());
        }
        builder.setView(input);

        builder.setPositiveButton("Connect", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                final String raw = input.getText().toString().trim();
                if (!raw.isEmpty()) {
                    String ip = raw;
                    int port = DEFAULT_PORT;
                    if (raw.contains(":")) {
                        String[] parts = raw.split(":");
                        ip = parts[0].trim();
                        try {
                            port = Integer.parseInt(parts[1].trim());
                        } catch (Exception ignored) {
                            port = DEFAULT_PORT;
                        }
                    }
                    testAndConnect(ip, port);
                }
            }
        });

        builder.setNeutralButton("Branches", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                scanAndSelectBranchServer();
            }
        });

        builder.setNegativeButton("Cancel", null);
        builder.show();
    }

    private void testAndConnect(final String ip, final int port) {
        Toast.makeText(this, "Testing " + ip + ":" + port + "...", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                boolean reachable = false;
                try {
                    Socket socket = new Socket();
                    socket.connect(new InetSocketAddress(ip, port), 1500);
                    socket.close();
                    reachable = true;
                } catch (Exception ignored) {}

                final boolean success = reachable;
                final ServerEntry entry = success ? fetchServerInfo(ip, port, 1000) : null;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (success) {
                            found.set(true);
                            String branch = entry != null ? entry.branch : "";
                            setConnectedServer(ip, port, branch);
                            String msg = "Connected to " + ip + ":" + port + (!branch.isEmpty() ? " [" + branch + "]" : "") + "!";
                            Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                            loadApp(ip, port);
                            syncOfflineFiles(ip, port);
                        } else {
                            Toast.makeText(MainActivity.this, "Could not reach " + ip + ":" + port + ". Make sure server is running!", Toast.LENGTH_LONG).show();
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
    private void checkAppUpdate(final String ip, final int port, final boolean userTriggered) {
        if (userTriggered) {
            Toast.makeText(this, "Checking for update on " + ip + ":" + port + "...", Toast.LENGTH_SHORT).show();
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    URL url = new URL("http://" + ip + ":" + port + "/api/app-version");
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
                                .setMessage("A newer build of Flow Note is available on this server.\n\n"
                                        + "• Size: " + sizeMb + "\n"
                                        + (dateStr.isEmpty() ? "" : "• Build Time: " + dateStr + "\n")
                                        + "\nWould you like to download and install this update now?")
                                .setPositiveButton("Update Now", new DialogInterface.OnClickListener() {
                                    @Override
                                    public void onClick(DialogInterface dialog, int which) {
                                        downloadAndInstallApk(ip, port, apkUrl, serverMtime, serverMd5);
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

    private void downloadAndInstallApk(final String ip, final int port, final String apkUrl, final long serverMtime, final String serverMd5) {
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
                    URL url = new URL("http://" + ip + ":" + port + apkUrl);
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
                    String lastIp = getConnectedIp();
                    int lastPort = getConnectedPort();
                    if (!lastIp.isEmpty()) {
                        checkAppUpdate(lastIp, lastPort, true);
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
