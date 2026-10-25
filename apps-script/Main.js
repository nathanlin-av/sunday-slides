/**
 * Entry points. Run these from the Apps Script editor (the trigger runs runSundaySlides on its own):
 *   setupSundaySlides()   one time: creates the control sheet (with a Settings tab) and the 15-minute trigger.
 *   runSundaySlides()     the trigger: does work only at the times job_shouldRun allows.
 *   runSundaySlidesNow()  manual run, ignoring the schedule (still obeys MODE, PAUSED and the freeze).
 *   runSelfTest()         builds a public-domain test song and checks it matches the reference bytes.
 *   showStatus()          logs the settings, the sheet address and the triggers.
 *
 * Settings: the "Settings" tab of the control sheet (see Settings.js for the full list).
 * Look: a file called template.pro in the "Sunday Slides" Drive folder, if there is one, sets the font, colors and position of the
 * slides (see Template.js). Without it, or if it cannot be used, the built-in look from Assets.js is used and the Log tab says so.
 * Secrets: PCO_APP_ID and PCO_SECRET, the Planning Center personal access token, in Project Settings > Script Properties.
 */

/** SHA-256 of the self-test song. tests/selftest.test.js checks this against the reference file. */
var SS_SELFTEST_SHA256 = "6793d7f79a31eb067f6b22584d12c3152d0679ca89aec048c369ef2f7a9da34b";

function ss_http(req) {
  var opts = { method: req.method.toLowerCase(), muteHttpExceptions: true, followRedirects: false, headers: { Authorization: req.auth } };
  if (req.payload != null) {
    opts.contentType = req.contentType;
    opts.payload = typeof req.payload === "string" ? req.payload
      : Array.prototype.map.call(req.payload, function (b) { return b > 127 ? b - 256 : b; });
  }
  var r = UrlFetchApp.fetch(req.url, opts), h = r.getHeaders();
  return { code: r.getResponseCode(), text: r.getContentText(), retryAfter: h["Retry-After"] || h["retry-after"] };
}

function ss_ownerEmail() { return Session.getEffectiveUser().getEmail(); }

/** { settings, errors, control }: the Settings tab read and checked, plus the control object for the sheet. */
function ss_loadSettings(props) {
  var ss = ctl_open(props);
  var out = set_normalize(ctl_readSettings(ss), { scriptTimeZone: Session.getScriptTimeZone(), ownerEmail: ss_ownerEmail() });
  out.control = ctl_control(ss);
  return out;
}

function ss_problemText(errors) {
  return "The Settings tab needs fixing:\n- " + errors.join("\n- ");
}

/** The template for this run: your template.pro from the Sunday Slides folder, else the built-in look. Logs when the choice changes. */
function ss_template(props, control) {
  var found;
  try { found = ctl_findTemplate(props); }
  catch (e) { found = { error: "Google Drive would not let the script look for it: " + e.message }; }
  return tpl_choose(found, {
    get: function () { return props.getProperty("TEMPLATE_STATE"); },
    set: function (v) { props.setProperty("TEMPLATE_STATE", String(v).slice(0, 8000)); },
  }, control.log);
}

function ss_env(props, loaded, overrides) {
  var app = props.getProperty("PCO_APP_ID"), secret = props.getProperty("PCO_SECRET"), s = loaded.settings;
  if (!app || !secret) throw new Error("The Planning Center key is not set: add PCO_APP_ID and PCO_SECRET in Project Settings > Script Properties.");
  overrides = overrides || {};
  return {
    pco: { http: ss_http, auth: "Basic " + Utilities.base64Encode(app + ":" + secret), sleep: function (ms) { Utilities.sleep(ms); } },
    serviceTypeId: s.serviceTypeId, planCount: s.planCount, sched: s.sched, now: new Date(), clock: function () { return new Date(); },
    mode: overrides.forceDryRun ? "dry-run" : s.mode,
    approvalRequired: s.approvalRequired, onlyPlanId: overrides.onlyPlanId || null,
    state: {
      get: function (k) { var v = props.getProperty("ss:" + k); return v ? JSON.parse(v) : null; },
      set: function (k, v) { if (v == null) props.deleteProperty("ss:" + k); else props.setProperty("ss:" + k, JSON.stringify(v)); },
    },
    control: loaded.control,
    template: ss_template(props, loaded.control),
  };
}

function ss_run(overrides, loaded) {
  var props = PropertiesService.getScriptProperties();
  loaded = loaded || ss_loadSettings(props);
  if (loaded.errors.length) throw new Error(ss_problemText(loaded.errors));
  if (loaded.settings.paused) return { skipped: "PAUSED is yes on the Settings tab" };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    try { loaded.control.log("SKIPPED: another run was still going"); } catch (ignored) { /* sheet unavailable */ }
    return { skipped: "another run is still going" };
  }
  try {
    var summary = job_run(ss_env(props, loaded, overrides));
    if (!overrides.onlyPlanId) props.setProperty("LAST_RUN", summary.at);
    return summary;
  } catch (e) {
    try { loaded.control.log("RUN FAILED: " + e.message); } catch (ignored) { /* sheet unavailable */ }
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function runSundaySlides() {
  var props = PropertiesService.getScriptProperties(), loaded;
  try { loaded = ss_loadSettings(props); }
  catch (e) {
    ss_alertOnce(props, ss_ownerEmail(), "UTC", "LAST_FAIL_ALERT", "Sunday Slides could not read its settings", e.message);
    throw e;
  }
  var s = loaded.settings;
  if (loaded.errors.length) {
    var problem = ss_problemText(loaded.errors);
    if (props.getProperty("LAST_SETTINGS_PROBLEM") !== problem) {
      props.setProperty("LAST_SETTINGS_PROBLEM", problem);
      try { loaded.control.log(problem); } catch (ignored) { /* sheet unavailable */ }
    }
    ss_alertOnce(props, s.alertEmail, s.timeZone, "LAST_SETTINGS_ALERT", "Sunday Slides needs a setting fixed", problem + "\n\nControl sheet: " + ss_sheetUrl(props));
    return;
  }
  props.deleteProperty("LAST_SETTINGS_PROBLEM");
  if (s.paused || !job_shouldRun(new Date(), props.getProperty("LAST_RUN"), s.sched, props.getProperty("LAST_ATTEMPT"))) return;
  var summary;
  try { summary = ss_run({}, loaded); }
  catch (e) {
    props.setProperty("LAST_ATTEMPT", new Date().toISOString());
    ss_alertOnce(props, s.alertEmail, s.timeZone, "LAST_FAIL_ALERT", "Sunday Slides could not run", "The weekly job failed: " + e.message +
      "\n\nIt will try again about once an hour, and every 15 minutes from the evening before the freeze until the freeze time. " +
      "Nothing was changed in Planning Center by the failed run.");
    throw e;
  }
  props.deleteProperty("LAST_ATTEMPT");
  if (summary && summary.report && job_isAlertTime(new Date(), s.sched)) {
    var text = job_alertText(summary);
    if (text) ss_alertOnce(props, s.alertEmail, s.timeZone, "LAST_SAT_ALERT", "Sunday Slides: songs to check before Sunday",
      text + "\n\nControl sheet: " + ss_sheetUrl(props));
  }
}

function ss_sheetUrl(props) {
  var id = props.getProperty("CONTROL_SHEET_ID");
  return id ? "https://docs.google.com/spreadsheets/d/" + id : "(not found)";
}

/** Send one email per alert kind per calendar day (in timeZone). A blank address means the admin turned emails off. */
function ss_alertOnce(props, to, timeZone, stampKey, subject, body) {
  var today = job_dateKey(new Date(), timeZone);
  if (!to || props.getProperty(stampKey) === today) return;
  MailApp.sendEmail(to, subject, body + "\n\n(Sent by the Sunday Slides job in your Google account. To stop these, type none for ALERT_EMAIL on the Settings tab.)");
  props.setProperty(stampKey, today);
}

function runSundaySlidesNow() {
  var summary = ss_run({});
  Logger.log(JSON.stringify(summary.skipped ? summary : { mode: summary.mode, frozen: summary.frozen, counts: summary.counts }));
  return summary;
}

function setupSundaySlides() {
  var props = PropertiesService.getScriptProperties();
  var ss = ctl_open(props);
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "runSundaySlides") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("runSundaySlides").timeBased().everyMinutes(15).create();
  var loaded = ss_loadSettings(props);
  var out = { account: ss_ownerEmail(), sheet: ss.getUrl(), timeZone: loaded.settings.timeZone, keySet: !!props.getProperty("PCO_SECRET"),
    problemsToFix: loaded.errors };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function showStatus() {
  var props = PropertiesService.getScriptProperties(), loaded = ss_loadSettings(props);
  var out = { account: ss_ownerEmail(), settings: loaded.settings, problemsToFix: loaded.errors, keySet: !!props.getProperty("PCO_SECRET"),
    sheet: ss_sheetUrl(props), triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }) };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Public-domain fixture (Amazing Grace, verse 1) built with fixed IDs; tests/selftest.test.js builds the same bytes. */
var SS_SELFTEST = {
  lyrics: "Verse 1\nAmazing grace, how sweet the sound\nThat saved a wretch like me\nI once was lost, but now am found\nWas blind, but now I see\n",
  meta: { title: "Amazing Grace (self-test)", author: "John Newton", year: 1779, ccli: 22025 },
  sequence: ["V1"],
};

function ss_selftest() {
  var n = 0, draft = draftSlides(SS_SELFTEST.lyrics);
  var built = pw_build(draft.groups, SS_SELFTEST.lyrics, SS_SELFTEST.meta, SS_SELFTEST.sequence, function () {
    n++;
    return "00000000-0000-4000-8000-" + ("000000000000" + n.toString(16).toUpperCase()).slice(-12);
  });
  var out = { slides: built.slides, groups: built.groups, draft: draft.groups, base64: pb_b64encode(built.bytes) };
  if (typeof Utilities !== "undefined") {
    out.sha256 = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Array.prototype.map.call(built.bytes, function (b) { return b > 127 ? b - 256 : b; }))
      .map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
  }
  return out;
}

/** Run this in your own Apps Script project: it proves the code behaves here exactly as it does in the Node tests. */
function runSelfTest() {
  var r = ss_selftest();
  var problems = pw_check(pb_b64decode(r.base64));
  if (problems.length) throw new Error("Self-test failed, the song did not pass its own check: " + problems.join("; "));
  if (SS_SELFTEST_SHA256 && r.sha256 !== SS_SELFTEST_SHA256) {
    throw new Error("Self-test failed: the bytes differ from the reference (" + r.sha256 + " is not " + SS_SELFTEST_SHA256 + ").");
  }
  Logger.log("Self-test passed: " + r.slides + " slides, sha256 " + r.sha256);
  return { ok: true, slides: r.slides, sha256: r.sha256 };
}
