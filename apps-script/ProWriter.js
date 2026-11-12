/**
 * Writes a ProPresenter 21 song by cloning a template slide. The template is "assets": by default PP_ASSETS (Assets.js,
 * the built-in look), or the object tpl_fromPro (Template.js) makes from the admin's own template.pro. The output is
 * deterministic given the same inputs and the same ID sequence; tests/prowriter.test.js holds it to byte equality
 * with reference .pro files.
 */

var PW_APOS_CLASS = "['’]";

function pw_newIdDefault() {
  if (typeof Utilities !== "undefined") return Utilities.getUuid().toUpperCase();
  var hex = "0123456789ABCDEF", s = "";
  for (var i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
    else if (i === 14) s += "4";
    else if (i === 19) s += hex.charAt(8 + Math.floor(Math.random() * 4));
    else s += hex.charAt(Math.floor(Math.random() * 16));
  }
  return s;
}

function pw_rtfEscape(text) {
  var out = "";
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i), code = text.charCodeAt(i);
    if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
    else if (ch === "\n") out += "\\\n";
    else if (ch === "\t") out += " ";
    else if (code < 32 || (code >= 127 && code <= 159)) continue;   // control characters have no place on a slide
    else if (code > 127) out += "\\uc0\\u" + (code < 32768 ? code : code - 65536) + " ";
    else out += ch;
  }
  return out;
}

function pw_rtfUnescape(body) {
  var out = "", i = 0;
  while (i < body.length) {
    if (body.indexOf("\\uc0\\u", i) === i) {
      var j = body.indexOf(" ", i), n = parseInt(body.substring(i + 6, j), 10);
      out += String.fromCharCode(n < 0 ? n + 65536 : n);
      i = j + 1;
    } else if (body.charAt(i) === "\\" && body.charAt(i + 1) === "\n") { out += "\n"; i += 2; }
    else if (body.charAt(i) === "\\" && i + 1 < body.length && "\\{}".indexOf(body.charAt(i + 1)) >= 0) { out += body.charAt(i + 1); i += 2; }
    else { out += body.charAt(i); i++; }
  }
  return out;
}

function pw_escapeRegex(w) { return w.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&"); }

/** The lyric's own casing for a draft line, searching forward from `start` . */
function pw_restoreCase(caps, lyrics, start) {
  var words = caps.split(/\s+/).filter(function (w) { return w.length; }).map(function (w) {
    return pw_escapeRegex(w).replace(/['’]/g, PW_APOS_CLASS).replace(/SS/gi, "(?:ss|\u00df)");
  });
  var re = new RegExp(words.join("\\s+"), "gi");
  re.lastIndex = start;
  var m = re.exec(lyrics);
  if (!m) { re.lastIndex = 0; m = re.exec(lyrics); }
  if (m) return { text: m[0], end: m.index + m[0].length };
  var found = pw_findUpper(caps, lyrics, start) || pw_findUpper(caps, lyrics, 0);
  if (!found) throw new Error("draft line not found in the lyrics: " + JSON.stringify(caps));
  return found;
}

// The words of the lyrics with their places, split once per song (the last lyrics seen are kept).
var PW_WORDS = { lyrics: null, tokens: null };

function pw_lyricWords(lyrics) {
  if (PW_WORDS.lyrics !== lyrics) {
    var tokens = [], re = /\S+/g, t;
    while ((t = re.exec(lyrics))) tokens.push({ text: t[0], at: t.index });
    PW_WORDS = { lyrics: lyrics, tokens: tokens };
  }
  return PW_WORDS.tokens;
}

function pw_upperWord(w) { return w.replace(/\u2019/g, "'").toUpperCase(); }

/**
 * The same search for capitals that do not map back letter for letter (Turkish dotless i, ligatures like "ffi"):
 * a run of lyric words whose capitals are the draft's words. The last word may carry extra end punctuation.
 */
function pw_findUpper(caps, lyrics, start) {
  var want = caps.split(/\s+/).filter(function (w) { return w.length; }).map(pw_upperWord);
  var tokens = pw_lyricWords(lyrics), i = 0;
  while (i < tokens.length && tokens[i].at < start) i++;
  for (; want.length && i + want.length <= tokens.length; i++) {
    var ok = true, last = i + want.length - 1, endAt = 0;
    for (var k = 0; ok && k < want.length; k++) {
      var tok = tokens[i + k];
      if (i + k < last) { ok = pw_upperWord(tok.text) === want[k]; continue; }
      ok = false;
      for (var n = tok.text.length; n > 0 && !ok; n--) {   // the longest start of the word that is the draft's word
        if (pw_upperWord(tok.text.substring(0, n)) === want[k]) { ok = true; endAt = tok.at + n; }
      }
    }
    if (ok) return { text: lyrics.substring(tokens[i].at, endAt), end: endAt };
  }
  return null;
}

function pw_capFirst(line) { return line.charAt(0).toUpperCase() + line.substring(1); }

/** Planning Center style labels to ProPresenter group names ("Chorus 1" -> "Chorus", "Pre-Chorus" -> "PreChorus"). */
function pw_groupName(label) {
  label = label.trim().replace(/^Pre[- ]?Chorus/i, "PreChorus");
  return label.replace(/^(Chorus|Tag|Bridge|PreChorus|Intro|Ending|Outro|Interlude|Vamp|Refrain|Turnaround)\s+1$/i, "$1");
}

function pw_uuidMsg(id, A) { return pb_message([pb_stringField((A || PP_ASSETS).f.uuid.string, id)]); }

function pw_groupBytes(name, id, A) {
  A = A || PP_ASSETS;
  var tpl = A.groups[name];
  if (tpl) {
    var bytes = new Uint8Array(pb_b64decode(tpl)), hits = pb_findAll(bytes, A.placeholder);
    if (hits.length !== 1) throw new Error("group template " + name + " has " + hits.length + " placeholder IDs");
    bytes.set(pb_latin1(id), hits[0]);
    return bytes;
  }
  var g = A.f.group;
  return pb_message([pb_bytesField(g.uuid, pw_uuidMsg(id, A)), pb_stringField(g.name, name), pb_bytesField(g.hotKey, new Uint8Array(0))]);
}

function pw_cueBytes(text, newId, A) {
  A = A || PP_ASSETS;
  var f = A.f, cue = new Uint8Array(pb_b64decode(A.cue));
  for (var k = 0; k < A.cueUuids.length; k++) {
    // One fresh ID per template ID, written everywhere that ID appears so references inside the slide stay linked.
    var hits = pb_findAll(cue, A.cueUuids[k]), fresh = pb_latin1(newId());
    if (hits.length < 1) throw new Error("template cue ID " + k + " is not in the template slide");
    for (var h = 0; h < hits.length; h++) cue.set(fresh, hits[h]);
  }
  var units = text.length;
  cue = pb_editPath(cue, f.textPath, function (textMsg) {
    var fields = pb_fields(textMsg), rtfField = pb_first(fields, f.rtfData);
    if (!rtfField) throw new Error("template slide has no RTF");
    var parts = pb_latin1Decode(rtfField.body).split(A.marker);
    if (parts.length !== 2) throw new Error("template slide RTF does not have exactly one text marker");
    fields = pb_withBody(fields, f.rtfData, 0, pb_latin1(parts[0] + A.marker + pw_rtfEscape(text) + "}"));
    return pb_editPath(pb_encode(fields), [f.attrPath[0]], function (attrs) {
      return pb_encode(pb_fields(attrs).map(function (a) {
        if (a.n !== f.attrPath[1]) return a;
        return { n: a.n, wt: 2, tag: null, body: pw_setRange(a.body, units, A) };
      }));
    });
  });
  var cueId = pb_latin1Decode(pb_first(pb_fields(pb_first(pb_fields(cue), f.cueUuid).body), f.uuid.string).body);
  return { bytes: cue, id: cueId };
}

/** custom_attribute.range = {start: 0, end: units} (proto3: start 0 is not written). */
function pw_setRange(attr, units, A) {
  var f = (A || PP_ASSETS).f, fields = pb_fields(attr), range = pb_first(fields, f.rangePath[0]);
  var keep = range ? pb_fields(range.body).filter(function (x) { return x.n !== f.rangeStart && x.n !== f.rangeEnd; }) : [];
  var parts = keep.concat([pb_uintField(f.rangeEnd, units)]).filter(Boolean);
  parts.sort(function (a, b) { return a.n - b.n; });
  var body = pb_encode(parts);
  if (range) return pb_encode(pb_withBody(fields, f.rangePath[0], 0, body));
  var all = fields.concat([pb_bytesField(f.rangePath[0], body)]);
  all.sort(function (a, b) { return a.n - b.n; });
  return pb_encode(all);
}

/**
 * The group a sequence item names. Capitals and spaces do not count ("VERSE 1", "verse1" and "Verse 1" are one
 * group, "FinalChorus" is "Final Chorus"); short forms ("V1", "C", "PC2") and "Chorus 1" for "Chorus" are understood.
 */
function pw_sequenceName(item, byName, A) {
  var names = {}, flat = function (t) { return String(t).replace(/\s+/g, "").toLowerCase(); };
  // An exact name always wins; of two groups that differ only in capitals or spaces, the first one typed.
  Object.keys(byName).forEach(function (n) { if (!Object.prototype.hasOwnProperty.call(names, flat(n))) names[flat(n)] = n; });
  var find = function (t) {
    if (Object.prototype.hasOwnProperty.call(byName, t)) return t;
    var k = flat(t);
    return Object.prototype.hasOwnProperty.call(names, k) ? names[k] : null;
  };
  var hit = find(item);
  if (hit) return hit;
  var m = /^([A-Za-z-]+?)(\d*[a-c]?)$/.exec(item.trim());   // "Verse1", "Chorus", "Verse1a"
  if (!m) throw new Error("sequence item " + JSON.stringify(item) + " is not a section label");
  var word = (A || PP_ASSETS).short[m[1]] || (A || PP_ASSETS).short[m[1].toUpperCase()] || m[1];   // "V1" and "v1"
  var name = m[2] ? word + " " + m[2] : word;
  hit = find(name) || find(m[2] === "1" ? pw_groupName(name) : pw_groupName(name + " 1"));
  if (!hit) throw new Error("sequence item " + JSON.stringify(item) + " has no group (have " + Object.keys(byName).sort().join(", ") + ")");
  return hit;
}

/**
 * groups: [{ label, slides: [["LINE", "LINE"], ...] }] (draft lines, any case), lyrics: the song's lyric text,
 * meta: { title, author, year, ccli }, sequence: ["V1", "C", ...], newId: optional ID source, A: optional template assets.
 * Returns { bytes: Uint8Array, slides, groups }.
 */
function pw_build(groups, lyrics, meta, sequence, newId, A) {
  newId = newId || pw_newIdDefault;
  A = A || PP_ASSETS;
  var F = A.f, P = F.presentation;
  var top = pb_fields(pb_b64decode(A.presentationHead));
  top.push(pb_bytesField(P.uuid, pw_uuidMsg(newId(), A)));
  top.push(pb_stringField(P.name, meta.title));
  top.push(pb_bytesField(P.ccli, pb_message([
    pb_stringField(F.ccli.author, meta.author || ""), pb_stringField(F.ccli.song_title, meta.title),
    pb_uintField(F.ccli.copyright_year, meta.year || 0), pb_uintField(F.ccli.song_number, meta.ccli || 0),
    pb_varintField(F.ccli.display, 1)])));

  var byName = {}, cursor = 0, slideCount = 0, groupNames = [];
  for (var gi = 0; gi < groups.length; gi++) {
    var name = pw_groupName(groups[gi].label);
    if (name in byName) throw new Error("two groups would both be called " + JSON.stringify(name));
    if (!groups[gi].slides.length) throw new Error("group " + JSON.stringify(groups[gi].label) + " has no slides");
    var gid = newId(), cueIds = [];
    byName[name] = gid;
    groupNames.push(name);
    var groupBytes = pw_groupBytes(name, gid, A);
    for (var si = 0; si < groups[gi].slides.length; si++) {
      var parts = [];
      for (var li = 0; li < groups[gi].slides[si].length; li++) {
        var found = pw_restoreCase(groups[gi].slides[si][li], lyrics, cursor);
        cursor = found.end;
        parts.push(pw_capFirst(found.text));
      }
      var slideText = parts.join("\n");
      // A template whose own words are typed in capitals gets capitals; a caps setting or caps font does the job itself.
      var cue = pw_cueBytes(A.upperText ? slideText.toUpperCase() : slideText, newId, A);
      top.push(pb_bytesField(P.cues, cue.bytes));
      cueIds.push(cue.id);
      slideCount++;
    }
    top.push(pb_bytesField(P.cue_groups, pb_message([pb_bytesField(F.cueGroup.group, groupBytes)].concat(
      cueIds.map(function (id) { return pb_bytesField(F.cueGroup.cue_identifiers, pw_uuidMsg(id, A)); })))));
  }

  var arrId = newId();
  top.push(pb_bytesField(P.arrangements, pb_message([
    pb_bytesField(F.arrangement.uuid, pw_uuidMsg(arrId, A)), pb_stringField(F.arrangement.name, "Planning Center")].concat(
    sequence.map(function (item) { return pb_bytesField(F.arrangement.group_identifiers, pw_uuidMsg(byName[pw_sequenceName(item, byName, A)], A)); })))));
  top.push(pb_bytesField(P.selected_arrangement, pw_uuidMsg(arrId, A)));

  var order = top.filter(Boolean).map(function (f, i) { return { f: f, i: i }; });
  order.sort(function (a, b) { return a.f.n - b.f.n || a.i - b.i; });
  var bytes = pb_encode(order.map(function (x) { return x.f; }));
  var problems = pw_check(bytes, A);
  if (problems.length) throw new Error("Refusing to write: " + problems.join("; "));
  return { bytes: bytes, slides: slideCount, groups: groupNames };
}

/** Re-read a written song and check it independently of how it was built. */
function pw_check(bytes, A) {
  A = A || PP_ASSETS;
  var F = A.f, P = F.presentation, problems = [];
  function uuidOf(msg) { var u = pb_first(pb_fields(msg), F.uuid.string); return u ? pb_latin1Decode(u.body) : ""; }
  var top = pb_fields(bytes), cueIds = [], grouped = [], groupIds = {}, arranged = [];
  top.forEach(function (f) {
    if (f.n === P.cues) cueIds.push(uuidOf(pb_first(pb_fields(f.body), F.cueUuid).body));
    if (f.n === P.cue_groups) pb_fields(f.body).forEach(function (cg) {
      if (cg.n === F.cueGroup.group) groupIds[uuidOf(pb_first(pb_fields(cg.body), F.group.uuid).body)] = true;
      if (cg.n === F.cueGroup.cue_identifiers) grouped.push(uuidOf(cg.body));
    });
    if (f.n === P.arrangements) pb_fields(f.body).forEach(function (a) {
      if (a.n === F.arrangement.group_identifiers) arranged.push(uuidOf(a.body));
    });
  });
  if (cueIds.slice().sort().join() !== grouped.slice().sort().join()) problems.push("cues and group membership disagree");
  if (new Set(cueIds).size !== cueIds.length) problems.push("duplicate cue IDs");
  arranged.forEach(function (id) { if (!groupIds[id]) problems.push("arrangement points at missing group " + id); });
  A.templateUuids.forEach(function (id) { if (pb_findAll(bytes, id).length) problems.push("ID still shared with the template song: " + id); });
  top.forEach(function (f) {
    if (f.n !== P.cues) return;
    var text = pb_fields(pb_atPath(f.body, F.textPath));
    var rtf = pb_latin1Decode(pb_first(text, F.rtfData).body).split(A.marker);
    var units = pw_rtfUnescape(rtf[1].replace(/\}$/, "")).length;
    pb_fields(pb_first(text, F.attrPath[0]).body).forEach(function (a) {
      if (a.n !== F.attrPath[1]) return;
      var end = pb_first(pb_fields(pb_atPath(a.body, F.rangePath)), F.rangeEnd);
      if (!end || pb_readVarint(end.body, 0).value !== units) problems.push("text length mismatch on a slide");
    });
  });
  return problems;
}

/** Draft text format: [Label] on its own line, then one slide per line with its two lines split by a slash. */
function pw_parseDraft(text) {
  var groups = [];
  text.split(/\r?\n/).forEach(function (raw) {
    var line = raw.trim().replace(/\s{2,}\(\?\).*$/, "");
    if (!line || line.charAt(0) === "#") return;
    if (line.charAt(0) === "[") { groups.push({ label: line.replace(/^\[+|\]+$/g, ""), slides: [] }); return; }
    groups[groups.length - 1].slides.push(line.split("/").map(function (x) { return x.trim(); }));
  });
  return groups;
}
