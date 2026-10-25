#!/usr/bin/env node
/**
 * Writes the synthetic custom templates the tests use to tests/fixtures/templates/. Each one has a different font,
 * size, colors and box, so a test can check that songs built from it keep those and none of the placeholder words.
 * Usage: node tools/make_test_templates.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { buildTemplatePro } = require("./build_default_template");

const OUT = path.join(__dirname, "..", "tests", "fixtures", "templates");

const TEMPLATES = {
  // A wide serif look: gold text on dark blue, in a bigger box set low on the slide.
  "georgia.pro": {
    idSeed: "test-georgia", name: "Georgia test", placeholder: ["Placeholder words", "second line here"],
    fontName: "Georgia-Bold", fontFamily: "Georgia", fontFace: "Bold", fontPt: 54, kerning: 1.5,
    textColor: [1, 0.85, 0.2, 1], backgroundColor: [0.05, 0.1, 0.3, 1], box: { x: 120, y: 300, width: 1680, height: 380 },
  },
  // Placeholder words typed in capitals with no All Caps setting: songs must come out in capitals too.
  "capitals-typed.pro": {
    idSeed: "test-capitals", name: "Capitals test", placeholder: ["HELLO THERE", "MY FRIEND"],
    fontName: "Verdana-Bold", fontFamily: "Verdana", fontFace: "Bold", fontPt: 70,
    textColor: [0.9, 0.95, 1, 1], box: { x: 200, y: 380, width: 1520, height: 300 },
  },
  // The CMG Sans look: All Caps setting, 63 pt, 3 pt tracking.
  "cmg-style.pro": {
    idSeed: "test-cmg", name: "CMG style test", placeholder: ["Placeholder text", "goes right here"],
    fontName: "CMGSans-MediumCAPS", fontFamily: "CMG Sans", fontFace: "", fontPt: 63, kerning: 3, capsAttribute: true,
  },
};

fs.mkdirSync(OUT, { recursive: true });
for (const [file, look] of Object.entries(TEMPLATES)) {
  fs.writeFileSync(path.join(OUT, file), buildTemplatePro(look));
  console.log("wrote tests/fixtures/templates/" + file);
}
module.exports = { TEMPLATES };
