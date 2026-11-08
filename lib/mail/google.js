import {
  LABELS,
  buildRawEmail,
  htmlToText,
  parseAddress,
  parseAddressList,
  providerFetch,
  replySubject,
  truncate,
} from "./common.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3";

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

function decode(data) {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

// Walks the MIME tree and returns the best plain-text body.
export function extractBody(payload) {
  let plain = "";
  let html = "";
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data && !plain) plain = decode(part.body.data);
    else if (part.mimeType === "text/html" && part.body?.data && !html) html = decode(part.body.data);
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return plain || htmlToText(html);
}

export function normalizeGmail(m, accountId) {
  const h = m.payload?.headers || [];
  return {
    accountId,
    id: m.id,
    threadId: m.threadId,
    from: parseAddress(header(h, "From")),
    replyTo: parseAddress(header(h, "Reply-To")),
    to: parseAddressList(header(h, "To")).map((a) => a.email),
    cc: parseAddressList(header(h, "Cc")).map((a) => a.email),
    subject: header(h, "Subject"),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    snippet: m.snippet || "",
    bodyText: truncate(extractBody(m.payload)),
    messageIdHeader: header(h, "Message-ID") || header(h, "Message-Id"),
    references: header(h, "References"),
    isUnread: (m.labelIds || []).includes("UNREAD"),
    headers: {
      listUnsubscribe: header(h, "List-Unsubscribe"),
      listId: header(h, "List-Id"),
      autoSubmitted: header(h, "Auto-Submitted"),
      precedence: header(h, "Precedence"),
      authResults: header(h, "Authentication-Results"),
    },
  };
}

export function gmailProvider(account, token) {
  const call = (path, opts = {}) => providerFetch(GMAIL + path, token, { label: "Gmail", ...opts });
  const calCall = (path, opts = {}) => providerFetch(CAL + path, token, { label: "Google Calendar", ...opts });
  let labelCache = null;

  async function labelId(name) {
    if (!labelCache) {
      const res = await call("/labels");
      labelCache = new Map((res.labels || []).map((l) => [l.name, l.id]));
    }
    if (labelCache.has(name)) return labelCache.get(name);
    const created = await call("/labels", {
      method: "POST",
      body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    labelCache.set(name, created.id);
    return created.id;
  }

  async function getMessage(id) {
    const m = await call(`/messages/${encodeURIComponent(id)}?format=full`);
    return normalizeGmail(m, account.id);
  }

  async function search(query, max = 10) {
    const q = new URLSearchParams({ q: query, maxResults: String(Math.min(max, 50)) });
    const res = await call(`/messages?${q}`);
    const ids = (res.messages || []).map((m) => m.id);
    return Promise.all(ids.map(getMessage));
  }

  function replyRaw(msg, body) {
    const to = msg.replyTo?.email || msg.from?.email;
    return buildRawEmail({
      to: [to],
      subject: replySubject(msg.subject),
      body,
      inReplyTo: msg.messageIdHeader,
      references: msg.references,
    });
  }

  return {
    provider: "google",
    accountId: account.id,
    address: account.email,

    // Unprocessed inbox mail from the last few days, newest first.
    async listNew({ max = 15, days = 3 } = {}) {
      const label = LABELS.processed.toLowerCase().replace(/[/ ]/g, "-");
      const q = new URLSearchParams({ q: `in:inbox newer_than:${days}d -label:${label}`, maxResults: String(max) });
      const res = await call(`/messages?${q}`);
      return (res.messages || []).map((m) => m.id);
    },

    getMessage,
    search,

    async hasSentTo(address) {
      const q = new URLSearchParams({ q: `in:sent to:${address}`, maxResults: "1" });
      const res = await call(`/messages?${q}`);
      return (res.messages || []).length > 0;
    },

    async sendReply(msg, body) {
      const sent = await call("/messages/send", { method: "POST", body: { raw: replyRaw(msg, body), threadId: msg.threadId } });
      return sent.id;
    },

    async createReplyDraft(msg, body) {
      const d = await call("/drafts", {
        method: "POST",
        body: { message: { raw: replyRaw(msg, body), threadId: msg.threadId } },
      });
      return d.id;
    },

    async discardDraft(draftId) {
      await call(`/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
    },

    async sendNew({ to, cc = [], subject, body }) {
      const raw = buildRawEmail({ to, cc, subject, body });
      const sent = await call("/messages/send", { method: "POST", body: { raw } });
      return sent.id;
    },

    async createDraft({ to, cc = [], subject, body }) {
      const raw = buildRawEmail({ to, cc, subject, body });
      const d = await call("/drafts", { method: "POST", body: { message: { raw } } });
      return d.id;
    },

    async organize(msg, { labels = [], archive = false, markRead = false }) {
      const addLabelIds = await Promise.all(labels.map(labelId));
      const removeLabelIds = [];
      if (archive) removeLabelIds.push("INBOX");
      if (markRead) removeLabelIds.push("UNREAD");
      await call(`/messages/${encodeURIComponent(msg.id)}/modify`, { method: "POST", body: { addLabelIds, removeLabelIds } });
    },

    async listEvents(startIso, endIso) {
      const q = new URLSearchParams({
        timeMin: startIso,
        timeMax: endIso,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "50",
      });
      const res = await calCall(`/calendars/primary/events?${q}`);
      return (res.items || [])
        .filter((e) => e.status !== "cancelled")
        .map((e) => ({
          accountId: account.id,
          id: e.id,
          title: e.summary || "(no title)",
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          allDay: !e.start?.dateTime,
          location: e.location || "",
          attendees: (e.attendees || []).map((a) => a.email),
        }));
    },

    async createEvent({ title, start, end, attendees = [], location = "", description = "", timezone }) {
      const e = await calCall("/calendars/primary/events?sendUpdates=all", {
        method: "POST",
        body: {
          summary: title,
          location,
          description,
          start: { dateTime: start, timeZone: timezone },
          end: { dateTime: end, timeZone: timezone },
          attendees: attendees.map((email) => ({ email })),
        },
      });
      return { id: e.id, link: e.htmlLink };
    },
  };
}
