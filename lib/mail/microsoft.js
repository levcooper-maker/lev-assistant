import { LABELS, htmlToText, providerFetch, truncate } from "./common.js";

const GRAPH = "https://graph.microsoft.com/v1.0/me";

const SELECT =
  "id,conversationId,subject,from,replyTo,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,categories,internetMessageId";

function addr(r) {
  const e = r?.emailAddress;
  return e?.address ? { name: e.name || "", email: e.address.toLowerCase() } : null;
}

function hdr(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

export function normalizeGraph(m, accountId) {
  const headers = m.internetMessageHeaders || [];
  const body = m.body?.contentType === "html" ? htmlToText(m.body.content) : m.body?.content || "";
  return {
    accountId,
    id: m.id,
    threadId: m.conversationId,
    from: addr(m.from),
    replyTo: addr((m.replyTo || [])[0]),
    to: (m.toRecipients || []).map(addr).filter(Boolean).map((a) => a.email),
    cc: (m.ccRecipients || []).map(addr).filter(Boolean).map((a) => a.email),
    subject: m.subject || "",
    date: m.receivedDateTime || null,
    snippet: m.bodyPreview || "",
    bodyText: truncate(body),
    messageIdHeader: m.internetMessageId || "",
    references: hdr(headers, "References"),
    isUnread: m.isRead === false,
    categories: m.categories || [],
    headers: {
      listUnsubscribe: hdr(headers, "List-Unsubscribe"),
      listId: hdr(headers, "List-Id"),
      autoSubmitted: hdr(headers, "Auto-Submitted"),
      precedence: hdr(headers, "Precedence"),
      authResults: hdr(headers, "Authentication-Results"),
    },
  };
}

export function graphProvider(account, token) {
  const call = (path, opts = {}) => providerFetch(GRAPH + path, token, { label: "Outlook", ...opts });

  async function getMessage(id) {
    const m = await call(
      `/messages/${encodeURIComponent(id)}?$select=${SELECT},body,internetMessageHeaders`,
      { headers: { Prefer: 'outlook.body-content-type="text"' } },
    );
    return normalizeGraph(m, account.id);
  }

  function recipients(list) {
    return list.map((address) => ({ emailAddress: { address } }));
  }

  return {
    provider: "microsoft",
    accountId: account.id,
    address: account.email,

    async listNew({ max = 15, days = 3 } = {}) {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const q = new URLSearchParams({
        $filter: `receivedDateTime ge ${since}`,
        $orderby: "receivedDateTime desc",
        $top: "50",
        $select: "id,categories",
      });
      const res = await call(`/mailFolders/inbox/messages?${q}`);
      return (res.value || [])
        .filter((m) => !(m.categories || []).includes(LABELS.processed))
        .slice(0, max)
        .map((m) => m.id);
    },

    getMessage,

    async search(query, max = 10) {
      const q = new URLSearchParams({ $search: `"${String(query).replace(/"/g, "")}"`, $top: String(Math.min(max, 50)), $select: "id" });
      const res = await call(`/messages?${q}`);
      return Promise.all((res.value || []).map((m) => getMessage(m.id)));
    },

    async hasSentTo(address) {
      const q = new URLSearchParams({ $search: `"to:${String(address).replace(/"/g, "")}"`, $top: "1", $select: "id" });
      const res = await call(`/mailFolders/sentitems/messages?${q}`);
      return (res.value || []).length > 0;
    },

    async sendReply(msg, body) {
      await call(`/messages/${encodeURIComponent(msg.id)}/reply`, { method: "POST", body: { comment: body } });
      return null; // Graph does not return the sent message id.
    },

    async createReplyDraft(msg, body) {
      const d = await call(`/messages/${encodeURIComponent(msg.id)}/createReply`, { method: "POST", body: { comment: body } });
      return d?.id || null;
    },

    async discardDraft(draftId) {
      await call(`/messages/${encodeURIComponent(draftId)}`, { method: "DELETE" });
    },

    async sendNew({ to, cc = [], subject, body }) {
      await call("/sendMail", {
        method: "POST",
        body: {
          message: { subject, body: { contentType: "Text", content: body }, toRecipients: recipients(to), ccRecipients: recipients(cc) },
          saveToSentItems: true,
        },
      });
      return null;
    },

    async createDraft({ to, cc = [], subject, body }) {
      const d = await call("/messages", {
        method: "POST",
        body: { subject, body: { contentType: "Text", content: body }, toRecipients: recipients(to), ccRecipients: recipients(cc) },
      });
      return d?.id || null;
    },

    async organize(msg, { labels = [], archive = false, markRead = false }) {
      const categories = Array.from(new Set([...(msg.categories || []), ...labels]));
      await call(`/messages/${encodeURIComponent(msg.id)}`, {
        method: "PATCH",
        body: { categories, ...(markRead ? { isRead: true } : {}) },
      });
      if (archive) {
        await call(`/messages/${encodeURIComponent(msg.id)}/move`, { method: "POST", body: { destinationId: "archive" } });
      }
    },

    async listEvents(startIso, endIso) {
      // Ask for UTC so every time can be turned into a real instant.
      const q = new URLSearchParams({ startDateTime: startIso, endDateTime: endIso, $top: "50", $orderby: "start/dateTime" });
      const res = await call(`/calendarView?${q}`, { headers: { Prefer: 'outlook.timezone="UTC"' } });
      const utc = (dt) => (dt && !/[zZ]|[+-]\d{2}:\d{2}$/.test(dt) ? `${dt.replace(/\.\d+$/, "")}Z` : dt);
      return (res.value || [])
        .filter((e) => !e.isCancelled)
        .map((e) => ({
          accountId: account.id,
          id: e.id,
          title: e.subject || "(no title)",
          start: e.isAllDay ? String(e.start?.dateTime).slice(0, 10) : utc(e.start?.dateTime),
          end: e.isAllDay ? String(e.end?.dateTime).slice(0, 10) : utc(e.end?.dateTime),
          allDay: !!e.isAllDay,
          location: e.location?.displayName || "",
          attendees: (e.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean),
        }));
    },

    async createEvent({ title, start, end, attendees = [], location = "", description = "", timezone }) {
      const e = await call("/events", {
        method: "POST",
        body: {
          subject: title,
          body: { contentType: "Text", content: description },
          start: { dateTime: start, timeZone: timezone },
          end: { dateTime: end, timeZone: timezone },
          location: { displayName: location },
          attendees: attendees.map((address) => ({ emailAddress: { address }, type: "required" })),
        },
      });
      return { id: e.id, link: e.webLink };
    },
  };
}
