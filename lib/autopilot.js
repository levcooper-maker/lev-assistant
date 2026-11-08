import { db, eq, getSettings } from "./db.js";
import { allProviders, providerById } from "./mail/index.js";
import { LABELS, CATEGORY_LABELS, ARCHIVABLE } from "./mail/common.js";
import { triageEmail, decideAction, replyTarget, EMAIL_RE } from "./triage.js";
import { runBudgetMs } from "./config.js";

const MAX_ATTEMPTS = 3;
const PER_ACCOUNT = 15;
const CONCURRENCY = 3;

// Claims an email so no other run touches it. Returns the row or null.
async function claim(accountId, messageId) {
  const row = await db.tryInsert("processed_emails", {
    account_id: accountId,
    message_id: messageId,
    status: "processing",
    attempts: 1,
  });
  if (row) return row;
  const existing = await db.one("processed_emails", { account_id: eq(accountId), message_id: eq(messageId) });
  if (!existing || existing.status !== "error" || existing.attempts >= MAX_ATTEMPTS) return null;
  // Retry a previous failure. The status filter makes this atomic.
  const updated = await db.update(
    "processed_emails",
    { id: eq(existing.id), status: "eq.error" },
    { status: "processing", attempts: existing.attempts + 1, updated_at: new Date().toISOString() },
  );
  return updated?.[0] || null;
}

export async function processOne(provider, messageId, ctx) {
  const row = await claim(provider.accountId, messageId);
  if (!row) return null;
  try {
    const msg = await provider.getMessage(messageId);
    const triage = await triageEmail(msg, ctx.settings);
    const target = replyTarget(msg);
    const prior =
      triage.needs_reply && EMAIL_RE.test(target) && ctx.settings.require_prior_correspondence
        ? await provider.hasSentTo(target)
        : false;
    const decision = decideAction({
      msg,
      triage,
      settings: ctx.settings,
      ownAddress: provider.address,
      sentToday: ctx.sentToday,
      priorCorrespondence: prior,
      killSwitch: ctx.killSwitch,
    });

    const labels = [LABELS.processed, CATEGORY_LABELS[triage.category]].filter(Boolean);
    let status = "filed";
    let outboundId = null;
    let archive = false;
    let markRead = false;

    if (decision.action === "send") {
      outboundId = await provider.sendReply(msg, triage.reply_body);
      ctx.sentToday += 1;
      labels.push(LABELS.replied);
      status = "sent";
      markRead = true;
    } else if (decision.action === "draft") {
      outboundId = await provider.createReplyDraft(msg, triage.reply_body);
      labels.push(LABELS.drafted, LABELS.needsYou);
      status = "drafted";
    } else if (
      ctx.settings.auto_archive &&
      ARCHIVABLE.has(triage.category) &&
      !["urgent", "high"].includes(triage.priority)
    ) {
      archive = true;
      markRead = true;
      status = "archived";
    }
    await provider.organize(msg, { labels, archive, markRead });

    for (const item of triage.action_items) {
      await db.insert("tasks", [
        {
          title: item.title.slice(0, 300),
          due: /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? item.due : null,
          account_id: provider.accountId,
          source: "email",
          source_ref: messageId,
          priority: triage.priority === "urgent" ? "high" : triage.priority === "low" ? "low" : "medium",
        },
      ]);
    }

    const record = {
      status,
      thread_id: msg.threadId,
      from_email: msg.from?.email || null,
      from_name: msg.from?.name || null,
      subject: (msg.subject || "").slice(0, 500),
      received_at: msg.date,
      category: triage.category,
      priority: triage.priority,
      summary: triage.summary,
      reply_body: triage.reply_body || null,
      reply_confidence: triage.reply_confidence,
      risk_flags: triage.risk_flags,
      reasons: decision.reasons,
      outbound_id: outboundId,
      error: null,
      updated_at: new Date().toISOString(),
    };
    await db.update("processed_emails", { id: eq(row.id) }, record);
    if (triage.priority === "urgent" || (status === "drafted" && triage.priority === "high")) {
      ctx.alerts.push({ accountId: provider.accountId, ...record });
    }
    return status;
  } catch (err) {
    await db.update(
      "processed_emails",
      { id: eq(row.id) },
      { status: "error", error: String(err.message).slice(0, 1000), updated_at: new Date().toISOString() },
    );
    return "error";
  }
}

async function sendAlert(settings, alerts) {
  if (!alerts.length) return;
  try {
    const provider = await providerById(settings.brief_account);
    if (!provider.address) return;
    const lines = alerts.map(
      (a) => `• [${a.accountId}] ${a.from_name || a.from_email}: ${a.subject}\n  ${a.summary}\n  Status: ${a.status} (${(a.reasons || []).join("; ")})`,
    );
    await provider.sendNew({
      to: [provider.address],
      subject: `Jarvis: ${alerts.length} email${alerts.length > 1 ? "s" : ""} need you`,
      body: `These came in and need your eyes. Drafts are waiting in each inbox.\n\n${lines.join("\n\n")}\n\n— Jarvis`,
    });
  } catch (err) {
    console.error("alert failed", err.message);
  }
}

export async function runInbox() {
  const started = Date.now();
  const deadline = started + runBudgetMs();
  const settings = await getSettings();
  const since = new Date(Date.now() - 86400000).toISOString();
  const ctx = {
    settings,
    killSwitch: process.env.AUTOPILOT_DISABLED === "1",
    sentToday: await db.count("processed_emails", { status: "eq.sent", updated_at: `gte.${since}` }),
    alerts: [],
  };

  const { providers, errors } = await allProviders();
  const queue = [];
  for (const provider of providers) {
    try {
      const ids = await provider.listNew({ max: PER_ACCOUNT });
      ids.forEach((id) => queue.push({ provider, id }));
    } catch (err) {
      errors.push({ accountId: provider.accountId, error: String(err.message) });
    }
  }

  const results = {};
  async function worker() {
    while (queue.length && Date.now() < deadline) {
      const { provider, id } = queue.shift();
      const status = await processOne(provider, id, ctx);
      if (status) results[status] = (results[status] || 0) + 1;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await sendAlert(settings, ctx.alerts);

  await db.insert("runs", [
    { job: "inbox", ok: errors.length === 0, detail: { results, errors, left: queue.length }, duration_ms: Date.now() - started },
  ]);
  return { results, errors, remaining: queue.length };
}

// Owner approved a draft from the app: send it (optionally edited).
export async function approveDraft(id, editedBody) {
  const row = await db.one("processed_emails", { id: eq(id) });
  if (!row || row.status !== "drafted") throw new Error("Nothing to approve");
  const provider = await providerById(row.account_id);
  const msg = await provider.getMessage(row.message_id);
  const body = (editedBody ?? row.reply_body ?? "").trim();
  if (!body) throw new Error("Reply is empty");
  await provider.sendReply(msg, body);
  if (row.outbound_id) {
    // The inbox copy of the draft is now redundant.
    await provider.discardDraft(row.outbound_id).catch(() => {});
  }
  await provider.organize(msg, { labels: [LABELS.replied], markRead: true });
  await db.update(
    "processed_emails",
    { id: eq(id) },
    { status: "sent", reply_body: body, reasons: ["approved by you"], updated_at: new Date().toISOString() },
  );
}

export async function dismissDraft(id) {
  await db.update(
    "processed_emails",
    { id: eq(id), status: "eq.drafted" },
    { status: "dismissed", updated_at: new Date().toISOString() },
  );
}
