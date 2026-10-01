import type { Plugin } from '@capacitor/core';

export interface DownloadAndInstallOptions {
  /** https URL of the APK. The native side only allows github.com and objects.githubusercontent.com. */
  url: string;
  /** File name for the download (path parts are stripped). Defaults to cognos-update.apk. */
  fileName?: string;
}

export interface CognosUpdaterPlugin extends Plugin {
  downloadAndInstall(options: DownloadAndInstallOptions): Promise<{ started: boolean }>;
}

export declare const CognosUpdater: CognosUpdaterPlugin;
