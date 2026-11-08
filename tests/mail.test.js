import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRawEmail, parseAddress, parseAddressList, replySubject, htmlToText } from "../lib/mail/common.js";
import { normalizeGmail, extractBody } from "../lib/mail/google.js";
import { normalizeGraph } from "../lib/mail/microsoft.js";

const decodeRaw = (raw) => Buffer.from(raw, "base64url").toString("utf8");

test("outgoing mail cannot be header-injected through the subject or recipient", () => {
  const raw = decodeRaw(
    buildRawEmail({ to: ["a@b.com\r\nBcc: victim@x.com"], subject: "Hi\r\nBcc: spy@x.com", body: "hello" }),
  );
  const headerBlock = raw.split("\r\n\r\n")[0];
  assert.ok(!/^Bcc:/m.test(headerBlock), headerBlock);
  assert.equal(headerBlock.split("\r\n").filter((l) => l.startsWith("To:")).length, 1);
});

test("reply threading headers and UTF-8 subject encoding", () => {
  const raw = decodeRaw(
    buildRawEmail({ to: ["a@b.com"], subject: "Re: Café", body: "Merci ✓", inReplyTo: "<x@y>", references: "<w@y>" }),
  );
  assert.match(raw, /In-Reply-To: <x@y>/);
  assert.match(raw, /References: <w@y> <x@y>/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Merci ✓");
});

test("address parsing", () => {
  assert.deepEqual(parseAddress('"Smith, Jane" <Jane@Example.com>'), { name: "Smith, Jane", email: "jane@example.com" });
  assert.deepEqual(parseAddress("bob@x.org"), { name: "", email: "bob@x.org" });
  assert.equal(parseAddressList('"Smith, Jane" <jane@example.com>, bob@x.org').length, 2);
  assert.equal(replySubject("Re: hello"), "Re: hello");
  assert.equal(replySubject("hello"), "Re: hello");
});

test("html to text strips tags and scripts", () => {
  assert.equal(htmlToText("<p>Hi <b>there</b></p><script>alert(1)</script>"), "Hi there");
});

test("Gmail message normalization prefers text/plain", () => {
  const b64 = (s) => Buffer.from(s).toString("base64url");
  const m = {
    id: "1",
    threadId: "t",
    internalDate: "1700000000000",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "snip",
    payload: {
      headers: [
        { name: "From", value: "Ann <ann@x.com>" },
        { name: "To", value: "lev.cooper@gmail.com" },
        { name: "Subject", value: "Hey" },
        { name: "Message-ID", value: "<m@x>" },
        { name: "List-Unsubscribe", value: "<mailto:u@x>" },
      ],
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
        { mimeType: "text/plain", body: { data: b64("plain body") } },
      ],
    },
  };
  const n = normalizeGmail(m, "personal");
  assert.equal(n.bodyText, "plain body");
  assert.equal(n.from.email, "ann@x.com");
  assert.equal(n.isUnread, true);
  assert.equal(n.headers.listUnsubscribe, "<mailto:u@x>");
  assert.equal(extractBody({ mimeType: "text/html", body: { data: b64("<div>only html</div>") } }), "only html");
});

test("Outlook message normalization", () => {
  const n = normalizeGraph(
    {
      id: "g1",
      conversationId: "c1",
      subject: "Rig 4",
      from: { emailAddress: { name: "Ops", address: "Ops@Dynamic.com" } },
      replyTo: [],
      toRecipients: [{ emailAddress: { address: "lev@dynamicwellservice.com" } }],
      ccRecipients: [],
      receivedDateTime: "2026-11-08T10:00:00Z",
      body: { contentType: "text", content: "Pump down at 3." },
      isRead: false,
      internetMessageHeaders: [{ name: "Authentication-Results", value: "dmarc=pass" }],
    },
    "dynamic",
  );
  assert.equal(n.from.email, "ops@dynamic.com");
  assert.equal(n.bodyText, "Pump down at 3.");
  assert.equal(n.headers.authResults, "dmarc=pass");
  assert.deepEqual(n.to, ["lev@dynamicwellservice.com"]);
});
