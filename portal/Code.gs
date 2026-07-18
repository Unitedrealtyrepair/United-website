// ============================================================
// URR PORTAL BACKEND v2 (Google Apps Script)
// Replaces your existing Code.gs. Supports BOTH:
//   - the Chrome extension (token mode, unchanged)
//   - the web portal at unitedrealtyrepair.com/portal (login mode)
//
// After pasting: Deploy > Manage deployments > Edit (pencil) >
// Version: New version > Deploy. Same URL keeps working.
// ============================================================

// Extension token (must match config.js syncToken in the extension)
const TOKEN = "URR-9f4k2m8x-2026";

const DATA_SHEET = "Data";
const USERS_SHEET = "Users";
const PROJECTS_SHEET = "Projects";
const SETTINGS_SHEET = "Settings";

// ---------- Sheet helpers ----------
function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers) sh.appendRow(headers);
  }
  return sh;
}

function dataSheet_() { return sheet_(DATA_SHEET, ["key", "json", "updated"]); }

function usersSheet_() {
  return sheet_(USERS_SHEET, ["email", "role", "accessCode", "projects"]);
}

function projectsSheet_() {
  return sheet_(PROJECTS_SHEET, ["name", "folderId", "customerFolderId", "crewFolderId", "officeFolderId"]);
}

function settingsSheet_() {
  const sh = sheet_(SETTINGS_SHEET, ["setting", "value"]);
  if (sh.getLastRow() === 1) sh.appendRow(["driveApiKey", ""]);
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Data access ----------
function readAllData_() {
  const rows = dataSheet_().getDataRange().getValues();
  const data = {};
  for (let i = 1; i < rows.length; i++) {
    const key = rows[i][0];
    if (!key) continue;
    try { data[key] = JSON.parse(rows[i][1] || "null"); } catch (e) { data[key] = null; }
  }
  return data;
}

function writeData_(key, value) {
  const sh = dataSheet_();
  const rows = sh.getDataRange().getValues();
  const jsonStr = JSON.stringify(value === undefined ? null : value);
  const now = new Date();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) {
      sh.getRange(i + 1, 2).setValue(jsonStr);
      sh.getRange(i + 1, 3).setValue(now);
      return;
    }
  }
  sh.appendRow([key, jsonStr, now]);
}

function findUser_(email, code) {
  const rows = usersSheet_().getDataRange().getValues();
  const e = String(email || "").trim().toLowerCase();
  const c = String(code || "").trim();
  for (let i = 1; i < rows.length; i++) {
    const rEmail = String(rows[i][0] || "").trim().toLowerCase();
    const rCode = String(rows[i][2] || "").trim();
    if (rEmail === e && rCode !== "" && rCode === c) {
      return {
        email: rEmail,
        role: String(rows[i][1] || "").trim().toLowerCase(),
        projects: String(rows[i][3] || "").split(",").map(function(s){return s.trim();}).filter(String)
      };
    }
  }
  return null;
}

function allProjects_() {
  const rows = projectsSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0] || !rows[i][1]) continue;
    out.push({
      name: String(rows[i][0]).trim(),
      folderId: String(rows[i][1]).trim(),
      folders: {
        customer: String(rows[i][2] || "").trim(),
        crew: String(rows[i][3] || "").trim(),
        office: String(rows[i][4] || "").trim()
      }
    });
  }
  return out;
}

// Only hand each role the folder IDs they're allowed to touch
function projectsForRole_(projects, role) {
  return projects.map(function (p) {
    if (role === "admin") return p;
    const f = p.folders || {};
    const scoped = { name: p.name, folderId: p.folderId, folders: {} };
    if (role === "customer" && f.customer) scoped.folders.customer = f.customer;
    if (role === "sub" && f.crew) scoped.folders.crew = f.crew;
    if (!f.customer && !f.crew && !f.office) scoped.folders = null; // legacy single-folder
    return scoped;
  });
}

function getSetting_(name) {
  const rows = settingsSheet_().getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === name) return String(rows[i][1] || "").trim();
  }
  return "";
}

// ---------- Presence tracking ----------
function touchPresence_(email, project) {
  try {
    const all = readAllData_();
    const p = all["urrPresence"] || {};
    p[String(email).toLowerCase()] = { t: new Date().toISOString(), project: String(project || "") };
    writeData_("urrPresence", p);
  } catch (e) {}
}

// ---------- Role-based note/log filtering ----------
function filterForRole_(data, role) {
  if (role === "admin") return data;
  const out = {};
  for (const key in data) {
    if (key === "urrPresence") continue;
    let val = data[key];
    if (val && key.indexOf("urrSchedule_") === 0 && Array.isArray(val)) {
      val = val.map(function (t) {
        const clean = {
          id: t.id, trade: t.trade, sub: t.sub, start: t.start,
          end: t.end, status: t.status
        };
        if (role === "customer" && t.customerNote) clean.customerNote = t.customerNote;
        if (role === "sub" && t.subNote) clean.subNote = t.subNote;
        return clean;
      });
    }
    if (val && key.indexOf("urrLogs_") === 0 && Array.isArray(val)) {
      val = val.filter(function (l) { return !l.internal; });
    }
    if (val && key.indexOf("urrBudget_") === 0 && role === "sub") {
      continue; // subs never get budget data
    }
    out[key] = val;
  }
  return out;
}

// ---------- File listing (runs as the sheet owner - sees all folders) ----------
function listFolderFiles_(folderId) {
  const out = [];
  try {
    const folder = DriveApp.getFolderById(folderId);
    const it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      const o = {
        id: f.getId(),
        name: f.getName(),
        mimeType: f.getMimeType(),
        modifiedTime: f.getLastUpdated().toISOString(),
        webViewLink: f.getUrl()
      };
      // Thumbnails need the "Drive API" advanced service (Services > + > Drive API).
      try {
        if (typeof Drive !== "undefined" && Drive.Files) {
          const meta = Drive.Files.get(o.id, { fields: "thumbnailLink" });
          if (meta && meta.thumbnailLink) o.thumbnailLink = meta.thumbnailLink;
        }
      } catch (e) {}
      out.push(o);
    }
  } catch (e) {}
  return out;
}

function listSubfolders_(folderId) {
  const out = [];
  try {
    const it = DriveApp.getFolderById(folderId).getFolders();
    while (it.hasNext()) {
      const f = it.next();
      out.push({ id: f.getId(), name: f.getName() });
    }
  } catch (e) {}
  return out;
}

function filesForRole_(project, role, email) {
  const f = project.folders || {};
  const hasSplit = f.customer || f.crew || f.office;
  const roots = [];
  if (hasSplit) {
    if (role === "admin") {
      if (f.customer) roots.push({ id: f.customer, source: "customer" });
      if (f.crew) roots.push({ id: f.crew, source: "crew" });
      if (f.office) roots.push({ id: f.office, source: "office" });
    } else if (role === "customer" && f.customer) {
      roots.push({ id: f.customer, source: "customer" });
    } else if (role === "sub" && f.crew) {
      roots.push({ id: f.crew, source: "crew" });
    }
  } else {
    roots.push({ id: project.folderId, source: "legacy" });
  }

  const files = [];
  const albums = [];
  const MAX_DEPTH = 5;

  function walk(folderId, source, depth, parentName) {
    if (depth > MAX_DEPTH) return;
    listFolderFiles_(folderId).forEach(function (o) {
      o.source = source;
      if (depth > 0) {
        o.albumId = folderId;
        o.albumName = parentName;
      }
      files.push(o);
    });
    listSubfolders_(folderId).forEach(function (sf) {
      const label = depth > 0 ? parentName + " / " + sf.name : sf.name;
      albums.push({
        id: sf.id, name: label, source: source,
        isSubUploads: /sub[\s\-_]?uploads?/i.test(sf.name)
      });
      walk(sf.id, source, depth + 1, label);
    });
  }

  roots.forEach(function (root) { walk(root.id, root.source, 0, ""); });

  // Folder-level access: if the admin limited a folder to specific emails,
  // strip it (and everything inside it) before it ever leaves the server.
  if (role !== "admin") {
    const perms = readAllData_()["urrFolderPerms_" + project.folderId] || {};
    const blockedPaths = [];
    for (let i = 0; i < albums.length; i++) {
      const al = albums[i];
      const allowed = perms[al.id];
      if (al.isSubUploads && role === "sub") continue;
      if (allowed && allowed.length > 0 && allowed.indexOf(String(email || "").toLowerCase()) === -1) {
        blockedPaths.push(al.name);
      }
    }
    const isBlocked = function (name) {
      if (!name) return false;
      for (let i = 0; i < blockedPaths.length; i++) {
        if (name === blockedPaths[i] || name.indexOf(blockedPaths[i] + " / ") === 0) return true;
      }
      return false;
    };
    const files2 = files.filter(function (f) { return !isBlocked(f.albumName); });
    const albums2 = albums.filter(function (al) { return !isBlocked(al.name); });
    return { files: files2, albums: albums2 };
  }

  return { files: files, albums: albums };
}

function projectByName_(name) {
  const all = allProjects_();
  for (let i = 0; i < all.length; i++) if (all[i].name === name) return all[i];
  return null;
}

// ---------- HTTP handlers ----------
function doGet(e) {
  // Extension token mode (unchanged behavior)
  if (e.parameter && e.parameter.token === TOKEN) {
    return json_({ ok: true, data: readAllData_() });
  }
  return json_({ ok: false, error: "unauthorized" });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) {
    return json_({ ok: false, error: "bad json" });
  }

  // ----- Extension token mode (unchanged) -----
  if (body.token === TOKEN && body.key !== undefined) {
    writeData_(body.key, body.data);
    return json_({ ok: true });
  }

  // ----- Extension: file listing (admin sees everything) -----
  if (body.token === TOKEN && body.action === "files") {
    const project = projectByName_(body.project);
    if (!project) return json_({ ok: false, error: "unknown project" });
    return json_({ ok: true, ...filesForRole_(project, "admin", "admin") });
  }

  // ----- Presence ping -----
  if (body.action === "ping") {
    let email = null, project = String(body.project || "");
    if (body.token === TOKEN) email = String(body.email || "admin");
    else {
      const user = findUser_(body.email, body.code);
      if (!user) return json_({ ok: false, error: "denied" });
      email = user.email;
    }
    touchPresence_(email, project);
    return json_({ ok: true });
  }

  // ----- Presence read (admin only) -----
  if (body.action === "presence") {
    let allowed = body.token === TOKEN;
    if (!allowed) {
      const user = findUser_(body.email, body.code);
      allowed = user && user.role === "admin";
    }
    if (!allowed) return json_({ ok: false, error: "denied" });
    const all = readAllData_();
    return json_({ ok: true, presence: all["urrPresence"] || {} });
  }

  // ----- Web portal: login -----
  if (body.action === "login") {
    const user = findUser_(body.email, body.code);
    if (!user) return json_({ ok: false, error: "denied" });
    touchPresence_(user.email, "");

    let projects = allProjects_();
    if (user.role !== "admin") {
      projects = projects.filter(function (p) { return user.projects.indexOf(p.name) !== -1; });
    }
    if (projects.length === 0) return json_({ ok: false, error: "denied" });
    projects = projectsForRole_(projects, user.role);

    const resp = {
      ok: true,
      role: user.role,
      email: user.email,
      projects: projects,
      apiKey: getSetting_("driveApiKey"),
      data: filterForRole_(readAllData_(), user.role)
    };
    if (user.role === "admin") {
      const rows = usersSheet_().getDataRange().getValues();
      const members = [];
      for (let i = 1; i < rows.length; i++) {
        if (!rows[i][0]) continue;
        members.push({
          email: String(rows[i][0]).trim().toLowerCase(),
          role: String(rows[i][1] || "").trim().toLowerCase(),
          projects: String(rows[i][3] || "").split(",").map(function(s){return s.trim();}).filter(String)
        });
      }
      resp.members = members;
    }
    return json_(resp);
  }

  // ----- Web portal: refresh data -----
  if (body.action === "pull") {
    const user = findUser_(body.email, body.code);
    if (!user) return json_({ ok: false, error: "denied" });
    touchPresence_(user.email, String(body.project || ""));
    return json_({ ok: true, data: filterForRole_(readAllData_(), user.role) });
  }

  // ----- Web portal: file listing -----
  if (body.action === "files") {
    const user = findUser_(body.email, body.code);
    if (!user) return json_({ ok: false, error: "denied" });
    const project = projectByName_(body.project);
    if (!project) return json_({ ok: false, error: "unknown project" });
    if (user.role !== "admin" && user.projects.indexOf(project.name) === -1) {
      return json_({ ok: false, error: "forbidden" });
    }
    return json_({ ok: true, ...filesForRole_(project, user.role, user.email) });
  }

  // ----- Folder listing for upload pickers -----
  if (body.action === "folders") {
    let role = null;
    if (body.token === TOKEN) role = "admin";
    else {
      const user = findUser_(body.email, body.code);
      if (!user) return json_({ ok: false, error: "denied" });
      role = user.role;
    }
    const project = projectByName_(body.project);
    if (!project) return json_({ ok: false, error: "unknown project" });
    const f = project.folders || {};
    const out = {};
    if (role === "admin") {
      if (f.customer) out.customer = listSubfolders_(f.customer);
      if (f.crew) out.crew = listSubfolders_(f.crew);
      if (f.office) out.office = listSubfolders_(f.office);
    }
    return json_({ ok: true, areas: out });
  }

  // ----- Photo upload (extension token = admin, or web user admin/sub) -----
  if (body.action === "upload") {
    let role = null, email = null;
    if (body.token === TOKEN) { role = "admin"; email = "admin"; }
    else {
      const user = findUser_(body.email, body.code);
      if (!user) return json_({ ok: false, error: "denied" });
      role = user.role; email = user.email;
      if (role !== "admin" && role !== "sub") return json_({ ok: false, error: "forbidden" });
      if (role !== "admin" && user.projects.indexOf(String(body.project)) === -1) {
        return json_({ ok: false, error: "forbidden" });
      }
    }
    const project = projectByName_(body.project);
    if (!project) return json_({ ok: false, error: "unknown project" });
    if (!body.filename || !body.data) return json_({ ok: false, error: "missing file" });

    const f2 = project.folders || {};
    const crewId = f2.crew || project.folderId;

    // Destination: area + optional subfolder name (find-or-create).
    let area = String(body.destArea || "crew");
    let folderName = String(body.destFolderName || "");
    if (role !== "admin") {
      // Subs: crew area only, and only Sub Uploads or Log Photos
      area = "crew";
      if (folderName !== "Log Photos") folderName = "Sub Uploads";
    } else {
      if (area === "crew" && !folderName && !body.destAreaRoot) folderName = "Sub Uploads";
    }

    let rootId = crewId;
    if (area === "customer" && f2.customer) rootId = f2.customer;
    else if (area === "office" && f2.office) rootId = f2.office;

    let target = rootId;
    if (folderName) {
      const subs = listSubfolders_(rootId);
      for (let i = 0; i < subs.length; i++) {
        if (subs[i].name.toLowerCase() === folderName.toLowerCase()) { target = subs[i].id; break; }
      }
      if (target === rootId) {
        target = DriveApp.getFolderById(rootId).createFolder(folderName).getId();
      }
    }
    try {
      const bytes = Utilities.base64Decode(body.data);
      const blob = Utilities.newBlob(bytes, body.mimeType || "application/octet-stream", String(body.filename));
      const created = DriveApp.getFolderById(target).createFile(blob);
      return json_({ ok: true, fileId: created.getId(), fileName: created.getName() });
    } catch (e) {
      return json_({ ok: false, error: "upload failed: " + e });
    }
  }

  // ----- Web portal: save a collection -----
  if (body.action === "save") {
    const user = findUser_(body.email, body.code);
    if (!user) return json_({ ok: false, error: "denied" });
    const key = String(body.key || "");
    if (!key) return json_({ ok: false, error: "missing key" });

    const isLogs = key.indexOf("urrLogs_") === 0;
    if (user.role === "admin" || (user.role === "sub" && isLogs)) {
      // Subs write logs; merge carefully so they can't nuke internal/admin entries
      if (user.role === "sub" && isLogs) {
        const existing = readAllData_()[key] || [];
        const preserved = existing.filter(function (l) { return l.internal || (l.author && l.author !== user.email); });
        const theirs = (body.data || []).filter(function (l) { return !l.internal && l.author === user.email; });
        writeData_(key, preserved.concat(theirs));
      } else {
        writeData_(key, body.data);
      }
      return json_({ ok: true });
    }
    return json_({ ok: false, error: "forbidden" });
  }

  return json_({ ok: false, error: "unknown request" });
}
