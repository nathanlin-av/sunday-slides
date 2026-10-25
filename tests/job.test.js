// Scenario tests for the weekly job against a fake Planning Center. Every write the job makes is recorded,
// so the safety rules (dry run writes nothing, never replace slides, Sunday freeze) are checked directly.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { loadGas, CORE } = require("./gas-loader");

const g = loadGas(CORE.concat(["Pco.js", "Job.js"]));
const GRACE = fs.readFileSync(path.join(__dirname, "fixtures", "hymns", "amazing-grace.txt"), "utf8");
const ST = "100200300";
// The schedule most tests use: freeze on Sunday at 08:45 in New York time (the tests name a zone so they do not depend on the machine).
const NY = { timeZone: "America/New_York", freezeDay: 0, freezeMinutes: 8 * 60 + 45 };

function fakePco(plans) {
  const attachments = {}, writes = [], calls = [];
  let rateLimitOnce = false;
  for (const p of plans) for (const s of p.songs) if (s.arr) attachments[s.arr] = attachments[s.arr] || (s.attachments || []).map((f) => ({ attributes: { filename: f } }));
  function http(req) {
    calls.push(req.method + " " + req.url);
    if (rateLimitOnce) { rateLimitOnce = false; return { code: 429, text: "", retryAfter: "0" }; }
    if (req.method !== "GET") writes.push(req);
    const u = req.url.replace("https://api.planningcenteronline.com", "");
    let m;
    if (req.url.startsWith("https://upload.")) return { code: 200, text: JSON.stringify({ data: [{ id: "up-" + writes.length }] }) };
    if ((m = u.match(/^\/services\/v2\/service_types\/\d+\/plans\?filter=future/))) {
      return { code: 200, text: JSON.stringify({ data: plans.map((p) => ({ id: p.id, attributes: { dates: p.dates } })) }) };
    }
    if ((m = u.match(/^\/services\/v2\/service_types\/\d+\/plans\/(\d+)\/items/))) {
      const p = plans.find((x) => x.id === m[1]);
      const data = [], included = [];
      p.songs.forEach((s, i) => {
        data.push({ id: "it" + i, attributes: { title: s.title, item_type: "song", sequence: i + 1 },
          relationships: { song: { data: s.song ? { id: s.song } : null }, arrangement: { data: s.arr ? { id: s.arr } : null } } });
        if (s.song) included.push({ type: "Song", id: s.song, attributes: { title: s.title, author: "A. Writer", ccli_number: s.ccli === undefined ? 22025 : s.ccli, copyright: "1779 Public Domain" } });
        if (s.arr) included.push({ type: "Arrangement", id: s.arr, attributes: { lyrics: s.lyrics || "", sequence: s.sequence || [] } });
      });
      data.push({ id: "hdr", attributes: { title: "Announcements", item_type: "item", sequence: 0 }, relationships: {} });
      return { code: 200, text: JSON.stringify({ data, included }) };
    }
    if ((m = u.match(/^\/services\/v2\/service_types\/\d+\/plans\/(\d+)$/))) {
      const p = plans.find((x) => x.id === m[1]);
      return { code: 200, text: JSON.stringify({ data: { id: p.id, attributes: { dates: p.dates } } }) };
    }
    if ((m = u.match(/^\/services\/v2\/songs\/(\w+)\/arrangements\/(\w+)\/import_ccli$/))) {
      const song = plans.flatMap((p) => p.songs).find((x) => x.arr === m[2]);
      if (song && song.songSelect) song.lyrics = song.songSelect;
      return { code: 200, text: "" };
    }
    if ((m = u.match(/^\/services\/v2\/songs\/(\w+)\/arrangements\/(\w+)$/))) {
      const song = plans.flatMap((p) => p.songs).find((x) => x.arr === m[2]);
      return { code: 200, text: JSON.stringify({ data: { id: m[2], attributes: { lyrics: song.lyrics || "", sequence: song.sequence || [] } } }) };
    }
    if ((m = u.match(/^\/services\/v2\/songs\/(\w+)\/arrangements\/(\w+)\/attachments/))) {
      if (req.method === "POST") {
        const body = JSON.parse(req.payload);
        attachments[m[2]].push({ attributes: { filename: body.data.attributes.filename } });
        return { code: 201, text: JSON.stringify({ data: { id: "att1", attributes: body.data.attributes } }) };
      }
      return { code: 200, text: JSON.stringify({ data: attachments[m[2]] || [] }) };
    }
    return { code: 404, text: "no route " + req.method + " " + u };
  }
  return { client: { http, auth: "Basic x", sleep: () => {} }, writes, calls, attachments, rateLimit: () => { rateLimitOnce = true; } };
}

function env(pco, opts = {}) {
  const state = {}, approvals = {}, approvalRows = [], logs = [];
  let thisSunday = null;
  return {
    pco: pco.client, serviceTypeId: ST, planCount: 3, sched: opts.sched || NY, now: opts.now || new Date("2026-10-21T16:00:00Z"),
    mode: opts.mode || "dry-run", approvalRequired: opts.approvalRequired !== false, onlyPlanId: opts.onlyPlanId, template: opts.template,
    state: { get: (k) => state[k], set: (k, v) => { state[k] = v; } },
    control: {
      approvals: () => Object.assign({}, approvals, opts.approvals || {}),
      putApproval: (row) => { approvalRows.push(row); approvals[row.key] = row.status; },
      setThisSunday: (rows) => { thisSunday = rows; },
      log: (t) => logs.push(t),
    },
    _: { state, approvals, approvalRows, logs, thisSunday: () => thisSunday },
  };
}

const PLAN = (songs, id = "100", dates = "October 25, 2026") => ({ id, dates, songs });

// The approval key the job shows in the sheet for a set of songs (first run, approval required).
function pendingKey(songs) {
  const e = env(fakePco([PLAN(songs)]));
  g.job_run(e);
  return e._.approvalRows[0].key;
}
const GRACE_SONG = { title: "Amazing Grace", song: "s1", arr: "a1", lyrics: GRACE, sequence: ["Verse 1", "Verse 2", "Instrumental", "Verse 3"] };

test("song that already has slides is left alone", () => {
  const pco = fakePco([PLAN([{ ...GRACE_SONG, attachments: ["Amazing Grace.pro"] }])]);
  const s = g.job_run(env(pco, { mode: "live", approvalRequired: false }));
  assert.strictEqual(s.report[0].status, "ready");
  assert.strictEqual(pco.writes.length, 0);
});

test("song with no lyrics anywhere: one SongSelect import attempt, then reported, no slides attached", () => {
  const pco = fakePco([PLAN([{ title: "A New Hymn", song: "s2", arr: "a2", lyrics: "" }])]);
  const s = g.job_run(env(pco, { mode: "live" }));
  assert.strictEqual(s.report[0].status, "needs-lyrics");
  assert.deepStrictEqual(pco.writes.map((w) => w.url.replace(/.*\//, "")), ["import_ccli"]);
});

test("new draft waits for approval; a second run does not add a second row", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const e = env(pco, { mode: "live" });
  assert.strictEqual(g.job_run(e).report[0].status, "pending-approval");
  assert.strictEqual(g.job_run(e).report[0].status, "pending-approval");
  assert.strictEqual(e._.approvalRows.length, 1);
  assert.match(e._.approvalRows[0].preview, /\[Verse 1\]/);
  assert.strictEqual(pco.writes.length, 0);
});

test("approved + dry run: says what it would do, writes nothing", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const key = pendingKey([GRACE_SONG]);
  const s = g.job_run(env(pco, { approvals: { [key]: "APPROVED" } }));
  assert.strictEqual(s.report[0].status, "would-attach");
  assert.strictEqual(pco.writes.length, 0);
});

test("approved + live: uploads one valid .pro and attaches it, records lyrics hash", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const key = pendingKey([GRACE_SONG]);
  const e = env(pco, { mode: "live", approvals: { [key]: "APPROVED" } });
  const s = g.job_run(e);
  assert.strictEqual(s.report[0].status, "attached", s.report[0].note);
  assert.strictEqual(pco.writes.length, 2);
  const upload = Buffer.from(pco.writes[0].payload);
  const text = upload.toString("latin1");
  const start = text.indexOf("\r\n\r\n") + 4, end = text.lastIndexOf("\r\n--");
  const pro = new Uint8Array(upload.subarray(start, end));
  assert.deepStrictEqual(Array.from(g.pw_check(pro)), []);
  assert.strictEqual(e._.state["att:a1"].hash, g.job_hash(GRACE));
  assert.deepStrictEqual(pco.attachments.a1.map((a) => a.attributes.filename), ["Amazing Grace.pro"]);
  assert.strictEqual(g.job_run(e).report[0].status, "ready");
  assert.strictEqual(pco.writes.length, 2);
});

test("auto mode (no approval) attaches directly in live mode", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  assert.strictEqual(g.job_run(env(pco, { mode: "live", approvalRequired: false })).report[0].status, "attached");
});

test("Sunday freeze: nothing attached at 8:45 or later, allowed at 8:44 (EST, after DST ends 1 Nov)", () => {
  const key = pendingKey([GRACE_SONG]);
  let pco = fakePco([PLAN([GRACE_SONG])]);
  let s = g.job_run(env(pco, { mode: "live", approvals: { [key]: "APPROVED" }, now: new Date("2026-11-01T13:45:00Z") }));
  assert.strictEqual(s.frozen, true);
  assert.strictEqual(s.report[0].status, "frozen");
  assert.strictEqual(pco.writes.length, 0);
  pco = fakePco([PLAN([GRACE_SONG])]);
  s = g.job_run(env(pco, { mode: "live", approvals: { [key]: "APPROVED" }, now: new Date("2026-11-01T13:44:00Z") }));
  assert.strictEqual(s.frozen, false);
  assert.strictEqual(s.report[0].status, "attached");
});

test("freeze also holds in summer time (EDT): Sunday 25 Oct 8:45 is 12:45 UTC", () => {
  assert.strictEqual(g.job_frozen(new Date("2026-10-25T12:45:00Z"), NY), true);
  assert.strictEqual(g.job_frozen(new Date("2026-10-25T12:44:00Z"), NY), false);
  assert.strictEqual(g.job_frozen(new Date("2026-10-24T13:00:00Z"), NY), false);
});

test("lyrics changed after we attached: flagged, never replaced", () => {
  const pco = fakePco([PLAN([{ ...GRACE_SONG, attachments: ["Amazing Grace.pro"] }])]);
  const e = env(pco, { mode: "live", approvalRequired: false });
  e.state.set("att:a1", { hash: "deadbeef", filename: "Amazing Grace.pro" });
  assert.strictEqual(g.job_run(e).report[0].status, "lyrics-changed");
  assert.strictEqual(pco.writes.length, 0);
});

test("same arrangement in two plans is handled once", () => {
  const pco = fakePco([PLAN([GRACE_SONG], "100"), PLAN([GRACE_SONG], "101", "November 1, 2026")]);
  const s = g.job_run(env(pco, { mode: "live", approvalRequired: false }));
  assert.deepStrictEqual(Array.from(s.report, (r) => r.status), ["attached", "attached"]);
  assert.strictEqual(pco.writes.length, 2);
});

test("attach refuses if a .pro appeared in the meantime", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  pco.attachments.a1.push({ attributes: { filename: "Hand made.pro" } });
  assert.throws(() => g.pco_attachPro(pco.client, "s1", "a1", "x.pro", new Uint8Array([1])), /already has Hand made.pro/);
  assert.strictEqual(pco.writes.length, 0);
});

test("rate limit is retried", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  pco.rateLimit();
  assert.strictEqual(g.job_run(env(pco)).report.length, 1);
});

test("plan with no songs, song with no arrangement", () => {
  const pco = fakePco([PLAN([], "100"), PLAN([{ title: "Mystery", song: "s9", arr: null }], "101")]);
  const s = g.job_run(env(pco));
  assert.deepStrictEqual(Array.from(s.report, (r) => r.status), ["no-songs", "no-arrangement"]);
});

test("one bad song does not stop the others", () => {
  const pco = fakePco([PLAN([{ title: "Broken", song: "s5", arr: "a5", lyrics: "Verse 1\n\u0000\n" }, GRACE_SONG])]);
  const s = g.job_run(env(pco, { mode: "live", approvalRequired: false }));
  assert.strictEqual(s.report[1].status, "attached");
});

test("dry run never writes, whatever the approvals say", () => {
  const pco = fakePco([PLAN([GRACE_SONG, { title: "A New Hymn", song: "s2", arr: "a2", lyrics: "" }])]);
  g.job_run(env(pco, { approvalRequired: false }));
  assert.strictEqual(pco.writes.length, 0);
});

test("schedule: Saturday evening and Sunday morning every run; otherwise every 4 hours in the daytime", () => {
  assert.strictEqual(g.job_shouldRun(new Date("2026-10-24T21:30:00Z"), "2026-10-24T21:15:00Z", NY), true);   // Sat 5:30pm EDT
  assert.strictEqual(g.job_shouldRun(new Date("2026-10-25T11:20:00Z"), "2026-10-25T11:05:00Z", NY), true);   // Sun 7:20am EDT
  assert.strictEqual(g.job_shouldRun(new Date("2026-10-21T16:20:00Z"), "2026-10-21T15:20:00Z", NY), false);  // Wed, 1 hour since
  assert.strictEqual(g.job_shouldRun(new Date("2026-10-21T16:20:00Z"), "2026-10-21T12:00:00Z", NY), true);   // Wed, 4h20m since
  assert.strictEqual(g.job_shouldRun(new Date("2026-10-21T16:20:00Z"), null, NY), true);                     // never ran
  assert.strictEqual(g.job_shouldRun(new Date("2026-10-21T07:00:00Z"), null, NY), false);                    // Wed 3am EDT
});

test("alert text lists only songs that need a look", () => {
  const t = g.job_alertText({ report: [{ plan: "Oct 25", title: "A", status: "ready", note: "" },
    { plan: "Oct 25", title: "B", status: "needs-lyrics", note: "No lyrics." }] });
  assert.match(t, /1 song\(s\) need a look before Sunday/);
  assert.match(t, /B \(needs-lyrics\)/);
  assert.strictEqual(g.job_alertText({ report: [] }), null);
});

test("the Planning Center key is never sent to another host, and errors carry no response body", () => {
  const sent = [];
  const c = { http: (req) => { sent.push(req.url); return { code: 422, text: JSON.stringify({ errors: [{ title: "Validation Error", detail: "can't be blank" }], secret: "LEAK" }) }; }, auth: "Basic x", sleep: () => {} };
  assert.throws(() => g.pco_get(c, "https://evil.example.com/services/v2/songs"), /outside Planning Center/);
  assert.throws(() => g.pco_get(c, "http://api.planningcenteronline.com/x"), /outside Planning Center/);
  assert.strictEqual(sent.length, 0);
  assert.throws(() => g.pco_get(c, "/services/v2/songs"), (e) => /422/.test(e.message) && /can't be blank/.test(e.message) && !/LEAK/.test(e.message));
});

test("an unreadable clock stops the run instead of switching the freeze off (Apps Script path)", () => {
  const mk = (out) => loadGas(["Job.js"], { Utilities: { formatDate: () => out } });
  assert.strictEqual(mk("7 08 45").job_frozen(new Date(), NY), true);
  assert.strictEqual(mk("7 08 44").job_frozen(new Date(), NY), false);
  assert.strictEqual(mk("6 23 59").job_frozen(new Date(), NY), false);
  assert.throws(() => mk("Sun 08 45").job_frozen(new Date(), NY), /could not read/);
  assert.throws(() => mk("").job_frozen(new Date(), NY), /could not read/);
});

test("slides we attached and someone removed are never re-added", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const e = env(pco, { mode: "live", approvalRequired: false });
  e.state.set("att:a1", { hash: g.job_hash(GRACE), filename: "Amazing Grace.pro" });
  assert.strictEqual(g.job_run(e).report[0].status, "removed-by-user");
  assert.strictEqual(pco.writes.length, 0);
});

test("lyrics with labels but no lines give an error, never an empty file", () => {
  const pco = fakePco([PLAN([{ title: "Empty", song: "s3", arr: "a3", lyrics: "Verse 1\n\nChorus\n" }])]);
  const s = g.job_run(env(pco, { mode: "live", approvalRequired: false }));
  assert.strictEqual(s.report[0].status, "error");
  assert.strictEqual(pco.writes.length, 0);
});

test("a rejected draft stays rejected even when approval is switched off", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const key = pendingKey([GRACE_SONG]);
  const s = g.job_run(env(pco, { mode: "live", approvalRequired: false, approvals: { [key]: "REJECTED" } }));
  assert.strictEqual(s.report[0].status, "rejected");
  assert.strictEqual(pco.writes.length, 0);
});

test("an approval covers exactly the slides shown: a new song order needs a new approval", () => {
  const key = pendingKey([GRACE_SONG]);
  const reordered = { ...GRACE_SONG, sequence: ["Verse 3", "Verse 2", "Verse 1"] };
  const pco = fakePco([PLAN([reordered])]);
  const s = g.job_run(env(pco, { mode: "live", approvals: { [key]: "APPROVED" } }));
  assert.strictEqual(s.report[0].status, "pending-approval");
  assert.strictEqual(pco.writes.length, 0);
});

test("a failed attach leaves no record behind, so the next run can try again", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const http = pco.client.http;
  pco.client.http = (req) => (req.method === "POST" && /attachments/.test(req.url) ? { code: 500, text: "{}" } : http(req));
  const e = env(pco, { mode: "live", approvalRequired: false });
  const s = g.job_run(e);
  assert.strictEqual(s.report[0].status, "error");
  assert.strictEqual(e._.state["att:a1"], null);
});

test("the freeze is checked again right before writing", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const e = env(pco, { mode: "live", approvalRequired: false, now: new Date("2026-11-01T13:44:00Z") });
  e.clock = () => new Date("2026-11-01T13:46:00Z");
  assert.strictEqual(g.job_run(e).report[0].status, "frozen");
  assert.strictEqual(pco.writes.length, 0);
});

test("German sharp s: a draft line in capitals still finds the lyric", () => {
  const pco = fakePco([PLAN([{ title: "Grosser Gott", song: "s7", arr: "a7", lyrics: "Verse 1\nGroßer Gott, wir loben dich\nHerr, wir preisen deine Stärke\n" }])]);
  assert.strictEqual(g.job_run(env(pco, { mode: "live", approvalRequired: false })).report[0].status, "attached");
});

test("file names: accents kept readable, arrangements kept apart", () => {
  assert.strictEqual(g.job_filename("Ángel de Luz", "Acoustic"), "Angel de Luz (Acoustic).pro");
  assert.strictEqual(g.job_filename("Amazing Grace", "Default Arrangement"), "Amazing Grace.pro");
});

test("a single-plan dry run does not overwrite This Sunday", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const e = env(pco, { onlyPlanId: "100" });
  g.job_run(e);
  assert.strictEqual(e._.thisSunday(), null);
});

test("hymnal contractions are spelled out in full", () => {
  const clean = g.job_cleanLyrics("Verse 1\nO'er ev'ry land and sea\nHeav'n and nature sing\nNe'er to wand'ring go, Pow'r of His love\nEv'rything for Thee, 'tis so sweet\nWe're His, He'll stay\nO'ER ALL THE EARTH\n");
  assert.strictEqual(clean, "Verse 1\nOver every land and sea\nHeaven and nature sing\nNever to wandering go, Power of His love\nEverything for Thee, 'tis so sweet\nWe're His, He'll stay\nOVER ALL THE EARTH\n");
});

test("ad-libs, echoes, notes and repeat marks never reach the slides", () => {
  const clean = g.job_cleanLyrics("Chorus (x2)\nPraise God from whom all blessings flow (all blessings flow)\n(Amen amen)\nPraise Him all creatures here below x2\n[Organ only]\nRepeat Chorus\n\nBridge\nHallelujah (hallelujah) forever\n");
  assert.strictEqual(clean, "Chorus\nPraise God from whom all blessings flow\nPraise Him all creatures here below\n\nBridge\nHallelujah forever\n");
  const pco = fakePco([PLAN([{ title: "Doxology", song: "s8", arr: "a8", lyrics: "Verse 1\nPraise God from whom all blessings flow (all blessings flow)\n(Amen amen)\nPraise Him all creatures here below x2\n" }])]);
  const e = env(pco);
  g.job_run(e);
  const preview = e._.approvalRows[0].preview;
  assert.ok(!/\(|AMEN AMEN|X2/i.test(preview), preview);
  assert.match(preview, /Praise God/);
});

test("Alert email time is 8pm or later on the evening before the freeze day only", () => {
  assert.strictEqual(g.job_isAlertTime(new Date("2026-10-25T00:00:00Z"), NY), true);   // Sat 8:00pm EDT
  assert.strictEqual(g.job_isAlertTime(new Date("2026-10-24T23:59:00Z"), NY), false);  // Sat 7:59pm EDT
  assert.strictEqual(g.job_isAlertTime(new Date("2026-10-25T13:00:00Z"), NY), false);  // Sunday
  assert.strictEqual(g.job_dateKey(new Date("2026-10-25T03:00:00Z"), NY.timeZone), "2026-10-24"); // still Saturday in New York
});

test("a song with no lyrics: live run imports Lyrics ONLY from SongSelect, then makes slides in the same run", () => {
  const song = { title: "New Song", song: "s9", arr: "a9", lyrics: "", songSelect: GRACE };
  const pco = fakePco([PLAN([song])]);
  const e = env(pco, { mode: "live", approvalRequired: false });
  const r = g.job_run(e).report[0];
  assert.strictEqual(r.status, "attached", r.note);
  const imp = pco.writes.find((w) => /import_ccli$/.test(w.url));
  assert.deepStrictEqual(JSON.parse(imp.payload).data.attributes,
    { import_chord_chart: false, import_chord_pro: false, import_lyrics: true, import_chord_chart_options: { import_single_column: null, import_double_column: null } });
});

test("lyrics import: never in dry run, never in the freeze, never without a CCLI number, once a day", () => {
  let pco = fakePco([PLAN([{ title: "New", song: "s9", arr: "a9", lyrics: "", songSelect: GRACE }])]);
  assert.strictEqual(g.job_run(env(pco)).report[0].status, "needs-lyrics");
  assert.strictEqual(pco.writes.length, 0);
  pco = fakePco([PLAN([{ title: "New", song: "s9", arr: "a9", lyrics: "", songSelect: GRACE }])]);
  g.job_run(env(pco, { mode: "live", approvalRequired: false, now: new Date("2026-11-01T14:00:00Z") }));
  assert.strictEqual(pco.writes.length, 0);
  pco = fakePco([PLAN([{ title: "Original", song: "s9", arr: "a9", lyrics: "", ccli: null }])]);
  assert.match(g.job_run(env(pco, { mode: "live" })).report[0].note, /no CCLI number/);
  assert.strictEqual(pco.writes.length, 0);
  pco = fakePco([PLAN([{ title: "Not in SongSelect", song: "s9", arr: "a9", lyrics: "" }])]);
  const e = env(pco, { mode: "live" });
  assert.match(g.job_run(e).report[0].note, /import from SongSelect was started/);
  assert.match(g.job_run(e).report[0].note, /already tried today/);
  assert.strictEqual(pco.writes.filter((w) => /import_ccli/.test(w.url)).length, 1);
});

test("lyrics that arrive a few seconds after the import are picked up in the same run", () => {
  const song = { title: "Slow", song: "s9", arr: "a9", lyrics: "" };
  const pco = fakePco([PLAN([song])]);
  let sleeps = 0;
  pco.client.sleep = () => { if (++sleeps === 2) song.lyrics = GRACE; };
  assert.strictEqual(g.job_run(env(pco, { mode: "live", approvalRequired: false })).report[0].status, "attached");
});

test("song order: Pre-Chorus 2 finds its slides, and Chorus falls back to Down-Chorus", () => {
  const groups = [{ label: "Verse 1", slides: [["A"]] }, { label: "Pre-Chorus 2", slides: [["B"]] }, { label: "Down-Chorus", slides: [["C"]] }];
  const r = g.job_sequence(["Intro", "Verse 1", "Pre-Chorus 2", "Chorus", "Instrumental"], groups);
  assert.deepStrictEqual(Array.from(r.sequence), ["Verse1", "PreChorus2", "Down-Chorus"]);
  assert.deepStrictEqual(Array.from(r.skipped), ["Intro", "Instrumental"]);
});

// The schedule follows the settings, not a fixed day, time or time zone.
const CHICAGO_SAT = { timeZone: "America/Chicago", freezeDay: 6, freezeMinutes: 18 * 60 };   // freeze Saturday 18:00

test("the freeze can be set to another day, time and time zone", () => {
  // Saturday 14 Nov 2026, 18:00 CST is 00:00 UTC on Sunday 15 Nov.
  assert.strictEqual(g.job_frozen(new Date("2026-11-15T00:00:00Z"), CHICAGO_SAT), true);
  assert.strictEqual(g.job_frozen(new Date("2026-11-14T23:59:00Z"), CHICAGO_SAT), false);
  assert.strictEqual(g.job_frozen(new Date("2026-11-15T14:00:00Z"), CHICAGO_SAT), false);   // Sunday morning is not frozen
  // The same instant is frozen under New York's Sunday 08:45 rule only on Sunday morning, so the settings clearly matter.
  assert.strictEqual(g.job_frozen(new Date("2026-11-15T14:00:00Z"), NY), true);
});

test("schedule and alert time move with the freeze day", () => {
  // Friday 13 Nov 2026 is the evening before the Saturday freeze: every run from 17:00, alert from 20:00 (CST = UTC-6).
  assert.strictEqual(g.job_shouldRun(new Date("2026-11-13T23:15:00Z"), "2026-11-13T23:00:00Z", CHICAGO_SAT), true);    // 17:15
  assert.strictEqual(g.job_shouldRun(new Date("2026-11-13T22:45:00Z"), "2026-11-13T22:44:00Z", CHICAGO_SAT), false);   // 16:45, 1 minute since
  assert.strictEqual(g.job_isAlertTime(new Date("2026-11-14T02:00:00Z"), CHICAGO_SAT), true);    // Fri 20:00
  assert.strictEqual(g.job_isAlertTime(new Date("2026-11-14T01:59:00Z"), CHICAGO_SAT), false);   // Fri 19:59
  assert.strictEqual(g.job_isAlertTime(new Date("2026-11-15T02:00:00Z"), CHICAGO_SAT), false);   // Sat 20:00 is the freeze day
  // On the freeze day every run counts until three hours and a quarter after the freeze starts (21:15), then the daytime rule.
  assert.strictEqual(g.job_shouldRun(new Date("2026-11-15T03:10:00Z"), "2026-11-15T03:00:00Z", CHICAGO_SAT), true);    // Sat 21:10
  assert.strictEqual(g.job_dateKey(new Date("2026-11-15T03:10:00Z"), "America/Chicago"), "2026-11-14");
});

test("with no schedule given, Sunday 08:00 in the script's own time zone", () => {
  const seen = [];
  const mk = (tz) => loadGas(["Job.js"], { Session: { getScriptTimeZone: () => tz },
    Utilities: { formatDate: (_d, zone) => { seen.push(zone); return "7 08 00"; } } });
  assert.strictEqual(mk("Asia/Tokyo").job_frozen(new Date()), true);
  assert.deepStrictEqual(seen, ["Asia/Tokyo"]);
  // Outside Apps Script (no Session) the fallback is UTC, so a test never depends on the machine's zone.
  assert.strictEqual(g.job_frozen(new Date("2026-10-25T08:00:00Z")), true);
  assert.strictEqual(g.job_frozen(new Date("2026-10-25T07:59:00Z")), false);
});

test("a custom schedule in env controls the freeze inside a run", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  // 2026-11-15T00:30:00Z is Saturday 18:30 in Chicago: past the Saturday 18:00 freeze.
  const e = env(pco, { mode: "live", approvalRequired: false, sched: CHICAGO_SAT, now: new Date("2026-11-15T00:30:00Z") });
  const s = g.job_run(e);
  assert.strictEqual(s.frozen, true);
  assert.strictEqual(s.report[0].status, "frozen");
  assert.strictEqual(pco.writes.length, 0);
});

function uploadedPro(pco) {
  const upload = Buffer.from(pco.writes[0].payload), text = upload.toString("latin1");
  return new Uint8Array(upload.subarray(text.indexOf("\r\n\r\n") + 4, text.lastIndexOf("\r\n--")));
}
const TEMPLATES = path.join(__dirname, "fixtures", "templates");

test("a custom template.pro look is what gets attached, and the run says which look it used", () => {
  const tpl = g.tpl_choose({ bytes: new Uint8Array(fs.readFileSync(path.join(TEMPLATES, "georgia.pro"))) }, null, () => {});
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const e = env(pco, { mode: "live", approvalRequired: false, template: tpl });
  const s = g.job_run(e);
  assert.strictEqual(s.report[0].status, "attached", s.report[0].note);
  assert.strictEqual(s.template, "custom");
  assert.match(e._.logs[e._.logs.length - 1], /"template":"custom"/);
  const pro = uploadedPro(pco);
  assert.ok(Buffer.from(pro).includes("Georgia-Bold") && !Buffer.from(pro).includes("Arial"));
  assert.ok(!Buffer.from(pro).includes("Placeholder words"));
  assert.deepStrictEqual(Array.from(g.pw_check(pro, tpl.assets)), []);
});

test("the built-in look is attached when there is no template, and the run says so", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const e = env(pco, { mode: "live", approvalRequired: false });
  const s = g.job_run(e);
  assert.strictEqual(s.template, "default");
  assert.ok(Buffer.from(uploadedPro(pco)).includes("Arial-BoldMT"));
});

test("a broken template.pro: songs still get slides in the built-in look, and the weekly email names the problem", () => {
  const logs = [];
  const tpl = g.tpl_choose({ bytes: new Uint8Array(fs.readFileSync(path.join(TEMPLATES, "georgia.pro")).subarray(0, 400)) }, null, (l) => logs.push(l));
  assert.strictEqual(tpl.source, "fallback");
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const s = g.job_run(env(pco, { mode: "live", approvalRequired: false, template: tpl }));
  assert.strictEqual(s.report[0].status, "attached");
  assert.strictEqual(s.template, "fallback");
  assert.ok(Buffer.from(uploadedPro(pco)).includes("Arial-BoldMT"));
  assert.match(g.job_alertText(s), /template\.pro was not used/);
  assert.match(logs[0], /TEMPLATE PROBLEM/);
});

// ---- approval keys

test("an approval key starts with a letter, so Sheets can never read it as a number or a date", () => {
  const key = pendingKey([{ ...GRACE_SONG, arr: "12345" }]);
  assert.match(key, /^a12345:[0-9a-f]{8}$/);
  assert.strictEqual(g.job_approvalKey("12345", "0badf00d"), "a12345:0badf00d");
});

test("changing template.pro after an approval asks for a new approval, even when the slides look the same", () => {
  const DEFAULT_PRO = new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "templates", "default-template.pro")));
  const custom = g.tpl_choose({ bytes: DEFAULT_PRO }, null, () => {});
  assert.strictEqual(custom.source, "custom");
  const first = env(fakePco([PLAN([GRACE_SONG])]));
  g.job_run(first);
  const second = env(fakePco([PLAN([GRACE_SONG])]), { template: custom });
  g.job_run(second);
  assert.strictEqual(second._.approvalRows[0].preview, first._.approvalRows[0].preview, "same slides on screen");
  assert.notStrictEqual(second._.approvalRows[0].key, first._.approvalRows[0].key);
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const s = g.job_run(env(pco, { mode: "live", template: custom, approvals: { [first._.approvalRows[0].key]: "APPROVED" } }));
  assert.strictEqual(s.report[0].status, "pending-approval");
  assert.strictEqual(pco.writes.length, 0);
});

// ---- a failed run backs off

test("after a failed run: no retry for an hour, except every trigger from the evening before the freeze until the freeze", () => {
  const wed = new Date("2026-10-21T17:00:00Z");   // Wednesday 13:00 EDT
  const fail = (minutesAgo) => new Date(wed.getTime() - minutesAgo * 60000).toISOString();
  assert.strictEqual(g.job_shouldRun(wed, null, NY, fail(15)), false);
  assert.strictEqual(g.job_shouldRun(wed, null, NY, fail(59)), false);
  assert.strictEqual(g.job_shouldRun(wed, null, NY, fail(61)), true);
  assert.strictEqual(g.job_shouldRun(wed, null, NY, null), true);
  const sat = new Date("2026-10-24T22:30:00Z");   // Saturday 18:30 EDT, the evening before the freeze
  assert.strictEqual(g.job_shouldRun(sat, "2026-10-24T22:00:00Z", NY, new Date(sat.getTime() - 15 * 60000).toISOString()), true);
  const sunEarly = new Date("2026-10-25T11:30:00Z");   // Sunday 07:30 EDT, before the 08:45 freeze
  assert.strictEqual(g.job_shouldRun(sunEarly, null, NY, new Date(sunEarly.getTime() - 15 * 60000).toISOString()), true);
  const sunAfter = new Date("2026-10-25T13:00:00Z");   // Sunday 09:00 EDT, after the freeze (read-only): back to hourly
  assert.strictEqual(g.job_shouldRun(sunAfter, null, NY, new Date(sunAfter.getTime() - 15 * 60000).toISOString()), false);
  assert.strictEqual(g.job_shouldRun(sunAfter, null, NY, new Date(sunAfter.getTime() - 61 * 60000).toISOString()), true);
});

// ---- Planning Center client

test("a long Retry-After never makes the script sleep more than 60 seconds", () => {
  const sleeps = [];
  let calls = 0;
  const c = { http: () => (++calls === 1 ? { code: 429, text: "", retryAfter: "3600" } : { code: 200, text: "{}" }), auth: "Basic x", sleep: (ms) => sleeps.push(ms) };
  g.pco_get(c, "/services/v2/songs");
  assert.deepStrictEqual(sleeps, [60000]);
  calls = 0; sleeps.length = 0;
  c.http = () => (++calls === 1 ? { code: 429, text: "", retryAfter: "7" } : { code: 200, text: "{}" });
  g.pco_get(c, "/services/v2/songs");
  assert.deepStrictEqual(sleeps, [7000]);
});

test("the key only goes to the two Planning Center hosts: every dot in the host pattern is literal", () => {
  const sent = [];
  const c = { http: (req) => { sent.push(req.url); return { code: 200, text: "{}" }; }, auth: "Basic x", sleep: () => {} };
  for (const bad of ["https://apiXplanningcenteronline.com/x", "https://api.planningcenteronlineXcom/x", "https://api.planningcenteronline.com.evil.example/x",
    "https://xapi.planningcenteronline.com/x", "https://other.planningcenteronline.com/x"]) {
    assert.throws(() => g.pco_get(c, bad), /outside Planning Center/, bad);
  }
  assert.strictEqual(sent.length, 0);
  g.pco_get(c, "https://api.planningcenteronline.com/x");
  g.pco_request(c, "POST", "https://upload.planningcenteronline.com/v2/files", "x");
  assert.strictEqual(sent.length, 2);
});

// ---- a run cut off while attaching

const PENDING_AT = (minutesAgo) => new Date(new Date("2026-10-21T16:00:00Z").getTime() - minutesAgo * 60000).toISOString();

test("a run cut off while attaching: the record is pending and Planning Center shows no file, so a later run tries again", () => {
  const key = pendingKey([GRACE_SONG]);
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const e = env(pco, { mode: "live", approvals: { [key]: "APPROVED" } });
  e._.state["att:a1"] = { hash: g.job_hash(GRACE), filename: "Amazing Grace.pro", at: PENDING_AT(120), pending: true };
  const s = g.job_run(e);
  assert.strictEqual(s.report[0].status, "attached", s.report[0].note);
  assert.match(s.report[0].note, /earlier run was cut off/);
  assert.strictEqual(pco.writes.length, 2);
  assert.deepStrictEqual(pco.attachments.a1.map((a) => a.attributes.filename), ["Amazing Grace.pro"]);
  assert.strictEqual(e._.state["att:a1"].pending, undefined);
  assert.strictEqual(g.job_run(e).report[0].status, "ready");
  assert.strictEqual(pco.writes.length, 2, "never a second attachment");
});

test("a pending record that is still young is left alone: the earlier request may still be landing", () => {
  const key = pendingKey([GRACE_SONG]);
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const e = env(pco, { mode: "live", approvals: { [key]: "APPROVED" } });
  e._.state["att:a1"] = { hash: g.job_hash(GRACE), filename: "Amazing Grace.pro", at: PENDING_AT(10), pending: true };
  const s = g.job_run(e);
  assert.strictEqual(s.report[0].status, "attach-unconfirmed");
  assert.strictEqual(pco.writes.length, 0);
  assert.ok(e._.state["att:a1"].pending);
});

test("a pending record whose file did reach Planning Center is confirmed, and the file is never added again", () => {
  const pco = fakePco([PLAN([{ ...GRACE_SONG, attachments: ["Amazing Grace.pro"] }])]);
  const e = env(pco, { mode: "live", approvalRequired: false });
  e._.state["att:a1"] = { hash: g.job_hash(GRACE), filename: "Amazing Grace.pro", at: PENDING_AT(120), pending: true };
  assert.strictEqual(g.job_run(e).report[0].status, "ready");
  assert.strictEqual(e._.state["att:a1"].pending, undefined);
  e.pco.http = pco.client.http;
  pco.attachments.a1.length = 0;   // now someone removes it on purpose
  assert.strictEqual(g.job_run(e).report[0].status, "removed-by-user");
  assert.strictEqual(pco.writes.length, 0);
});

// ---- file names and UTF-8

test("file names keep letters and digits from any script, fold accents on Latin letters, and drop only unsafe characters", () => {
  const f = (t, a) => g.job_filename(t, a || "");
  assert.strictEqual(f("사랑해요"), "사랑해요.pro");
  assert.strictEqual(f("主啊我爱你"), "主啊我爱你.pro");
  assert.strictEqual(f("Hosanna 호산나"), "Hosanna 호산나.pro");
  assert.strictEqual(f("Señor, Mi Pastor"), "Senor, Mi Pastor.pro");
  assert.strictEqual(f("Cantaré ¡Aleluya!"), "Cantare Aleluya.pro");
  assert.strictEqual(f("Ángel de Luz", "Acoustic"), "Angel de Luz (Acoustic).pro");
  assert.strictEqual(f("Straße der Liebe"), "Straße der Liebe.pro");
  assert.strictEqual(f("Don’t Stop"), "Don't Stop.pro");
  assert.strictEqual(f("  Two   words  "), "Two words.pro");
  assert.strictEqual(f("a/b\\c:d*e?f\"g<h>i|j\u0007k\u0000l"), "abcdefghijkl.pro");
  assert.strictEqual(f("사랑".normalize("NFD")), "사랑.pro", "decomposed Hangul is put back together");
  assert.strictEqual(f("Café"), "Cafe.pro");
  assert.strictEqual(f("हे प्रभु"), "हे प्रभु.pro");
  assert.throws(() => f("\u{1F525}"), /no usable characters/);
  assert.throws(() => f("///"), /no usable characters/);
});

test("a song whose title is not in Latin letters is attached with its UTF-8 file name", () => {
  const title = "사랑해요";
  const pco = fakePco([PLAN([{ ...GRACE_SONG, title }])]);
  const s = g.job_run(env(pco, { mode: "live", approvalRequired: false }));
  assert.strictEqual(s.report[0].status, "attached", s.report[0].note);
  assert.deepStrictEqual(pco.attachments.a1.map((a) => a.attributes.filename), ["사랑해요.pro"]);
  const body = Buffer.from(pco.writes[0].payload), head = body.subarray(0, body.indexOf("\r\n\r\n")).toString("utf8");
  assert.match(head, /Content-Disposition: form-data; name="file"; filename="사랑해요\.pro"/);
  const pro = uploadedPro(pco);
  assert.deepStrictEqual(Array.from(g.pw_check(pro)), []);
  assert.ok(Buffer.from(pro).includes(Buffer.from(title, "utf8")), "the presentation name is UTF-8 too");
});
