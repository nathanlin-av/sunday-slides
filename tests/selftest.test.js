// runSelfTest() in your own Apps Script project builds this same song with fixed IDs and compares its SHA-256 with
// SS_SELFTEST_SHA256. This file proves that constant is right: Node builds the same bytes as the committed reference
// file, so a match in Apps Script means the code behaves in Google's runtime exactly as it does in these tests.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadGas, CORE } = require("./gas-loader");

const GOLD = fs.readFileSync(path.join(__dirname, "fixtures", "golden", "selftest.pro"));
const FILES = CORE.concat(["Settings.js", "Control.js", "Pco.js", "Job.js", "Main.js"]);
const g = loadGas(FILES);

test("self-test builds, passes the writer's own check, and has at least one slide per sung line", () => {
  const r = g.ss_selftest();
  assert.ok(r.slides >= 4, "expected at least one slide per sung line");
  assert.deepStrictEqual(Array.from(g.pw_check(g.pb_b64decode(r.base64))), []);
});

test("self-test bytes equal the committed reference file, and SS_SELFTEST_SHA256 is its hash", () => {
  const bytes = Buffer.from(g.pb_b64decode(g.ss_selftest().base64));
  assert.ok(bytes.equals(GOLD), "self-test bytes differ from tests/fixtures/golden/selftest.pro");
  assert.strictEqual(g.SS_SELFTEST_SHA256, crypto.createHash("sha256").update(GOLD).digest("hex"));
});

test("runSelfTest passes when the hash matches and throws when it does not (Apps Script path)", () => {
  const utilities = {
    DigestAlgorithm: { SHA_256: "sha256" },
    computeDigest: (_alg, bytes) => Array.from(crypto.createHash("sha256").update(Buffer.from(bytes.map((b) => b & 0xff))).digest(), (b) => (b > 127 ? b - 256 : b)),
  };
  const logs = [];
  const ok = loadGas(FILES, { Utilities: utilities, Logger: { log: (t) => logs.push(t) } });
  const res = ok.runSelfTest();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sha256, ok.SS_SELFTEST_SHA256);
  assert.match(logs[0], /Self-test passed/);
  const bad = loadGas(FILES, { Utilities: utilities, Logger: { log() {} } });
  bad.SS_SELFTEST_SHA256 = "0".repeat(64);
  assert.throws(() => bad.runSelfTest(), /bytes differ from the reference/);
});
