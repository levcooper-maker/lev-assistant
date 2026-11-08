import { handler, send, body, requireUser, methodNotAllowed } from "../lib/http.js";
import { db, eq, getSettings } from "../lib/db.js";
import { allProviders } from "../lib/mail/index.js";
import { buildPlan, todaysEvents } from "../lib/planner.js";
import { dayRange } from "../lib/time.js";

export default handler(async (req, res) => {
  if (!requireUser(req, res)) return;

  if (req.method === "POST") {
    if (body(req).action !== "replan") return send(res, 400, { error: "Unknown action" });
    const { day, plan, events } = await buildPlan();
    return send(res, 200, { day, plan, events });
  }
  if (req.method !== "GET") return methodNotAllowed(res);

  const settings = await getSettings();
  const { day } = dayRange(settings.timezone);
  const since = new Date(Date.now() - 86400000).toISOString();
  const [planRow, tasks, sent, waiting, handled, providersResult] = await Promise.all([
    db.one("plans", { day: eq(day) }),
    db.select("tasks", { status: "eq.open", order: "due.asc.nullslast,created_at.asc", limit: 8 }),
    db.count("processed_emails", { status: "eq.sent", updated_at: `gte.${since}` }),
    db.count("processed_emails", { status: "eq.drafted" }),
    db.count("processed_emails", { status: "in.(filed,archived,sent,drafted)", updated_at: `gte.${since}` }),
    allProviders(),
  ]);
  const events = await todaysEvents(settings, providersResult.providers);
  return send(res, 200, {
    day,
    timezone: settings.timezone,
    plan: planRow?.data || null,
    events,
    tasks: tasks || [],
    stats: { sent24h: sent, waiting, handled24h: handled, openTasks: (tasks || []).length },
    connectionErrors: providersResult.errors,
  });
});
