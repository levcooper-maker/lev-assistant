export default async function handler(req, res) {
    if (req.method !== "POST") {
          return res.status(405).json({ error: "Method not allowed" });
    }
    try {
          const { messages, system, apiKey } = req.body;
          const key = apiKey || process.env.ANTHROPIC_API_KEY;
          if (!key) {
                  return res.status(400).json({ error: "No API key provided." });
          }
          const response = await fetch("https://api.anthropic.com/v1/messages", {
                  method: "POST",
                  headers: {
                            "Content-Type": "application/json",
                            "x-api-key": key,
                            "anthropic-version": "2023-06-01",
                  },
                  body: JSON.stringify({
                            model: "claude-sonnet-4-20250514",
                            max_tokens: 1024,
                            system: system || "You are a helpful assistant.",
                            messages: messages || [],
                  }),
          });
          if (!response.ok) {
                  const errorText = await response.text();
                  return res.status(response.status).json({ error: "API error: " + response.status });
          }
          const data = await response.json();
          const content = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
          return res.status(200).json({ content, usage: data.usage });
    } catch (error) {
          return res.status(500).json({ error: "Internal server error" });
    }
}
