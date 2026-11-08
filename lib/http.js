import { sign, verify, safeEqual } from "./crypto.js";
import { env } from "./config.js";

// Small helpers shared by every API route.

export const SESSION_COOKIE = "jarvis_session";
const SESSION_DAYS = 30;

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers?.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res) {
  const token = sign({ sub: "owner", exp: Date.now() + SESSION_DAYS * 86400000 });
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  );
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function isLoggedIn(req) {
  const payload = verify(parseCookies(req)[SESSION_COOKIE]);
  return !!payload && payload.sub === "owner";
}

// Gate for every user-facing route. State-changing requests must also be
// JSON: browsers cannot send a cross-site JSON POST without a CORS
// preflight, which this app never approves (CSRF defence on top of
// SameSite=Lax).
export function requireUser(req, res) {
  if (!isLoggedIn(req)) {
    send(res, 401, { error: "Not signed in" });
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const ct = String(req.headers["content-type"] || "");
    if (!ct.startsWith("application/json")) {
      send(res, 415, { error: "Expected application/json" });
      return false;
    }
  }
  return true;
}

// Gate for scheduled jobs: Authorization: Bearer <CRON_SECRET>.
export function requireCron(req, res) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, env("CRON_SECRET"))) {
    send(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

export function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "");
  return fwd.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

// Vercel parses JSON bodies for us; tests pass plain objects.
export function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export function methodNotAllowed(res) {
  send(res, 405, { error: "Method not allowed" });
}

// Wraps a handler so an unexpected exception never leaks a stack trace.
export function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "Internal error" });
    }
  };
}
