import { handler, send, body, isLoggedIn, setSessionCookie, clearSessionCookie, clientIp, methodNotAllowed } from "../lib/http.js";
import { safeEqual } from "../lib/crypto.js";
import { db } from "../lib/db.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 10;
const MAX_GLOBAL = 50;

export default handler(async (req, res) => {
  if (req.method === "GET") return send(res, 200, { loggedIn: isLoggedIn(req) });
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    return send(res, 415, { error: "Expected application/json" });
  }

  const { action, password } = body(req);
  if (action === "logout") {
    clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }
  if (action !== "login") return send(res, 400, { error: "Unknown action" });

  const expected = process.env.APP_PASSWORD || "";
  if (expected.length < 12) {
    return send(res, 500, { error: "APP_PASSWORD is not set (or shorter than 12 characters) in Vercel" });
  }

  const ip = clientIp(req);
  const since = `gte.${new Date(Date.now() - WINDOW_MS).toISOString()}`;
  const [byIp, total] = await Promise.all([
    db.count("login_failures", { ip: `eq.${ip.replace(/[,()]/g, "")}`, created_at: since }),
    db.count("login_failures", { created_at: since }),
  ]);
  if (byIp >= MAX_PER_IP || total >= MAX_GLOBAL) {
    return send(res, 429, { error: "Too many attempts. Wait 15 minutes." });
  }

  if (typeof password !== "string" || !safeEqual(password, expected)) {
    await db.insert("login_failures", [{ ip }]);
    return send(res, 401, { error: "Wrong password" });
  }
  setSessionCookie(res);
  return send(res, 200, { ok: true });
});
