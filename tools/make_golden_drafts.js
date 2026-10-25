#!/usr/bin/env node
/**
 * Rewrites tests/fixtures/golden/{amazing-grace,holy-holy-holy,come-thou-fount,it-is-well,selftest}.slides.txt from the
 * drafter's current output for the built-in default look. Those files are the input of the golden .pro files; the
 * golden .pro bytes themselves come from a separate reference writer, never from this script.
 * Run it only after reviewing a change to the drafter, then rebuild the golden .pro files.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { loadGas, CORE } = require("../tests/gas-loader");

const FIX = path.join(__dirname, "..", "tests", "fixtures");
const g = loadGas(CORE.concat(["Settings.js", "Control.js", "Pco.js", "Job.js", "Main.js"]));

function draftText(lyrics) {
  return g.draftSlides(lyrics).groups.map((grp) => "[" + grp.label + "]\n" + grp.slides.map((s) => s.join(" / ")).join("\n")).join("\n") + "\n";
}

for (const name of ["amazing-grace", "holy-holy-holy", "come-thou-fount", "it-is-well"]) {
  const lyrics = fs.readFileSync(path.join(FIX, "hymns", name + ".txt"), "utf8");
  fs.writeFileSync(path.join(FIX, "golden", name + ".slides.txt"), draftText(lyrics));
  fs.writeFileSync(path.join(FIX, "golden", name + ".lyrics.txt"), lyrics);
}
fs.writeFileSync(path.join(FIX, "golden", "selftest.lyrics.txt"), g.SS_SELFTEST.lyrics);
fs.writeFileSync(path.join(FIX, "golden", "selftest.slides.txt"), draftText(g.SS_SELFTEST.lyrics));
console.log("wrote golden draft files");
