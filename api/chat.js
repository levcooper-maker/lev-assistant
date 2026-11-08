import { handler, send, body, requireUser, methodNotAllowed } from "../lib/http.js";
import { runAgent, sendPrepared } from "../lib/agent.js";
import { db, eq } from "../lib/db.js";

const MAX_TURNS = 30;
const MAX_CHARS = 20000;

// Accepts only plain text turns, starting with the user and ending with
// the user's newest message.
export function cleanHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const turns = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return null;
  return turns;
}

export default handler(async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!requireUser(req, res)) return;
  const b = body(req);

  if (b.action === "send") {
    await sendPrepared(String(b.id));
    return send(res, 200, { ok: true });
  }
  if (b.action === "discard") {
    await db.update("outbox", { id: eq(b.id), status: "eq.pending" }, { status: "discarded" });
    return send(res, 200, { ok: true });
  }

  const history = cleanHistory(b.messages);
  if (!history) return send(res, 400, { error: "Send messages ending with a user turn" });
  const result = await runAgent(history);
  return send(res, 200, result);
});
