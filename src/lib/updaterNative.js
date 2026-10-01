/**
 * Native bridge for the first-party self-updater plugin (cognos-updater).
 *
 * The plugin is lazily imported — like the TTS adapter — so node tests and
 * the web build never require it to be installed. @capacitor/app (for the
 * installed versionCode) is a real dependency, imported lazily only on
 * native platforms.
 */

import { Capacitor } from '@capacitor/core';

/** Lazily loads the plugin. Resolves to `{ plugin }`; `{ plugin: null }` when absent. */
export function loadUpdaterPlugin() {
  return import('cognos-updater').then(
    (mod) => ({ plugin: mod && mod.CognosUpdater ? mod.CognosUpdater : null }),
    () => ({ plugin: null }),
  );
}

/**
 * Installed Android versionCode as a string, or null on web / when unknown.
 * App.getInfo().build is the versionCode on Android.
 */
export async function getInstalledBuild() {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    return info && info.build != null ? String(info.build) : null;
  } catch {
    return null;
  }
}

/**
 * Download the APK via the system DownloadManager and hand it to the
 * installer. Resolves `{ started: true }` once the installer intent fires.
 * Rejects with INSTALL_BLOCKED:<detail> when Android refuses the install
 * (usually "Install unknown apps" not allowed for COGNOS yet).
 */
export async function downloadAndInstallApk(url, fileName) {
  const { plugin } = await loadUpdaterPlugin();
  if (!plugin || typeof plugin.downloadAndInstall !== 'function') {
    throw new Error('Updater plugin not available on this device');
  }
  return plugin.downloadAndInstall({ url, fileName });
}
