import { registerPlugin } from '@capacitor/core';

/**
 * First-party self-updater plugin (Android only).
 *
 * downloadAndInstall({ url, fileName }) enqueues the APK in Android's
 * DownloadManager (system progress UI, survives the app going to the
 * background) and, when the download completes, fires ACTION_VIEW on the
 * file through our FileProvider so the system installer takes over.
 * The returned promise resolves once the installer intent is handed off,
 * or rejects with a plain message (INSTALL_BLOCKED when Android refuses
 * the install — e.g. "Install unknown apps" not allowed for COGNOS).
 */
export const CognosUpdater = registerPlugin('CognosUpdater');
