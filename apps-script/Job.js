/**
 * The weekly Sunday Slides run: look at the upcoming plans, make slides for songs that have none, and report.
 * Pure logic over an injected env, so the same code runs on the Apps Script trigger and in Node tests.
 *
 * env = { pco, serviceTypeId, planCount, now: Date, mode: "dry-run" | "live", approvalRequired: boolean,
 *         sched: { timeZone, freezeDay: 0 Sunday .. 6 Saturday, freezeMinutes: minutes after midnight },
 *         template (optional): { source, assets, layout, problem } from tpl_choose; the built-in look when missing,
 *         onlyPlanId (optional, testing), state: { get(key), set(key, value) },
 *         control: { approvals() -> { key: status }, putApproval(row), setThisSunday(rows), log(text) } }
 *
 * Safety: never replaces or deletes an attachment; read-only during the freeze; never writes to
 * Planning Center unless mode is "live"; new slides wait for approval unless approvalRequired is false.
 */

var JOB_PRO = /\.pro\d?$/i;   // ProPresenter files (.pro, also the old .pro6 and .pro7)
var JOB_DEFAULT_SCHED = { timeZone: null, freezeDay: 0, freezeMinutes: 8 * 60 };   // Sunday 08:00
var JOB_RETRY_MS = 3600 * 1000;   // a failed run is not retried sooner than this (outside the busy time before the freeze)
var JOB_PENDING_MINUTES = 30;   // an attach that started this long ago and left no file was cut off, not still running
var JOB_SLACK_MINUTES = 3 * 60 + 15;   // every run counts until this long after the freeze starts (read-only then)

/** The schedule to use: env.sched, with the script's own time zone when none is set. */
function job_sched(sched) {
  var s = sched || JOB_DEFAULT_SCHED;
  var tz = s.timeZone || (typeof Session !== "undefined" ? Session.getScriptTimeZone() : "UTC");
  return { timeZone: tz, freezeDay: s.freezeDay, freezeMinutes: s.freezeMinutes };
}

/** { day: 0 Sunday .. 6 Saturday, minutes: minutes after midnight } in the given time zone. */
function job_clock(now, timeZone) {
  if (typeof Utilities !== "undefined") {
    var p = Utilities.formatDate(now, timeZone, "u HH mm").split(" ");
    return job_checkClock({ day: parseInt(p[0], 10) % 7, minutes: parseInt(p[1], 10) * 60 + parseInt(p[2], 10) }, timeZone);
  }
  var parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone: timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).forEach(function (x) { parts[x.type] = x.value; });
  return job_checkClock({ day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
    minutes: parseInt(parts.hour, 10) % 24 * 60 + parseInt(parts.minute, 10) }, timeZone);
}

/** An unreadable clock must stop the run, never silently switch the freeze off. */
function job_checkClock(t, timeZone) {
  if (!(t.day >= 0 && t.day <= 6 && t.minutes >= 0 && t.minutes < 1440)) throw new Error("could not read the clock in time zone " + timeZone + ": " + JSON.stringify(t));
  return t;
}

/** True from the freeze time on the freeze day until midnight (default: Sunday 08:00 onward). */
function job_frozen(now, sched) {
  var c = job_sched(sched), t = job_clock(now, c.timeZone);
  return t.day === c.freezeDay && t.minutes >= c.freezeMinutes;
}

/**
 * The trigger fires about every 15 minutes; this decides which of those runs do work. lastRun: ISO or null.
 * lastFail: ISO of the last failed run, or null.
 * Every run counts on the evening before the freeze day (from 17:00) and on the freeze day until a few hours after
 * the freeze starts (read-only after it); otherwise about every 4 hours between 07:00 and 22:00.
 * After a failed run, wait an hour before the next try, except from the evening before the freeze day until the
 * freeze time, when every trigger may try again.
 */
function job_shouldRun(now, lastRun, sched, lastFail) {
  var c = job_sched(sched), t = job_clock(now, c.timeZone), eve = (c.freezeDay + 6) % 7;
  var beforeFreeze = (t.day === eve && t.minutes >= 17 * 60) || (t.day === c.freezeDay && t.minutes < c.freezeMinutes);
  var failedAt = lastFail ? new Date(lastFail).getTime() : 0;
  if (failedAt > 0 && !beforeFreeze && now.getTime() - failedAt < JOB_RETRY_MS) return false;
  if (t.day === eve && t.minutes >= 17 * 60) return true;
  if (t.day === c.freezeDay && t.minutes < c.freezeMinutes + JOB_SLACK_MINUTES) return true;
  if (t.minutes < 7 * 60 || t.minutes >= 22 * 60) return false;   // quiet overnight
  var last = lastRun ? new Date(lastRun).getTime() : 0;
  return !(last > 0) || now.getTime() - last >= 4 * 3600 * 1000;  // otherwise about every 4 hours
}

/** The evening before the freeze day, 20:00 or later: time for the weekly "songs need a look" email. */
function job_isAlertTime(now, sched) {
  var c = job_sched(sched), t = job_clock(now, c.timeZone);
  return t.day === (c.freezeDay + 6) % 7 && t.minutes >= 20 * 60;
}

/** Calendar date (YYYY-MM-DD) in the given time zone, used to send each alert at most once a day. */
function job_dateKey(now, timeZone) {
  var tz = timeZone || job_sched(null).timeZone;
  if (typeof Utilities !== "undefined") return Utilities.formatDate(now, tz, "yyyy-MM-dd");
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function job_hash(text) {
  var h = 0x811c9dc5, s = String(text || "").replace(/\r\n?/g, "\n").trim();
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ("0000000" + h.toString(16)).slice(-8);
}

/**
 * The .pro file name for a song. Letters and digits of any script are kept (Korean, Chinese, Hindi...). Latin letters
 * lose their accents so the name is plain to type on any computer; everything unsafe in a file name is dropped.
 */
function job_filename(title, arrangementName) {
  var name = String(title || "");
  if (arrangementName && !/default/i.test(arrangementName)) name += " (" + arrangementName + ")";
  var safe = name.normalize("NFC").replace(/[\u2018\u2019]/g, "'")
    .replace(/\p{Script=Latin}+/gu, function (run) { return run.normalize("NFD").replace(/\p{M}/gu, ""); })
    .replace(/[^\p{L}\p{M}\p{N} ()'&,.-]/gu, "").replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  if (!safe) throw new Error("song title has no usable characters for a file name");
  return safe + ".pro";
}

/** The key of an approval row. It starts with a letter so Sheets never reads it as a number or a date. */
function job_approvalKey(arrangementId, fingerprint) {
  return "a" + arrangementId + ":" + fingerprint;
}

function job_meta(item) {
  var a = item.song ? item.song.attributes : {};
  var year = /\b(1[5-9]\d\d|20\d\d)\b/.exec(a.copyright || "");
  return { title: a.title || item.title, author: a.author || "", ccli: parseInt(a.ccli_number, 10) || 0,
    year: year ? parseInt(year[1], 10) : 0 };
}

/** PCO arrangement sequence ("Verse 1", "Chorus 1", "Intro", ...) to slide groups; parts with no lyrics are skipped. */
function job_sequence(pcoSequence, groups) {
  var byName = {}, used = [], skipped = [];
  groups.forEach(function (g) { byName[pw_groupName(g.label)] = true; });
  (pcoSequence || []).forEach(function (label) {
    // Try the label as ProPresenter group names are written ("Pre-Chorus 2" -> "PreChorus 2"), as written, and the
    // "Down-" form for when only a quieter section carries the words ("Chorus" -> "Down-Chorus").
    var tries = [pw_groupName(String(label)), String(label), "Down-" + pw_groupName(String(label))], hit = null;
    for (var i = 0; i < tries.length && !hit; i++) {
      var compact = tries[i].replace(/\s+/g, "");
      try { pw_sequenceName(compact, byName); hit = compact; } catch (e) { /* try the next form */ }
    }
    if (hit) used.push(hit);
    else if (skipped.indexOf(String(label)) < 0) skipped.push(String(label));
  });
  if (!used.length) used = groups.map(function (g) { return pw_groupName(g.label).replace(/\s+/g, ""); });
  return { sequence: used, skipped: skipped };
}

/** Lyrics as slides should show them: no (ad-libs), [notes], echoes or repeat marks (x2, Repeat). Labels are kept. */
// Hymnal spellings like ev'ry and heav'n, written out in full on the screen.
var JOB_FULL_WORDS = {
  "ev'ry": "every", "ev'rything": "everything", "ev'ryone": "everyone", "ev'rywhere": "everywhere", "ev'rybody": "everybody",
  "heav'n": "heaven", "heav'ns": "heavens", "heav'nly": "heavenly", "o'er": "over", "ne'er": "never", "e'er": "ever",
  "whate'er": "whatever", "where'er": "wherever", "pow'r": "power", "pow'rs": "powers", "pow'rful": "powerful",
  "flow'r": "flower", "flow'rs": "flowers", "tow'r": "tower", "show'rs": "showers", "wand'ring": "wandering",
  "wand'rer": "wanderer", "wond'rous": "wondrous", "vict'ry": "victory", "vict'ries": "victories", "mem'ry": "memory",
  "myst'ry": "mystery", "glor'ous": "glorious", "hast'ning": "hastening", "list'ning": "listening", "lab'ring": "laboring",
  "trav'ler": "traveler", "sov'reign": "sovereign", "sov'reignty": "sovereignty", "gath'ring": "gathering",
  "suff'ring": "suffering", "off'ring": "offering", "ris'n": "risen", "giv'n": "given", "driv'n": "driven", "forgiv'n": "forgiven"
};

function job_fullWords(line) {
  return line.replace(/[A-Za-z]*['’][A-Za-z]+/g, function (word) {
    var full = JOB_FULL_WORDS[word.replace(/’/g, "'").toLowerCase()];
    if (!full) return word;
    if (word === word.toUpperCase()) return full.toUpperCase();
    if (word.charAt(0) === word.charAt(0).toUpperCase()) return full.charAt(0).toUpperCase() + full.slice(1);
    return full;
  });
}

function job_cleanLyrics(text) {
  var out = [];
  String(text || "").replace(/\r\n?/g, "\n").split("\n").forEach(function (raw) {
    var line = job_fullWords(raw).replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ");
    line = line.replace(/(^|\s)(x\s*\d+|\d+\s*x)(?=\s|$)/gi, " ");
    line = line.replace(/\s+/g, " ").trim();
    if (!raw.trim()) { out.push(""); return; }
    if (!line || /^(repeat|rpt)\b/i.test(line) || /^[-*.,!?:;]+$/.test(line)) return;
    out.push(line);
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function job_preview(groups) {
  return groups.map(function (g) {
    return "[" + g.label + "]\n" + g.slides.map(function (s) { return s.join(" / "); }).join("\n");
  }).join("\n\n");
}

/** Decide (and, in live mode, do) what one song needs. Returns a result row for the report. */
function job_song(env, item, ctx) {
  var row = { title: item.title, songId: item.songId, arrangementId: item.arrangementId, status: "", note: "" };
  if (!item.songId || !item.arrangementId) { row.status = "no-arrangement"; row.note = "Pick an arrangement for this song in the plan."; return row; }
  var arrAttrs = item.arrangement && item.arrangement.attributes ? item.arrangement.attributes : {};
  var lyrics = arrAttrs.lyrics || "", hash = job_hash(lyrics), record = env.state.get("att:" + item.arrangementId);
  var pros = pco_attachments(env.pco, item.songId, item.arrangementId).filter(function (a) { return JOB_PRO.test(a.attributes.filename || ""); });
  var cutOffNote = "";
  if (pros.length) {
    // The file is there, so an attach that was cut off before it finished is confirmed.
    if (record && record.pending) {
      record = { hash: record.hash, filename: record.filename, at: record.at };
      env.state.set("att:" + item.arrangementId, record);
    }
    if (record && lyrics.trim() && record.hash !== hash) {
      row.status = "lyrics-changed";
      row.note = "Lyrics changed after Sunday Slides made slides (" + record.filename + "). Slides were NOT replaced; check them.";
    } else { row.status = "ready"; row.note = "Has slides: " + pros.map(function (a) { return a.attributes.filename; }).join(", "); }
    return row;
  }
  if (record && record.pending) {
    // A run was cut off (the Apps Script time limit, say) after it wrote the record and before it saw the file land.
    // Planning Center shows no file, so try again, but only once the earlier request cannot still be on its way.
    var ageMs = job_now(env).getTime() - new Date(record.at).getTime();
    if (!(ageMs >= JOB_PENDING_MINUTES * 60000)) {
      row.status = "attach-unconfirmed";
      row.note = "An earlier run started attaching " + record.filename + " and has not been confirmed yet. It will check again in a few minutes.";
      return row;
    }
    cutOffNote = "An earlier run was cut off while attaching " + record.filename + " and Planning Center shows no file, so it is being tried again. ";
    env.state.set("att:" + item.arrangementId, null);
    record = null;
  }
  if (record) {
    row.status = "removed-by-user";
    row.note = "Sunday Slides attached " + record.filename + " before and it was removed, so it will not add it again. Make slides by hand.";
    return row;
  }
  if (!lyrics.trim()) {
    var imported = job_importLyrics(env, item, ctx);
    if (imported.lyrics) { lyrics = imported.lyrics; hash = job_hash(lyrics); arrAttrs = imported.attrs; }
    else { row.status = "needs-lyrics"; row.note = imported.note; return row; }
  }

  var slideText = job_cleanLyrics(lyrics);
  var tpl = env.template || tpl_default();
  var draft = draftSlides(slideText, tpl.layout), seq = job_sequence(arrAttrs.sequence, draft.groups);
  var meta = job_meta(item), filename = job_filename(meta.title, arrAttrs.name), built;
  try { built = pw_build(draft.groups, slideText, meta, seq.sequence, null, tpl.assets); }
  catch (e) { row.status = "error"; row.note = "Could not make slides: " + e.message; return row; }
  if (!built.slides) { row.status = "error"; row.note = "No lyric lines found under the section labels; nothing to put on slides."; return row; }
  var notes = draft.flags.slice();
  if (seq.skipped.length) notes.push("No lyrics for: " + seq.skipped.join(", "));
  var preview = job_preview(draft.groups);
  // The approval covers exactly what was shown: slides, order, title and the template the slides are built from.
  var look = tpl.source === "custom" && tpl.hash ? tpl.hash : "default";
  var key = job_approvalKey(item.arrangementId, job_hash(preview + "\n|" + seq.sequence.join(",") + "\n|" + meta.title + "\n|" + filename + "\n|" + look));
  var approval = ctx.approvals[key];
  if (approval === "REJECTED") { row.status = "rejected"; row.note = "Draft rejected in the control sheet. Fix the lyrics in Planning Center or make slides by hand."; return row; }
  if (env.approvalRequired && approval !== "APPROVED") {
    if (!approval) {
      env.control.putApproval({ key: key, title: meta.title, status: "PENDING", slides: built.slides,
        preview: preview, notes: notes.join("; "), sequence: seq.sequence.join(", ") });
      ctx.approvals[key] = "PENDING";
    }
    row.status = "pending-approval"; row.note = built.slides + " slides drafted; waiting for approval in the control sheet.";
    return row;
  }
  if (env.mode !== "live") { row.status = "would-attach"; row.note = "Dry run: would attach " + filename + " (" + built.slides + " slides)."; return row; }
  if (ctx.frozen || job_frozen(job_now(env), env.sched)) { row.status = "frozen"; row.note = "Freeze: slides not attached. Make them by hand if needed."; return row; }
  // Record first, so a lost response can never leave our file in Planning Center without a record.
  env.state.set("att:" + item.arrangementId, { hash: hash, filename: filename, at: job_now(env).toISOString(), pending: true });
  try {
    pco_attachPro(env.pco, item.songId, item.arrangementId, filename, built.bytes);
  } catch (e) {
    var landed = false;
    try { landed = pco_attachments(env.pco, item.songId, item.arrangementId).some(function (a) { return a.attributes.filename === filename; }); }
    catch (ignored) { landed = true; }   // cannot tell: keep the record, the safe side
    if (!landed) env.state.set("att:" + item.arrangementId, null);
    throw e;
  }
  env.state.set("att:" + item.arrangementId, { hash: hash, filename: filename, at: job_now(env).toISOString() });
  env.control.putApproval({ key: key, title: meta.title, status: "ATTACHED", slides: built.slides });
  row.status = "attached"; row.note = cutOffNote + "Attached " + filename + " (" + built.slides + " slides)" + (notes.length ? ". " + notes.join("; ") : "");
  return row;
}

/**
 * A song in a plan has no lyrics: in live mode, ask Planning Center to import Lyrics (never chord sheets) from
 * SongSelect, at most once a day per arrangement, never during the freeze. Returns { lyrics, attrs, note }.
 */
function job_importLyrics(env, item, ctx) {
  var ccli = item.song && item.song.attributes ? item.song.attributes.ccli_number : null;
  var manual = "No lyrics in Planning Center. Import them from SongSelect (Lyrics) on this arrangement.";
  if (!ccli) return { note: "No lyrics and no CCLI number, so SongSelect cannot supply them. Add the CCLI number or the lyrics in Planning Center." };
  if (env.mode !== "live") return { note: "No lyrics yet. A live run will import them from SongSelect (Lyrics only)." };
  if (ctx.frozen || job_frozen(job_now(env), env.sched)) return { note: "Freeze: lyrics not imported. " + manual };
  var stamp = "imp:" + item.arrangementId, today = job_dateKey(job_now(env), job_sched(env.sched).timeZone);
  if (env.state.get(stamp) === today) return { note: "SongSelect import already tried today and gave no lyrics. " + manual };
  env.state.set(stamp, today);
  try { pco_importLyrics(env.pco, item.songId, item.arrangementId); }
  catch (e) { return { note: "SongSelect import failed (" + e.message + "). " + manual }; }
  // Planning Center finishes the import a few seconds after the request, so wait briefly.
  for (var tries = 0; tries < 6; tries++) {
    var attrs = (pco_arrangement(env.pco, item.songId, item.arrangementId) || {}).attributes || {};
    if ((attrs.lyrics || "").trim()) return { lyrics: attrs.lyrics, attrs: attrs };
    if (tries < 5) env.pco.sleep(3000);
  }
  return { note: "Lyrics import from SongSelect was started; slides will be made on the next run if SongSelect has them. " + manual };
}

/** The current time: env.clock() in production (re-read before each write), env.now in tests. */
function job_now(env) { return env.clock ? env.clock() : env.now; }

function job_run(env) {
  var frozen = job_frozen(env.now, env.sched), ctx = { frozen: frozen, approvals: env.control.approvals() };
  var plans = env.onlyPlanId ? [pco_plan(env.pco, env.serviceTypeId, env.onlyPlanId)]
    : pco_upcomingPlans(env.pco, env.serviceTypeId, env.planCount || 3);
  var done = {}, report = [];
  plans.forEach(function (plan) {
    var label = plan.attributes.dates || plan.attributes.title || plan.id;
    var items = pco_planSongs(env.pco, env.serviceTypeId, plan.id);
    if (!items.length) report.push({ plan: label, planId: plan.id, title: "(no songs)", status: "no-songs", note: "This plan has no songs yet." });
    items.forEach(function (item) {
      var row = item.arrangementId ? done[item.arrangementId] : null;
      if (!row) {
        try { row = job_song(env, item, ctx); }
        catch (e) { row = { title: item.title, status: "error", note: e.message }; }
        if (item.arrangementId) done[item.arrangementId] = row;
      }
      report.push({ plan: label, planId: plan.id, title: row.title, status: row.status, note: row.note });
    });
  });
  var first = plans.length ? plans[0].id : null;
  if (!env.onlyPlanId) env.control.setThisSunday(report.filter(function (r) { return r.planId === first; }));
  var counts = {};
  report.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
  var tplInfo = env.template || tpl_default();
  var summary = { at: env.now.toISOString(), mode: env.mode, frozen: frozen, plans: plans.length, counts: counts, report: report,
    template: tplInfo.source, templateProblem: tplInfo.problem || null };
  env.control.log(JSON.stringify({ at: summary.at, mode: summary.mode, frozen: frozen, plans: plans.length, counts: counts, template: tplInfo.source }));
  return summary;
}

/** Text of the weekly "songs need a look" alert email. */
function job_alertText(summary) {
  var problems = summary.report.filter(function (r) { return ["ready", "attached"].indexOf(r.status) < 0; });
  var tplNote = summary.templateProblem ? "Your template.pro was not used (" + summary.templateProblem + "), so new slides use the built-in look.\n\n" : "";
  if (!problems.length) return tplNote ? "Sunday Slides: a setting needs a look before Sunday.\n\n" + tplNote.trim() : null;
  var songs = problems.filter(function (r) { return r.status !== "no-songs"; }).length, empty = problems.length - songs;
  var head = [songs ? songs + " song(s) need a look" : "", empty ? empty + " plan(s) have no songs yet" : ""].filter(Boolean).join(" and ");
  return "Sunday Slides: " + head + " before Sunday.\n\n" + tplNote +
    problems.map(function (r) { return "- " + r.plan + ": " + (r.status === "no-songs" ? "no songs in the plan yet" : r.title + " (" + r.status + "). " + r.note); }).join("\n");
}
