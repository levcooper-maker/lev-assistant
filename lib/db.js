import { env, DEFAULT_SETTINGS } from "./config.js";

// Minimal Supabase (PostgREST) client. Uses the service-role key, which
// only ever lives on the server. Every table has RLS enabled with no
// policies, so the public anon key can read nothing.

function base() {
  return env("SUPABASE_URL").replace(/\/+$/, "") + "/rest/v1";
}

function headers(extra = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function request(method, path, { body, prefer } = {}) {
  const res = await fetch(base() + path, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Database ${method} ${path.split("?")[0]} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// filters: { column: "eq.value" } in PostgREST syntax.
function qs(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const db = {
  select(table, params = {}) {
    return request("GET", `/${table}${qs(params)}`);
  },
  async one(table, params = {}) {
    const rows = await request("GET", `/${table}${qs({ ...params, limit: 1 })}`);
    return rows?.[0] || null;
  },
  insert(table, rows) {
    return request("POST", `/${table}`, { body: rows, prefer: "return=representation" });
  },
  // Insert that returns null instead of throwing on a unique-key conflict.
  // Used as a lock so two overlapping runs never handle the same email.
  async tryInsert(table, row) {
    const res = await fetch(base() + `/${table}`, {
      method: "POST",
      headers: headers({ Prefer: "return=representation" }),
      body: JSON.stringify([row]),
    });
    if (res.status === 409) return null;
    if (!res.ok) throw new Error(`Database insert ${table} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json())[0];
  },
  async count(table, params = {}) {
    const res = await fetch(base() + `/${table}${qs({ ...params, select: "id" })}`, {
      method: "HEAD",
      headers: headers({ Prefer: "count=exact" }),
    });
    if (!res.ok) throw new Error(`Database count ${table} failed: ${res.status}`);
    const range = res.headers.get("content-range") || "*/0";
    return Number(range.split("/")[1]) || 0;
  },
  upsert(table, rows, onConflict) {
    return request("POST", `/${table}${qs({ on_conflict: onConflict })}`, {
      body: rows,
      prefer: "resolution=merge-duplicates,return=representation",
    });
  },
  update(table, params, patch) {
    return request("PATCH", `/${table}${qs(params)}`, { body: patch, prefer: "return=representation" });
  },
  remove(table, params) {
    return request("DELETE", `/${table}${qs(params)}`);
  },
};

// PostgREST filter values must not smuggle in extra operators.
export function eq(value) {
  return `eq.${String(value).replace(/[,()]/g, "")}`;
}

export async function getSettings() {
  const row = await db.one("settings", { id: "eq.1" });
  return { ...DEFAULT_SETTINGS, ...(row?.data || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await db.upsert("settings", [{ id: 1, data: next, updated_at: new Date().toISOString() }], "id");
  return next;
}
