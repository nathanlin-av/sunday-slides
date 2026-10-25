/**
 * Lyrics to slides drafter: turns plain lyrics (section label on its own line, one sung line per line)
 * into ProPresenter slide text. One sung line per slide, split into two short lines at the breath.
 * Rule based, no network. Pure JavaScript for Apps Script and Node; needs Layout.js (and the width tables it uses).
 * Public: draftSlides(lyricsText, layout), slideLineWidth(text), slideLineFits(text).
 * The layout (Layout.js) describes the template's text box and font; without one the built-in default look is used.
 * Lines come out in capitals when the layout says the template shows capitals, otherwise in the lyric's own case.
 */

var DRAFTER_LAYOUT = null;   // the layout in force during a draftSlides call

// Tuning. Costs: lower is a better place to break. Bonuses are subtracted, penalties added.
var DRAFTER_CONFIG = {
  oneLineMaxChars: 22,   // at or under this many characters a sung line stays on one slide line
  comma: 40,             // break after a comma, semicolon or dash
  conj: 14,              // break before and, but, 'cause, till, when, who ...
  relative: 8,           // break before that, who, when, where, as, like ...
  prep: 12,              // break before to, of, in, at, within ...
  aux: 20,               // break before is, are, can, may ...
  strongSubj: 14,        // break before I, we, he, she, they (a new clause)
  subj: 6,               // break before a subject pronoun that starts a new clause
  subjectPhrase: 10,     // break after a short opening subject (as the deer, so my soul) before its verb
  than: 12,              // break before comparison words (more, than)
  dangle: 30,            // ends a line on an article, preposition or conjunction
  balance: 18,           // penalty per unit the first half's share of the characters is off its target
  shareShort: 0.42,      // target share for the first half of a short line (singers breathe early)
  shareLong: 0.5,        // target share for the first half of a long line
  longChars: 32,         // characters: from here on a line counts as long
  heavyMult: 1.6,        // being over the target share costs this much more than being under it
  loneShort: 1000,       // a short word alone on a line
  loneLong: 12,          // a longer single word alone on a line
  loneShortMax: 5,       // letters: at or under this a lone word counts as short
  repeat: 100,           // both halves are the same words
  parallel: 14,          // second half opens with the first word of the first half
  parallelMinWords: 4,
  mirrorMinWords: 4,     // lines with a repeated or mirrored phrase split even when short
  mirrorMaxHalf: 3       // words: the largest half for a mirrored (same opening word) phrase
};

var DRAFTER_LABEL_KEYS = drafter_set("verse chorus bridge tag intro outro interlude instrumental ending vamp " +
  "refrain turnaround prechorus coda breakdown hook solo pre");
var DRAFTER_LABEL_MODS = drafter_set("down up final last alt alternate extended repeat " +
  "half big soft post x2 x3 x4");
var DRAFTER_CONJ = drafter_set("and but or so 'cause cause till until because though although if since unless then yet nor");
var DRAFTER_RELATIVE = drafter_set("when whenever where wherever that who whom whose which as like while whether");
var DRAFTER_PREP = drafter_set("to in on at from of within toward towards before after over under through into by " +
  "upon beyond around about without among between across against for with");
var DRAFTER_AUX = drafter_set("is are am was were can may will shall would could might must do does did have has " +
  "had be been won't can't don't");
var DRAFTER_SUBJ = drafter_set("i you we he she they it i'm you're we're he's she's they're it's i'll you'll i've " +
  "you've we've i'd you'd your my our his her their its");
var DRAFTER_BARE_SUBJ = drafter_set("i we he she they");
var DRAFTER_STRONG_SUBJ = drafter_set("i we he she they i'm we're he's she's they're it's i'll we'll i've we've i'd " +
  "he'll she'll they'll they've");
var DRAFTER_END_PREP = drafter_set("to of in on at for with from by into within before after upon without between " +
  "among against too very");
var DRAFTER_INTENSIFIERS = drafter_set("much far so even way");
var DRAFTER_PARTITIVE = drafter_set("kind sort type lot bit");
var DRAFTER_DETERMINERS = drafter_set("the a an my your our his her their its thy this these those some every each");
var DRAFTER_OPENERS = drafter_set("as so the a an my your our his her their its thy");
var DRAFTER_DANGLERS = drafter_set("the a an my your our his her their its thy this these those some every each " +
  "and but or so 'cause cause as than that if when where who not no i'm");

function drafter_set(words) {
  var out = {};
  var list = words.split(/\s+/);
  for (var i = 0; i < list.length; i++) { out[list[i]] = true; }
  return out;
}

function drafter_has(set, key) { return Object.prototype.hasOwnProperty.call(set, key); }

// width model (see Layout.js)

function drafter_layout() { return DRAFTER_LAYOUT || layout_default(); }

function slideLineWidth(text) { return layout_width(drafter_layout(), text); }

function slideLineFits(text) { return layout_fits(drafter_layout(), text); }

/** A slide line as the draft shows it: capitals when the template shows capitals. */
function drafter_display(text) { return drafter_layout().caps ? text.toUpperCase() : text; }

// text helpers

function drafter_stripEnd(text) {
  return text.replace(/[\s,.;:!?…]+$/, "").replace(/^\s+/, "");
}

function drafter_core(word) {
  return word.toLowerCase().replace(/’/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

function drafter_normKey(text) {
  return text.toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9']+/g, " ").replace(/^ | $/g, "");
}

function drafter_labelText(line) {
  return line.trim().replace(/^[\[(]+\s*/, "").replace(/\s*[\])]+$/, "").replace(/\s*:$/, "").trim();
}

function drafter_isLabel(line) {
  var text = drafter_labelText(line);
  if (!text || text.length > 40) { return false; }
  var tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  var seen = false;
  var count = 0;
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (!t) { continue; }
    count++;
    if (drafter_has(DRAFTER_LABEL_KEYS, t)) { seen = true; continue; }
    if (drafter_has(DRAFTER_LABEL_MODS, t) || /^\d{1,2}$/.test(t) || /^[a-c]$/.test(t)) { continue; }
    return false;
  }
  return seen && count <= 5;
}

// parsing

function drafter_parse(lyricsText) {
  var rows = String(lyricsText == null ? "" : lyricsText).replace(/^﻿/, "").split(/\r\n|\r|\n/);
  var sections = [];
  var current = null;
  var labelled = false;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i].replace(/[ \t]+/g, " ").trim();
    if (!row) { continue; }
    if (drafter_isLabel(row)) {
      labelled = true;
      current = { label: drafter_labelText(row), lines: [], preface: false };
      sections.push(current);
    } else {
      if (!current) { current = { label: "", lines: [], preface: true }; sections.push(current); }
      current.lines.push(row);
    }
  }
  return { sections: sections, labelled: labelled };
}

// splitting

function drafter_words(line) { return line.split(/\s+/).filter(function (w) { return w.length > 0; }); }

function drafter_join(words, from, to) { return words.slice(from, to).join(" "); }

function drafter_isFunctionWord(core) {
  return drafter_has(DRAFTER_CONJ, core) || drafter_has(DRAFTER_RELATIVE, core) || drafter_has(DRAFTER_PREP, core) || drafter_has(DRAFTER_DANGLERS, core) ||
    drafter_has(DRAFTER_AUX, core) || drafter_has(DRAFTER_SUBJ, core);
}

/** "more than" / "less than" that opens a comparison: a break before "than" would strand "more". */
function drafter_isMoreThan(words, k) {
  var prev = drafter_core(words[k - 1]);
  if (prev !== "more" && prev !== "less") { return false; }
  return k < 2 || !drafter_has(DRAFTER_INTENSIFIERS, drafter_core(words[k - 2]));
}

function drafter_laterHas(words, k, word) {
  for (var i = k + 1; i < words.length; i++) {
    if (drafter_core(words[i]) === word) { return true; }
  }
  return false;
}

/** Cost of breaking between words[k-1] and words[k]. */
function drafter_breakCost(words, k) {
  var c = DRAFTER_CONFIG;
  var prevRaw = words[k - 1];
  var prev = drafter_core(prevRaw);
  var next = drafter_core(words[k]);
  var cost = 0;
  if (/[,;:\u2014\u2013.!?]$/.test(prevRaw)) { cost -= c.comma; }
  var compare = next === "than" && !drafter_isMoreThan(words, k) ||
    ((next === "more" || next === "less") && drafter_laterHas(words, k, "than") && !drafter_has(DRAFTER_INTENSIFIERS, prev));
  if (compare) { cost -= c.than; }
  else if (drafter_has(DRAFTER_CONJ, next)) { cost -= c.conj; }
  else if (drafter_has(DRAFTER_RELATIVE, next)) { cost -= c.relative; }
  else if (drafter_has(DRAFTER_PREP, next)) { cost -= c.prep; }
  else if (drafter_has(DRAFTER_AUX, next) && !(prev === "you" || prev === "it")) { cost -= c.aux; }
  else if (drafter_has(DRAFTER_STRONG_SUBJ, next)) { cost -= c.strongSubj; }
  else if (drafter_has(DRAFTER_SUBJ, next)) { cost -= c.subj; }
  else if (k >= 2 && k <= 3 && drafter_has(DRAFTER_OPENERS, drafter_core(words[0])) &&
      !drafter_isFunctionWord(prev) && !drafter_isFunctionWord(next)) { cost -= c.subjectPhrase; }
  if (drafter_has(DRAFTER_DANGLERS, prev) || drafter_has(DRAFTER_END_PREP, prev) ||
      drafter_has(DRAFTER_STRONG_SUBJ, prev) ||
      ((prev === "you" || prev === "it") && drafter_has(DRAFTER_AUX, next)) ||
      (next === "of" && drafter_has(DRAFTER_PARTITIVE, prev)) ||
      (next === "than" && drafter_isMoreThan(words, k))) { cost += c.dangle; }
  return cost;
}

function drafter_lonePenalty(words, from, to, hard) {
  if (to - from !== 1) { return 0; }
  var core = drafter_core(words[from]);
  var c = DRAFTER_CONFIG;
  if (core.length <= c.loneShortMax || drafter_isFunctionWord(core)) { return hard ? c.loneShort : c.loneShort / 10; }
  return c.loneLong;
}

function drafter_pieceFits(words, from, to) {
  return slideLineFits(drafter_stripEnd(drafter_join(words, from, to)));
}

/** The words from k on repeat the words just before them (all of the line, or its closing phrase). */
function drafter_isRepeat(words, k) {
  var m = words.length - k;
  if (m < 1 || m > k) { return false; }
  for (var i = 0; i < m; i++) {
    if (drafter_core(words[k - m + i]) !== drafter_core(words[k + i])) { return false; }
  }
  return true;
}

function drafter_isParallel(words, k) {
  return words.length >= DRAFTER_CONFIG.parallelMinWords && k >= 1 && k < words.length &&
    drafter_core(words[k]) === drafter_core(words[0]);
}

function drafter_twoCost(words, k, hard) {
  var c = DRAFTER_CONFIG;
  var left = drafter_join(words, 0, k).length;
  var total = left + 1 + drafter_join(words, k, words.length).length;
  var diff = left / total - (total >= c.longChars ? c.shareLong : c.shareShort);
  var cost = drafter_breakCost(words, k);
  cost += c.balance * (diff > 0 ? diff * c.heavyMult : -diff);
  cost += drafter_lonePenalty(words, 0, k, hard) + drafter_lonePenalty(words, k, words.length, hard);
  if (drafter_isRepeat(words, k)) { cost -= c.repeat; }
  else if (drafter_isParallel(words, k)) { cost -= c.parallel; }
  return cost;
}

/** Best two-way split where both halves fit, or null. */
function drafter_bestTwo(words, hard) {
  var best = null;
  for (var k = 1; k < words.length; k++) {
    if (!drafter_pieceFits(words, 0, k) || !drafter_pieceFits(words, k, words.length)) { continue; }
    var cost = drafter_twoCost(words, k, hard);
    if (best === null || cost < best.cost) { best = { k: k, cost: cost }; }
  }
  return best;
}

/** True when the line is two copies of a phrase, or two phrases opening with the same word. */
function drafter_isMirrored(words) {
  if (words.length < DRAFTER_CONFIG.mirrorMinWords) { return false; }
  for (var k = 1; k < words.length; k++) {
    if (drafter_isRepeat(words, k)) { return true; }
    if (k <= DRAFTER_CONFIG.mirrorMaxHalf && words.length - k <= DRAFTER_CONFIG.mirrorMaxHalf &&
        drafter_core(words[k]) === drafter_core(words[0])) { return true; }
  }
  return false;
}

function drafter_pieceText(words, from, to) { return drafter_display(drafter_stripEnd(drafter_join(words, from, to))); }

function drafter_twoLines(words) {
  if (words.length < 2) { return null; }
  return drafter_bestTwo(words, true) || drafter_bestTwo(words, false);
}

/** Cut a too-long line at the best breath into two sung parts, preferring cuts that leave each part renderable. */
function drafter_longCut(words) {
  var c = DRAFTER_CONFIG;
  var best = null;
  for (var pass = 0; pass < 2 && best === null; pass++) {
    for (var k = 1; k < words.length; k++) {
      var left = words.slice(0, k);
      var right = words.slice(k);
      if (pass === 0 && !(drafter_canTwo(left) && drafter_canTwo(right))) { continue; }
      var leftLen = drafter_join(words, 0, k).length;
      var total = leftLen + 1 + drafter_join(words, k, words.length).length;
      var cost = drafter_breakCost(words, k) + c.balance * Math.abs(leftLen / total - 0.5) +
        drafter_lonePenalty(words, 0, k, true) + drafter_lonePenalty(words, k, words.length, true);
      if (best === null || cost < best.cost) { best = { k: k, cost: cost }; }
    }
  }
  return best.k;
}

function drafter_canTwo(words) {
  return drafter_pieceFits(words, 0, words.length) || drafter_twoLines(words) !== null;
}

/** Slides for one sung phrase: one line if short, two lines at the breath, else cut and recurse. */
function drafter_render(words) {
  var line = drafter_stripEnd(drafter_join(words, 0, words.length));
  if (slideLineFits(line) && (words.length === 1 ||
      (line.length <= DRAFTER_CONFIG.oneLineMaxChars && !drafter_isMirrored(words)))) {
    return [[drafter_display(line)]];
  }
  var two = drafter_twoLines(words);
  if (two) { return [[drafter_pieceText(words, 0, two.k), drafter_pieceText(words, two.k, words.length)]]; }
  if (words.length === 1) { return [[drafter_display(line)]]; }
  var k = drafter_longCut(words);
  return drafter_render(words.slice(0, k)).concat(drafter_render(words.slice(k)));
}

function drafter_slidesForLine(rawLine, group, flags) {
  var line = drafter_stripEnd(rawLine.replace(/\s+/g, " "));
  if (!line) { return []; }
  var slides = drafter_render(drafter_words(line));
  if (slides.length > 1) {
    flags.push("[" + group + "] \"" + line + "\" does not fit in two lines; split across " + slides.length + " slides.");
  }
  for (var i = 0; i < slides.length; i++) {
    for (var j = 0; j < slides[i].length; j++) {
      if (!slideLineFits(slides[i][j])) {
        flags.push("[" + group + "] \"" + slides[i][j] + "\" is wider than the slide box even on its own line.");
      }
    }
  }
  return slides;
}

// sections

function drafter_freeName(base, used) {
  var stem = base.replace(/\s*\d+$/, "").trim() || base;
  for (var n = 2; n < 100; n++) {
    var name = stem + " " + n;
    if (!used[name.toLowerCase()]) { return name; }
  }
  return base + " (copy)";
}

function draftSlides(lyricsText, layout) {
  DRAFTER_LAYOUT = layout || null;
  try { return drafter_draft(lyricsText); }
  finally { DRAFTER_LAYOUT = null; }
}

function drafter_draft(lyricsText) {
  var parsed = drafter_parse(lyricsText);
  var flags = [];
  var groups = [];
  var sections = parsed.sections;
  if (sections.length === 0) {
    flags.push("No lyrics found.");
    return { groups: groups, flags: flags };
  }
  var used = {};
  for (var i = 0; i < sections.length; i++) {
    if (!sections[i].preface) { used[sections[i].label.toLowerCase()] = true; }
  }
  if (!parsed.labelled) {
    sections[0].label = "Verse 1";
    flags.push("No section labels in the lyrics; everything is in one group called Verse 1.");
  } else if (sections[0].preface) {
    sections[0].label = used["verse 1"] ? "Verse 0" : "Verse 1";
    used[sections[0].label.toLowerCase()] = true;
    flags.push("Lyrics before the first section label; put in " + sections[0].label + ".");
  }
  var seen = {};
  for (var s = 0; s < sections.length; s++) {
    var sec = sections[s];
    var label = sec.label;
    if (sec.lines.length === 0) {
      flags.push("Section \"" + label + "\" has no lines; dropped.");
      continue;
    }
    var key = sec.lines.map(drafter_normKey).join("\n");
    var lower = label.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(seen, lower)) {
      if (seen[lower] === key) { continue; }
      var renamed = drafter_freeName(label, used);
      used[renamed.toLowerCase()] = true;
      flags.push("\"" + label + "\" appears again with different words; renamed \"" + renamed + "\".");
      label = renamed;
      lower = label.toLowerCase();
    }
    seen[lower] = key;
    var slides = [];
    for (var l = 0; l < sec.lines.length; l++) {
      var made = drafter_slidesForLine(sec.lines[l], label, flags);
      for (var m = 0; m < made.length; m++) { slides.push(made[m]); }
    }
    groups.push({ label: label, slides: slides });
  }
  return { groups: groups, flags: flags };
}
