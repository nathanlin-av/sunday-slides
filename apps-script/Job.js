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
var JOB_NAME_MAX = 120;     // characters of a .pro file name before ".pro"; longer titles are cut here
var JOB_NAME_BYTES = 200;   // and bytes: most computers allow 255 for a whole file name

function job_filename(title, arrangementName) {
  var name = String(title || "");
  if (arrangementName && !/default/i.test(arrangementName)) name += " (" + arrangementName + ")";
  var safe = name.normalize("NFC").replace(/[\u2018\u2019]/g, "'")
    .replace(/\p{Script=Latin}+/gu, function (run) { return run.normalize("NFD").replace(/\p{M}/gu, ""); })
    .replace(/[^\p{L}\p{M}\p{N} ()'&,.-]/gu, "").replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  if (!safe) throw new Error("song title has no usable characters for a file name");
  // Whole characters only (Array.from keeps emoji-range letters in one piece), then no space or dot before ".pro".
  // Never a name Windows keeps for itself (CON, NUL, COM1...).
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) safe += " (song)";
  // A long name is cut, in characters and in bytes (Korean or Chinese letters take 3 bytes each), and ends in a
  // short code made from the whole name, so two long titles never share a file name.
  var chars = Array.from(safe);
  if (chars.length > JOB_NAME_MAX || pb_utf8(safe).length > JOB_NAME_BYTES) {
    chars = chars.slice(0, JOB_NAME_MAX - 9);
    while (chars.length > 1 && pb_utf8(chars.join("")).length > JOB_NAME_BYTES - 9) chars.pop();
    safe = chars.join("").replace(/[ .]+$/, "") + " " + job_hash(name);
  }
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
function job_sequence(pcoSequence, groups, order) {
  var byName = {}, used = [], skipped = [];
  groups.forEach(function (g) { byName[pw_groupName(g.label)] = true; });
  (pcoSequence || []).forEach(function (label) {
    // Try the label as ProPresenter group names are written ("Pre-Chorus 2" -> "PreChorus 2"), as written, and the
    // "Down-" form for when only a quieter section carries the words ("Chorus" -> "Down-Chorus").
    var tries = [pw_groupName(String(label)), String(label), "Down-" + pw_groupName(String(label))], hit = null;
    for (var i = 0; i < tries.length && !hit; i++) {
      var compact = tries[i].replace(/\s+/g, "");
      try { hit = pw_sequenceName(compact, byName).replace(/\s+/g, ""); } catch (e) { /* try the next form */ }
    }
    if (hit) used.push(hit);
    else if (skipped.indexOf(String(label)) < 0) skipped.push(String(label));
  });
  // No usable order from Planning Center: the order the sections were typed in, repeats included.
  if (!used.length) used = (order && order.length ? order : groups.map(function (g) { return g.label; }))
    .map(function (label) { return pw_groupName(label).replace(/\s+/g, ""); });
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

// "Repeat", "Repeat Chorus", "Repeat last line twice": an instruction. "Repeat the sounding joy": a lyric.
var JOB_REPEAT_WORDS = new RegExp("^(the|a|chorus|verse|bridge|tag|pre-?chorus|refrain|ending|intro|outro|section|part|line|lines|" +
  "final|instrumental|interlude|vamp|turnaround|bar|bars|fade|out|" +
  "last|first|second|third|all|both|again|once|twice|more|time|times|from|top|to|end|and|as|needed|\\d+(st|nd|rd|th)?|x)$", "i");

var JOB_COUNT = /(^|\s)(x\s*\d+|\d+\s*x)[.,:;!?\u2026]*(?=\s|$)/gi;   // a repeat count: x2, 2x, x 3 (also "x2," and "x2:")

function job_isRepeatMark(line) {
  var words = line.replace(/[.,:;!]+/g, " ").split(/\s+/).filter(function (w) { return w.length; });
  if (!words.length || !/^(repeat|rpt)$/i.test(words[0])) return false;
  for (var i = 1; i < words.length; i++) { if (!JOB_REPEAT_WORDS.test(words[i])) return false; }
  return true;
}

// Lines that come along when lyrics are pasted from a song sheet: license, copyright and credit lines.
var JOB_FOOTER = /^(ccli\b|\u00a9|\(c\)\s*\d|copyright\s*(\u00a9|\(c\)|\d)|for use solely with|all rights reserved\.?$|www\.|https?:)|ccli\.com|songselect/i;
// A credit line names a person or a publisher after "by": "Words and Music by John Newton", "Published by Example
// Music". "Music by the river" and "Words: You are holy" are lyrics.
var JOB_CREDIT = /^((words|lyrics|music|text|tune)(\s+(and|&)\s+(words|lyrics|music))?|published|administered|arranged|arr\.|translated)\s+by\s+(.)/i;

function job_isFooter(raw) {
  if (JOB_FOOTER.test(raw)) return true;
  if (/^(words|lyrics|music)\s+(and|&)\s+(words|lyrics|music)\s*(by\b|:|$)/i.test(raw)) return true;   // "Words and Music by ...": never a lyric
  var credit = JOB_CREDIT.exec(raw);
  return !!credit && credit[6] !== credit[6].toLowerCase();   // the name starts with a capital letter
}

/** One line of lyrics as slides should show it; null when the line is not for the slides. */
function job_cleanLine(raw, isVerseNumber) {
  if (isVerseNumber) return "Verse " + parseInt(raw, 10);
  // "[Verse 1]" and "(Chorus)" are section labels, not notes: keep them, without the brackets. A repeat count in
  // the brackets ("[Chorus x2]"), after them ("[Chorus] x2") or in brackets of its own ("(Chorus) (x2)") is not part of it.
  var boxed = /^[\[(]([^\])]*)[\])](\s*[\[(][^\])]*[\])])*\s*:?$/.exec(raw.replace(JOB_COUNT, " ").replace(/\s+/g, " ").trim());
  if (boxed) {
    var name = boxed[1].replace(JOB_COUNT, " ").replace(/\s+/g, " ").replace(/\s*:$/, "").trim();
    if (drafter_isLabel(name) && !job_isRepeatMark(name)) return name;
  }
  if (job_isFooter(raw)) return null;
  var line = job_fullWords(raw).replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ");
  // What is left when a note is taken out of "found (x3)." is "found .": put the full stop back on its word.
  line = line.replace(JOB_COUNT, " ").replace(/\s+/g, " ").replace(/ ([.,:;!?])/g, "$1").trim();
  line = drafter_trimEdges(line);   // a note taken off the end can leave an unseen mark there
  if (!line || job_isRepeatMark(line) || /^[-*.,!?:;]+$/.test(line)) return null;
  return line;
}

function job_cleanLyrics(text) {
  var out = [], rows = drafter_plainRows(text), number = /^\d{1,2}[.)]?$/;
  rows.forEach(function (row, i) {
    if (!row) { out.push(""); return; }
    // A verse number, as hymn books print them ("1", "2.", "3)"): a number alone on the first line of a stanza,
    // with words on the next line. A sung "3, 2, 1" has a number on the next line and stays as lyrics.
    var next = i + 1 < rows.length ? rows[i + 1] : "";
    var isVerseNumber = number.test(row) && (i === 0 || !rows[i - 1]) && !!next && !number.test(next);
    drafter_rowPieces(row).forEach(function (raw) {
      var line = job_cleanLine(raw, isVerseNumber);
      if (line !== null) out.push(line);
    });
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** How many lines of the lyrics are so long that they are cut into pieces (see drafter_rowPieces). */
function job_longLines(text) {
  return drafter_plainRows(text).filter(function (row) { return drafter_rowPieces(row).length > 1; }).length;
}

/**
 * A fingerprint of the words the slides show: no punctuation and no capitals, so a change of punctuation, capitals
 * or an ad-lib in brackets is not a change, while a changed word, symbol or emoji is. Used to tell whether lyrics changed after slides were attached.
 */
function job_shownKey(lyrics) {
  return job_hash(job_cleanLyrics(lyrics).split("\n").map(function (line) {
    return line.toLowerCase().replace(/[\p{P}\p{Cf}]+/gu, "").replace(/\s+/g, " ").trim();
  }).filter(function (l) { return l.length; }).join("\n"));
}

function job_preview(groups) {
  return groups.map(function (g) {
    return "[" + g.label + "]\n" + g.slides.map(function (s) { return s.join(" / "); }).join("\n");
  }).join("\n\n");
}

var JOB_PREVIEW_MAX = 40000;   // characters of a preview that fit, whole, in one cell of the Approvals tab

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
      record = { hash: record.hash, shown: record.shown, filename: record.filename, at: record.at };
      env.state.set("att:" + item.arrangementId, record);
    }
    // "shown" is a fingerprint of the words on the slides (job_shownKey), so an edit inside (brackets) or to the
    // punctuation is not a change. Records made before it existed only have the hash of the lyrics as typed.
    var changed = record && lyrics.trim() && (record.shown ? record.shown !== job_shownKey(lyrics) : record.hash !== hash);
    // A record from before fingerprints were kept, with the lyrics still as they were: give it one now.
    if (record && !record.shown && !changed && lyrics.trim()) {
      record = { hash: record.hash, shown: job_shownKey(lyrics), filename: record.filename, at: record.at };
      env.state.set("att:" + item.arrangementId, record);
    }
    if (changed) {
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
  var draft = draftSlides(slideText, tpl.layout), seq = job_sequence(arrAttrs.sequence, draft.groups, draft.order);
  var meta = job_meta(item), filename = job_filename(meta.title, arrAttrs.name), built;
  try { built = pw_build(draft.groups, slideText, meta, seq.sequence, null, tpl.assets); }
  catch (e) { row.status = "error"; row.note = "Could not make slides: " + e.message; return row; }
  if (!built.slides) { row.status = "error"; row.note = "No lyric lines found under the section labels; nothing to put on slides."; return row; }
  var notes = draft.flags.slice(), longLines = job_longLines(lyrics);
  if (longLines) notes.push("A very long line was cut into pieces (" + longLines + " such line" + (longLines === 1 ? "" : "s") + "). Add line breaks to the lyrics in Planning Center.");
  if (seq.skipped.length) notes.push("No lyrics for: " + seq.skipped.join(", "));
  var preview = job_preview(draft.groups);
  // The approval covers exactly what was shown: slides, order, title and the template the slides are built from.
  var look = tpl.source === "custom" && tpl.hash ? tpl.hash : "default";
  var key = job_approvalKey(item.arrangementId, job_hash(preview + "\n|" + seq.sequence.join(",") + "\n|" + meta.title + "\n|" + filename + "\n|" + look));
  var approval = ctx.approvals[key];
  if (approval === "REJECTED") { row.status = "rejected"; row.note = "Draft rejected in the control sheet. Fix the lyrics in Planning Center or make slides by hand."; return row; }
  if (env.approvalRequired && preview.length > JOB_PREVIEW_MAX) {
    row.status = "too-long";
    row.note = "This song has too many slides (" + built.slides + ") to show in full on the Approvals tab, so it was not offered for approval. Split it into shorter arrangements or make slides by hand.";
    return row;
  }
  if (env.approvalRequired && approval !== "APPROVED") {
    // ATTACHED with no file and no record: the file was removed and the record cleared by hand. Ask again.
    if (!approval || approval === "ATTACHED") {
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
  var shown = job_shownKey(lyrics);
  env.state.set("att:" + item.arrangementId, { hash: hash, shown: shown, filename: filename, at: job_now(env).toISOString(), pending: true });
  try {
    pco_attachPro(env.pco, item.songId, item.arrangementId, filename, built.bytes);
  } catch (e) {
    var landed = false;
    if (e.nothingPosted) { env.state.set("att:" + item.arrangementId, null); throw e; }   // someone else's file is there, not ours
    try { landed = pco_attachments(env.pco, item.songId, item.arrangementId).some(function (a) { return a.attributes.filename === filename; }); }
    catch (ignored) { landed = true; }   // cannot tell: keep the record, the safe side
    if (!landed) env.state.set("att:" + item.arrangementId, null);
    throw e;
  }
  env.state.set("att:" + item.arrangementId, { hash: hash, shown: shown, filename: filename, at: job_now(env).toISOString() });
  env.control.putApproval({ key: key, title: meta.title, status: "ATTACHED", slides: built.slides });
  row.status = "attached"; row.note = cutOffNote + "Attached " + filename + " (" + built.slides + " slides)" + (notes.length ? ". " + notes.join("; ") : "");
  return row;
}

/**
 * A song in a plan has no lyrics: in live mode, ask Planning Center to import Lyrics (never chord sheets) from
 * SongSelect, at most once a day per arrangement, never during the freeze. Returns { lyrics, attrs, note }.
 */
var JOB_IMPORT_BUDGET_MS = 3 * 60000;   // no new SongSelect import after this much of a run
var JOB_RUN_BUDGET_MS = 4.5 * 60000;    // no new song after this much of a run

function job_importLyrics(env, item, ctx) {
  var ccli = item.song && item.song.attributes ? item.song.attributes.ccli_number : null;
  var manual = "No lyrics in Planning Center. Import them from SongSelect (Lyrics) on this arrangement.";
  if (!ccli) return { note: "No lyrics and no CCLI number, so SongSelect cannot supply them. Add the CCLI number or the lyrics in Planning Center." };
  if (env.mode !== "live") return { note: "No lyrics yet. A live run will import them from SongSelect (Lyrics only)." };
  if (ctx.frozen || job_frozen(job_now(env), env.sched)) return { note: "Freeze: lyrics not imported. " + manual };
  // Each import can wait up to 15 seconds for SongSelect. Apps Script stops a run at 6 minutes, so late in a run
  // the import is left for the next one (in 15 minutes to an hour) instead of risking the whole run.
  if (ctx.startedAt && job_now(env).getTime() - ctx.startedAt > JOB_IMPORT_BUDGET_MS) {
    return { note: "No lyrics yet. This run was short of time, so the SongSelect import is left for the next run." };
  }
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

/** The plan the This Sunday tab shows: the first one on the service day (the freeze day), else the next plan. */
function job_serviceDayPlan(plans, sched) {
  var c = job_sched(sched);
  for (var i = 0; i < plans.length; i++) {
    var when = plans[i].attributes && plans[i].attributes.sort_date ? new Date(plans[i].attributes.sort_date) : null;
    if (when && !isNaN(when.getTime()) && job_clock(when, c.timeZone).day === c.freezeDay) return plans[i].id;
  }
  return plans.length ? plans[0].id : null;
}

function job_run(env) {
  var frozen = job_frozen(env.now, env.sched), ctx = { frozen: frozen, approvals: env.control.approvals(), startedAt: job_now(env).getTime() };
  var plans = env.onlyPlanId ? [pco_plan(env.pco, env.serviceTypeId, env.onlyPlanId)]
    : pco_upcomingPlans(env.pco, env.serviceTypeId, env.planCount || 3);
  // Every song of every plan, in plan order. Work starts at the song where the last run ran out of time (if it
  // did), and wraps round, so slow weeks still reach every song over a few runs. The report keeps plan order.
  var entries = [];
  plans.forEach(function (plan) {
    var label = plan.attributes.dates || plan.attributes.title || plan.id;
    var items = pco_planSongs(env.pco, env.serviceTypeId, plan.id);
    if (!items.length) entries.push({ plan: label, planId: plan.id, row: { title: "(no songs)", status: "no-songs", note: "This plan has no songs yet." } });
    items.forEach(function (item) {
      // The key of a song in a plan, for the resume point: short, whatever the title is.
      entries.push({ plan: label, planId: plan.id, item: item, key: plan.id + ":" + (item.arrangementId || item.itemId || String(item.title || "").slice(0, 80)) });
    });
  });
  // A one-plan run or a forced dry run (a check someone asked for) neither uses nor moves the resume point.
  var keepsPlace = !env.onlyPlanId && !env.forced;
  var resumeAt = keepsPlace ? env.state.get("cursor") : null, start = 0, done = {}, stoppedAt = null;
  for (var k = 0; resumeAt && k < entries.length; k++) { if (entries[k].key === resumeAt) { start = k; break; } }
  for (var n = 0; n < entries.length; n++) {
    var entry = entries[(start + n) % entries.length], item = entry.item;
    if (!item) continue;
    var row = item.arrangementId ? done[item.arrangementId] : null;
    if (!row && job_now(env).getTime() - ctx.startedAt > JOB_RUN_BUDGET_MS) {
      // Apps Script stops a run at 6 minutes. Stop cleanly before that, so the report is always written.
      if (stoppedAt === null) stoppedAt = entry.key;
      continue;
    }
    if (!row) {
      try { row = job_song(env, item, ctx); }
      catch (e) { row = { title: item.title, status: "error", note: e.message }; }
      if (item.arrangementId) done[item.arrangementId] = row;
    }
    entry.row = row;
  }
  if (keepsPlace && (stoppedAt !== null || resumeAt)) env.state.set("cursor", stoppedAt);
  var report = entries.map(function (entry) {
    var row = entry.row || { title: entry.item.title, status: "not-reached", note: "This run ran out of time before it got to this song. The next run starts with it." };
    // The title is this plan's own: one arrangement can sit in two plans under two item titles.
    return { plan: entry.plan, planId: entry.planId, title: entry.item ? entry.item.title || row.title : row.title, status: row.status, note: row.note };
  });
  var first = job_serviceDayPlan(plans, env.sched);
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
