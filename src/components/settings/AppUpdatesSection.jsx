import { useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { RefreshCw, Download, Check } from 'lucide-react';
import { checkForUpdate } from '@/lib/appUpdates';
import { getInstalledBuild, downloadAndInstallApk } from '@/lib/updaterNative';

const FRIENDLY_ERRORS = {
  network: 'Could not reach GitHub. Check your connection and try again.',
  'rate-limited': 'GitHub is rate-limiting update checks right now. Try again in a little while.',
  http: 'GitHub returned an error. Try again.',
  'bad-response': 'GitHub sent back something unexpected. Try again.',
  'no-apk': 'The latest release has no APK attached yet.',
  'no-version': 'The latest release does not say which build it is.',
};

function installGuidance(message) {
  if (String(message || '').startsWith('INSTALL_BLOCKED')) {
    return 'Android blocked the install. Allow “Install unknown apps” for COGNOS (phone Settings → Apps → COGNOS → Install unknown apps), then tap Download & install again.';
  }
  return `Install failed: ${message || 'unknown error'}`;
}

/**
 * Settings → App updates. One-tap self-update: checks this repo's latest
 * GitHub release, compares its versionCode against the installed Android
 * build, and downloads + installs with the system DownloadManager and
 * installer. Nothing downloads or installs without an explicit tap.
 */
export default function AppUpdatesSection() {
  const isNative = Capacitor.isNativePlatform();
  const [installed, setInstalled] = useState(null);
  const [state, setState] = useState('idle'); // idle|checking|current|available|downloading|done|error
  const [release, setRelease] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!isNative) return undefined;
    getInstalledBuild().then((b) => {
      if (!cancelled) setInstalled(b);
    });
    return () => { cancelled = true; };
  }, [isNative]);

  const check = useCallback(async () => {
    setState('checking');
    setError(null);
    setRelease(null);
    const result = await checkForUpdate({ fetchImpl: fetch, getInstalledBuild });
    if (result.status === 'error') {
      setState('error');
      setError(FRIENDLY_ERRORS[result.error] || 'Something went wrong. Try again.');
      return;
    }
    if (result.installedBuild != null) setInstalled(String(result.installedBuild));
    setRelease(result);
    setState(result.status === 'update' ? 'available' : 'current');
  }, []);

  const install = useCallback(async () => {
    if (!release || release.status !== 'update') return;
    setState('downloading');
    setError(null);
    try {
      await downloadAndInstallApk(release.assetUrl, release.assetName);
      setState('done');
    } catch (e) {
      setState('error');
      setError(installGuidance(e && e.message));
    }
  }, [release]);

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">App updates</h3>
      <div className="rounded-xl border border-border bg-card p-3 text-xs space-y-2.5">
        {!isNative ? (
          <p className="text-muted-foreground leading-relaxed">
            One-tap updates are available in the Android app. This build is running on the web.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground leading-relaxed">
              Installed build: <span className="font-mono">{installed ?? '…'}</span>
            </p>
            {state === 'current' && (
              <p className="flex items-center gap-1.5 text-foreground/90">
                <Check className="w-3.5 h-3.5 text-green-500" /> You are on the latest build.
              </p>
            )}
            {state === 'available' && release && (
              <p className="text-foreground/90">
                Update available: <span className="font-mono">build {release.releaseVersionCode}</span>
                {release.releaseTag ? <span className="text-muted-foreground"> ({release.releaseTag})</span> : null}
              </p>
            )}
            {state === 'done' && (
              <p className="text-foreground/90 leading-relaxed">
                The installer should be open now — confirm the install there.
                If nothing opened, check your notification shade for the download.
              </p>
            )}
            {state === 'error' && error && (
              <p className="text-destructive leading-relaxed">{error}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={check}
                disabled={state === 'checking' || state === 'downloading'}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${state === 'checking' ? 'animate-spin' : ''}`} />
                {state === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
              {state === 'available' && (
                <button
                  type="button"
                  onClick={install}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground"
                >
                  <Download className="w-3.5 h-3.5" /> Download &amp; install
                </button>
              )}
              {state === 'downloading' && (
                <p className="text-muted-foreground">Downloading… watch the system notification for progress.</p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
