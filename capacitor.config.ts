import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.cognos.acuity',
  appName: 'COGNOS',
  // Assembled by `node mobile/make-nodejs-project.mjs` (not committed):
  // a boot page plus the embedded Node.js project under nodejs/.
  webDir: 'mobile-dist',
  server: {
    // The embedded server speaks plain HTTP on loopback only.
    cleartext: true,
    // NATIVE-BRIDGE COUPLING (incident 2026-10-01): Capacitor injects
    // window.androidBridge — the thing that makes every native plugin work
    // (TTS, mic dictation, notifications) — only on origins matching these
    // rules. Entries not starting with "http" are prefixed "https://" by
    // Capacitor (Bridge.java setAllowedOriginRules), so a bare '127.0.0.1'
    // becomes the rule "https://127.0.0.1". The embedded Node server serves
    // the app page at http://127.0.0.1:39391/ (PORT hardcoded in
    // mobile/boot-index.html), whose origin matches neither the https rule
    // nor any port-less rule — so the bridge was never injected, and
    // Capacitor.isNativePlatform() was false on the app page: every native
    // plugin silently dead. The rule must name scheme + host + port VERBATIM.
    // If the boot PORT ever changes, this rule must change with it.
    // Guarded by test/capacitor-origin.mjs.
    allowNavigation: ['127.0.0.1', 'http://127.0.0.1:39391'],
  },
  android: {
    backgroundColor: '#0b0e14',
  },
  plugins: {
    CapacitorNodeJS: {
      nodeDir: 'nodejs',
      // The boot page starts Node itself so it can pass COGNOS_DATA_DIR
      // (internal storage) and PORT via env. See mobile/boot-index.html.
      startMode: 'manual',
    },
  },
};

export default config;
