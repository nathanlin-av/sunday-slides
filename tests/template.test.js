// The look of the slides: the built-in default template, the admin's own template.pro, the fallback when that file is
// missing or broken, and the line breaking that goes with each font.
// Template files here are synthetic (tools/make_test_templates.js) with placeholder words that must never reach a song.
// The "golden" custom songs were written by a separate reference writer, like the other golden files.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { loadGas, CORE } = require("./gas-loader");
const tool = require("../tools/build_default_template");

const FIX = path.join(__dirname, "fixtures");
const g = loadGas(CORE);
const read = (...p) => fs.readFileSync(path.join(FIX, ...p));
const text = (...p) => read(...p).toString("utf8");
const DEFAULT_PRO = fs.readFileSync(path.join(__dirname, "..", "templates", "default-template.pro"));
const GRACE = text("hymns", "amazing-grace.txt");

function detIds() {
  let n = 0;
  return () => "00000000-0000-4000-8000-" + (++n).toString(16).toUpperCase().padStart(12, "0");
}

function graceSong(assets, layout, ids) {
  const draft = g.draftSlides(GRACE, layout);
  return g.pw_build(draft.groups, GRACE, { title: "Amazing Grace", author: "John Newton", year: 1779, ccli: 22025 }, ["V1", "V2"], ids, assets);
}

// What a song says about its first slide, read straight from the bytes.
const TEXT_PATH = [10, 23, 2, 1, 1, 1, 13];
function firstSlide(bytes) {
  const top = g.pb_fields(new Uint8Array(bytes));
  const cue = top.find((f) => f.n === 13).body;
  const el = g.pb_atPath(cue, TEXT_PATH.slice(0, 6));
  const textMsg = g.pb_fields(g.pb_atPath(cue, TEXT_PATH));
  const attrs = g.pb_fields(g.pb_first(textMsg, 3).body), font = g.pb_fields(g.pb_first(attrs, 1).body);
  const color = g.pb_fields(g.pb_first(attrs, 3).body);
  const bounds = g.pb_fields(g.pb_first(g.pb_fields(el), 3).body);
  const origin = g.pb_fields(g.pb_first(bounds, 1).body), size = g.pb_fields(g.pb_first(bounds, 2).body);
  const num = (fields, n) => { const f = g.pb_first(fields, n); return f ? (f.body.length === 8 ? g.pb_readDouble(f.body) : g.pb_readFloat(f.body)) : 0; };
  const background = g.pb_fields(g.pb_first(top, 8).body);
  const bgColor = g.pb_fields(g.pb_first(background, 1).body);
  return {
    fontName: g.pb_utf8Decode(g.pb_first(font, 1).body), fontPt: num(font, 2), kerning: num(attrs, 7),
    red: num(color, 1), green: num(color, 2), blue: num(color, 3),
    x: num(origin, 1), y: num(origin, 2), width: num(size, 1), height: num(size, 2),
    rtf: g.pb_latin1Decode(g.pb_first(textMsg, 5).body), bgBlue: num(bgColor, 3), bgRed: num(bgColor, 1),
  };
}
const has = (bytes, s) => g.pb_findAll(new Uint8Array(bytes), s).length > 0;

// ---- the default template

test("Assets.js and templates/default-template.pro are exactly what tools/build_default_template.js writes", () => {
  assert.strictEqual(fs.readFileSync(path.join(__dirname, "..", "apps-script", "Assets.js"), "utf8"), tool.buildAssetsJs());
  assert.ok(DEFAULT_PRO.equals(tool.buildTemplatePro()));
});

test("default look: Arial Bold, white, centered, neutral placeholder from a public-domain hymn", () => {
  const s = graceSong(g.PP_ASSETS, g.layout_default(), detIds());
  const info = firstSlide(s.bytes);
  assert.strictEqual(info.fontName, "Arial-BoldMT");
  assert.strictEqual(info.fontPt, 60);
  assert.deepStrictEqual([info.red, info.green, info.blue], [1, 1, 1]);
  assert.match(info.rtf, /\\fonttbl\\f0\\fnil\\fcharset0 Arial-BoldMT;/);
  assert.match(info.rtf, /\\qc/);
  assert.ok(info.rtf.endsWith("\\expndtw0\nAmazing grace\\\nHow sweet the sound}"));
});

test("the layout stored in Assets.js is the layout read from the default template.pro", () => {
  const t = g.tpl_fromPro(DEFAULT_PRO);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.layout)), JSON.parse(JSON.stringify(g.layout_default())));
  assert.deepStrictEqual(Array.from(t.warnings), []);
});

test("the default template.pro, used as a custom template, gives the same song as the built-in path", () => {
  const t = g.tpl_fromPro(DEFAULT_PRO);
  const a = graceSong(g.PP_ASSETS, g.layout_default(), detIds()), b = graceSong(t.assets, t.layout, detIds());
  assert.ok(Buffer.from(a.bytes).equals(Buffer.from(b.bytes)));
});

test("the default template's own words appear only in a song that sings them", () => {
  const draft = g.draftSlides(text("hymns", "come-thou-fount.txt"));
  const s = g.pw_build(draft.groups, text("hymns", "come-thou-fount.txt"), { title: "Come Thou Fount" }, ["V1"]);
  assert.ok(!has(s.bytes, "Amazing grace") && !has(s.bytes, "how sweet the sound"));
  assert.ok(!has(s.bytes, "Amazing") && !has(s.bytes, "sweet"));
});

test("group definitions keep their hot keys and colors, with a fresh ID per song", () => {
  const draft = g.draftSlides("Verse 1\nOne line here\n\nChorus\nTwo lines there\n");
  const a = g.pw_build(draft.groups, "Verse 1\nOne line here\n\nChorus\nTwo lines there\n", { title: "X" }, ["V1", "C"]);
  const b = g.pw_build(draft.groups, "Verse 1\nOne line here\n\nChorus\nTwo lines there\n", { title: "X" }, ["V1", "C"]);
  const groupIds = (bytes) => g.pb_fields(new Uint8Array(bytes)).filter((f) => f.n === 12).map((f) => g.pb_latin1Decode(g.pb_first(g.pb_fields(g.pb_first(g.pb_fields(g.pb_first(g.pb_fields(f.body), 1).body), 1).body), 1).body));
  const ga = groupIds(a.bytes), gb = groupIds(b.bytes);
  assert.strictEqual(ga.length, 2);
  assert.ok(ga.every((id) => !gb.includes(id)), "group IDs must be new for every song");
  assert.ok(!has(a.bytes, "00000000-0000-0000-0000-000000000000"));
  const group = (name) => Buffer.from(g.pb_b64decode(g.PP_ASSETS.groups[name]));
  assert.strictEqual(Object.keys(g.PP_ASSETS.groups).length, 30);
  assert.ok(group("Chorus").includes(Buffer.from([0x22, 0x02, 0x08, 0x03])), "Chorus is hot key C");
  assert.ok(group("Verse 1").includes(Buffer.from([0x22, 0x02, 0x08, 0x01])), "Verse 1 is hot key A");
});

// ---- a custom template

const CUSTOM = ["georgia", "capitals-typed", "cmg-style"];
for (const name of CUSTOM) {
  test("custom template " + name + ": the song equals the reference writer's file byte for byte", () => {
    const c = JSON.parse(text("golden", "custom-cases.json"))["custom-" + name];
    const t = g.tpl_fromPro(read("templates", c.template));
    const draft = g.draftSlides(GRACE, g.layout_default());   // the reference file was built from the default drafter output
    const lyrics = text("golden", c.from + ".lyrics.txt");
    const groups = g.pw_parseDraft(text("golden", c.from + ".slides.txt"));
    const s = g.pw_build(groups, lyrics, { title: c.title, author: c.author, year: c.year, ccli: c.ccli }, c.seq.split(","), detIds(), t.assets);
    assert.ok(draft.groups.length > 0);
    const gold = read("golden", "custom-" + name + ".pro");
    assert.strictEqual(Buffer.from(s.bytes).length, gold.length);
    assert.ok(Buffer.from(s.bytes).equals(gold), "bytes differ from the reference writer's file");
  });
}

test("custom template keeps its font, size, colors, position, size and background; none of its words reach the song", () => {
  const t = g.tpl_fromPro(read("templates", "georgia.pro"));
  assert.strictEqual(t.source, "custom");
  const s = graceSong(t.assets, t.layout, detIds());
  const info = firstSlide(s.bytes);
  assert.strictEqual(info.fontName, "Georgia-Bold");
  assert.strictEqual(info.fontPt, 54);
  assert.strictEqual(info.kerning, 1.5);
  assert.ok(Math.abs(info.red - 1) < 1e-6 && Math.abs(info.green - 0.85) < 1e-6 && Math.abs(info.blue - 0.2) < 1e-6);
  assert.deepStrictEqual([info.x, info.y, info.width, info.height], [120, 300, 1680, 380]);
  assert.ok(Math.abs(info.bgBlue - 0.3) < 1e-6 && Math.abs(info.bgRed - 0.05) < 1e-6);
  assert.match(info.rtf, /fcharset0 Georgia-Bold;/);
  assert.match(info.rtf, /\\fs108 /);
  for (const w of ["Placeholder", "second line", "Georgia test"]) assert.ok(!has(s.bytes, w), w);
  assert.ok(has(s.bytes, "Amazing grace"));
  assert.ok(!has(s.bytes, "Arial"), "the default font must not leak into a custom song");
  assert.deepStrictEqual(Array.from(g.pw_check(s.bytes, t.assets)), []);
  // Template IDs never survive into a song.
  assert.ok(t.assets.templateUuids.length >= 4);
  for (const id of t.assets.templateUuids) assert.ok(!has(s.bytes, id), id);
});

test("custom template: the line breaker uses the template's font and box", () => {
  const t = g.tpl_fromPro(read("templates", "georgia.pro"));
  assert.strictEqual(t.layout.model, "average");
  assert.strictEqual(t.layout.boxWidth, 1680);
  assert.strictEqual(t.layout.fontPt, 54);
  assert.strictEqual(t.layout.caps, false);
  const d = g.draftSlides(GRACE, t.layout);
  for (const grp of d.groups) for (const slide of grp.slides) for (const line of slide) assert.ok(g.layout_fits(t.layout, line), line);
});

test("custom template in CMG Sans uses the CMG widths and capitals", () => {
  const t = g.tpl_fromPro(read("templates", "cmg-style.pro"));
  assert.strictEqual(t.layout.model, "cmg");
  assert.strictEqual(t.layout.caps, true);
  assert.strictEqual(t.layout.fontPt, 63);
  assert.strictEqual(t.layout.trackingPt, 3);
  assert.strictEqual(t.assets.upperText, false, "the All Caps setting does the capitals; the stored text keeps the lyric's case");
  const d = g.draftSlides("Verse 1\nHoly, holy, holy\nEarly in the morning our song shall rise to Thee\n", t.layout);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.groups[0].slides)), [["HOLY, HOLY, HOLY"], ["EARLY IN THE MORNING OUR SONG", "SHALL RISE TO THEE"]]);
  const s = g.pw_build(d.groups, "Verse 1\nHoly, holy, holy\nEarly in the morning our song shall rise to Thee\n", { title: "x" }, ["V1"], null, t.assets);
  assert.ok(has(s.bytes, "Early in the morning our song"), "stored text keeps its own case");
});

test("placeholder words typed in capitals give a song in capitals", () => {
  const t = g.tpl_fromPro(read("templates", "capitals-typed.pro"));
  assert.strictEqual(t.layout.caps, true);
  assert.strictEqual(t.assets.upperText, true);
  const s = graceSong(t.assets, t.layout, detIds());
  assert.ok(has(s.bytes, "AMAZING GRACE") && !has(s.bytes, "Amazing grace"));
  assert.ok(!has(s.bytes, "HELLO THERE") && !has(s.bytes, "MY FRIEND"));
});

test("the text length the writer records matches the text for every slide of a custom song", () => {
  const t = g.tpl_fromPro(read("templates", "georgia.pro"));
  assert.deepStrictEqual(Array.from(g.pw_check(graceSong(t.assets, t.layout).bytes, t.assets)), []);
});

// ---- templates that cannot be used

function swapCue(bytes, fn) {
  return Buffer.from(g.pb_encode(g.pb_fields(new Uint8Array(bytes)).map((f) => (f.n === 13 ? { n: 13, wt: 2, tag: null, body: fn(f.body) } : f))));
}
function replaceBytes(buf, from, to) {
  const at = buf.indexOf(Buffer.from(from, "latin1"));
  assert.ok(at >= 0, from);
  const out = Buffer.from(buf);
  Buffer.from(to, "latin1").copy(out, at);
  return out;
}
const GEORGIA = read("templates", "georgia.pro");
const ELEMENT_PATH = [10, 23, 2, 1, 1, 1];

const BAD = {
  "an empty file": [Buffer.alloc(0), /empty/],
  "a zip file": [Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(40)]), /zip file/],
  "a truncated file": [GEORGIA.subarray(0, 700), /could not be read|does not look like|damaged|no slides|no text box|text box/],
  "a plain text file": [Buffer.from("Hello, this is not a slide.\n".repeat(20)), /does not look like|could not be read|no slides|damaged/],
  "a slide with no text box": [swapCue(GEORGIA, (cue) => g.pb_editPath(cue, ELEMENT_PATH, (el) => g.pb_encode(g.pb_fields(el).filter((f) => f.n !== 13)))), /none of the slides|no text box/i],
  "a slide with two text boxes": [swapCue(GEORGIA, (cue) => g.pb_editPath(cue, [10, 23, 2, 1], (base) => {
    const f = g.pb_fields(base), first = f.find((x) => x.n === 1);
    return g.pb_encode([first].concat(f));
  })), /2 text boxes/],
  "RTF that is not RTF": [replaceBytes(GEORGIA, "{\\rtf1\\ansi", "{\\xtf1\\ansi"), /not in the form/],
  "RTF with no paragraph settings": [replaceBytes(replaceBytes(GEORGIA, "\\pard\\slleading", "\\pxrd\\slleading"), "\\pardirnatural", "\\pxrdirnatural"), /paragraph settings/],
  "the template's words stored a second time in the slide": [swapCue(GEORGIA, (cue) => g.pb_encode(g.pb_fields(cue).concat([g.pb_stringField(2, "Placeholder words")]).sort((a, b) => a.n - b.n))), /more than one place/],
};

for (const [what, [bytes, reason]] of Object.entries(BAD)) {
  test("rejects " + what + " with a readable reason", () => {
    assert.throws(() => g.tpl_fromPro(bytes), (e) => {
      assert.match(e.message, reason);
      assert.ok(e.tpl === true || /could not be read/.test(e.message), "reason must be written for the admin: " + e.message);
      return true;
    });
  });
}

test("60 randomly corrupted copies of a good template never throw out of tpl_choose and always give a usable look", () => {
  let seed = 12345, rejected = 0, accepted = 0;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
  for (let i = 0; i < 60; i++) {
    const bad = Buffer.from(GEORGIA);
    const at = next() % (bad.length - 12);
    for (let k = 0; k < 1 + (next() % 8); k++) bad[at + k] = next() & 0xff;
    const logs = [];
    const t = g.tpl_choose({ bytes: new Uint8Array(bad) }, null, (l) => logs.push(l));
    assert.strictEqual(logs.length, 1);
    if (t.source === "fallback") { rejected++; assert.match(logs[0], /TEMPLATE PROBLEM/); assert.ok(t.problem.length > 10); }
    else { accepted++; assert.strictEqual(t.source, "custom"); }
    const s = g.pw_build(g.draftSlides("Verse 1\nHello there friend\n", t.layout).groups, "Verse 1\nHello there friend\n", { title: "x" }, ["V1"], null, t.assets);
    assert.deepStrictEqual(Array.from(g.pw_check(s.bytes, t.assets)), []);
  }
  assert.ok(rejected > 5, "expected corruption to be caught at least sometimes, got " + rejected);
  assert.strictEqual(rejected + accepted, 60);
});

// ---- which template a run uses, and what the Log tab says

function memory() { let v = null; return { get: () => v, set: (x) => { v = x; } }; }

test("no template.pro: the built-in look, one clear Log line, and no repeat of it on the next run", () => {
  const logs = [], store = memory();
  const a = g.tpl_choose(null, store, (l) => logs.push(l));
  const b = g.tpl_choose(null, store, (l) => logs.push(l));
  assert.strictEqual(a.source, "default");
  assert.strictEqual(b.source, "default");
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /no template\.pro in the Sunday Slides folder/);
  assert.match(logs[0], /built-in look/);
});

test("a template that cannot be read from Drive falls back and says why on the Log tab", () => {
  const logs = [];
  const t = g.tpl_choose({ error: "the file could not be read from Google Drive: quota" }, memory(), (l) => logs.push(l));
  assert.strictEqual(t.source, "fallback");
  assert.strictEqual(t.layout.fontName, "Arial-BoldMT");
  assert.match(logs[0], /TEMPLATE PROBLEM.*quota/);
});

test("a broken template.pro falls back to the default and writes the reason to the Log tab; fixing it switches over", () => {
  const logs = [], store = memory();
  const broken = g.tpl_choose({ bytes: new Uint8Array(GEORGIA.subarray(0, 500)) }, store, (l) => logs.push(l));
  assert.strictEqual(broken.source, "fallback");
  assert.ok(broken.problem);
  assert.match(logs[0], /TEMPLATE PROBLEM: template\.pro was not used: .+built-in look until this is fixed/);
  g.tpl_choose({ bytes: new Uint8Array(GEORGIA.subarray(0, 500)) }, store, (l) => logs.push(l));
  assert.strictEqual(logs.length, 1, "same problem, same line, logged once");
  const good = g.tpl_choose({ bytes: new Uint8Array(GEORGIA), extra: "2 files are called template.pro; the newest one is used" }, store, (l) => logs.push(l));
  assert.strictEqual(good.source, "custom");
  assert.strictEqual(logs.length, 2);
  assert.match(logs[1], /TEMPLATE: using slide 1 of your template\.pro: Georgia-Bold, 54 pt/);
  assert.match(logs[1], /2 files are called template\.pro/);
});

test("a template whose text box is too short for two lines is used, with a note", () => {
  const short = g.tpl_fromPro(Buffer.from(tool.buildTemplatePro({ idSeed: "short", box: { x: 0, y: 0, width: 1400, height: 90 } })));
  assert.strictEqual(short.warnings.length, 1);
  assert.match(short.warnings[0], /too short for two lines/);
});

// ---- line breaking and widths

test("Arial widths agree with an independent computation from the font file (fontTools)", () => {
  // Total advance in font units (2048 per em), summed with a different tool from the fonts on a Mac.
  const fromFontTools = [
    ["Amazing grace, how sweet the sound", 34039, 36415], ["Wandering from the fold of God", 28573, 30830],
    ["Jesus sought me when a stranger", 30737, 33005], ["I’m fixed upon it", 14343, 15701],
  ];
  for (const [line, regular, bold] of fromFontTools) {
    const mk = (name) => g.layout_make({ fontName: name, fontPt: 60, trackingPt: 0, boxWidth: 1400, caps: false });
    assert.ok(Math.abs(g.layout_width(mk("ArialMT"), line) - regular / 2048 * 60) < 1e-9, line);
    assert.ok(Math.abs(g.layout_width(mk("Arial-BoldMT"), line) - bold / 2048 * 60) < 1e-9, line);
  }
});

test("width model by font name", () => {
  const m = (n) => g.layout_model(n);
  assert.strictEqual(m("CMGSans-MediumCAPS"), "cmg");
  assert.strictEqual(m("Arial-BoldMT"), "arial");
  assert.strictEqual(m("ArialMT"), "arial");
  assert.strictEqual(m("Arial"), "arial");
  assert.strictEqual(m("Helvetica"), "arial");
  assert.strictEqual(m("ArialNarrow"), "average");
  assert.strictEqual(m("Arial-Black"), "average");
  assert.strictEqual(m("Georgia-Bold"), "average");
  assert.strictEqual(m(""), "average");
});

test("the average-width rule never makes a line narrower than Arial would, so unknown fonts break early, not late", () => {
  const mk = (name) => g.layout_make({ fontName: name, fontPt: 60, trackingPt: 0, boxWidth: 1400, caps: false });
  let lines = 0;
  for (const n of ["amazing-grace", "holy-holy-holy", "come-thou-fount", "it-is-well"]) {
    for (const line of text("hymns", n + ".txt").split("\n")) {
      if (!line.trim() || /^(verse|chorus)/i.test(line)) continue;
      lines++;
      assert.ok(g.layout_width(mk("Georgia"), line) > g.layout_width(mk("Arial-BoldMT"), line), line);
    }
  }
  assert.ok(lines > 60);
});

test("default look: every line fits the box, keeps the lyric's own case, and the drafts match the reviewed reference", () => {
  const layout = g.layout_default();
  for (const n of ["amazing-grace", "holy-holy-holy", "come-thou-fount", "it-is-well"]) {
    const lyrics = text("hymns", n + ".txt"), out = g.draftSlides(lyrics);
    for (const grp of out.groups) for (const slide of grp.slides) for (const line of slide) {
      assert.ok(g.layout_fits(layout, line), n + ": " + line);
      assert.ok(line !== line.toUpperCase() || line.length < 4, "should not be capitals: " + line);
    }
    const asText = out.groups.map((x) => "[" + x.label + "]\n" + x.slides.map((s) => s.join(" / ")).join("\n")).join("\n") + "\n";
    assert.strictEqual(asText, text("golden", n + ".slides.txt"), n + ": drafts changed; review, then run node tools/make_golden_drafts.js and rebuild the golden files");
  }
});

test("capitals are used only when the template shows capitals", () => {
  const plain = g.layout_make({ fontName: "Arial-BoldMT", fontPt: 60, boxWidth: 1400, caps: false });
  const caps = g.layout_make({ fontName: "Arial-BoldMT", fontPt: 60, boxWidth: 1400, caps: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.draftSlides("Verse 1\nHoly holy holy\n", plain).groups[0].slides)), [["Holy holy holy"]]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.draftSlides("Verse 1\nHoly holy holy\n", caps).groups[0].slides)), [["HOLY HOLY HOLY"]]);
  assert.ok(g.layout_width(caps, "holy") > g.layout_width(plain, "holy"));
});
