// Security helpers: response headers, rate limiting, origin checks and
// encryption-at-rest for the few secrets the server has to keep.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Response headers

// Pyodide is fetched from a CDN and compiled as WebAssembly, so those origins
// and 'wasm-unsafe-eval' have to be allowed; everything else is locked to same-origin.
const CDN_ORIGINS = ["https://cdn.jsdelivr.net", "https://unpkg.com"];

// index.html carries a small inline bootstrap (theme + Pyodide sources). Hashing
// it keeps the policy strict instead of opening the door with 'unsafe-inline'.
const hashCache = new Map(); // file -> { mtimeMs, hashes }

export function inlineScriptHashes(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const cached = hashCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.hashes;
  const html = fs.readFileSync(file, "utf8");
  const hashes = [];
  const pattern = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    hashes.push(`'sha256-${crypto.createHash("sha256").update(match[1], "utf8").digest("base64")}'`);
  }
  hashCache.set(file, { mtimeMs: stat.mtimeMs, hashes });
  return hashes;
}

function contentSecurityPolicy(scriptHashes = []) {
  const cdn = CDN_ORIGINS.join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${cdn}${scriptHashes.length ? " " + scriptHashes.join(" ") : ""}`,
    "style-src 'self' 'unsafe-inline'", // CodeMirror injects its theme as <style>
    "img-src 'self' data: https:", // problem statements embed images from LeetCode
    `connect-src 'self' ws: wss: ${cdn}`,
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function securityHeaders({ html = false, scriptHashes = [] } = {}) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
  if (html) headers["Content-Security-Policy"] = contentSecurityPolicy(scriptHashes);
  return headers;
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window per key, memory only)

export class RateLimiter {
  constructor({ limit, windowMs, max = 5000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // key -> { count, resetAt }
  }

  // Returns { ok, retryAfter } — retryAfter in whole seconds.
  take(key, cost = 1) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += cost;
    if (this.hits.size > this.max) this.sweep(now);
    if (entry.count > this.limit) return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    return { ok: true, retryAfter: 0 };
  }

  sweep(now = Date.now()) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

// Director's nginx sits in front of the site, so the socket address is always the
// proxy. Trust the proxy headers it sets, and fall back to the socket.
export function clientIp(req) {
  const forwarded = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

// ---------------------------------------------------------------------------
// Cross-site request checks

// Browsers always send Origin on cross-origin POSTs, so rejecting mismatches keeps
// other sites from driving the API with a visitor's session id.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client or same-origin GET
  const host = req.headers["x-forwarded-host"] || req.headers["original-host"] || req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === String(host).trim();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Encryption at rest

// LeetCode session cookies (when a player opts into account judging) are stored
// encrypted, so a leaked or backed-up state.json does not hand them over. The key
// lives beside the data with 0600 permissions: this protects the file, not a full
// compromise of the site directory.
export class SecretBox {
  constructor(dir) {
    this.keyFile = path.join(dir, "secret.key");
    this.key = null;
  }

  loadKey() {
    if (this.key) return this.key;
    try {
      const raw = fs.readFileSync(this.keyFile, "utf8").trim();
      const key = Buffer.from(raw, "base64");
      if (key.length === 32) {
        this.key = key;
        return key;
      }
    } catch {
      /* create below */
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.keyFile, key.toString("base64"), { mode: 0o600 });
    this.key = key;
    return key;
  }

  encrypt(text) {
    if (typeof text !== "string" || !text) return "";
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.loadKey(), iv);
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
  }

  decrypt(value) {
    if (typeof value !== "string" || !value) return "";
    if (!value.startsWith("v1.")) return value; // plaintext from an older release
    const [, iv, tag, body] = value.split(".");
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.loadKey(), Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      return "";
    }
  }
}