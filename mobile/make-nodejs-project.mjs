// Assembles the Capacitor webDir (mobile-dist/) for the Android APK:
//
//   mobile-dist/index.html        <- mobile/boot-index.html (starts Node, then
//                                    redirects the WebView into it)
//   mobile-dist/nodejs/           <- the embedded Node.js project
//       entry.mjs                 <- mobile/entry.mjs (boots server/serve.js)
//       package.json              <- generated, server-only runtime deps
//       server/                   <- copied from the repo
//       dist/                     <- vite build output; Express serves it from
//                                    ../dist relative to server/ with no code
//                                    changes (see server/index.js)
//       node_modules/             <- npm install --omit=dev
//
// The PGlite database files live OUTSIDE this dir, in the app's internal
// storage (<files>/cognos/pglite), so uninstalling/reinstalling the APK
// keeps the code but the data dir is managed by Android per install.
//
// Usage: npm run build && node mobile/make-nodejs-project.mjs

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "mobile-dist");
const nodeDir = path.join(out, "nodejs");

// Server-only runtime deps: no frontend libs, no devDeps, nothing native.
const SERVER_DEPS = [
  "@electric-sql/pglite",
  "@electric-sql/pglite-socket",
  "@neondatabase/serverless",
  "cheerio",
  "cookie-parser",
  "express",
  "mammoth",
  "pdfjs-dist",
  "pg",
  "ws",
];

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// The mobile tree is installed fresh with `npm install` (no lockfile), so
// version ranges would drift to newest releases at build time. That broke
// the app once: cheerio pulled undici 7, which references the `File`
// global at import time — absent on the phone's Node 18 — crashing the
// engine on every launch. Pin every server dep (and undici itself,
// belt-and-braces) to the exact versions in the root lockfile, which CI
// verifies via `npm ci`.
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const lockedVersion = (name) => {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version) throw new Error(`server dep ${name} missing from root package-lock.json`);
  return entry.version;
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(nodeDir, { recursive: true });

// 1. boot page
fs.copyFileSync(path.join(root, "mobile", "boot-index.html"), path.join(out, "index.html"));

// 2. server code + entry point
fs.cpSync(path.join(root, "server"), path.join(nodeDir, "server"), { recursive: true });
fs.copyFileSync(path.join(root, "mobile", "entry.mjs"), path.join(nodeDir, "entry.mjs"));

// 3. frontend build (must exist: run `npm run build` first)
const dist = path.join(root, "dist");
if (!fs.existsSync(dist)) throw new Error("dist/ missing — run `npm run build` first");
fs.cpSync(dist, path.join(nodeDir, "dist"), { recursive: true });

// 4. pruned package.json + production-only install
const nodePkg = {
  name: "cognos-android",
  private: true,
  version: pkg.version,
  type: "module",
  main: "entry.mjs",
  dependencies: Object.fromEntries(
    SERVER_DEPS.map((name) => [name, lockedVersion(name)])
  ),
  overrides: {
    undici: lockedVersion("undici"),
  },
};
fs.writeFileSync(path.join(nodeDir, "package.json"), JSON.stringify(nodePkg, null, 2) + "\n");
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: nodeDir, stdio: "inherit" });

console.log("mobile-dist ready at", out);
