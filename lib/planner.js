import { db, getSettings } from "./db.js";
import { allProviders, providerById } from "./mail/index.js";
import { createJson } from "./claude.js";
import { dayRange, localTime, nowLocal } from "./time.js";
import { accountById } from "./config.js";

// Gathers today's calendar across every inbox. Graph returns local times
// without an offset when asked for a time zone; normalize them here.
export async function todaysEvents(settings, providers, days = 1) {
  const { start, end } = dayRange(settings.timezone, new Date(), days);
  const events = [];
  for (const p of providers) {
    try {
      const list = await p.listEvents(start, end, settings.timezone);
      events.push(...list);
    } catch (err) {
      events.push({ accountId: p.accountId, error: String(err.message) });
    }
  }
  return events
    .filter((e) => !e.error)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "top_three", "schedule", "automate_or_delegate", "heads_up", "email_digest"],
  properties: {
    headline: { type: "string", description: "One line that frames the day." },
    top_three: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "why"],
        properties: { title: { type: "string" }, why: { type: "string" } },
      },
    },
    schedule: {
      type: "array",
      description: "The day in order: fixed meetings plus focus blocks placed in the gaps.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["time", "item", "kind"],
        properties: {
          time: { type: "string", description: "e.g. 9:00 AM" },
          item: { type: "string" },
          kind: { type: "string", enum: ["meeting", "focus", "task", "personal", "break"] },
        },
      },
    },
    automate_or_delegate: {
      type: "array",
      description: "Things on his plate that Jarvis or someone else could take over, and how.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "how"],
        properties: { item: { type: "string" }, how: { type: "string" } },
      },
    },
    heads_up: { type: "array", items: { type: "string" } },
    email_digest: { type: "string", description: "Short paragraph: what the autopilot handled and what is waiting on him." },
  },
};

const PLAN_SYSTEM = `You are the chief of staff for a business owner who runs a real-estate investment firm, an oilfield service company, and a busy personal life. Each morning you turn his calendar, open tasks and inbox activity into a realistic plan for the day.

Principles:
- Protect his time. Put the three things that actually move his businesses forward first.
- Build the schedule around fixed meetings; place focus blocks for the top three in real gaps. Do not over-pack the day.
- Be specific: name the person, the deal, the deadline.
- Look hard for work he should not be doing himself (routine replies, scheduling, follow-ups, data entry, reminders) and say exactly how Jarvis or a delegate could take it.
- Flag conflicts, overdue items, and anything that will bite him later this week.`;

export async function buildPlan() {
  const settings = await getSettings();
  const { providers } = await allProviders();
  const tz = settings.timezone;
  const events = await todaysEvents(settings, providers);
  const tasks =
    (await db.select("tasks", { status: "eq.open", order: "due.asc.nullslast,created_at.asc", limit: 60 })) || [];
  const since = new Date(Date.now() - 36 * 3600000).toISOString();
  const emails =
    (await db.select("processed_emails", {
      updated_at: `gte.${since}`,
      status: "in.(sent,drafted,filed,archived)",
      order: "updated_at.desc",
      limit: 80,
      select: "account_id,status,category,priority,from_name,from_email,subject,summary",
    })) || [];

  const counts = emails.reduce((acc, e) => ((acc[e.status] = (acc[e.status] || 0) + 1), acc), {});
  const prompt = [
    `<now>${nowLocal(tz)}</now>`,
    settings.about_me ? `<about_him>\n${settings.about_me}\n</about_him>` : "",
    `<calendar>\n${events.map((e) => `${localTime(tz, e.start)}–${localTime(tz, e.end)} ${e.title} [${accountById(e.accountId)?.label || e.accountId}]${e.location ? ` @ ${e.location}` : ""}`).join("\n") || "(no events)"}\n</calendar>`,
    `<open_tasks>\n${tasks.map((t) => `- ${t.title}${t.due ? ` (due ${t.due})` : ""} [${t.priority}${t.account_id ? `, ${t.account_id}` : ""}]`).join("\n") || "(none)"}\n</open_tasks>`,
    `<inbox_last_36h counts="${JSON.stringify(counts).replace(/"/g, "'")}">\n${emails
      .filter((e) => e.status === "drafted" || ["urgent", "high"].includes(e.priority) || e.category === "action")
      .map((e) => `- [${e.account_id}] ${e.status.toUpperCase()} ${e.priority} — ${e.from_name || e.from_email}: ${e.subject} — ${e.summary}`)
      .join("\n") || "(nothing needs him)"}\n</inbox_last_36h>`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const plan = await createJson({ system: PLAN_SYSTEM, prompt, schema: PLAN_SCHEMA, effort: "high", maxTokens: 16000 });
  const { day } = dayRange(tz);
  await db.upsert("plans", [{ day, data: plan, events, created_at: new Date().toISOString() }], "day");
  return { day, plan, events };
}

export function planToText(plan) {
  const out = [plan.headline, "", "TOP 3"];
  plan.top_three.forEach((t, i) => out.push(`${i + 1}. ${t.title} — ${t.why}`));
  out.push("", "SCHEDULE");
  plan.schedule.forEach((s) => out.push(`${s.time.padEnd(9)} ${s.item}`));
  if (plan.automate_or_delegate.length) {
    out.push("", "HAND OFF");
    plan.automate_or_delegate.forEach((a) => out.push(`• ${a.item} → ${a.how}`));
  }
  if (plan.heads_up.length) {
    out.push("", "HEADS UP");
    plan.heads_up.forEach((h) => out.push(`• ${h}`));
  }
  out.push("", "INBOX", plan.email_digest, "", "— Jarvis");
  return out.join("\n");
}

export async function runPlan() {
  const started = Date.now();
  const settings = await getSettings();
  const { day, plan } = await buildPlan();
  let emailed = false;
  try {
    const provider = await providerById(settings.brief_account);
    if (provider.address) {
      await provider.sendNew({ to: [provider.address], subject: `Your plan for ${day}`, body: planToText(plan) });
      emailed = true;
    }
  } catch (err) {
    console.error("plan email failed", err.message);
  }
  await db.insert("runs", [{ job: "plan", ok: true, detail: { day, emailed }, duration_ms: Date.now() - started }]);
  return { day, emailed };
}
