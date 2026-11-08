// Shared helpers for the Gmail and Outlook providers.

export const LABELS = {
  processed: "Jarvis/Processed",
  replied: "Jarvis/Auto-replied",
  drafted: "Jarvis/Draft ready",
  needsYou: "Jarvis/Needs you",
};

// Category names the triage step can assign, mapped to inbox labels.
export const CATEGORY_LABELS = {
  action: "Jarvis/Action",
  reply: "Jarvis/Reply",
  fyi: "Jarvis/FYI",
  scheduling: "Jarvis/Scheduling",
  finance: "Jarvis/Finance",
  newsletter: "Jarvis/Newsletters",
  promotion: "Jarvis/Promotions",
  receipt: "Jarvis/Receipts",
  notification: "Jarvis/Notifications",
  spam: "Jarvis/Junk",
};

export const ARCHIVABLE = new Set(["newsletter", "promotion", "receipt", "notification", "spam"]);

// Strips CR/LF so user- or sender-controlled text can never inject extra
// headers into an outgoing message.
export function headerSafe(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

export function parseAddress(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const bare = s.match(/[^\s<>,;]+@[^\s<>,;]+/);
  return bare ? { name: "", email: bare[0].toLowerCase() } : null;
}

export function parseAddressList(raw) {
  if (!raw) return [];
  // Split on commas that are not inside quotes.
  const parts = String(raw).match(/(?:"[^"]*"|[^,])+/g) || [];
  return parts.map(parseAddress).filter(Boolean);
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export function truncate(text, max = 12000) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) + "\n…[truncated]" : s;
}

export function replySubject(subject) {
  const s = headerSafe(subject);
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

function encodeHeaderWord(value) {
  const s = headerSafe(value);
  // RFC 2047 encode anything that is not plain ASCII.
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

// Builds an RFC 5322 message for the Gmail API, base64url-encoded.
export function buildRawEmail({ to, cc = [], subject, body, inReplyTo, references }) {
  const lines = [
    `To: ${to.map(headerSafe).join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.map(headerSafe).join(", ")}`] : []),
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${headerSafe(inReplyTo)}`);
  if (references || inReplyTo) lines.push(`References: ${headerSafe([references, inReplyTo].filter(Boolean).join(" "))}`);
  const encodedBody = Buffer.from(String(body), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const raw = lines.join("\r\n") + "\r\n\r\n" + encodedBody;
  return Buffer.from(raw, "utf8").toString("base64url");
}

// Signals that a message is machine-generated and must never get a reply.
export function isAutomated(msg) {
  const h = msg.headers || {};
  const from = msg.from?.email || "";
  if (h.listUnsubscribe || h.listId) return true;
  if (h.autoSubmitted && h.autoSubmitted.toLowerCase() !== "no") return true;
  if (/^(bulk|list|junk|auto_reply)$/i.test(h.precedence || "")) return true;
  if (/(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|alerts?|bounce)([._+-]|@)/i.test(from)) return true;
  return false;
}

// True when the receiving server recorded a failed sender check.
export function failedAuthentication(msg) {
  const a = (msg.headers?.authResults || "").toLowerCase();
  return /\bdmarc=fail\b/.test(a) || /\bspf=fail\b/.test(a) || /\bdkim=fail\b/.test(a);
}

export async function providerFetch(url, token, { method = "GET", body, headers = {}, label = "request" } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${label} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 202 || res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
