// Central configuration. Everything secret comes from environment variables
// set in the Vercel dashboard; nothing personal is committed to the repo.

// The three inboxes Jarvis manages. The provider (google | microsoft) is
// chosen when each inbox is connected, and stored in the database.
export const ACCOUNTS = [
  { id: "personal", label: "Personal", hint: "lev.cooper@gmail.com" },
  { id: "realestate", label: "Real Estate (CCI Capital)", hint: "lev@cci.capital" },
  { id: "dynamic", label: "Dynamic Well Service", hint: "lev@dynamicwellservice.com" },
];

export const ACCOUNT_IDS = ACCOUNTS.map((a) => a.id);

export function accountById(id) {
  return ACCOUNTS.find((a) => a.id === id) || null;
}

// Defaults for the settings row. The user changes these from the app.
export const DEFAULT_SETTINGS = {
  // off: only read + organize. drafts: write replies as drafts.
  // full: send replies that pass every guardrail, draft the rest.
  autopilot: "full",
  confidence_threshold: 0.85,
  daily_send_cap: 40,
  // Only auto-send to people you have emailed before (phishing defence).
  require_prior_correspondence: true,
  // Addresses or @domains that must never get an automatic reply.
  never_auto_send: [],
  // Archive newsletters, promos, receipts and notifications after labeling.
  auto_archive: true,
  timezone: "America/Chicago",
  // Which connected inbox receives the morning plan and urgent alerts.
  brief_account: "personal",
  // Facts about you that the chat assistant may use. Private.
  about_me: "",
  // What automatic email replies may say about you: tone, signature,
  // role per business. Keep anything sensitive OUT of this field, since
  // replies go to outside senders.
  reply_profile: "",
};

export function env(name, { required = true } = {}) {
  const v = process.env[name];
  if (required && (!v || !v.trim())) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

export function appUrl() {
  return (process.env.APP_URL || "").replace(/\/+$/, "");
}

// Hard cap on how long one cron run spends before it stops picking up new work.
export function runBudgetMs() {
  const n = Number(process.env.MAX_RUN_MS || 50000);
  return Number.isFinite(n) && n > 0 ? n : 50000;
}
