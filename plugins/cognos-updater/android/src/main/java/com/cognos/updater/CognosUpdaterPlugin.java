package com.cognos.updater;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * First-party COGNOS self-updater (Android only).
 *
 * downloadAndInstall({ url, fileName }) enqueues the APK with Android's
 * DownloadManager — the system shows its own progress notification, and the
 * download survives the app going to the background. When the download
 * completes, the plugin fires ACTION_VIEW on the file through the app's
 * FileProvider ({@code <package>.fileprovider}, declared by the CI manifest
 * patch) so the system installer takes over.
 *
 * Safety: only https URLs on github.com / objects.githubusercontent.com /
 * api.github.com are accepted — the JS layer additionally restricts downloads
 * to this repo's release assets. Nothing installs without the user tapping
 * "Download & install" in Settings; Android itself shows the install
 * confirmation screen.
 */
@CapacitorPlugin(name = "CognosUpdater")
public class CognosUpdaterPlugin extends Plugin {

    private static final Set<String> ALLOWED_HOSTS = new HashSet<>(Arrays.asList(
            "github.com",
            "objects.githubusercontent.com",
            "api.github.com"
    ));

    private BroadcastReceiver downloadReceiver;
    private long pendingDownloadId = -1;
    private PluginCall pendingCall;
    private String pendingFileName;

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        if (pendingCall != null) {
            call.reject("A download is already in progress");
            return;
        }
        String url = call.getString("url");
        String fileName = call.getString("fileName", "cognos-update.apk");
        if (url == null || url.isEmpty()) {
            call.reject("Missing download URL");
            return;
        }
        String host = Uri.parse(url).getHost();
        if (host == null || !ALLOWED_HOSTS.contains(host.toLowerCase())) {
            call.reject("Refusing to download from untrusted host");
            return;
        }
        // Sanitize: strip any path parts, force the .apk extension.
        fileName = new File(fileName).getName();
        if (fileName.isEmpty()) {
            fileName = "cognos-update.apk";
        }
        if (!fileName.toLowerCase().endsWith(".apk")) {
            fileName = fileName + ".apk";
        }

        Context context = getContext();
        try {
            // A stale file at the destination makes DownloadManager fail the
            // new download, so clear it first.
            File dest = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName);
            if (dest.exists() && !dest.delete()) {
                call.reject("Could not clear a previous download");
                return;
            }

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("COGNOS update");
            request.setDescription("Downloading update…");
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setMimeType("application/vnd.android.package-archive");
            request.setDestinationInExternalFilesDir(
                    context, Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager dm =
                    (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            long id = dm.enqueue(request);

            pendingDownloadId = id;
            pendingCall = call;
            pendingFileName = fileName;

            if (downloadReceiver == null) {
                downloadReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context ctx, Intent intent) {
                        long doneId = intent.getLongExtra(
                                DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                        if (doneId == pendingDownloadId) {
                            onDownloadComplete(ctx);
                        }
                    }
                };
                IntentFilter filter =
                        new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                if (Build.VERSION.SDK_INT >= 33) {
                    context.registerReceiver(
                            downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
                } else {
                    context.registerReceiver(downloadReceiver, filter);
                }
            }
            // The call stays open: it resolves when the installer intent is
            // handed off, or rejects if the download fails.
        } catch (Exception e) {
            call.reject("Download failed to start: " + e.getMessage());
        }
    }

    private void onDownloadComplete(Context context) {
        PluginCall call = pendingCall;
        long id = pendingDownloadId;
        String fileName = pendingFileName;
        pendingCall = null;
        pendingDownloadId = -1;
        pendingFileName = null;
        if (call == null) {
            return;
        }

        DownloadManager dm =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
        try (Cursor c = dm.query(query)) {
            if (c != null && c.moveToFirst()) {
                int status = c.getInt(
                        c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    launchInstaller(context, fileName, call);
                    return;
                }
                int reason = c.getInt(
                        c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                call.reject("Download failed (status=" + status + ", reason=" + reason + ")");
                return;
            }
        } catch (Exception e) {
            call.reject("Download failed: " + e.getMessage());
            return;
        }
        call.reject("Download not found");
    }

    private void launchInstaller(Context context, String fileName, PluginCall call) {
        try {
            File apk = new File(
                    context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName);
            Uri uri = FileProvider.getUriForFile(
                    context, context.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            context.startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception e) {
            // Usually Android 8+: "Install unknown apps" is not allowed for
            // COGNOS yet. The JS layer turns this into guidance.
            call.reject("INSTALL_BLOCKED:" + e.getMessage());
        }
    }

    /**
     * Raw TTS diagnostic: bypasses the @capacitor-community text-to-speech
     * plugin and asks the OS directly what the engine looks like.
     *
     * The engine is constructed on the calling (main) thread — TextToSpeech
     * binds its callback handler to a Looper — while the up-to-5s init wait
     * runs on a worker thread so the UI never blocks. The call is NEVER
     * rejected on diagnostic failure; problems are reported in the `error`
     * string field instead.
     */
    @PluginMethod
    public void diagnoseTts(PluginCall call) {
        final JSObject ret = new JSObject();
        final Context context = getContext();

        // 1. Is the engine package visible to us at all? On Android 11+ this
        // is false without a <queries> manifest entry for TTS_SERVICE.
        boolean engineVisible = false;
        try {
            context.getPackageManager().getApplicationInfo(
                    "com.google.android.tts", 0);
            engineVisible = true;
        } catch (PackageManager.NameNotFoundException ignored) {
            engineVisible = false;
        }
        ret.put("engineVisible", engineVisible);

        // 2. The engine the user picked in system settings (may be null).
        String defaultEngine = null;
        try {
            defaultEngine = Settings.Secure.getString(
                    context.getContentResolver(), Settings.Secure.TTS_DEFAULT_SYNTH);
        } catch (Exception ignored) {
            defaultEngine = null;
        }
        ret.put("defaultEngine",
                defaultEngine != null ? defaultEngine : JSObject.NULL);

        // 3. Raw android.speech.tts.TextToSpeech bind.
        final CountDownLatch latch = new CountDownLatch(1);
        final int[] initCode = { Integer.MIN_VALUE };
        final TextToSpeech[] holder = new TextToSpeech[1];
        try {
            holder[0] = new TextToSpeech(context, status -> {
                initCode[0] = status;
                latch.countDown();
            });
        } catch (Exception e) {
            ret.put("initStatus", "ERROR");
            ret.put("voiceCount", 0);
            ret.put("error", "TextToSpeech constructor threw: " + e.getMessage());
            call.resolve(ret);
            return;
        }

        new Thread(() -> {
            try {
                boolean finished;
                try {
                    finished = latch.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    finished = false;
                }
                String initStatus = !finished ? "TIMEOUT"
                        : (initCode[0] == TextToSpeech.SUCCESS ? "SUCCESS" : "ERROR");
                ret.put("initStatus", initStatus);

                int voiceCount = 0;
                if (finished && initCode[0] == TextToSpeech.SUCCESS) {
                    try {
                        Set<Voice> voices = holder[0].getVoices();
                        voiceCount = voices == null ? 0 : voices.size();
                    } catch (Exception e) {
                        ret.put("error", "getVoices failed: " + e.getMessage());
                    }
                }
                ret.put("voiceCount", voiceCount);
            } catch (Exception e) {
                ret.put("error", String.valueOf(e.getMessage()));
            } finally {
                try {
                    if (holder[0] != null) holder[0].shutdown();
                } catch (Exception ignored) {
                    // Best effort; the diagnostic result stands on its own.
                }
            }
            call.resolve(ret);
        }, "cognos-tts-diagnose").start();
    }

    @Override
    protected void handleOnDestroy() {        if (downloadReceiver != null) {
            try {
                getContext().unregisterReceiver(downloadReceiver);
            } catch (Exception ignored) {
                // Already unregistered or context gone; nothing to do.
            }
            downloadReceiver = null;
        }
        if (pendingCall != null) {
            pendingCall.reject("Updater was torn down");
            pendingCall = null;
            pendingDownloadId = -1;
            pendingFileName = null;
        }
    }
}
