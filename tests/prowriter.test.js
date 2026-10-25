// The JS .pro writer must produce exactly the bytes in tests/fixtures/golden/*.pro, given the same inputs and the same
// IDs (00000000-0000-4000-8000-000000000001, ...2, ... in call order). The golden files were written once by a
// separate reference implementation of the writer, so this holds the two to byte equality without needing it here.
// All songs are public-domain hymns or synthetic text.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { loadGas, CORE } = require("./gas-loader");

const GOLDEN = path.join(__dirname, "fixtures", "golden");
const g = loadGas(CORE);
const CASES = JSON.parse(fs.readFileSync(path.join(GOLDEN, "cases.json"), "utf8"));
const read = (name, ext) => fs.readFileSync(path.join(GOLDEN, name + ext));

function detIds() {
  let n = 0;
  return () => "00000000-0000-4000-8000-" + (++n).toString(16).toUpperCase().padStart(12, "0");
}

function build(name, c) {
  return g.pw_build(g.pw_parseDraft(read(name, ".slides.txt").toString("utf8")), read(name, ".lyrics.txt").toString("utf8"),
    { title: c.title, author: c.author, year: c.year, ccli: c.ccli }, c.seq.split(","), detIds());
}

for (const [name, c] of Object.entries(CASES)) {
  test("JS writer equals the golden .pro byte for byte: " + name, () => {
    const js = build(name, c), gold = read(name, ".pro");
    assert.strictEqual(Buffer.from(js.bytes).length, gold.length, "length differs");
    assert.ok(Buffer.from(js.bytes).equals(gold), "bytes differ");
    assert.deepStrictEqual(Array.from(g.pw_check(js.bytes)), []);
  });
}

test("random IDs: unique, none shared with the template, check passes", () => {
  const draftText = read("amazing-grace", ".slides.txt").toString("utf8");
  const lyricsText = read("amazing-grace", ".lyrics.txt").toString("utf8");
  const a = g.pw_build(g.pw_parseDraft(draftText), lyricsText, { title: "Amazing Grace" }, ["V1", "V2"]);
  const b = g.pw_build(g.pw_parseDraft(draftText), lyricsText, { title: "Amazing Grace" }, ["V1", "V2"]);
  assert.ok(!Buffer.from(a.bytes).equals(Buffer.from(b.bytes)), "two builds must not share IDs");
  assert.deepStrictEqual(Array.from(g.pw_check(a.bytes)), []);
});

test("refuses bad input loudly", () => {
  const lyr = "Verse 1\nhello world\n";
  assert.throws(() => g.pw_build([{ label: "Verse 1", slides: [["GOODBYE"]] }], lyr, { title: "x" }, ["V1"]), /not found in the lyrics/);
  assert.throws(() => g.pw_build([{ label: "Verse 1", slides: [] }], lyr, { title: "x" }, ["V1"]), /has no slides/);
  assert.throws(() => g.pw_build([{ label: "Chorus", slides: [["HELLO"]] }, { label: "Chorus 1", slides: [["WORLD"]] }], lyr, { title: "x" }, ["C"]), /both be called/);
  assert.throws(() => g.pw_build([{ label: "Verse 1", slides: [["HELLO"]] }], lyr, { title: "x" }, ["Bridge"]), /has no group/);
  assert.throws(() => g.pw_build([{ label: "Verse 1", slides: [["HELLO"]] }], lyr, { title: "x" }, ["Verse 1"]), /not a section label/);
});

test("slide text survives a write and read: RTF escaping of braces, backslash, accents and emoji", () => {
  const text = "Ángel {amen}\nback\\slash 🙏 it’s";
  assert.strictEqual(g.pw_rtfUnescape(g.pw_rtfEscape(text)), text);
});

test("codec: re-encoding every golden file, and every slide's text path, is byte-identical", () => {
  let cues = 0;
  for (const name of Object.keys(CASES)) {
    const bytes = new Uint8Array(read(name, ".pro"));
    const top = g.pb_fields(bytes);
    assert.ok(Buffer.from(g.pb_encode(top)).equals(Buffer.from(bytes)), name + " top level");
    for (const fld of top) {
      if (fld.n !== g.PP_ASSETS.f.presentation.cues) continue;
      cues++;
      const out = g.pb_editPath(fld.body, g.PP_ASSETS.f.textPath, (x) => x);
      assert.ok(Buffer.from(out).equals(Buffer.from(fld.body)), name + " cue re-encode");
    }
  }
  assert.ok(cues > 50, "only " + cues + " slides checked");
});
