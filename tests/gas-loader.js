// Loads Apps Script source files into a Node vm context, the way Apps Script concatenates them into one
// global scope. Tests use this so the exact files that are pushed with clasp are the files under test.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const GAS_DIR = path.join(__dirname, "..", "apps-script");

function loadGas(files, extraGlobals = {}) {
  const ctx = vm.createContext({ console, Uint8Array, TextEncoder, TextDecoder, ...extraGlobals });
  for (const f of files) {
    const src = fs.readFileSync(path.join(GAS_DIR, f), "utf8");
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}

// The files every test of the slide-making code needs, in the order Apps Script would show them.
const CORE = ["Assets.js", "Proto.js", "ProWriter.js", "CmgWidths.js", "ArialWidths.js", "Layout.js", "Drafter.js", "Template.js"];

module.exports = { loadGas, GAS_DIR, CORE };
