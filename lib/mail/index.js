import { getAccessToken, listConnectedAccounts } from "../oauth.js";
import { gmailProvider } from "./google.js";
import { graphProvider } from "./microsoft.js";

export async function providerFor(account) {
  const token = await getAccessToken(account);
  if (account.provider === "google") return gmailProvider(account, token);
  if (account.provider === "microsoft") return graphProvider(account, token);
  throw new Error(`Unknown provider ${account.provider}`);
}

// Returns a provider for every connected inbox. A broken connection is
// reported, not thrown, so one bad inbox does not stop the other two.
export async function allProviders() {
  const accounts = await listConnectedAccounts();
  const out = [];
  const errors = [];
  for (const account of accounts) {
    try {
      out.push(await providerFor(account));
    } catch (err) {
      errors.push({ accountId: account.id, error: String(err.message) });
    }
  }
  return { providers: out, errors };
}

export async function providerById(accountId) {
  const accounts = await listConnectedAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Inbox "${accountId}" is not connected`);
  return providerFor(account);
}
