// At-rest secret encryption (Phase 37) — ported from OpenMuse's vault.ts (MIT).
//
// AES-256-GCM envelope: v1.nonce.tag.ciphertext, AAD-bound. Dependency-free
// Node crypto. Reimplemented in COGNOS's CommonJS idioms.
//
// The key lives OUTSIDE the database: COGNOS_VAULT_KEY (32-byte base64) if set,
// otherwise a generated key stored at <dataDir>/vault.key with 0600 perms.
// Secrets are still write-only through the API (Jeremy's rule) — this protects
// the database file itself.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";

const AAD = "cognos:credential:v1";

function decodeKey(key) {
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== key) {
    throw new Error("Credential encryption requires a 32-byte base64 key");
  }
  return bytes;
}

/** Versioned AES-256-GCM envelope: version.nonce.tag.ciphertext. */
export function encryptSecret(plaintext, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(key), nonce);
  cipher.setAAD(Buffer.from(AAD));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(encrypted, key) {
  const keyBytes = decodeKey(key);
  const [version, nonceString, tagString, ciphertextString, extra] = String(encrypted).split(".");
  if (
    version !== "v1" ||
    nonceString === undefined ||
    tagString === undefined ||
    ciphertextString === undefined ||
    extra !== undefined
  ) {
    throw new Error("Invalid encrypted secret");
  }
  const encoded = [nonceString, tagString, ciphertextString];
  const [nonce, tag, ciphertext] = encoded.map((value) => Buffer.from(value, "base64url"));
  if (
    nonce.length !== 12 ||
    tag.length !== 16 ||
    encoded.some(
      (value, index) => Buffer.from(value, "base64url").toString("base64url") !== encoded[index]
    )
  ) {
    throw new Error("Invalid encrypted secret");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce);
    decipher.setAAD(Buffer.from(AAD));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unable to authenticate or decrypt credential");
  }
}

/** True if a stored value looks like a vault envelope (vs. a legacy plaintext). */
export function isEncrypted(value) {
  return typeof value === "string" && /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

let cachedKey = null;

/**
 * Resolve the vault key. Env first, then a generated key file beside the data
 * dir. The file is created once with 0600 permissions.
 */
export function getVaultKey({ dataDir = null } = {}) {
  if (cachedKey) return cachedKey;
  if (process.env.COGNOS_VAULT_KEY) {
    cachedKey = process.env.COGNOS_VAULT_KEY;
    decodeKey(cachedKey); // throws early on a bad key
    return cachedKey;
  }
  const dir = dataDir || process.env.COGNOS_DATA_DIR || "/tmp";
  const keyFile = join(dir, "vault.key");
  try {
    if (existsSync(keyFile)) {
      cachedKey = readFileSync(keyFile, "utf8").trim();
      decodeKey(cachedKey);
      return cachedKey;
    }
    mkdirSync(dirname(keyFile), { recursive: true });
    cachedKey = randomBytes(32).toString("base64");
    writeFileSync(keyFile, cachedKey, { mode: 0o600 });
    try { chmodSync(keyFile, 0o600); } catch { /* best effort */ }
    return cachedKey;
  } catch (error) {
    throw new Error(`vault key unavailable: ${error.message}`);
  }
}

/** For tests: reset the cached key. */
export function _resetVaultKeyCache() {
  cachedKey = null;
}
