import { handler, send, body, requireUser, methodNotAllowed } from "../lib/http.js";
import { db, eq } from "../lib/db.js";
import { ACCOUNT_IDS } from "../lib/config.js";

const PRIORITIES = ["high", "medium", "low"];
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default handler(async (req, res) => {
  if (!requireUser(req, res)) return;

  if (req.method === "GET") {
    const open = await db.select("tasks", { status: "eq.open", order: "due.asc.nullslast,created_at.asc", limit: 200 });
    const done = await db.select("tasks", { status: "eq.done", order: "completed_at.desc", limit: 20 });
    return send(res, 200, { open: open || [], done: done || [] });
  }
  if (req.method !== "POST") return methodNotAllowed(res);

  const b = body(req);
  if (b.action === "add") {
    const title = String(b.title || "").trim().slice(0, 300);
    if (!title) return send(res, 400, { error: "Title required" });
    const [row] = await db.insert("tasks", [
      {
        title,
        due: isDate(b.due) ? b.due : null,
        priority: PRIORITIES.includes(b.priority) ? b.priority : "medium",
        account_id: ACCOUNT_IDS.includes(b.account) ? b.account : null,
        source: "manual",
      },
    ]);
    return send(res, 200, row);
  }
  if (b.action === "update") {
    const patch = {};
    if (b.status === "done" || b.status === "open") {
      patch.status = b.status;
      patch.completed_at = b.status === "done" ? new Date().toISOString() : null;
    }
    if (b.due !== undefined) patch.due = isDate(b.due) ? b.due : null;
    if (PRIORITIES.includes(b.priority)) patch.priority = b.priority;
    if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim().slice(0, 300);
    const rows = await db.update("tasks", { id: eq(b.id) }, patch);
    return send(res, 200, rows?.[0] || {});
  }
  if (b.action === "delete") {
    await db.remove("tasks", { id: eq(b.id) });
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: "Unknown action" });
});
