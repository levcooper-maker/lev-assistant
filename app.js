// Jarvis front end. No inline handlers (the CSP forbids them): every
// button carries data-action and one delegated listener routes clicks.
// Anything that came from an email is untrusted and goes through esc().

const $ = (id) => document.getElementById(id);
const ACCOUNT_NAMES = { personal: "Personal", realestate: "Real estate", dynamic: "Dynamic" };
const CHAT_KEY = "jarvis_chat_v2";

const state = {
  tab: "today",
  inboxStatus: "drafted",
  inboxAccount: "",
  inboxItems: [],
  chat: [],
  chatBusy: false,
  settings: null,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

// ── helpers ────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let bannerTimer;
function notify(text, isError = false) {
  const b = $("banner");
  b.textContent = text;
  b.classList.toggle("err", isError);
  b.classList.add("show");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove("show"), isError ? 5000 : 2500);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== "/api/auth") {
    showLogin();
    throw new Error("Please sign in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function timeOf(iso) {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "All day";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: state.tz });
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function priorityColor(p) {
  return p === "high" || p === "urgent" ? "var(--red)" : p === "low" ? "var(--text3)" : "var(--gold)";
}

// ── auth ───────────────────────────────────────────────────────────────
function showLogin() {
  $("login").classList.add("show");
  setTimeout(() => $("loginPassword").focus(), 50);
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  try {
    await api("/api/auth", { method: "POST", body: { action: "login", password: $("loginPassword").value } });
    $("loginPassword").value = "";
    $("login").classList.remove("show");
    boot();
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});

// ── navigation ─────────────────────────────────────────────────────────
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === `screen-${tab}`));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "today") loadToday();
  if (tab === "inbox") loadInbox();
  if (tab === "tasks") loadTasks();
  if (tab === "chat") setTimeout(() => $("chatInput").focus(), 50);
}

// ── today ──────────────────────────────────────────────────────────────
function greet() {
  const h = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: state.tz }));
  $("greeting").textContent = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  $("dateLine").textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: state.tz,
  });
}

function renderPlan(plan) {
  if (!plan) {
    return `<div class="empty">No plan yet today. It builds automatically each morning, or tap Rebuild.</div>`;
  }
  let html = `<div class="headline">${esc(plan.headline)}</div>`;
  if (plan.top_three?.length) {
    html += `<div class="section-label">Top 3</div>`;
    html += plan.top_three
      .map((t, i) => `<div class="row"><div class="time" style="width:18px">${i + 1}</div><div class="main"><b>${esc(t.title)}</b><div class="muted">${esc(t.why)}</div></div></div>`)
      .join("");
  }
  if (plan.schedule?.length) {
    const colors = { meeting: "var(--accent)", focus: "var(--purple)", task: "var(--gold)", personal: "var(--green)", break: "var(--text3)" };
    html += `<div class="section-label">Schedule</div>`;
    html += plan.schedule
      .map((s) => `<div class="row"><div class="time">${esc(s.time)}</div><div class="dot" style="background:${colors[s.kind] || "var(--text3)"}"></div><div class="main">${esc(s.item)}</div></div>`)
      .join("");
  }
  if (plan.automate_or_delegate?.length) {
    html += `<div class="section-label">Hand off</div>`;
    html += plan.automate_or_delegate
      .map((a) => `<div class="row"><div class="main"><b>${esc(a.item)}</b><div class="muted">${esc(a.how)}</div></div></div>`)
      .join("");
  }
  if (plan.heads_up?.length) {
    html += `<div class="section-label">Heads up</div>`;
    html += plan.heads_up.map((h) => `<div class="row"><div class="main">${esc(h)}</div></div>`).join("");
  }
  if (plan.email_digest) html += `<div class="section-label">Inbox</div><div class="muted">${esc(plan.email_digest)}</div>`;
  return html;
}

function renderTaskRows(tasks, compact = false) {
  if (!tasks.length) return `<div class="empty">${compact ? "Nothing open." : "No open tasks."}</div>`;
  return tasks
    .map(
      (t) => `<div class="row">
        <button class="check ${t.status === "done" ? "done" : ""}" data-action="toggle-task" data-id="${esc(t.id)}" data-status="${esc(t.status)}" aria-label="Toggle">${t.status === "done" ? "✓" : ""}</button>
        <div class="main" style="${t.status === "done" ? "opacity:.5;text-decoration:line-through" : ""}">${esc(t.title)}
          <div class="small">${t.due ? `Due ${esc(t.due)}` : "No date"}${t.account_id ? ` · ${esc(ACCOUNT_NAMES[t.account_id] || t.account_id)}` : ""}${t.source === "email" ? " · from email" : ""}</div>
        </div>
        <div class="dot" style="background:${priorityColor(t.priority)}"></div>
      </div>`,
    )
    .join("");
}

async function loadToday() {
  greet();
  try {
    const d = await api("/api/today");
    state.tz = d.timezone || state.tz;
    greet();
    $("statSent").textContent = d.stats.sent24h;
    $("statWaiting").textContent = d.stats.waiting;
    $("statHandled").textContent = d.stats.handled24h;
    $("statEvents").textContent = d.events.length;
    setBadge(d.stats.waiting);
    $("planBody").innerHTML = renderPlan(d.plan);
    $("eventsBody").innerHTML = d.events.length
      ? d.events
          .map((e) => `<div class="row"><div class="time">${esc(timeOf(e.start))}</div><div class="main"><b>${esc(e.title)}</b><div class="small">${esc(ACCOUNT_NAMES[e.accountId] || "")}${e.location ? ` · ${esc(e.location)}` : ""}</div></div></div>`)
          .join("")
      : `<div class="empty">Nothing on the calendar today.</div>`;
    $("todayTasks").innerHTML = renderTaskRows(d.tasks, true);
    $("todayWarnings").innerHTML = d.connectionErrors?.length
      ? `<div class="warn">${d.connectionErrors.map((c) => `${esc(ACCOUNT_NAMES[c.accountId] || c.accountId)} inbox needs reconnecting.`).join("<br>")} Open Settings.</div>`
      : "";
  } catch (err) {
    $("planBody").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function setBadge(n) {
  const b = $("inboxBadge");
  b.textContent = n;
  b.classList.toggle("show", n > 0);
}

// ── inbox ──────────────────────────────────────────────────────────────
function mailCard(m) {
  const who = m.from_name || m.from_email || "Unknown sender";
  const labels = { sent: "Auto-replied", drafted: "Needs you", filed: "Filed", archived: "Archived", dismissed: "Dismissed", error: "Error" };
  let detail = "";
  if (m.reasons?.length) detail += `<div class="small" style="margin-bottom:8px">Why: ${esc(m.reasons.join(" · "))}</div>`;
  if (m.status === "drafted") {
    detail += `<label class="small">Reply (edit before sending)</label>
      <textarea class="input" id="reply-${esc(m.id)}" style="margin-top:6px">${esc(m.reply_body || "")}</textarea>
      <div class="btn-row">
        <button class="btn" data-action="approve" data-id="${esc(m.id)}">Send reply</button>
        <button class="btn secondary" data-action="dismiss" data-id="${esc(m.id)}">I'll handle it</button>
      </div>`;
  } else if (m.reply_body) {
    detail += `<div class="section-label">${m.status === "sent" ? "Reply sent" : "Suggested reply"}</div><div class="muted" style="white-space:pre-wrap">${esc(m.reply_body)}</div>`;
  }
  if (m.error) detail += `<div class="warn" style="margin-top:8px">${esc(m.error)}</div>`;
  return `<div class="mail" data-action="toggle-mail" data-id="${esc(m.id)}">
    <div class="mail-top">
      <div class="dot" style="margin-top:0;background:${priorityColor(m.priority)}"></div>
      <div class="mail-from">${esc(who)}</div>
      <span class="badge b-${esc(m.status)}">${esc(labels[m.status] || m.status)}</span>
    </div>
    <div class="mail-subject">${esc(m.subject || "(no subject)")}</div>
    ${m.summary ? `<div class="mail-summary">${esc(m.summary)}</div>` : ""}
    <div class="small" style="margin-top:6px"><span class="badge b-acct">${esc(ACCOUNT_NAMES[m.account_id] || m.account_id)}</span> ${esc(m.category || "")} · ${esc(ago(m.updated_at))}</div>
    <div class="mail-detail">${detail}</div>
  </div>`;
}

async function loadInbox() {
  const qs = new URLSearchParams();
  if (state.inboxStatus) qs.set("status", state.inboxStatus);
  if (state.inboxAccount) qs.set("account", state.inboxAccount);
  try {
    const d = await api(`/api/inbox?${qs}`);
    state.inboxItems = d.items;
    setBadge(d.stats.waiting);
    $("inboxStats").textContent = `${d.stats.sent24h} auto-replies in 24h · ${d.stats.waiting} waiting on you`;
    $("inboxList").innerHTML = d.items.length
      ? d.items.map(mailCard).join("")
      : `<div class="empty">${state.inboxStatus === "drafted" ? "Nothing waiting on you. 🎯" : "Nothing here yet."}</div>`;
  } catch (err) {
    $("inboxList").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

// ── tasks ──────────────────────────────────────────────────────────────
async function loadTasks() {
  try {
    const d = await api("/api/tasks");
    let html = renderTaskRows(d.open);
    if (d.done.length) html += `<div class="section-label">Recently done</div>` + renderTaskRows(d.done);
    $("taskList").innerHTML = html;
  } catch (err) {
    $("taskList").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

$("taskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("taskInput").value.trim();
  if (!title) return;
  try {
    await api("/api/tasks", { method: "POST", body: { action: "add", title, due: $("taskDue").value || undefined } });
    $("taskInput").value = "";
    $("taskDue").value = "";
    loadTasks();
  } catch (err) {
    notify(err.message, true);
  }
});

// ── chat ───────────────────────────────────────────────────────────────
function loadChat() {
  try {
    state.chat = JSON.parse(localStorage.getItem(CHAT_KEY) || "[]");
  } catch {
    state.chat = [];
  }
  renderChat();
}

function saveChat() {
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(state.chat.slice(-60)));
  } catch {
    /* storage unavailable */
  }
}

function outboxCard(p) {
  const done = p.status === "sent" || p.status === "discarded";
  return `<div class="outbox-card">
    <div><b>${esc(p.subject || "(no subject)")}</b></div>
    <div class="small">From ${esc(ACCOUNT_NAMES[p.account_id] || p.account_id)} → ${esc((p.to_addrs || []).join(", "))}</div>
    <pre>${esc(p.body)}</pre>
    ${
      done
        ? `<div class="small" style="margin-top:8px">${p.status === "sent" ? "✓ Sent" : "Discarded"}</div>`
        : `<div class="btn-row"><button class="btn" data-action="send-prepared" data-id="${esc(p.id)}">Send</button><button class="btn secondary" data-action="discard-prepared" data-id="${esc(p.id)}">Discard</button></div>`
    }
  </div>`;
}

function renderChat() {
  const box = $("chatMessages");
  if (!state.chat.length) {
    box.innerHTML = `<div class="msg system">Ask about your email, calendar or tasks — or tell Jarvis to handle something.</div>`;
  } else {
    box.innerHTML = state.chat
      .map((m) => (m.role === "outbox" ? outboxCard(m.item) : `<div class="msg ${m.role === "user" ? "user" : "assistant"}">${esc(m.content)}</div>`))
      .join("");
  }
  if (state.chatBusy) box.insertAdjacentHTML("beforeend", `<div class="msg assistant typing"><span></span><span></span><span></span></div>`);
  const screen = $("screen-chat");
  setTimeout(() => (screen.scrollTop = screen.scrollHeight), 30);
}

async function sendChat() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text || state.chatBusy) return;
  input.value = "";
  input.style.height = "auto";
  state.chat.push({ role: "user", content: text });
  state.chatBusy = true;
  $("sendBtn").disabled = true;
  renderChat();
  try {
    const messages = state.chat.filter((m) => m.role === "user" || m.role === "assistant");
    const d = await api("/api/chat", { method: "POST", body: { messages } });
    state.chat.push({ role: "assistant", content: d.reply });
    (d.pending || []).forEach((item) => state.chat.push({ role: "outbox", item }));
  } catch (err) {
    state.chat.push({ role: "assistant", content: `⚠️ ${err.message}` });
  } finally {
    state.chatBusy = false;
    $("sendBtn").disabled = false;
    saveChat();
    renderChat();
  }
}

function markOutbox(id, status) {
  state.chat.forEach((m) => {
    if (m.role === "outbox" && m.item.id === id) m.item.status = status;
  });
  saveChat();
  renderChat();
}

$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
$("chatInput").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
});

// ── settings ───────────────────────────────────────────────────────────
async function openSettings() {
  $("settings").classList.add("show");
  $("settingsBody").innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const d = await api("/api/settings");
    state.settings = d;
    renderSettings();
  } catch (err) {
    $("settingsBody").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function renderSettings() {
  const { settings: s, accounts, memory, runs, killSwitch } = state.settings;
  const accountsHtml = accounts
    .map((a) => {
      const c = a.connection;
      const status = c
        ? `<div class="small">${c.provider === "google" ? "Google" : "Microsoft"} · ${esc(c.email || "connected")}</div>${c.last_error ? `<div class="small" style="color:var(--red)">${esc(c.last_error)}</div>` : ""}`
        : `<div class="small">Not connected · ${esc(a.hint)}</div>`;
      return `<div class="acct"><div class="acct-name">${esc(a.label)}</div>${status}
        <div class="btn-row">
          <a class="btn secondary" style="text-decoration:none;font-size:13px" href="/api/oauth?step=start&provider=google&account=${esc(a.id)}">${c?.provider === "google" ? "Reconnect" : "Connect"} Google</a>
          <a class="btn secondary" style="text-decoration:none;font-size:13px" href="/api/oauth?step=start&provider=microsoft&account=${esc(a.id)}">${c?.provider === "microsoft" ? "Reconnect" : "Connect"} Outlook</a>
          ${c ? `<button class="btn danger" style="font-size:13px" data-action="disconnect" data-account="${esc(a.id)}">Disconnect</button>` : ""}
        </div></div>`;
    })
    .join("");

  const seg = ["off", "drafts", "full"]
    .map((m) => `<button type="button" class="${s.autopilot === m ? "on" : ""}" data-action="autopilot" data-mode="${m}">${{ off: "Off", drafts: "Drafts only", full: "Full auto" }[m]}</button>`)
    .join("");

  $("settingsBody").innerHTML = `
    ${killSwitch ? `<div class="warn">AUTOPILOT_DISABLED is set in Vercel: nothing will be sent until it is removed.</div>` : ""}
    <div class="section-label">Inboxes</div>${accountsHtml}

    <div class="section-label">Email autopilot</div>
    <div class="field"><div class="seg" id="autopilotSeg">${seg}</div>
      <p class="small" style="margin-top:6px">Full auto sends replies that pass every guardrail below and drafts the rest. Drafts only never sends.</p></div>
    <div class="field"><label>Only auto-send when Jarvis is at least this confident (0.5–1)</label><input class="input" id="sConfidence" type="number" step="0.05" min="0.5" max="1" value="${esc(s.confidence_threshold)}"></div>
    <div class="field"><label>Max auto-replies per 24 hours</label><input class="input" id="sCap" type="number" min="0" max="500" value="${esc(s.daily_send_cap)}"></div>
    <div class="toggle-row"><span>Only auto-reply to people I've emailed before</span><input type="checkbox" id="sPrior" ${s.require_prior_correspondence ? "checked" : ""}></div>
    <div class="toggle-row"><span>Archive newsletters, promos, receipts</span><input type="checkbox" id="sArchive" ${s.auto_archive ? "checked" : ""}></div>
    <div class="field"><label>Never auto-reply to (one address or @domain per line)</label><textarea class="input" id="sNever" placeholder="@brasstowncapital.com&#10;lawyer@firm.com">${esc((s.never_auto_send || []).join("\n"))}</textarea></div>
    <div class="field"><label>Reply profile: what auto-replies may say (tone, signature per business). Goes to outside senders, so nothing private.</label><textarea class="input" id="sReplyProfile">${esc(s.reply_profile)}</textarea></div>

    <div class="section-label">Planning</div>
    <div class="field"><label>Send the morning plan and alerts to</label>
      <select class="input" id="sBrief">${accounts.map((a) => `<option value="${esc(a.id)}" ${s.brief_account === a.id ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select></div>
    <div class="field"><label>Time zone</label><input class="input" id="sTz" value="${esc(s.timezone)}"></div>
    <div class="field"><label>About me (private: used for planning and chat, never in email replies)</label><textarea class="input" id="sAbout">${esc(s.about_me)}</textarea></div>
    <button class="btn" style="width:100%;padding:14px" data-action="save-settings">Save settings</button>

    <div class="section-label">What Jarvis remembers</div>
    ${memory.length ? memory.map((m) => `<div class="row"><div class="main">${esc(m.fact)}</div><button class="btn secondary" style="padding:4px 10px;font-size:12px" data-action="forget" data-id="${esc(m.id)}">Forget</button></div>`).join("") : `<div class="small">Nothing yet. Tell Jarvis things in chat.</div>`}

    <div class="section-label">Recent background runs</div>
    ${runs.length ? runs.map((r) => `<div class="small">${r.ok ? "✓" : "⚠️"} ${esc(r.job)} · ${esc(ago(r.created_at))} · ${esc(JSON.stringify(r.detail?.results || r.detail || {}))}</div>`).join("") : `<div class="small">No runs yet. Check that the GitHub Actions schedule is set up.</div>`}

    <div class="btn-row" style="margin-top:20px"><button class="btn danger" data-action="logout">Sign out</button></div>`;
}

async function saveSettingsForm() {
  const payload = {
    autopilot: state.settings.settings.autopilot,
    confidence_threshold: Number($("sConfidence").value),
    daily_send_cap: Number($("sCap").value),
    require_prior_correspondence: $("sPrior").checked,
    auto_archive: $("sArchive").checked,
    never_auto_send: $("sNever").value.split(/\n|,/).map((x) => x.trim()).filter(Boolean),
    reply_profile: $("sReplyProfile").value,
    brief_account: $("sBrief").value,
    timezone: $("sTz").value.trim(),
    about_me: $("sAbout").value,
  };
  const d = await api("/api/settings", { method: "POST", body: { action: "save", settings: payload } });
  state.settings.settings = d.settings;
  notify("Settings saved");
}

// ── click routing ──────────────────────────────────────────────────────
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;

  // Clicks inside an open mail's controls must not collapse it.
  if (action === "toggle-mail") {
    if (e.target.closest(".mail-detail")) return;
    el.classList.toggle("open");
    return;
  }

  const busy = (on) => {
    if (el.tagName === "BUTTON") el.disabled = on;
  };
  busy(true);
  try {
    switch (action) {
      case "tab":
        switchTab(el.dataset.tab);
        break;
      case "open-settings":
        await openSettings();
        break;
      case "close-settings":
        $("settings").classList.remove("show");
        break;
      case "replan":
        $("planBody").innerHTML = `<div class="empty">Building your plan… (about a minute)</div>`;
        await api("/api/today", { method: "POST", body: { action: "replan" } });
        await loadToday();
        break;
      case "inbox-filter":
        state.inboxStatus = el.dataset.status;
        document.querySelectorAll("#statusChips .chip").forEach((c) => c.classList.toggle("on", c === el));
        await loadInbox();
        break;
      case "inbox-account":
        state.inboxAccount = el.dataset.account;
        document.querySelectorAll("#accountChips .chip").forEach((c) => c.classList.toggle("on", c === el));
        await loadInbox();
        break;
      case "run-inbox": {
        notify("Checking all inboxes…");
        const r = await api("/api/inbox", { method: "POST", body: { action: "run" } });
        const n = Object.values(r.results || {}).reduce((a, b) => a + b, 0);
        notify(n ? `Handled ${n} new email${n > 1 ? "s" : ""}` : "No new email");
        await loadInbox();
        break;
      }
      case "approve": {
        const text = $(`reply-${id}`)?.value;
        await api("/api/inbox", { method: "POST", body: { action: "approve", id, body: text } });
        notify("Reply sent");
        await loadInbox();
        break;
      }
      case "dismiss":
        await api("/api/inbox", { method: "POST", body: { action: "dismiss", id } });
        await loadInbox();
        break;
      case "toggle-task":
        await api("/api/tasks", { method: "POST", body: { action: "update", id, status: el.dataset.status === "done" ? "open" : "done" } });
        if (state.tab === "tasks") await loadTasks();
        else await loadToday();
        break;
      case "send-chat":
        await sendChat();
        break;
      case "clear-chat":
        state.chat = [];
        saveChat();
        renderChat();
        break;
      case "send-prepared":
        await api("/api/chat", { method: "POST", body: { action: "send", id } });
        markOutbox(id, "sent");
        notify("Email sent");
        break;
      case "discard-prepared":
        await api("/api/chat", { method: "POST", body: { action: "discard", id } });
        markOutbox(id, "discarded");
        break;
      case "autopilot":
        state.settings.settings.autopilot = el.dataset.mode;
        document.querySelectorAll("#autopilotSeg button").forEach((b) => b.classList.toggle("on", b === el));
        break;
      case "save-settings":
        await saveSettingsForm();
        break;
      case "disconnect":
        if (!confirm("Disconnect this inbox? Jarvis will stop handling its email.")) break;
        await api("/api/settings", { method: "POST", body: { action: "disconnect", account: el.dataset.account } });
        await openSettings();
        break;
      case "forget":
        await api("/api/settings", { method: "POST", body: { action: "forget", id } });
        await openSettings();
        break;
      case "logout":
        await api("/api/auth", { method: "POST", body: { action: "logout" } });
        $("settings").classList.remove("show");
        showLogin();
        break;
    }
  } catch (err) {
    notify(err.message, true);
  } finally {
    busy(false);
  }
});

// ── boot ───────────────────────────────────────────────────────────────
function handleOAuthReturn() {
  const params = new URLSearchParams(location.search);
  const c = params.get("connected");
  if (!c) return;
  history.replaceState(null, "", "/");
  if (c.startsWith("error:")) notify(`Connection failed (${c.slice(6)}). Try again.`, true);
  else notify(`Connected ${c.split(":").slice(1).join(":")}`);
}

async function boot() {
  const { loggedIn } = await api("/api/auth").catch(() => ({ loggedIn: false }));
  if (!loggedIn) return showLogin();
  handleOAuthReturn();
  loadChat();
  switchTab(state.tab);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
