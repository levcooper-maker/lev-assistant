import { handler, send, body, requireUser, methodNotAllowed } from "../lib/http.js";
import { db, eq } from "../lib/db.js";
import { approveDraft, dismissDraft, runInbox } from "../lib/autopilot.js";
import { ACCOUNT_IDS } from "../lib/config.js";

const STATUSES = ["sent", "drafted", "filed", "archived", "error", "dismissed"];

export default handler(async (req, res) => {
  if (!requireUser(req, res)) return;

  if (req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const status = q.get("status");
    const account = q.get("account");
    const rows = await db.select("processed_emails", {
      ...(STATUSES.includes(status) ? { status: eq(status) } : { status: "neq.processing" }),
      ...(ACCOUNT_IDS.includes(account) ? { account_id: eq(account) } : {}),
      order: "updated_at.desc",
      limit: 100,
      select:
        "id,account_id,status,category,priority,from_name,from_email,subject,summary,reply_body,reply_confidence,risk_flags,reasons,error,received_at,updated_at",
    });
    const since = new Date(Date.now() - 86400000).toISOString();
    const [sent, drafted] = await Promise.all([
      db.count("processed_emails", { status: "eq.sent", updated_at: `gte.${since}` }),
      db.count("processed_emails", { status: "eq.drafted" }),
    ]);
    return send(res, 200, { items: rows || [], stats: { sent24h: sent, waiting: drafted } });
  }

  if (req.method !== "POST") return methodNotAllowed(res);
  const b = body(req);
  if (b.action === "approve") {
    await approveDraft(String(b.id), typeof b.body === "string" ? b.body : undefined);
    return send(res, 200, { ok: true });
  }
  if (b.action === "dismiss") {
    await dismissDraft(String(b.id));
    return send(res, 200, { ok: true });
  }
  if (b.action === "run") {
    return send(res, 200, await runInbox());
  }
  return send(res, 400, { error: "Unknown action" });
});
