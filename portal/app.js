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

const COMPANY = {
  name: "United Realty Repair",
  address: "967 E Parkcenter Blvd #242",
  cityState: "Boise, Idaho",
  email: "info@unitedrealtyrepair.com",
  logo: "logo.png"
};

const ROLE_ACCESS = {
  admin:    ["Overview", "Schedule", "Budget", "Daily Logs", "Documents", "Photos", "Scans", "Invoices", "Change Orders", "Estimates", "Materials", "Subs", "Calc", "Codes", "Time"],
  customer: ["Overview", "Schedule", "Budget", "Daily Logs", "Documents", "Photos", "Invoices", "Change Orders", "Estimates"],
  sub:      ["Schedule", "Daily Logs", "Documents", "Photos", "Invoices", "Estimates", "Materials", "Codes"]
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
let estimates = [];     // [{id, number, title, date, status, taxRate, sections:[{id,name,items:[...]}], ...}]
let termsLibrary = [];  // [{id, name, body, default}] — admin-only contract templates
let custInvoices = [];  // customer invoices — memory only
let folderGrants = {};  // { folderId: [sub emails granted access] } — admin-only
let subBids = [];       // sub bid submissions — memory only
let calcAccess = [];    // emails granted the Field Calc tab — admin-managed
let timeEntries = [];   // admin time clock — {id, project, start, end, note, rate, costId}
let editingTimeId = null;
let costs = [];         // job costing entries — ADMIN ONLY, memory only
let editingCostId = null;
let editingEstId = null;
let estDraft = null;    // working copy while the builder modal is open
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
  estimates = remote[pkey("Estimates")] || []; // server pre-filters per role; memory only
  if (remote["urrTermsLibrary"]) termsLibrary = remote["urrTermsLibrary"];
  custInvoices = remote[pkey("CustInvoices")] || [];
  subBids = remote[pkey("SubEstimates")] || [];
  if (remote["urrCalcAccess"]) calcAccess = remote["urrCalcAccess"];
  if (remote["urrTimeClock"]) timeEntries = remote["urrTimeClock"];
  costs = remote[pkey("Costs")] || [];
  if (remote[pkey("FolderGrants")]) folderGrants = remote[pkey("FolderGrants")];
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
  estimates = [];
  custInvoices = [];
  subBids = [];
  costs = [];
  folderGrants = {};
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
async function saveEstimates()   { pushCollection(pkey("Estimates"), estimates); }
async function saveTermsLibrary() { pushCollection("urrTermsLibrary", termsLibrary); }
async function saveCalcAccess()  { pushCollection("urrCalcAccess", calcAccess); }
async function saveTimeEntries() { pushCollection("urrTimeClock", timeEntries); }
async function saveFolderGrants() { pushCollection(pkey("FolderGrants"), folderGrants); }
async function saveCosts()        { pushCollection(pkey("Costs"), costs); }

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
  // Folder wins over filename: everything inside a "Scans" folder is a scan,
  // whatever CubiCasa named the export.
  const album = String(file.albumName || "").toLowerCase();
  if (/(^|\/\s*)scans?(\s*\/|$)/.test(album) || /floor[\s\-_]?plan/.test(album)) {
    return { tab: "Scans", internal: isInternal };
  }
  if (/cubicasa|\bscan\b/.test(n) && !/scanned/.test(n)) {
    return { tab: "Scans", internal: isInternal };
  }
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
    SESSION = { email: out.email, code, role: out.role, projects: out.projects, apiKey: out.apiKey, members: out.members || [] };
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
    selectMode = false;
    selectedIds = new Set();
    subUploadsFolderId = null;
    schedule = []; budget = []; logs = []; folderPerms = {}; folderGrants = {};
    invoices = []; estimates = []; custInvoices = []; subBids = []; costs = [];
    buildTabs();
    render();       // swap the screen to the new project instantly
    loadFiles();    // start the (slow) Drive walk right away
    loadState(null).then(render);
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
  // Online first, then idle, then offline — each group alphabetical
  const rank = { online: 0, idle: 1, offline: 2 };
  const rows = roster.map((m) => {
    const rec = presenceRecFor(m.email);
    return { m, rec, st: presenceStatus(rec ? rec.t : null) };
  }).sort((a, b) => {
    const r = (rank[a.st.cls] ?? 3) - (rank[b.st.cls] ?? 3);
    return r !== 0 ? r : a.m.email.toLowerCase().localeCompare(b.m.email.toLowerCase());
  });

  let lastGroup = null;
  for (const { m, rec, st } of rows) {
    if (st.cls !== lastGroup) {
      lastGroup = st.cls;
      const h = document.createElement("div");
      h.className = "presence-group";
      h.textContent = st.cls === "online" ? "Online now" : st.cls === "idle" ? "Recently active" : "Offline";
      pop.appendChild(h);
    }
    const row = document.createElement("div");
    row.className = "presence-row";
    const dot = document.createElement("span");
    dot.className = "presence-dot " + st.cls;
    row.appendChild(dot);
    const info = document.createElement("div");
    info.className = "presence-info";
    const who = document.createElement("div");
    who.className = "presence-who";
    // name portion only, full address on hover — keeps rows to one line
    const at = m.email.indexOf("@");
    who.textContent = at > 0 ? m.email.slice(0, at) : m.email;
    who.title = m.email;
    const tag = document.createElement("span");
    tag.className = "presence-role " + (m.role === "sub" ? "sub" : "cust");
    tag.textContent = m.role === "sub" ? "SUB" : "CUSTOMER";
    who.appendChild(tag);
    const meta = document.createElement("div");
    meta.className = "presence-meta";
    const proj = rec && rec.project && st.cls !== "offline" ? shortProject(rec.project) : "";
    meta.textContent = st.cls === "online" ? (proj || "In the portal") : st.label + (proj ? " · " + proj : "");
    info.appendChild(who);
    info.appendChild(meta);
    row.appendChild(info);
    pop.appendChild(row);
  }
}

// "2426 State St Boise ID 83702" -> "2426 State St"
function shortProject(name) {
  const s = String(name || "").trim();
  const m = s.match(/^(.*?)(?:\s+Boise\b|\s+ID\b|,)/i);
  return (m ? m[1] : s).trim();
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
    if (isAdmin()) {
      const del = document.createElement("button");
      del.className = "msg-del";
      del.textContent = "🗑";
      del.title = "Remove this notification";
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        try {
          const out = await api({
            action: "deleteActivity", email: SESSION.email, code: SESSION.code, actId: a.id
          });
          if (out.ok) {
            activityList = activityList.filter((x) => x.id !== a.id);
            renderBellPop();
            renderBell();
          }
        } catch (err) { alert("Couldn't remove that notification."); }
      });
      row.appendChild(del);
    }
    pop.appendChild(row);
  }
  if (isAdmin() && activityList.length) {
    const clr = document.createElement("button");
    clr.className = "msg-clear-thread";
    clr.textContent = "🗑 Clear all notifications";
    clr.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("Clear all notifications?")) return;
      try {
        const out = await api({
          action: "deleteActivity", email: SESSION.email, code: SESSION.code, all: true
        });
        if (out.ok) { activityList = []; renderBellPop(); renderBell(); }
      } catch (err) { alert("Couldn't clear notifications."); }
    });
    pop.appendChild(clr);
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
    if (items.length) {
      const clr = document.createElement("button");
      clr.className = "msg-clear-thread";
      clr.textContent = "🗑 Clear this conversation";
      clr.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm("Delete ALL messages with " + msgTargetEmail + "?\n\nThis cannot be undone.")) return;
        try {
          const out = await api({
            action: "deleteMessage", email: SESSION.email, code: SESSION.code,
            with: msgTargetEmail, all: true
          });
          if (out.ok) {
            if (inboxThreads[msgTargetEmail]) inboxThreads[msgTargetEmail].items = [];
            renderMsgPop();
          }
        } catch (err) { alert("Couldn't clear the conversation."); }
      });
      pop.appendChild(clr);
    }
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
    if (isAdmin()) {
      // Admin can delete any message in the thread
      const del = document.createElement("button");
      del.className = "msg-del";
      del.textContent = "🗑";
      del.title = "Delete this message";
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm("Delete this message?\n\n\"" + m.text.slice(0, 80) + (m.text.length > 80 ? "…" : "") + "\"")) return;
        try {
          const out = await api({
            action: "deleteMessage", email: SESSION.email, code: SESSION.code,
            with: msgTargetEmail, msgId: m.id
          });
          if (out.ok) {
            if (inboxThreads[msgTargetEmail]) inboxThreads[msgTargetEmail].items = out.thread || [];
            renderMsgPop();
          }
        } catch (err) { alert("Couldn't delete that message."); }
      });
      wrap.appendChild(del);
    }
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
  const tabs = (ROLE_ACCESS[SESSION.role] || []).slice();
  // Field Calc: admins always; others only when explicitly granted
  if (!isAdmin() && calcAccess.indexOf(String(SESSION.email).toLowerCase()) !== -1
      && tabs.indexOf("Calc") === -1) {
    tabs.push("Calc");
  }
  const nav = $("tabs");
  nav.innerHTML = "";
  activeTab = tabs[0];
  tabs.forEach((t) => {
    const b = document.createElement("button");
    b.className = "tab" + (t === activeTab ? " active" : "");
    b.textContent = t;
    b.addEventListener("click", () => {
      activeTab = t;
      selectMode = false;
      selectedIds = new Set();
      if (t === "Subs") subFilesData = null;
      nav.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      render();
    });
    nav.appendChild(b);
  });
}

// ---------- Drive API ----------
let filesToken = 0;

async function loadFiles() {
  const token = ++filesToken;
  $("loading").classList.remove("hidden");
  $("api-error").classList.add("hidden");
  $("file-list").innerHTML = "";
  $("empty-msg").classList.add("hidden");

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = await api({ action: "files", email: SESSION.email, code: SESSION.code, project: currentProject.name });
      if (token !== filesToken) return; // user switched projects mid-flight — drop stale data
      if (!out.ok) throw new Error(out.error || "listing failed");
      ingestListing(out);
      $("loading").classList.add("hidden");
      render();
      return;
    } catch (err) {
      if (token !== filesToken) return;
      lastErr = err;
      console.warn("files attempt " + attempt + " failed:", err);
      await new Promise((r) => setTimeout(r, 1200 * attempt));
      if (token !== filesToken) return;
    }
  }
  if (token !== filesToken) return;
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
      // A Scans folder wins over everything — including images, since
      // CubiCasa exports floor plans as PNG/JPG.
      const albumLc = String(f.albumName || "").toLowerCase();
      if (/(^|\/\s*)scans?(\s*\/|$)/.test(albumLc) || /floor[\s\-_]?plan/.test(albumLc)) {
        return { ...f, tab: "Scans", internal: office };
      }
      // Images in a subfolder = photo album entry.
      // Documents in a subfolder = sorted into their normal tab.
      if (isImage(f)) return { ...f, tab: "Photos", internal: office };
      // Folder name wins: a file in a "...PERMIT..." folder is a Document,
      // even if its filename says "receipt".
      const folderCat = categorize({ name: f.albumName || "", mimeType: "" });
      const fileCat = categorize(f);
      const byFolder = /invoice|change[\s\-_]?order|estimate|proposal|bid|schedule|timeline|material|receipt|supply|permit|inspection|plan|contract|warranty|scope|spec|scan/.test((f.albumName || "").toLowerCase());
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
    "invoices-section": activeTab === "Invoices",
    "estimates-section": activeTab === "Estimates",
    "calc-section": activeTab === "Calc" &&
      (isAdmin() || calcAccess.indexOf(String(SESSION.email).toLowerCase()) !== -1),
    "codes-section": activeTab === "Codes",
    "time-section": activeTab === "Time" && isAdmin()
  };
  $("pl-card").classList.toggle("hidden", !(activeTab === "Budget" && isAdmin()));
  for (const [id, show] of Object.entries(sections)) {
    $(id).classList.toggle("hidden", !show);
  }

  // Admin keeps the invoice FILE view under the submitted-invoice panel
  const isFileTab = !Object.values(sections).some(Boolean)
    || (activeTab === "Invoices" && isAdmin())
    || activeTab === "Estimates";

  if (activeTab === "Overview") renderOverview();
  if (activeTab === "Schedule") {
    $("add-task-btn").classList.toggle("hidden", !isAdmin());
    renderCalendar();
    renderUpcoming();
  }
  if (activeTab === "Budget") { renderBudget(); renderPL(); }
  renderCostsPanel();
  renderScansPanel();
  if (activeTab === "Daily Logs") renderLogs();
  if (activeTab === "Subs") renderSubs();
  if (activeTab === "Invoices") renderInvoices();
  if (activeTab === "Estimates") renderEstimates();
  if (activeTab === "Calc") renderCalc();
  if (activeTab === "Codes") renderCodes();
  if (activeTab === "Time" && isAdmin()) renderTime();

  // File grid only on file tabs
  const list = $("file-list");
  list.innerHTML = "";
  $("empty-msg").classList.add("hidden");
  if (!isFileTab) return;

  // Photos tab: in-portal upload for subs & admin
  let uploadToolbar = null;
  if ((activeTab === "Photos" || activeTab === "Documents") && (isAdmin() || currentUser.role === "sub" || currentUser.role === "customer") && syncEnabled()) {
    const bar = document.createElement("div");
    bar.className = "photos-toolbar";
    uploadToolbar = bar;

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

  // Multi-select / ZIP controls — docked right of the upload toolbar when
  // one exists, otherwise their own row.
  const selBar = buildSelectBar(list, files.length);
  if (selBar) {
    if (uploadToolbar) {
      selBar.classList.add("select-bar-docked");
      uploadToolbar.appendChild(selBar);
    } else {
      list.appendChild(selBar);
    }
  }

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

      // GRANTS: share this folder (from any area) with specific SUBS —
      // e.g. give a glass bidder the PLANS folder on this project.
      const projSubs = projectMembers().filter((m) => m.role === "sub");
      if (projSubs.length && fo.source !== "crew") {
        const grants = document.createElement("div");
        grants.className = "album-perms crumb-perms grant-row";
        const glbl = document.createElement("span");
        glbl.className = "album-perms-label";
        const granted = folderGrants[fo.id] || [];
        glbl.textContent = granted.length === 0 ? "Share this folder with a sub:" : "Shared with subs:";
        grants.appendChild(glbl);
        for (const u of projSubs) {
          const on = granted.includes(u.email);
          const chip = document.createElement("button");
          chip.className = "perm-chip grant-chip" + (on ? " on" : "");
          chip.textContent = (on ? "✓ " : "") + u.email;
          chip.addEventListener("click", async () => {
            let list3 = folderGrants[fo.id] || [];
            list3 = on ? list3.filter((x) => x !== u.email) : list3.concat([u.email]);
            if (list3.length === 0) delete folderGrants[fo.id];
            else folderGrants[fo.id] = list3;
            await saveFolderGrants();
            render();
          });
          grants.appendChild(chip);
        }
        list.appendChild(grants);
      }
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
  // everyone on this project except admins — from login members, falling
  // back to the presence roster (whose projects field is a comma string)
  const source = (SESSION.members && SESSION.members.length) ? SESSION.members : presenceRosterList();
  return source.filter((u) => {
    if (u.role === "admin") return false;
    const pl = Array.isArray(u.projects)
      ? u.projects
      : String(u.projects || "").split(",").map((s) => s.trim());
    return pl.includes(currentProject.name);
  });
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
    if (selectMode) {
      if (selectedIds.has(f.id)) selectedIds.delete(f.id);
      else selectedIds.add(f.id);
      render();
      return;
    }
    openLightboxGallery(f);
  });
  if (selectMode) {
    a.classList.add("selectable");
    if (selectedIds.has(f.id)) a.classList.add("selected");
    const chk = document.createElement("div");
    chk.className = "file-check" + (selectedIds.has(f.id) ? " on" : "");
    chk.textContent = selectedIds.has(f.id) ? "✓" : "";
    a.appendChild(chk);
  }
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
    // Office-area files aren't public, so the Drive image CDN 404s on them.
    // Fall back to fetching the bytes through our own backend.
    img.addEventListener("error", function onErr() {
      img.removeEventListener("error", onErr);
      estBlobUrl(f.id)
        .then((u) => { img.src = u; })
        .catch(() => estBlobUrl(f.id).then((u) => { img.src = u; }).catch(() => {
          img.style.display = "none";
        }));
    });
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
// ---------- Scans (CubiCasa exports, admin) ----------
const SHORTCUT_NAME = "URR Scan";
const CUBICASA_APPSTORE = "https://apps.apple.com/us/app/cubicasa-2d-3d-floor-plans/id1439879192";
const CUBICASA_WEB = "https://www.cubi.casa";

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function launchCubiCasa(btn) {
  if (!isIOS()) { window.open(CUBICASA_WEB, "_blank", "noopener"); return; }
  const orig = btn.textContent;
  btn.textContent = "Opening scanner…";
  let left = false;
  const onHide = () => { left = true; };
  document.addEventListener("visibilitychange", onHide, { once: true });
  // Shortcuts is the only reliable launcher — CubiCasa publishes no URL scheme
  window.location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent(SHORTCUT_NAME);
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    btn.textContent = orig;
    if (!left && !document.hidden) {
      $("scan-help").classList.remove("hidden");
    }
  }, 2000);
}

function scanFiles() {
  const path = navPathByTab["Scans"] || "";
  return allFiles.filter((f) => (f.albumName || "") === path && /scan/i.test(f.albumName || "Scans"));
}

function renderScansPanel() {
  const sec = $("scans-section");
  const show = activeTab === "Scans" && isAdmin();
  sec.classList.toggle("hidden", !show);
  if (!show) return;
  const n = allFiles.filter((f) => {
    if (f.tab !== "Scans") return false;
    const a = String(f.albumName || "").toLowerCase();
    return /(^|\/\s*)scans?(\s*\/|$)/.test(a) || /floor[\s\-_]?plan/.test(a);
  }).length;
  $("scan-count").textContent = n ? n + (n === 1 ? " scan file" : " scan files") + " on this property" : "";
}

async function uploadScanFiles(files, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  let done = 0, failed = 0;
  for (const file of files) {
    done++;
    btn.textContent = "Uploading " + done + " of " + files.length + "…";
    try {
      const out = await uploadOne(file, { destArea: "office", destFolderName: "Scans", notify: [] });
      if (!out.ok) failed++;
    } catch (e) { failed++; console.warn("scan upload failed", e); }
  }
  btn.textContent = failed ? "✗ " + failed + " failed" : "✓ Uploaded";
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
  loadFiles();
}

// ---------- Job costing (ADMIN ONLY) ----------
const COST_CATS = ["Material", "Labor", "Sub", "Equipment", "Permit/Fee", "Other"];
const COST_ICON = { Material: "🧱", Labor: "👷", Sub: "🔧", Equipment: "🚜", "Permit/Fee": "📋", Other: "📦" };

// Derive the ESTIMATED internal cost of a budget line from its source
// estimate (matching section by name) — the customer never has this data.
function budgetLineIntel(b) {
  const out = { estCost: null, kind: "normal", actual: 0 };
  for (const c of costs) if (c.budgetId === b.id) out.actual = r2(out.actual + (Number(c.amount) || 0));
  if (!b.estId) return out;
  const desc = String(b.desc || "");
  if (/^Sales tax\b/.test(desc)) { out.kind = "tax"; out.estCost = 0; return out; }
  if (/^Discount\b/.test(desc)) { out.kind = "discount"; out.estCost = 0; return out; }
  const est = estimates.find((x) => x.id === b.estId);
  if (!est || est.totals) return out; // customer copies have no cost data
  const c = calcEstimate(est);
  for (const s of (est.sections || [])) {
    const label = (s.name || "") + " — ";
    if (desc.indexOf(label) === 0) { out.estCost = c.costBySection[s.id] || 0; return out; }
  }
  return out;
}

function renderPL() {
  const host = $("pl-card");
  if (!isAdmin()) { host.classList.add("hidden"); return; }
  host.classList.remove("hidden");
  let contract = 0, estCost = 0, actual = 0, estKnown = false;
  for (const b of budget) {
    const it = budgetLineIntel(b);
    if (it.kind === "tax") continue; // pass-through, not profit
    contract = r2(contract + (Number(b.amount) || 0));
    if (it.estCost !== null) { estCost = r2(estCost + it.estCost); estKnown = true; }
    actual = r2(actual + it.actual);
  }
  // costs not linked to any budget line still count against the job
  for (const c of costs) {
    if (!c.budgetId || !budget.some((b) => b.id === c.budgetId)) actual = r2(actual + (Number(c.amount) || 0));
  }
  const estProfit = estKnown ? r2(contract - estCost) : null;
  const profitNow = r2(contract - actual);
  const variance = estKnown ? r2(estCost - actual) : null;
  const cell = (label, val, cls) =>
    "<div class='pl-cell" + (cls ? " " + cls : "") + "'><span>" + label + "</span><b>" + val + "</b></div>";
  host.innerHTML =
    "<div class='pl-title'>Job Performance — admin only</div><div class='pl-grid'>" +
    cell("Contract (excl. tax)", fmtMoney(contract)) +
    cell("Estimated cost", estKnown ? fmtMoney(estCost) : "—") +
    cell("Estimated profit", estProfit !== null ? fmtMoney(estProfit) : "—") +
    cell("Actual costs to date", fmtMoney(actual)) +
    cell("Profit if costs stop today", fmtMoney(profitNow), profitNow >= 0 ? "good" : "bad") +
    cell("Cost variance vs estimate", variance !== null ? (variance >= 0 ? "▲ " : "▼ ") + fmtMoney(Math.abs(variance)) + (variance >= 0 ? " under" : " over") : "—",
         variance === null ? "" : variance >= 0 ? "good" : "bad") +
    "</div>";
}

function renderCostsPanel() {
  const sec = $("costs-section");
  const show = activeTab === "Materials" && isAdmin();
  sec.classList.toggle("hidden", !show);
  if (!show) return;
  const list = $("costs-list");
  list.innerHTML = "";
  const sorted = costs.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  $("costs-empty").classList.toggle("hidden", sorted.length > 0);
  let total = 0;
  for (const c of sorted) total = r2(total + (Number(c.amount) || 0));
  $("costs-total").textContent = sorted.length ? "Total logged: " + fmtMoney(total) : "";
  for (const c of sorted) {
    const row = document.createElement("div");
    row.className = "cost-row";
    const left = document.createElement("div");
    left.className = "cost-left";
    const line1 = document.createElement("div");
    line1.className = "cost-desc";
    line1.textContent = (COST_ICON[c.cat] || "📦") + " " + c.desc;
    left.appendChild(line1);
    const bLine = budget.find((b) => b.id === c.budgetId);
    const line2 = document.createElement("div");
    line2.className = "cost-meta";
    line2.textContent = [
      c.date ? fmtDateLong(c.date) : null,
      c.cat,
      c.vendor || null,
      bLine ? "→ " + bLine.desc : "→ unassigned"
    ].filter(Boolean).join("  ·  ");
    left.appendChild(line2);
    row.appendChild(left);
    const amt = document.createElement("div");
    amt.className = "cost-amt";
    amt.textContent = fmtMoney(c.amount);
    row.appendChild(amt);
    if (c.receiptId) {
      const rc = document.createElement("button");
      rc.className = "btn-ghost cost-receipt";
      rc.textContent = "🧾";
      rc.title = "View receipt";
      rc.addEventListener("click", (e2) => {
        e2.stopPropagation();
        lightboxList = [{ id: c.receiptId, name: c.desc + " receipt", mimeType: /\.pdf$/i.test(c.receiptName || "") ? "application/pdf" : "image/jpeg" }];
        lightboxIndex = 0;
        openLightbox(lightboxList[0]);
      });
      row.appendChild(rc);
    }
    row.addEventListener("click", () => openCostModal(c.id));
    list.appendChild(row);
  }
}

function openCostModal(id) {
  editingCostId = id || null;
  const c = id ? costs.find((x) => x.id === id) : null;
  $("cost-modal-title").textContent = c ? "Edit Cost" : "Log a Cost";
  $("cost-date").value = c ? c.date : ymd(new Date());
  $("cost-desc").value = c ? c.desc : "";
  const catSel = $("cost-cat");
  catSel.innerHTML = "";
  for (const k of COST_CATS) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = COST_ICON[k] + " " + k;
    catSel.appendChild(o);
  }
  catSel.value = c ? c.cat : "Material";
  $("cost-vendor").value = c ? (c.vendor || "") : "";
  $("cost-amount").value = c ? c.amount : "";
  const bSel = $("cost-budget");
  bSel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— not assigned to a budget line —";
  bSel.appendChild(none);
  for (const b of budget) {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = b.desc + "  (" + fmtMoney(b.amount) + ")";
    bSel.appendChild(o);
  }
  bSel.value = c ? (c.budgetId || "") : "";
  $("cost-receipt").value = "";
  $("cost-receipt-hint").textContent = c && c.receiptId ? "Receipt attached ✓ (choose a file to replace)" : "";
  $("cost-delete").classList.toggle("hidden", !c);
  $("cost-modal").classList.remove("hidden");
}

async function saveCost() {
  const desc = $("cost-desc").value.trim();
  const amount = parseFloat($("cost-amount").value) || 0;
  if (!desc || !(amount > 0)) { $("cost-receipt-hint").textContent = "Enter a description and amount."; return; }
  const btn = $("cost-save");
  btn.disabled = true;
  let receiptId = null, receiptName = null;
  const file = ($("cost-receipt").files || [])[0];
  if (file) {
    $("cost-receipt-hint").textContent = "Uploading receipt…";
    try {
      const up = await uploadOne(file, { destArea: "office", destFolderName: "Job Costs", notify: [] });
      if (up.ok) { receiptId = up.fileId; receiptName = up.fileName; }
    } catch (e) { console.warn("receipt upload failed", e); }
  }
  const data = {
    date: $("cost-date").value,
    desc,
    cat: $("cost-cat").value,
    vendor: $("cost-vendor").value.trim(),
    amount,
    budgetId: $("cost-budget").value || null
  };
  if (editingCostId) {
    const i = costs.findIndex((x) => x.id === editingCostId);
    if (i >= 0) {
      costs[i] = { ...costs[i], ...data };
      if (receiptId) { costs[i].receiptId = receiptId; costs[i].receiptName = receiptName; }
    }
  } else {
    const rec = { id: "c" + Date.now(), ...data };
    if (receiptId) { rec.receiptId = receiptId; rec.receiptName = receiptName; }
    costs.push(rec);
  }
  await saveCosts();
  btn.disabled = false;
  closeModal("cost-modal");
  render();
}

async function deleteCost() {
  costs = costs.filter((x) => x.id !== editingCostId);
  await saveCosts();
  closeModal("cost-modal");
  render();
}

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

    if (admin) {
      if (b.hidden) {
        const hid = document.createElement("span");
        hid.className = "budget-hidden-tag";
        hid.textContent = "hidden from customer";
        left.appendChild(hid);
      }
      const it = budgetLineIntel(b);
      if (it.kind === "normal" && (it.estCost !== null || it.actual > 0)) {
        const intel = document.createElement("div");
        intel.className = "budget-intel";
        const amt2 = Number(b.amount) || 0;
        const parts = [];
        if (it.estCost !== null) parts.push("Est. cost " + fmtMoney(it.estCost));
        parts.push("Actual " + fmtMoney(it.actual));
        if (it.estCost !== null) {
          const v = r2(it.estCost - it.actual);
          parts.push((v >= 0 ? "▲ " : "▼ ") + fmtMoney(Math.abs(v)) + (v >= 0 ? " under est" : " over est"));
        }
        parts.push("Margin now " + fmtMoney(r2(amt2 - it.actual)));
        intel.textContent = parts.join("  ·  ");
        const v2 = it.estCost !== null ? r2(it.estCost - it.actual) : 0;
        intel.classList.add(v2 >= 0 ? "good" : "bad");
        left.appendChild(intel);
      }
      row.addEventListener("click", () => openBudgetModal(b.id));
    } else {
      row.addEventListener("click", () => {
        alert(b.desc + "\n\nCategory: " + (b.cat || "—") +
          "\nAmount: " + fmtMoney(b.amount) +
          "\nPaid: " + fmtMoney(b.paid) +
          "\nRemaining: " + fmtMoney((Number(b.amount) || 0) - (Number(b.paid) || 0)));
      });
    }
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
  $("budget-visible").checked = b ? !b.hidden : true;
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
    hidden: !$("budget-visible").checked,
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
const CI_STATUS = (inv) => {
  const paid = (inv.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const total = inv.totals ? Number(inv.totals.total) || 0 : 0;
  if (total > 0 && paid >= total) return { label: "Paid", cls: "complete", paid, total };
  if (paid > 0) return { label: "Partial — " + fmtMoney(total - paid) + " due", cls: "in-progress", paid, total };
  return { label: inv.visible ? "Awaiting payment" : "Hidden from customer", cls: inv.visible ? "in-progress" : "scheduled", paid, total };
};

function renderCustInvoices(list) {
  const wrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "section-title ci-title";
  title.textContent = isAdmin() ? "Customer Invoices" : "Your Invoices";
  wrap.appendChild(title);
  const sorted = custInvoices.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (sorted.length === 0) {
    const em = document.createElement("div");
    em.className = "status-msg";
    em.textContent = isAdmin()
      ? "No customer invoices yet — approving an estimate creates the first one automatically (hidden until you make it visible)."
      : "No invoices yet.";
    wrap.appendChild(em);
  }
  for (const inv of sorted) {
    const st = CI_STATUS(inv);
    const card = document.createElement("div");
    card.className = "log-card inv-card";
    const head = document.createElement("div");
    head.className = "log-head";
    const t = document.createElement("div");
    t.className = "log-date";
    t.textContent = (inv.number || "Invoice") + (inv.title ? " — " + inv.title : "");
    head.appendChild(t);
    const badge = document.createElement("span");
    badge.className = "status-badge " + st.cls;
    badge.textContent = st.label;
    head.appendChild(badge);
    card.appendChild(head);
    const meta = document.createElement("div");
    meta.className = "log-meta";
    meta.textContent = [
      inv.date ? fmtDateLong(inv.date) : null,
      fmtMoney(st.total),
      st.paid ? fmtMoney(st.paid) + " paid" : null
    ].filter(Boolean).join("  ·  ");
    card.appendChild(meta);

    if (isAdmin()) {
      const row = document.createElement("div");
      row.className = "inv-actions";
      const pv = document.createElement("button");
      pv.className = "btn-ghost inv-btn";
      pv.textContent = "👁 Preview / PDF";
      pv.addEventListener("click", (e2) => { e2.stopPropagation(); openCustInvoicePreview(inv.id); });
      row.appendChild(pv);
      const vis = document.createElement("button");
      vis.className = (inv.visible ? "btn-ghost" : "btn-primary") + " inv-btn";
      vis.textContent = inv.visible ? "🙈 Hide from customer" : "👤 Make visible to customer";
      vis.addEventListener("click", (e2) => { e2.stopPropagation(); custInvoiceAction(inv, { visible: !inv.visible }); });
      row.appendChild(vis);
      const pay = document.createElement("button");
      pay.className = "btn-primary inv-btn";
      pay.textContent = "＋ Log payment";
      pay.addEventListener("click", (e2) => { e2.stopPropagation(); logInvoicePayment(inv); });
      row.appendChild(pay);
      const del = document.createElement("button");
      del.className = "btn-danger inv-btn";
      del.textContent = "Delete";
      del.addEventListener("click", (e2) => {
        e2.stopPropagation();
        if (confirm("Delete " + (inv.number || "this invoice") + "? Budget lines are not affected.")) custInvoiceAction(inv, { remove: true });
      });
      row.appendChild(del);
      card.appendChild(row);
    } else {
      card.addEventListener("click", () => openCustInvoiceView(inv.id));
    }
    list.appendChild(wrap);
    wrap.appendChild(card);
  }
  if (sorted.length === 0) list.appendChild(wrap);
}

async function custInvoiceAction(inv, payload) {
  try {
    const out = await api({ action: "custInvoiceUpdate", email: SESSION.email, code: SESSION.code, project: currentProject.name, invId: inv.id, ...payload });
    if (out.ok && out.invoices) { custInvoices = out.invoices; render(); }
  } catch (e) { console.warn("cust invoice update failed", e); }
}

async function logInvoicePayment(inv) {
  const st = CI_STATUS(inv);
  const amtStr = prompt("Payment amount (balance: " + fmtMoney(st.total - st.paid) + "):");
  if (amtStr === null) return;
  const amount = parseFloat(amtStr);
  if (!(amount > 0)) { alert("Enter a dollar amount."); return; }
  const method = prompt("Payment method (check #, card, cash, Zelle...):") || "";
  try {
    const out = await api({ action: "custInvoicePayment", email: SESSION.email, code: SESSION.code, project: currentProject.name, invId: inv.id, amount, method, date: ymd(new Date()) });
    if (!out.ok) throw new Error(out.error || "failed");
    custInvoices = out.invoices;
    loadState().then(render); // budget paid amounts updated server-side
  } catch (e) { alert("Couldn't log payment: " + e.message); }
}

function openCustInvoicePreview(id) {
  const inv = custInvoices.find((x) => x.id === id);
  if (!inv) return;
  previewEstId = null;
  previewInvId = id;
  const sb = $("est-send-btn");
  if (sb) sb.classList.add("hidden");
  renderEstimateDoc(inv, $("est-preview-doc"), "INVOICE");
  $("est-preview-modal").classList.remove("hidden");
}

function openCustInvoiceView(id) {
  const inv = custInvoices.find((x) => x.id === id);
  if (!inv) return;
  viewingEstId = null;
  renderEstimateDoc(inv, $("ev-doc"), "INVOICE");
  $("ev-sign-row").classList.add("hidden");
  $("ev-approve").classList.add("hidden");
  $("ev-decline").classList.add("hidden");
  $("est-view-modal").classList.remove("hidden");
}

let previewInvId = null;

function renderInvoices() {
  const isSub = currentUser.role === "sub";
  const isCust = currentUser.role === "customer";
  $("inv-form").classList.toggle("hidden", !isSub);
  $("inv-title").textContent = isSub ? "Submit an Invoice" : isCust ? "" : "Invoices Submitted by Subs";

  const list = $("inv-list");
  list.innerHTML = "";
  if (!isSub) renderCustInvoices(list);
  if (isCust) { $("inv-empty").classList.add("hidden"); return; }
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


// ---------- Estimates (built in-portal; markup hidden from customer) ----------
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function calcEstimate(e) {
  const lines = [];
  let markedSubtotal = 0, cost = 0;
  for (const s of (e.sections || [])) {
    for (const it of (s.items || [])) {
      const qty = Number(it.qty) || 0;
      const rate = Number(it.rate) || 0;
      const base = r2(qty * rate);
      const m = Number(it.markup) || 0;
      let marked = base;
      if (it.markupType === "$") marked = base + m;
      else marked = base * (1 + m / 100);
      marked = r2(marked);
      lines.push({ secId: s.id, item: it, base, marked });
      markedSubtotal = r2(markedSubtotal + marked);
      cost = r2(cost + base);
    }
  }
  const g = Number(e.globalMarkup) || 0;
  const gType = e.globalMarkupType === "$" ? "$" : "%";
  let target = markedSubtotal;
  if (g) target = gType === "$" ? r2(markedSubtotal + g) : r2(markedSubtotal * (1 + g / 100));
  let running = 0, lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let cust = L.marked;
    if (g && markedSubtotal > 0) {
      cust = gType === "$" ? L.marked + g * (L.marked / markedSubtotal) : L.marked * (1 + g / 100);
    }
    L.customer = r2(cust);
    running = r2(running + L.customer);
    if (L.customer > 0) lastIdx = i;
  }
  if (lines.length && lastIdx >= 0 && running !== target) {
    lines[lastIdx].customer = r2(lines[lastIdx].customer + (target - running));
  }
  const subtotal = target;
  const d = Number(e.discount) || 0;
  const discountAmt = d ? (e.discountType === "$" ? r2(d) : r2(subtotal * d / 100)) : 0;
  let taxable = 0;
  for (const L of lines) if (L.item.taxable !== false) taxable = r2(taxable + L.customer);
  const taxBase = subtotal > 0 ? r2(taxable - discountAmt * (taxable / subtotal)) : 0;
  const tax = r2(taxBase * ((Number(e.taxRate) || 0) / 100));
  const total = r2(subtotal - discountAmt + tax);
  const dep = Number(e.deposit) || 0;
  const depositAmt = dep ? (e.depositType === "$" ? r2(dep) : r2(total * dep / 100)) : 0;
  const margin = r2(subtotal - discountAmt - cost);
  const bySection = {};
  const costBySection = {};
  for (const L of lines) {
    bySection[L.secId] = r2((bySection[L.secId] || 0) + L.customer);
    costBySection[L.secId] = r2((costBySection[L.secId] || 0) + L.base);
  }
  return { lines, subtotal, discountAmt, tax, total, depositAmt, margin, cost, bySection, costBySection };
}

const EST_STATUS_LABEL = { draft: "Draft", sent: "Awaiting response", approved: "Approved", declined: "Declined" };
const EST_STATUS_CLASS = { draft: "scheduled", sent: "in-progress", approved: "complete", declined: "declined" };

function nextEstNumber() {
  let max = 0;
  for (const e of estimates) {
    const m = /(\d+)$/.exec(e.number || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "EST-" + String(max + 1).padStart(3, "0");
}

// Totals helper that works for BOTH shapes: admin raw estimates and the
// server-transformed customer copies (which carry a totals object).
function estDisplayTotals(e) {
  if (e.totals) return { subtotal: e.totals.subtotal, discountAmt: e.totals.discount, tax: e.totals.tax, total: e.totals.total, depositAmt: e.totals.deposit, margin: 0 };
  return calcEstimate(e);
}

const BID_STATUS_LABEL = { submitted: "Submitted", reviewed: "Under review", accepted: "Accepted", declined: "Declined" };
const BID_STATUS_CLASS = { submitted: "scheduled", reviewed: "in-progress", accepted: "complete", declined: "declined" };

function renderBids(list) {
  const isSub = currentUser.role === "sub";
  const sorted = subBids.slice().sort((a, b) => (b.t || "").localeCompare(a.t || ""));
  const wrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "section-title ci-title";
  title.textContent = isSub ? "Your Submitted Bids" : "Bids from Subs";
  if (!isSub || sorted.length) wrap.appendChild(title);
  if (!isSub && sorted.length === 0) {
    const em = document.createElement("div");
    em.className = "status-msg";
    em.textContent = "No sub bids submitted yet.";
    wrap.appendChild(em);
  }
  for (const b of sorted) {
    const st = b.status || "submitted";
    const card = document.createElement("div");
    card.className = "log-card inv-card";
    const head = document.createElement("div");
    head.className = "log-head";
    const t = document.createElement("div");
    t.className = "log-date";
    t.textContent = b.title || b.fileName || "Bid";
    head.appendChild(t);
    const badge = document.createElement("span");
    badge.className = "status-badge " + (BID_STATUS_CLASS[st] || "scheduled");
    badge.textContent = BID_STATUS_LABEL[st] || st;
    head.appendChild(badge);
    card.appendChild(head);
    const meta = document.createElement("div");
    meta.className = "log-meta";
    meta.textContent = [
      isAdmin() ? authorLabel(b.sub) : null,
      b.t ? new Date(b.t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null,
      b.amount ? fmtMoney(b.amount) : null
    ].filter(Boolean).join("  ·  ");
    card.appendChild(meta);
    if (b.notes) {
      const nt = document.createElement("div");
      nt.className = "log-notes";
      nt.textContent = b.notes;
      card.appendChild(nt);
    }
    if (isAdmin()) {
      const row = document.createElement("div");
      row.className = "inv-actions";
      const open = document.createElement("button");
      open.className = "btn-ghost inv-btn";
      open.textContent = "Open bid file";
      open.addEventListener("click", (e2) => {
        e2.stopPropagation();
        lightboxList = [{ id: b.fileId, name: b.fileName, mimeType: /\.pdf$/i.test(b.fileName || "") ? "application/pdf" : "" }];
        lightboxIndex = 0;
        openLightbox(lightboxList[0]);
      });
      row.appendChild(open);
      [["reviewed", "Mark reviewed"], ["accepted", "✓ Accept"], ["declined", "Decline"]].forEach(([s, lbl]) => {
        if (st === s) return;
        const btn = document.createElement("button");
        btn.className = (s === "accepted" ? "btn-primary" : "btn-ghost") + " inv-btn";
        btn.textContent = lbl;
        btn.addEventListener("click", (e2) => { e2.stopPropagation(); bidAction(b, { status: s }); });
        row.appendChild(btn);
      });
      const del = document.createElement("button");
      del.className = "btn-danger inv-btn";
      del.textContent = "Delete";
      del.addEventListener("click", (e2) => {
        e2.stopPropagation();
        if (confirm("Delete this bid and trash its file?")) bidAction(b, { remove: true });
      });
      row.appendChild(del);
      card.appendChild(row);
    }
    wrap.appendChild(card);
  }
  list.appendChild(wrap);
}

async function bidAction(b, payload) {
  try {
    const out = await api({ action: "bidUpdate", email: SESSION.email, code: SESSION.code, project: currentProject.name, bidId: b.id, ...payload });
    if (out.ok && out.bids) { subBids = out.bids; render(); }
  } catch (e) { console.warn("bid update failed", e); }
}

async function submitBid() {
  const file = ($("bid-file").files || [])[0];
  const status = $("bid-status-msg");
  if (!file) { status.textContent = "Attach your bid file (PDF or photo) first."; return; }
  const btn = $("bid-submit");
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
      action: "submitBid",
      email: SESSION.email, code: SESSION.code, project: currentProject.name,
      filename: file.name, mimeType: file.type, data: b64,
      title: $("bid-title").value.trim(),
      amount: parseFloat($("bid-amount").value) || 0,
      notes: $("bid-notes").value.trim()
    });
    if (!out.ok) throw new Error(out.error || "submit failed");
    subBids.unshift(out.bid);
    $("bid-title").value = "";
    $("bid-amount").value = "";
    $("bid-notes").value = "";
    $("bid-file").value = "";
    status.textContent = "✓ Bid sent to the URR office.";
    render();
    $("bid-status-msg").textContent = "✓ Bid sent to the URR office.";
  } catch (e) {
    status.textContent = "✗ " + (e.message || "submit failed");
  }
  btn.disabled = false;
}

function renderEstimates() {
  const isSub = currentUser.role === "sub";
  $("add-est-btn").classList.toggle("hidden", !isAdmin());
  $("bid-form").classList.toggle("hidden", !isSub);
  $("est-title-bar").textContent = isAdmin() ? "Estimates" : isSub ? "Submit a Bid" : "Your Estimates";
  const list = $("est-list");
  list.innerHTML = "";
  if (isSub) {
    $("est-empty").classList.add("hidden");
    renderBids(list);
    return;
  }
  const sorted = estimates.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  $("est-empty").classList.toggle("hidden", sorted.length > 0);
  $("est-empty").textContent = isAdmin()
    ? "No estimates yet. Build one with + New Estimate — drafts stay invisible to the customer until you mark them Sent."
    : "No estimates yet.";

  for (const e of sorted) {
    const t = estDisplayTotals(e);
    const card = document.createElement("div");
    card.className = "log-card est-card";
    const head = document.createElement("div");
    head.className = "log-head";
    const title = document.createElement("div");
    title.className = "log-date";
    title.textContent = (e.number ? e.number + " — " : "") + (e.title || "Estimate");
    head.appendChild(title);
    const badge = document.createElement("span");
    badge.className = "status-badge " + (EST_STATUS_CLASS[e.status] || "scheduled");
    badge.textContent = EST_STATUS_LABEL[e.status] || e.status;
    head.appendChild(badge);
    card.appendChild(head);
    const meta = document.createElement("div");
    meta.className = "log-meta";
    meta.textContent = [
      e.date ? fmtDateLong(e.date) : null,
      fmtMoney(t.total),
      Number(e.revision) ? "Rev " + e.revision : null,
      e.signedName ? "Signed: " + e.signedName : null
    ].filter(Boolean).join("  ·  ");
    card.appendChild(meta);
    if (isAdmin() && t.margin) {
      const mg = document.createElement("div");
      mg.className = "est-margin-line";
      mg.textContent = "Your margin: " + fmtMoney(t.margin) + " (never shown to customer)";
      card.appendChild(mg);
    }
    if (isAdmin()) {
      const pv = document.createElement("button");
      pv.className = "btn-ghost est-preview-btn";
      pv.textContent = "👁 Preview / PDF";
      pv.addEventListener("click", (ev2) => { ev2.stopPropagation(); openEstPreview(e.id); });
      card.appendChild(pv);
    }
    card.addEventListener("click", () => {
      if (isAdmin()) openEstModal(e.id);
      else openEstView(e.id);
    });
    list.appendChild(card);
  }
  if (isAdmin()) renderBids(list);
}

// ----- Admin builder -----
function blankEstimate() {
  return {
    id: "e" + Date.now(),
    number: nextEstNumber(),
    title: "",
    date: ymd(new Date()),
    expires: "",
    status: "draft",
    taxRate: 0,
    discount: 0, discountType: "%",
    globalMarkup: 0, globalMarkupType: "%",
    deposit: 0, depositType: "%",
    schedule: [],
    photos: [],
    attachments: [],
    customerName: "",
    billingAddress: "",
    serviceAddress: currentProject ? currentProject.name : "",
    display: { qty: true, rate: true, amount: true, sectionTotal: false },
    termsTemplateId: (termsLibrary.find((t) => t.default) || {}).id || "",
    terms: (termsLibrary.find((t) => t.default) || {}).body || cacheGet("urrEstimateTermsLocal") || "",
    customerNotes: "",
    internalNotes: "",
    sections: [{ id: "s" + Date.now(), name: "General", items: [blankItem()] }]
  };
}
function blankItem() {
  return { id: "i" + Date.now() + Math.floor(Math.random() * 1000), desc: "", notes: "", photos: [], qty: 1, rate: 0, markupType: "%", markup: 0, taxable: true };
}

function openEstModal(id) {
  editingEstId = id || null;
  const e = id ? estimates.find((x) => x.id === id) : null;
  estDraft = e ? JSON.parse(JSON.stringify(e)) : blankEstimate();
  if (!estDraft.schedule) estDraft.schedule = [];
  if (!estDraft.photos) estDraft.photos = [];
  if (!estDraft.attachments) estDraft.attachments = [];
  $("est-modal-title").textContent = e ? "Edit Estimate" : "New Estimate";
  $("est-number").value = estDraft.number || "";
  $("est-date").value = estDraft.date || ymd(new Date());
  $("est-expires").value = estDraft.expires || "";
  $("est-status").value = estDraft.status || "draft";
  $("est-name").value = estDraft.title || "";
  $("est-taxrate").value = estDraft.taxRate || 0;
  $("est-disc-type").value = estDraft.discountType || "%";
  $("est-disc-val").value = estDraft.discount || 0;
  $("est-gm-type").value = estDraft.globalMarkupType || "%";
  $("est-gm-val").value = estDraft.globalMarkup || 0;
  $("est-dep-type").value = estDraft.depositType || "%";
  $("est-dep-val").value = estDraft.deposit || 0;
  $("est-cust-name").value = estDraft.customerName || "";
  $("est-bill-addr").value = estDraft.billingAddress || "";
  $("est-svc-addr").value = estDraft.serviceAddress || (currentProject ? currentProject.name : "");
  const disp = estDraft.display || { qty: true, rate: true, amount: true, sectionTotal: false };
  $("est-show-qty").checked = disp.qty !== false;
  $("est-show-rate").checked = disp.rate !== false;
  $("est-show-amount").checked = disp.amount !== false;
  $("est-show-sectotal").checked = disp.sectionTotal === true;
  $("est-terms").value = estDraft.terms || "";
  renderTermsControls();
  $("est-cust-notes").value = estDraft.customerNotes || "";
  $("est-int-notes").value = estDraft.internalNotes || "";
  $("est-delete").classList.toggle("hidden", !e);
  renderEstSections();
  renderEstSchedule();
  renderEstAttachRows();
  $("est-modal").classList.remove("hidden");
}

// ----- Contract terms library -----
function renderTermsControls() {
  const sel = $("est-terms-select");
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— custom / no template —";
  sel.appendChild(none);
  for (const t of termsLibrary) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = (t.default ? "★ " : "") + t.name;
    sel.appendChild(o);
  }
  sel.value = estDraft.termsTemplateId || "";
  updateTermsPreview();
}

function updateTermsPreview() {
  const body = $("est-terms").value || "";
  const pv = $("est-terms-preview");
  pv.textContent = body ? body.slice(0, 220) + (body.length > 220 ? "…" : "") : "No terms attached — pick a template or expand to write your own.";
  pv.classList.toggle("est-terms-empty", !body);
}

function toggleTermsEditor(open) {
  const ed = $("est-terms-editor");
  const show = open !== undefined ? open : ed.classList.contains("hidden");
  ed.classList.toggle("hidden", !show);
  $("est-terms-preview").classList.toggle("hidden", show);
  $("est-terms-toggle").textContent = show ? "Collapse ▴" : "Expand ▾";
}

async function uploadEstFile(file) {
  const out = await uploadOne(file, { destArea: "office", destFolderName: "Estimate Files", notify: [] });
  if (!out.ok) throw new Error(out.error || "upload failed");
  return { id: out.fileId, name: out.fileName };
}

function estThumb(p, size) {
  const img = document.createElement("img");
  img.className = "est-thumb";
  img.alt = p.name || "";
  img.src = "https://drive.google.com/thumbnail?id=" + encodeURIComponent(p.id) + "&sz=w" + (size || 120);
  return img;
}

// ----- Reordering (drag ≡ on desktop, ▲▼ on touch) -----
let estDrag = null; // {type:'item'|'section', secId, itemId}

function moveItem(secId, itemId, dir) {
  const sIdx = estDraft.sections.findIndex((s) => s.id === secId);
  const s = estDraft.sections[sIdx];
  const i = s.items.findIndex((x) => x.id === itemId);
  const j = i + dir;
  if (j >= 0 && j < s.items.length) {
    [s.items[i], s.items[j]] = [s.items[j], s.items[i]];
  } else {
    // crossing a section boundary moves the item to the adjacent section
    const t = estDraft.sections[sIdx + dir];
    if (!t) return;
    const [it] = s.items.splice(i, 1);
    if (dir < 0) t.items.push(it);
    else t.items.unshift(it);
    if (s.items.length === 0) s.items.push(blankItem());
  }
  renderEstSections();
}

function moveSection(secId, dir) {
  const i = estDraft.sections.findIndex((s) => s.id === secId);
  const j = i + dir;
  if (j < 0 || j >= estDraft.sections.length) return;
  [estDraft.sections[i], estDraft.sections[j]] = [estDraft.sections[j], estDraft.sections[i]];
  renderEstSections();
}

function dropItemAt(targetSecId, targetIndex) {
  if (!estDrag || estDrag.type !== "item") return;
  const from = estDraft.sections.find((s) => s.id === estDrag.secId);
  const to = estDraft.sections.find((s) => s.id === targetSecId);
  if (!from || !to) return;
  const i = from.items.findIndex((x) => x.id === estDrag.itemId);
  if (i === -1) return;
  const [it] = from.items.splice(i, 1);
  let idx = targetIndex;
  if (from === to && i < idx) idx--; // account for removal shift
  idx = Math.max(0, Math.min(idx, to.items.length));
  to.items.splice(idx, 0, it);
  if (from.items.length === 0) from.items.push(blankItem());
  renderEstSections();
}

function dropSectionAt(targetIndex) {
  if (!estDrag || estDrag.type !== "section") return;
  const i = estDraft.sections.findIndex((s) => s.id === estDrag.secId);
  if (i === -1) return;
  const [s] = estDraft.sections.splice(i, 1);
  let idx = targetIndex;
  if (i < idx) idx--;
  idx = Math.max(0, Math.min(idx, estDraft.sections.length));
  estDraft.sections.splice(idx, 0, s);
  renderEstSections();
}

function makeHandle(cls, startDrag, upFn, downFn) {
  const wrap = document.createElement("span");
  wrap.className = "drag-cell " + cls;
  const grip = document.createElement("span");
  grip.className = "drag-handle";
  grip.textContent = "≡";
  grip.title = "Drag to reorder";
  grip.draggable = true;
  grip.addEventListener("dragstart", (e2) => { startDrag(); e2.dataTransfer.effectAllowed = "move"; try { e2.dataTransfer.setData("text/plain", "x"); } catch (err) {} });
  grip.addEventListener("dragend", () => { estDrag = null; clearDropMarks(); });
  // Touch drag for iOS (native HTML5 drag doesn't fire on touch)
  grip.addEventListener("touchstart", (e2) => {
    e2.preventDefault();
    startDrag();
    document.body.classList.add("dragging-item");
  }, { passive: false });
  grip.addEventListener("touchmove", (e2) => {
    e2.preventDefault();
    const t = e2.touches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    clearDropMarks();
    if (!el) return;
    if (estDrag && estDrag.type === "item") {
      const row = el.closest(".est-item-row");
      if (row) {
        const r = row.getBoundingClientRect();
        row.classList.add(t.clientY > r.top + r.height / 2 ? "drop-below" : "drop-above");
      }
    } else if (estDrag && estDrag.type === "section") {
      const box = el.closest(".est-section");
      if (box) {
        const r = box.getBoundingClientRect();
        box.classList.add(t.clientY > r.top + r.height / 2 ? "drop-below" : "drop-above");
      }
    }
  }, { passive: false });
  grip.addEventListener("touchend", (e2) => {
    document.body.classList.remove("dragging-item");
    const t = e2.changedTouches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    clearDropMarks();
    if (el && estDrag) {
      if (estDrag.type === "item") {
        const row = el.closest(".est-item-row");
        if (row && row._dropInfo) {
          const r = row.getBoundingClientRect();
          row._dropInfo(t.clientY > r.top + r.height / 2 ? 1 : 0);
        }
      } else if (estDrag.type === "section") {
        const box = el.closest(".est-section");
        if (box && box._dropSection) {
          const r = box.getBoundingClientRect();
          box._dropSection(t.clientY > r.top + r.height / 2 ? 1 : 0);
        }
      }
    }
    estDrag = null;
  });
  wrap.appendChild(grip);
  const arrows = document.createElement("span");
  arrows.className = "drag-arrows";
  const up = document.createElement("button");
  up.textContent = "▲";
  up.addEventListener("click", (e2) => { e2.stopPropagation(); upFn(); });
  const down = document.createElement("button");
  down.textContent = "▼";
  down.addEventListener("click", (e2) => { e2.stopPropagation(); downFn(); });
  arrows.appendChild(up);
  arrows.appendChild(down);
  wrap.appendChild(arrows);
  return wrap;
}

function clearDropMarks() {
  document.querySelectorAll(".drop-above, .drop-below").forEach((el) => el.classList.remove("drop-above", "drop-below"));
}

function wireItemDropTarget(el, secId, indexOf) {
  el._dropInfo = (below) => dropItemAt(secId, indexOf() + below);
  el.addEventListener("dragover", (e2) => {
    if (!estDrag || estDrag.type !== "item") return;
    e2.preventDefault();
    e2.dataTransfer.dropEffect = "move";
    clearDropMarks();
    const r = el.getBoundingClientRect();
    const below = e2.clientY > r.top + r.height / 2;
    el.classList.add(below ? "drop-below" : "drop-above");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-above", "drop-below"));
  el.addEventListener("drop", (e2) => {
    if (!estDrag || estDrag.type !== "item") return;
    e2.preventDefault();
    const r = el.getBoundingClientRect();
    const below = e2.clientY > r.top + r.height / 2;
    clearDropMarks();
    dropItemAt(secId, indexOf() + (below ? 1 : 0));
  });
}

function renderEstSections() {
  const host = $("est-sections");
  host.innerHTML = "";
  estDraft.sections.forEach((s, sIndex) => {
    const box = document.createElement("div");
    box.className = "est-section";
    // section-level drop target (for reordering whole sections)
    box.addEventListener("dragover", (e2) => {
      if (!estDrag || estDrag.type !== "section") return;
      e2.preventDefault();
      clearDropMarks();
      const r = box.getBoundingClientRect();
      box.classList.add(e2.clientY > r.top + r.height / 2 ? "drop-below" : "drop-above");
    });
    box.addEventListener("dragleave", () => box.classList.remove("drop-above", "drop-below"));
    box._dropSection = (below) => dropSectionAt(sIndex + below);
    box.addEventListener("drop", (e2) => {
      if (!estDrag || estDrag.type !== "section") return;
      e2.preventDefault();
      const r = box.getBoundingClientRect();
      const below = e2.clientY > r.top + r.height / 2;
      clearDropMarks();
      dropSectionAt(sIndex + (below ? 1 : 0));
    });

    const head = document.createElement("div");
    head.className = "est-sec-head";
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.className = "est-sec-name";
    nameIn.placeholder = "Section name (e.g. Demolition, Plumbing)";
    nameIn.value = s.name || "";
    nameIn.addEventListener("input", () => { s.name = nameIn.value; });
    head.appendChild(nameIn);
    const secTotal = document.createElement("div");
    secTotal.className = "est-sec-total";
    const secLbl = document.createElement("span");
    secLbl.className = "est-field-lbl";
    secLbl.textContent = "Section Total";
    secTotal.appendChild(secLbl);
    const secVal = document.createElement("span");
    secVal.className = "est-sec-total-val";
    secTotal.appendChild(secVal);
    head.appendChild(secTotal);
    const delSec = document.createElement("button");
    delSec.className = "est-x est-sec-del";
    delSec.textContent = "🗑";
    delSec.title = "Delete section";
    delSec.addEventListener("click", () => {
      const label = (s.name || "this section").trim() || "this section";
      const count = (s.items || []).filter((x) => (x.desc || "").trim() || Number(x.rate) > 0).length;
      const msg = "Delete the section \"" + label + "\"" +
        (count ? " and its " + count + " line item" + (count === 1 ? "" : "s") : "") +
        "?\n\nThis cannot be undone.";
      if (!confirm(msg)) return;
      if (count > 0 && !confirm("Are you sure? " + count + " line item" + (count === 1 ? "" : "s") + " will be permanently removed.")) return;
      estDraft.sections = estDraft.sections.filter((x) => x.id !== s.id);
      if (estDraft.sections.length === 0) estDraft.sections.push({ id: "s" + Date.now(), name: "General", items: [blankItem()] });
      renderEstSections();
    });
    head.appendChild(makeHandle("sec-handle",
      () => { estDrag = { type: "section", secId: s.id }; },
      () => moveSection(s.id, -1),
      () => moveSection(s.id, 1)));
    head.appendChild(delSec);
    box.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "est-items";
    const cols = document.createElement("div");
    cols.className = "est-colhead";
    cols.innerHTML = "<span>Description</span><span>Qty</span><span>Rate</span><span>Markup</span><span>Tax</span><span>Total</span><span></span><span></span>";
    grid.appendChild(cols);

    const refreshTotals = () => {
      const c = calcEstimate(estDraft);
      secVal.textContent = fmtMoney(c.bySection[s.id] || 0);
      updateEstSummary(c);
      grid.querySelectorAll(".est-line-total").forEach((el) => {
        const it = s.items.find((x) => x.id === el.dataset.item);
        if (!it) return;
        const L = c.lines.find((x) => x.item.id === it.id);
        const v = el.querySelector(".est-total-val");
        if (v) v.textContent = fmtMoney(L ? L.customer : 0);
      });
    };

    s.items.forEach((it, itemIndex) => {
      const row = document.createElement("div");
      row.className = "est-row est-item-row";
      wireItemDropTarget(row, s.id, () => s.items.findIndex((x) => x.id === it.id));
      const num = document.createElement("span");
      num.className = "est-item-num";
      num.textContent = (itemIndex + 1) + ")";

      const desc = document.createElement("textarea");
      desc.rows = 1;
      desc.className = "est-grow";
      desc.dataset.lbl = "Item";
      desc.placeholder = "Work / material description (Enter = new line)";
      desc.value = it.desc || "";
      const growDesc = () => { desc.style.height = "auto"; desc.style.height = desc.scrollHeight + "px"; };
      desc.addEventListener("input", () => { it.desc = desc.value; growDesc(); });
      desc.addEventListener("focus", () => { desc.classList.add("expanded"); growDesc(); });
      desc.addEventListener("blur", () => { desc.classList.remove("expanded"); growDesc(); });
      setTimeout(growDesc, 0);
      // NOTE: ::before does not render on <input>, so each numeric field is
      // wrapped in a div that carries the label.
      // Real <span> labels above each field — pseudo-elements are unreliable here
      const mkField = (labelText, input, cls) => {
        const w = document.createElement("div");
        w.className = "est-field" + (cls ? " " + cls : "");
        const lb = document.createElement("span");
        lb.className = "est-field-lbl";
        lb.textContent = labelText;
        w.appendChild(lb);
        w.appendChild(input);
        return w;
      };

      const qtyIn = document.createElement("input");
      qtyIn.type = "number"; qtyIn.min = "0"; qtyIn.step = "0.01"; qtyIn.value = it.qty;
      qtyIn.addEventListener("input", () => { it.qty = qtyIn.value; refreshTotals(); });
      const qty = mkField("Qty", qtyIn, "fld-qty");

      const rateIn = document.createElement("input");
      rateIn.type = "number"; rateIn.min = "0"; rateIn.step = "0.01"; rateIn.value = it.rate;
      rateIn.addEventListener("input", () => { it.rate = rateIn.value; refreshTotals(); });
      const rate = mkField("Item Cost", rateIn, "fld-cost");
      const mwrap = document.createElement("div");
      mwrap.className = "est-markup";
      mwrap.dataset.lbl = "Item Markup";
      const mlbl = document.createElement("span");
      mlbl.className = "est-field-lbl";
      mlbl.textContent = "Item Markup";
      mwrap.appendChild(mlbl);
      const msel = document.createElement("select");
      ["%", "$"].forEach((v) => { const o = document.createElement("option"); o.value = v; o.textContent = v; msel.appendChild(o); });
      msel.value = it.markupType || "%";
      msel.addEventListener("change", () => { it.markupType = msel.value; refreshTotals(); });
      const mval = document.createElement("input");
      mval.type = "number"; mval.step = "0.01"; mval.value = it.markup || 0;
      mval.addEventListener("input", () => { it.markup = mval.value; refreshTotals(); });
      mwrap.appendChild(msel);
      mwrap.appendChild(mval);
      const taxWrap = document.createElement("label");
      taxWrap.className = "est-tax-wrap";
      const txlbl = document.createElement("span");
      txlbl.className = "est-field-lbl";
      txlbl.textContent = "Tax";
      taxWrap.appendChild(txlbl);
      const taxChk = document.createElement("input");
      taxChk.type = "checkbox";
      taxChk.className = "est-taxchk";
      taxChk.checked = it.taxable !== false;
      taxChk.title = "Taxable";
      taxChk.addEventListener("change", () => { it.taxable = taxChk.checked; refreshTotals(); });
      const tot = document.createElement("div");
      tot.className = "est-line-total";
      tot.dataset.item = it.id;
      const totLbl = document.createElement("span");
      totLbl.className = "est-field-lbl";
      totLbl.textContent = "Item Total";
      tot.appendChild(totLbl);
      const totVal = document.createElement("span");
      totVal.className = "est-total-val";
      tot.appendChild(totVal);
      const del = document.createElement("button");
      del.className = "est-x";
      del.textContent = "✕";
      del.addEventListener("click", () => {
        const nm = (it.desc || "").trim();
        if (nm || Number(it.rate) > 0) {
          if (!confirm("Delete line item" + (nm ? ' "' + nm.split("\n")[0].slice(0, 40) + '"' : "") + "?")) return;
        }
        s.items = s.items.filter((x) => x.id !== it.id);
        if (s.items.length === 0) s.items.push(blankItem());
        renderEstSections();
      });
      taxWrap.appendChild(taxChk);
      const taxTxt = document.createElement("span");
      taxTxt.className = "est-tax-lbl";
      taxTxt.textContent = "Taxable";
      taxWrap.appendChild(taxTxt);
      row.appendChild(num);
      row.appendChild(desc);
      row.appendChild(rate); row.appendChild(qty);
      row.appendChild(mwrap); row.appendChild(taxWrap); row.appendChild(tot);
      row.appendChild(del);
      // Handle lives OUTSIDE the card frame, to its right
      const wrap = document.createElement("div");
      wrap.className = "est-item-wrap";
      wrap.appendChild(row);
      wrap.appendChild(makeHandle("item-handle",
        () => { estDrag = { type: "item", secId: s.id, itemId: it.id }; },
        () => moveItem(s.id, it.id, -1),
        () => moveItem(s.id, it.id, 1)));
      grid.appendChild(wrap);
      it._row = row;

      // Description + photos go INSIDE the item card
      const extra = document.createElement("div");
      extra.className = "est-row-extra";
      const notes = document.createElement("textarea");
      notes.rows = 1;
      notes.className = "est-item-notes est-grow";
      notes.dataset.lbl = "Item Description";
      notes.placeholder = "Item description — customer sees this (Enter = new line)";
      notes.value = it.notes || "";
      const growNotes = () => { notes.style.height = "auto"; notes.style.height = notes.scrollHeight + "px"; };
      notes.addEventListener("input", () => { it.notes = notes.value; growNotes(); });
      notes.addEventListener("focus", () => { notes.classList.add("expanded"); growNotes(); });
      notes.addEventListener("blur", () => { notes.classList.remove("expanded"); growNotes(); });
      setTimeout(growNotes, 0);
      row.insertBefore(notes, rate); // description sits under the title, above fields
      const strip = document.createElement("div");
      strip.className = "est-thumb-strip";
      (it.photos || []).forEach((p) => {
        const w = document.createElement("span");
        w.className = "est-thumb-wrap";
        w.appendChild(estThumb(p));
        const x = document.createElement("button");
        x.className = "est-thumb-x";
        x.textContent = "✕";
        x.addEventListener("click", () => { it.photos = it.photos.filter((q) => q.id !== p.id); renderEstSections(); });
        w.appendChild(x);
        strip.appendChild(w);
      });
      if ((it.photos || []).length < 4) {
        const pin = document.createElement("input");
        pin.type = "file"; pin.accept = "image/*"; pin.multiple = true; pin.style.display = "none";
        const pbtn = document.createElement("button");
        pbtn.className = "btn-ghost est-photo-add";
        pbtn.textContent = "📷 " + ((it.photos || []).length ? "" : "Add photos");
        pbtn.addEventListener("click", () => pin.click());
        pin.addEventListener("change", async () => {
          const files = Array.from(pin.files || []).slice(0, 4 - (it.photos || []).length);
          pbtn.disabled = true;
          for (const file of files) {
            pbtn.textContent = "Uploading…";
            try { it.photos = (it.photos || []).concat([await uploadEstFile(file)]); }
            catch (e2) { console.warn("item photo failed", e2); }
          }
          renderEstSections();
        });
        strip.appendChild(pbtn);
        strip.appendChild(pin);
      }
      row.appendChild(strip); // photos row inside the card, below totals
    });

    const addItem = document.createElement("button");
    addItem.className = "btn-ghost est-add-item";
    addItem.textContent = "+ Line item";
    addItem.addEventListener("click", () => { s.items.push(blankItem()); renderEstSections(); });

    box.appendChild(grid);
    box.appendChild(addItem);
    host.appendChild(box);
  });
  const c = calcEstimate(estDraft);
  host.querySelectorAll(".est-section").forEach((box, i) => {
    const s = estDraft.sections[i];
    const sv = box.querySelector(".est-sec-total-val");
    if (sv) sv.textContent = fmtMoney(c.bySection[s.id] || 0);
    box.querySelectorAll(".est-line-total").forEach((el) => {
      const L = c.lines.find((x) => x.item.id === el.dataset.item);
      const v = el.querySelector(".est-total-val");
      if (v) v.textContent = fmtMoney(L ? L.customer : 0);
    });
  });
  updateEstSummary(c);
}

function schedAmount(r, total) {
  if (r.type === "%") return r2(total * (Number(r.value) || 0) / 100);
  if (r.type === "$") return r2(r.value);
  return r2(r.amount); // legacy rows
}

function nextDrawLabel() {
  const hasDeposit = (parseFloat($("est-dep-val").value) || 0) > 0;
  return "Draw " + ((estDraft.schedule || []).length + 1 + (hasDeposit ? 1 : 0));
}

function refreshSchedAmounts(total) {
  const spans = document.querySelectorAll("#est-schedule .est-sched-amt");
  (estDraft.schedule || []).forEach((r, i) => {
    if (spans[i]) spans[i].textContent = fmtMoney(schedAmount(r, total));
  });
}

function renderEstSchedule() {
  const host = $("est-schedule");
  host.innerHTML = "";
  const total = calcEstimate(estDraft).total;
  (estDraft.schedule || []).forEach((r) => {
    if (r.type === undefined && r.amount !== undefined) { r.type = "$"; r.value = r.amount; } // migrate legacy
    const row = document.createElement("div");
    row.className = "est-sched-row";
    const desc = document.createElement("input");
    desc.type = "text"; desc.placeholder = "e.g. Draw 2 — due at rough-in";
    desc.value = r.desc || "";
    desc.addEventListener("input", () => { r.desc = desc.value; });
    const tsel = document.createElement("select");
    ["%", "$"].forEach((v) => { const o = document.createElement("option"); o.value = v; o.textContent = v; tsel.appendChild(o); });
    tsel.value = r.type || "$";
    tsel.addEventListener("change", () => { r.type = tsel.value; renderEstSchedule(); });
    const val = document.createElement("input");
    val.type = "number"; val.step = "0.01"; val.min = "0"; val.placeholder = "0.00";
    val.value = r.value || 0;
    val.addEventListener("input", () => { r.value = val.value; amtSpan.textContent = fmtMoney(schedAmount(r, calcEstimate(estDraft).total)); });
    const amtSpan = document.createElement("span");
    amtSpan.className = "est-sched-amt";
    amtSpan.textContent = fmtMoney(schedAmount(r, total));
    const x = document.createElement("button");
    x.className = "est-x";
    x.textContent = "✕";
    x.addEventListener("click", () => { estDraft.schedule = estDraft.schedule.filter((q) => q !== r); renderEstSchedule(); });
    row.appendChild(desc); row.appendChild(tsel); row.appendChild(val); row.appendChild(amtSpan); row.appendChild(x);
    host.appendChild(row);
  });
}

function renderEstAttachRows() {
  const ph = $("est-photos-strip");
  ph.innerHTML = "";
  (estDraft.photos || []).forEach((p) => {
    const w = document.createElement("span");
    w.className = "est-thumb-wrap";
    w.appendChild(estThumb(p));
    const x = document.createElement("button");
    x.className = "est-thumb-x";
    x.textContent = "✕";
    x.addEventListener("click", () => { estDraft.photos = estDraft.photos.filter((q) => q.id !== p.id); renderEstAttachRows(); });
    w.appendChild(x);
    ph.appendChild(w);
  });
  const at = $("est-attach-list");
  at.innerHTML = "";
  (estDraft.attachments || []).forEach((a) => {
    const row = document.createElement("div");
    row.className = "sub-doc-row";
    const nm = document.createElement("span");
    nm.className = "est-attach-name";
    nm.textContent = "📎 " + a.name;
    row.appendChild(nm);
    const x = document.createElement("button");
    x.className = "sub-doc-del";
    x.textContent = "🗑";
    x.addEventListener("click", () => { estDraft.attachments = estDraft.attachments.filter((q) => q.id !== a.id); renderEstAttachRows(); });
    row.appendChild(x);
    at.appendChild(row);
  });
}

function updateEstSummary(c) {
  if (!estDraft) return;
  estDraft.taxRate = $("est-taxrate").value;
  estDraft.discount = $("est-disc-val").value;
  estDraft.discountType = $("est-disc-type").value;
  estDraft.globalMarkup = $("est-gm-val").value;
  estDraft.globalMarkupType = $("est-gm-type").value;
  estDraft.deposit = $("est-dep-val").value;
  estDraft.depositType = $("est-dep-type").value;
  const t = c || calcEstimate(estDraft);
  $("est-subtotal").textContent = fmtMoney(t.subtotal);
  $("est-disc-amt").textContent = "−" + fmtMoney(t.discountAmt);
  $("est-tax-amt").textContent = fmtMoney(t.tax);
  $("est-grand").textContent = fmtMoney(t.total);
  $("est-dep-amt").textContent = fmtMoney(t.depositAmt);
  $("est-margin").textContent = fmtMoney(t.margin);
  refreshSchedAmounts(t.total);
}

async function saveEstimate() {
  estDraft.number = $("est-number").value.trim();
  estDraft.date = $("est-date").value;
  estDraft.expires = $("est-expires").value;
  estDraft.status = $("est-status").value;
  estDraft.title = $("est-name").value.trim();
  estDraft.taxRate = parseFloat($("est-taxrate").value) || 0;
  estDraft.discount = parseFloat($("est-disc-val").value) || 0;
  estDraft.discountType = $("est-disc-type").value;
  estDraft.globalMarkup = parseFloat($("est-gm-val").value) || 0;
  estDraft.globalMarkupType = $("est-gm-type").value;
  estDraft.deposit = parseFloat($("est-dep-val").value) || 0;
  estDraft.depositType = $("est-dep-type").value;
  estDraft.terms = $("est-terms").value;
  estDraft.display = {
    qty: $("est-show-qty").checked,
    rate: $("est-show-rate").checked,
    amount: $("est-show-amount").checked,
    sectionTotal: $("est-show-sectotal").checked
  };
  estDraft.customerName = $("est-cust-name").value.trim();
  estDraft.billingAddress = $("est-bill-addr").value.trim();
  estDraft.serviceAddress = $("est-svc-addr").value.trim();
  estDraft.customerNotes = $("est-cust-notes").value.trim();
  estDraft.internalNotes = $("est-int-notes").value.trim();
  estDraft.schedule = (estDraft.schedule || []).filter((r) => (r.desc || "").trim() || Number(r.value) > 0 || Number(r.amount) > 0)
    .map((r) => ({ desc: r.desc, type: r.type === "%" ? "%" : "$", value: Number(r.value !== undefined ? r.value : r.amount) || 0 }));
  for (const s of estDraft.sections) {
    s.items = s.items.filter((it) => (it.desc || "").trim() !== "" || Number(it.rate) > 0);
    for (const it of s.items) {
      it.qty = Number(it.qty) || 0;
      it.rate = Number(it.rate) || 0;
      it.markup = Number(it.markup) || 0;
    }
  }
  estDraft.sections = estDraft.sections.filter((s) => s.items.length > 0);
  if (editingEstId) {
    const i = estimates.findIndex((x) => x.id === editingEstId);
    if (i >= 0) estimates[i] = estDraft;
  } else {
    estimates.push(estDraft);
  }
  const savedId = estDraft.id;
  await saveEstimates();
  estDraft = null;
  closeModal("est-modal");
  render();
  openEstPreview(savedId);
}

async function deleteEstimate() {
  if (!editingEstId) return;
  if (!confirm("Delete this estimate?")) return;
  estimates = estimates.filter((x) => x.id !== editingEstId);
  await saveEstimates();
  estDraft = null;
  closeModal("est-modal");
  render();
}

// ----- Shared branded document renderer (preview + customer view) -----
let viewingEstId = null;
const estBlobCache = {};

const estBlobPending = {};
let estBlobChain = Promise.resolve();

async function estBlobUrl(fileId) {
  if (estBlobCache[fileId]) return estBlobCache[fileId];
  if (estBlobPending[fileId]) return estBlobPending[fileId];
  // Queue: Apps Script serves one request at a time per user, so firing a
  // grid full of thumbnails in parallel makes them all time out.
  const p = estBlobChain.then(async () => {
    if (estBlobCache[fileId]) return estBlobCache[fileId];
    const blob = await fetchFileBlobFast({ id: fileId });
    const url = URL.createObjectURL(blob);
    estBlobCache[fileId] = url;
    return url;
  });
  estBlobChain = p.catch(() => {});
  estBlobPending[fileId] = p;
  p.finally(() => { delete estBlobPending[fileId]; });
  return p;
}

function evPhotoStrip(photos, host) {
  for (const p of photos) {
    const img = document.createElement("img");
    img.className = "est-thumb ev-thumb";
    img.alt = p.name || "";
    host.appendChild(img);
    estBlobUrl(p.id).then((u) => { img.src = u; }).catch(() => img.remove());
    img.addEventListener("click", () => {
      lightboxList = [{ id: p.id, name: p.name || "Photo", mimeType: "image/jpeg" }];
      lightboxIndex = 0;
      openLightbox(lightboxList[0]);
    });
  }
}

// Normalize both shapes (admin raw / server customer copy) into final-price doc data
function nl2brHtml(s) {
  return escapeHtml(s).replace(/\n/g, "<br>");
}

function normalizeEstDoc(e) {
  let totals, custByItem = {}, secTotals = {};
  if (e.totals) {
    totals = { subtotal: e.totals.subtotal, discountAmt: e.totals.discount, tax: e.totals.tax, total: e.totals.total, depositAmt: e.totals.deposit };
    for (const s of (e.sections || [])) if (s.sectionTotal !== undefined) secTotals[s.id] = s.sectionTotal;
  } else {
    const c = calcEstimate(e);
    totals = c;
    for (const L of c.lines) custByItem[L.item.id] = L.customer;
    secTotals = c.bySection;
  }
  const disp = e.display || {};
  return {
    display: {
      qty: disp.qty !== false,
      rate: disp.rate !== false,
      amount: disp.amount !== false,
      sectionTotal: disp.sectionTotal === true
    },
    secTotals,
    number: e.number || "", title: e.title || "", date: e.date || "", expires: e.expires || "",
    status: e.status, signedName: e.signedName || "", respondedAt: e.respondedAt || "",
    customerName: e.customerName || "", billingAddress: e.billingAddress || "",
    serviceAddress: e.serviceAddress || "", customerNotes: e.customerNotes || "",
    terms: e.terms || "", photos: e.photos || [], attachments: e.attachments || [],
    totals,
    schedule: (e.schedule || []).map((r) => ({ desc: r.desc, amount: e.totals ? r.amount : schedAmount(r, totals.total) })),
    sections: (e.sections || []).map((s) => ({
      name: s.name,
      id: s.id,
      items: (s.items || []).map((it) => {
        const total = e.totals ? (it.total !== undefined ? Number(it.total) || 0 : null) : (custByItem[it.id] || 0);
        const qty = it.qty !== undefined ? Number(it.qty) || 0 : null;
        let rate;
        if (e.totals) rate = it.rate !== undefined ? Number(it.rate) || 0 : null;
        else rate = qty > 0 ? r2(total / qty) : total;
        return { desc: it.desc, notes: it.notes || "", photos: it.photos || [], qty, rate, total };
      })
    }))
  };
}

function renderEstimateDoc(e, host, kind) {
  const n = normalizeEstDoc(e);
  n.kind = kind || "ESTIMATE";
  n.payments = e.payments || [];
  host.innerHTML = "";

  // ---- Branded header: logo + contractor left, meta + customer right ----
  const head = document.createElement("div");
  head.className = "doc-head";
  const left = document.createElement("div");
  left.className = "doc-co";
  const logo = document.createElement("img");
  logo.src = COMPANY.logo;
  logo.className = "doc-logo";
  logo.alt = COMPANY.name;
  left.appendChild(logo);
  const co = document.createElement("div");
  co.className = "doc-co-info";
  co.innerHTML = "<b>" + escapeHtml(COMPANY.name) + "</b><br>" + escapeHtml(COMPANY.address) + "<br>" +
    escapeHtml(COMPANY.cityState) + "<br>" + escapeHtml(COMPANY.email);
  left.appendChild(co);
  head.appendChild(left);

  const right = document.createElement("div");
  right.className = "doc-meta";
  const kindEl = document.createElement("div");
  kindEl.className = "doc-kind";
  kindEl.textContent = n.kind;
  right.appendChild(kindEl);
  const meta = document.createElement("div");
  meta.className = "doc-meta-grid";
  const metaRows = [
    [n.kind === "INVOICE" ? "Invoice #" : "Estimate #", n.number],
    ["Date", n.date ? fmtDateLong(n.date) : ""],
    ["Expires", n.expires ? fmtDateLong(n.expires) : ""],
    ["Service address", n.serviceAddress]
  ].filter((r) => r[1]);
  for (const [k, v] of metaRows) {
    meta.innerHTML += "<span>" + escapeHtml(k) + "</span><b>" + escapeHtml(v) + "</b>";
  }
  right.appendChild(meta);
  if (n.customerName || n.billingAddress) {
    const bill = document.createElement("div");
    bill.className = "doc-billto";
    bill.innerHTML = "<span>Prepared for</span><b>" + escapeHtml(n.customerName) + "</b>" +
      (n.billingAddress ? "<div>" + escapeHtml(n.billingAddress) + "</div>" : "");
    right.appendChild(bill);
  }
  head.appendChild(right);
  host.appendChild(head);

  if (n.title) {
    const t = document.createElement("div");
    t.className = "doc-title";
    t.textContent = n.title;
    host.appendChild(t);
  }

  if (n.status === "approved" && n.signedName) {
    const ap = document.createElement("div");
    ap.className = "doc-approved";
    ap.textContent = "✓ Approved — signed by " + n.signedName +
      (n.respondedAt ? " on " + new Date(n.respondedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "");
    host.appendChild(ap);
  }

  if (n.photos.length) {
    const strip = document.createElement("div");
    strip.className = "est-thumb-strip ev-strip";
    evPhotoStrip(n.photos, strip);
    host.appendChild(strip);
  }

  const d = n.display;
  const gridCols = "1fr" + (d.qty ? " 56px" : "") + (d.rate ? " 96px" : "") + (d.amount ? " 100px" : "");
  for (const s of n.sections) {
    const sec = document.createElement("div");
    sec.className = "ev-section";
    const h = document.createElement("div");
    h.className = "ev-sec-name";
    h.textContent = s.name || "";
    sec.appendChild(h);
    const cols = document.createElement("div");
    cols.className = "ev-row ev-cols";
    cols.style.gridTemplateColumns = gridCols;
    cols.innerHTML = "<span>Description</span>" + (d.qty ? "<span>Qty</span>" : "") +
      (d.rate ? "<span>Rate</span>" : "") + (d.amount ? "<span>Amount</span>" : "");
    sec.appendChild(cols);
    for (const it of s.items) {
      const row = document.createElement("div");
      row.className = "ev-row";
      row.style.gridTemplateColumns = gridCols;
      row.innerHTML = "<span class='ev-desc'>" + nl2brHtml(it.desc || "") +
        (it.notes ? "<div class='ev-item-notes'>" + nl2brHtml(it.notes) + "</div>" : "") +
        "</span>" +
        (d.qty ? "<span>" + (it.qty !== null ? it.qty : "") + "</span>" : "") +
        (d.rate ? "<span>" + (it.rate !== null ? fmtMoney(it.rate) : "") + "</span>" : "") +
        (d.amount ? "<span>" + (it.total !== null ? fmtMoney(it.total) : "") + "</span>" : "");
      sec.appendChild(row);
      if (it.photos.length) {
        const strip = document.createElement("div");
        strip.className = "est-thumb-strip ev-strip";
        evPhotoStrip(it.photos, strip);
        sec.appendChild(strip);
      }
    }
    if (d.sectionTotal && n.secTotals[s.id] !== undefined) {
      const st = document.createElement("div");
      st.className = "ev-row ev-sec-total";
      st.style.gridTemplateColumns = gridCols;
      st.innerHTML = "<span>Section subtotal</span>" + (d.qty ? "<span></span>" : "") +
        (d.rate ? "<span></span>" : "") +
        "<span" + (d.amount ? "" : " style='grid-column:-2'") + "><b>" + fmtMoney(n.secTotals[s.id]) + "</b></span>";
      sec.appendChild(st);
    }
    host.appendChild(sec);
  }

  const sums = document.createElement("div");
  sums.className = "est-sums ev-sums doc-sums";
  let sumsHtml = "<div><span>Subtotal</span><b>" + fmtMoney(n.totals.subtotal) + "</b></div>";
  if (n.totals.discountAmt) sumsHtml += "<div><span>Discount</span><b>−" + fmtMoney(n.totals.discountAmt) + "</b></div>";
  if (n.totals.tax) sumsHtml += "<div><span>Tax</span><b>" + fmtMoney(n.totals.tax) + "</b></div>";
  sumsHtml += "<div class='est-grand'><span>Total</span><b>" + fmtMoney(n.totals.total) + "</b></div>";
  if (n.totals.depositAmt) sumsHtml += "<div><span>Deposit due</span><b>" + fmtMoney(n.totals.depositAmt) + "</b></div>";
  if (n.payments.length) {
    let paidSum = 0;
    for (const p of n.payments) {
      paidSum = r2(paidSum + (Number(p.amount) || 0));
      sumsHtml += "<div class='doc-pay'><span>Payment " + (p.date ? fmtDateLong(p.date) : "") + (p.method ? " · " + escapeHtml(p.method) : "") + "</span><b>−" + fmtMoney(p.amount) + "</b></div>";
    }
    sumsHtml += "<div class='est-grand doc-balance'><span>Balance due</span><b>" + fmtMoney(r2(n.totals.total - paidSum)) + "</b></div>";
  }
  sums.innerHTML = sumsHtml;
  host.appendChild(sums);

  if (n.schedule.length) {
    const h = document.createElement("div");
    h.className = "ev-sec-name";
    h.textContent = "Payment Schedule";
    host.appendChild(h);
    if (n.totals.depositAmt) {
      const dep = document.createElement("div");
      dep.className = "ev-row ev-sched";
      dep.innerHTML = "<span>Deposit</span><span></span><span></span><span>" + fmtMoney(n.totals.depositAmt) + "</span>";
      host.appendChild(dep);
    }
    for (const r of n.schedule) {
      const row = document.createElement("div");
      row.className = "ev-row ev-sched";
      row.innerHTML = "<span class='ev-sched-desc'>" + escapeHtml(r.desc || "") + "</span><span></span><span></span><span>" + fmtMoney(r.amount) + "</span>";
      host.appendChild(row);
    }
  }

  if (n.attachments.length) {
    const h = document.createElement("div");
    h.className = "ev-sec-name";
    h.textContent = "Attachments";
    host.appendChild(h);
    for (const a of n.attachments) {
      const row = document.createElement("button");
      row.className = "sub-doc-name ev-attach";
      row.textContent = "📎 " + a.name;
      row.addEventListener("click", () => {
        lightboxList = [{ id: a.id, name: a.name, mimeType: /\.pdf$/i.test(a.name) ? "application/pdf" : "" }];
        lightboxIndex = 0;
        openLightbox(lightboxList[0]);
      });
      host.appendChild(row);
    }
  }

  if (n.customerNotes) {
    const nb = document.createElement("div");
    nb.className = "doc-notes";
    nb.innerHTML = "<div class='ev-sec-name'>Notes</div><div>" + escapeHtml(n.customerNotes) + "</div>";
    host.appendChild(nb);
  }

  if (n.terms) {
    const tb = document.createElement("div");
    tb.className = "doc-terms";
    tb.innerHTML = "<div class='ev-sec-name'>Contract Terms</div><div class='ev-terms-text'>" + escapeHtml(n.terms) + "</div>";
    host.appendChild(tb);
  }

  const foot = document.createElement("div");
  foot.className = "doc-foot";
  foot.textContent = COMPANY.name + " · " + COMPANY.email;
  host.appendChild(foot);
}

// ----- Admin preview + PDF -----
let previewEstId = null;

function openEstPreview(id) {
  const e = estimates.find((x) => x.id === id);
  if (!e) return;
  previewEstId = id;
  previewInvId = null;
  const sb = $("est-send-btn");
  if (sb) {
    sb.classList.remove("hidden");
    const already = e.status === "sent" || e.status === "approved" || e.status === "declined" || e.sentAt;
    sb.textContent = already ? "📨 Update Customer" : "📨 Send to Customer";
  }
  renderEstimateDoc(e, $("est-preview-doc"));
  $("est-preview-modal").classList.remove("hidden");
}

const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";

async function urlToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch failed");
  const blob = await res.blob();
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok({ data: r.result, type: blob.type });
    r.onerror = bad;
    r.readAsDataURL(blob);
  });
}

async function fileIdToDataUrl(fileId) {
  const blob = await fetchFileBlobFast({ id: fileId });
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok({ data: r.result, type: blob.type });
    r.onerror = bad;
    r.readAsDataURL(blob);
  });
}

async function downloadEstPdf() {
  const isInv = !previewEstId && previewInvId;
  const e = isInv ? custInvoices.find((x) => x.id === previewInvId)
                  : estimates.find((x) => x.id === previewEstId);
  if (!e) return;
  const btn = $("est-pdf-btn");
  btn.disabled = true;
  btn.textContent = "Building PDF…";
  try {
    await loadScript(JSPDF_URL);
    await generateEstimatePdf(e, (msg) => { btn.textContent = msg; }, isInv ? "INVOICE" : "ESTIMATE");
    btn.textContent = "✓ Downloaded";
  } catch (err) {
    console.warn("pdf failed", err);
    btn.textContent = "✗ Failed — try again";
  }
  setTimeout(() => { btn.textContent = "⬇ Download PDF"; btn.disabled = false; }, 2500);
}

async function generateEstimatePdf(e, progress, kind) {
  const n = normalizeEstDoc(e);
  n.kind = kind || "ESTIMATE";
  n.payments = e.payments || [];
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "letter" });
  const W = 215.9, H = 279.4, M = 14, FOOT = 14;
  const NAVY = [15, 36, 64], RED = [200, 16, 46], SLATE = [64, 80, 106], GRAY = [138, 150, 168], LINE = [228, 233, 241];
  let y = M;

  const ensure = (need) => {
    if (y + need > H - M - FOOT) { doc.addPage(); y = M; }
  };
  const money = (v) => "$" + (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  // ---- Header ----
  let logoH = 0;
  try {
    progress && progress("Loading logo…");
    const logo = await urlToDataUrl(COMPANY.logo);
    const fmt = /png/i.test(logo.type) ? "PNG" : "JPEG";
    const lw = 42, lh = lw * 402 / 720;
    doc.addImage(logo.data, fmt, M, y, lw, lh);
    logoH = lh;
  } catch (err) {
    doc.setFont("helvetica", "bold").setFontSize(16).setTextColor(...NAVY);
    doc.text(COMPANY.name, M, y + 8);
    logoH = 12;
  }
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...SLATE);
  const coLines = [COMPANY.name, COMPANY.address, COMPANY.cityState, COMPANY.email];
  let cy = y + logoH + 5;
  doc.setFont("helvetica", "bold").setTextColor(...NAVY);
  doc.text(coLines[0], M, cy);
  doc.setFont("helvetica", "normal").setTextColor(...SLATE);
  for (let i = 1; i < coLines.length; i++) doc.text(coLines[i], M, cy + i * 4.4);
  const coBottom = cy + (coLines.length - 1) * 4.4;

  doc.setFont("helvetica", "bold").setFontSize(24).setTextColor(...RED);
  doc.text(n.kind, W - M, y + 8, { align: "right" });
  let my = y + 16;
  doc.setFontSize(9.5);
  const metaRows = [
    [n.kind === "INVOICE" ? "Invoice #" : "Estimate #", n.number],
    ["Date", n.date ? fmtDateLong(n.date) : ""],
    ["Expires", n.expires ? fmtDateLong(n.expires) : ""],
    ["Service address", n.serviceAddress]
  ].filter((r) => r[1]);
  for (const [k, v] of metaRows) {
    doc.setFont("helvetica", "normal").setTextColor(...GRAY);
    doc.text(k, W - M - 62, my, { align: "right" });
    doc.setFont("helvetica", "bold").setTextColor(...NAVY);
    doc.text(String(v), W - M, my, { align: "right", maxWidth: 58 });
    my += 5;
  }
  if (n.customerName || n.billingAddress) {
    my += 3;
    doc.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(...GRAY);
    doc.text("PREPARED FOR", W - M, my, { align: "right" });
    my += 4.4;
    doc.setFont("helvetica", "bold").setFontSize(10.5).setTextColor(...NAVY);
    if (n.customerName) { doc.text(n.customerName.toUpperCase(), W - M, my, { align: "right" }); my += 4.8; }
    if (n.billingAddress) {
      doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...SLATE);
      const bl = doc.splitTextToSize(n.billingAddress, 80);
      doc.text(bl, W - M, my, { align: "right" });
      my += bl.length * 4.2;
    }
  }
  y = Math.max(coBottom, my) + 5;
  doc.setDrawColor(...NAVY).setLineWidth(1.2);
  doc.line(M, y, W - M, y);
  y += 8;

  if (n.title) {
    doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(...NAVY);
    doc.text(n.title, M, y);
    y += 8;
  }
  if (n.status === "approved" && n.signedName) {
    doc.setFillColor(232, 246, 236);
    doc.rect(M, y - 4.5, W - 2 * M, 8, "F");
    doc.setFont("helvetica", "bold").setFontSize(9.5).setTextColor(28, 124, 60);
    doc.text("APPROVED — signed by " + n.signedName + (n.respondedAt ? " on " + new Date(n.respondedAt).toLocaleDateString("en-US") : ""), M + 3, y);
    y += 8;
  }

  // ---- Sections (columns follow the customer-display settings) ----
  const d = n.display;
  const colAmt = W - M;
  const colRate = d.amount ? W - M - 34 : W - M;
  const colQty = (d.rate && d.amount) ? W - M - 62 : (d.rate || d.amount) ? W - M - 34 : W - M;
  const descW = d.qty || d.rate || d.amount ? 110 : W - 2 * M - 6;
  for (const s of n.sections) {
    ensure(16);
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...NAVY);
    doc.text(s.name || "", M, y);
    doc.setDrawColor(...NAVY).setLineWidth(0.5);
    doc.line(M, y + 1.5, W - M, y + 1.5);
    y += 7;
    doc.setFont("helvetica", "bold").setFontSize(7).setTextColor(...GRAY);
    doc.text("DESCRIPTION", M, y);
    if (d.qty) doc.text("QTY", colQty, y, { align: "right" });
    if (d.rate) doc.text("RATE", colRate, y, { align: "right" });
    if (d.amount) doc.text("AMOUNT", colAmt, y, { align: "right" });
    y += 2;
    doc.setDrawColor(...LINE).setLineWidth(0.3);
    doc.line(M, y, W - M, y);
    y += 4.5;

    for (const it of s.items) {
      doc.setFont("helvetica", "normal").setFontSize(9.5);
      const descLines = doc.splitTextToSize(it.desc || "", descW);
      let noteLines = [];
      if (it.notes) {
        doc.setFontSize(8);
        noteLines = doc.splitTextToSize(it.notes, descW);
      }
      const rowH = descLines.length * 4.4 + noteLines.length * 3.8 + 3;
      ensure(rowH);
      doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(45, 58, 82);
      doc.text(descLines, M, y);
      if (d.qty && it.qty !== null) doc.text(String(it.qty), colQty, y, { align: "right" });
      if (d.rate && it.rate !== null) doc.text(money(it.rate), colRate, y, { align: "right" });
      doc.setFont("helvetica", "bold").setTextColor(...NAVY);
      if (d.amount && it.total !== null) doc.text(money(it.total), colAmt, y, { align: "right" });
      let iy = y + descLines.length * 4.4;
      if (noteLines.length) {
        doc.setFont("helvetica", "italic").setFontSize(8).setTextColor(...GRAY);
        doc.text(noteLines, M, iy);
        iy += noteLines.length * 3.8;
      }
      y = iy + 1;
      doc.setDrawColor(...LINE).setLineWidth(0.2);
      doc.line(M, y, W - M, y);
      y += 4;

      if ((it.photos || []).length) {
        progress && progress("Adding photos…");
        const size = 30, gap = 3;
        ensure(size + 4);
        let px = M;
        for (const p of it.photos.slice(0, 4)) {
          try {
            const img = await fileIdToDataUrl(p.id);
            const fmt = /png/i.test(img.type) ? "PNG" : "JPEG";
            doc.addImage(img.data, fmt, px, y, size, size, undefined, "MEDIUM");
            px += size + gap;
          } catch (err) {}
        }
        y += size + 5;
      }
    }
    if (d.sectionTotal && n.secTotals[s.id] !== undefined) {
      ensure(7);
      doc.setFont("helvetica", "bold").setFontSize(9.5).setTextColor(...NAVY);
      doc.text("Section subtotal", W - M - 40, y, { align: "right" });
      doc.text(money(n.secTotals[s.id]), colAmt, y, { align: "right" });
      y += 6;
    }
    y += 3;
  }

  // ---- Estimate photos ----
  if (n.photos.length) {
    progress && progress("Adding photos…");
    ensure(12);
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...NAVY);
    doc.text("Photos", M, y);
    doc.setDrawColor(...NAVY).setLineWidth(0.5);
    doc.line(M, y + 1.5, W - M, y + 1.5);
    y += 7;
    const size = 42, gap = 4, perRow = Math.floor((W - 2 * M + gap) / (size + gap));
    let col = 0;
    for (const p of n.photos.slice(0, 20)) {
      if (col === 0) ensure(size + 4);
      try {
        const img = await fileIdToDataUrl(p.id);
        const fmt = /png/i.test(img.type) ? "PNG" : "JPEG";
        doc.addImage(img.data, fmt, M + col * (size + gap), y, size, size, undefined, "MEDIUM");
      } catch (err) {}
      col++;
      if (col >= perRow) { col = 0; y += size + gap; }
    }
    if (col > 0) y += size + gap;
    y += 3;
  }

  // ---- Totals ----
  const tx = W - M - 70;
  const trow = (label, val, opts) => {
    ensure(6.5);
    doc.setFont("helvetica", opts && opts.bold ? "bold" : "normal")
       .setFontSize(opts && opts.big ? 13 : 9.5)
       .setTextColor(...(opts && opts.color ? opts.color : SLATE));
    doc.text(label, tx, y);
    doc.setFont("helvetica", "bold").setTextColor(...(opts && opts.color ? opts.color : NAVY));
    doc.text(val, colAmt, y, { align: "right" });
    y += opts && opts.big ? 7.5 : 5.5;
  };
  ensure(30);
  doc.setDrawColor(...NAVY).setLineWidth(0.8);
  doc.line(tx, y - 3, W - M, y - 3);
  trow("Subtotal", money(n.totals.subtotal));
  if (n.totals.discountAmt) trow("Discount", "-" + money(n.totals.discountAmt));
  if (n.totals.tax) trow("Tax", money(n.totals.tax));
  trow("Total", money(n.totals.total), { bold: true, big: true });
  if (n.totals.depositAmt) trow("Deposit due", money(n.totals.depositAmt), { color: RED });
  if (n.payments.length) {
    let paidSum = 0;
    for (const p of n.payments) {
      paidSum = r2(paidSum + (Number(p.amount) || 0));
      trow("Payment " + (p.date || "") + (p.method ? " · " + p.method : ""), "-" + money(p.amount));
    }
    trow("Balance due", money(r2(n.totals.total - paidSum)), { bold: true, big: true, color: RED });
  }
  y += 2;

  // ---- Payment schedule ----
  if (n.schedule.length || n.totals.depositAmt) {
    ensure(14);
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...NAVY);
    doc.text("Payment Schedule", M, y);
    doc.setDrawColor(...NAVY).setLineWidth(0.5);
    doc.line(M, y + 1.5, W - M, y + 1.5);
    y += 7;
    const srow = (label, amt) => {
      // Reserve the right column for the amount so long milestone text wraps
      // onto additional lines instead of running underneath it.
      const amtW = 34;
      const labelW = (W - 2 * M) - amtW - 6;
      doc.setFont("helvetica", "normal").setFontSize(9.5);
      const lines = doc.splitTextToSize(String(label || ""), labelW);
      const blockH = Math.max(lines.length * 4.4, 5);
      ensure(blockH + 5);
      doc.setTextColor(45, 58, 82);
      doc.text(lines, M, y);
      doc.setFont("helvetica", "bold").setTextColor(...NAVY);
      doc.text(money(amt), colAmt, y, { align: "right" });
      y += blockH - 0.6;
      doc.setDrawColor(...LINE).setLineWidth(0.2);
      doc.line(M, y, W - M, y);
      y += 4;
    };
    if (n.totals.depositAmt) srow("Deposit", n.totals.depositAmt);
    for (const r of n.schedule) srow(r.desc || "", r.amount);
    y += 2;
  }

  // ---- Attachments ----
  if (n.attachments.length) {
    ensure(12);
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...NAVY);
    doc.text("Attachments", M, y);
    y += 5.5;
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...SLATE);
    for (const a of n.attachments) {
      ensure(5);
      doc.text("• " + a.name, M, y);
      y += 4.6;
    }
    y += 2;
  }

  // ---- Notes ----
  if (n.customerNotes) {
    ensure(14);
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...NAVY);
    doc.text("Notes", M, y);
    y += 5.5;
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...SLATE);
    const nl = doc.splitTextToSize(n.customerNotes, W - 2 * M);
    for (const line of nl) { ensure(4.5); doc.text(line, M, y); y += 4.3; }
    y += 3;
  }

  // ---- Terms (paginated line by line — never cut off) ----
  if (n.terms) {
    ensure(14);
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...NAVY);
    doc.text("Contract Terms", M, y);
    doc.setDrawColor(...NAVY).setLineWidth(0.5);
    doc.line(M, y + 1.5, W - M, y + 1.5);
    y += 7;
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...SLATE);
    const tl = doc.splitTextToSize(n.terms, W - 2 * M);
    for (const line of tl) {
      ensure(4.2);
      doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...SLATE);
      doc.text(line, M, y);
      y += 3.9;
    }
    y += 4;
  }

  // ---- Signature block ----
  if (n.status === "approved" && n.signedName) {
    ensure(20);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(...SLATE);
    doc.text("Accepted and agreed:", M, y);
    y += 8;
    doc.setFont("helvetica", "bolditalic").setFontSize(13).setTextColor(...NAVY);
    doc.text(n.signedName, M, y);
    doc.setDrawColor(...SLATE).setLineWidth(0.3);
    doc.line(M, y + 2, M + 80, y + 2);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...GRAY);
    doc.text("Signature", M, y + 6);
    if (n.respondedAt) doc.text(new Date(n.respondedAt).toLocaleDateString("en-US"), M + 90, y);
  }

  // ---- Footer on EVERY page ----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const fy = H - M + 2;
    doc.setDrawColor(...RED).setLineWidth(0.8);
    doc.line(M, fy - 5, W - M, fy - 5);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...GRAY);
    doc.text(COMPANY.name + " · " + COMPANY.email, M, fy);
    doc.text("Page " + p + " of " + pages, W - M, fy, { align: "right" });
  }

  const name = safeName((n.number || n.kind) + (n.serviceAddress ? " - " + n.serviceAddress : "")) + ".pdf";
  doc.save(name);
}

// Push (or re-push) an estimate to the customer: flips status to "sent",
// clears any prior response so they can sign the revision, and notifies them.
async function sendEstimateToCustomer() {
  if (!previewEstId) return;
  const i = estimates.findIndex((x) => x.id === previewEstId);
  if (i < 0) return;
  const e = estimates[i];
  const btn = $("est-send-btn");
  const wasResponded = e.status === "approved" || e.status === "declined";
  const revised = wasResponded || e.sentAt;

  let msg;
  if (revised) {
    msg = "Send the REVISED estimate " + (e.number || "") + " to the customer?\n\n" +
          (wasResponded ? "This clears their previous " + e.status + " response — they'll need to review and sign again.\n\n" : "") +
          "They'll see the updated version immediately.";
  } else {
    msg = "Send estimate " + (e.number || "") + " to the customer?\n\nThey'll be able to review and sign it in their portal.";
  }
  if (!confirm(msg)) return;

  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    e.status = "sent";
    e.sentAt = new Date().toISOString();
    if (wasResponded) {
      e.respondedAt = "";
      e.signedName = "";
      e.respondedBy = "";
      // keep e.budgeted so an already-converted estimate can't double-post
    }
    e.revision = (Number(e.revision) || 0) + (revised ? 1 : 0);
    estimates[i] = e;
    await saveEstimates();

    // Ping every customer on this project: bell notification + a message
    const custs = projectMembers().filter((m) => m.role === "customer").map((m) => m.email);
    if (custs.length) {
      const label = (e.number ? e.number + " " : "") + (e.title || "estimate");
      const noteTxt = revised
        ? "Revised estimate " + label + " is ready to review and sign."
        : "New estimate " + label + " is ready to review and sign.";
      try {
        // bell notification
        await api({
          action: "notify", email: SESSION.email, code: SESSION.code,
          project: currentProject.name, kind: "estimate",
          summary: noteTxt, notify: custs
        });
      } catch (err) { console.warn("notify failed", err); }
      // message into each customer's thread
      for (const c of custs) {
        try {
          await api({
            action: "sendMessage", email: SESSION.email, code: SESSION.code,
            to: c, text: noteTxt + " Open the Estimates tab to view it."
          });
        } catch (err) { console.warn("message failed", err); }
      }
    }

    btn.textContent = revised ? "✓ Revision sent" : "✓ Sent";
    render();
  } catch (err) {
    btn.textContent = "✗ Failed — try again";
  }
  setTimeout(() => {
    btn.textContent = "📨 Send to Customer";
    btn.disabled = false;
  }, 2600);
}

// ----- Customer view -----
function openEstView(id) {
  const e = estimates.find((x) => x.id === id);
  if (!e) return;
  viewingEstId = id;
  renderEstimateDoc(e, $("ev-doc"));
  const open = e.status === "sent" && !isAdmin();
  $("ev-sign-row").classList.toggle("hidden", !open);
  $("ev-sign-name").value = "";
  $("ev-agree").checked = false;
  $("ev-approve").classList.toggle("hidden", !open);
  $("ev-decline").classList.toggle("hidden", !open);
  $("est-view-modal").classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function respondEstimate(response) {
  const btn = response === "approved" ? $("ev-approve") : $("ev-decline");
  let signature = "";
  if (response === "approved") {
    signature = $("ev-sign-name").value.trim();
    if (!signature) { alert("Please type your full name to sign."); return; }
    if (!$("ev-agree").checked) { alert("Please check the box to agree to the terms."); return; }
  } else {
    if (!confirm("Decline this estimate?")) return;
  }
  btn.disabled = true;
  try {
    const out = await api({ action: "estimateRespond", email: SESSION.email, code: SESSION.code, project: currentProject.name, estId: viewingEstId, response, signature });
    if (!out.ok) throw new Error(out.error || "failed");
    const i = estimates.findIndex((x) => x.id === viewingEstId);
    if (i >= 0) estimates[i] = out.estimate;
    closeModal("est-view-modal");
    // approval creates budget lines server-side — pull fresh data
    loadState().then(render);
  } catch (e) {
    alert("Couldn't submit: " + e.message);
  }
  btn.disabled = false;
}

// ---------- Time Clock (ADMIN ONLY) ----------
let clockTimer = null;

function hoursBetween(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const ms = new Date(endIso) - new Date(startIso);
  return ms > 0 ? Math.round((ms / 3600000) * 100) / 100 : 0;
}

function fmtHrs(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return hh + "h " + String(mm).padStart(2, "0") + "m";
}

function fmtClock(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// datetime-local wants local time, not UTC
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 16);
}
function fromLocalInput(v) {
  return v ? new Date(v).toISOString() : "";
}

function openEntry() {
  return timeEntries.find((e) => !e.end) || null;
}

function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());   // Sunday
  return x;
}

function renderTime() {
  const open = openEntry();
  const btn = $("clock-btn");
  const status = $("clock-status");

  // --- the big button ---
  if (open) {
    btn.className = "clock-btn out";
    btn.innerHTML = "<span class='cb-label'>Clock Out</span><span class='cb-timer' id='cb-timer'>0h 00m</span>";
    status.innerHTML = "<b>On the clock at " + escapeHtml(shortProject(open.project)) + "</b>" +
      "<span>Since " + fmtClock(open.start) + "</span>";
    status.className = "clock-status running";
    if (!clockTimer) clockTimer = setInterval(tickClock, 1000);
    tickClock();
  } else {
    btn.className = "clock-btn in";
    btn.innerHTML = "<span class='cb-label'>Clock In</span><span class='cb-sub'>" +
      escapeHtml(shortProject(currentProject.name)) + "</span>";
    status.innerHTML = "<span>Not clocked in. Tap to start on " +
      escapeHtml(shortProject(currentProject.name)) + ".</span>";
    status.className = "clock-status";
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }

  // --- totals ---
  const now = new Date();
  const todayKey = now.toDateString();
  const ws = weekStart(now);
  let todayH = 0, weekH = 0;
  const byProject = {};
  for (const e of timeEntries) {
    const h = e.end ? hoursBetween(e.start, e.end) : hoursBetween(e.start, new Date().toISOString());
    const d = new Date(e.start);
    if (d.toDateString() === todayKey) todayH += h;
    if (d >= ws) {
      weekH += h;
      byProject[e.project] = (byProject[e.project] || 0) + h;
    }
  }
  $("time-today").textContent = fmtHrs(todayH);
  $("time-week").textContent = fmtHrs(weekH);

  // --- per-property breakdown this week ---
  const bp = $("time-by-project");
  bp.innerHTML = "";
  const keys = Object.keys(byProject).sort((a, b) => byProject[b] - byProject[a]);
  if (keys.length) {
    const t = document.createElement("div");
    t.className = "tc-sub-title";
    t.textContent = "This week by property";
    bp.appendChild(t);
    for (const k of keys) {
      const row = document.createElement("div");
      row.className = "tc-proj-row";
      row.innerHTML = "<span>" + escapeHtml(shortProject(k)) + "</span><b>" + fmtHrs(byProject[k]) + "</b>";
      bp.appendChild(row);
    }
  }

  // --- entry list, newest first, grouped by day ---
  const list = $("time-list");
  list.innerHTML = "";
  const sorted = timeEntries.slice().sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  $("time-empty").classList.toggle("hidden", sorted.length > 0);

  let lastDay = "";
  for (const e of sorted) {
    const day = new Date(e.start).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const dh = document.createElement("div");
      dh.className = "tc-day";
      const dayH = sorted.filter((x) => new Date(x.start).toDateString() === day)
        .reduce((s, x) => s + (x.end ? hoursBetween(x.start, x.end) : 0), 0);
      dh.innerHTML = "<span>" + new Date(e.start).toLocaleDateString("en-US",
        { weekday: "short", month: "short", day: "numeric" }) + "</span><b>" + fmtHrs(dayH) + "</b>";
      list.appendChild(dh);
    }
    const row = document.createElement("div");
    row.className = "tc-row" + (e.end ? "" : " open");
    const left = document.createElement("div");
    left.className = "tc-left";
    const p = document.createElement("div");
    p.className = "tc-proj";
    p.textContent = shortProject(e.project);
    left.appendChild(p);
    const t = document.createElement("div");
    t.className = "tc-times";
    t.textContent = fmtClock(e.start) + " – " + (e.end ? fmtClock(e.end) : "running") +
      (e.note ? "  ·  " + e.note : "");
    left.appendChild(t);
    row.appendChild(left);
    const h = document.createElement("div");
    h.className = "tc-hours";
    h.textContent = e.end ? fmtHrs(hoursBetween(e.start, e.end)) : "—";
    row.appendChild(h);
    row.addEventListener("click", () => openTimeModal(e.id));
    list.appendChild(row);
  }
}

function tickClock() {
  const open = openEntry();
  const el = $("cb-timer");
  if (!open || !el) return;
  const ms = Date.now() - new Date(open.start);
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  el.textContent = hh + "h " + String(mm).padStart(2, "0") + "m " + String(ss).padStart(2, "0") + "s";
}

async function toggleClock() {
  const open = openEntry();
  const btn = $("clock-btn");
  btn.disabled = true;
  if (open) {
    open.end = new Date().toISOString();
  } else {
    timeEntries.push({
      id: "t" + Date.now(),
      project: currentProject.name,
      start: new Date().toISOString(),
      end: "",
      note: ""
    });
  }
  await saveTimeEntries();
  btn.disabled = false;
  render();
}

function openTimeModal(id) {
  editingTimeId = id || null;
  const e = id ? timeEntries.find((x) => x.id === id) : null;
  $("time-modal-title").textContent = e ? "Edit Time Entry" : "Add Time Entry";
  const sel = $("time-project");
  sel.innerHTML = "";
  for (const p of SESSION.projects) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = shortProject(p.name);
    sel.appendChild(o);
  }
  sel.value = e ? e.project : currentProject.name;
  $("time-start").value = e ? toLocalInput(e.start) : toLocalInput(new Date().toISOString());
  $("time-end").value   = e ? toLocalInput(e.end)   : "";
  $("time-note").value  = e ? (e.note || "") : "";
  $("time-delete").classList.toggle("hidden", !e);
  updateTimeModalHours();
  $("time-modal").classList.remove("hidden");
}

function updateTimeModalHours() {
  const s = fromLocalInput($("time-start").value);
  const en = fromLocalInput($("time-end").value);
  const h = hoursBetween(s, en);
  $("time-calc").textContent = en ? fmtHrs(h) + "  (" + h.toFixed(2) + " hrs)" : "Still running";
}

async function saveTimeEntry() {
  const s = fromLocalInput($("time-start").value);
  if (!s) { alert("Enter a start time."); return; }
  const en = fromLocalInput($("time-end").value);
  if (en && new Date(en) <= new Date(s)) { alert("Clock-out must be after clock-in."); return; }
  const data = {
    project: $("time-project").value,
    start: s,
    end: en,
    note: $("time-note").value.trim()
  };
  if (editingTimeId) {
    const i = timeEntries.findIndex((x) => x.id === editingTimeId);
    if (i >= 0) timeEntries[i] = { ...timeEntries[i], ...data };
  } else {
    timeEntries.push({ id: "t" + Date.now(), ...data });
  }
  await saveTimeEntries();
  closeModal("time-modal");
  render();
}

async function deleteTimeEntry() {
  if (!confirm("Delete this time entry?")) return;
  timeEntries = timeEntries.filter((x) => x.id !== editingTimeId);
  await saveTimeEntries();
  closeModal("time-modal");
  render();
}

// Export the visible week as CSV
function exportTimeCsv() {
  const ws = weekStart(new Date());
  const rows = [["Date", "Property", "Clock In", "Clock Out", "Hours", "Note"]];
  timeEntries
    .filter((e) => new Date(e.start) >= ws)
    .sort((a, b) => (a.start || "").localeCompare(b.start || ""))
    .forEach((e) => {
      rows.push([
        new Date(e.start).toLocaleDateString("en-US"),
        e.project,
        fmtClock(e.start),
        e.end ? fmtClock(e.end) : "",
        e.end ? hoursBetween(e.start, e.end).toFixed(2) : "",
        (e.note || "").replace(/"/g, '""')
      ]);
    });
  const csv = rows.map((r) => r.map((c) => '"' + String(c) + '"').join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "URR-timesheet-" + ws.toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- Building Codes & References ----------
const CODE_LIBRARY = [
  {
    group: "Adopted Building Codes — Idaho",
    note: "Idaho adopts the 2018 I-Codes with state amendments. Free read-only access via the ICC Digital Codes library.",
    items: [
      { name: "2018 IRC — International Residential Code", sub: "One- and two-family dwellings. The primary code for most URR work.", url: "https://codes.iccsafe.org/content/IRC2018P4" },
      { name: "2018 IBC — International Building Code", sub: "Commercial and multi-family structures.", url: "https://codes.iccsafe.org/content/IBC2018P4" },
      { name: "2018 IEBC — International Existing Building Code", sub: "Alterations, repairs and additions to existing buildings.", url: "https://codes.iccsafe.org/content/IEBC2018P4" },
      { name: "2018 IECC — Energy Conservation Code", sub: "Insulation, fenestration U-factors, air sealing. Referenced in the envelope table on A1.1.", url: "https://codes.iccsafe.org/content/IECC2018P4" },
      { name: "2018 IMC — International Mechanical Code", sub: "HVAC, ducting, ventilation.", url: "https://codes.iccsafe.org/content/IMC2018P4" },
      { name: "2018 IPC — International Plumbing Code", sub: "Plumbing systems and fixtures.", url: "https://codes.iccsafe.org/content/IPC2018P4" },
      { name: "2018 IFGC — International Fuel Gas Code", sub: "Gas piping and appliances.", url: "https://codes.iccsafe.org/content/IFGC2018P4" },
      { name: "2018 IFC — International Fire Code", sub: "Fire protection and life safety.", url: "https://codes.iccsafe.org/content/IFC2018P4" }
    ]
  },
  {
    group: "Electrical",
    items: [
      { name: "NFPA 70 — National Electrical Code", sub: "Free read-only access. Idaho adopts the NEC statewide.", url: "https://www.nfpa.org/codes-and-standards/nfpa-70-standard-development/70" },
      { name: "Idaho Division of Building Safety — Electrical", sub: "State amendments, licensing and permit rules.", url: "https://dbs.idaho.gov/programs/electrical/" }
    ]
  },
  {
    group: "City of Boise",
    items: [
      { name: "Boise Planning & Development Services", sub: "Permits, inspections, plan review.", url: "https://www.cityofboise.org/departments/planning-and-development-services/" },
      { name: "Boise Permit & Inspection Portal", sub: "Look up permit status, schedule inspections.", url: "https://developmentservices.cityofboise.org/" },
      { name: "Boise Building Code Amendments", sub: "Local amendments to the adopted I-Codes.", url: "https://www.cityofboise.org/departments/planning-and-development-services/building/" }
    ]
  },
  {
    group: "State of Idaho",
    items: [
      { name: "Idaho Division of Building Safety", sub: "Adopted codes, amendments and state programs.", url: "https://dbs.idaho.gov/" },
      { name: "Idaho Contractor Registration", sub: "Verify or renew registration. Required for URR and subs.", url: "https://dbs.idaho.gov/programs/contractors/" },
      { name: "Idaho Code 45-525 — Contractor Disclosure", sub: "The disclosure statement quoted in URR contract terms.", url: "https://legislature.idaho.gov/statutesrules/idstat/Title45/T45CH5/SECT45-525/" }
    ]
  },
  {
    group: "Referenced Standards — from plan general notes",
    note: "Standards called out on sheet A1.1 for 2515 Bannock.",
    items: [
      { name: "ACI 318 — Structural Concrete", sub: "Concrete design and reinforcement placement.", url: "https://www.concrete.org/store/productdetail.aspx?ItemID=318U19" },
      { name: "ASTM A615 — Reinforcing Steel", sub: "Grade 60 deformed bars.", url: "https://www.astm.org/a0615_a0615m-22.html" },
      { name: "ASTM A307 — Anchor Bolts", sub: "Carbon steel bolts for foundation anchorage.", url: "https://www.astm.org/a0307-21.html" },
      { name: "APA — Engineered Wood Association", sub: "Sheathing, span ratings, nailing schedules.", url: "https://www.apawood.org/" },
      { name: "WWPA — Lumber Grading Rules", sub: "Douglas Fir-Larch grading referenced in the framing notes.", url: "https://www.wwpa.org/" },
      { name: "Simpson Strong-Tie", sub: "Connector specs and installation. Called out in the nailing schedule.", url: "https://www.strongtie.com/" },
      { name: "ACCA Manual J", sub: "Residential HVAC load calculation, per the design criteria table.", url: "https://www.acca.org/standards/technical-manuals" }
    ]
  }
];

function renderCodes() {
  const host = $("codes-list");
  host.innerHTML = "";
  for (const g of CODE_LIBRARY) {
    const sec = document.createElement("div");
    sec.className = "code-group";
    const h = document.createElement("div");
    h.className = "code-group-title";
    h.textContent = g.group;
    sec.appendChild(h);
    if (g.note) {
      const n = document.createElement("div");
      n.className = "code-group-note";
      n.textContent = g.note;
      sec.appendChild(n);
    }
    for (const it of g.items) {
      const a = document.createElement("a");
      a.className = "code-link";
      a.href = it.url;
      a.target = "_blank";
      a.rel = "noopener";
      const nm = document.createElement("div");
      nm.className = "code-link-name";
      nm.textContent = it.name;
      a.appendChild(nm);
      if (it.sub) {
        const s = document.createElement("div");
        s.className = "code-link-sub";
        s.textContent = it.sub;
        a.appendChild(s);
      }
      sec.appendChild(a);
    }
    host.appendChild(sec);
  }
}

// ---------- Field Calc ----------
function renderCalc() {
  const frame = $("calc-frame");
  if (frame && !frame.getAttribute("src")) {
    frame.setAttribute("src", "calc.html?v=126");
  }
}

// ---------- Subs ----------
let subFilesData = null;   // admin-only: [{id, name, files:[...]}]
let subFilesLoading = false;

function subFileKey(s) {
  return (s.email || s.company || s.name || "").trim();
}

async function loadSubFiles() {
  if (subFilesLoading) return;
  subFilesLoading = true;
  try {
    const out = await api({ action: "subFiles", email: SESSION.email, code: SESSION.code });
    if (out.ok) { subFilesData = out.groups || []; render(); }
  } catch (e) { console.warn("subFiles load failed", e); }
  subFilesLoading = false;
}

function subDocsBlock(s) {
  const key = subFileKey(s);
  const wrap = document.createElement("div");
  wrap.className = "sub-docs";
  const title = document.createElement("div");
  title.className = "sub-docs-title";
  title.textContent = "📁 Documents (admin only)";
  wrap.appendChild(title);

  const group = (subFilesData || []).find((g) => g.name.toLowerCase() === key.toLowerCase());
  const files = group ? group.files : [];
  if (subFilesData === null) {
    const ld = document.createElement("div");
    ld.className = "sub-doc-empty";
    ld.textContent = "Loading…";
    wrap.appendChild(ld);
  } else if (files.length === 0) {
    const em = document.createElement("div");
    em.className = "sub-doc-empty";
    em.textContent = "No documents yet — add their W9, insurance cert, license…";
    wrap.appendChild(em);
  } else {
    for (const f of files) {
      const row = document.createElement("div");
      row.className = "sub-doc-row";
      const nm = document.createElement("button");
      nm.className = "sub-doc-name";
      nm.textContent = (isPdf(f) ? "📄 " : isImage(f) ? "🖼️ " : "📎 ") + f.name;
      nm.addEventListener("click", (e) => { e.stopPropagation(); lightboxList = [f]; lightboxIndex = 0; openLightbox(f); });
      row.appendChild(nm);
      const del = document.createElement("button");
      del.className = "sub-doc-del";
      del.textContent = "🗑";
      del.title = "Delete";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm('Delete "' + f.name + '"?')) return;
        del.disabled = true;
        try {
          const out = await api({ action: "deleteFile", email: SESSION.email, code: SESSION.code, fileId: f.id });
          if (!out.ok) throw new Error(out.error || "failed");
          subFilesData = null;
          loadSubFiles();
        } catch (err) { alert("Couldn't delete: " + err.message); del.disabled = false; }
      });
      row.appendChild(del);
      wrap.appendChild(row);
    }
  }

  const bar = document.createElement("div");
  bar.className = "sub-doc-addbar";
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.display = "none";
  const btn = document.createElement("button");
  btn.className = "btn-ghost sub-doc-add";
  btn.textContent = "+ Add document";
  btn.addEventListener("click", (e) => { e.stopPropagation(); input.click(); });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("change", async () => {
    const list = Array.from(input.files || []);
    if (!list.length) return;
    btn.disabled = true;
    let n = 0;
    for (const file of list) {
      n++;
      btn.textContent = "Uploading " + n + " of " + list.length + "…";
      try {
        await uploadOne(file, { destArea: "subfiles", destFolderName: key, notify: [] });
      } catch (err) { console.warn("sub doc upload failed", err); }
    }
    btn.textContent = "+ Add document";
    btn.disabled = false;
    subFilesData = null;
    loadSubFiles();
  });
  bar.appendChild(btn);
  bar.appendChild(input);
  wrap.appendChild(bar);
  return wrap;
}

function renderCalcAccess(host) {
  if (!isAdmin()) return;
  const wrap = document.createElement("div");
  wrap.className = "calc-access";
  const lbl = document.createElement("div");
  lbl.className = "calc-access-lbl";
  lbl.textContent = "🧮 Field Calc access — tap a name to give them the Calc tab";
  wrap.appendChild(lbl);

  const chips = document.createElement("div");
  chips.className = "album-perms";
  const people = (SESSION.members && SESSION.members.length ? SESSION.members : presenceRosterList())
    .filter((u) => u.role !== "admin");
  if (!people.length) {
    const em = document.createElement("span");
    em.className = "calc-access-empty";
    em.textContent = "No sub or customer accounts yet.";
    chips.appendChild(em);
  }
  for (const u of people) {
    const on = calcAccess.indexOf(String(u.email).toLowerCase()) !== -1;
    const chip = document.createElement("button");
    chip.className = "perm-chip" + (on ? " on" : "");
    chip.textContent = (on ? "✓ " : "") + u.email + " (" + u.role + ")";
    chip.addEventListener("click", async () => {
      const e = String(u.email).toLowerCase();
      calcAccess = on ? calcAccess.filter((x) => x !== e) : calcAccess.concat([e]);
      await saveCalcAccess();
      render();
    });
    chips.appendChild(chip);
  }
  wrap.appendChild(chips);
  host.appendChild(wrap);
}

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

    card.appendChild(subDocsBlock(s));

    card.addEventListener("click", (e) => {
      if (e.target.tagName === "A") return;
      if (e.target.closest && e.target.closest(".sub-docs")) return;
      openSubModal(s.id);
    });
    list.appendChild(card);
  }
  if (subFilesData === null) loadSubFiles();
  renderCalcAccess(list);
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

let lightboxBlobUrl = null;
let lightboxToken = 0;

function isPdf(f) {
  return /pdf/i.test(f.mimeType || "") || /\.pdf$/i.test(f.name || "");
}

function freeLightboxBlob() {
  if (lightboxBlobUrl) { try { URL.revokeObjectURL(lightboxBlobUrl); } catch (e) {} lightboxBlobUrl = null; }
}

// File bytes come from OUR backend — the client never touches Drive URLs.
async function fetchFileBlob(f) {
  const out = await api({ action: "fileData", email: SESSION.email, code: SESSION.code, project: currentProject.name, fileId: f.id });
  if (!out.ok) throw new Error(out.error || "fetch failed");
  const bin = atob(out.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: out.mimeType || "application/octet-stream" });
}

// Fast path: direct media fetch (no Apps Script round-trip), backend fallback.
async function fetchFileBlobFast(f) {
  try {
    const res = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(f.id) +
      "?alt=media&key=" + encodeURIComponent(SESSION.apiKey || ""));
    if (res.ok) return await res.blob();
  } catch (e) {}
  return fetchFileBlob(f);
}

// ---------- Lazy script loading (pdf.js, JSZip) ----------
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector('script[src="' + src + '"]')) return res();
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("script load failed"));
    document.head.appendChild(s);
  });
}

const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

async function ensurePdfJs() {
  await loadScript(PDFJS_URL);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  return window.pdfjsLib;
}

// ---------- Multi-select + ZIP download ----------
let selectMode = false;
let selectedIds = new Set();
let zipBusy = false;

function toggleSelectMode(on) {
  selectMode = on;
  selectedIds = new Set();
  render();
}

function safeName(s) { return String(s || "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "file"; }

async function downloadSelectedZip(btn) {
  if (zipBusy || selectedIds.size === 0) return;
  zipBusy = true;
  const files = allFiles.filter((f) => selectedIds.has(f.id));
  const orig = btn.textContent;
  try {
    btn.disabled = true;
    btn.textContent = "Preparing…";
    await loadScript(JSZIP_URL);
    const zip = new window.JSZip();

    // Fetch in parallel (6 at a time) instead of one by one
    const results = new Array(files.length);
    let next = 0, done = 0, failed = 0;
    async function worker() {
      while (next < files.length) {
        const i = next++;
        try {
          results[i] = await fetchFileBlobFast(files[i]);
        } catch (e) {
          results[i] = null;
          failed++;
        }
        done++;
        btn.textContent = "Fetching " + done + " of " + files.length + "…";
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));

    const used = {};
    for (let i = 0; i < files.length; i++) {
      if (!results[i]) continue;
      const f = files[i];
      let name = safeName(f.name);
      if (used[name.toLowerCase()]) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        name = stem + " (" + used[name.toLowerCase()] + ")" + ext;
      }
      used[safeName(f.name).toLowerCase()] = (used[safeName(f.name).toLowerCase()] || 0) + 1;
      zip.file(name, results[i]);
      results[i] = null; // free as we go
    }
    if (failed === files.length) throw new Error("all fetches failed");
    const out = await zip.generateAsync({ type: "blob" }, (meta) => {
      btn.textContent = "Zipping… " + Math.round(meta.percent) + "%";
    });
    const url = URL.createObjectURL(out);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeName(currentProject.name) + " - " + safeName(activeTab) + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    zipBusy = false;
    toggleSelectMode(false);
    return;
  } catch (e) {
    console.warn("zip failed", e);
    btn.textContent = "✗ Failed — try again";
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
  }
  zipBusy = false;
}

function buildSelectBar(list, fileCount) {
  const bar = document.createElement("div");
  bar.className = "select-bar";
  if (!selectMode) {
    if (fileCount === 0) return null;
    const b = document.createElement("button");
    b.className = "btn-ghost select-toggle";
    b.textContent = "☑ Select files";
    b.addEventListener("click", () => toggleSelectMode(true));
    bar.appendChild(b);
    return bar;
  }
  const dl = document.createElement("button");
  dl.className = "btn-primary select-dl";
  dl.textContent = selectedIds.size === 0
    ? "Tap files to select"
    : "⬇ Download " + selectedIds.size + " as ZIP";
  dl.disabled = selectedIds.size === 0;
  dl.addEventListener("click", () => downloadSelectedZip(dl));
  bar.appendChild(dl);

  const all = document.createElement("button");
  all.className = "btn-ghost";
  const hereFiles = () => {
    const path = navPathByTab[activeTab] || "";
    return visibleFiles().filter((f) => (f.albumName || "") === path);
  };
  const here = hereFiles();
  const allSelected = here.length > 0 && here.every((f) => selectedIds.has(f.id));
  all.textContent = allSelected ? "Deselect all" : "Select all";
  all.addEventListener("click", () => {
    const hf = hereFiles();
    const everything = hf.length > 0 && hf.every((f) => selectedIds.has(f.id));
    for (const f of hf) {
      if (everything) selectedIds.delete(f.id);
      else selectedIds.add(f.id);
    }
    render();
  });
  bar.appendChild(all);

  const cancel = document.createElement("button");
  cancel.className = "btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => toggleSelectMode(false));
  bar.appendChild(cancel);
  return bar;
}

// ---------- In-portal PDF viewer (our UI only — no browser/Drive toolbar) ----------
let lbPdfDoc = null;
let lbPdfZoom = 1;

async function showPdfInLightbox(f, token) {
  const box = $("lightbox-pdf");
  const pages = $("lightbox-pdf-pages");
  const zoomBar = $("lightbox-pdf-zoom");
  box.classList.remove("hidden");
  zoomBar.classList.add("hidden");
  pages.innerHTML = '<div class="pdf-loading">Loading document…</div>';
  const pdfjs = await ensurePdfJs();
  const blob = await fetchFileBlobFast(f);
  if (token !== lightboxToken) return;
  const buf = await blob.arrayBuffer();
  if (token !== lightboxToken) return;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  if (token !== lightboxToken) { doc.destroy(); return; }
  lbPdfDoc = doc;
  lbPdfZoom = 1;
  await renderPdfPages(token);
  if (token === lightboxToken) zoomBar.classList.remove("hidden");
}

async function renderPdfPages(token) {
  const doc = lbPdfDoc;
  if (!doc) return;
  const pages = $("lightbox-pdf-pages");
  const box = $("lightbox-pdf");
  const scrollFrac = box.scrollHeight > 0 ? box.scrollTop / box.scrollHeight : 0;
  pages.innerHTML = "";
  $("pdf-zoom-pct").textContent = Math.round(lbPdfZoom * 100) + "%";
  const availW = Math.min(box.clientWidth - 24, 1400);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (let n = 1; n <= doc.numPages; n++) {
    if (token !== lightboxToken || doc !== lbPdfDoc) return;
    const page = await doc.getPage(n);
    if (token !== lightboxToken || doc !== lbPdfDoc) return;
    const base = page.getViewport({ scale: 1 });
    const scale = (availW / base.width) * lbPdfZoom;
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page";
    canvas.width = vp.width;
    canvas.height = vp.height;
    canvas.style.width = (vp.width / dpr) + "px";
    canvas.style.height = (vp.height / dpr) + "px";
    pages.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  }
  box.scrollTop = scrollFrac * box.scrollHeight;
}

function closePdfViewer() {
  if (lbPdfDoc) { try { lbPdfDoc.destroy(); } catch (e) {} lbPdfDoc = null; }
  $("lightbox-pdf-pages").innerHTML = "";
  $("lightbox-pdf").classList.add("hidden");
  $("lightbox-pdf-zoom").classList.add("hidden");
}

function openLightbox(f) {
  const img = $("lightbox-img");
  const frame = $("lightbox-frame");
  const token = ++lightboxToken;
  freeLightboxBlob();
  closePdfViewer();

  if (isImage(f)) {
    img.src = thumbUrl(f, 1600);
    img.classList.remove("hidden");
    frame.classList.add("hidden");
    frame.src = "";
    img.onerror = () => {
      img.onerror = null;
      estBlobUrl(f.id).then((u) => { if (token === lightboxToken) img.src = u; }).catch(() => {});
    };
  } else if (isPdf(f)) {
    // Our own pdf.js viewer — no browser toolbar, no Drive UI, no popout,
    // works the same on desktop and mobile. Fallbacks: blob iframe, then
    // Drive preview, only if rendering fails.
    img.classList.add("hidden");
    img.src = "";
    frame.classList.add("hidden");
    frame.src = "";
    showPdfInLightbox(f, token).catch(() => {
      if (token !== lightboxToken) return;
      closePdfViewer();
      frame.classList.remove("hidden");
      fetchFileBlob(f).then((blob) => {
        if (token !== lightboxToken) return;
        lightboxBlobUrl = URL.createObjectURL(blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" }));
        frame.src = lightboxBlobUrl + "#toolbar=0";
      }).catch(() => {
        if (token !== lightboxToken) return;
        frame.src = "https://drive.google.com/file/d/" + encodeURIComponent(f.id) + "/preview";
      });
    });
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
  const dlBtn = $("lightbox-download");
  if (dlBtn) {
    dlBtn.classList.remove("hidden");
    dlBtn.onclick = (e) => { e.stopPropagation(); downloadLightboxFile(f, dlBtn); };
  }
  $("lightbox").classList.remove("hidden");
}

async function downloadLightboxFile(f, btn) {
  const orig = "⬇ Download";
  btn.textContent = "Downloading…";
  btn.disabled = true;
  try {
    const blob = await fetchFileBlobFast(f);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    btn.textContent = "✓ Downloaded";
    setTimeout(() => { btn.textContent = orig; }, 3000);
  } catch (e) {
    btn.textContent = "✗ Failed — tap to retry";
    setTimeout(() => { btn.textContent = orig; }, 4000);
  }
  btn.disabled = false;
}
function closeLightbox() {
  lightboxList = [];
  lightboxIndex = -1;
  lightboxToken++;
  freeLightboxBlob();
  closePdfViewer();
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
  for (const id of ["task-modal", "budget-modal", "log-modal", "sub-modal", "task-view-modal", "est-modal", "est-view-modal", "est-preview-modal", "cost-modal", "time-modal"]) {
    $(id).addEventListener("click", (e) => { if (e.target.id === id) closeModal(id); });
  }

  $("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

  $("inv-submit").addEventListener("click", submitInvoice);
  $("bid-submit").addEventListener("click", submitBid);
  $("scan-launch-btn").addEventListener("click", (e) => launchCubiCasa(e.currentTarget));
  $("scan-upload-btn").addEventListener("click", () => $("scan-upload-input").click());
  $("scan-upload-input").addEventListener("change", () => {
    const files = Array.from($("scan-upload-input").files || []);
    if (files.length) uploadScanFiles(files, $("scan-upload-btn"));
    $("scan-upload-input").value = "";
  });
  $("scan-store-link").href = CUBICASA_APPSTORE;
  $("clock-btn").addEventListener("click", toggleClock);
  $("time-add-btn").addEventListener("click", () => openTimeModal(null));
  $("time-export-btn").addEventListener("click", exportTimeCsv);
  $("time-save").addEventListener("click", saveTimeEntry);
  $("time-cancel").addEventListener("click", () => closeModal("time-modal"));
  $("time-delete").addEventListener("click", deleteTimeEntry);
  $("time-start").addEventListener("input", updateTimeModalHours);
  $("time-end").addEventListener("input", updateTimeModalHours);

  $("add-cost-btn").addEventListener("click", () => openCostModal(null));
  $("cost-save").addEventListener("click", saveCost);
  $("cost-cancel").addEventListener("click", () => closeModal("cost-modal"));
  $("cost-delete").addEventListener("click", deleteCost);

  $("add-est-btn").addEventListener("click", () => openEstModal(null));
  $("est-add-section").addEventListener("click", () => {
    estDraft.sections.push({ id: "s" + Date.now(), name: "", items: [blankItem()] });
    renderEstSections();
  });
  ["est-taxrate", "est-gm-val", "est-disc-val", "est-dep-val"].forEach((id) =>
    $(id).addEventListener("input", () => updateEstSummary()));
  ["est-gm-type", "est-disc-type", "est-dep-type"].forEach((id) =>
    $(id).addEventListener("change", () => updateEstSummary()));
  $("est-add-sched").addEventListener("click", () => {
    estDraft.schedule.push({ desc: nextDrawLabel(), type: "%", value: 0 });
    renderEstSchedule();
  });
  $("est-add-photos").addEventListener("click", () => $("est-photos-input").click());
  $("est-photos-input").addEventListener("change", async () => {
    const files = Array.from($("est-photos-input").files || []).slice(0, 20 - (estDraft.photos || []).length);
    for (const file of files) {
      try { estDraft.photos.push(await uploadEstFile(file)); } catch (e) { console.warn(e); }
    }
    $("est-photos-input").value = "";
    renderEstAttachRows();
  });
  $("est-add-attach").addEventListener("click", () => $("est-attach-input").click());
  $("est-attach-input").addEventListener("change", async () => {
    const files = Array.from($("est-attach-input").files || []).slice(0, 10 - (estDraft.attachments || []).length);
    for (const file of files) {
      try { estDraft.attachments.push(await uploadEstFile(file)); } catch (e) { console.warn(e); }
    }
    $("est-attach-input").value = "";
    renderEstAttachRows();
  });
  $("est-terms-toggle").addEventListener("click", () => toggleTermsEditor());
  $("est-terms-preview").addEventListener("click", () => toggleTermsEditor(true));
  $("est-terms").addEventListener("input", () => { estDraft.terms = $("est-terms").value; updateTermsPreview(); });
  $("est-terms-select").addEventListener("change", () => {
    const id = $("est-terms-select").value;
    estDraft.termsTemplateId = id;
    const tpl = termsLibrary.find((t) => t.id === id);
    if (tpl) {
      estDraft.terms = tpl.body;
      $("est-terms").value = tpl.body;
      updateTermsPreview();
    }
  });
  $("est-terms-update").addEventListener("click", async () => {
    const tpl = termsLibrary.find((t) => t.id === $("est-terms-select").value);
    if (!tpl) { alert("Pick a template first, or use Save as new template."); return; }
    tpl.body = $("est-terms").value;
    await saveTermsLibrary();
    $("est-terms-update").textContent = "✓ Updated";
    setTimeout(() => { $("est-terms-update").textContent = "💾 Update this template"; }, 2000);
  });
  $("est-terms-saveas").addEventListener("click", async () => {
    const name = prompt("Template name (e.g. Remodel Terms, Service Call Terms):");
    if (!name || !name.trim()) return;
    const tpl = { id: "t" + Date.now(), name: name.trim(), body: $("est-terms").value, default: termsLibrary.length === 0 };
    termsLibrary.push(tpl);
    estDraft.termsTemplateId = tpl.id;
    await saveTermsLibrary();
    renderTermsControls();
  });
  $("est-terms-setdef").addEventListener("click", async () => {
    const id = $("est-terms-select").value;
    if (!id) { alert("Pick a template first."); return; }
    for (const t of termsLibrary) t.default = t.id === id;
    await saveTermsLibrary();
    renderTermsControls();
  });
  $("est-terms-deltpl").addEventListener("click", async () => {
    const id = $("est-terms-select").value;
    const tpl = termsLibrary.find((t) => t.id === id);
    if (!tpl) return;
    if (!confirm('Delete template "' + tpl.name + '"? Estimates already using it keep their text.')) return;
    termsLibrary = termsLibrary.filter((t) => t.id !== id);
    estDraft.termsTemplateId = "";
    await saveTermsLibrary();
    renderTermsControls();
  });
  $("est-pdf-btn").addEventListener("click", downloadEstPdf);
  $("est-send-btn").addEventListener("click", sendEstimateToCustomer);
  $("est-preview-close").addEventListener("click", () => closeModal("est-preview-modal"));
  $("est-preview-edit").addEventListener("click", () => {
    closeModal("est-preview-modal");
    if (previewEstId) openEstModal(previewEstId);
  });
  $("est-save").addEventListener("click", saveEstimate);
  $("est-cancel").addEventListener("click", () => { estDraft = null; closeModal("est-modal"); });
  $("est-delete").addEventListener("click", deleteEstimate);
  $("ev-close").addEventListener("click", () => closeModal("est-view-modal"));
  $("ev-approve").addEventListener("click", () => respondEstimate("approved"));
  $("ev-decline").addEventListener("click", () => respondEstimate("declined"));

  $("pdf-zoom-in").addEventListener("click", () => {
    lbPdfZoom = Math.min(lbPdfZoom * 1.25, 4);
    renderPdfPages(lightboxToken);
  });
  $("pdf-zoom-out").addEventListener("click", () => {
    lbPdfZoom = Math.max(lbPdfZoom / 1.25, 0.5);
    renderPdfPages(lightboxToken);
  });

  // Restore session for this browser tab
  try {
    const saved = JSON.parse(sessionStorage.getItem("urrSession"));
    if (saved && saved.email && saved.code) { SESSION = saved; enterPortal(null); }
  } catch (e) {}
});
