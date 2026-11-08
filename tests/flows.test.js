import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTestEnv, fakeSupabase, sampleMessage, sampleTriage } from "./helpers.js";
import { DEFAULT_SETTINGS } from "../lib/config.js";

before(setTestEnv);

let sb;
beforeEach(() => {
  sb = fakeSupabase();
  globalThis.fetch = sb.fetchImpl;
});

// A fake Claude client that replays scripted responses.
function scriptedClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        async create(params) {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("No scripted response left");
          return typeof next === "function" ? next(params) : next;
        },
      },
    },
  };
}

function fakeProvider(msg, { sentBefore = true } = {}) {
  const log = [];
  return {
    log,
    accountId: msg.accountId,
    address: "lev@cci.capital",
    getMessage: async () => msg,
    hasSentTo: async () => sentBefore,
    sendReply: async (m, body) => (log.push(["send", body]), "sent-1"),
    createReplyDraft: async (m, body) => (log.push(["draft", body]), "draft-1"),
    organize: async (m, opts) => log.push(["organize", opts]),
  };
}

const triageResponse = (t) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(t) }],
});

test("autopilot sends a safe reply, labels it, and records it", async () => {
  const { setClient } = await import("../lib/claude.js");
  const { processOne } = await import("../lib/autopilot.js");
  const client = scriptedClient([triageResponse(sampleTriage({ action_items: [{ title: "Book Tuesday room", due: "2026-11-10" }] }))]);
  setClient(client);
  const provider = fakeProvider(sampleMessage());
  const ctx = { settings: { ...DEFAULT_SETTINGS }, killSwitch: false, sentToday: 0, alerts: [] };

  assert.equal(await processOne(provider, "m1", ctx), "sent");
  assert.deepEqual(provider.log[0], ["send", sampleTriage().reply_body]);
  assert.ok(provider.log[1][1].labels.includes("Jarvis/Auto-replied"));
  assert.equal(ctx.sentToday, 1);
  const row = sb.table("processed_emails")[0];
  assert.equal(row.status, "sent");
  assert.equal(sb.table("tasks")[0].title, "Book Tuesday room");

  // The request used structured output, fallbacks, and carried no tools.
  const req = client.requests[0];
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(req.fallbacks, "default");
  assert.equal(req.tools, undefined);

  // Running again on the same email is a no-op (dedupe lock).
  assert.equal(await processOne(provider, "m1", ctx), null);
});

test("autopilot drafts risky mail and raises an alert", async () => {
  const { setClient } = await import("../lib/claude.js");
  const { processOne } = await import("../lib/autopilot.js");
  setClient(scriptedClient([triageResponse(sampleTriage({ priority: "high", risk_flags: ["money"] }))]));
  const provider = fakeProvider(sampleMessage({ id: "m2" }));
  const ctx = { settings: { ...DEFAULT_SETTINGS }, killSwitch: false, sentToday: 0, alerts: [] };

  assert.equal(await processOne(provider, "m2", ctx), "drafted");
  assert.equal(provider.log[0][0], "draft");
  assert.equal(ctx.alerts.length, 1);
});

test("autopilot archives newsletters and records failures for retry", async () => {
  const { setClient } = await import("../lib/claude.js");
  const { processOne } = await import("../lib/autopilot.js");
  setClient(
    scriptedClient([
      triageResponse(sampleTriage({ category: "newsletter", priority: "low", needs_reply: false, reply_body: "" })),
      () => {
        throw new Error("API down");
      },
    ]),
  );
  const ctx = { settings: { ...DEFAULT_SETTINGS }, killSwitch: false, sentToday: 0, alerts: [] };
  const p1 = fakeProvider(sampleMessage({ id: "n1" }));
  assert.equal(await processOne(p1, "n1", ctx), "archived");
  assert.equal(p1.log[0][1].archive, true);

  const p2 = fakeProvider(sampleMessage({ id: "n2" }));
  assert.equal(await processOne(p2, "n2", ctx), "error");
  const row = sb.table("processed_emails").find((r) => r.message_id === "n2");
  assert.equal(row.status, "error");
  assert.match(row.error, /API down/);
});

test("chat agent runs tools and queues email instead of sending", async () => {
  const { setClient } = await import("../lib/claude.js");
  const { runAgent } = await import("../lib/agent.js");
  const client = scriptedClient([
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu1", name: "add_task", input: { title: "Call Trevor", due: "2026-11-09", priority: "high" } },
        {
          type: "tool_use",
          id: "tu2",
          name: "prepare_email",
          input: { account: "realestate", to: ["trevor@st4.example", "not-an-email"], subject: "Call", body: "Free at 2?" },
        },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Added the task. Email to Trevor is ready to send." }] },
  ]);
  setClient(client);

  const out = await runAgent([{ role: "user", content: "Remind me to call Trevor tomorrow and email him" }]);
  assert.match(out.reply, /ready to send/);
  assert.equal(out.pending.length, 1);
  assert.deepEqual(out.pending[0].to_addrs, ["trevor@st4.example"]);
  assert.equal(out.pending[0].status, "pending");
  assert.equal(sb.table("tasks")[0].title, "Call Trevor");

  // Both tool results went back in ONE user message.
  const second = client.requests[1].messages;
  const last = second[second.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content.length, 2);
  assert.ok(last.content.every((b) => b.type === "tool_result"));
});

test("chat agent reports tool errors to the model instead of crashing", async () => {
  const { setClient } = await import("../lib/claude.js");
  const { runAgent } = await import("../lib/agent.js");
  const client = scriptedClient([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "x", name: "read_email", input: { account: "dynamic", message_id: "1" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "That inbox isn't connected yet." }] },
  ]);
  setClient(client);
  const out = await runAgent([{ role: "user", content: "read it" }]);
  assert.match(out.reply, /isn't connected/);
  const result = client.requests[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /not connected/);
});
