import crypto from "node:crypto";

// Test environment: fake secrets and an in-memory stand-in for Supabase.
export function setTestEnv() {
  process.env.SESSION_SECRET = "test-session-secret-0123456789";
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  process.env.CRON_SECRET = "cron-secret-abc";
  process.env.SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.APP_PASSWORD = "correct horse battery";
}

// Minimal PostgREST emulation: enough for inserts, selects with eq
// filters, conditional updates and counts.
export function fakeSupabase() {
  const tables = {};
  const calls = [];
  const table = (name) => (tables[name] ||= []);

  function matches(row, params) {
    for (const [k, v] of params) {
      if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
      const [op, ...rest] = v.split(".");
      const val = rest.join(".");
      if (op === "eq" && String(row[k]) !== val) return false;
      if (op === "neq" && String(row[k]) === val) return false;
      if (op === "in" && !val.replace(/[()]/g, "").split(",").includes(String(row[k]))) return false;
    }
    return true;
  }

  async function fetchImpl(url, opts = {}) {
    const u = new URL(url);
    if (u.host !== "db.test") throw new Error(`Unexpected fetch ${url}`);
    const name = u.pathname.replace("/rest/v1/", "");
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, table: name, body, params: Object.fromEntries(u.searchParams) });
    const rows = table(name);
    const json = (status, data, headers = {}) =>
      new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

    if (method === "POST") {
      const inserted = [];
      for (const r of body) {
        if (name === "processed_emails" && rows.some((x) => x.account_id === r.account_id && x.message_id === r.message_id)) {
          return json(409, { message: "duplicate" });
        }
        const conflictKey = u.searchParams.get("on_conflict");
        const existing = conflictKey ? rows.find((x) => String(x[conflictKey]) === String(r[conflictKey])) : null;
        if (existing) {
          Object.assign(existing, r);
          inserted.push(existing);
        } else {
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          inserted.push(row);
        }
      }
      return json(201, inserted);
    }
    const hit = rows.filter((r) => matches(r, u.searchParams));
    if (method === "GET") return json(200, hit.slice(0, Number(u.searchParams.get("limit") || 1000)));
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `0-0/${hit.length}` } });
    if (method === "PATCH") {
      hit.forEach((r) => Object.assign(r, body));
      return json(200, hit);
    }
    if (method === "DELETE") {
      tables[name] = rows.filter((r) => !hit.includes(r));
      return json(204, null);
    }
    throw new Error(`Unhandled ${method}`);
  }

  return { tables, calls, fetchImpl, table };
}

export function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(b) {
      this.body = b ? JSON.parse(b) : null;
      this.headersSent = true;
    },
  };
  return res;
}

// A message object in the shape the providers return.
export function sampleMessage(overrides = {}) {
  return {
    accountId: "realestate",
    id: "m1",
    threadId: "t1",
    from: { name: "Jon Sidoti", email: "jon@example.com" },
    replyTo: null,
    to: ["lev@cci.capital"],
    cc: [],
    subject: "Quick question",
    date: "2026-11-08T15:00:00.000Z",
    snippet: "Are we still on for Tuesday?",
    bodyText: "Are we still on for Tuesday?",
    messageIdHeader: "<abc@example.com>",
    references: "",
    isUnread: true,
    headers: { listUnsubscribe: "", listId: "", autoSubmitted: "", precedence: "", authResults: "spf=pass dkim=pass dmarc=pass" },
    ...overrides,
  };
}

export function sampleTriage(overrides = {}) {
  return {
    category: "reply",
    priority: "normal",
    summary: "Jon confirms Tuesday.",
    needs_reply: true,
    reply_body: "Yes, still on for Tuesday.\n\nLev",
    reply_confidence: 0.95,
    risk_flags: [],
    action_items: [],
    ...overrides,
  };
}
