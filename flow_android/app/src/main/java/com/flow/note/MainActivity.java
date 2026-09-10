package com.flow.note;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.text.InputType;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.PermissionRequest;
import android.Manifest;
import android.content.pm.PackageManager;
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
import java.net.URLDecoder;
import java.net.URLEncoder;
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
    private final int[] NOTE_PORTS = new int[]{ 3941, 3939 };
    private int mServerPort = 3941;
    private final int PDF_PORT = 4040;
    private AtomicBoolean found = new AtomicBoolean(false);
    private ValueCallback<Uri[]> mUploadMessage;
    private final static int FILECHOOSER_RESULTCODE = 1;
    private final static int INSTALL_PERMISSION_REQUEST_CODE = 1002;
    private final static int AUDIO_PERMISSION_REQUEST_CODE = 1003;
    private PermissionRequest mPendingAudioPermissionRequest = null;
    private boolean isOfflineMode = false;
    private Dialog mPdfDialog = null;
    private WebView mPdfWebView = null;
    private java.util.concurrent.ScheduledExecutorService mFileSyncScheduler = null;
    private final long FILE_SYNC_INTERVAL_SEC = 50;
    private AlertDialog mUpdateDialog = null;

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
        public String getServerIp() {
            return getSharedPreferences("FlowPrefs", MODE_PRIVATE).getString("last_ip", "");
        }

        @JavascriptInterface
        public void saveBoardState(String json) {
            if (json != null && !json.isEmpty()) {
                getSharedPreferences("FlowPrefs", MODE_PRIVATE).edit().putString("saved_board_state", json).apply();
            }
        }

        @JavascriptInterface
        public String getBoardState() {
            return getSharedPreferences("FlowPrefs", MODE_PRIVATE).getString("saved_board_state", "");
        }

        @JavascriptInterface
        public boolean isOffline() {
            return isOfflineMode;
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

        @JavascriptInterface
        public void openPdf(final String fileUrl, final String fileName) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showPdfViewerDialog(fileUrl, fileName);
                }
            });
        }

        @JavascriptInterface
        public void openFile(final String fileUrl, final String fileName) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (fileUrl != null && fileUrl.toLowerCase().endsWith(".pdf")) {
                        showPdfViewerDialog(fileUrl, fileName);
                    } else {
                        openExternalFile(fileUrl, fileName);
                    }
                }
            });
        }

        @JavascriptInterface
        public String saveLocalFile(final String fileName, String base64Data) {
            try {
                File uploadsDir = new File(getFilesDir(), "uploads");
                if (!uploadsDir.exists()) uploadsDir.mkdirs();

                String safeName = System.currentTimeMillis() + "_" + (fileName != null ? fileName.replaceAll("[^a-zA-Z0-9._-]", "_") : "file");
                File dest = new File(uploadsDir, safeName);

                if (base64Data != null && base64Data.contains(",")) {
                    base64Data = base64Data.substring(base64Data.indexOf(",") + 1);
                }
                if (base64Data != null) {
                    byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                    FileOutputStream fos = new FileOutputStream(dest);
                    fos.write(bytes);
                    fos.close();
                    Log.d("FlowApp", "Saved local offline file: " + dest.getAbsolutePath());
                    return "/uploads/" + safeName;
                }
            } catch (Exception e) {
                Log.e("FlowApp", "Error saving local file", e);
            }
            return null;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        mServerPort = getSharedPreferences("FlowPrefs", MODE_PRIVATE).getInt("last_port", 3941);
        
        mWebView = new WebView(this);
        setContentView(mWebView);

        WebSettings webSettings = mWebView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setDatabaseEnabled(true);
        webSettings.setAllowFileAccess(true);
        webSettings.setAllowFileAccessFromFileURLs(true);
        webSettings.setAllowUniversalAccessFromFileURLs(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            webSettings.setMediaPlaybackRequiresUserGesture(false);
        }
        
        mWebView.addJavascriptInterface(new WebAppInterface(), "AndroidBridge");

        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                            boolean needsAudio = false;
                            for (String res : request.getResources()) {
                                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                                    needsAudio = true;
                                    break;
                                }
                            }
                            if (needsAudio) {
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                                        checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                                    mPendingAudioPermissionRequest = request;
                                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION_REQUEST_CODE);
                                } else {
                                    request.grant(request.getResources());
                                }
                            } else {
                                request.grant(request.getResources());
                            }
                        }
                    }
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (mPendingAudioPermissionRequest == request) {
                    mPendingAudioPermissionRequest = null;
                }
            }

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
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    return handleUrlNavigation(request.getUrl().toString());
                }
                return false;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrlNavigation(url);
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    WebResourceResponse res = interceptAssetOrUpload(request.getUrl().toString(), request.getUrl().getPath());
                    if (res != null) return res;
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (failingUrl != null && isNoteUrl(failingUrl) && !failingUrl.contains("localhost") && !failingUrl.contains("127.0.0.1") && !isOfflineMode) {
                    Log.w("FlowApp", "Server load failed, falling back to local offline assets: " + description);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            loadApp("");
                        }
                    });
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    String failingUrl = request.getUrl() != null ? request.getUrl().toString() : "";
                    if (isNoteUrl(failingUrl) && !failingUrl.contains("localhost") && !failingUrl.contains("127.0.0.1") && !isOfflineMode) {
                        Log.w("FlowApp", "Main frame server load failed, falling back to local offline assets");
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                loadApp("");
                            }
                        });
                    }
                }
            }
        });
        
        scanNetwork();
        startPeriodicFileSync();
    }

    @Override
    public void onBackPressed() {
        if (mPdfDialog != null && mPdfDialog.isShowing()) {
            if (mPdfWebView != null && mPdfWebView.canGoBack()) {
                mPdfWebView.goBack();
            } else {
                mPdfDialog.dismiss();
            }
            return;
        }

        if (mWebView != null && mWebView.canGoBack()) {
            mWebView.goBack();
            return;
        }

        super.onBackPressed();
    }

    private boolean isNoteUrl(String url) {
        if (url == null) return false;
        for (int p : NOTE_PORTS) {
            if (url.contains(":" + p)) return true;
        }
        return false;
    }

    private boolean handleUrlNavigation(String url) {
        if (url == null || url.isEmpty()) return false;

        // 1. PDF Viewer or Annotator URLs
        if (url.contains(":" + PDF_PORT) || url.contains("/web/viewer.html")) {
            Uri uri = Uri.parse(url);
            String fileParam = uri.getQueryParameter("file");
            if (fileParam != null && !fileParam.isEmpty()) {
                String fname = "Document.pdf";
                try {
                    fname = new File(Uri.parse(fileParam).getPath()).getName();
                } catch (Exception ignored) {}
                showPdfViewerDialog(fileParam, fname);
            } else {
                showPdfViewerDialog(url, "PDF Viewer");
            }
            return true;
        }

        // 2. Direct PDF document links
        String lower = url.toLowerCase();
        if (lower.endsWith(".pdf") || (url.contains("/uploads/") && lower.contains(".pdf"))) {
            String fname = "Document.pdf";
            try {
                fname = new File(Uri.parse(url).getPath()).getName();
            } catch (Exception ignored) {}
            showPdfViewerDialog(url, fname);
            return true;
        }

        // 3. Flow Whiteboard internal page navigations
        if (isNoteUrl(url) || url.startsWith("file:///android_asset/web/")) {
            return false;
        }

        // 4. External websites (e.g. clicked link cards)
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private int dpToPx(int dp) {
        return (int) (dp * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void showPdfViewerDialog(final String rawFileUrl, final String fileName) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (mPdfDialog != null && mPdfDialog.isShowing()) {
                        mPdfDialog.dismiss();
                    }

                    final Dialog dialog = new Dialog(MainActivity.this, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
                    mPdfDialog = dialog;

                    android.widget.LinearLayout root = new android.widget.LinearLayout(MainActivity.this);
                    root.setOrientation(android.widget.LinearLayout.VERTICAL);
                    root.setLayoutParams(new android.view.ViewGroup.LayoutParams(
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT));
                    root.setBackgroundColor(0xFF1E1E1E);

                    // Header bar
                    android.widget.LinearLayout header = new android.widget.LinearLayout(MainActivity.this);
                    header.setOrientation(android.widget.LinearLayout.HORIZONTAL);
                    header.setLayoutParams(new android.widget.LinearLayout.LayoutParams(
                            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                            dpToPx(50)));
                    header.setBackgroundColor(0xFF2B2B2B);
                    header.setGravity(android.view.Gravity.CENTER_VERTICAL);
                    header.setPadding(dpToPx(10), 0, dpToPx(10), 0);

                    // Back button
                    android.widget.Button backBtn = new android.widget.Button(MainActivity.this);
                    backBtn.setText("← Back");
                    backBtn.setTextColor(0xFFFFFFFF);
                    backBtn.setTextSize(14);
                    backBtn.setBackgroundColor(0x00000000);
                    backBtn.setOnClickListener(new android.view.View.OnClickListener() {
                        @Override
                        public void onClick(android.view.View v) {
                            dialog.dismiss();
                        }
                    });
                    header.addView(backBtn);

                    // Title
                    android.widget.TextView titleView = new android.widget.TextView(MainActivity.this);
                    titleView.setText(fileName != null && !fileName.isEmpty() ? fileName : "PDF Document");
                    titleView.setTextColor(0xFFE5E5E5);
                    titleView.setTextSize(15);
                    titleView.setSingleLine(true);
                    titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
                    android.widget.LinearLayout.LayoutParams titleParams = new android.widget.LinearLayout.LayoutParams(
                            0, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1.0f);
                    titleParams.setMargins(dpToPx(10), 0, dpToPx(10), 0);
                    titleView.setLayoutParams(titleParams);
                    header.addView(titleView);

                    // External app button
                    android.widget.Button extBtn = new android.widget.Button(MainActivity.this);
                    extBtn.setText("Share / App ↗");
                    extBtn.setTextColor(0xFF4A90E2);
                    extBtn.setTextSize(13);
                    extBtn.setBackgroundColor(0x00000000);
                    extBtn.setOnClickListener(new android.view.View.OnClickListener() {
                        @Override
                        public void onClick(android.view.View v) {
                            openPdfInExternalApp(rawFileUrl, fileName);
                        }
                    });
                    header.addView(extBtn);

                    root.addView(header);

                    // PDF WebView
                    final WebView pdfWv = new WebView(MainActivity.this);
                    mPdfWebView = pdfWv;
                    pdfWv.setLayoutParams(new android.widget.LinearLayout.LayoutParams(
                            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                            0, 1.0f));

                    WebSettings ws = pdfWv.getSettings();
                    ws.setJavaScriptEnabled(true);
                    ws.setDomStorageEnabled(true);
                    ws.setDatabaseEnabled(true);
                    ws.setAllowFileAccess(true);
                    ws.setAllowFileAccessFromFileURLs(true);
                    ws.setAllowUniversalAccessFromFileURLs(true);

                    pdfWv.setWebViewClient(new WebViewClient() {
                        @Override
                        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                            if (request != null && request.getUrl() != null) {
                                WebResourceResponse res = interceptAssetOrUpload(request.getUrl().toString(), request.getUrl().getPath());
                                if (res != null) return res;
                            }
                            return super.shouldInterceptRequest(view, request);
                        }
                    });

                    root.addView(pdfWv);
                    dialog.setContentView(root);

                    dialog.setOnDismissListener(new DialogInterface.OnDismissListener() {
                        @Override
                        public void onDismiss(DialogInterface d) {
                            if (mPdfWebView != null) {
                                mPdfWebView.destroy();
                                mPdfWebView = null;
                            }
                            mPdfDialog = null;
                        }
                    });

                    String resolvedUrl = resolveFileUrlForViewer(rawFileUrl);
                    String viewerUrl = "http://localhost:" + PDF_PORT + "/web/viewer.html?file=" + URLEncoder.encode(resolvedUrl, "UTF-8");
                    Log.d("FlowApp", "Opening PDF viewer with URL: " + viewerUrl);
                    pdfWv.loadUrl(viewerUrl);

                    dialog.show();
                } catch (Exception e) {
                    Log.e("FlowApp", "Error showing PDF dialog", e);
                    Toast.makeText(MainActivity.this, "Opening external PDF viewer...", Toast.LENGTH_SHORT).show();
                    openPdfInExternalApp(rawFileUrl, fileName);
                }
            }
        });
    }

    private String resolveFileUrlForViewer(String rawFileUrl) {
        if (rawFileUrl == null || rawFileUrl.isEmpty()) return "";
        if (rawFileUrl.startsWith("http://") || rawFileUrl.startsWith("https://")) {
            return rawFileUrl;
        }

        String path = rawFileUrl;
        if (path.startsWith("file:///android_asset/")) {
            path = path.replace("file:///android_asset/", "");
        }
        if (!path.startsWith("/")) path = "/" + path;

        // When offline or local, route via localhost:3939 so interceptAssetOrUpload intercepts it
        String lastIp = getSharedPreferences("FlowPrefs", MODE_PRIVATE).getString("last_ip", "");
        if (isOfflineMode || lastIp.isEmpty()) {
            return "http://localhost:" + mServerPort + path;
        } else {
            return "http://" + lastIp + ":" + mServerPort + path;
        }
    }

    private File findLocalUploadFile(String fileUrl) {
        if (fileUrl == null || fileUrl.isEmpty()) return null;
        try {
            String cleanName = fileUrl;
            if (cleanName.contains("?")) cleanName = cleanName.substring(0, cleanName.indexOf("?"));
            if (cleanName.contains("/uploads/")) {
                cleanName = cleanName.substring(cleanName.indexOf("/uploads/") + 9);
            } else if (cleanName.contains("/")) {
                cleanName = cleanName.substring(cleanName.lastIndexOf("/") + 1);
            }
            if (cleanName.startsWith("/")) cleanName = cleanName.substring(1);

            File uploadsDir = new File(getFilesDir(), "uploads");
            File f = new File(uploadsDir, cleanName);
            if (f.exists()) return f;

            try {
                File decoded = new File(uploadsDir, URLDecoder.decode(cleanName, "UTF-8"));
                if (decoded.exists()) return decoded;
            } catch (Exception ignored) {}

            File direct = new File(getFilesDir(), cleanName);
            if (direct.exists()) return direct;

            File cache = new File(getCacheDir(), cleanName);
            if (cache.exists()) return cache;
        } catch (Exception ignored) {}
        return null;
    }

    private void openPdfInExternalApp(String fileUrl, String fileName) {
        try {
            File targetFile = findLocalUploadFile(fileUrl);
            if (targetFile == null || !targetFile.exists()) {
                Toast.makeText(this, "File is not stored locally on this device.", Toast.LENGTH_SHORT).show();
                return;
            }

            Uri uri = Uri.parse("content://" + GenericFileProvider.AUTHORITY + "/" + targetFile.getName());
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/pdf");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(Intent.createChooser(intent, "Open PDF with..."));
        } catch (Exception e) {
            Log.e("FlowApp", "Error opening external PDF", e);
            Toast.makeText(this, "No external application found to open PDF.", Toast.LENGTH_SHORT).show();
        }
    }

    private void openExternalFile(String fileUrl, String fileName) {
        try {
            File targetFile = findLocalUploadFile(fileUrl);
            if (targetFile != null && targetFile.exists()) {
                String mime = "*/*";
                String lower = targetFile.getName().toLowerCase();
                if (lower.endsWith(".png")) mime = "image/png";
                else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mime = "image/jpeg";
                else if (lower.endsWith(".pdf")) mime = "application/pdf";

                Uri uri = Uri.parse("content://" + GenericFileProvider.AUTHORITY + "/" + targetFile.getName());
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, mime);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(Intent.createChooser(intent, "Open file with..."));
            } else if (fileUrl != null && (fileUrl.startsWith("http://") || fileUrl.startsWith("https://"))) {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(fileUrl));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } else {
                Toast.makeText(this, "File not available locally", Toast.LENGTH_SHORT).show();
            }
        } catch (Exception e) {
            Log.e("FlowApp", "Error opening file", e);
            Toast.makeText(this, "Could not open file: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private WebResourceResponse interceptAssetOrUpload(String url, String path) {
        if (path == null) path = "";
        try {
            // 1. Intercept Flow Note uploads (saved locally in app files)
            if (path.contains("/uploads/")) {
                int uploadIdx = path.indexOf("/uploads/");
                String subPath = path.substring(uploadIdx);
                if (subPath.startsWith("/")) subPath = subPath.substring(1);

                File localFile = new File(getFilesDir(), subPath);
                if (!localFile.exists()) {
                    try {
                        localFile = new File(getFilesDir(), URLDecoder.decode(subPath, "UTF-8"));
                    } catch (Exception ignored) {}
                }
                if (!localFile.exists()) {
                    String fname = new File(subPath).getName();
                    File uFile = new File(new File(getFilesDir(), "uploads"), fname);
                    if (uFile.exists()) localFile = uFile;
                }

                if (localFile.exists()) {
                    String mime = "application/octet-stream";
                    String encoding = null; // Binary by default
                    String lower = subPath.toLowerCase();
                    if (lower.endsWith(".png")) mime = "image/png";
                    else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mime = "image/jpeg";
                    else if (lower.endsWith(".pdf")) mime = "application/pdf";
                    else if (lower.endsWith(".svg")) { mime = "image/svg+xml"; encoding = "UTF-8"; }
                    else if (lower.endsWith(".webm")) mime = "audio/webm";
                    else if (lower.endsWith(".mp3")) mime = "audio/mpeg";
                    else if (lower.endsWith(".ogg")) mime = "audio/ogg";
                    else if (lower.endsWith(".wav")) mime = "audio/wav";
                    else if (lower.endsWith(".m4a")) mime = "audio/mp4";

                    WebResourceResponse response = new WebResourceResponse(mime, encoding, new FileInputStream(localFile));
                    java.util.Map<String, String> headers = new java.util.HashMap<>();
                    headers.put("Access-Control-Allow-Origin", "*");
                    headers.put("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
                    headers.put("Access-Control-Allow-Headers", "*");
                    headers.put("Accept-Ranges", "bytes");
                    response.setResponseHeaders(headers);
                    return response;
                }
            }

            // 2. Intercept Flow PDF Viewer (4040)
            if (url.contains(":" + PDF_PORT) || path.startsWith("/web/") || path.startsWith("/build/") || url.contains("/web/viewer.html")) {
                String assetPath = "pdf" + (path.equals("/") || path.isEmpty() ? "/web/viewer.html" : (path.startsWith("/") ? path : "/" + path));
                InputStream is = null;
                try {
                    is = getAssets().open(assetPath);
                } catch (Exception notFound) {
                    try {
                        is = getAssets().open("pdf/web" + (path.startsWith("/") ? path : "/" + path));
                    } catch (Exception ignored) {}
                }

                if (is != null) {
                    String mime = "application/octet-stream";
                    String encoding = null;
                    String lower = path.toLowerCase();
                    if (lower.endsWith(".html")) { mime = "text/html"; encoding = "UTF-8"; }
                    else if (lower.endsWith(".js") || lower.endsWith(".mjs")) { mime = "application/javascript"; encoding = "UTF-8"; }
                    else if (lower.endsWith(".css")) { mime = "text/css"; encoding = "UTF-8"; }
                    else if (lower.endsWith(".json") || lower.endsWith(".map")) { mime = "application/json"; encoding = "UTF-8"; }
                    else if (lower.endsWith(".svg")) { mime = "image/svg+xml"; encoding = "UTF-8"; }
                    else if (lower.endsWith(".png")) { mime = "image/png"; }
                    else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) { mime = "image/jpeg"; }
                    else if (lower.endsWith(".gif")) { mime = "image/gif"; }
                    else if (lower.endsWith(".wasm")) { mime = "application/wasm"; }
                    else if (lower.endsWith(".woff")) { mime = "font/woff"; }
                    else if (lower.endsWith(".woff2")) { mime = "font/woff2"; }
                    else if (lower.endsWith(".ttf")) { mime = "font/ttf"; }
                    else if (lower.endsWith(".properties")) { mime = "text/plain"; encoding = "UTF-8"; }

                    WebResourceResponse response = new WebResourceResponse(mime, encoding, is);
                    java.util.Map<String, String> headers = new java.util.HashMap<>();
                    headers.put("Access-Control-Allow-Origin", "*");
                    headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                    headers.put("Access-Control-Allow-Headers", "*");
                    response.setResponseHeaders(headers);
                    return response;
                }
            }

            // 3. Fallback intercept for localhost / 127.0.0.1 offline web assets
            boolean isLocalhostNote = false;
            for (int p : NOTE_PORTS) {
                if (url.contains("localhost:" + p) || url.contains("127.0.0.1:" + p)) {
                    isLocalhostNote = true;
                    break;
                }
            }
            if (isLocalhostNote) {
                String cleanPath = path.equals("/") || path.isEmpty() ? "index.html" : (path.startsWith("/") ? path.substring(1) : path);
                InputStream is = getAssets().open("web/" + cleanPath);
                String mime = "application/octet-stream";
                String encoding = null;
                String lower = cleanPath.toLowerCase();
                if (lower.endsWith(".html")) { mime = "text/html"; encoding = "UTF-8"; }
                else if (lower.endsWith(".js")) { mime = "application/javascript"; encoding = "UTF-8"; }
                else if (lower.endsWith(".css")) { mime = "text/css"; encoding = "UTF-8"; }
                else if (lower.endsWith(".json")) { mime = "application/json"; encoding = "UTF-8"; }
                else if (lower.endsWith(".svg")) { mime = "image/svg+xml"; encoding = "UTF-8"; }
                else if (lower.endsWith(".png")) { mime = "image/png"; }

                WebResourceResponse response = new WebResourceResponse(mime, encoding, is);
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
        return null;
    }

    private synchronized void startPeriodicFileSync() {
        if (mFileSyncScheduler != null && !mFileSyncScheduler.isShutdown()) {
            return;
        }
        mFileSyncScheduler = Executors.newSingleThreadScheduledExecutor();
        // Periodically sync/update files and check for app updates every 50 seconds
        mFileSyncScheduler.scheduleWithFixedDelay(new Runnable() {
            @Override
            public void run() {
                try {
                    String currentIp = getSharedPreferences("FlowPrefs", MODE_PRIVATE).getString("last_ip", "");
                    if (!currentIp.isEmpty() && !isOfflineMode) {
                        syncOfflineFilesInternal(currentIp, false);
                        checkAppUpdate(currentIp, false);
                    }
                } catch (Exception e) {
                    Log.e("FlowApp", "Periodic file sync error", e);
                }
            }
        }, 3, FILE_SYNC_INTERVAL_SEC, TimeUnit.SECONDS);
    }

    private void syncOfflineFiles(final String ip) {
        startPeriodicFileSync();
        new Thread(new Runnable() {
            @Override
            public void run() {
                syncOfflineFilesInternal(ip, true);
            }
        }).start();
    }

    private void syncOfflineFilesInternal(final String ip, final boolean isInitial) {
        if (ip == null || ip.isEmpty() || isOfflineMode) return;
        try {
            if (isInitial) {
                // Delay slightly on initial connection to prioritize board loading
                Thread.sleep(3000);
            }

            File uploadsDir = new File(getFilesDir(), "uploads");
            if (!uploadsDir.exists()) uploadsDir.mkdirs();

            URL url = new URL("http://" + ip + ":" + mServerPort + "/api/files");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(10000);
            if (conn.getResponseCode() != 200) {
                conn.disconnect();
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
            conn.disconnect();

            JSONArray files = new JSONArray(sb.toString());
            int changedCount = 0;
            int newCount = 0;

            for (int i = 0; i < files.length(); i++) {
                String filename = null;
                long serverMtime = 0;
                long serverSize = 0;

                Object item = files.get(i);
                if (item instanceof JSONObject) {
                    JSONObject obj = (JSONObject) item;
                    filename = obj.optString("name", "");
                    serverMtime = obj.optLong("mtime", 0);
                    serverSize = obj.optLong("size", 0);
                } else if (item instanceof String) {
                    filename = (String) item;
                }

                if (filename == null || filename.isEmpty()) continue;

                try {
                    File localFile = new File(uploadsDir, filename);
                    boolean isNew = !localFile.exists();
                    boolean isChanged = false;

                    if (isNew) {
                        isChanged = true;
                    } else {
                        // Check if file on server was modified
                        if (serverMtime > 0 && Math.abs(localFile.lastModified() - serverMtime) > 1000) {
                            isChanged = true;
                        } else if (serverSize > 0 && localFile.length() != serverSize) {
                            isChanged = true;
                        }
                    }

                    if (isChanged) {
                        String encodedFilename = URLEncoder.encode(filename, "UTF-8").replace("+", "%20");
                        URL fileUrl = new URL("http://" + ip + ":" + mServerPort + "/uploads/" + encodedFilename);
                        HttpURLConnection fileConn = (HttpURLConnection) fileUrl.openConnection();
                        fileConn.setConnectTimeout(4000);
                        fileConn.setReadTimeout(15000);
                        if (fileConn.getResponseCode() == 200) {
                            InputStream fileIs = fileConn.getInputStream();
                            File tempFile = new File(uploadsDir, filename + ".part");
                            FileOutputStream fos = new FileOutputStream(tempFile);
                            byte[] dlBuffer = new byte[8192];
                            int dlRead;
                            while ((dlRead = fileIs.read(dlBuffer)) != -1) {
                                fos.write(dlBuffer, 0, dlRead);
                            }
                            fos.close();
                            fileIs.close();

                            // Atomic replace
                            if (localFile.exists()) localFile.delete();
                            tempFile.renameTo(localFile);

                            if (serverMtime > 0) {
                                localFile.setLastModified(serverMtime);
                            }

                            if (isNew) newCount++;
                            else changedCount++;

                            Log.d("FlowApp", (isNew ? "Downloaded new" : "Updated changed") + " file: " + filename);
                        }
                        fileConn.disconnect();
                    }
                } catch (Exception fileEx) {
                    Log.e("FlowApp", "Failed to sync file: " + filename, fileEx);
                }
            }

            final int totalUpdated = newCount + changedCount;
            if (totalUpdated > 0) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "Synced " + totalUpdated + " updated file" + (totalUpdated > 1 ? "s" : ""), Toast.LENGTH_SHORT).show();
                    }
                });
            } else if (isInitial) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "Files are up to date", Toast.LENGTH_SHORT).show();
                    }
                });
            }
        } catch (Exception e) {
            Log.e("FlowApp", "Offline file sync error", e);
        }
    }

    private void loadApp(String ip) {
        if (ip != null && !ip.isEmpty()) {
            isOfflineMode = false;
            mWebView.loadUrl("http://" + ip + ":" + mServerPort);
        } else {
            isOfflineMode = true;
            mWebView.loadUrl("file:///android_asset/web/index.html");
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
                    checkAndConnect(lastIp, "Reconnected to last server", 1500);
                }
            });
        }

        // 2. High-priority check for known Tailscale IP
        final String tailscaleIp = "100.100.40.92";
        executor.execute(new Runnable() {
            @Override
            public void run() {
                checkAndConnect(tailscaleIp, "Connected via Tailscale! Syncing...", 2000);
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
                        checkAndConnect(targetIp, "Connected via Wi-Fi! Syncing...", 1200);
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
                    executor.awaitTermination(6000, TimeUnit.MILLISECONDS);
                } catch (Exception ignored) {}

                if (!found.get()) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "Server not found. Starting in Offline Mode.", Toast.LENGTH_SHORT).show();
                            loadApp("");
                        }
                    });
                }
            }
        }).start();
    }

    private void checkAndConnect(final String ip, final String successMsg, int timeoutMs) {
        if (found.get()) return;
        for (final int port : NOTE_PORTS) {
            try {
                Socket socket = new Socket();
                socket.connect(new InetSocketAddress(ip, port), timeoutMs);
                socket.close();

                if (found.compareAndSet(false, true)) {
                    mServerPort = port;
                    getSharedPreferences("FlowPrefs", MODE_PRIVATE).edit()
                            .putString("last_ip", ip)
                            .putInt("last_port", port)
                            .apply();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, successMsg, Toast.LENGTH_SHORT).show();
                            loadApp(ip);
                            checkAppUpdate(ip, false);
                            syncOfflineFiles(ip);
                        }
                    });
                    return;
                }
            } catch (Exception ignored) {}
        }
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
                    loadApp("");
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
                int reachablePort = -1;
                for (int port : NOTE_PORTS) {
                    try {
                        Socket socket = new Socket();
                        socket.connect(new InetSocketAddress(ip, port), 1500);
                        socket.close();
                        reachablePort = port;
                        break;
                    } catch (Exception ignored) {}
                }

                final int finalPort = reachablePort;
                final boolean success = (finalPort != -1);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (success) {
                            found.set(true);
                            mServerPort = finalPort;
                            getSharedPreferences("FlowPrefs", MODE_PRIVATE).edit()
                                    .putString("last_ip", ip)
                                    .putInt("last_port", finalPort)
                                    .apply();
                            Toast.makeText(MainActivity.this, "Connected to " + ip + ":" + finalPort + "!", Toast.LENGTH_SHORT).show();
                            loadApp(ip);
                            checkAppUpdate(ip, false);
                            syncOfflineFiles(ip);
                        } else {
                            Toast.makeText(MainActivity.this, "Could not reach " + ip + ". Make sure PC server is running!", Toast.LENGTH_LONG).show();
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
                    URL url = new URL("http://" + ip + ":" + mServerPort + "/api/app-version");
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
                    // A new build is available if the server MD5 is different from the installed APK MD5
                    boolean isNewer = !serverMd5.isEmpty() && !serverMd5.equals(lastInstalledMd5);

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
                            if (mUpdateDialog != null && mUpdateDialog.isShowing()) {
                                return;
                            }
                            mUpdateDialog = new AlertDialog.Builder(MainActivity.this)
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
                    URL url = new URL("http://" + ip + ":" + mServerPort + apkUrl);
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
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == AUDIO_PERMISSION_REQUEST_CODE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                if (mPendingAudioPermissionRequest != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        mPendingAudioPermissionRequest.grant(mPendingAudioPermissionRequest.getResources());
                    }
                    mPendingAudioPermissionRequest = null;
                }
            } else {
                Toast.makeText(this, "Microphone permission is required for voice notes", Toast.LENGTH_SHORT).show();
                if (mPendingAudioPermissionRequest != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        mPendingAudioPermissionRequest.deny();
                    }
                    mPendingAudioPermissionRequest = null;
                }
            }
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    protected void onDestroy() {
        if (mFileSyncScheduler != null) {
            mFileSyncScheduler.shutdownNow();
            mFileSyncScheduler = null;
        }
        super.onDestroy();
    }
}
