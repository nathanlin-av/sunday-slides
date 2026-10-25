/**
 * The control sheet "Sunday Slides Control", kept in a "Sunday Slides" folder in the admin's Google Drive.
 * Tabs: Settings (the admin's choices), Approvals (set Status to APPROVED or REJECTED), This Sunday, Log, How it works.
 */

var CTL_NAME = "Sunday Slides Control";
var CTL_FOLDER = "Sunday Slides";
var CTL_SETTINGS_HEAD = ["Setting", "Value", "What it does"];
var CTL_APPROVAL_HEAD = ["Key", "Song", "Status", "Slides", "Preview", "Notes", "Order", "Updated"];
var CTL_SUNDAY_HEAD = ["Plan", "Song", "Status", "What to do"];
var CTL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "ATTACHED"];
var CTL_HELP = [
  ["How Sunday Slides works"],
  ["Every week it reads the next plans in Planning Center and makes ProPresenter slides for songs that have none."],
  ["New slides wait here: open Approvals, read the Preview, and set Status to APPROVED (or REJECTED). The next run attaches them."],
  ["It never replaces or deletes slides that are already attached, and it changes nothing after the freeze time set on the Settings tab."],
  ["This Sunday lists every song in the next plan and what, if anything, needs doing."],
  ["Songs with no lyrics need a one-time 'Import from SongSelect' (Lyrics) on the arrangement in Planning Center."],
  ["Your own look: export one ProPresenter slide as template.pro and put it in the Sunday Slides folder in your Drive (the one setup made, even if you have moved this sheet). The Log tab says whether it was used, and why not if it was refused."],
];

function ctl_folder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** The folder setup made (its id is stored when the sheet is created), else the sheet's own folder, else the Drive root's Sunday Slides folder. */
function ctl_templateFolder(props) {
  var stored = props.getProperty("TEMPLATE_FOLDER_ID");
  if (stored) {
    try {
      var kept = DriveApp.getFolderById(stored);
      if (!(typeof kept.isTrashed === "function" && kept.isTrashed())) return kept;
    } catch (e) { /* the folder was deleted: fall back to the sheet's folder */ }
  }
  var id = props.getProperty("CONTROL_SHEET_ID");
  if (id) {
    var parents = DriveApp.getFileById(id).getParents();
    if (parents.hasNext()) return parents.next();
  }
  return ctl_folder(DriveApp.getRootFolder(), CTL_FOLDER);
}

/**
 * The template.pro the admin dropped in the Sunday Slides folder, as { bytes, extra } ; null when there is none;
 * { error } when the file is there but cannot be read. With several files of that name the newest wins.
 */
function ctl_findTemplate(props) {
  var folder = ctl_templateFolder(props);
  var best = null, count = 0, files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (!/^template\.pro$/i.test(f.getName())) continue;
    count++;
    if (!best || f.getLastUpdated().getTime() > best.getLastUpdated().getTime()) best = f;
  }
  if (!best) return null;
  var extra = count > 1 ? count + " files are called template.pro; the newest one is used" : "";
  try {
    var raw = best.getBlob().getBytes(), bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw[i] & 0xff;
    return { bytes: bytes, extra: extra };
  } catch (e) {
    return { error: "the file could not be read from Google Drive: " + e.message };
  }
}

function ctl_open(props) {
  var id = props.getProperty("CONTROL_SHEET_ID");
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (e) {
      throw new Error("The control sheet (" + id + ") could not be opened: " + e.message +
        ". If it was deleted on purpose, remove CONTROL_SHEET_ID in Script Properties and run setupSundaySlides again.");
    }
  }
  var ss = SpreadsheetApp.create(CTL_NAME);
  props.setProperty("CONTROL_SHEET_ID", ss.getId());
  var file = DriveApp.getFileById(ss.getId());
  var folder = ctl_folder(DriveApp.getRootFolder(), CTL_FOLDER);
  file.moveTo(folder);
  props.setProperty("TEMPLATE_FOLDER_ID", folder.getId());
  ctl_prepare(ss);
  return ss;
}

function ctl_tab(ss, name, head) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (head && sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

/** The Settings tab, created with the default values when it is missing. Existing values are never overwritten. */
function ctl_settingsTab(ss) {
  var created = !ss.getSheetByName("Settings");
  var sh = ctl_tab(ss, "Settings", CTL_SETTINGS_HEAD);
  if (created || sh.getLastRow() < 2) {
    // Plain text first: otherwise Sheets turns 08:00 into a time of day and reads it back as a Date.
    sh.getRange("B2:B200").setNumberFormat("@");
    var rows = SET_DEFS.map(function (d) { return [d.key, d.sheet, d.note]; });
    sh.getRange(2, 1, rows.length, 3).setValues(rows);
    sh.setColumnWidth(1, 200);
    sh.setColumnWidth(2, 220);
    sh.setColumnWidth(3, 760);
  }
  return sh;
}

/** The raw settings as typed: { NAME: "value" }. */
function ctl_readSettings(ss) {
  var sh = ctl_settingsTab(ss), n = sh.getLastRow() - 1;
  return set_parseRows(n > 0 ? sh.getRange(2, 1, n, 2).getValues() : [], ss.getSpreadsheetTimeZone());
}

function ctl_prepare(ss) {
  var help = ctl_tab(ss, "How it works");
  help.clear();
  help.getRange(1, 1, CTL_HELP.length, 1).setValues(CTL_HELP);
  help.getRange(1, 1).setFontWeight("bold");
  help.setColumnWidth(1, 900);
  ctl_settingsTab(ss);
  var ap = ctl_tab(ss, "Approvals", CTL_APPROVAL_HEAD);
  ap.setColumnWidth(5, 420);
  ap.getRange("A2:A1000").setNumberFormat("@");   // keys stay text
  ap.getRange("C2:C1000").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(CTL_STATUSES, true).build());
  ctl_tab(ss, "This Sunday", CTL_SUNDAY_HEAD);
  ctl_tab(ss, "Log", ["At", "Summary"]);
  var first = ss.getSheetByName("Sheet1");
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
}

/** The control object job_run expects. */
function ctl_control(ss) {
  var ap = ctl_tab(ss, "Approvals", CTL_APPROVAL_HEAD);
  function rows() {
    var n = ap.getLastRow() - 1;
    return n > 0 ? ap.getRange(2, 1, n, CTL_APPROVAL_HEAD.length).getValues() : [];
  }
  return {
    approvals: function () {
      var out = {};
      rows().forEach(function (r) { if (r[0]) out[String(r[0])] = String(r[2]).trim().toUpperCase(); });
      return out;
    },
    putApproval: function (row) {
      var all = rows(), now = new Date().toISOString();
      for (var i = 0; i < all.length; i++) {
        if (String(all[i][0]) === row.key) { ap.getRange(i + 2, 3).setValue(row.status); ap.getRange(i + 2, 8).setValue(now); return; }
      }
      ap.appendRow([row.key, ctl_cell(row.title), row.status, row.slides || "", ctl_cell(row.preview), ctl_cell(row.notes), ctl_cell(row.sequence), now]);
    },
    setThisSunday: function (report) {
      var sh = ctl_tab(ss, "This Sunday", CTL_SUNDAY_HEAD);
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, CTL_SUNDAY_HEAD.length).clearContent();
      var values = report.map(function (r) { return [ctl_cell(r.plan), ctl_cell(r.title), r.status, ctl_cell(r.note)]; });
      if (values.length) sh.getRange(2, 1, values.length, CTL_SUNDAY_HEAD.length).setValues(values);
    },
    log: function (text) {
      var sh = ctl_tab(ss, "Log", ["At", "Summary"]);
      sh.appendRow([new Date().toISOString(), ctl_cell(text)]);
      if (sh.getLastRow() > 2000) sh.deleteRows(2, sh.getLastRow() - 2000);
    },
  };
}

/** Sheets cells hold at most 50,000 characters, and a leading = + - @ would be read as a formula. */
function ctl_cell(text) {
  var s = String(text == null ? "" : text);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s.length > 45000 ? s.slice(0, 45000) + " ..." : s;
}
