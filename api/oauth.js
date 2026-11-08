import { handler, send, isLoggedIn, methodNotAllowed } from "../lib/http.js";
import { sign, verify, randomId } from "../lib/crypto.js";
import { accountById, appUrl } from "../lib/config.js";
import { PROVIDERS, authorizeUrl, exchangeCode, saveAccount } from "../lib/oauth.js";

// GET /api/oauth?step=start&account=personal&provider=google
// GET /api/oauth?step=callback&code=...&state=...   (provider redirects here)

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

export default handler(async (req, res) => {
  if (req.method !== "GET") return methodNotAllowed(res);
  const url = new URL(req.url, "http://x");
  const q = Object.fromEntries(url.searchParams);
  if (!isLoggedIn(req)) return send(res, 401, { error: "Not signed in" });

  if (q.step === "start") {
    const account = accountById(q.account);
    if (!account || !PROVIDERS[q.provider]) return send(res, 400, { error: "Bad account or provider" });
    const state = sign({ account: account.id, provider: q.provider, n: randomId(), exp: Date.now() + 10 * 60000 });
    return redirect(res, authorizeUrl(q.provider, state, account.hint));
  }

  if (q.step === "callback") {
    const back = (msg) => redirect(res, `${appUrl()}/?connected=${encodeURIComponent(msg)}`);
    const state = verify(q.state);
    if (!state || !accountById(state.account) || !PROVIDERS[state.provider]) return back("error:expired");
    if (q.error || !q.code) return back(`error:${q.error || "no_code"}`);
    try {
      const tokens = await exchangeCode(state.provider, q.code);
      const { email } = await saveAccount(state.account, state.provider, tokens);
      return back(`${state.account}:${email || "ok"}`);
    } catch (err) {
      console.error("oauth callback", err.message);
      return back("error:token_exchange");
    }
  }

  return send(res, 400, { error: "Unknown step" });
});
