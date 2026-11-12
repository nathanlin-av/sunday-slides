// Checks of the lyrics-to-slides drafter: the width model, the rules, and a regression score against reference slide
// drafts of four public-domain hymns (tests/fixtures/golden/*.slides.txt, which are the drafter's output, checked by hand).
// If a tuning change moves a line break, the score test shows which slide changed; check it, then regenerate the file.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadGas } = require("./gas-loader");

const gas = loadGas(["Assets.js", "CmgWidths.js", "ArialWidths.js", "Layout.js", "Drafter.js"]);
// These tests cover the CMG Sans look (capitals, 63 pt, 3 pt tracking, a 1401.1 wide box). The default look has its own tests below.
const CMG = gas.layout_make({ fontName: "CMGSans-MediumCAPS", fontPt: 63, trackingPt: 3, boxWidth: 1401.1, caps: true });
// The vm context has its own Array and Object, so round trip results through JSON for deep comparisons.
const g = {
  draftSlides: (text) => JSON.parse(JSON.stringify(gas.draftSlides(text, CMG))),
  slideLineWidth: (text) => gas.layout_width(CMG, text),
  slideLineFits: (text) => gas.layout_fits(CMG, text)
};
const FIXTURES = path.join(__dirname, "fixtures");
const HYMNS = ["amazing-grace", "holy-holy-holy", "come-thou-fount", "it-is-well"];

// FITS and WRAPS are the nearest hymn lines either side of the box limit (1401.1 wide, 3 percent kept clear, so 1359.07
// slide units). FONT_WIDTHS were computed from the font file with a separate script (glyph advances at 63pt plus 3pt
// tracking per character).
const FITS = ["CALL FOR SONGS OF LOUDEST PRAISE", "TEACH ME SOME MELODIOUS SONNET", "MOUNT OF THY REDEEMING LOVE", "SUNG BY FLAMING TONGUES ABOVE"];
const WRAPS = ["WANDERING FROM THE FOLD OF GOD", "BIND MY WANDERING HEART TO THEE", "JESUS SOUGHT ME WHEN A STRANGER", "WHEN SORROWS LIKE SEA BILLOWS ROLL"];
const FONT_WIDTHS = {
  "CALL FOR SONGS OF LOUDEST PRAISE": 1358.6460000000002,
  "TEACH ME SOME MELODIOUS SONNET": 1356.3000000000002,
  "MOUNT OF THY REDEEMING LOVE": 1203.03,
  "SUNG BY FLAMING TONGUES ABOVE": 1289.67,
  "WANDERING FROM THE FOLD OF GOD": 1360.458,
  "BIND MY WANDERING HEART TO THEE": 1361.379,
  "JESUS SOUGHT ME WHEN A STRANGER": 1378.7669999999998,
  "WHEN SORROWS LIKE SEA BILLOWS ROLL": 1499.34,
  "I’M FIXED UPON IT": 646.854
};

// The reference drafts are the drafter's own output, checked by hand, so every slide must match exactly. A drop means a line break moved.
const TOTAL_SLIDES = 74;

function parseDraft(file) {
  const groups = [];
  let cur = null;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("(")) { continue; }
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { cur = { label: head[1], slides: [] }; groups.push(cur); continue; }
    const text = line.replace(/\s+\(\?\).*$/, "");
    cur.slides.push(text.split("/").map((s) => s.trim()));
  }
  return groups;
}

const flat = (t) => t.replace(/[^A-Z0-9' ]/g, "").replace(/\s+/g, " ").trim();

// Compare slide by slide. One gold slide is one sung line, so if the drafter spread that sung line over
// several slides it is consumed together and counted as a miss.
function score(goldGroups, out) {
  let ok = 0, total = 0;
  const misses = [];
  for (const gold of goldGroups) {
    const mine = out.groups.find((x) => x.label === gold.label) || { slides: [] };
    let at = 0;
    for (const slide of gold.slides) {
      total++;
      const want = flat(slide.join(" "));
      const first = mine.slides[at];
      let used = 0, acc = [];
      while (at < mine.slides.length && flat(acc.concat(mine.slides[at]).join(" ")).length <= want.length) {
        acc = acc.concat(mine.slides[at]);
        at++; used++;
        if (flat(acc.join(" ")) === want) { break; }
      }
      if (used === 1 && first.join("|") === slide.join("|")) { ok++; }
      else { misses.push({ label: gold.label, want: slide.join(" / "), got: mine.slides.slice(at - used, at).map((s) => s.join(" / ")).join(" || ") }); }
    }
  }
  return { ok, total, misses };
}

const songs = HYMNS.map((name) => {
  const groups = parseDraft(path.join(FIXTURES, "drafts-cmg", name + ".slides.txt"));
  return { name, groups, lyrics: fs.readFileSync(path.join(FIXTURES, "hymns", name + ".txt"), "utf8") };
});
const graceLyrics = fs.readFileSync(path.join(FIXTURES, "hymns", "amazing-grace.txt"), "utf8");

const EDGE_INPUTS = [
  "Chorus\nHallelujah, hallelujah!\nHe is worthy, He is worthy;\n\nChorus\nHallelujah, hallelujah!\nHe is worthy, He is worthy;",
  "Verse 1\nWe’re singing, we’re shouting ’cause grace is wonderful and everlasting to us all today\nA\nIt’s a thing",
  "Just some words\nOn two lines\nAnd a third line goes here, so it stays long"
];

test("width model matches an independent computation from the font file", () => {
  for (const [text, want] of Object.entries(FONT_WIDTHS)) {
    assert.ok(Math.abs(g.slideLineWidth(text) - want) < 1e-6, `${text}: ${g.slideLineWidth(text)} vs ${want}`);
  }
  assert.equal(g.slideLineWidth("a’b"), g.slideLineWidth("a'b"));
});

test("lines just inside the box limit fit, lines just outside do not", () => {
  for (const t of FITS) { assert.equal(g.slideLineFits(t), true, t); }
  for (const t of WRAPS) { assert.equal(g.slideLineFits(t), false, t); }
});

test("every slide line fits, is uppercase and has no trailing punctuation", () => {
  const inputs = [graceLyrics, ...songs.map((s) => s.lyrics), ...EDGE_INPUTS];
  let lines = 0;
  for (const text of inputs) {
    const out = g.draftSlides(text);
    for (const grp of out.groups) {
      for (const slide of grp.slides) {
        assert.ok(slide.length >= 1 && slide.length <= 2, `${grp.label}: ${slide.length} lines`);
        for (const line of slide) {
          lines++;
          assert.ok(g.slideLineFits(line), `${grp.label}: does not fit: ${line}`);
          assert.equal(line, line.toUpperCase());
          assert.ok(!/[,.;:!?]$/.test(line), `trailing punctuation: ${line}`);
          assert.ok(line.length > 0 && line === line.trim());
        }
      }
    }
  }
  assert.ok(lines > 150);
});

test("punctuation is stripped at line ends, kept inside, apostrophes kept", () => {
  const out = g.draftSlides("Verse 1\nYes, Lord!\nHe's the joy-giver, always;\nWho am I, that You'd care?");
  const lines = out.groups[0].slides.flat();
  assert.deepEqual(out.groups[0].slides[0], ["YES, LORD"]);
  assert.ok(lines.some((l) => l.includes("JOY-GIVER")));
  assert.ok(lines.every((l) => !/[,.;:!?]$/.test(l)));
  assert.ok(lines.join(" ").includes("HE'S"));
  assert.ok(lines.join(" ").includes("YOU'D CARE"));
});

test("one short line stays one line, a longer one splits in two", () => {
  const out = g.draftSlides("Verse 1\nHoly, holy, holy\nEarly in the morning our song shall rise to Thee");
  assert.deepEqual(out.groups[0].slides[0], ["HOLY, HOLY, HOLY"]);
  assert.deepEqual(out.groups[0].slides[1], ["EARLY IN THE MORNING OUR SONG", "SHALL RISE TO THEE"]);
});

test("a split falls at a comma when there is one", () => {
  const out = g.draftSlides("Verse 1\nEarly in the morning, our song shall rise to Thee");
  assert.deepEqual(out.groups[0].slides[0], ["EARLY IN THE MORNING", "OUR SONG SHALL RISE TO THEE"]);
});

test("a repeated phrase splits between the copies", () => {
  const out = g.draftSlides("Chorus\nHallelujah praise Him hallelujah praise Him\nSing His praise sing His praise");
  assert.deepEqual(out.groups[0].slides, [["HALLELUJAH PRAISE HIM", "HALLELUJAH PRAISE HIM"], ["SING HIS PRAISE", "SING HIS PRAISE"]]);
});

test("a single short word is not left alone on a line", () => {
  const out = g.draftSlides("Verse 1\nSafely to arrive at home\nProne to wander Lord I feel it");
  for (const slide of out.groups[0].slides) {
    if (slide.length === 2) { for (const l of slide) { assert.ok(l.split(" ").length > 1, l); } }
  }
});

test("a line too long for two lines becomes more slides and is flagged", () => {
  const out = g.draftSlides("Bridge\nCasting down their golden crowns around the glassy sea and falling down before Thee forever");
  assert.equal(out.groups[0].slides.length, 2);
  assert.equal(out.flags.length, 1);
  assert.match(out.flags[0], /does not fit in two lines/);
  assert.match(out.flags[0], /Bridge/);
});

test("identical repeated section is dropped, different text is renamed and flagged", () => {
  const same = g.draftSlides("Chorus\nOh come and sing\n\nVerse 1\nOh come let us adore\n\nChorus\noh come and sing!");
  assert.deepEqual(same.groups.map((x) => x.label), ["Chorus", "Verse 1"]);
  assert.equal(same.flags.length, 0);

  const diff = g.draftSlides("Chorus\nOh come and sing\n\nChorus\nA different chorus line");
  assert.deepEqual(diff.groups.map((x) => x.label), ["Chorus", "Chorus 2"]);
  assert.equal(diff.flags.length, 1);
  assert.match(diff.flags[0], /Chorus 2/);

  const taken = g.draftSlides("Chorus\nOne\n\nChorus 2\nTwo\n\nChorus\nThree");
  assert.deepEqual(taken.groups.map((x) => x.label), ["Chorus", "Chorus 2", "Chorus 3"]);
});

test("lyrics with no labels go in one group called Verse 1 with a flag", () => {
  const out = g.draftSlides("Amazing grace\nHow sweet the sound");
  assert.deepEqual(out.groups.map((x) => x.label), ["Verse 1"]);
  assert.equal(out.groups[0].slides.length, 1);
  assert.equal(out.flags.length, 1);
  assert.match(out.flags[0], /No section labels/);
});

test("a section with no lines is dropped with a flag", () => {
  const out = g.draftSlides("Verse 1\nSome words here\n\nChorus\n\nBridge\nMore words");
  assert.deepEqual(out.groups.map((x) => x.label), ["Verse 1", "Bridge"]);
  assert.equal(out.flags.length, 1);
  assert.match(out.flags[0], /Chorus/);
});

test("empty and blank input give no groups and a flag", () => {
  for (const text of ["", "  \n\n ", null, undefined]) {
    const out = g.draftSlides(text);
    assert.deepEqual(out.groups, []);
    assert.equal(out.flags.length, 1);
  }
});

test("label forms: brackets, colon, Windows line endings, hyphenated names", () => {
  const out = g.draftSlides("[Verse 1]\r\nLine one\r\n\r\nPre-Chorus:\r\nLine two\r\n\r\nDown-Bridge 1\r\nLine three");
  assert.deepEqual(out.groups.map((x) => x.label), ["Verse 1", "Pre-Chorus", "Down-Bridge 1"]);
});

test("score against the reference hymn drafts", () => {
  let ok = 0, total = 0;
  const rows = [];
  for (const song of songs) {
    const r = score(song.groups, g.draftSlides(song.lyrics));
    ok += r.ok; total += r.total;
    rows.push(`${song.name.padEnd(16)} ${String(r.ok).padStart(3)}/${String(r.total).padEnd(3)} ${(100 * r.ok / r.total).toFixed(1)}%`);
    for (const m of r.misses) { rows.push(`    [${m.label}] want: ${m.want}\n    ${" ".repeat(m.label.length + 2)} got:  ${m.got}`); }
  }
  rows.push(`OVERALL          ${ok}/${total} ${(100 * ok / total).toFixed(1)}%`);

  if (ok !== total) console.log(rows.join("\n"));

  assert.equal(total, TOTAL_SLIDES);
  assert.equal(ok, total, `${total - ok} slide(s) no longer match the reference drafts, see the rows above`);
});

test("Amazing Grace lyrics file: label order, counts and no flags", () => {
  const out = g.draftSlides(graceLyrics);
  assert.deepEqual(out.groups.map((x) => x.label), ["Verse 1", "Verse 2", "Verse 3", "Verse 4"]);
  assert.deepEqual(out.groups.map((x) => x.slides.length), [4, 4, 4, 4]);
  assert.deepEqual(out.flags, []);
});

// Short consecutive lines share a slide, but never across sections, never after a sentence end,
// and a line that needs two slide lines keeps its own slide. Public-domain text only.
test("two short consecutive lines share one slide", () => {
  const out = g.draftSlides("Chorus\nGlory be to the Father\nAnd to the Son\nAnd to the Holy Ghost");
  assert.deepEqual(out.groups[0].slides[0], ["GLORY BE TO THE FATHER", "AND TO THE SON"]);
});

test("a short line is never paired with a line from the next section", () => {
  const out = g.draftSlides("Verse 1\nHoly holy holy\nChorus\nLord God Almighty");
  assert.deepEqual(out.groups.map((x) => x.slides.length), [1, 1]);
});

test("a sentence end keeps the next line on a new slide", () => {
  const out = g.draftSlides("Verse 1\nHoly holy holy.\nLord God Almighty");
  assert.equal(out.groups[0].slides.length, 2);
});

test("a sentence end inside closing quotes or brackets also keeps the next line apart", () => {
  for (const end of ['me."', "me.\u201d", "me?'", "me.)"]) {
    const out = g.draftSlides("Verse 1\nHe said to " + end + "\nCome and see");
    assert.strictEqual(out.groups[0].slides.length, 2, end);
  }
});

test("a long line is not paired", () => {
  const out = g.draftSlides("Verse 1\nHoly holy holy\nEarly in the morning our song shall rise to Thee");
  assert.equal(out.groups[0].slides.length, 2);
});

test("three short lines make one shared slide and one slide of its own", () => {
  const out = g.draftSlides("Chorus\nGlory be to the Father\nAnd to the Son\nAnd to the Holy Ghost");
  assert.deepEqual(out.groups[0].slides.map((s) => s.length), [2, 1]);
});

test("short lines with a repeated phrase keep a slide each", () => {
  const out = g.draftSlides("Verse 1\nPraise Him praise Him\nPraise Him praise Him");
  assert.equal(out.groups[0].slides.length, 2);
});

// Labels, other alphabets and wide characters.
test("the same label a third time with words already seen makes no extra group", () => {
  const a = "Amazing grace how sweet the sound", b = "I once was lost but now am found";
  const out = g.draftSlides(["Chorus", a, "", "Chorus", b, "", "Chorus", b, "", "Chorus", a].join("\n"));
  assert.deepEqual(out.groups.map((x) => x.label), ["Chorus", "Chorus 2"]);
});

test("Chorus and Chorus 1 are the same label", () => {
  const a = "Amazing grace how sweet the sound", b = "I once was lost but now am found";
  const same = g.draftSlides(["Chorus", a, "", "Chorus 1", a].join("\n"));
  assert.deepEqual(same.groups.map((x) => x.label), ["Chorus"]);
  const differ = g.draftSlides(["Chorus", a, "", "Chorus 1", b].join("\n"));
  assert.deepEqual(differ.groups.map((x) => x.label), ["Chorus", "Chorus 2"]);
  assert.equal(differ.flags.length, 1);
});

test("two sections with one label and different words in another alphabet are both kept", () => {
  const out = g.draftSlides("Verse\nСвят свят свят\n\nVerse\nВоистину воскрес");
  assert.equal(out.groups.length, 2);
  assert.equal(out.flags.length, 1);
});

test("wide characters (Chinese, Japanese, Korean) are measured at full width", () => {
  const line = "聖".repeat(26);
  assert.equal(g.slideLineFits(line), false);
  assert.equal(g.slideLineFits("聖".repeat(6)), true);
});

test("words in another alphabet are not mistaken for a repeated phrase", () => {
  const out = g.draftSlides("Verse 1\n\u6211 \u7231 \u4f60 \u4e3b");
  assert.deepEqual(out.groups[0].slides, [["\u6211 \u7231 \u4f60 \u4e3b"]]);
});


test("a label like Verse 1a is a label", () => {
  const out = g.draftSlides("VERSE 1A\nAmazing grace how sweet the sound\n\nVerse 1b\nI once was lost but now am found");
  assert.deepEqual(out.groups.map((x) => x.label), ["Verse 1a", "Verse 1b"]);
});

test("one-word lines share a slide too", () => {
  const out = g.draftSlides("Verse 1\nHoly\nHoly\nLord God Almighty");
  assert.deepEqual(out.groups[0].slides.map((x) => x.length), [2, 1]);
});

test("rare Chinese characters outside the basic range are full width as well", () => {
  assert.equal(g.slideLineFits("\ud840\udc0b".repeat(26)), false);
  assert.equal(g.slideLineFits("\ud840\udc0b".repeat(6)), true);
});

test("a label keeps only its words: stars, dashes and a final full stop are not part of it", () => {
  const body = "\nAmazing grace how sweet the sound\n\n";
  const out = g.draftSlides("Verse 1." + body + "*Chorus*" + body.replace("Amazing", "Lasting") + "-- Bridge --" + body.replace("Amazing", "Saving") + "**Tag**:" + body.replace("Amazing", "Endless"));
  assert.deepEqual(out.groups.map((x) => x.label), ["Verse 1", "Chorus", "Bridge", "Tag"]);
});

test("unseen characters and unusual line breaks do not make slides", () => {
  const out = g.draftSlides("\u200bVerse 1\nAmazing grace how sweet the sound\u2028That saved a wretch like me\n\u200b\n\ufeffI once was lost but now am found\u0007");
  assert.deepEqual(out.groups.map((x) => x.label), ["Verse 1"]);
  assert.equal(out.groups[0].slides.length, 3);
  assert.ok(!/[\u200b\ufeff\u0007\u2028]/.test(JSON.stringify(out.groups)));
});

test("a huge line is cut into pieces, flagged, and does not take long", () => {
  const t0 = Date.now();
  const words = g.draftSlides("Verse 1\n" + "holy ".repeat(3000));
  const commas = g.draftSlides("Verse 1\nword word " + ",".repeat(20000) + "a");
  assert.ok(Date.now() - t0 < 5000, "took " + (Date.now() - t0) + " ms");
  assert.ok(words.groups[0].slides.length > 100);
  assert.ok(words.flags.some((f) => /cut into pieces/.test(f)));
  assert.ok(commas.groups[0].slides.length >= 1);
  const normal = g.draftSlides("Verse 1\nAmazing grace how sweet the sound that saved a wretch like me");
  assert.ok(!normal.flags.some((f) => /cut into pieces/.test(f)));
});

test("a label with nothing under it, for a section already typed, means sing that section again", () => {
  const out = g.draftSlides("Verse 1\nAmazing grace how sweet the sound\n\nChorus\nI once was lost but now am found\n\nVerse 2\nTwas grace that taught my heart to fear\n\nChorus\n");
  assert.deepEqual(out.order, ["Verse 1", "Chorus", "Verse 2", "Chorus"]);
  assert.equal(out.flags.length, 0);
  const lone = g.draftSlides("Verse 1\nAmazing grace how sweet the sound\n\nBridge\n");
  assert.deepEqual(lone.order, ["Verse 1"]);
  assert.equal(lone.flags.length, 1);
});

test("vowel points and tone marks in any script take no width of their own", () => {
  const em = (text) => gas.layout_em(CMG, text);   // width of the letters alone, without letter spacing
  assert.equal(em("\u05e9\u05c1\u05b8\u05dc\u05d5\u05b9\u05dd"), em("\u05e9\u05dc\u05d5\u05dd"));
  assert.equal(em("\u0e01\u0e48"), em("\u0e01"));
  assert.ok(em("\u05e9") > 0);
});

test("a variation selector past the basic range takes no width", () => {
  const em = (text) => gas.layout_em(CMG, text);
  assert.equal(em("A\udb40\udd00"), em("A"));
});

test("trimming the ends of a line gives exactly what the plain pattern gives, on any text", () => {
  const pattern = /^[\p{Cf}\s]+|[\p{Cf}\s]+$/gu;
  const parts = ["a", "b", " ", "\t", "\u00a0", "\u200b", "\u200d", "\u200f", "\u2060", "\ufeff", "\u061c", "\u00ad", "\ud83d\ude00", "\udb40\udc20", "\udb40\udc7f", "\ud834\udd73", "\ud800", "\udc00", "."];
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let i = 0; i < 20000; i++) {
    let s = "";
    for (let k = rnd(9); k > 0; k--) s += parts[rnd(parts.length)];
    assert.equal(gas.drafter_trimEdges(s), s.replace(pattern, ""), JSON.stringify(s));
  }
});
