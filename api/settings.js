import { handler, send, body, requireUser, methodNotAllowed } from "../lib/http.js";
import { db, eq, getSettings, saveSettings } from "../lib/db.js";
import { ACCOUNTS, ACCOUNT_IDS, DEFAULT_SETTINGS } from "../lib/config.js";

// Validates a settings patch from the app; unknown keys are dropped.
export function cleanSettings(input) {
  const out = {};
  if (["off", "drafts", "full"].includes(input.autopilot)) out.autopilot = input.autopilot;
  if (input.confidence_threshold !== undefined) {
    const n = Number(input.confidence_threshold);
    if (Number.isFinite(n)) out.confidence_threshold = Math.min(1, Math.max(0.5, n));
  }
  if (input.daily_send_cap !== undefined) {
    const n = Math.round(Number(input.daily_send_cap));
    if (Number.isFinite(n)) out.daily_send_cap = Math.min(500, Math.max(0, n));
  }
  for (const k of ["require_prior_correspondence", "auto_archive"]) {
    if (typeof input[k] === "boolean") out[k] = input[k];
  }
  if (Array.isArray(input.never_auto_send)) {
    out.never_auto_send = input.never_auto_send.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 200);
  }
  if (typeof input.timezone === "string") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
      out.timezone = input.timezone;
    } catch {
      /* ignore invalid zone */
    }
  }
  if (ACCOUNT_IDS.includes(input.brief_account)) out.brief_account = input.brief_account;
  for (const k of ["about_me", "reply_profile"]) {
    if (typeof input[k] === "string") out[k] = input[k].slice(0, 8000);
  }
  return out;
}

export default handler(async (req, res) => {
  if (!requireUser(req, res)) return;

  if (req.method === "GET") {
    const [settings, accounts, memory, runs] = await Promise.all([
      getSettings(),
      db.select("accounts", { select: "id,provider,email,connected_at,last_error" }),
      db.select("memory", { order: "created_at.desc", limit: 200 }),
      db.select("runs", { order: "created_at.desc", limit: 10 }),
    ]);
    const byId = Object.fromEntries((accounts || []).map((a) => [a.id, a]));
    return send(res, 200, {
      settings,
      defaults: DEFAULT_SETTINGS,
      accounts: ACCOUNTS.map((a) => ({ ...a, connection: byId[a.id] || null })),
      memory: memory || [],
      runs: runs || [],
      killSwitch: process.env.AUTOPILOT_DISABLED === "1",
    });
  }
  if (req.method !== "POST") return methodNotAllowed(res);

  const b = body(req);
  if (b.action === "disconnect") {
    if (!ACCOUNT_IDS.includes(b.account)) return send(res, 400, { error: "Unknown inbox" });
    await db.remove("accounts", { id: eq(b.account) });
    return send(res, 200, { ok: true });
  }
  if (b.action === "forget") {
    await db.remove("memory", { id: eq(b.id) });
    return send(res, 200, { ok: true });
  }
  if (b.action === "save") {
    return send(res, 200, { settings: await saveSettings(cleanSettings(b.settings || {})) });
  }
  return send(res, 400, { error: "Unknown action" });
});
