// The Settings tab: defaults, checking, and what the entry points do with it. The Google services are replaced by
// small fakes, so these tests run anywhere with Node and never touch a real account or Planning Center.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { loadGas, CORE } = require("./gas-loader");

const FILES = CORE.concat(["Settings.js", "Control.js", "Pco.js", "Job.js", "Main.js"]);
// Placeholder addresses, joined here so they cannot be mistaken for real ones.
const OWNER = ["admin", "example.org"].join("@"), TECH = ["tech", "church.example"].join("@");
const plain = (x) => JSON.parse(JSON.stringify(x));
const CTX = { scriptTimeZone: "America/Chicago", ownerEmail: OWNER };
const g = loadGas(["Settings.js"]);
const norm = (raw, ctx = CTX) => plain(g.set_normalize(raw, ctx));

test("defaults: only the service type is required; everything else has a neutral default", () => {
  const r = norm({ SERVICE_TYPE_ID: "42" });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.settings, {
    serviceTypeId: "42", planCount: 3, alertEmail: OWNER, timeZone: "America/Chicago",
    sched: { timeZone: "America/Chicago", freezeDay: 0, freezeMinutes: 480 },
    mode: "dry-run", approvalRequired: true, paused: false,
  });
});

test("a missing service type id is reported with a clear message", () => {
  const r = norm({});
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0], /SERVICE_TYPE_ID is empty.*service_types/);
  assert.match(norm({ SERVICE_TYPE_ID: "abc" }).errors[0], /only digits/);
});

test("values are read as typed: day names, times, yes and no, live mode, own time zone and address", () => {
  const r = norm({ SERVICE_TYPE_ID: "7", PLAN_COUNT: "5", ALERT_EMAIL: TECH, TIME_ZONE: "Europe/London",
    FREEZE_DAY: "saturday", FREEZE_TIME: "18:30", MODE: "LIVE", APPROVAL_REQUIRED: "No", PAUSED: "yes" });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.settings.sched, { timeZone: "Europe/London", freezeDay: 6, freezeMinutes: 18 * 60 + 30 });
  assert.strictEqual(r.settings.planCount, 5);
  assert.strictEqual(r.settings.alertEmail, TECH);
  assert.strictEqual(r.settings.mode, "live");
  assert.strictEqual(r.settings.approvalRequired, false);
  assert.strictEqual(r.settings.paused, true);
});

test("alert emails: blank is the owner, none turns them off", () => {
  assert.strictEqual(norm({ SERVICE_TYPE_ID: "1", ALERT_EMAIL: "none" }).settings.alertEmail, "");
  assert.strictEqual(norm({ SERVICE_TYPE_ID: "1", ALERT_EMAIL: "" }).settings.alertEmail, OWNER);
});

test("anything not understood is an error, never a guess (a typo cannot switch on live mode or switch off a pause)", () => {
  const r = norm({ SERVICE_TYPE_ID: "1", MODE: "lvie", PAUSED: "ye", APPROVAL_REQUIRED: "maybe", PLAN_COUNT: "0",
    FREEZE_DAY: "Sunnday", FREEZE_TIME: "25:00", TIME_ZONE: "Mars/Olympus", ALERT_EMAIL: "not an email" });
  assert.strictEqual(r.errors.length, 8);
  assert.strictEqual(r.settings.mode, "dry-run");
  assert.strictEqual(r.settings.approvalRequired, true);
  for (const word of ["MODE", "PAUSED", "APPROVAL_REQUIRED", "PLAN_COUNT", "FREEZE_DAY", "FREEZE_TIME", "TIME_ZONE", "ALERT_EMAIL"]) {
    assert.ok(r.errors.some((e) => e.startsWith(word)), word + " should be reported");
  }
});

test("rows of the tab: names are case-insensitive, blank rows and notes are ignored", () => {
  const raw = plain(g.set_parseRows([["Setting", "Value", "What it does"], ["plan_count", " 4 ", "note"], ["", "", ""], ["MODE", "live"]]));
  assert.deepStrictEqual(raw, { SETTING: "Value", PLAN_COUNT: "4", MODE: "live" });
});

test("every setting in the list has a default and a note", () => {
  assert.deepStrictEqual(plain(g.SET_DEFS.map((d) => d.key)),
    ["SERVICE_TYPE_ID", "PLAN_COUNT", "ALERT_EMAIL", "TIME_ZONE", "FREEZE_DAY", "FREEZE_TIME", "MODE", "APPROVAL_REQUIRED", "PAUSED"]);
  assert.ok(g.SET_DEFS.every((d) => d.note.length > 10));
});

// ---- the entry points, with fake Google services

// A time of day as Sheets hands it back: a Date on 1899-12-30 (here in UTC, the fake spreadsheet's zone).
const timeOfDay = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return new Date(Date.UTC(1899, 11, 30, h, m)); };

function fakeSheet() {
  const rows = [], formats = [];
  const isText = (r, c) => formats.some((f) => f.fmt === "@" && c === f.col && r >= f.r1 && r <= f.r2);
  // Like Sheets: a time typed or written into a cell that is not plain text is stored as a time of day (read back as a Date).
  const put = (r, c, x) => {
    (rows[r - 1] = rows[r - 1] || [])[c - 1] = typeof x === "string" && /^\d{1,2}:\d{2}$/.test(x) && !isText(r, c) ? timeOfDay(x) : x;
  };
  const cell = (r, c) => (rows[r - 1] && rows[r - 1][c - 1] != null ? rows[r - 1][c - 1] : "");
  const range = (r, c, nr, nc) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
    setValues: (v) => { v.forEach((row, i) => row.forEach((x, j) => put(r + i, c + j, x))); return range(r, c, nr, nc); },
    setValue: (x) => { put(r, c, x); },
    setNumberFormat(fmt) { for (let j = 0; j < nc; j++) formats.push({ fmt, col: c + j, r1: r, r2: r + nr - 1 }); return this; },
    setFontWeight() { return this; }, setDataValidation() {}, clearContent() {},
  });
  const a1 = (ref) => {
    const m = /^([A-Z])(\d+):([A-Z])(\d+)$/.exec(ref), c = m[1].charCodeAt(0) - 64;
    return range(+m[2], c, +m[4] - +m[2] + 1, m[3].charCodeAt(0) - 64 - c + 1);
  };
  return { rows, formats, getLastRow: () => rows.length, getRange: (r, c, nr, nc) => (typeof r === "string" ? a1(r) : range(r, c, nr || 1, nc || 1)),
    setFrozenRows() {}, setColumnWidth() {}, appendRow: (a) => { rows.push(a); }, deleteRows() {}, clear() { rows.length = 0; } };
}

function fakeWorld(settings, { key = false, scriptTz = "America/Chicago", now = null } = {}) {
  const sheets = {}, props = { CONTROL_SHEET_ID: "sheet-1" }, mail = [], fetches = [], triggers = [];
  if (key) { props.PCO_APP_ID = "app"; props.PCO_SECRET = "secret-value"; }
  const ss = {
    getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = fakeSheet()), getSheets: () => Object.values(sheets),
    deleteSheet() {}, getUrl: () => "https://sheets.example/sheet-1", getId: () => "sheet-1", getSpreadsheetTimeZone: () => "UTC",
  };
  const fmt = (d, tz, pattern) => {
    const p = {};
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    if (pattern === "yyyy") return p.year;
    if (pattern === "yyyy-MM-dd") return `${p.year}-${p.month}-${p.day}`;
    if (pattern === "HH:mm") return `${p.hour}:${p.minute}`;
    return `${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1} ${p.hour} ${p.minute}`;
  };
  const globals = {
    Utilities: { formatDate: fmt, base64Encode: (s) => Buffer.from(s).toString("base64"), sleep() {} },
    Session: { getEffectiveUser: () => ({ getEmail: () => OWNER }), getScriptTimeZone: () => scriptTz },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: (k) => { delete props[k]; } }) },
    SpreadsheetApp: { openById: () => ss, create: () => ss, newDataValidation: () => ({ requireValueInList() { return this; }, build: () => ({}) }) },
    DriveApp: { getFileById: () => ({ moveTo() {} }), getRootFolder: () => ({ getFoldersByName: () => ({ hasNext: () => false }), createFolder: () => ({}) }) },
    ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger() {}, newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => { triggers.push({ getHandlerFunction: () => fn }); } }) }) }) },
    MailApp: { sendEmail: (to, subject, body) => mail.push({ to, subject, body }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    UrlFetchApp: { fetch: (url) => { fetches.push(url); throw new Error("no network in tests"); } },
    Logger: { log() {} },
  };
  if (now) {
    const at = new Date(now).getTime();
    globals.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(at); } static now() { return at; } };
  }
  const world = loadGas(FILES, globals);
  world.ctl_prepare(ss);
  const tab = sheets.Settings;
  for (const [k, v] of Object.entries(settings)) {
    const row = tab.rows.findIndex((r) => r[0] === k);
    tab.rows[row][1] = v;
  }
  const log = () => sheets.Log.rows.slice(1).map((r) => r[1]);
  return { world, props, mail, fetches, triggers, sheets, log };
}

test("a missing service type: the trigger run stops, writes the problem to the Log tab and emails the owner once a day", () => {
  const w = fakeWorld({});
  w.world.runSundaySlides();
  w.world.runSundaySlides();
  assert.strictEqual(w.fetches.length, 0);
  assert.strictEqual(w.mail.length, 1);
  assert.strictEqual(w.mail[0].to, OWNER);
  assert.match(w.mail[0].body, /SERVICE_TYPE_ID is empty/);
  assert.strictEqual(w.log().length, 1);
  assert.match(w.log()[0], /needs fixing/);
});

test("a manual run with no service type refuses with the same clear message", () => {
  const w = fakeWorld({}, { key: true });
  assert.throws(() => w.world.runSundaySlidesNow(), /Settings tab needs fixing[\s\S]*SERVICE_TYPE_ID is empty/);
  assert.strictEqual(w.fetches.length, 0);
});

test("settings fine but no Planning Center key: a manual run says exactly where to add it", () => {
  const w = fakeWorld({ SERVICE_TYPE_ID: "42" });
  assert.throws(() => w.world.runSundaySlidesNow(), /add PCO_APP_ID and PCO_SECRET in Project Settings > Script Properties/);
});

test("PAUSED yes on the Settings tab stops the run before anything is read from Planning Center", () => {
  const w = fakeWorld({ SERVICE_TYPE_ID: "42", PAUSED: "yes" }, { key: true });
  const r = w.world.runSundaySlidesNow();
  assert.match(r.skipped, /PAUSED is yes/);
  assert.strictEqual(w.fetches.length, 0);
});

test("ALERT_EMAIL none: no emails are sent, the problem still goes to the Log tab", () => {
  const w = fakeWorld({ ALERT_EMAIL: "none" });
  w.world.runSundaySlides();
  assert.strictEqual(w.mail.length, 0);
  assert.strictEqual(w.log().length, 1);
});

test("setup makes the trigger and a Settings tab holding every setting with its neutral default", () => {
  const w = fakeWorld({});
  const out = w.world.setupSundaySlides();
  assert.deepStrictEqual(w.triggers.map((t) => t.getHandlerFunction()), ["runSundaySlides"]);
  const rows = w.sheets.Settings.rows;
  assert.deepStrictEqual(rows[0], ["Setting", "Value", "What it does"]);
  assert.strictEqual(rows.length, 1 + w.world.SET_DEFS.length);
  assert.strictEqual(rows.find((r) => r[0] === "FREEZE_DAY")[1], "Sunday");
  assert.strictEqual(rows.find((r) => r[0] === "FREEZE_TIME")[1], "08:00");
  assert.strictEqual(rows.find((r) => r[0] === "MODE")[1], "dry-run");
  assert.strictEqual(out.timeZone, "America/Chicago");
  assert.ok(plain(out.problemsToFix).some((e) => /SERVICE_TYPE_ID/.test(e)));
});

// ---- template.pro in the Drive folder

const fs = require("fs");
const nodePath = require("path");
const GEORGIA = fs.readFileSync(nodePath.join(__dirname, "fixtures", "templates", "georgia.pro"));

function driveWith(files) {
  const folder = { getFiles: () => { let i = 0; return { hasNext: () => i < files.length, next: () => files[i++] }; } };
  return {
    getFileById: () => ({ getParents: () => ({ hasNext: () => true, next: () => folder }) }),
    getRootFolder: () => ({ getFoldersByName: () => ({ hasNext: () => true, next: () => folder }), createFolder: () => folder }),
  };
}
// Apps Script hands back file bytes as signed numbers.
const driveFile = (name, time, bytes) => ({ getName: () => name, getLastUpdated: () => new Date(time),
  getBlob: () => ({ getBytes: () => Array.from(bytes, (b) => (b > 127 ? b - 256 : b)) }) });

test("template.pro in the folder is used, logged once, and the newest copy wins", () => {
  const w = fakeWorld({});
  w.props.CONTROL_SHEET_ID = "sheet1";
  const logs = [];
  const control = { log: (t) => logs.push(t) };
  const propsObj = w.world.PropertiesService.getScriptProperties();

  w.world.DriveApp = driveWith([driveFile("notes.txt", "2026-10-01", Buffer.from("x")), driveFile("Template.PRO", "2026-10-02", GEORGIA.subarray(0, 300)),
    driveFile("template.pro", "2026-10-20", GEORGIA)]);
  const t = w.world.ss_template(propsObj, control);
  assert.strictEqual(t.source, "custom");
  assert.strictEqual(t.layout.fontName, "Georgia-Bold");
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /TEMPLATE: using slide 1 of your template\.pro: Georgia-Bold, 54 pt/);
  assert.match(logs[0], /2 files are called template\.pro; the newest one is used/);
  w.world.ss_template(propsObj, control);
  assert.strictEqual(logs.length, 1, "unchanged template, no new line");

  w.world.DriveApp = driveWith([driveFile("notes.txt", "2026-10-01", Buffer.from("x"))]);
  const gone = w.world.ss_template(propsObj, control);
  assert.strictEqual(gone.source, "default");
  assert.match(logs[1], /no template\.pro in the Sunday Slides folder/);
});

test("a template.pro that is damaged, or a Drive error, falls back to the built-in look with a Log line", () => {
  const w = fakeWorld({});
  w.props.CONTROL_SHEET_ID = "sheet1";
  const logs = [];
  const control = { log: (t) => logs.push(t) };
  const propsObj = w.world.PropertiesService.getScriptProperties();
  w.world.DriveApp = driveWith([driveFile("template.pro", "2026-10-20", Buffer.from("this is not a slide"))]);
  const a = w.world.ss_template(propsObj, control);
  assert.strictEqual(a.source, "fallback");
  assert.match(logs[0], /TEMPLATE PROBLEM: template\.pro was not used/);
  w.world.DriveApp = { getFileById: () => { throw new Error("Service error: Drive"); }, getRootFolder: () => { throw new Error("Service error: Drive"); } };
  const b = w.world.ss_template(propsObj, control);
  assert.strictEqual(b.source, "fallback");
  assert.match(logs[1], /TEMPLATE PROBLEM.*Service error: Drive/);
});

// ---- times and Sheets

test("the default FREEZE_TIME survives a round trip through the sheet (the column is plain text, so 08:00 stays 08:00)", () => {
  const w = fakeWorld({ SERVICE_TYPE_ID: "42" });
  assert.ok(w.sheets.Settings.formats.some((f) => f.fmt === "@" && f.col === 2), "column B should be formatted as plain text");
  assert.strictEqual(w.sheets.Settings.rows.find((r) => r[0] === "FREEZE_TIME")[1], "08:00");
  const out = plain(w.world.showStatus());
  assert.deepStrictEqual(out.problemsToFix, []);
  assert.strictEqual(out.settings.sched.freezeMinutes, 480);
});

test("an admin typing 8:45 into the Settings tab gets 08:45, not a Date", () => {
  const w = fakeWorld({ SERVICE_TYPE_ID: "42" });
  const row = w.sheets.Settings.rows.findIndex((r) => r[0] === "FREEZE_TIME") + 1;
  w.sheets.Settings.getRange(row, 2, 1, 1).setValues([["8:45"]]);
  const out = plain(w.world.showStatus());
  assert.deepStrictEqual(out.problemsToFix, []);
  assert.strictEqual(out.settings.sched.freezeMinutes, 8 * 60 + 45);
});

test("a time that Sheets already turned into a Date (older sheets) is read as HH:mm in the spreadsheet's zone", () => {
  const w = fakeWorld({ SERVICE_TYPE_ID: "42", FREEZE_TIME: timeOfDay("08:45") });
  const out = plain(w.world.showStatus());
  assert.deepStrictEqual(out.problemsToFix, []);
  assert.strictEqual(out.settings.sched.freezeMinutes, 8 * 60 + 45);
});

test("parseRows: a Date in FREEZE_TIME becomes HH:mm with Utilities (spreadsheet zone) and with plain getHours without it", () => {
  const seen = [];
  const withUtil = loadGas(["Settings.js"], { Utilities: { formatDate: (d, tz, pattern) => { seen.push([tz, pattern]); return "18:30"; } } });
  assert.strictEqual(withUtil.set_parseRows([["FREEZE_TIME", new Date(0)]], "Asia/Tokyo").FREEZE_TIME, "18:30");
  assert.deepStrictEqual(seen, [["Asia/Tokyo", "HH:mm"]]);
  assert.strictEqual(g.set_parseRows([["FREEZE_TIME", new Date(1899, 11, 30, 8, 5)]]).FREEZE_TIME, "08:05");
  assert.strictEqual(g.set_parseRows([["FREEZE_TIME", new Date(1899, 11, 30, 18, 30)]]).FREEZE_TIME, "18:30");
});

// ---- time zone

test("TIME_ZONE blank while the script's own zone is UTC or GMT: a clear error that says what to type", () => {
  for (const tz of ["UTC", "Etc/UTC", "GMT", "Etc/GMT", "Etc/GMT+5", ""]) {
    const r = norm({ SERVICE_TYPE_ID: "1" }, { scriptTimeZone: tz, ownerEmail: OWNER });
    assert.strictEqual(r.errors.length, 1, tz);
    assert.match(r.errors[0], /^TIME_ZONE is empty.*America\/Chicago/, tz);
  }
  assert.deepStrictEqual(norm({ SERVICE_TYPE_ID: "1", TIME_ZONE: "America/Chicago" }, { scriptTimeZone: "Etc/UTC", ownerEmail: OWNER }).errors, []);
  assert.deepStrictEqual(norm({ SERVICE_TYPE_ID: "1" }, { scriptTimeZone: "Europe/London", ownerEmail: OWNER }).errors, []);
});

test("a run refuses while TIME_ZONE is blank and the script is on UTC", () => {
  const w = fakeWorld({ SERVICE_TYPE_ID: "42" }, { key: true, scriptTz: "Etc/UTC" });
  assert.throws(() => w.world.runSundaySlidesNow(), /Settings tab needs fixing[\s\S]*TIME_ZONE is empty/);
  assert.strictEqual(w.fetches.length, 0);
});

test("TIME_ZONE must be spelled the canonical way; unknown or wrongly cased names are rejected with a hint", () => {
  for (const bad of ["america/chicago", "America/chicago", "AMERICA/CHICAGO"]) {
    const r = norm({ SERVICE_TYPE_ID: "1", TIME_ZONE: bad });
    assert.strictEqual(r.errors.length, 1, bad);
    assert.match(r.errors[0], /^TIME_ZONE "[^"]+" is spelled with the wrong capitals.*America\/Chicago/, bad);
  }
  const unknown = norm({ SERVICE_TYPE_ID: "1", TIME_ZONE: "Mars/Olympus" });
  assert.match(unknown.errors[0], /not a time zone name/);
  for (const good of ["America/Chicago", "Europe/London", "Asia/Kolkata", "US/Central", "UTC", "Etc/UTC"]) {
    assert.deepStrictEqual(norm({ SERVICE_TYPE_ID: "1", TIME_ZONE: good }).errors, [], good);
  }
});

test("a zone the Apps Script clock cannot use is rejected even when Intl knows it", () => {
  const picky = loadGas(["Settings.js"], { Utilities: { formatDate: (d, tz) => { if (tz === "Asia/Calcutta") throw new Error("Unknown time zone"); return "1970"; } } });
  assert.match(plain(picky.set_normalize({ SERVICE_TYPE_ID: "1", TIME_ZONE: "Asia/Calcutta" }, { scriptTimeZone: "Europe/London", ownerEmail: OWNER })).errors[0], /not a time zone name/);
});

// ---- approval keys and sheet formats

test("Approvals: the Key column is plain text, and keys round-trip through the sheet unchanged", () => {
  const w = fakeWorld({ SERVICE_TYPE_ID: "42" });
  assert.ok(w.sheets.Approvals.formats.some((f) => f.fmt === "@" && f.col === 1), "column A should be formatted as plain text");
  const ctl = w.world.ctl_control(w.world.SpreadsheetApp.openById("x"));
  const key = w.world.job_approvalKey("12345", "0badf00d");
  ctl.putApproval({ key, title: "Song", status: "PENDING" });
  ctl.putApproval({ key, title: "Song", status: "APPROVED" });
  assert.strictEqual(w.sheets.Approvals.rows.length, 2, "same key updates its row");
  assert.deepStrictEqual(plain(ctl.approvals()), { [key]: "APPROVED" });
});

// ---- failed runs back off

const WED_NOON = "2026-10-21T17:00:00Z";   // Wednesday 12:00 in Chicago
const at = (iso) => ({ now: iso });

test("a failed run is logged once, emailed once, and not retried at the next trigger; the email says what really happens", () => {
  const w = fakeWorld({ SERVICE_TYPE_ID: "42" }, { key: true, ...at(WED_NOON) });
  assert.throws(() => w.world.runSundaySlides(), /no network/);
  assert.strictEqual(w.props.LAST_ATTEMPT, new Date(WED_NOON).toISOString());
  assert.strictEqual(w.fetches.length, 1);
  assert.strictEqual(w.mail.length, 1);
  assert.doesNotMatch(w.mail[0].body, /every few hours/);
  assert.match(w.mail[0].body, /about once an hour/);
  const failedLogs = () => w.log().filter((l) => /RUN FAILED/.test(l)).length;
  assert.strictEqual(failedLogs(), 1);
  // The next triggers, 15 and 45 minutes later, do nothing.
  for (const later of ["2026-10-21T17:15:00Z", "2026-10-21T17:45:00Z"]) {
    const again = fakeWorld({ SERVICE_TYPE_ID: "42" }, { key: true, now: later });
    Object.assign(again.props, { LAST_ATTEMPT: w.props.LAST_ATTEMPT });
    again.world.runSundaySlides();
    assert.strictEqual(again.fetches.length, 0, later);
  }
  // An hour later it tries again.
  const hour = fakeWorld({ SERVICE_TYPE_ID: "42" }, { key: true, now: "2026-10-21T18:01:00Z" });
  hour.props.LAST_ATTEMPT = w.props.LAST_ATTEMPT;
  assert.throws(() => hour.world.runSundaySlides(), /no network/);
});

// ---- which folder holds template.pro

function folderOf(id, files, trashed = false) {
  return { getId: () => id, isTrashed: () => trashed, getFiles: () => { let i = 0; return { hasNext: () => i < files.length, next: () => files[i++] }; } };
}

test("template.pro is looked for in the Sunday Slides folder that setup made, not wherever the sheet was moved", () => {
  const w = fakeWorld({});
  const logs = [];
  const home = folderOf("folder-home", [driveFile("template.pro", "2026-10-20", GEORGIA)]);
  const elsewhere = folderOf("folder-elsewhere", []);
  w.props.TEMPLATE_FOLDER_ID = "folder-home";
  w.world.DriveApp = {
    getFileById: () => ({ getParents: () => ({ hasNext: () => true, next: () => elsewhere }) }),
    getFolderById: (id) => { if (id !== "folder-home") throw new Error("not found"); return home; },
    getRootFolder: () => { throw new Error("should not be needed"); },
  };
  const t = w.world.ss_template(w.world.PropertiesService.getScriptProperties(), { log: (x) => logs.push(x) });
  assert.strictEqual(t.source, "custom");
});

test("if the stored folder is gone or in the trash, the sheet's own folder is used", () => {
  for (const gone of [() => { throw new Error("not found"); }, () => folderOf("folder-home", [], true)]) {
    const w = fakeWorld({});
    const logs = [];
    const elsewhere = folderOf("folder-elsewhere", [driveFile("template.pro", "2026-10-20", GEORGIA)]);
    w.props.TEMPLATE_FOLDER_ID = "folder-home";
    w.world.DriveApp = {
      getFileById: () => ({ getParents: () => ({ hasNext: () => true, next: () => elsewhere }) }),
      getFolderById: gone,
      getRootFolder: () => { throw new Error("should not be needed"); },
    };
    assert.strictEqual(w.world.ss_template(w.world.PropertiesService.getScriptProperties(), { log: (x) => logs.push(x) }).source, "custom");
  }
});

test("creating the control sheet remembers the Sunday Slides folder it was put in", () => {
  const w = fakeWorld({});
  delete w.props.CONTROL_SHEET_ID;
  let moved = null;
  const made = folderOf("folder-new", []);
  w.world.DriveApp = {
    getFileById: () => ({ moveTo: (f) => { moved = f; } }),
    getRootFolder: () => ({ getFoldersByName: () => ({ hasNext: () => false }), createFolder: () => made }),
  };
  w.world.ctl_open(w.world.PropertiesService.getScriptProperties());
  assert.strictEqual(moved, made);
  assert.strictEqual(w.props.TEMPLATE_FOLDER_ID, "folder-new");
});
