# Jarvis setup (about 45 minutes, one time)

Jarvis runs on Vercel, stores its state in Supabase, reads and answers mail
through Google and Microsoft, and is woken every 10 minutes by GitHub Actions.
You need five things: a Supabase project, a Google Cloud OAuth app, a Microsoft
Entra app, an Anthropic API key, and the Vercel environment variables below.

Nothing runs until you connect at least one inbox, so you can do this in any
order.

## 1. Supabase (database)

1. Create a project at supabase.com (free tier is fine).
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, and run it.
3. From **Project Settings → API**, copy the **Project URL** and the
   **service_role** key. The service_role key is a full-access secret: it goes
   only into Vercel, never into the app or the repo.

## 2. Google (for every Gmail / Google Workspace inbox)

1. console.cloud.google.com → create a project ("Jarvis").
2. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
3. **OAuth consent screen**:
   - If *all* your Google inboxes are on your own Workspace domain, choose
     **Internal**. Done.
   - If any is a plain `@gmail.com` (yours is), choose **External**, add your
     addresses as test users, then click **Publish app** (In production).
     Do not leave it in *Testing*: Google expires Testing refresh tokens after
     7 days and Jarvis would silently stop. You'll see an "unverified app"
     warning when you connect; that's expected for a personal app. Click
     *Advanced → Go to Jarvis*.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized redirect URI: `https://YOUR-APP.vercel.app/api/oauth?step=callback`
5. Copy the client ID and secret.

## 3. Microsoft (for every Outlook / Microsoft 365 inbox)

1. entra.microsoft.com → **App registrations → New registration**.
   - Supported account types: **Accounts in any organizational directory and
     personal Microsoft accounts**.
   - Redirect URI (Web): `https://YOUR-APP.vercel.app/api/oauth?step=callback`
2. **Certificates & secrets → New client secret**. Copy the *Value* now.
3. **API permissions → Microsoft Graph → Delegated**: `offline_access`,
   `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`.
   If the business inbox is on a company tenant that blocks user consent,
   click **Grant admin consent** (you're the admin).
4. Copy the **Application (client) ID**.

## 4. Vercel environment variables

Project → Settings → Environment Variables (Production):

| Name | Value |
|---|---|
| `APP_URL` | `https://YOUR-APP.vercel.app` (no trailing slash) |
| `APP_PASSWORD` | the password you'll sign in with, 12+ characters |
| `SESSION_SECRET` | output of `openssl rand -base64 48` |
| `TOKEN_ENCRYPTION_KEY` | output of `openssl rand -base64 32` |
| `CRON_SECRET` | output of `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `SUPABASE_URL` | step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | step 1 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | step 2 |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | step 3 |

Optional:

| Name | Effect |
|---|---|
| `AUTOPILOT_DISABLED=1` | Emergency stop: nothing is sent or drafted, mail is still labeled. |
| `CLAUDE_MODEL` | Override the model (default `claude-opus-5-5`). |
| `MAX_RUN_MS` | Time budget per background run (default 50000). |

Delete the old `ANTHROPIC_API_KEY`-in-the-browser setting: the app no longer
accepts a key from the client. Redeploy after saving variables.

## 5. Schedule (makes it 24/7)

GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

- `JARVIS_URL` = `https://YOUR-APP.vercel.app`
- `CRON_SECRET` = same value as in Vercel

The workflow `.github/workflows/jarvis-schedule.yml` then runs the inbox
autopilot every 10 minutes and builds the morning plan at 5:40 AM CST /
6:40 AM CDT. Trigger it by hand from the Actions tab to test. GitHub pauses
scheduled workflows in repos with no commits for 60 days; re-enable it from the
Actions tab if that happens.

## 6. First run

1. Open the app, sign in with `APP_PASSWORD`.
2. Gear icon → connect each inbox with **Google** or **Outlook**.
3. Fill in **Reply profile** before turning anything loose. Example:
   > I'm Lev. Personal mail: casual, sign "Lev". CCI Capital (real estate
   > investing): professional, sign "Lev Cooper, CCI Capital". Dynamic Well
   > Service: direct and practical, sign "Lev Cooper, Dynamic Well Service".
   > I'm usually available for calls weekday mornings Central time.
4. Add investor and attorney domains to **Never auto-reply to**.
5. Tap **Check now** on the Inbox tab and read what it did.

## How the autopilot decides

Every new email gets one Claude call that returns a category, priority,
summary, action items and a proposed reply. That call has no tools, so an
email cannot make Jarvis do anything except write a reply to its own sender.

Then plain code decides. In **Full auto** a reply is sent only if all of these
hold, otherwise it becomes a draft labeled *Jarvis/Needs you*:

- no risk flags (money, legal, contract, pricing, commitments, investor
  relations, HR, safety, confidential info, suspicious, needs your knowledge)
- Claude's confidence ≥ your threshold (default 0.85)
- the sender passed SPF/DKIM/DMARC and Reply-To isn't on a different domain
- you've emailed that address before (toggle)
- the sender isn't on your never-auto-reply list
- you were in To, not just Cc
- not urgent (urgent mail always comes to you)
- under the daily cap (default 40 per 24h)

Newsletters, promotions, receipts and notifications get labeled and archived.
Action items become tasks. Urgent mail and high-priority drafts trigger an
alert email to your brief inbox.

## Costs to expect

Each email is one Claude Opus call (roughly 3–5 cents, mostly output and thinking). At 150 emails a day
across three inboxes that's about $5–8/day, plus a few cents per chat and plan. The model is configurable with
`CLAUDE_MODEL` if you want to trade quality for cost.
