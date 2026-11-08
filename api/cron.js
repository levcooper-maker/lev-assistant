import { handler, send, requireCron } from "../lib/http.js";
import { runInbox } from "../lib/autopilot.js";
import { runPlan } from "../lib/planner.js";

// Called by the scheduler (GitHub Actions) with
//   Authorization: Bearer <CRON_SECRET>
//   /api/cron?job=inbox   every 10 minutes
//   /api/cron?job=plan    once each morning
export default handler(async (req, res) => {
  if (!requireCron(req, res)) return;
  const job = new URL(req.url, "http://x").searchParams.get("job");
  if (job === "inbox") return send(res, 200, await runInbox());
  if (job === "plan") return send(res, 200, await runPlan());
  return send(res, 400, { error: "Unknown job" });
});
