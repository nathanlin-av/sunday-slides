#!/usr/bin/env node
/**
 * Writes apps-script/ArialWidths.js: the advance width of each common character in Arial and Arial Bold, read from
 * the font files already on this computer. Nothing is downloaded and no font is copied: only the widths (plain
 * numbers) are kept, and the line breaker uses them to guess how wide a slide line will be.
 *
 * Usage: node tools/build_arial_widths.js [folder holding Arial.ttf and "Arial Bold.ttf"]
 * Default folders tried: /System/Library/Fonts/Supplemental (macOS), C:\Windows\Fonts (Windows).
 * Needs Node 20 or newer and nothing else. The small TrueType reader below handles the tables it needs
 * (head, hhea, hmtx, cmap formats 4 and 12) and fails loudly on anything else.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FOLDERS = ["/System/Library/Fonts/Supplemental", "C:\\Windows\\Fonts"];
// Characters kept: printable ASCII, Latin-1 letters and signs, and the typographic quotes, dashes and ellipsis lyrics use.
const WANTED = [];
for (let c = 32; c <= 126; c++) WANTED.push(c);
for (let c = 160; c <= 255; c++) WANTED.push(c);
WANTED.push(0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026);

function readTable(buf, tag) {
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    if (buf.toString("latin1", at, at + 4) === tag) return { offset: buf.readUInt32BE(at + 8), length: buf.readUInt32BE(at + 12) };
  }
  throw new Error("font has no " + tag + " table");
}

/** Map of code point to glyph index from the best Unicode cmap subtable. */
function readCmap(buf) {
  const { offset } = readTable(buf, "cmap");
  const count = buf.readUInt16BE(offset + 2);
  let best = null;
  for (let i = 0; i < count; i++) {
    const rec = offset + 4 + i * 8, platform = buf.readUInt16BE(rec), enc = buf.readUInt16BE(rec + 2), sub = offset + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(sub);
    const rank = platform === 3 && enc === 10 && format === 12 ? 3 : platform === 3 && enc === 1 && format === 4 ? 2 : platform === 0 && (format === 4 || format === 12) ? 1 : 0;
    if (rank > 0 && (!best || rank > best.rank)) best = { rank, sub, format };
  }
  if (!best) throw new Error("font has no Unicode cmap subtable of format 4 or 12");
  const map = new Map();
  if (best.format === 4) {
    const segX2 = buf.readUInt16BE(best.sub + 6), ends = best.sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = buf.readUInt16BE(ends + s * 2), start = buf.readUInt16BE(starts + s * 2), delta = buf.readInt16BE(deltas + s * 2), ro = buf.readUInt16BE(ranges + s * 2);
      for (let c = start; c <= end && c < 0xffff; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xffff;
        else { const at = ranges + s * 2 + ro + (c - start) * 2; g = buf.readUInt16BE(at); if (g) g = (g + delta) & 0xffff; }
        if (g) map.set(c, g);
      }
    }
  } else {
    const groups = buf.readUInt32BE(best.sub + 12);
    for (let i = 0; i < groups; i++) {
      const at = best.sub + 16 + i * 12, start = buf.readUInt32BE(at), end = buf.readUInt32BE(at + 4), g0 = buf.readUInt32BE(at + 8);
      for (let c = start; c <= end; c++) map.set(c, g0 + (c - start));
    }
  }
  return map;
}

function readWidths(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x00010000 && buf.toString("latin1", 0, 4) !== "true") throw new Error(file + " is not a plain TrueType font (collections are not supported)");
  const unitsPerEm = buf.readUInt16BE(readTable(buf, "head").offset + 18);
  const metrics = buf.readUInt16BE(readTable(buf, "hhea").offset + 34);
  const hmtx = readTable(buf, "hmtx").offset;
  const cmap = readCmap(buf);
  const advance = {};
  for (const c of WANTED) {
    const g = cmap.get(c);
    if (g === undefined) continue;
    advance[String.fromCodePoint(c)] = buf.readUInt16BE(hmtx + Math.min(g, metrics - 1) * 4);
  }
  return { unitsPerEm, advance };
}

function jsString(ch) {
  const c = ch.codePointAt(0);
  if (ch === '"') return '"\\""';
  if (ch === "\\") return '"\\\\"';
  return c < 127 ? '"' + ch + '"' : '"\\u' + c.toString(16).padStart(4, "0") + '"';
}

function table(w) {
  return "{\n" + Object.keys(w.advance).map((ch) => "    " + jsString(ch) + ": " + w.advance[ch]).join(",\n") + "\n  }";
}

function main() {
  const folder = process.argv[2] || FOLDERS.find((f) => fs.existsSync(path.join(f, "Arial.ttf")));
  if (!folder) throw new Error("Arial.ttf not found; pass the folder that holds Arial.ttf and \"Arial Bold.ttf\"");
  const regular = readWidths(path.join(folder, "Arial.ttf")), bold = readWidths(path.join(folder, fs.existsSync(path.join(folder, "Arial Bold.ttf")) ? "Arial Bold.ttf" : "arialbd.ttf"));
  if (regular.unitsPerEm !== bold.unitsPerEm) throw new Error("the two fonts use different units per em");
  const out = "// Advance widths of Arial and Arial Bold, read from the font files on the computer that ran tools/build_arial_widths.js.\n" +
    "// Used to estimate how wide a slide line is. Do not edit by hand. Advance values are font units; divide by unitsPerEm for em.\n" +
    "var ARIAL_WIDTHS = {\n  unitsPerEm: " + regular.unitsPerEm + ",\n  regular: " + table(regular) + ",\n  bold: " + table(bold) + "\n};\n";
  fs.writeFileSync(path.join(ROOT, "apps-script", "ArialWidths.js"), out);
  console.log("wrote apps-script/ArialWidths.js from " + folder + " (" + Object.keys(regular.advance).length + " characters)");
}

main();
