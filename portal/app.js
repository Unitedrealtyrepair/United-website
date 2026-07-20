// ============================================================
// URR Project Portal v2.0 - dashboard logic
// ============================================================

const $ = (id) => document.getElementById(id);

// ============================================================
// The only thing configured here is your Apps Script URL.
// No emails, keys, or codes live in this file - all of that
// stays in your private Google Sheet, checked server-side.
// ============================================================
const BACKEND_URL = "https://script.google.com/macros/s/AKfycbyawmC9BmS689FgvFsMo-UemEhBNlYl7jPwMdTuTZqPSDTbFVCD4Ks6IqizdZctTcdj/exec";

const ROLE_ACCESS = {
  admin:    ["Overview", "Schedule", "Budget", "Daily Logs", "Documents", "Photos", "Invoices", "Change Orders", "Estimates", "Materials", "Subs"],
  customer: ["Overview", "Schedule", "Budget", "Daily Logs", "Documents", "Photos", "Invoices", "Change Orders", "Estimates"],
  sub:      ["Schedule", "Daily Logs", "Photos", "Invoices", "Materials"]
};

let SESSION = null; // { email, code, role, projects, apiKey }

async function api(payload) {
  const res = await fetch(BACKEND_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

let currentUser = null;
let presenceMap = {};
let presenceTimer = null;
let presenceRoster = [];
let inboxThreads = {};     // admin: { email: {items, unread} }
let myThread = [];         // non-admin thread
let unreadMsgs = 0;
let activityList = [];
let msgTargetEmail = null;
let pendingNotify = { task: [], log: [], upload: [] };

function projectUsersForNotify() {
  return presenceRosterList().filter((m) =>
    m.role !== "admin" &&
    (Array.isArray(m.projects)
      ? m.projects.includes(currentProject.name)
      : String(m.projects || "").split(",").map((s) => s.trim()).includes(currentProject.name))
  );
}

function buildNotifyChips(container, slot) {
  container.innerHTML = "";
  pendingNotify[slot] = [];
  if (!isAdmin()) return;
  const users = projectUsersForNotify();
  if (users.length === 0) return;
  const lbl = document.createElement("span");
  lbl.className = "album-perms-label";
  lbl.textContent = "🔔 Notify:";
  container.appendChild(lbl);
  for (const u of users) {
    const em = u.email.toLowerCase();
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "perm-chip";
    chip.textContent = u.email + " (" + u.role + ")";
    chip.addEventListener("click", () => {
      const i = pendingNotify[slot].indexOf(em);
      if (i === -1) { pendingNotify[slot].push(em); chip.classList.add("on"); chip.textContent = "✓ " + u.email + " (" + u.role + ")"; }
      else { pendingNotify[slot].splice(i, 1); chip.classList.remove("on"); chip.textContent = u.email + " (" + u.role + ")"; }
    });
    container.appendChild(chip);
  }
} // admin's selected thread
function presenceRosterList() {
  return presenceRoster.length ? presenceRoster : (SESSION && SESSION.members ? SESSION.members : []);
}
let uploadStatus = "";
let expandedGroups = new Set();
let navPathByTab = {};
const syncEnabled = () => true;
let currentProject = null;
let allFiles = [];
let activeTab = null;

// ---------- Trades (in build-sequence order) ----------
const TRADES = [
  "Planning / Design","Architectural / Engineering","Permitting","Demolition",
  "Excavation / Grading","Utilities (Sewer / Water / Gas)","Foundation / Concrete",
  "Waterproofing / Drainage","Framing","Structural Steel","Roofing",
  "Windows / Exterior Doors","Siding / Exterior Finish","Masonry / Stucco / Stone",
  "Gutters","Decks / Porches","Rough Electrical","Rough Plumbing","Rough HVAC",
  "Fire Sprinklers","Low Voltage / Security / AV","Inspections (Rough)","Insulation",
  "Drywall","Interior Doors / Trim / Millwork","Cabinets","Countertops","Tile",
  "Flooring","Painting","Finish Electrical / Fixtures","Finish Plumbing / Fixtures",
  "Finish HVAC / Registers","Appliances","Garage Doors","Driveway / Flatwork",
  "Fencing","Landscaping / Irrigation","Final Cleaning","Punch List","Final Inspection"
];

const BUDGET_CATEGORIES = [
  "Labor","Materials","Subcontractor","Permits & Fees","Equipment Rental",
  "Demolition & Disposal","Design / Engineering","Contingency","Change Order","Other"
];

// ---------- Per-project state ----------
let schedule = [];   // [{id, trade, sub, start, end, status, notes}]
let budget = [];     // [{id, desc, cat, amount, paid}]
let logs = [];       // [{id, date, weather, crew, notes, internal}]
let subs = [];       // global: [{id, name, company, trade, phone, email, notes}]
let folderPerms = {};   // { subfolderId: [emails allowed to view] }
let invoices = [];      // [{id, t, sub, number, amount, notes, fileId, fileName, status}] — memory only, never cached
let photoFolders = [];  // [{id, name, isSubUploads}]
let subUploadsFolderId = null;
let calMonth = new Date();
let editingTaskId = null;
let editingBudgetId = null;
let editingLogId = null;
let editingSubId = null;

function pkey(name) { return "urr" + name + "_" + currentProject.folderId; }

function cacheGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}
function cacheSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

function applyRemote(remote) {
  if (!remote) return;
  if (remote[pkey("Schedule")]) schedule = remote[pkey("Schedule")];
  if (remote[pkey("Budget")]) budget = remote[pkey("Budget")];
  if (remote[pkey("Logs")]) logs = remote[pkey("Logs")];
  if (remote[pkey("FolderPerms")]) folderPerms = remote[pkey("FolderPerms")];
  invoices = remote[pkey("Invoices")] || []; // server pre-filters per role; never cached to localStorage
  if (remote["urrSubs"]) subs = remote["urrSubs"];
  cacheSet(pkey("Schedule"), schedule);
  cacheSet(pkey("Budget"), budget);
  cacheSet(pkey("Logs"), logs);
  cacheSet(pkey("FolderPerms"), folderPerms);
  if (isAdmin()) cacheSet("urrSubs", subs);
}

async function loadState(initialData) {
  schedule = cacheGet(pkey("Schedule")) || [];
  budget = cacheGet(pkey("Budget")) || [];
  logs = cacheGet(pkey("Logs")) || [];
  folderPerms = cacheGet(pkey("FolderPerms")) || {};
  invoices = [];
  subs = cacheGet("urrSubs") || [];
  if (initialData) { applyRemote(initialData); setSyncStatus("synced"); return; }
  try {
    const out = await api({ action: "pull", email: SESSION.email, code: SESSION.code });
    if (out.ok) { applyRemote(out.data); setSyncStatus("synced"); }
    else setSyncStatus("offline");
  } catch (err) {
    console.warn("pull failed", err);
    setSyncStatus("offline");
  }
}

async function pushCollection(key, data, notify) {
  try {
    const out = await api({ action: "save", email: SESSION.email, code: SESSION.code, key, data, notify: notify || [] });
    setSyncStatus(out.ok ? "synced" : "offline");
  } catch (err) {
    console.warn("save failed", err);
    setSyncStatus("offline");
  }
}

function setSyncStatus(state) {
  const badge = $("user-badge");
  if (!badge) return;
  badge.dataset.sync = state;
  badge.title = state === "offline"
    ? "Connection issue - changes saved on this device; hit Refresh when back online."
    : "Synced";
}

async function saveSchedule() { cacheSet(pkey("Schedule"), schedule); pushCollection(pkey("Schedule"), schedule, pendingNotify.task); pendingNotify.task = []; }
async function saveBudget()   { cacheSet(pkey("Budget"), budget);     pushCollection(pkey("Budget"), budget); }
async function saveLogs()     { cacheSet(pkey("Logs"), logs); pushCollection(pkey("Logs"), logs, pendingNotify.log); pendingNotify.log = []; }
async function saveSubs()     { cacheSet("urrSubs", subs);            pushCollection("urrSubs", subs); }
async function saveFolderPerms() { cacheSet(pkey("FolderPerms"), folderPerms); pushCollection(pkey("FolderPerms"), folderPerms); }

// ---------- Categorization ----------
const RULES = [
  { tab: "Invoices",      match: (n) => /\binvoice|\binv[\s\-_]?\d/.test(n) },
  { tab: "Change Orders", match: (n) => /change[\s\-_]?order|\bco[\s\-_]?\d/.test(n) },
  { tab: "Estimates",     match: (n) => /estimate|proposal|bid\b/.test(n) },
  { tab: "Schedule",      match: (n) => /schedule|timeline/.test(n) },
  { tab: "Materials",     match: (n) => /material|receipt|supply|supplier|order[\s\-_]?form/.test(n) },
  { tab: "Documents",     match: (n) => /permit|inspection|plan|contract|warranty|scope|spec/.test(n) }
];

function categorize(file) {
  const n = file.name.toLowerCase();
  const isInternal = /internal/.test(n);
  for (const r of RULES) {
    if (r.match(n)) return { tab: r.tab, internal: isInternal };
  }
  if ((file.mimeType || "").startsWith("image/") || /\.(jpe?g|png|gif|heic|webp)$/.test(n)) {
    return { tab: "Photos", internal: isInternal };
  }
  return { tab: "Documents", internal: isInternal };
}

// ---------- Login ----------
const isAdmin = () => SESSION && SESSION.role === "admin";

async function doLogin() {
  const email = $("email-input").value.trim();
  const code = $("code-input").value.trim();
  if (!email || !code) return;
  $("login-error").classList.add("hidden");
  $("login-wait").classList.remove("hidden");
  try {
    const out = await api({ action: "login", email, code });
    $("login-wait").classList.add("hidden");
    if (!out.ok) { $("login-error").classList.remove("hidden"); return; }
    SESSION = { email: out.email, code, role: out.role, projects: out.projects, apiKey: out.apiKey };
    sessionStorage.setItem("urrSession", JSON.stringify(SESSION));
    enterPortal(out.data);
  } catch (err) {
    $("login-wait").classList.add("hidden");
    $("login-error").classList.remove("hidden");
    console.error(err);
  }
}

function enterPortal(initialData) {
  currentUser = { email: SESSION.email, role: SESSION.role };
  if (!currentProject || !SESSION.projects.some((p) => p.name === currentProject.name)) {
    const savedName = sessionStorage.getItem("urrProject");
    currentProject = SESSION.projects.find((p) => p.name === savedName) || SESSION.projects[0];
  }
  $("login-screen").classList.add("hidden");
  $("portal-screen").classList.remove("hidden");
  renderProjectName();
  $("user-badge").textContent = SESSION.email + " · " + SESSION.role;
  buildTabs();
  loadState(initialData).then(() => { render(); loadFiles(); });
  resetSharedState();
  startPresence();
}

function renderProjectName() {
  const holder = $("project-name");
  holder.innerHTML = "";
  if (SESSION.projects.length <= 1) {
    holder.textContent = currentProject.name;
    return;
  }
  const sel = document.createElement("select");
  sel.className = "project-switcher";
  for (const p of SESSION.projects) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = currentProject.name;
  sel.addEventListener("change", () => {
    currentProject = SESSION.projects.find((p) => p.name === sel.value);
    sessionStorage.setItem("urrProject", currentProject.name);
    allFiles = [];
    photoFolders = [];
    projectFolderTree = {};
    navPathByTab = {};
    buildTabs();
    loadState(null).then(() => { render(); loadFiles(); });
  });
  holder.appendChild(sel);
}


function startPresence() {
  if (presenceTimer) clearInterval(presenceTimer);
  const beat = async () => {
    try { await api({ action: "ping", email: SESSION.email, code: SESSION.code, project: currentProject.name }); } catch (e) {}
    try {
      const out = await api({ action: "inbox", email: SESSION.email, code: SESSION.code });
      if (out.ok) {
        if (out.v) console.log("URR backend " + out.v);
        activityList = out.activity || [];
        if (!isAdmin()) {
          presenceMap = {};
          presenceRoster = [];
          inboxThreads = {};
        }
        if (isAdmin()) {
          inboxThreads = out.threads || {};
          unreadMsgs = Object.values(inboxThreads).reduce((s, t) => s + (t.unread || 0), 0);
          presenceMap = out.presence || {};
          if (out.users) presenceRoster = out.users;
          renderPresenceBadge();
          if (activeTab === "Overview") renderPresence();
        } else {
          myThread = out.thread || [];
          unreadMsgs = out.unreadMsgs || 0;
        }
        renderMsgBadge();
        renderBell();
      }
    } catch (e) {}
  };
  beat();
  presenceTimer = setInterval(beat, 60000);
}

function presenceStatus(iso) {
  if (!iso) return { cls: "offline", label: "Never logged in" };
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 2.5) return { cls: "online", label: "Online now" };
  if (mins < 15) return { cls: "away", label: Math.round(mins) + " min ago" };
  const d = new Date(iso);
  return { cls: "offline", label: "Last seen " + d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) };
}

function presenceRecFor(email) {
  return presenceMap[String(email || "").toLowerCase()] || null;
}

function renderPresenceBadge() {
  const btn = $("presence-badge");
  const pop = $("presence-pop");
  if (!btn || !pop) return;
  if (!isAdmin()) { btn.classList.add("hidden"); pop.classList.add("hidden"); return; }
  btn.classList.remove("hidden");
  const roster = presenceRosterList().filter((m) => m.role !== "admin");
  let online = 0;
  for (const m of roster) {
    const rec = presenceRecFor(m.email);
    if (rec && presenceStatus(rec.t).cls === "online") online++;
  }
  btn.textContent = "👥 " + online + " online";
  btn.classList.toggle("has-online", online > 0);

  pop.innerHTML = "";
  if (roster.length === 0) {
    const d = document.createElement("div");
    d.className = "presence-meta";
    d.style.padding = "10px 14px";
    d.textContent = "No customers or subs yet";
    pop.appendChild(d);
  }
  for (const m of roster) {
    const rec = presenceRecFor(m.email);
    const st = presenceStatus(rec ? rec.t : null);
    const row = document.createElement("div");
    row.className = "presence-row";
    const dot = document.createElement("span");
    dot.className = "presence-dot " + st.cls;
    row.appendChild(dot);
    const info = document.createElement("div");
    info.className = "presence-info";
    const who = document.createElement("div");
    who.className = "presence-who";
    who.textContent = m.email + " · " + m.role;
    const meta = document.createElement("div");
    meta.className = "presence-meta";
    meta.textContent = st.label + (rec && rec.project && st.cls !== "offline" ? " · " + rec.project : "");
    info.appendChild(who);
    info.appendChild(meta);
    row.appendChild(info);
    pop.appendChild(row);
  }
}

function lastSeenActivityKey() {
  return "urrActSeen_" + (SESSION ? SESSION.email : "");
}

function unseenActivityCount() {
  const seen = localStorage.getItem(lastSeenActivityKey()) || "";
  return activityList.filter((a) => a.t > seen).length;
}

function renderBell() {
  const btn = $("bell-badge");
  if (!btn) return;
  btn.classList.remove("hidden");
  const n = unseenActivityCount();
  btn.textContent = "🔔" + (n > 0 ? " " + n : "");
  btn.classList.toggle("has-online", n > 0);
}

function renderBellPop() {
  const pop = $("bell-pop");
  if (!pop) return;
  pop.innerHTML = "";
  if (activityList.length === 0) {
    const d = document.createElement("div");
    d.className = "presence-meta";
    d.style.padding = "10px 14px";
    d.textContent = "No updates yet";
    pop.appendChild(d);
    return;
  }
  for (const a of activityList) {
    const row = document.createElement("div");
    row.className = "presence-row";
    const info = document.createElement("div");
    info.className = "presence-info";
    const who = document.createElement("div");
    who.className = "presence-who";
    const icon = a.kind === "schedule" ? "📅" : a.kind === "budget" ? "💵" : a.kind === "log" ? "📝" : a.kind === "photos" ? "📷" : "•";
    who.textContent = icon + " " + a.summary;
    const meta = document.createElement("div");
    meta.className = "presence-meta";
    const d2 = new Date(a.t);
    meta.textContent = a.project + " · " + d2.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d2.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) + (a.by && a.by !== "admin" ? " · " + a.by : "");
    info.appendChild(who);
    info.appendChild(meta);
    row.appendChild(info);
    pop.appendChild(row);
  }
}

function renderMsgBadge() {
  const btn = $("msg-badge");
  if (!btn) return;
  btn.classList.remove("hidden");
  btn.textContent = "✉" + (unreadMsgs > 0 ? " " + unreadMsgs : "");
  btn.classList.toggle("has-online", unreadMsgs > 0);
}

function renderMsgPop() {
  const pop = $("msg-pop");
  if (!pop) return;
  pop.innerHTML = "";

  const thread = document.createElement("div");
  thread.className = "msg-thread";

  let items = [];
  if (isAdmin()) {
    const sel = document.createElement("select");
    sel.className = "dest-select msg-user-select";
    const roster = presenceRosterList().filter((m) => m.role !== "admin");
    if (roster.length === 0) {
      const d = document.createElement("div");
      d.className = "presence-meta";
      d.style.padding = "10px 14px";
      d.textContent = "Add users to the sheet first";
      pop.appendChild(d);
      return;
    }
    for (const m of roster) {
      const o = document.createElement("option");
      o.value = m.email.toLowerCase();
      const un = (inboxThreads[m.email.toLowerCase()] || {}).unread || 0;
      o.textContent = m.email + (un > 0 ? " (" + un + ")" : "");
      sel.appendChild(o);
    }
    if (!msgTargetEmail) msgTargetEmail = sel.options[0].value;
    sel.value = msgTargetEmail;
    sel.addEventListener("change", () => {
      msgTargetEmail = sel.value;
      renderMsgPop();
      markThreadRead();
    });
    pop.appendChild(sel);
    items = (inboxThreads[msgTargetEmail] || {}).items || [];
  } else {
    items = myThread;
  }

  const meLabel = isAdmin() ? "admin" : SESSION.email.toLowerCase();
  if (items.length === 0) {
    const d = document.createElement("div");
    d.className = "presence-meta";
    d.style.padding = "8px 4px";
    d.textContent = "No messages yet";
    thread.appendChild(d);
  }
  for (const m of items) {
    const bub = document.createElement("div");
    const mine = m.from === meLabel;
    bub.className = "msg-bubble " + (mine ? "mine" : "theirs");
    bub.textContent = m.text;
    const t = document.createElement("div");
    t.className = "msg-time";
    const d2 = new Date(m.t);
    t.textContent = (mine ? "You" : (m.from === "admin" ? "United Realty Repair" : m.from)) + " · " + d2.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d2.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const wrap = document.createElement("div");
    wrap.className = "msg-wrap-line " + (mine ? "mine" : "theirs");
    wrap.appendChild(bub);
    wrap.appendChild(t);
    thread.appendChild(wrap);
  }
  pop.appendChild(thread);
  thread.scrollTop = thread.scrollHeight;

  const bar = document.createElement("div");
  bar.className = "msg-input-bar";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = "Type a message…";
  inp.maxLength = 2000;
  const send = document.createElement("button");
  send.className = "add-task-btn";
  send.textContent = "Send";
  const doSend = async () => {
    const text = inp.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      const payload = { action: "sendMessage", email: SESSION.email, code: SESSION.code, text };
      if (isAdmin()) payload.to = msgTargetEmail;
      const out = await api(payload);
      if (!out.ok) throw new Error(out.error || "failed");
      inp.value = "";
      const now = new Date().toISOString();
      const msg = { id: "tmp" + Date.now(), from: meLabel, text, t: now, readBy: [meLabel] };
      if (isAdmin()) {
        if (!inboxThreads[msgTargetEmail]) inboxThreads[msgTargetEmail] = { items: [], unread: 0 };
        inboxThreads[msgTargetEmail].items.push(msg);
      } else {
        myThread.push(msg);
      }
      renderMsgPop();
    } catch (err) {
      alert("Couldn't send: " + err.message);
    }
    send.disabled = false;
    inp.focus();
  };
  send.addEventListener("click", doSend);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); });
  bar.appendChild(inp);
  bar.appendChild(send);
  pop.appendChild(bar);
}

async function markThreadRead() {
  try {
    const payload = { action: "readMessages", email: SESSION.email, code: SESSION.code };
    if (isAdmin()) {
      payload.with = msgTargetEmail;
      if (inboxThreads[msgTargetEmail]) {
        unreadMsgs -= inboxThreads[msgTargetEmail].unread || 0;
        inboxThreads[msgTargetEmail].unread = 0;
      }
    } else {
      unreadMsgs = 0;
    }
    renderMsgBadge();
    await api(payload);
  } catch (e) {}
}

function renderPresence() {
  const card = $("ov-presence-card");
  const wrap = $("ov-presence");
  if (!card || !wrap) return;
  if (!isAdmin()) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  wrap.innerHTML = "";
  const members = presenceRosterList().filter((m) => m.role !== "admin");
  if (members.length === 0) {
    wrap.appendChild(ovEmpty("No customers or subs added yet"));
    return;
  }
  for (const m of members) {
    const rec = presenceRecFor(m.email);
    const st = presenceStatus(rec ? rec.t : null);
    const row = document.createElement("div");
    row.className = "presence-row";
    const dot = document.createElement("span");
    dot.className = "presence-dot " + st.cls;
    row.appendChild(dot);
    const info = document.createElement("div");
    info.className = "presence-info";
    const who = document.createElement("div");
    who.className = "presence-who";
    who.textContent = m.email + " · " + m.role;
    const meta = document.createElement("div");
    meta.className = "presence-meta";
    meta.textContent = st.label + (rec && rec.project && st.cls !== "offline" ? " · viewing " + rec.project : "");
    info.appendChild(who);
    info.appendChild(meta);
    row.appendChild(info);
    wrap.appendChild(row);
  }
}

function resetSharedState() {
  presenceMap = {};
  presenceRoster = [];
  inboxThreads = {};
  myThread = [];
  unreadMsgs = 0;
  activityList = [];
  msgTargetEmail = null;
  const pb = $("presence-badge"), pp = $("presence-pop");
  if (pb) pb.classList.add("hidden");
  if (pp) { pp.classList.add("hidden"); pp.innerHTML = ""; }
}

function logout() {
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
  resetSharedState();
  sessionStorage.removeItem("urrSession");
  SESSION = null;
  currentUser = null;
  allFiles = [];
  $("portal-screen").classList.add("hidden");
  $("login-screen").classList.remove("hidden");
  $("email-input").value = "";
  $("code-input").value = "";
  $("login-error").classList.add("hidden");
}

// ---------- Tabs ----------
function buildTabs() {
  const tabs = ROLE_ACCESS[SESSION.role] || [];
  const nav = $("tabs");
  nav.innerHTML = "";
  activeTab = tabs[0];
  tabs.forEach((t) => {
    const b = document.createElement("button");
    b.className = "tab" + (t === activeTab ? " active" : "");
    b.textContent = t;
    b.addEventListener("click", () => {
      activeTab = t;
      nav.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      render();
    });
    nav.appendChild(b);
  });
}

// ---------- Drive API ----------
async function loadFiles() {
  $("loading").classList.remove("hidden");
  $("api-error").classList.add("hidden");
  $("file-list").innerHTML = "";
  $("empty-msg").classList.add("hidden");

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = await api({ action: "files", email: SESSION.email, code: SESSION.code, project: currentProject.name });
      if (!out.ok) throw new Error(out.error || "listing failed");
      ingestListing(out);
      $("loading").classList.add("hidden");
      render();
      return;
    } catch (err) {
      lastErr = err;
      console.warn("files attempt " + attempt + " failed:", err);
      await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  showApiError("Couldn't load files (" + (lastErr && lastErr.message ? lastErr.message : "network") + "). Tap Refresh to retry.");
}

let projectFolderTree = {};

async function loadFolderTree() {
  try {
    const out = await api({ action: "folders", email: SESSION.email, code: SESSION.code, project: currentProject.name });
    if (out.ok) projectFolderTree = out.areas || {};
  } catch (e) { console.warn("folders load failed", e); }
}

async function uploadOne(file, dest) {
  const b64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("read failed"));
    r.readAsDataURL(file);
  });
  return api({
    action: "upload",
    email: SESSION.email,
    code: SESSION.code,
    project: currentProject.name,
    filename: file.name,
    mimeType: file.type,
    data: b64,
    destArea: (dest && dest.destArea) || "crew",
    destFolderName: (dest && dest.destFolderName) || "",
    destAreaRoot: !!(dest && dest.destAreaRoot),
    notify: (dest && dest.notify) || []
  });
}

async function uploadPhotos(fileList, btn, hint, dest) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  btn.disabled = true;
  let done = 0, failed = 0, lastErr = "";
  for (const file of files) {
    hint.textContent = "Uploading " + (done + failed + 1) + " of " + files.length + "… (" + file.name + ")";
    try {
      const out = await uploadOne(file, dest);
      if (out.ok) done++;
      else { failed++; lastErr = out.error || "unknown"; }
    } catch (err) {
      console.warn("upload failed", err);
      failed++;
      lastErr = err.message;
    }
  }
  btn.disabled = false;
  uploadStatus = failed
    ? "✗ Upload failed — server said: " + lastErr
    : "✓ " + done + " photo" + (done === 1 ? "" : "s") + " uploaded";
  hint.textContent = uploadStatus;
  console.error("URR upload result:", { done, failed, lastErr });
  setTimeout(() => { uploadStatus = ""; }, 15000);
  loadFiles();
}

function ingestListing(out) {
  photoFolders = out.albums || [];
  const su = photoFolders.find((f) => f.isSubUploads);
  subUploadsFolderId = su ? su.id : null;

  allFiles = (out.files || []).map((f) => {
    const office = f.source === "office";
    if (f.albumId) {
      // Images in a subfolder = photo album entry.
      // Documents in a subfolder = sorted into their normal tab.
      if (isImage(f)) return { ...f, tab: "Photos", internal: office };
      // Folder name wins: a file in a "...PERMIT..." folder is a Document,
      // even if its filename says "receipt".
      const folderCat = categorize({ name: f.albumName || "", mimeType: "" });
      const fileCat = categorize(f);
      const byFolder = /invoice|change[\s\-_]?order|estimate|proposal|bid|schedule|timeline|material|receipt|supply|permit|inspection|plan|contract|warranty|scope|spec/.test((f.albumName || "").toLowerCase());
      const c = byFolder ? folderCat : fileCat;
      return { ...f, tab: c.tab, internal: fileCat.internal || office };
    }
    const c = categorize(f);
    return { ...f, ...c, internal: c.internal || office };
  });
}

function albumHasVisualsOrIsSpecial(fo, files) {
  // Show an album section if it contains images, or if it's Sub Uploads (upload target)
  return fo.isSubUploads || files.some((f) => f.albumId === fo.id);
}

function showApiError(msg) {
  $("loading").classList.add("hidden");
  const el = $("api-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function offerKeyInput() {
  const el = $("api-error");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Paste Google API key here";
  input.style.cssText = "display:block;margin:14px auto 0;padding:10px;width:min(420px,90%);border:1.5px solid #dde3ec;border-radius:8px;font-family:inherit;";
  const btn = document.createElement("button");
  btn.textContent = "Save key";
  btn.style.cssText = "display:block;margin:10px auto 0;padding:10px 22px;background:#0f2440;color:#fff;border:none;border-radius:8px;font-family:inherit;font-weight:700;cursor:pointer;";
  btn.addEventListener("click", async () => {
    await chrome.storage.local.set({ urrApiKey: input.value.trim() });
    loadFiles();
  });
  el.appendChild(input);
  el.appendChild(btn);
}

// ---------- Money helpers ----------
const fmtMoney = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// ---------- Master render ----------
function render() {
  const sections = {
    "overview-section": activeTab === "Overview",
    "calendar-section": activeTab === "Schedule",
    "budget-section":   activeTab === "Budget",
    "logs-section":     activeTab === "Daily Logs",
    "subs-section":     activeTab === "Subs",
    "invoices-section": activeTab === "Invoices" && (isAdmin() || currentUser.role === "sub")
  };
  for (const [id, show] of Object.entries(sections)) {
    $(id).classList.toggle("hidden", !show);
  }

  // Admin keeps the invoice FILE view under the submitted-invoice panel
  const isFileTab = !Object.values(sections).some(Boolean) || (activeTab === "Invoices" && isAdmin());

  if (activeTab === "Overview") renderOverview();
  if (activeTab === "Schedule") {
    $("add-task-btn").classList.toggle("hidden", !isAdmin());
    renderCalendar();
    renderUpcoming();
  }
  if (activeTab === "Budget") renderBudget();
  if (activeTab === "Daily Logs") renderLogs();
  if (activeTab === "Subs") renderSubs();
  if (activeTab === "Invoices" && (isAdmin() || currentUser.role === "sub")) renderInvoices();

  // File grid only on file tabs
  const list = $("file-list");
  list.innerHTML = "";
  $("empty-msg").classList.add("hidden");
  if (!isFileTab) return;

  // Photos tab: in-portal upload for subs & admin
  if ((activeTab === "Photos" || activeTab === "Documents") && (isAdmin() || currentUser.role === "sub" || currentUser.role === "customer") && syncEnabled()) {
    const bar = document.createElement("div");
    bar.className = "photos-toolbar";

    const isDocs = activeTab === "Documents";
    const input = document.createElement("input");
    input.type = "file";
    if (!isDocs) input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";

    const btn = document.createElement("button");
    btn.className = "add-task-btn photos-add";
    btn.textContent = isDocs ? "+ Add Documents" : "+ Add Photos";
    btn.addEventListener("click", () => input.click());

    let areaSel = null, folderSel = null;
    if (isAdmin()) {
      areaSel = document.createElement("select");
      areaSel.className = "dest-select";
      [["customer","→ Customer folder"],["crew","→ Sub folder"],["office","→ Office (private)"]].forEach(([v,l]) => {
        const o = document.createElement("option"); o.value = v; o.textContent = l; areaSel.appendChild(o);
      });
      areaSel.value = "office";

      folderSel = document.createElement("select");
      folderSel.className = "dest-select";
      const rebuildFolders = () => {
        folderSel.innerHTML = "";
        const root = document.createElement("option");
        root.value = "";
        root.textContent = "(main folder)";
        folderSel.appendChild(root);
        const subsIn = (projectFolderTree[areaSel.value] || []);
        for (const sf of subsIn) {
          const o = document.createElement("option");
          o.value = sf.name;
          o.textContent = "📁 " + sf.name;
          folderSel.appendChild(o);
        }
        const nf = document.createElement("option");
        nf.value = "__new__";
        nf.textContent = "➕ New folder…";
        folderSel.appendChild(nf);
        const su = subsIn.find(s => /sub[\s\-_]?uploads?/i.test(s.name));
        if (areaSel.value === "crew" && su) folderSel.value = su.name;
      };
      rebuildFolders();
      loadFolderTree().then(rebuildFolders);
      areaSel.addEventListener("change", rebuildFolders);
      folderSel.addEventListener("change", () => {
        if (folderSel.value === "__new__") {
          const name = prompt("New folder name:");
          if (name && name.trim()) {
            const o = document.createElement("option");
            o.value = name.trim();
            o.textContent = "📁 " + name.trim() + " (new)";
            folderSel.insertBefore(o, folderSel.lastChild);
            folderSel.value = name.trim();
          } else {
            folderSel.value = "";
          }
        }
      });
      bar.appendChild(areaSel);
      bar.appendChild(folderSel);
    }

    const hint = document.createElement("span");
    hint.className = "photos-hint";
    hint.textContent = uploadStatus || (isAdmin()
      ? "Pick a destination, then Add."
      : currentUser.role === "customer"
        ? "Files you add go straight to United Realty Repair."
        : "Pick your job photos — they upload straight to United Realty Repair.");

    const notifyRow = document.createElement("div");
    notifyRow.className = "album-perms notify-row";
    buildNotifyChips(notifyRow, "upload");

    input.addEventListener("change", () => uploadPhotos(input.files, btn, hint, {
      notify: pendingNotify.upload.slice(),
      destArea: areaSel ? areaSel.value : "crew",
      destFolderName: folderSel ? (folderSel.value === "__new__" ? "" : folderSel.value) : "",
      destAreaRoot: areaSel && folderSel && !folderSel.value
    }));

    bar.appendChild(btn);
    bar.appendChild(hint);
    bar.appendChild(input);
    list.appendChild(bar);
    if (isAdmin() && notifyRow.childNodes.length > 0) list.appendChild(notifyRow);
  }

  const files = visibleFiles().sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""));

  // ---------- Folder explorer ----------
  const path = navPathByTab[activeTab] || "";

  // Folders visible on this tab: those containing (recursively) files of this tab
  const tabFolders = photoFolders.filter((fo) => {
    if (activeTab === "Photos" && !canSeeAlbum(fo.id)) return false;
    if (fo.isSubUploads && activeTab === "Photos") return true;
    return files.some((f) => f.albumName === fo.name || (f.albumName || "").indexOf(fo.name + " / ") === 0);
  });

  const countIn = (fo) => files.filter((f) => f.albumName === fo.name || (f.albumName || "").indexOf(fo.name + " / ") === 0).length;
  const parentOf = (name) => {
    const i = name.lastIndexOf(" / ");
    return i === -1 ? "" : name.slice(0, i);
  };
  const lastSeg = (name) => {
    const i = name.lastIndexOf(" / ");
    return i === -1 ? name : name.slice(i + 3);
  };

  // Breadcrumb
  if (path) {
    const crumb = document.createElement("div");
    crumb.className = "crumb-bar";
    const home = document.createElement("button");
    home.className = "crumb";
    home.textContent = activeTab;
    home.addEventListener("click", () => { navPathByTab[activeTab] = ""; render(); });
    crumb.appendChild(home);
    const segs = path.split(" / ");
    let acc = "";
    segs.forEach((seg, i) => {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      crumb.appendChild(sep);
      acc = acc ? acc + " / " + seg : seg;
      const b = document.createElement("button");
      b.className = "crumb" + (i === segs.length - 1 ? " current" : "");
      b.textContent = seg;
      const target = acc;
      b.addEventListener("click", () => { navPathByTab[activeTab] = target; render(); });
      crumb.appendChild(b);
    });
    list.appendChild(crumb);
  }

  // Admin chips for whichever folder is open (all tabs)
  if (path && isAdmin()) {
    const fo = photoFolders.find((x) => x.name === path);
    if (fo) {
      const perms = document.createElement("div");
      perms.className = "album-perms crumb-perms";
      const lbl = document.createElement("span");
      lbl.className = "album-perms-label";
      const allowed = folderPerms[fo.id] || [];
      lbl.textContent = allowed.length === 0 ? "Visible to everyone in this folder — limit to:" : "Limited to:";
      perms.appendChild(lbl);
      const audience = fo.source === "customer" ? "customer" : fo.source === "crew" ? "sub" : null;
      for (const u of projectMembers().filter((m) => !audience || m.role === audience)) {
        const on = allowed.includes(u.email);
        const chip = document.createElement("button");
        chip.className = "perm-chip" + (on ? " on" : "");
        chip.textContent = (on ? "✓ " : "") + u.email + " (" + u.role + ")";
        chip.addEventListener("click", async () => {
          let list2 = folderPerms[fo.id] || [];
          list2 = on ? list2.filter((x) => x !== u.email) : list2.concat([u.email]);
          folderPerms[fo.id] = list2;
          await saveFolderPerms();
          render();
        });
        perms.appendChild(chip);
      }
      list.appendChild(perms);
    }
  }

  // Folder tiles at this level
  const children = tabFolders
    .filter((fo) => parentOf(fo.name) === path)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const fo of children) {
    const tile = document.createElement("button");
    tile.className = "folder-tile";
    const n = countIn(fo);
    tile.innerHTML = "";
    const ic = document.createElement("div");
    ic.className = "folder-tile-icon";
    ic.textContent = "📁";
    const nm = document.createElement("div");
    nm.className = "folder-tile-name";
    nm.textContent = lastSeg(fo.name);
    const ct = document.createElement("div");
    ct.className = "folder-tile-count";
    ct.textContent = n + (n === 1 ? " item" : " items");
    tile.appendChild(ic);
    tile.appendChild(nm);
    tile.appendChild(ct);
    tile.addEventListener("click", () => { navPathByTab[activeTab] = fo.name; render(); });
    list.appendChild(tile);
  }

  // Files at this level
  const here = files.filter((f) => (f.albumName || "") === path);
  for (const f of here) list.appendChild(fileCard(f));

  if (children.length === 0 && here.length === 0) {
    $("empty-msg").classList.remove("hidden");
  }
}

function canSeeAlbum(albumId) {
  if (isAdmin()) return true;
  const fo = photoFolders.find((x) => x.id === albumId);
  if (!fo) return false;
  // Subs always see the Sub Uploads folder so they can check their own uploads
  if (fo.isSubUploads && currentUser.role === "sub") return true;
  const allowed = folderPerms[albumId];
  // No chips set = the whole audience of that folder sees it.
  // Chips set = only those emails see it.
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(currentUser.email);
}

function projectMembers() {
  // everyone on this project except admins
  return (SESSION.members || []).filter((u) =>
    u.role !== "admin" &&
    (u.projects || []).includes(currentProject.name));
}

function visibleFiles() {
  return allFiles.filter((f) => {
    if (f.tab !== activeTab) return false;
    if (f.internal && !isAdmin()) return false;
    if (f.albumId) return canSeeAlbum(f.albumId);
    return true;
  });
}

function isImage(f) {
  return (f.mimeType || "").startsWith("image/") || /\.(jpe?g|png|gif|heic|webp)$/i.test(f.name);
}

function thumbUrl(f, size) {
  return "https://drive.google.com/thumbnail?id=" + encodeURIComponent(f.id) + "&sz=w" + (size || 400);
}

function fileCard(f) {
  const a = document.createElement("a");
  a.className = "file-card";
  a.href = f.webViewLink || "#";
  a.target = "_blank";
  a.rel = "noopener";

  a.addEventListener("click", (e) => {
    e.preventDefault();
    openLightboxGallery(f);
  });
  if (isAdmin()) {
    const del = document.createElement("button");
    del.className = "file-del";
    del.title = "Delete file";
    del.textContent = "🗑";
    del.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm("Delete \"" + f.name + "\"? It goes to Drive's trash.")) return;
      del.disabled = true;
      try {
        const out = await api({ action: "deleteFile", email: SESSION.email, code: SESSION.code, fileId: f.id });
        if (!out.ok) throw new Error(out.error || "failed");
        allFiles = allFiles.filter((x) => x.id !== f.id);
        render();
      } catch (err) {
        alert("Couldn't delete: " + err.message);
        del.disabled = false;
      }
    });
    a.appendChild(del);
  }

  if (isImage(f)) {
    const img = document.createElement("img");
    img.className = "file-thumb";
    img.src = thumbUrl(f, 400);
    img.alt = f.name;
    img.loading = "lazy";
    img.onerror = () => {
      img.remove();
      const ic = document.createElement("div");
      ic.className = "file-icon";
      ic.textContent = "🖼️";
      a.prepend(ic);
    };
    a.appendChild(img);
  } else {
    const ic = document.createElement("div");
    ic.className = "file-icon";
    ic.textContent = iconFor(f);
    a.appendChild(ic);
  }

  const name = document.createElement("div");
  name.className = "file-name";
  name.textContent = f.name;
  a.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "file-meta";
  const d = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : "";
  meta.textContent = d + (f.internal ? "  ·  INTERNAL" : "");
  a.appendChild(meta);

  return a;
}

function iconFor(f) {
  const m = f.mimeType || "";
  if (m.includes("pdf")) return "📄";
  if (m.includes("spreadsheet") || /\.xlsx?$/.test(f.name)) return "📊";
  if (m.includes("document") || /\.docx?$/.test(f.name)) return "📝";
  if (m.includes("folder")) return "📁";
  if (m.startsWith("image/")) return "🖼️";
  return "📎";
}

// ---------- Overview ----------
function taskStatus(t) {
  if (t.status) return t.status;
  const today = ymd(new Date());
  if (t.end < today) return "complete";
  if (t.start <= today && today <= t.end) return "in-progress";
  return "scheduled";
}

function renderOverview() {
  renderPresence();
  const today = ymd(new Date());

  // Progress
  const total = schedule.length;
  const done = schedule.filter((t) => taskStatus(t) === "complete").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("ov-progress-pct").textContent = pct + "%";
  $("ov-progress-fill").style.width = pct + "%";
  $("ov-progress-detail").textContent = total
    ? done + " of " + total + " scheduled trades complete"
    : "No trades scheduled yet";

  // Budget
  const bTotal = budget.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const bPaid = budget.reduce((s, b) => s + (Number(b.paid) || 0), 0);
  $("ov-budget-total").textContent = fmtMoney(bTotal);
  $("ov-budget-detail").textContent = budget.length
    ? fmtMoney(bPaid) + " paid · " + fmtMoney(bTotal - bPaid) + " remaining"
    : "No budget entered yet";
  $("ov-budget-fill").style.width = (bTotal ? Math.min(100, (bPaid / bTotal) * 100) : 0) + "%";

  // Happening now / up next
  const now = schedule.filter((t) => taskStatus(t) === "in-progress");
  const next = schedule
    .filter((t) => taskStatus(t) === "scheduled")
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 3);

  $("ov-now").innerHTML = "";
  if (now.length === 0) {
    $("ov-now").appendChild(ovEmpty("Nothing in progress today"));
  } else {
    for (const t of now) $("ov-now").appendChild(ovTask(t, "now"));
  }

  $("ov-next").innerHTML = "";
  if (next.length === 0) {
    $("ov-next").appendChild(ovEmpty("Nothing scheduled ahead"));
  } else {
    for (const t of next) $("ov-next").appendChild(ovTask(t, "next"));
  }

  // Latest log (respect internal flag)
  const vis = logs.filter((l) => !l.internal || isAdmin()).sort((a, b) => b.date.localeCompare(a.date));
  const latest = vis[0];
  const logEl = $("ov-latest-log");
  logEl.innerHTML = "";
  if (!latest) {
    logEl.appendChild(ovEmpty("No updates posted yet"));
  } else {
    const d = document.createElement("div");
    d.className = "ov-log-date";
    d.textContent = fmtDate(latest.date);
    const n = document.createElement("div");
    n.className = "ov-log-notes";
    n.textContent = latest.notes;
    logEl.appendChild(d);
    logEl.appendChild(n);
  }

  // Recent files (respect role tabs + internal)
  const myTabs = ROLE_ACCESS[SESSION.role] || [];
  const recent = allFiles
    .filter((f) => myTabs.includes(f.tab) && (!f.internal || isAdmin()))
    .sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""))
    .slice(0, 5);
  const rf = $("ov-recent-files");
  rf.innerHTML = "";
  if (recent.length === 0) {
    rf.appendChild(ovEmpty("No files yet"));
  } else {
    for (const f of recent) {
      const a = document.createElement("a");
      a.className = "ov-file-row";
      a.href = f.webViewLink || "#";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = iconFor(f) + "  " + f.name;
      rf.appendChild(a);
    }
  }
}

function ovEmpty(msg) {
  const d = document.createElement("div");
  d.className = "ov-empty";
  d.textContent = msg;
  return d;
}

function ovTask(t, kind) {
  const d = document.createElement("div");
  d.className = "ov-task " + kind;
  const trade = document.createElement("div");
  trade.className = "ov-task-trade";
  trade.textContent = t.trade;
  const meta = document.createElement("div");
  meta.className = "ov-task-meta";
  meta.textContent = fmtDate(t.start) + (t.end !== t.start ? " → " + fmtDate(t.end) : "") + (t.sub ? " · " + subLabel(t.sub) : "");
  d.appendChild(trade);
  d.appendChild(meta);
  return d;
}

// ---------- Calendar ----------
function ymd(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function adminTooltipNotes(t) {
  if (!isAdmin()) return "";
  const lines = [];
  if (t.customerNote) lines.push("To customer: " + t.customerNote);
  if (t.subNote) lines.push("To sub: " + t.subNote);
  if (t.adminNote) lines.push("Private: " + t.adminNote);
  return lines.length ? "\n" + lines.join("\n") : "";
}

function noteForCurrentUser(t) {
  if (currentUser.role === "customer") return t.customerNote || "";
  if (currentUser.role === "sub") return t.subNote || "";
  return "";
}

function subLabel(subId) {
  const s = subs.find((x) => x.id === subId);
  if (s) return s.company || s.name;
  return subId; // legacy free-text value
}

function renderCalendar() {
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  $("cal-month-label").textContent = calMonth.toLocaleString("en-US", { month: "long", year: "numeric" });

  const grid = $("cal-grid");
  grid.innerHTML = "";

  const firstDay = new Date(y, m, 1);
  const startOffset = firstDay.getDay();
  const gridStart = new Date(y, m, 1 - startOffset);
  const todayStr = ymd(new Date());

  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const dStr = ymd(d);
    const cell = document.createElement("div");
    cell.className = "cal-day" + (d.getMonth() !== m ? " other-month" : "") + (dStr === todayStr ? " today" : "");

    const num = document.createElement("div");
    num.className = "cal-day-num";
    num.textContent = d.getDate();
    cell.appendChild(num);

    for (const t of schedule) {
      if (dStr >= t.start && dStr <= t.end) {
        const st = taskStatus(t);
        const ev = document.createElement("div");
        ev.className = "cal-event" + (dStr !== t.start ? " continues" : "") + (st === "complete" ? " done" : "");
        ev.textContent = t.trade + (t.sub ? " · " + subLabel(t.sub) : "");
        ev.title = t.trade + (t.sub ? " — " + subLabel(t.sub) : "") + adminTooltipNotes(t);
        ev.addEventListener("click", () => isAdmin() ? openTaskModal(t.id) : openTaskView(t.id));
        cell.appendChild(ev);
      }
    }
    grid.appendChild(cell);
  }
}

function renderUpcoming() {
  const wrap = $("upcoming-list");
  wrap.innerHTML = "";
  const sorted = [...schedule].sort((a, b) => a.start.localeCompare(b.start));
  for (const t of sorted) {
    const item = document.createElement("div");
    item.className = "upcoming-item";
    const st = taskStatus(t);

    const left = document.createElement("div");
    const trade = document.createElement("div");
    trade.className = "upcoming-trade";
    trade.textContent = t.trade;
    const dates = document.createElement("div");
    dates.className = "upcoming-dates";
    dates.textContent = fmtDate(t.start) + (t.end !== t.start ? " → " + fmtDate(t.end) : "");
    left.appendChild(trade);
    left.appendChild(dates);
    item.appendChild(left);

    const badge = document.createElement("span");
    badge.className = "status-badge " + st;
    badge.textContent = st === "in-progress" ? "In Progress" : st === "complete" ? "Complete" : "Scheduled";
    item.appendChild(badge);

    const sub = document.createElement("span");
    sub.className = "upcoming-sub";
    sub.textContent = t.sub ? subLabel(t.sub) : "Not assigned";
    item.appendChild(sub);

    if (isAdmin()) {
      const preview = [];
      if (t.customerNote) preview.push("Customer: " + t.customerNote);
      if (t.subNote) preview.push("Sub: " + t.subNote);
      if (t.adminNote) preview.push("Private: " + t.adminNote);
      if (preview.length) {
        const notes = document.createElement("div");
        notes.className = "upcoming-notes";
        notes.textContent = preview.join("  ·  ");
        item.appendChild(notes);
      }
    } else {
      const mine = noteForCurrentUser(t);
      if (mine) {
        const notes = document.createElement("div");
        notes.className = "upcoming-notes";
        notes.textContent = mine;
        item.appendChild(notes);
      }
    }

    item.addEventListener("click", () => isAdmin() ? openTaskModal(t.id) : openTaskView(t.id));
    wrap.appendChild(item);
  }
}

function openTaskView(taskId) {
  const t = schedule.find((x) => x.id === taskId);
  if (!t) return;
  const st = taskStatus(t);
  $("tv-trade").textContent = t.trade;
  $("tv-dates").textContent = "📅 " + fmtDate(t.start) + (t.end !== t.start ? " → " + fmtDate(t.end) : "");
  $("tv-sub").textContent = "👷 " + (t.sub ? subLabel(t.sub) : "Crew not assigned yet");
  const badge = $("tv-status");
  badge.className = "status-badge " + st;
  badge.textContent = st === "in-progress" ? "In Progress" : st === "complete" ? "Complete" : "Scheduled";
  const mine = noteForCurrentUser(t);
  $("tv-note-row").classList.toggle("hidden", !mine);
  $("tv-note-text").textContent = mine;
  $("task-view-modal").classList.remove("hidden");
}

function fmtDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------- Task modal ----------
function fillTradeDropdown(selectEl) {
  selectEl.innerHTML = "";
  for (const t of TRADES) {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = t;
    selectEl.appendChild(o);
  }
}

function fillSubDropdown() {
  const sel = $("task-sub");
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Not assigned yet";
  sel.appendChild(none);
  for (const s of subs) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = (s.company || s.name) + (s.trade ? " — " + s.trade : "");
    sel.appendChild(o);
  }
}

function openTaskModal(taskId) {
  editingTaskId = taskId || null;
  fillTradeDropdown($("task-trade"));
  fillSubDropdown();
  const t = taskId ? schedule.find((x) => x.id === taskId) : null;
  $("task-modal-title").textContent = t ? "Edit Scheduled Trade" : "Schedule a Trade";
  $("task-trade").value = t ? t.trade : TRADES[0];
  $("task-sub").value = t ? (t.sub || "") : "";
  const tn = $("task-notify");
  if (tn) buildNotifyChips(tn, "task");
  $("task-start").value = t ? t.start : ymd(new Date());
  $("task-end").value = t ? t.end : ymd(new Date());
  $("task-status").value = t ? (t.status || taskStatus(t)) : "scheduled";
  $("task-note-customer").value = t ? (t.customerNote || "") : "";
  $("task-note-sub").value = t ? (t.subNote || "") : "";
  $("task-note-admin").value = t ? (t.adminNote || t.notes || "") : "";
  $("task-delete").classList.toggle("hidden", !t);
  $("task-modal").classList.remove("hidden");
}

async function saveTask() {
  const start = $("task-start").value;
  let end = $("task-end").value;
  if (!start) return;
  if (!end || end < start) end = start;

  const data = {
    trade: $("task-trade").value,
    sub: $("task-sub").value,
    start, end,
    status: $("task-status").value,
    customerNote: $("task-note-customer").value.trim(),
    subNote: $("task-note-sub").value.trim(),
    adminNote: $("task-note-admin").value.trim()
  };

  if (editingTaskId) {
    const i = schedule.findIndex((x) => x.id === editingTaskId);
    if (i >= 0) schedule[i] = { ...schedule[i], ...data };
  } else {
    schedule.push({ id: "t" + Date.now(), ...data });
  }
  await saveSchedule();
  closeModal("task-modal");
  render();
}

async function deleteTask() {
  schedule = schedule.filter((x) => x.id !== editingTaskId);
  await saveSchedule();
  closeModal("task-modal");
  render();
}

// ---------- Budget ----------
function renderBudget() {
  const admin = isAdmin();
  $("add-budget-btn").classList.toggle("hidden", !admin);

  const total = budget.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const paid = budget.reduce((s, b) => s + (Number(b.paid) || 0), 0);
  $("bs-total").textContent = fmtMoney(total);
  $("bs-paid").textContent = fmtMoney(paid);
  $("bs-remaining").textContent = fmtMoney(total - paid);
  $("budget-fill").style.width = (total ? Math.min(100, (paid / total) * 100) : 0) + "%";

  const list = $("budget-list");
  list.innerHTML = "";
  $("budget-empty").classList.toggle("hidden", budget.length > 0);

  for (const b of budget) {
    const row = document.createElement("div");
    row.className = "budget-row";

    const left = document.createElement("div");
    left.className = "budget-left";
    const desc = document.createElement("div");
    desc.className = "budget-desc";
    desc.textContent = b.desc;
    const cat = document.createElement("div");
    cat.className = "budget-cat";
    cat.textContent = b.cat;
    left.appendChild(desc);
    left.appendChild(cat);
    row.appendChild(left);

    const amounts = document.createElement("div");
    amounts.className = "budget-amounts";
    const amt = document.createElement("div");
    amt.className = "budget-amt";
    amt.textContent = fmtMoney(b.amount);
    const paidEl = document.createElement("div");
    paidEl.className = "budget-paid" + ((Number(b.paid) || 0) >= (Number(b.amount) || 0) && Number(b.amount) > 0 ? " full" : "");
    paidEl.textContent = fmtMoney(b.paid) + " paid";
    amounts.appendChild(amt);
    amounts.appendChild(paidEl);
    row.appendChild(amounts);

    if (admin) row.addEventListener("click", () => openBudgetModal(b.id));
    list.appendChild(row);
  }
}

function fillCatDropdown() {
  const sel = $("budget-cat");
  sel.innerHTML = "";
  for (const c of BUDGET_CATEGORIES) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  }
}

function openBudgetModal(id) {
  editingBudgetId = id || null;
  fillCatDropdown();
  const b = id ? budget.find((x) => x.id === id) : null;
  $("budget-modal-title").textContent = b ? "Edit Line Item" : "Add Line Item";
  $("budget-desc").value = b ? b.desc : "";
  $("budget-cat").value = b ? b.cat : BUDGET_CATEGORIES[0];
  $("budget-amount").value = b ? b.amount : "";
  $("budget-paid").value = b ? b.paid : "";
  $("budget-delete").classList.toggle("hidden", !b);
  $("budget-modal").classList.remove("hidden");
}

async function saveBudgetItem() {
  const desc = $("budget-desc").value.trim();
  if (!desc) return;
  const data = {
    desc,
    cat: $("budget-cat").value,
    amount: Number($("budget-amount").value) || 0,
    paid: Number($("budget-paid").value) || 0
  };
  if (editingBudgetId) {
    const i = budget.findIndex((x) => x.id === editingBudgetId);
    if (i >= 0) budget[i] = { ...budget[i], ...data };
  } else {
    budget.push({ id: "b" + Date.now(), ...data });
  }
  await saveBudget();
  closeModal("budget-modal");
  render();
}

async function deleteBudgetItem() {
  budget = budget.filter((x) => x.id !== editingBudgetId);
  await saveBudget();
  closeModal("budget-modal");
  render();
}

// ---------- Daily Logs ----------
function canWriteLogs() { return isAdmin() || currentUser.role === "sub"; }
function canEditLog(l) { return isAdmin() || (l.author && l.author === currentUser.email); }

function renderLogs() {
  $("add-log-btn").classList.toggle("hidden", !canWriteLogs());

  const visible = logs
    .filter((l) => !l.internal || isAdmin())
    .sort((a, b) => b.date.localeCompare(a.date));

  const list = $("logs-list");
  list.innerHTML = "";
  $("logs-empty").classList.toggle("hidden", visible.length > 0);

  for (const l of visible) {
    const card = document.createElement("div");
    card.className = "log-card" + (l.internal ? " internal" : "");

    const head = document.createElement("div");
    head.className = "log-head";
    const date = document.createElement("div");
    date.className = "log-date";
    date.textContent = fmtDateLong(l.date);
    head.appendChild(date);
    if (l.internal) {
      const tag = document.createElement("span");
      tag.className = "internal-tag";
      tag.textContent = "INTERNAL";
      head.appendChild(tag);
    }
    card.appendChild(head);

    if (l.weather || l.crew) {
      const meta = document.createElement("div");
      meta.className = "log-meta";
      meta.textContent = [l.weather, l.crew].filter(Boolean).join("  ·  ");
      card.appendChild(meta);
    }

    const notes = document.createElement("div");
    notes.className = "log-notes";
    notes.textContent = l.notes;
    card.appendChild(notes);

    if (l.photos && l.photos.length) {
      const strip = document.createElement("div");
      strip.className = "log-photo-strip";
      for (const pid of l.photos) {
        const img = document.createElement("img");
        img.src = "https://drive.google.com/thumbnail?id=" + encodeURIComponent(pid) + "&sz=w200";
        img.loading = "lazy";
        img.addEventListener("click", (e) => {
          e.stopPropagation();
          openLightbox({ id: pid, name: "Log photo — " + fmtDateLong(l.date), mimeType: "image/jpeg" });
        });
        strip.appendChild(img);
      }
      card.appendChild(strip);
    }

    if (l.author) {
      const by = document.createElement("div");
      by.className = "log-author";
      by.textContent = "Posted by " + authorLabel(l.author);
      card.appendChild(by);
    }

    if (canEditLog(l)) card.addEventListener("click", () => openLogModal(l.id));
    list.appendChild(card);
  }
}

function fmtDateLong(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function authorLabel(email) {
  if (email === currentUser.email) return "you";
  if ((email || "").toLowerCase() === "info@unitedrealtyrepair.com") return "United Realty Repair";
  const s = subs.find((x) => (x.email || "").toLowerCase() === (email || "").toLowerCase());
  if (s) return s.company || s.name;
  return email;
}

function openLogModal(id) {
  editingLogId = id || null;
  const l = id ? logs.find((x) => x.id === id) : null;
  $("log-modal-title").textContent = l ? "Edit Log Entry" : "Add Log Entry";
  const ln = $("log-notify");
  if (ln) buildNotifyChips(ln, "log");
  $("log-date").value = l ? l.date : ymd(new Date());
  $("log-weather").value = l ? (l.weather || "") : "";
  $("log-crew").value = l ? (l.crew || "") : "";
  $("log-notes").value = l ? l.notes : "";
  $("log-internal").checked = l ? !!l.internal : false;
  $("log-internal").closest("label").classList.toggle("hidden", !isAdmin());
  $("log-photos").value = "";
  $("log-photo-status").textContent = "";
  renderLogPhotoPreviews(l ? (l.photos || []) : []);
  $("log-delete").classList.toggle("hidden", !(l && canEditLog(l)));
  $("log-modal").classList.remove("hidden");
}

function renderLogPhotoPreviews(ids) {
  const wrap = $("log-photo-previews");
  wrap.innerHTML = "";
  for (const id of ids) {
    const img = document.createElement("img");
    img.src = "https://drive.google.com/thumbnail?id=" + encodeURIComponent(id) + "&sz=w120";
    wrap.appendChild(img);
  }
}

async function saveLog() {
  const notes = $("log-notes").value.trim();
  const date = $("log-date").value;
  if (!notes || !date) return;

  // Upload any attached photos first
  const existing = editingLogId ? ((logs.find((x) => x.id === editingLogId) || {}).photos || []) : [];
  const photoIds = [...existing];
  const files = Array.from($("log-photos").files || []);
  if (files.length) {
    const internal = isAdmin() && $("log-internal").checked;
    $("log-save").disabled = true;
    let n = 0;
    for (const file of files) {
      n++;
      $("log-photo-status").textContent = "Uploading photo " + n + " of " + files.length + "…";
      try {
        const out = await uploadOne(file, {
          destArea: internal ? "office" : "crew",
          destFolderName: "Log Photos"
        });
        if (out.ok && out.fileId) photoIds.push(out.fileId);
      } catch (e) { console.warn("log photo failed", e); }
    }
    $("log-save").disabled = false;
    $("log-photo-status").textContent = "";
  }

  const data = {
    photos: photoIds,
    date,
    weather: $("log-weather").value.trim(),
    crew: $("log-crew").value.trim(),
    notes,
    internal: isAdmin() ? $("log-internal").checked : false
  };
  if (editingLogId) {
    const i = logs.findIndex((x) => x.id === editingLogId);
    if (i >= 0 && canEditLog(logs[i])) logs[i] = { ...logs[i], ...data };
  } else {
    logs.push({ id: "l" + Date.now(), author: currentUser.email, ...data });
  }
  await saveLogs();
  closeModal("log-modal");
  render();
}

async function deleteLog() {
  const l = logs.find((x) => x.id === editingLogId);
  if (l && !canEditLog(l)) return;
  logs = logs.filter((x) => x.id !== editingLogId);
  await saveLogs();
  closeModal("log-modal");
  render();
}

// ---------- Invoices (sub → admin office only) ----------
function renderInvoices() {
  const isSub = currentUser.role === "sub";
  $("inv-form").classList.toggle("hidden", !isSub);
  $("inv-title").textContent = isSub ? "Submit an Invoice" : "Invoices Submitted by Subs";

  const list = $("inv-list");
  list.innerHTML = "";
  const sorted = invoices.slice().sort((a, b) => (b.t || "").localeCompare(a.t || ""));
  $("inv-empty").classList.toggle("hidden", sorted.length > 0);
  $("inv-empty").textContent = isSub
    ? "No invoices submitted yet. Your submissions go straight to the URR office — the customer and other subs never see them."
    : "No sub invoices submitted yet.";

  for (const inv of sorted) {
    const card = document.createElement("div");
    card.className = "log-card inv-card";

    const head = document.createElement("div");
    head.className = "log-head";
    const title = document.createElement("div");
    title.className = "log-date";
    title.textContent = (inv.number ? "Invoice #" + inv.number : (inv.fileName || "Invoice"));
    head.appendChild(title);
    const badge = document.createElement("span");
    badge.className = "status-badge " + (inv.status === "paid" ? "complete" : "scheduled");
    badge.textContent = inv.status === "paid" ? "Paid" : "Submitted";
    head.appendChild(badge);
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "log-meta";
    const when = inv.t ? new Date(inv.t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    meta.textContent = [
      isAdmin() ? authorLabel(inv.sub) : null,
      when,
      inv.amount ? fmtMoney(inv.amount) : null
    ].filter(Boolean).join("  ·  ");
    card.appendChild(meta);

    if (inv.notes) {
      const notes = document.createElement("div");
      notes.className = "log-notes";
      notes.textContent = inv.notes;
      card.appendChild(notes);
    }

    if (isAdmin()) {
      const row = document.createElement("div");
      row.className = "inv-actions";
      const open = document.createElement("a");
      open.className = "btn-ghost inv-btn";
      open.textContent = "Open file ↗";
      open.href = "https://drive.google.com/file/d/" + encodeURIComponent(inv.fileId) + "/view";
      open.target = "_blank";
      open.rel = "noopener";
      row.appendChild(open);
      const toggle = document.createElement("button");
      toggle.className = "btn-primary inv-btn";
      toggle.textContent = inv.status === "paid" ? "Mark unpaid" : "Mark paid";
      toggle.addEventListener("click", () => invoiceAction(inv, { status: inv.status === "paid" ? "submitted" : "paid" }));
      row.appendChild(toggle);
      const del = document.createElement("button");
      del.className = "btn-danger inv-btn";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        if (confirm("Delete this invoice and trash its file?")) invoiceAction(inv, { remove: true });
      });
      row.appendChild(del);
      card.appendChild(row);
    }
    list.appendChild(card);
  }
}

async function invoiceAction(inv, payload) {
  try {
    const out = await api({ action: "invoiceUpdate", email: SESSION.email, code: SESSION.code, project: currentProject.name, invId: inv.id, ...payload });
    if (out.ok && out.invoices) { invoices = out.invoices; render(); }
  } catch (e) { console.warn("invoice update failed", e); }
}

async function submitInvoice() {
  const file = ($("inv-file").files || [])[0];
  const status = $("inv-status");
  if (!file) { status.textContent = "Attach your invoice file (PDF or photo) first."; return; }
  const btn = $("inv-submit");
  btn.disabled = true;
  status.textContent = "Sending to the URR office…";
  try {
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = () => rej(new Error("read failed"));
      r.readAsDataURL(file);
    });
    const out = await api({
      action: "submitInvoice",
      email: SESSION.email,
      code: SESSION.code,
      project: currentProject.name,
      filename: file.name,
      mimeType: file.type,
      data: b64,
      number: $("inv-number").value.trim(),
      amount: parseFloat($("inv-amount").value) || 0,
      notes: $("inv-notes").value.trim()
    });
    if (!out.ok) throw new Error(out.error || "submit failed");
    invoices.unshift(out.invoice);
    $("inv-number").value = "";
    $("inv-amount").value = "";
    $("inv-notes").value = "";
    $("inv-file").value = "";
    status.textContent = "✓ Invoice sent to the URR office.";
    render();
    $("inv-status").textContent = "✓ Invoice sent to the URR office.";
  } catch (e) {
    status.textContent = "✗ " + (e.message || "submit failed");
  }
  btn.disabled = false;
}

// ---------- Subs ----------
function renderSubs() {
  const list = $("subs-list");
  list.innerHTML = "";
  $("subs-empty").classList.toggle("hidden", subs.length > 0);

  const sorted = [...subs].sort((a, b) => (a.trade || "").localeCompare(b.trade || ""));
  for (const s of sorted) {
    const card = document.createElement("div");
    card.className = "sub-card";

    const head = document.createElement("div");
    head.className = "sub-head";
    const name = document.createElement("div");
    name.className = "sub-name";
    name.textContent = s.company || s.name;
    head.appendChild(name);
    const trade = document.createElement("span");
    trade.className = "sub-trade";
    trade.textContent = s.trade;
    head.appendChild(trade);
    card.appendChild(head);

    if (s.company && s.name) {
      const contact = document.createElement("div");
      contact.className = "sub-contact-name";
      contact.textContent = s.name;
      card.appendChild(contact);
    }

    const lines = document.createElement("div");
    lines.className = "sub-lines";
    if (s.phone) lines.appendChild(subLine("📞", s.phone, "tel:" + s.phone.replace(/[^\d+]/g, "")));
    if (s.email) lines.appendChild(subLine("✉️", s.email, "mailto:" + s.email));
    if (s.notes) lines.appendChild(subLine("📝", s.notes, null));
    card.appendChild(lines);

    card.addEventListener("click", (e) => {
      if (e.target.tagName === "A") return;
      openSubModal(s.id);
    });
    list.appendChild(card);
  }
}

function subLine(icon, text, href) {
  const d = document.createElement("div");
  d.className = "sub-line";
  if (href) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = icon + " " + text;
    d.appendChild(a);
  } else {
    d.textContent = icon + " " + text;
  }
  return d;
}

function openSubModal(id) {
  editingSubId = id || null;
  fillTradeDropdown($("sub-trade"));
  const s = id ? subs.find((x) => x.id === id) : null;
  $("sub-modal-title").textContent = s ? "Edit Subcontractor" : "Add Subcontractor";
  $("sub-name").value = s ? (s.name || "") : "";
  $("sub-company").value = s ? (s.company || "") : "";
  $("sub-trade").value = s ? (s.trade || TRADES[0]) : TRADES[0];
  $("sub-phone").value = s ? (s.phone || "") : "";
  $("sub-email").value = s ? (s.email || "") : "";
  $("sub-notes").value = s ? (s.notes || "") : "";
  $("sub-delete").classList.toggle("hidden", !s);
  $("sub-modal").classList.remove("hidden");
}

async function saveSub() {
  const name = $("sub-name").value.trim();
  const company = $("sub-company").value.trim();
  if (!name && !company) return;
  const data = {
    name, company,
    trade: $("sub-trade").value,
    phone: $("sub-phone").value.trim(),
    email: $("sub-email").value.trim(),
    notes: $("sub-notes").value.trim()
  };
  if (editingSubId) {
    const i = subs.findIndex((x) => x.id === editingSubId);
    if (i >= 0) subs[i] = { ...subs[i], ...data };
  } else {
    subs.push({ id: "s" + Date.now(), ...data });
  }
  await saveSubs();
  closeModal("sub-modal");
  render();
}

async function deleteSub() {
  subs = subs.filter((x) => x.id !== editingSubId);
  await saveSubs();
  closeModal("sub-modal");
  render();
}

// ---------- Lightbox ----------
let lightboxList = [];
let lightboxIndex = -1;

function openLightboxGallery(f) {
  // Siblings = files in the same folder on the same tab, in display order
  const siblings = visibleFiles()
    .filter((x) => (x.albumName || "") === (f.albumName || ""))
    .sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""));
  lightboxList = siblings.length ? siblings : [f];
  lightboxIndex = Math.max(0, lightboxList.findIndex((x) => x.id === f.id));
  showLightboxAt(lightboxIndex);
}

function showLightboxAt(i) {
  if (lightboxList.length === 0) return;
  lightboxIndex = (i + lightboxList.length) % lightboxList.length;
  openLightbox(lightboxList[lightboxIndex]);
  const multi = lightboxList.length > 1;
  $("lightbox-prev").classList.toggle("hidden", !multi);
  $("lightbox-next").classList.toggle("hidden", !multi);
  const counter = $("lightbox-counter");
  counter.classList.toggle("hidden", !multi);
  counter.textContent = (lightboxIndex + 1) + " of " + lightboxList.length;
}

function openLightbox(f) {
  const img = $("lightbox-img");
  const frame = $("lightbox-frame");
  if (isImage(f)) {
    img.src = thumbUrl(f, 1600);
    img.classList.remove("hidden");
    frame.classList.add("hidden");
    frame.src = "";
  } else {
    frame.src = "https://drive.google.com/file/d/" + encodeURIComponent(f.id) + "/preview";
    frame.classList.remove("hidden");
    img.classList.add("hidden");
    img.src = "";
  }
  $("lightbox-name").textContent = f.name;
  const openBtn = $("lightbox-open");
  if (openBtn) {
    if (isAdmin()) {
      openBtn.classList.remove("hidden");
      openBtn.href = f.link || ("https://drive.google.com/file/d/" + f.id + "/view");
    } else {
      openBtn.classList.add("hidden");
    }
  }
  $("lightbox").classList.remove("hidden");
}
function closeLightbox() {
  lightboxList = [];
  lightboxIndex = -1;
  $("lightbox").classList.add("hidden");
  $("lightbox-img").src = "";
  $("lightbox-frame").src = "";
}

// ---------- Modal plumbing ----------
function closeModal(id) {
  $(id).classList.add("hidden");
  editingTaskId = editingBudgetId = editingLogId = editingSubId = null;
}

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", async () => {
  $("login-btn").addEventListener("click", doLogin);
  $("email-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("logout-btn").addEventListener("click", logout);
  $("refresh-btn").addEventListener("click", () => { loadState().then(render); loadFiles(); });

  // Calendar
  $("cal-prev").addEventListener("click", () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(); });
  $("cal-next").addEventListener("click", () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(); });
  $("cal-today").addEventListener("click", () => { calMonth = new Date(); renderCalendar(); });
  $("add-task-btn").addEventListener("click", () => openTaskModal(null));
  $("task-cancel").addEventListener("click", () => closeModal("task-modal"));
  $("task-save").addEventListener("click", saveTask);
  $("task-delete").addEventListener("click", deleteTask);

  // Budget
  $("add-budget-btn").addEventListener("click", () => openBudgetModal(null));
  $("budget-cancel").addEventListener("click", () => closeModal("budget-modal"));
  $("budget-save").addEventListener("click", saveBudgetItem);
  $("budget-delete").addEventListener("click", deleteBudgetItem);

  // Logs
  $("add-log-btn").addEventListener("click", () => openLogModal(null));
  $("log-cancel").addEventListener("click", () => closeModal("log-modal"));
  $("log-save").addEventListener("click", saveLog);
  $("log-delete").addEventListener("click", deleteLog);

  // Subs
  $("add-sub-btn").addEventListener("click", () => openSubModal(null));
  $("sub-cancel").addEventListener("click", () => closeModal("sub-modal"));
  $("sub-save").addEventListener("click", saveSub);
  $("sub-delete").addEventListener("click", deleteSub);

  $("tv-close").addEventListener("click", () => closeModal("task-view-modal"));

  $("lightbox-close").addEventListener("click", closeLightbox);
  const mbtn = $("msg-badge");
  if (mbtn) mbtn.addEventListener("click", () => {
    const pop = $("msg-pop");
    pop.classList.toggle("hidden");
    if (!pop.classList.contains("hidden")) { renderMsgPop(); markThreadRead(); }
  });
  const bbtn = $("bell-badge");
  if (bbtn) bbtn.addEventListener("click", () => {
    const pop = $("bell-pop");
    pop.classList.toggle("hidden");
    if (!pop.classList.contains("hidden")) {
      renderBellPop();
      localStorage.setItem(lastSeenActivityKey(), new Date().toISOString());
      renderBell();
    }
  });
  document.addEventListener("click", (e) => {
    for (const w of ["msg", "bell"]) {
      const pop = $(w + "-pop");
      if (pop && !pop.classList.contains("hidden") && !e.target.closest("." + w + "-wrap")) pop.classList.add("hidden");
    }
  });
  const pbtn = $("presence-badge");
  if (pbtn) pbtn.addEventListener("click", () => $("presence-pop").classList.toggle("hidden"));
  document.addEventListener("click", (e) => {
    const pop = $("presence-pop");
    if (pop && !pop.classList.contains("hidden") && !e.target.closest(".presence-wrap")) pop.classList.add("hidden");
  });
  $("lightbox-prev").addEventListener("click", () => showLightboxAt(lightboxIndex - 1));
  $("lightbox-next").addEventListener("click", () => showLightboxAt(lightboxIndex + 1));
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").classList.contains("hidden")) return;
    if (e.key === "ArrowLeft") showLightboxAt(lightboxIndex - 1);
    if (e.key === "ArrowRight") showLightboxAt(lightboxIndex + 1);
  });
  $("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

  // Click outside modal closes it
  for (const id of ["task-modal", "budget-modal", "log-modal", "sub-modal", "task-view-modal"]) {
    $(id).addEventListener("click", (e) => { if (e.target.id === id) closeModal(id); });
  }

  $("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

  $("inv-submit").addEventListener("click", submitInvoice);

  // Restore session for this browser tab
  try {
    const saved = JSON.parse(sessionStorage.getItem("urrSession"));
    if (saved && saved.email && saved.code) { SESSION = saved; enterPortal(null); }
  } catch (e) {}
});
