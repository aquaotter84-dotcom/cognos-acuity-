// Server-side URL retrieval with DNS pinning and SSRF defenses.
// It intentionally does not use global fetch: validating a hostname and then
// letting another resolver connect would leave a DNS-rebinding gap. The request
// below connects only to an address we validated while preserving TLS SNI/Host.

import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { throwIfAborted } from "../shared/cancellation.js";

const blockedV4 = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blockedV4.addSubnet(network, prefix, "ipv4");

const blockedV6 = new net.BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8], ["2001:db8::", 32]
]) blockedV6.addSubnet(network, prefix, "ipv6");

function mappedIpv4(address) {
  const match = String(address).toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return match?.[1] || null;
}

export function isPublicAddress(address, family = net.isIP(address)) {
  if (family === 4 || family === "IPv4") return !blockedV4.check(address, "ipv4");
  if (family === 6 || family === "IPv6") {
    const mapped = mappedIpv4(address);
    return mapped ? isPublicAddress(mapped, 4) : !blockedV6.check(address, "ipv6");
  }
  return false;
}

const plainHostname = value => String(value || "").replace(/^\[|\]$/g, "");

export function normalizePublicUrl(input) {
  let url;
  try { url = new URL(String(input || "").trim()); }
  catch { throw Object.assign(new Error("Enter a valid absolute http or https URL"), { status: 400 }); }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("Only http and https links can be opened"), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error("Links containing credentials are not allowed"), { status: 400 });
  }
  const hostname = plainHostname(url.hostname).toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw Object.assign(new Error("Local-network links are not allowed"), { status: 400 });
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!new Set(["80", "443"]).has(port)) {
    throw Object.assign(new Error("Only standard web ports 80 and 443 are allowed"), { status: 400 });
  }
  if (net.isIP(hostname) !== 6) url.hostname = hostname;
  url.hash = "";
  return url;
}

async function resolvePublic(hostname) {
  const plain = plainHostname(hostname);
  const literalFamily = net.isIP(plain);
  let records;
  try {
    records = literalFamily
      ? [{ address: plain, family: literalFamily }]
      : await dns.lookup(plain, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error("The link hostname could not be resolved"), { status: 422 });
  }
  if (!records.length) throw Object.assign(new Error("The link hostname did not resolve"), { status: 422 });
  if (records.some(record => !isPublicAddress(record.address, record.family))) {
    throw Object.assign(new Error("The link resolves to a private, local, reserved, or non-public address"), { status: 403 });
  }
  return records;
}

function pinnedLookup(records) {
  return (_hostname, options, callback) => {
    const family = typeof options === "object" ? Number(options.family || 0) : Number(options || 0);
    const candidates = family ? records.filter(r => Number(r.family) === family) : records;
    const selected = candidates[0] || records[0];
    if (typeof options === "object" && options.all) return callback(null, candidates);
    callback(null, selected.address, selected.family);
  };
}

function oneRequest(url, records, { signal, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const req = transport.request(url, {
      method: "GET",
      lookup: pinnedLookup(records),
      servername: plainHostname(url.hostname),
      headers: {
        "User-Agent": "COGNOS-SourceReader/1.0",
        Accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "identity",
        Cookie: ""
      }
    }, response => {
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > maxBytes) {
        response.destroy();
        return finish(reject, Object.assign(new Error(`Link response exceeds the ${maxBytes} byte limit`), { status: 413 }));
      }
      const encoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
      if (!new Set(["", "identity"]).has(encoding)) {
        response.destroy();
        return finish(reject, Object.assign(new Error(`Unexpected compressed response (${encoding}); safe reader requested identity encoding`), { status: 422 }));
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy(Object.assign(new Error(`Link response exceeds the ${maxBytes} byte limit`), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", error => finish(reject, error));
      response.on("end", () => finish(resolve, {
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        bytes
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`Link fetch timed out after ${timeoutMs}ms`), { status: 504 })));
    req.on("error", error => finish(reject, error));
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error("Link fetch cancelled"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

export async function safeFetch(input, {
  signal = null,
  timeoutMs = 12_000,
  maxBytes = 2_000_000,
  maxRedirects = 4
} = {}) {
  let url = normalizePublicUrl(input);
  const visited = new Set();
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    throwIfAborted(signal);
    if (visited.has(url.href)) throw Object.assign(new Error("Redirect loop detected"), { status: 422 });
    visited.add(url.href);
    const records = await resolvePublic(url.hostname);
    const response = await oneRequest(url, records, { signal, timeoutMs, maxBytes });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) throw Object.assign(new Error("Redirect response did not include a Location header"), { status: 422 });
      if (redirects === maxRedirects) throw Object.assign(new Error(`Link exceeded ${maxRedirects} redirects`), { status: 422 });
      const nextUrl = normalizePublicUrl(new URL(location, url).href);
      if (url.protocol === "https:" && nextUrl.protocol !== "https:") {
        throw Object.assign(new Error("HTTPS links may not redirect to insecure HTTP"), { status: 422 });
      }
      url = nextUrl;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`Link returned HTTP ${response.status}`), { status: 422 });
    }
    return { ...response, finalUrl: url.href, redirects: visited.size - 1 };
  }
  throw Object.assign(new Error("Unable to retrieve link"), { status: 422 });
}
