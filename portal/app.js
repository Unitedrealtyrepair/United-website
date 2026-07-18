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
  sub:      ["Schedule", "Daily Logs", "Photos", "Materials"]
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
let uploadStatus = uploadStatus || "";
let expandedGroups = new Set();
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

async function pushCollection(key, data) {
  try {
    const out = await api({ action: "save", email: SESSION.email, code: SESSION.code, key, data });
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

async function saveSchedule() { cacheSet(pkey("Schedule"), schedule); pushCollection(pkey("Schedule"), schedule); }
async function saveBudget()   { cacheSet(pkey("Budget"), budget);     pushCollection(pkey("Budget"), budget); }
async function saveLogs()     { cacheSet(pkey("Logs"), logs);         pushCollection(pkey("Logs"), logs); }
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
    buildTabs();
    loadState(null).then(() => { render(); loadFiles(); });
  });
  holder.appendChild(sel);
}


function startPresence() {
  if (presenceTimer) clearInterval(presenceTimer);
  const beat = async () => {
    try { await api({ action: "ping", email: SESSION.email, code: SESSION.code, project: currentProject.name }); } catch (e) {}
    if (isAdmin()) {
      try {
        const out = await api({ action: "presence", email: SESSION.email, code: SESSION.code });
        if (out.ok) { presenceMap = out.presence || {}; if (activeTab === "Overview") renderPresence(); }
      } catch (e) {}
    }
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

function renderPresence() {
  const card = $("ov-presence-card");
  const wrap = $("ov-presence");
  if (!card || !wrap) return;
  if (!isAdmin()) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  wrap.innerHTML = "";
  const members = (SESSION.members || []).filter((m) => m.role !== "admin");
  if (members.length === 0) {
    wrap.appendChild(ovEmpty("No customers or subs added yet"));
    return;
  }
  for (const m of members) {
    const rec = presenceMap[m.email] || null;
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

function logout() {
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
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
    destAreaRoot: !!(dest && dest.destAreaRoot)
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
    "subs-section":     activeTab === "Subs"
  };
  for (const [id, show] of Object.entries(sections)) {
    $(id).classList.toggle("hidden", !show);
  }

  const isFileTab = !Object.values(sections).some(Boolean);

  if (activeTab === "Overview") renderOverview();
  if (activeTab === "Schedule") {
    $("add-task-btn").classList.toggle("hidden", !isAdmin());
    renderCalendar();
    renderUpcoming();
  }
  if (activeTab === "Budget") renderBudget();
  if (activeTab === "Daily Logs") renderLogs();
  if (activeTab === "Subs") renderSubs();

  // File grid only on file tabs
  const list = $("file-list");
  list.innerHTML = "";
  $("empty-msg").classList.add("hidden");
  if (!isFileTab) return;

  // Photos tab: in-portal upload for subs & admin
  if (activeTab === "Photos" && (isAdmin() || currentUser.role === "sub")) {
    const bar = document.createElement("div");
    bar.className = "photos-toolbar";

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";

    const btn = document.createElement("button");
    btn.className = "add-task-btn photos-add";
    btn.textContent = "+ Add Photos";
    btn.addEventListener("click", () => input.click());

    let areaSel = null, folderSel = null;
    if (isAdmin()) {
      areaSel = document.createElement("select");
      areaSel.className = "dest-select";
      [["customer","→ Customer folder"],["crew","→ Crew folder"],["office","→ Office (private)"]].forEach(([v,l]) => {
        const o = document.createElement("option"); o.value = v; o.textContent = l; areaSel.appendChild(o);
      });
      areaSel.value = "crew";

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
        if (areaSel.value === "crew") folderSel.value = subsIn.some(s => /sub[\s\-_]?uploads?/i.test(s.name)) ? subsIn.find(s => /sub[\s\-_]?uploads?/i.test(s.name)).name : "";
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
      ? "Pick where the photos go, then Add."
      : "Pick your job photos — they upload straight to United Realty Repair.");

    input.addEventListener("change", () => uploadPhotos(input.files, btn, hint, {
      destArea: areaSel ? areaSel.value : "crew",
      destFolderName: folderSel ? (folderSel.value === "__new__" ? "" : folderSel.value) : "",
      destAreaRoot: areaSel && folderSel && !folderSel.value
    }));

    bar.appendChild(btn);
    bar.appendChild(hint);
    bar.appendChild(input);
    list.appendChild(bar);
  }

  const files = visibleFiles().sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""));
  const visibleAlbums = activeTab === "Photos" ? photoFolders.filter((fo) => canSeeAlbum(fo.id)) : [];
  if (files.length === 0 && visibleAlbums.length === 0) {
    $("empty-msg").classList.remove("hidden");
    return;
  }

  if (activeTab === "Photos") {
    const loose = files.filter((f) => !f.albumId);
    for (const f of loose) list.appendChild(fileCard(f));

    for (const fo of photoFolders) {
      if (!canSeeAlbum(fo.id)) continue;
      const albumFiles = files.filter((f) => f.albumId === fo.id);
      if (albumFiles.length === 0 && !fo.isSubUploads) continue;

      const key = "Photos::" + fo.id;
      const open = expandedGroups.has(key) || fo.isSubUploads;
      const divider = document.createElement("div");
      divider.className = "photos-divider clickable";
      const title = document.createElement("span");
      title.textContent = (open ? "▾ " : "▸ ") + "📁 " + fo.name + "  (" + albumFiles.length + ")";
      title.style.cursor = "pointer";
      title.addEventListener("click", () => {
        if (expandedGroups.has(key)) expandedGroups.delete(key); else expandedGroups.add(key);
        render();
      });
      divider.appendChild(title);

      if (isAdmin()) {
        const perms = document.createElement("span");
        perms.className = "album-perms";
        const lbl = document.createElement("span");
        lbl.className = "album-perms-label";
        const allowed = folderPerms[fo.id] || [];
        lbl.textContent = allowed.length === 0 ? "Visible to everyone in this folder — limit to:" : "Limited to:";
        perms.appendChild(lbl);
        const audience = fo.source === "customer" ? "customer" : fo.source === "crew" ? "sub" : null;
        for (const u of projectMembers().filter((m) => !audience || m.role === audience)) {
          const chip = document.createElement("button");
          const on = allowed.includes(u.email);
          chip.className = "perm-chip" + (on ? " on" : "");
          chip.textContent = (on ? "✓ " : "") + u.email + " (" + u.role + ")";
          chip.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            let list2 = folderPerms[fo.id] || [];
            list2 = on ? list2.filter((x) => x !== u.email) : list2.concat([u.email]);
            folderPerms[fo.id] = list2;
            await saveFolderPerms();
            render();
          });
          perms.appendChild(chip);
        }
        if (projectMembers().length === 0) {
          const none = document.createElement("span");
          none.className = "photos-hint";
          none.textContent = "no customer/sub on this project yet";
          perms.appendChild(none);
        }
        divider.appendChild(perms);
      }
      list.appendChild(divider);

      if (!open) continue;
      if (albumFiles.length === 0) {
        const emptyEl = document.createElement("div");
        emptyEl.className = "photos-hint album-empty";
        emptyEl.textContent = "No photos in this folder yet.";
        list.appendChild(emptyEl);
      } else {
        for (const f of albumFiles) list.appendChild(fileCard(f));
      }
    }
    return;
  }

  // Group by folder on document-style tabs (collapsible)
  const loose2 = files.filter((f) => !f.albumName);
  for (const f of loose2) list.appendChild(fileCard(f));
  const groupNames = [...new Set(files.filter((f) => f.albumName).map((f) => f.albumName))].sort();
  for (const gn of groupNames) {
    const inGroup = files.filter((x) => x.albumName === gn);
    const key = activeTab + "::" + gn;
    const open = expandedGroups.has(key);
    const divider = document.createElement("div");
    divider.className = "photos-divider clickable";
    divider.textContent = (open ? "▾ " : "▸ ") + "📁 " + gn + "  (" + inGroup.length + ")";
    divider.addEventListener("click", () => {
      if (open) expandedGroups.delete(key); else expandedGroups.add(key);
      render();
    });
    list.appendChild(divider);
    if (open) for (const f of inGroup) list.appendChild(fileCard(f));
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
  return URR_CONFIG.users.filter((u) =>
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
    openLightbox(f);
  });

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
function ymd(d) { return d.toISOString().slice(0, 10); }

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
  $("lightbox").classList.remove("hidden");
}
function closeLightbox() {
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
  $("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

  // Click outside modal closes it
  for (const id of ["task-modal", "budget-modal", "log-modal", "sub-modal", "task-view-modal"]) {
    $(id).addEventListener("click", (e) => { if (e.target.id === id) closeModal(id); });
  }

  $("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

  // Restore session for this browser tab
  try {
    const saved = JSON.parse(sessionStorage.getItem("urrSession"));
    if (saved && saved.email && saved.code) { SESSION = saved; enterPortal(null); }
  } catch (e) {}
});
