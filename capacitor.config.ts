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
    allowNavigation: ['127.0.0.1'],
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
