/**
 * Your own look. An admin exports one ProPresenter slide in their theme as a file called template.pro and puts it in
 * the "Sunday Slides" folder in Google Drive. tpl_fromPro reads that file and makes the "assets" object ProWriter.js
 * clones for every song, so the songs keep the template's font, size, colors, position and background. The built-in
 * default look (Assets.js, PP_ASSETS) is used when there is no template or it cannot be used.
 *
 * What is read from the file:
 *   - the first slide that has a text box (a slide with two text boxes is refused: the second one's words would repeat in every song)
 *   - from that slide, everything is copied as it is (shapes, colors, background); only the text, its length and the IDs change
 *   - the presentation's application info and background color
 * What is not used: the other slides, groups, arrangements, timeline, media library items.
 * Nothing from the template song's own words is ever written: the writer drops them and the trial build below proves it.
 */

var TPL_FILE_NAME = "template.pro";
var TPL_MAX_BYTES = 3 * 1024 * 1024;
var TPL_UUID_RE = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

// Field numbers from the ProPresenter schema that the default template does not already name in PP_ASSETS.f.
var TPL_N = {
  cueActions: 10, actionSlide: 23, slidePresentation: 2, presentationBaseSlide: 1, baseSlideElements: 1, elementWrapper: 1,
  elementBounds: 3, elementText: 13, boundsSize: 2, sizeWidth: 1, sizeHeight: 2,
  textAttributes: 3, textRtf: 5, attrFont: 1, attrCapitalization: 2, attrKerning: 7, attrCustom: 13,
  fontName: 1, fontSize: 2, fontFamily: 9, capsAll: 1, chordPlatform: 3,
};

/** Throws an error whose message is meant for the admin (marked so callers can tell it from a bug). */
function tpl_fail(text) { var e = new Error(text); e.tpl = true; throw e; }

function tpl_hash(bytes) {
  var h = 0x811c9dc5;
  for (var i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return ("0000000" + h.toString(16)).slice(-8);
}

/** The built-in default look as a template object. */
function tpl_default() {
  return { source: "default", assets: PP_ASSETS, layout: layout_default(), note: "the built-in look", warnings: [] };
}

function tpl_uuids(bytes) {
  var found = pb_latin1Decode(bytes).match(TPL_UUID_RE) || [], out = [];
  for (var i = 0; i < found.length; i++) if (out.indexOf(found[i]) < 0) out.push(found[i]);
  return out;
}

/** Where the text starts inside the RTF: after the header, past control words and line breaks that belong to it. */
function tpl_rtfTextStart(rtf) {
  var p = rtf.indexOf("\\pard");
  if (p < 0) tpl_fail("The text box's formatting is not in the form ProPresenter normally writes (no paragraph settings).");
  var i = p, n = rtf.length;
  while (i < n) {
    var c = rtf.charAt(i);
    if (c === "\\") {
      var d = rtf.charAt(i + 1);
      if (/[A-Za-z]/.test(d)) {
        var j = i + 1;
        while (/[A-Za-z]/.test(rtf.charAt(j))) j++;
        var word = rtf.substring(i + 1, j);
        if (word === "u" && /[-0-9]/.test(rtf.charAt(j))) break;                       // \u followed by a number: the text starts here
        if (word === "uc" && /\d/.test(rtf.charAt(j)) && rtf.substr(j + 1, 2) === "\\u") break;   // \uc0 followed by \u
        if (rtf.charAt(j) === "-") j++;
        while (/\d/.test(rtf.charAt(j))) j++;
        if (rtf.charAt(j) === " ") j++;
        i = j;
        continue;
      }
      if (d === "*") { i += 2; continue; }
      break;
    }
    if (c === "\n" || c === "\r") { i++; continue; }
    if (c === "{") {
      var depth = 0;
      while (i < n) { var q = rtf.charAt(i++); if (q === "{") depth++; else if (q === "}" && --depth === 0) break; }
      continue;
    }
    break;
  }
  return i;
}

/** The words in an RTF text run, plain. Good enough to decide whether they are typed in capitals. */
function tpl_plainText(runText) {
  return pw_rtfUnescape(runText).replace(/\\'[0-9a-fA-F]{2}/g, "x").replace(/\\[A-Za-z]+-?\d* ?/g, "");
}

function tpl_double(fields, n) { var f = pb_first(fields, n); return f && f.body.length === 8 ? pb_readDouble(f.body) : null; }

/** Locate the first slide with a text box. Returns { cue, textPath, count } or fails with a readable reason. */
function tpl_findSlide(top, P) {
  var cues = top.filter(function (f) { return f.n === P.cues && f.wt === 2; });
  if (!cues.length) tpl_fail("The file has no slides in it.");
  var N = TPL_N;
  for (var ci = 0; ci < cues.length; ci++) {
    var actions = pb_fields(cues[ci].body).filter(function (f) { return f.n === N.cueActions; });
    for (var actionIdx = 0; actionIdx < actions.length; actionIdx++) {
      var slide = pb_first(pb_fields(actions[actionIdx].body), N.actionSlide);
      var pres = slide && pb_first(pb_fields(slide.body), N.slidePresentation);
      var base = pres && pb_first(pb_fields(pres.body), N.presentationBaseSlide);
      if (!base) continue;
      var wrappers = pb_fields(base.body).filter(function (f) { return f.n === N.baseSlideElements; });
      var textAt = [];
      for (var ei = 0; ei < wrappers.length; ei++) {
        var el = pb_first(pb_fields(wrappers[ei].body), N.elementWrapper);
        if (el && pb_first(pb_fields(el.body), N.elementText)) textAt.push(ei);
      }
      if (textAt.length > 1) tpl_fail("The first slide with text has " + textAt.length + " text boxes. Use a slide with exactly one text box, or its words would repeat in every song.");
      if (textAt.length === 1) {
        return { cue: cues[ci].body, slideNumber: ci + 1,
          textPath: [[N.cueActions, actionIdx], N.actionSlide, N.slidePresentation, N.presentationBaseSlide, [N.baseSlideElements, textAt[0]], N.elementWrapper, N.elementText],
          elementPath: [[N.cueActions, actionIdx], N.actionSlide, N.slidePresentation, N.presentationBaseSlide, [N.baseSlideElements, textAt[0]], N.elementWrapper] };
      }
    }
  }
  tpl_fail("None of the slides in the file has a text box. Type some words on the slide before exporting it.");
}

/** Keep only the first run of formatting so the whole song text is formatted like the template's first words. */
function tpl_singleRun(cue, textPath) {
  var N = TPL_N;
  return pb_editPath(cue, textPath, function (textMsg) {
    var fields = pb_fields(textMsg), attrs = pb_first(fields, N.textAttributes);
    if (!attrs) tpl_fail("The text box has no font settings.");
    var seen = 0, kept = pb_fields(attrs.body).filter(function (a) { return a.n !== N.attrCustom || seen++ === 0; });
    return pb_encode(pb_withBody(fields, N.textAttributes, 0, pb_encode(kept)));
  });
}

function tpl_head(top, P) {
  var def = pb_fields(pb_b64decode(PP_ASSETS.presentationHead)), out = [];
  [P.application_info, P.background, P.chord_chart, P.timeline].forEach(function (n) {
    var mine = pb_first(top, n), f = mine || pb_first(def, n);
    if (n === P.chord_chart && mine) {
      var plat = pb_first(pb_fields(mine.body), TPL_N.chordPlatform);
      f = plat ? pb_bytesField(n, pb_encode([plat])) : pb_first(def, n);
    }
    if (n === P.timeline) f = pb_first(def, n);   // the template's own timeline could point at its other slides
    if (f) out.push(f);
  });
  return pb_encode(out);
}

/** font, size, tracking, box width and capitals, read from the text box (RTF as a fallback for font, size, tracking). */
function tpl_readLayout(cue, textPath, elementPath, rtf, placeholderCaps) {
  var N = TPL_N, text = pb_fields(pb_atPath(cue, textPath)), el = pb_fields(pb_atPath(cue, elementPath));
  var attrs = pb_first(text, N.textAttributes), af = attrs ? pb_fields(attrs.body) : [];
  var fontMsg = pb_first(af, N.attrFont), font = fontMsg ? pb_fields(fontMsg.body) : [];
  var name = pb_first(font, N.fontName), fontName = name ? pb_utf8Decode(name.body) : "";
  if (!fontName) { var ft = /\\fonttbl[^;]*?\\fcharset\d+ ([^;}]+);/.exec(rtf); fontName = ft ? ft[1].trim() : ""; }
  if (!fontName) tpl_fail("Could not find the font of the text box.");
  var pt = tpl_double(font, N.fontSize);
  if (!(pt > 0)) { var fs = /\\fs(\d+)/.exec(rtf); pt = fs ? parseInt(fs[1], 10) / 2 : 0; }
  if (!(pt > 0)) tpl_fail("Could not find the font size of the text box.");
  var track = tpl_double(af, N.attrKerning);
  if (track === null) { var tw = /\\expndtw(-?\d+)/.exec(rtf); track = tw ? parseInt(tw[1], 10) / 20 : 0; }
  var bounds = pb_first(el, N.elementBounds), size = bounds && pb_first(pb_fields(bounds.body), N.boundsSize), sf = size ? pb_fields(size.body) : [];
  var width = tpl_double(sf, N.sizeWidth), height = tpl_double(sf, N.sizeHeight);
  if (!(width > 0)) tpl_fail("The text box has no width.");
  var capsAttr = false;
  var cap = pb_first(af, N.attrCapitalization);
  if (cap && pb_readVarint(cap.body, 0).value === N.capsAll) capsAttr = true;
  af.forEach(function (a) {
    if (a.n !== N.attrCustom) return;
    var c = pb_first(pb_fields(a.body), N.attrCapitalization);
    if (c && pb_readVarint(c.body, 0).value === N.capsAll) capsAttr = true;
  });
  var capsFont = /caps$/i.test(fontName);
  var warnings = [];
  if (height !== null && height < pt * 2.4) warnings.push("The text box is only " + Math.round(height) + " units tall, which looks too short for two lines at " + pt + " pt. Long lines may be cut off.");
  return {
    spec: { fontName: fontName, fontPt: pt, trackingPt: track, boxWidth: width, caps: capsAttr || capsFont || placeholderCaps },
    upperText: placeholderCaps && !capsAttr && !capsFont,
    warnings: warnings,
  };
}

/** Build a small song with the template and check it comes out sound and free of the template's own words. */
function tpl_trial(assets, placeholderLines) {
  var n = 0, ids = function () { n++; return "00000000-0000-4000-8000-" + ("000000000000" + n.toString(16).toUpperCase()).slice(-12); };
  var lyrics = "Verse 1\nTrial words one two\nTrial words three\n";
  var built = pw_build([{ label: "Verse 1", slides: [["TRIAL WORDS ONE TWO", "TRIAL WORDS THREE"], ["TRIAL WORDS THREE"]] }], lyrics,
    { title: "Trial", author: "", year: 0, ccli: 0 }, ["V1"], ids, assets);
  if (built.slides !== 2) tpl_fail("A trial song did not come out with the expected slides.");
  placeholderLines.forEach(function (line) {
    if (line.replace(/[^A-Za-zÀ-ɏ]/g, "").length < 3) return;
    if (pb_findAll(built.bytes, line).length || pb_findAll(built.bytes, pw_rtfEscape(line)).length) {
      tpl_fail("The template's own words (\"" + line + "\") are stored in more than one place in the slide, so they would show up in every song. Keep the words only in the text box.");
    }
  });
  return built;
}

function tpl_copy(obj) {
  if (Array.isArray(obj)) return obj.map(tpl_copy);
  if (obj && typeof obj === "object") { var o = {}; for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) o[k] = tpl_copy(obj[k]); return o; }
  return obj;
}

/**
 * Read a ProPresenter file and make a template from it. Returns { source: "custom", assets, layout, note, warnings, hash }
 * or throws an Error whose message is a reason the admin can act on.
 */
function tpl_fromPro(input) {
  try { return tpl_read(input); }
  catch (e) {
    if (e.tpl) throw e;
    tpl_fail("The file could not be read, it may be damaged or not a ProPresenter file (" + e.message + ").");
  }
}

function tpl_read(input) {
  var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length) tpl_fail("The file is empty.");
  if (bytes.length > TPL_MAX_BYTES) tpl_fail("The file is " + Math.round(bytes.length / 1024 / 1024 * 10) / 10 + " MB. Use a plain slide without pictures or video; the limit is 3 MB.");
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) tpl_fail("This is a zip file (maybe a .probundle). Export the slide as a plain ProPresenter file (.pro) instead.");
  var P = PP_ASSETS.f.presentation, top, found, cue, rtfField;
  try { top = pb_fields(bytes); }
  catch (e) { tpl_fail("This does not look like a ProPresenter file (" + e.message + ")."); }
  found = tpl_findSlide(top, P);
  cue = tpl_singleRun(found.cue, found.textPath);
  rtfField = pb_first(pb_fields(pb_atPath(cue, found.textPath)), TPL_N.textRtf);
  if (!rtfField) tpl_fail("The text box has no formatted text. Type some words in it in ProPresenter and export again.");
  var rtf = pb_latin1Decode(rtfField.body);
  if (rtf.indexOf("{\\rtf") !== 0) tpl_fail("The text box's text is not in the form ProPresenter normally writes.");
  var start = tpl_rtfTextStart(rtf), marker = rtf.substring(0, start);
  if (rtf.split(marker).length !== 2) tpl_fail("The text box's formatting repeats inside its text, which is not supported.");
  var runText = rtf.substring(start, Math.max(start, rtf.lastIndexOf("}")));
  var lines = tpl_plainText(runText).split("\n");
  var letters = lines.join("").replace(/[^A-Za-zÀ-ɏ]/g, "");
  var placeholderCaps = letters.length >= 2 && letters === letters.toUpperCase();
  var lay = tpl_readLayout(cue, found.textPath, found.elementPath, rtf, placeholderCaps);
  var assets = tpl_copy(PP_ASSETS);
  var cueIds = tpl_uuids(cue);
  assets.cue = pb_b64encode(cue);
  assets.cueUuids = cueIds;
  assets.templateUuids = cueIds;   // the writer copies nothing else from the template song, so these are the IDs that must not survive
  assets.marker = marker;
  assets.f.textPath = found.textPath;
  assets.presentationHead = pb_b64encode(tpl_head(top, P));
  assets.layout = lay.spec;
  assets.upperText = lay.upperText;
  try { tpl_trial(assets, lines); }
  catch (e) {
    if (e.tpl) throw e;
    tpl_fail("A trial song made from this template failed its own checks (" + e.message + "). The file may be damaged or built in an unusual way.");
  }
  var layout = layout_make(lay.spec);
  return { source: "custom", assets: assets, layout: layout, warnings: lay.warnings, hash: tpl_hash(bytes),
    note: "slide " + found.slideNumber + " of your template.pro: " + layout_describe(layout) };
}

/**
 * Decide which template a run uses and say so on the Log tab whenever the choice changes.
 *   found:  { bytes } (the file's bytes), { error } (the file exists but could not be read), or null (no file)
 *   store:  { get(), set(text) } remembers the last choice so the same line is not logged every run (may be null)
 *   log:    function (text)
 * Never throws: a template that cannot be used falls back to the built-in look and the reason is logged.
 */
function tpl_choose(found, store, log) {
  var tpl, state, line;
  if (!found) {
    tpl = tpl_default(); state = "default";
    line = "TEMPLATE: no " + TPL_FILE_NAME + " in the Sunday Slides folder, so slides use the built-in look (" + layout_describe(tpl.layout) + ").";
  } else if (found.error) {
    tpl = tpl_default(); tpl.source = "fallback"; tpl.problem = found.error; state = "bad:" + found.error;
    line = "TEMPLATE PROBLEM: " + TPL_FILE_NAME + " could not be used (" + found.error + "). Slides use the built-in look until this is fixed.";
  } else {
    try {
      tpl = tpl_fromPro(found.bytes); state = "custom:" + tpl.hash;
      line = "TEMPLATE: using " + tpl.note + (found.extra ? ". " + found.extra : "") + (tpl.warnings.length ? ". Note: " + tpl.warnings.join(" ") : "");
    } catch (e) {
      tpl = tpl_default(); tpl.source = "fallback"; tpl.problem = e.message; state = "bad:" + e.message;
      line = "TEMPLATE PROBLEM: " + TPL_FILE_NAME + " was not used: " + e.message + " Slides use the built-in look until this is fixed.";
    }
  }
  var before = store ? store.get() : null;
  if (before !== state) {
    try { log(line); } catch (ignored) { /* the Log tab is not reachable; the choice still stands */ }
    if (store) store.set(state);
  }
  tpl.line = line;
  return tpl;
}
