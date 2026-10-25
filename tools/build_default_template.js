#!/usr/bin/env node
/**
 * Builds the neutral default look that ships with Sunday Slides: apps-script/Assets.js (the template slide and the
 * group definitions the writer clones) and templates/default-template.pro (the same slide as a ProPresenter file you
 * can open, restyle and save as your own template.pro).
 *
 * Usage:
 *   node tools/build_default_template.js            write both files
 *   node tools/build_default_template.js --check    exit 1 if either file is out of date
 *   node tools/build_default_template.js --groups-file out.pro   also write a file holding only the group definitions
 *                                                   (used by the test fixtures)
 *
 * Needs Node 20 or newer and nothing else. The protobuf encoder below is deliberately separate from
 * apps-script/Proto.js, so the files this tool writes are an independent check on the code that reads them.
 *
 * Fresh IDs: every ID is derived, never random, so the output is reproducible. An ID is "00000000-0000-4xxx-8xxx-0000000yyyyy"
 * where the 11 hex digits x and y are the first 11 hex digits of SHA-256("sunday-slides default template v1/" + name).
 * It is a valid version 4 UUID with the variant bits set; the zeros keep it plainly recognisable as a placeholder.
 * Changing a name changes the ID. The tests use IDs that start 00000000-0000-4000-8000-, which this never makes.
 *
 * The same builder also makes the synthetic templates the tests use (different font, colors, size): see buildTemplatePro.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------- protobuf encoding (wire format only)

function varint(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); out.push(n > 0 ? b | 0x80 : b); } while (n > 0);
  return Buffer.from(out);
}
const cat = (parts) => Buffer.concat(parts.filter(Boolean));
const tag = (n, wt) => varint(n * 8 + wt);
/** Length delimited field holding the given child fields. */
const msg = (n, ...kids) => { const body = cat(kids); return cat([tag(n, 2), varint(body.length), body]); };
const str = (n, s) => { const b = Buffer.from(s, "utf8"); return cat([tag(n, 2), varint(b.length), b]); };
const raw = (n, b) => cat([tag(n, 2), varint(b.length), Buffer.from(b)]);
const vint = (n, v) => cat([tag(n, 0), varint(v)]);
const f32 = (n, v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return cat([tag(n, 5), b]); };
const f64 = (n, v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return cat([tag(n, 1), b]); };

/** Deterministic UUID for a name (see the header). */
function makeId(name) {
  const h = crypto.createHash("sha256").update("sunday-slides default template v1/" + name).digest().toString("hex").toUpperCase();
  const id = "00000000-0000-4" + h.slice(0, 3) + "-8" + h.slice(3, 6) + "-0000000" + h.slice(6, 11);
  if (/^00000000-0000-4000-8000-/.test(id)) throw new Error("ID clashes with the test ID sequence: " + name);
  return id;
}
const uuidMsg = (n, id) => msg(n, str(1, id));

// ---------------------------------------------------------------- the look

/** The default look. A synthetic template for a test overrides some of these. */
const DEFAULT_LOOK = {
  idSeed: "default",
  name: "Default template",
  placeholder: ["Amazing grace", "how sweet the sound"],   // public domain (John Newton, 1779)
  fontName: "Arial-BoldMT",      // PostScript name: the same on macOS and Windows
  fontFamily: "Arial",
  fontFace: "Bold",
  fontPt: 60,
  kerning: 0,                    // extra spacing per character, in points
  capsAttribute: false,          // ProPresenter's "All Caps" text setting
  textColor: [1, 1, 1, 1],       // white
  lineSpacing: 10,
  box: { x: 259.4, y: 409.0, width: 1401.1313927557962, height: 261.9606738613634 },   // centered on a 1920 x 1080 slide
  backgroundColor: [0, 0, 0, 1], // opaque black
};

const toTwips = (pt) => Math.round(pt * 20);
const rtfChannel = (v) => Math.round(v * 255);
const rtfPercent = (v) => Math.round(v * 100000);

/** The RTF header Cocoa writes in front of the text, then the text, then the closing brace. */
function rtfHeader(look) {
  const c = look.textColor;
  return "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870\n" +
    "\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fnil\\fcharset0 " + look.fontName + ";}\n" +
    "{\\colortbl;\\red" + rtfChannel(c[0]) + "\\green" + rtfChannel(c[1]) + "\\blue" + rtfChannel(c[2]) +
    ";\\red" + rtfChannel(c[0]) + "\\green" + rtfChannel(c[1]) + "\\blue" + rtfChannel(c[2]) + ";}\n" +
    "{\\*\\expandedcolortbl;;\\csgenericrgb\\c" + rtfPercent(c[0]) + "\\c" + rtfPercent(c[1]) + "\\c" + rtfPercent(c[2]) + ";}\n" +
    "\\pard\\slleading" + toTwips(look.lineSpacing) + "\\pardirnatural\\qc\\partightenfactor0\n\n" +
    "\\f0\\fs" + Math.round(look.fontPt * 2) + " \\cf2 \\kerning1\\expnd" + Math.round(look.kerning * 4) + "\\expndtw" + toTwips(look.kerning) + "\n";
}

function rtfText(lines) {
  const esc = (s) => s.replace(/[\\{}]/g, (m) => "\\" + m).replace(/[^\x00-\x7f]/g, (ch) => {
    let out = "";
    for (let i = 0; i < ch.length; i++) { const u = ch.charCodeAt(i); out += "\\uc0\\u" + (u < 32768 ? u : u - 65536) + " "; }
    return out;
  });
  return lines.map(esc).join("\\\n");
}

const color = (n, c) => msg(n, c[0] ? f32(1, c[0]) : null, c[1] ? f32(2, c[1]) : null, c[2] ? f32(3, c[2]) : null, c[3] ? f32(4, c[3]) : null);
const shadow = (n, offset, radius) => msg(n, f64(2, 315), f64(3, offset), f64(4, radius), msg(5, f32(4, 1)), f64(6, 0.75));

/** One slide (a ProPresenter "cue") with a single centered text box. Field numbers are from the ProPresenter schema. */
function buildCue(look) {
  const id = (what) => makeId(look.idSeed + "/cue/" + what);
  const text = look.placeholder.join("\n");
  const units = text.length;   // UTF-16 code units, as ProPresenter counts
  const box = look.box;
  const rtf = Buffer.from(rtfHeader(look) + rtfText(look.placeholder) + "}", "latin1");
  const caps = look.capsAttribute ? vint(2, 1) : null;
  const point = (x, y) => [x ? f64(1, x) : null, y ? f64(2, y) : null];
  const corner = (x, y) => [msg(1, ...point(x, y)), msg(2, ...point(x, y)), msg(3, ...point(x, y))];
  return cat([
    uuidMsg(1, id("slide")),
    vint(5, 1),                                   // completion_action_type: last
    msg(8),                                       // hot_key (empty)
    msg(10,                                       // actions
      uuidMsg(1, id("action")),
      vint(6, 1),                                 // isEnabled
      vint(9, 11),                                // type: presentation slide
      msg(23,                                     // slide
        msg(2,                                    // presentation
          msg(1,                                  // base_slide
            msg(1,                                // elements
              msg(1,                              // element
                uuidMsg(1, id("text")),
                str(2, "Text"),
                msg(3, msg(1, f64(1, box.x), f64(2, box.y)), msg(2, f64(1, box.width), f64(2, box.height))),   // bounds
                f64(5, 1),                        // opacity
                msg(8,                            // path: a rectangle
                  vint(1, 1),
                  msg(2, ...corner(0, 0)), msg(2, ...corner(1, 0)), msg(2, ...corner(1, 1)), msg(2, ...corner(0, 1)),
                  msg(3, vint(1, 1))),
                msg(9, color(1, [1, 1, 1, 0.7])),                                   // fill (switched off)
                msg(10, f64(2, 5), color(3, [1, 1, 1, 1])),                         // stroke (switched off)
                shadow(11, 5, 5),
                msg(12, f64(2, 0.0517578125)),                                      // feather
                msg(13,                           // text
                  msg(3,                          // attributes
                    msg(1, str(1, look.fontName), f64(2, look.fontPt), str(9, look.fontFamily), look.fontFace ? str(10, look.fontFace) : null),
                    caps,
                    color(3, look.textColor),
                    msg(4),                       // underline_style
                    msg(6, vint(1, 2), f64(5, 1), f64(8, look.lineSpacing), msg(13)),   // paragraph: centered
                    look.kerning ? f64(7, look.kerning) : null,
                    msg(9),                       // strikethrough_style
                    msg(13, msg(1, vint(2, units)), caps)),   // custom_attributes: the range the writer keeps in step with the text
                  shadow(4, 2, 3),
                  raw(5, rtf),                    // rtf_data
                  vint(6, 1),                     // vertical_alignment: middle
                  msg(8),                         // margins
                  vint(9, 1),                     // is_superscript_standardized
                  str(11, "  •  "),          // transformDelimiter
                  msg(12, color(3, [0.993, 0.76, 0.032, 1]))),   // chord_pro
                msg(14)),                         // text_line_mask
              vint(4, 3),                         // info
              msg(9, f64(2, 0.5), vint(3, 1), f64(4, 0.07137089391974608))),   // text_scroller
            msg(6, f64(1, 1920), f64(2, 1080)),   // size
            uuidMsg(7, id("slide-body"))),
          msg(4, vint(3, 1))))),                  // chord_chart: platform macOS
    vint(12, 1),                                  // isEnabled
  ]);
}

/** application_info, background, chord chart and timeline: the part of a song that does not depend on its slides. [field number, bytes]. */
function buildHeadFields(look) {
  return [
    [1, msg(1, vint(1, 1), msg(2, vint(1, 26), vint(2, 5)), vint(3, 1), msg(4, vint(1, 21), vint(2, 4), str(4, "352583705")))],   // application_info: ProPresenter 21.4 on macOS
    [8, msg(8, color(1, look.backgroundColor))],                                                                                      // background
    [9, msg(9, vint(3, 1))],                                                                                                        // chord_chart: platform macOS
    [17, msg(17, f64(5, 300))],                                                                                                     // timeline: duration
  ];
}

// ---------------------------------------------------------------- groups: names, colors and hot keys (A to Z are codes 1 to 26)

// [name, [red, green, blue] or null, hot key code or null]. Alpha is 1 whenever a color is given.
const GROUPS = [
  ["Blank", [0, 0, 0], null],
  ["Bridge", [0.4627451002597809, 0, 0.800000011920929], 2],
  ["Bridge 1", [0.4627451002597809, 0, 0.800000011920929], 2],
  ["Bridge 2", [0.3490196168422699, 0, 0.6000000238418579], 14],
  ["Bridge 3", [0.23137255012989044, 0, 0.4000000059604645], 13],
  ["Chorus", [0.800000011920929, 0, 0.30588236451148987], 3],
  ["Chorus 1", [0.800000011920929, 0, 0.30588236451148987], 3],
  ["Chorus 2", [0.6000000238418579, 0, 0.23137255012989044], 24],
  ["Chorus 3", [0.4000000059604645, 0, 0.15294118225574493], 26],
  ["Chorus 4", [0.7019608020782471, 0, 0.2666666805744171], 23],
  ["Ending", [0.6000000238418579, 0.5607843399047852, 0.12156862765550613], 5],
  ["Interlude", [0.1411764770746231, 0.7019608020782471, 0.2980392277240753], 12],
  ["Interlude 2", null, 11],
  ["Intro", [0.7019608020782471, 0.6549019813537598, 0.1411764770746231], 9],
  ["Outro", [0.4941176474094391, 0.4627451002597809, 0.09803921729326248], 15],
  ["Pre-Chorus", null, null],
  ["PreChorus", [0.800000011920929, 0.16078431904315948, 0.545098066329956], 16],
  ["PreChorus 2", null, 17],
  ["Refrain", null, 18],
  ["Tag", [0.800000011920929, 0.16078431904315948, 0.16078431904315948], 20],
  ["Tag 2", null, 25],
  ["Turnaround", [0.1411764770746231, 0.7019608020782471, 0.2980392277240753], null],
  ["Vamp", [0.1411764770746231, 0.7019608020782471, 0.2980392277240753], 22],
  ["Verse", [0, 0.46666666865348816, 0.800000011920929], 1],
  ["Verse 1", [0, 0.46666666865348816, 0.800000011920929], 1],
  ["Verse 2", [0, 0.3490196168422699, 0.6000000238418579], 19],
  ["Verse 3", [0, 0.23529411852359772, 0.4000000059604645], 4],
  ["Verse 4", [0, 0.40784314274787903, 0.7019608020782471], 6],
  ["Verse 5", [0, 0.29019609093666077, 0.501960813999176], 7],
  ["Verse 6", [0, 0.1764705926179886, 0.3019607961177826], 8],
];

const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

/** One group definition (a cue group's "group" message) with the given ID. */
function groupMsg(name, rgb, hot, id) {
  return cat([
    uuidMsg(1, id),
    str(2, name),
    rgb ? color(3, [rgb[0], rgb[1], rgb[2], 1]) : null,
    msg(4, hot ? vint(1, hot) : null),   // hot_key (present, empty when the group has no key)
  ]);
}

// ---------------------------------------------------------------- files

/** A whole song file holding one slide in one group: what the tool writes as templates/default-template.pro. */
function buildTemplatePro(overrides) {
  const look = Object.assign({}, DEFAULT_LOOK, overrides || {});
  const g = GROUPS.find((x) => x[0] === "Verse 1");
  const fields = buildHeadFields(look).concat([
    [2, uuidMsg(2, makeId(look.idSeed + "/presentation"))],
    [3, str(3, look.name)],
    [12, msg(12, msg(1, groupMsg("Verse 1", g[1], g[2], makeId(look.idSeed + "/group/Verse 1"))), uuidMsg(2, makeId(look.idSeed + "/cue/slide")))],
    [13, msg(13, buildCue(look))],
  ]);
  fields.sort((a, b) => a[0] - b[0]);
  return cat(fields.map((f) => f[1]));
}

/** A song file that holds only the group definitions (every name above, each with its own derived ID and no slides). */
function buildGroupsPro() {
  return cat(GROUPS.map(([name, rgb, hot]) => msg(12, msg(1, groupMsg(name, rgb, hot, makeId("default/group/" + name))))));
}

const b64 = (buf) => Buffer.from(buf).toString("base64");

/** The text of apps-script/Assets.js. */
function buildAssetsJs() {
  const look = DEFAULT_LOOK;
  const cue = buildCue(look);
  const header = rtfHeader(look);
  const cueUuids = [...cue.toString("latin1").matchAll(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g)].map((m) => m[0])
    .filter((x, i, a) => a.indexOf(x) === i);
  const groups = {};
  for (const [name, rgb, hot] of GROUPS) groups[name] = b64(groupMsg(name, rgb, hot, PLACEHOLDER_ID));
  const assets = {
    placeholder: PLACEHOLDER_ID,
    marker: header,
    short: { B: "Bridge", C: "Chorus", E: "Ending", I: "Intro", O: "Outro", PC: "PreChorus", T: "Tag", Tag: "Tag", V: "Verse" },
    presentationHead: b64(cat(buildHeadFields(look).map((f) => f[1]))),
    cue: b64(cue),
    cueUuids,
    templateUuids: cueUuids,
    groups,
    layout: { fontName: look.fontName, fontPt: look.fontPt, trackingPt: look.kerning, boxWidth: look.box.width, caps: false },
    upperText: false,
    f: {
      arrangement: { group_identifiers: 3, name: 2, uuid: 1 },
      attrPath: [3, 13],
      ccli: { album: 8, artist_credits: 2, artwork: 9, author: 1, copyright_year: 5, display: 7, publisher: 4, song_number: 6, song_title: 3 },
      cueGroup: { cue_identifiers: 2, group: 1 },
      cueUuid: 1,
      group: { application_group_identifier: 5, application_group_name: 6, color: 3, hotKey: 4, name: 2, uuid: 1 },
      presentation: { application_info: 1, arrangements: 11, background: 8, bible_reference: 15, category: 6, ccli: 14, chord_chart: 9,
        content_destination: 19, cue_groups: 12, cues: 13, last_date_used: 4, last_modified_date: 5, multi_tracks_licensing: 21, music: 23,
        music_key: 22, name: 3, notes: 7, selected_arrangement: 10, slide_show_duration: 20, timeline: 17, transition: 18, uuid: 2 },
      rangeEnd: 2, rangePath: [1], rangeStart: 1, rtfData: 5, textPath: [10, 23, 2, 1, 1, 1, 13], uuid: { string: 1 },
    },
  };
  const body = JSON.stringify(assets, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v), 1);
  return "/**\n * The built-in default look: one centered text slide (Arial Bold, white on black) and the group definitions the writer clones.\n" +
    " * Generated by tools/build_default_template.js. Do not edit by hand; change the tool and run it again.\n */\nvar PP_ASSETS = " + body + ";\n";
}

function targets() {
  return [
    { file: path.join(ROOT, "apps-script", "Assets.js"), data: Buffer.from(buildAssetsJs(), "utf8") },
    { file: path.join(ROOT, "templates", "default-template.pro"), data: buildTemplatePro() },
  ];
}

function main(argv) {
  const gi = argv.indexOf("--groups-file");
  if (gi >= 0) fs.writeFileSync(argv[gi + 1], buildGroupsPro());
  if (argv.includes("--check")) {
    const stale = targets().filter((t) => !fs.existsSync(t.file) || !fs.readFileSync(t.file).equals(t.data));
    if (stale.length) { console.error("Out of date, run: node tools/build_default_template.js\n  " + stale.map((t) => t.file).join("\n  ")); process.exit(1); }
    console.log("Assets.js and templates/default-template.pro are up to date.");
    return;
  }
  if (gi >= 0 && argv.length === 2) return;
  for (const t of targets()) { fs.mkdirSync(path.dirname(t.file), { recursive: true }); fs.writeFileSync(t.file, t.data); console.log("wrote " + path.relative(ROOT, t.file) + " (" + t.data.length + " bytes)"); }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { DEFAULT_LOOK, GROUPS, buildCue, buildTemplatePro, buildGroupsPro, buildAssetsJs, makeId, rtfHeader };
