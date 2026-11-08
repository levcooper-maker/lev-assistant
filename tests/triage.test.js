import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAction } from "../lib/triage.js";
import { DEFAULT_SETTINGS } from "../lib/config.js";
import { sampleMessage, sampleTriage } from "./helpers.js";

const base = (o = {}) => ({
  msg: sampleMessage(),
  triage: sampleTriage(),
  settings: { ...DEFAULT_SETTINGS },
  ownAddress: "lev@cci.capital",
  sentToday: 0,
  priorCorrespondence: true,
  ...o,
});

test("sends when every guardrail passes", () => {
  assert.equal(decideAction(base()).action, "send");
});

test("files when no reply is needed", () => {
  assert.equal(decideAction(base({ triage: sampleTriage({ needs_reply: false }) })).action, "file");
});

test("never replies to bulk or automated mail", () => {
  const cases = [
    { listUnsubscribe: "<mailto:x@y.com>" },
    { autoSubmitted: "auto-generated" },
    { precedence: "bulk" },
  ];
  for (const h of cases) {
    const msg = sampleMessage({ headers: { ...sampleMessage().headers, ...h } });
    assert.equal(decideAction(base({ msg })).action, "file", JSON.stringify(h));
  }
  const noreply = sampleMessage({ from: { name: "", email: "no-reply@bank.com" } });
  assert.equal(decideAction(base({ msg: noreply })).action, "file");
});

test("risk flags force a draft", () => {
  const d = decideAction(base({ triage: sampleTriage({ risk_flags: ["money"] }) }));
  assert.equal(d.action, "draft");
  assert.match(d.reasons.join(), /money/);
});

test("low confidence forces a draft", () => {
  assert.equal(decideAction(base({ triage: sampleTriage({ reply_confidence: 0.6 }) })).action, "draft");
});

test("first-time sender forces a draft when prior correspondence is required", () => {
  assert.equal(decideAction(base({ priorCorrespondence: false })).action, "draft");
  const settings = { ...DEFAULT_SETTINGS, require_prior_correspondence: false };
  assert.equal(decideAction(base({ priorCorrespondence: false, settings })).action, "send");
});

test("failed DMARC forces a draft", () => {
  const msg = sampleMessage({ headers: { ...sampleMessage().headers, authResults: "spf=pass; dmarc=fail" } });
  assert.equal(decideAction(base({ msg })).action, "draft");
});

test("Reply-To on another domain forces a draft", () => {
  const msg = sampleMessage({ replyTo: { name: "", email: "collect@evil.example" } });
  const d = decideAction(base({ msg }));
  assert.equal(d.action, "draft");
  assert.match(d.reasons.join(), /Reply-To/);
});

test("never-auto-send list matches exact address and @domain", () => {
  let settings = { ...DEFAULT_SETTINGS, never_auto_send: ["@example.com"] };
  assert.equal(decideAction(base({ settings })).action, "draft");
  settings = { ...DEFAULT_SETTINGS, never_auto_send: ["jon@example.com"] };
  assert.equal(decideAction(base({ settings })).action, "draft");
  settings = { ...DEFAULT_SETTINGS, never_auto_send: ["other@example.com"] };
  assert.equal(decideAction(base({ settings })).action, "send");
});

test("daily cap forces a draft", () => {
  assert.equal(decideAction(base({ sentToday: DEFAULT_SETTINGS.daily_send_cap })).action, "draft");
});

test("cc-only forces a draft", () => {
  const msg = sampleMessage({ to: ["someone@else.com"], cc: ["lev@cci.capital"] });
  assert.equal(decideAction(base({ msg })).action, "draft");
});

test("urgent mail is drafted so the owner sees it", () => {
  assert.equal(decideAction(base({ triage: sampleTriage({ priority: "urgent" }) })).action, "draft");
});

test("drafts-only mode never sends; off mode never drafts", () => {
  assert.equal(decideAction(base({ settings: { ...DEFAULT_SETTINGS, autopilot: "drafts" } })).action, "draft");
  assert.equal(decideAction(base({ settings: { ...DEFAULT_SETTINGS, autopilot: "off" } })).action, "file");
  assert.equal(decideAction(base({ killSwitch: true })).action, "file");
});

test("does not reply to your own messages", () => {
  const msg = sampleMessage({ from: { name: "Lev", email: "lev@cci.capital" } });
  assert.equal(decideAction(base({ msg })).action, "file");
});
