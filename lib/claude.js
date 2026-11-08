import Anthropic from "@anthropic-ai/sdk";

// One place that talks to Claude. Uses the server's ANTHROPIC_API_KEY; the
// browser never sees a key.

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

let client = null;
export function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// Test hook: lets unit tests swap in a fake client.
export function setClient(fake) {
  client = fake;
}

export class RefusalError extends Error {}

// Every request opts into server-side fallbacks: if a safety classifier
// declines, the API retries on Anthropic's recommended fallback model
// instead of failing the run.
export async function createMessage(params) {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    ...params,
  });
  if (response.stop_reason === "refusal") {
    throw new RefusalError("Claude declined this request");
  }
  return response;
}

export function textOf(response) {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Structured output: the response is constrained to `schema`.
export async function createJson({ system, prompt, schema, effort = "medium", maxTokens = 8000 }) {
  const response = await createMessage({
    max_tokens: maxTokens,
    system,
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude ran out of output tokens before finishing the JSON");
  }
  return JSON.parse(textOf(response));
}
