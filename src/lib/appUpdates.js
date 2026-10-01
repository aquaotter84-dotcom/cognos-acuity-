/**
 * In-app self-updater: pure decision logic over injected dependencies so node
 * tests can exercise every branch without a device or network.
 *
 * Update source of truth: the GitHub releases API for THIS repo only.
 * The publish workflow stamps `versionCode: <N>` (the build workflow's
 * run_number, monotonic) into each release body; the app compares that
 * against its installed build (Android versionCode via App.getInfo()).
 */

export const UPDATER_REPO = 'aquaotter84-dotcom/cognos-acuity-';
export const RELEASES_LATEST_URL = `https://api.github.com/repos/${UPDATER_REPO}/releases/latest`;

// Release-asset download URLs from the API always point at github.com.
// (DownloadManager follows the redirect to objects.githubusercontent.com
// internally; the native plugin allowlists that hop separately.)
const ALLOWED_ASSET_HOSTS = new Set(['github.com']);

/** Extract the `versionCode: <N>` stamp the publish workflow writes into the release body. */
export function extractVersionCode(releaseBody) {
  if (typeof releaseBody !== 'string') return null;
  const m = releaseBody.match(/versionCode:\s*(\d+)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** The .apk asset of a release payload, or null. */
export function findApkAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  return (
    assets.find(
      (a) =>
        a &&
        typeof a.browser_download_url === 'string' &&
        a.browser_download_url.toLowerCase().endsWith('.apk'),
    ) || null
  );
}

/**
 * Trust check for an asset URL: right host AND this repo's release-download
 * path. Defense in depth alongside the native plugin's own host allowlist.
 */
export function isTrustedAssetUrl(url) {
  try {
    const u = new URL(String(url));
    if (!ALLOWED_ASSET_HOSTS.has(u.hostname.toLowerCase())) return false;
    return u.pathname.startsWith(`/${UPDATER_REPO}/releases/download/`);
  } catch {
    return false;
  }
}

/** True when the release build is strictly newer than the installed build. */
export function isUpdateAvailable(installedBuild, releaseVersionCode) {
  const installed = Number.parseInt(installedBuild, 10);
  if (!Number.isFinite(installed) || !Number.isFinite(releaseVersionCode)) return false;
  return releaseVersionCode > installed;
}

/**
 * Check GitHub for a newer build.
 *
 * @param {object} deps
 * @param {(url: string, init?: object) => Promise<Response>} deps.fetchImpl
 * @param {() => Promise<string|null>} deps.getInstalledBuild  installed versionCode, or null when unknown
 * @returns {Promise<object>} { status: 'update'|'current'|'error', ... }
 */
export async function checkForUpdate(deps) {
  const { fetchImpl, getInstalledBuild } = deps;

  let installedBuild = null;
  try {
    installedBuild = await getInstalledBuild();
  } catch {
    installedBuild = null;
  }
  const installed = installedBuild == null ? null : Number.parseInt(installedBuild, 10);

  let res;
  try {
    res = await fetchImpl(RELEASES_LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
  } catch (e) {
    return { status: 'error', error: 'network', detail: String((e && e.message) || e) };
  }
  if (!res || !res.ok) {
    const httpStatus = res ? res.status : 0;
    return {
      status: 'error',
      error: httpStatus === 403 || httpStatus === 429 ? 'rate-limited' : 'http',
      httpStatus,
    };
  }
  let release;
  try {
    release = await res.json();
  } catch {
    return { status: 'error', error: 'bad-response' };
  }

  const versionCode = extractVersionCode(release && release.body);
  const asset = findApkAsset(release);
  if (!asset || !isTrustedAssetUrl(asset.browser_download_url)) {
    return { status: 'error', error: 'no-apk' };
  }
  if (versionCode == null) {
    return { status: 'error', error: 'no-version' };
  }

  const available = installed != null && Number.isFinite(installed) && isUpdateAvailable(installed, versionCode);
  return {
    status: available ? 'update' : 'current',
    installedBuild: installed,
    releaseVersionCode: versionCode,
    releaseTag: (release && release.tag_name) || null,
    assetUrl: asset.browser_download_url,
    assetName: asset.name || 'cognos-update.apk',
  };
}
