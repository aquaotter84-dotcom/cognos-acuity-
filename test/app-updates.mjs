#!/usr/bin/env node
// In-app self-updater tests. Pure decision logic (src/lib/appUpdates.js) is
// exercised directly with mocked fetch; the CI wiring (version stamping,
// manifest patches, publish body) and the native plugin are pinned with
// source-shape assertions in the repo's existing style.

import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; };

const {
  UPDATER_REPO,
  RELEASES_LATEST_URL,
  extractVersionCode,
  findApkAsset,
  isTrustedAssetUrl,
  isUpdateAvailable,
  checkForUpdate,
} = await import('../src/lib/appUpdates.js');

// --- extractVersionCode -------------------------------------------------------
ok('extractVersionCode parses the publish-workflow stamp', () => {
  assert.equal(extractVersionCode('COGNOS Android build.\nversionCode: 3693\nAsset: x.apk'), 3693);
});
ok('extractVersionCode returns null when the stamp is missing', () => {
  assert.equal(extractVersionCode('no stamp here'), null);
  assert.equal(extractVersionCode(null), null);
  assert.equal(extractVersionCode(undefined), null);
});
ok('extractVersionCode ignores unrelated numbers', () => {
  assert.equal(extractVersionCode('build 1234 is great'), null);
});

// --- findApkAsset --------------------------------------------------------------
const APK_URL = 'https://github.com/aquaotter84-dotcom/cognos-acuity-/releases/download/cognos-apk-x/cognos-apk-self-updater.apk';
ok('findApkAsset picks the .apk asset', () => {
  const release = { assets: [{ name: 'notes.txt', browser_download_url: 'https://x/notes.txt' }, { name: 'a.apk', browser_download_url: APK_URL }] };
  assert.equal(findApkAsset(release).browser_download_url, APK_URL);
});
ok('findApkAsset returns null without an apk', () => {
  assert.equal(findApkAsset({ assets: [] }), null);
  assert.equal(findApkAsset({}), null);
  assert.equal(findApkAsset(null), null);
});

// --- isTrustedAssetUrl ----------------------------------------------------------
ok('isTrustedAssetUrl only accepts this repo on github.com', () => {
  assert.equal(isTrustedAssetUrl(APK_URL), true);
  // objects.githubusercontent.com only appears inside DownloadManager's
  // redirect chain (native allowlist) — never as a JS-layer update URL.
  assert.equal(
    isTrustedAssetUrl('https://objects.githubusercontent.com/aquaotter84-dotcom/cognos-acuity-/releases/download/t/f.apk'),
    false,
  );
});
ok('isTrustedAssetUrl rejects other hosts and repos', () => {
  assert.equal(isTrustedAssetUrl('https://evil.com/aquaotter84-dotcom/cognos-acuity-/releases/download/t/f.apk'), false);
  assert.equal(isTrustedAssetUrl('https://github.com/someone-else/other-repo/releases/download/t/f.apk'), false);
  assert.equal(isTrustedAssetUrl('https://github.com/aquaotter84-dotcom/cognos-acuity-/releases/tag/t'), false);
  assert.equal(isTrustedAssetUrl('not a url'), false);
  assert.equal(isTrustedAssetUrl(null), false);
});

// --- isUpdateAvailable ------------------------------------------------------------
ok('isUpdateAvailable compares strictly', () => {
  assert.equal(isUpdateAvailable('100', 101), true);
  assert.equal(isUpdateAvailable('101', 101), false);
  assert.equal(isUpdateAvailable('102', 101), false);
});
ok('isUpdateAvailable is false on garbage input', () => {
  assert.equal(isUpdateAvailable(null, 101), false);
  assert.equal(isUpdateAvailable('abc', 101), false);
  assert.equal(isUpdateAvailable('100', null), false);
  assert.equal(isUpdateAvailable('100', NaN), false);
});

// --- checkForUpdate ---------------------------------------------------------------
const releasePayload = (overrides = {}) => ({
  tag_name: 'cognos-apk-abc123',
  body: 'COGNOS Android build.\nversionCode: 200\nAsset: a.apk',
  assets: [{ name: 'a.apk', browser_download_url: APK_URL }],
  ...overrides,
});
const mockFetch = (payload, { okStatus = true, status = 200 } = {}) => async () => ({
  ok: okStatus,
  status,
  json: async () => payload,
});

ok('checkForUpdate reports update when the release is newer', async () => {
  const r = await checkForUpdate({
    fetchImpl: mockFetch(releasePayload()),
    getInstalledBuild: async () => '199',
  });
  assert.equal(r.status, 'update');
  assert.equal(r.releaseVersionCode, 200);
  assert.equal(r.assetUrl, APK_URL);
  assert.equal(r.releaseTag, 'cognos-apk-abc123');
});
ok('checkForUpdate reports current when already up to date', async () => {
  const r = await checkForUpdate({
    fetchImpl: mockFetch(releasePayload()),
    getInstalledBuild: async () => '200',
  });
  assert.equal(r.status, 'current');
});
ok('checkForUpdate never claims an update when the installed build is unknown', async () => {
  const r = await checkForUpdate({
    fetchImpl: mockFetch(releasePayload()),
    getInstalledBuild: async () => null,
  });
  assert.equal(r.status, 'current');
});
ok('checkForUpdate maps a network failure to a friendly error', async () => {
  const r = await checkForUpdate({
    fetchImpl: async () => { throw new Error('boom'); },
    getInstalledBuild: async () => '1',
  });
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'network');
});
ok('checkForUpdate maps 403/429 to rate-limited', async () => {
  for (const status of [403, 429]) {
    const r = await checkForUpdate({
      fetchImpl: mockFetch({}, { okStatus: false, status }),
      getInstalledBuild: async () => '1',
    });
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'rate-limited');
  }
});
ok('checkForUpdate errors when there is no apk asset or no version stamp', async () => {
  const noApk = await checkForUpdate({
    fetchImpl: mockFetch(releasePayload({ assets: [] })),
    getInstalledBuild: async () => '1',
  });
  assert.equal(noApk.error, 'no-apk');
  const noVersion = await checkForUpdate({
    fetchImpl: mockFetch(releasePayload({ body: 'no stamp' })),
    getInstalledBuild: async () => '1',
  });
  assert.equal(noVersion.error, 'no-version');
});
ok('checkForUpdate rejects untrusted asset URLs', async () => {
  const r = await checkForUpdate({
    fetchImpl: mockFetch(releasePayload({
      assets: [{ name: 'a.apk', browser_download_url: 'https://evil.com/x.apk' }],
    })),
    getInstalledBuild: async () => '1',
  });
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'no-apk');
});
ok('checkForUpdate hits the releases/latest endpoint of this repo', () => {
  assert.equal(RELEASES_LATEST_URL, `https://api.github.com/repos/${UPDATER_REPO}/releases/latest`);
  assert.equal(UPDATER_REPO, 'aquaotter84-dotcom/cognos-acuity-');
});

// --- CI wiring: version stamp -------------------------------------------------------
const androidYml = read('.github/workflows/android.yml');
ok('android.yml stamps versionCode/versionName from the run number', () => {
  assert.match(androidYml, /Stamp versionCode\/versionName from build run number/);
  assert.match(androidYml, /versionCode \$\{\{ github\.run_number \}\}/);
  // The YAML line sits inside a double-quoted shell string, so its quotes are backslash-escaped.
  assert.match(androidYml, /versionName \\\"1\.0\.\$\{\{ github\.run_number \}\}\\\"/);
});
ok('android.yml restores a stable debug keystore before the build', () => {
  assert.match(androidYml, /Restore stable debug keystore/);
  assert.match(androidYml, /COGNOS_DEBUG_KEYSTORE_B64/);
  assert.match(androidYml, /~\/.android\/debug\.keystore/);
  assert.match(androidYml, /-alias androiddebugkey/);
  // The restore step must come before the gradle build in the file.
  assert.ok(
    androidYml.indexOf('Restore stable debug keystore') < androidYml.indexOf('Build debug APK'),
    'keystore restore must precede the gradle build',
  );
});
ok('android.yml pins the debug signingConfig explicitly to the stable keystore', () => {
  // AGP's implicit ~/.android/debug.keystore lookup generated a throwaway
  // key instead of using the restored file (build 36939542224), so the
  // signing config must be explicit, not implicit.
  assert.match(androidYml, /Pin debug signing to the stable keystore/);
  assert.match(androidYml, /STABLE_DEBUG_SIGNING/);
  assert.match(androidYml, /signingConfigs \{/);
  assert.match(androidYml, /storeFile file\(System\.getProperty\('user\.home'\)/);
  assert.match(androidYml, /keyAlias 'androiddebugkey'/);
  assert.ok(
    androidYml.indexOf('Pin debug signing to the stable keystore') < androidYml.indexOf('Build debug APK'),
    'signing pin must precede the gradle build',
  );
});
ok('android.yml enables the self-update install path in the manifest', () => {
  assert.match(androidYml, /Enable self-update install path/);
  assert.match(androidYml, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
  assert.match(androidYml, /cognos-updater-fileprovider/);
  assert.match(androidYml, /androidx\.core\.content\.FileProvider/);
  assert.match(androidYml, /\$\{applicationId\}\.fileprovider/);
  assert.match(androidYml, /cognos_filepaths/);
  assert.match(androidYml, /external-files-path/);
});

const publishYml = read('.github/workflows/publish-release-apk.yml');
ok('publish workflow stamps versionCode into the release body', () => {
  assert.match(publishYml, /Resolve build versionCode/);
  assert.match(publishYml, /versionCode: \$\{\{ steps\.build_version\.outputs\.version_code \}\}/);
  assert.match(publishYml, /actions\/runs\/\$\{\{ inputs\.run_id \}\}/);
});

// --- native plugin -------------------------------------------------------------------
const pluginJava = read('plugins/cognos-updater/android/src/main/java/com/cognos/updater/CognosUpdaterPlugin.java');
ok('updater plugin downloads via DownloadManager and installs via FileProvider', () => {
  assert.match(pluginJava, /DownloadManager/);
  assert.match(pluginJava, /FileProvider\.getUriForFile/);
  assert.match(pluginJava, /ACTION_VIEW/);
  assert.match(pluginJava, /INSTALL_BLOCKED/);
  assert.match(pluginJava, /application\/vnd\.android\.package-archive/);
});
ok('updater plugin only allows GitHub release hosts', () => {
  assert.match(pluginJava, /"github\.com"/);
  assert.match(pluginJava, /"objects\.githubusercontent\.com"/);
  assert.match(pluginJava, /Refusing to download from untrusted host/);
});
const pluginPkg = JSON.parse(read('plugins/cognos-updater/package.json'));
ok('updater plugin is registered as a Capacitor android plugin', () => {
  assert.equal(pluginPkg.capacitor.android.src, 'android');
  assert.equal(pluginPkg.name, 'cognos-updater');
});

// --- JS wiring --------------------------------------------------------------------------
const settingsSource = read('src/pages/Settings.jsx');
ok('Settings renders the App updates section', () => {
  assert.match(settingsSource, /import AppUpdatesSection from '@\/components\/settings\/AppUpdatesSection'/);
  assert.match(settingsSource, /<AppUpdatesSection \/>/);
});
const sectionSource = read('src/components/settings/AppUpdatesSection.jsx');
ok('App updates section has check + install affordances', () => {
  assert.match(sectionSource, /Check for updates/);
  assert.match(sectionSource, /Download &amp; install/);
  assert.match(sectionSource, /Install unknown apps/);
  assert.match(sectionSource, /checkForUpdate/);
  assert.match(sectionSource, /downloadAndInstallApk/);
});
const updaterNative = read('src/lib/updaterNative.js');
ok('updaterNative lazily loads the plugin and reads the installed build', () => {
  assert.match(updaterNative, /import\('cognos-updater'\)/);
  assert.match(updaterNative, /App\.getInfo\(\)/);
  assert.match(updaterNative, /isNativePlatform/);
});
const pkg = JSON.parse(read('package.json'));
ok('package.json carries the updater dependencies', () => {
  assert.ok(pkg.dependencies['@capacitor/app'], '@capacitor/app is required for App.getInfo()');
  assert.match(pkg.dependencies['cognos-updater'], /^file:/);
});
ok('package.json test script runs the updater tests', () => {
  assert.match(pkg.scripts.test, /node test\/app-updates\.mjs/);
});

console.log(`APP-UPDATES RESULT: ${passed} passed, 0 failed`);
