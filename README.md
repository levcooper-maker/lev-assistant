# Jarvis (lev-assistant)

A 24/7 personal chief of staff, installable on your phone as a web app.

- **Email autopilot** across three inboxes (personal Gmail, CCI Capital, Dynamic Well Service; Gmail or Outlook each). Every 10 minutes it reads new mail, labels and files it, archives the noise, pulls out tasks, sends routine replies that pass strict guardrails, and drafts everything else for one-tap approval.
- **Morning plan**: calendar across all accounts + open tasks + what the inbox needs → a realistic plan for the day with a "hand off" list, emailed to you and shown on the Today screen.
- **Ask Jarvis**: chat that can search and read your mail, prepare emails (you tap Send), read and create calendar events, and manage tasks and memory.

Setup: [docs/SETUP.md](docs/SETUP.md). Tests: `npm test`.

## Layout

| Path | What it is |
|---|---|
| `index.html`, `app.js` | The phone app (no inline scripts; strict CSP) |
| `api/*.js` | Vercel functions: `auth`, `oauth`, `cron`, `inbox`, `chat`, `tasks`, `today`, `settings` |
| `lib/autopilot.js` | Inbox loop: claim → triage → decide → act → record |
| `lib/triage.js` | The Claude triage call and the send/draft guardrails |
| `lib/planner.js` | Morning plan |
| `lib/agent.js` | Chat agent and its tools |
| `lib/mail/` | Gmail and Microsoft Graph providers |
| `supabase/schema.sql` | Database schema (RLS on, server-only access) |
| `.github/workflows/jarvis-schedule.yml` | The 24/7 scheduler |
