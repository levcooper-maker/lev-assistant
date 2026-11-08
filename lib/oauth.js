import { env, appUrl } from "./config.js";
import { db, eq } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

// OAuth for Google (Gmail + Calendar) and Microsoft (Outlook + Calendar).
// Refresh tokens are stored encrypted; access tokens live only in memory
// for the length of one function run.

export const PROVIDERS = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    clientId: () => env("GOOGLE_CLIENT_ID"),
    clientSecret: () => env("GOOGLE_CLIENT_SECRET"),
    extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  microsoft: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "offline_access",
      "openid",
      "email",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
    ],
    clientId: () => env("MICROSOFT_CLIENT_ID"),
    clientSecret: () => env("MICROSOFT_CLIENT_SECRET"),
    extraAuthParams: { prompt: "select_account" },
  },
};

export function redirectUri() {
  return `${appUrl()}/api/oauth?step=callback`;
}

export function authorizeUrl(provider, state, loginHint) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("Unknown provider");
  const params = new URLSearchParams({
    client_id: p.clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: p.scopes.join(" "),
    state,
    ...p.extraAuthParams,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `${p.authUrl}?${params}`;
}

async function tokenRequest(provider, form) {
  const p = PROVIDERS[provider];
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: p.clientId(), client_secret: p.clientSecret(), ...form }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${provider} token error: ${data.error || res.status} ${data.error_description || ""}`.trim());
  }
  return data;
}

export async function exchangeCode(provider, code) {
  return tokenRequest(provider, { grant_type: "authorization_code", code, redirect_uri: redirectUri() });
}

// Reads the signed-in address out of the id_token. The token came straight
// from the provider's token endpoint over TLS, so it is not re-verified.
export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return payload.email || payload.preferred_username || payload.upn || null;
  } catch {
    return null;
  }
}

export async function saveAccount(accountId, provider, tokens) {
  const existing = await db.one("accounts", { id: eq(accountId) });
  const refresh = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : existing?.provider === provider
      ? existing.refresh_token_enc
      : null;
  if (!refresh) throw new Error("The provider did not return a refresh token. Remove the app's access and connect again.");
  const email = emailFromIdToken(tokens.id_token || "") || existing?.email || null;
  await db.upsert(
    "accounts",
    [
      {
        id: accountId,
        provider,
        email,
        refresh_token_enc: refresh,
        connected_at: new Date().toISOString(),
        last_error: null,
      },
    ],
    "id",
  );
  return { email };
}

const tokenCache = new Map();

export async function getAccessToken(account) {
  const cached = tokenCache.get(account.id);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const refreshToken = decrypt(account.refresh_token_enc);
  let data;
  try {
    data = await tokenRequest(account.provider, { grant_type: "refresh_token", refresh_token: refreshToken });
  } catch (err) {
    await db.update("accounts", { id: eq(account.id) }, { last_error: String(err.message).slice(0, 500) });
    throw err;
  }
  // Microsoft rotates refresh tokens; keep the newest one.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await db.update("accounts", { id: eq(account.id) }, { refresh_token_enc: encrypt(data.refresh_token) });
  }
  tokenCache.set(account.id, { token: data.access_token, exp: Date.now() + (data.expires_in || 3000) * 1000 });
  return data.access_token;
}

export async function listConnectedAccounts() {
  return (await db.select("accounts", { select: "id,provider,email,refresh_token_enc,connected_at,last_error" })) || [];
}
