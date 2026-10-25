/**
 * Settings. The admin edits them on the "Settings" tab of the control sheet (one row per setting: name, value, notes).
 * This file holds only pure logic (defaults, parsing, checking) so Node tests can run it; Control.js reads and
 * writes the tab, and Main.js uses the result.
 *
 * A blank value means "use the default". A value that cannot be understood is reported as a problem and the job
 * refuses to run until it is fixed. It never guesses, because a wrong guess could attach slides at the wrong time.
 */

var SET_DEFS = [
  { key: "SERVICE_TYPE_ID", sheet: "", note: "Required. The number in the address of your Planning Center Services service type (.../service_types/NUMBER)." },
  { key: "PLAN_COUNT", sheet: "3", note: "How many upcoming plans to look at (1 to 10)." },
  { key: "ALERT_EMAIL", sheet: "", note: "Where the weekly \"songs need a look\" email goes. Blank: the Google account that owns this script. Type none to turn the emails off." },
  { key: "TIME_ZONE", sheet: "", note: "Required unless this script's own time zone is set to yours. For example America/Chicago or Europe/London. Capitals matter. A new Apps Script project is on UTC, so fill this in." },
  { key: "FREEZE_DAY", sheet: "Sunday", note: "Day of the week when slides are locked in. After the freeze time on this day nothing is attached or imported." },
  { key: "FREEZE_TIME", sheet: "08:00", note: "Time of day when the freeze starts, 24 hour clock, in the time zone above (for example 08:00)." },
  { key: "MODE", sheet: "dry-run", note: "dry-run: make drafts and report, change nothing in Planning Center. live: attach approved slides." },
  { key: "APPROVAL_REQUIRED", sheet: "yes", note: "yes: new slides wait for APPROVED on the Approvals tab. no: attach right away (live mode only)." },
  { key: "PAUSED", sheet: "no", note: "yes stops every run until you change it back to no." },
];

var SET_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
var SET_DEFAULT_PLAN_COUNT = 3;

// A script still on the default UTC/GMT zone has never been set to the church's zone, so it cannot stand in for it.
var SET_UNSET_ZONE = /^(utc|gmt|etc\/.*)$/i;
// What a canonical-looking zone name looks like, used only for names Intl maps to another spelling (Asia/Kolkata).
var SET_ZONE_SHAPE = /^[A-Z][A-Za-z0-9_+\-]*(\/[A-Z][A-Za-z0-9_+\-]*)*$/;

/** "" when tz is a zone name the clock code can use, else a short reason. Intl is the first check, Utilities the second. */
function set_timeZoneProblem(tz) {
  var resolved;
  try { resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone; }
  catch (e) { return "is not a time zone name"; }
  if (resolved !== tz) {
    if (resolved.toLowerCase() === tz.toLowerCase()) return "is spelled with the wrong capitals (use " + resolved + ")";
    if (!SET_ZONE_SHAPE.test(tz)) return "is spelled with the wrong capitals (names look like America/Chicago)";
  }
  // The job reads the clock through Utilities.formatDate in Apps Script, so the zone has to work there too.
  if (typeof Utilities !== "undefined") {
    try { Utilities.formatDate(new Date(0), tz, "yyyy"); }
    catch (e) { return "is not a time zone name"; }
  }
  return "";
}

/**
 * Rows of the Settings tab ([name, value, notes] each, header row first) to { NAME: "value" }.
 * timeZone: the spreadsheet's time zone. Sheets hands a time like 08:45 back as a Date, so FREEZE_TIME is turned back into HH:mm.
 */
function set_parseRows(rows, timeZone) {
  var raw = {};
  (rows || []).forEach(function (r) {
    var key = String(r[0] == null ? "" : r[0]).trim().toUpperCase();
    if (key) raw[key] = set_cellText(key, r[1], timeZone);
  });
  return raw;
}

function set_cellText(key, v, timeZone) {
  if (v == null) return "";
  if (Object.prototype.toString.call(v) === "[object Date]") {
    if (isNaN(v.getTime())) return "";
    if (key !== "FREEZE_TIME") return v.toISOString();
    if (typeof Utilities !== "undefined" && timeZone) return Utilities.formatDate(v, timeZone, "HH:mm");
    return ("0" + v.getHours()).slice(-2) + ":" + ("0" + v.getMinutes()).slice(-2);
  }
  return String(v).trim();
}

/**
 * raw: { NAME: "value" } as typed. ctx: { scriptTimeZone, ownerEmail }.
 * Returns { settings, errors } where settings holds the understood, typed values and errors lists what to fix.
 */
function set_normalize(raw, ctx) {
  raw = raw || {};
  ctx = ctx || {};
  var errors = [], s = {};
  var yesNo = function (key, dflt) {
    var v = String(raw[key] || "").toLowerCase();
    if (!v) return dflt;
    if (v === "yes" || v === "no") return v === "yes";
    errors.push(key + " must be yes or no (it says \"" + raw[key] + "\").");
    return dflt;
  };

  var id = String(raw.SERVICE_TYPE_ID || "");
  if (!id) errors.push("SERVICE_TYPE_ID is empty. Open your service type in Planning Center Services and copy the number from the address (.../service_types/NUMBER).");
  else if (!/^\d+$/.test(id)) errors.push("SERVICE_TYPE_ID must be only digits (it says \"" + id + "\").");
  s.serviceTypeId = id;

  var count = raw.PLAN_COUNT ? Number(raw.PLAN_COUNT) : SET_DEFAULT_PLAN_COUNT;
  if (!(count >= 1 && count <= 10 && Math.floor(count) === count)) {
    errors.push("PLAN_COUNT must be a whole number from 1 to 10 (it says \"" + raw.PLAN_COUNT + "\").");
    count = SET_DEFAULT_PLAN_COUNT;
  }
  s.planCount = count;

  var mail = String(raw.ALERT_EMAIL || "");
  if (!mail) mail = ctx.ownerEmail || "";
  else if (/^(none|off|no)$/i.test(mail)) mail = "";
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) {
    errors.push("ALERT_EMAIL is not an email address (it says \"" + mail + "\"). Use none to turn the emails off.");
    mail = ctx.ownerEmail || "";
  }
  s.alertEmail = mail;

  var tz = String(raw.TIME_ZONE || "");
  if (!tz) {
    var own = ctx.scriptTimeZone || "";
    if (!own || SET_UNSET_ZONE.test(own)) {
      errors.push("TIME_ZONE is empty and this script's own time zone is " + (own || "not set") + ". Type your time zone on the Settings tab, for example America/Chicago or Europe/London.");
      tz = "UTC";
    } else tz = own;
  }
  var tzProblem = set_timeZoneProblem(tz);
  if (tzProblem) {
    errors.push("TIME_ZONE \"" + tz + "\" " + tzProblem + ". Use a name like America/Chicago or Europe/London.");
    tz = ctx.scriptTimeZone || "UTC";
  }
  s.timeZone = tz;

  var day = SET_DAYS.indexOf(String(raw.FREEZE_DAY || "Sunday").toLowerCase());
  if (day < 0) { errors.push("FREEZE_DAY must be a day of the week such as Sunday (it says \"" + raw.FREEZE_DAY + "\")."); day = 0; }
  var time = /^(\d{1,2}):(\d{2})$/.exec(String(raw.FREEZE_TIME || "08:00"));
  var minutes = time ? parseInt(time[1], 10) * 60 + parseInt(time[2], 10) : -1;
  if (!time || parseInt(time[1], 10) > 23 || parseInt(time[2], 10) > 59) {
    errors.push("FREEZE_TIME must look like 08:00, on a 24 hour clock (it says \"" + raw.FREEZE_TIME + "\").");
    minutes = 8 * 60;
  }
  s.sched = { timeZone: tz, freezeDay: day, freezeMinutes: minutes };

  var mode = String(raw.MODE || "dry-run").toLowerCase();
  if (mode !== "dry-run" && mode !== "live") { errors.push("MODE must be dry-run or live (it says \"" + raw.MODE + "\")."); mode = "dry-run"; }
  s.mode = mode;
  s.approvalRequired = yesNo("APPROVAL_REQUIRED", true);
  s.paused = yesNo("PAUSED", false);
  return { settings: s, errors: errors };
}
