import crypto from "node:crypto";
import { env } from "./config.js";

// ── Token encryption (AES-256-GCM) ─────────────────────────────────────
// OAuth refresh tokens are encrypted before they reach the database, so a
// leaked database row alone does not give access to the mailbox.

function encKey() {
  const raw = env("TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }
  return key;
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decrypt(payload) {
  const [v, iv, tag, ct] = String(payload).split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Bad ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// ── Signed tokens (sessions, OAuth state) ──────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function hmac(data) {
  return crypto.createHmac("sha256", env("SESSION_SECRET")).update(data).digest();
}

export function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(hmac(body))}`;
}

// Returns the payload, or null when the signature is wrong or it expired.
export function verify(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = hmac(body);
  const given = Buffer.from(sig || "", "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}
