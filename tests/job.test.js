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
      return { code: 200, text: JSON.stringify({ data: plans.map((p) => ({ id: p.id, attributes: { dates: p.dates, sort_date: p.sortDate } })) }) };
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

// Lyric cleaning, label case, long titles and run limits. Public-domain or made-up text only.
test("a section label in brackets or parentheses is kept as a label", () => {
  const clean = g.job_cleanLyrics("[Verse 1]\nAmazing grace how sweet the sound\n\n(Chorus)\nI once was lost\n[Organ only]\n(Repeat Chorus)\n");
  assert.strictEqual(clean, "Verse 1\nAmazing grace how sweet the sound\n\nChorus\nI once was lost\n");
  // a repeat count inside or after the brackets is not part of the label
  for (const label of ["[Chorus x2]", "(Chorus) (x2)", "[Chorus] [2x]", "[Chorus]:", "Chorus (x2)", "[CHORUS X2]"]) {
    const d = g.draftSlides(g.job_cleanLyrics(label + "\nI once was lost\n"));
    assert.strictEqual(d.groups.map((x) => x.label).join("|"), "Chorus", label);
  }
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nI once was lost\n[softly] (hold)\n"), "Verse 1\nI once was lost\n");
});

test("a lyric line that starts with the word repeat is kept; repeat instructions are dropped", () => {
  const clean = g.job_cleanLyrics("Verse 1\nJoy to the world\nRepeat the sounding joy\nRepeat\nRepeat Chorus\nRepeat x2\nRpt\nRepeat last line twice\nRepeat the chorus 2 times\nRepeat final chorus\nRepeat to fade\nRepeat 4 bars\nRepeat instrumental\n");
  assert.strictEqual(clean, "Verse 1\nJoy to the world\nRepeat the sounding joy\n");
});

test("labels typed in capitals or small letters still follow the Planning Center order", () => {
  for (const [v, c] of [["VERSE 1", "CHORUS"], ["verse 1", "chorus"], ["Verse 1", "Chorus"]]) {
    const d = g.draftSlides(v + "\nAmazing grace how sweet the sound\n\n" + c + "\nI once was lost but now am found");
    assert.strictEqual(d.groups.map((x) => x.label).join("|"), "Verse 1|Chorus", v);
    const r = g.job_sequence(["Verse 1", "Chorus 1", "Verse 1", "Chorus 1"], d.groups);
    assert.strictEqual(r.sequence.join("|"), "Verse1|Chorus|Verse1|Chorus", v);
    assert.strictEqual(r.skipped.length, 0, v);
  }
});

test("a very long title still gives a file name Planning Center can take", () => {
  const name = g.job_filename("Amazing Grace ".repeat(40), "Default");
  assert.ok(name.length <= 124 && /\.pro$/.test(name) && !/ \.pro$/.test(name), name.length + " " + name.slice(-12));
});

test("the This Sunday tab shows the plan on the service day, not an earlier rehearsal plan", () => {
  const sat = { id: "200", dates: "October 24, 2026", sortDate: "2026-10-24T22:00:00Z", songs: [{ ...GRACE_SONG, title: "Rehearsal song", arr: "a20", song: "s20" }] };
  const sun = { id: "201", dates: "October 25, 2026", sortDate: "2026-10-25T14:30:00Z", songs: [GRACE_SONG] };
  const e = env(fakePco([sat, sun]));
  g.job_run(e);
  assert.strictEqual(e._.thisSunday().map((r) => r.planId).join(","), "201");
  const e2 = env(fakePco([PLAN([GRACE_SONG])]));   // no dates to go by: the next plan, as before
  g.job_run(e2);
  assert.strictEqual(e2._.thisSunday().map((r) => r.planId).join(","), "100");
});

test("lyrics imports stop when the run is short of time, and are left for the next run", () => {
  const songs = [];
  for (let i = 1; i <= 16; i++) songs.push({ title: "No words " + i, song: "s" + i, arr: "a" + i, lyrics: "" });
  const pco = fakePco([PLAN(songs)]);
  const e = env(pco, { mode: "live" });
  let t = e.now.getTime();
  e.clock = () => new Date(t);
  pco.client.sleep = (ms) => { t += ms; };            // each wait for SongSelect really takes that long
  const s = g.job_run(e);
  const imports = pco.writes.filter((w) => /import_ccli/.test(w.url)).length;
  assert.ok(imports >= 1 && imports < 16, "imports " + imports);
  assert.match(s.report[15].note, /next run/);
  assert.strictEqual(e._.state["imp:a16"], undefined);   // not marked as tried today
});

test("a list with more pages than expected is an error, never a silently short list", () => {
  let n = 0;
  const c = { http: () => ({ code: 200, text: JSON.stringify({ data: [{ id: ++n }], links: { next: "https://api.planningcenteronline.com/services/v2/x?offset=" + n } }) }), auth: "Basic x", sleep: () => {} };
  assert.throws(() => g.pco_getAll(c, "/services/v2/x"), /more than 20 pages/);
});

test("an edit that changes nothing on the slides (an ad-lib in brackets) is not reported as changed lyrics", () => {
  const song = { ...GRACE_SONG, lyrics: GRACE + "\n(softly)\n" };
  const pco = fakePco([PLAN([song])]);
  const e = env(pco, { mode: "live", approvalRequired: false });
  assert.strictEqual(g.job_run(e).report[0].status, "attached");
  song.lyrics = GRACE + "\n(loudly)\n";
  assert.strictEqual(g.job_run(e).report[0].status, "ready");
  song.lyrics = GRACE + "\nOne more line\n";
  assert.strictEqual(g.job_run(e).report[0].status, "lyrics-changed");
});

test("two long titles that differ only after the cut get different file names", () => {
  const a = g.job_filename("Amazing Grace ".repeat(40) + "One", "Default"), b = g.job_filename("Amazing Grace ".repeat(40) + "Two", "Default");
  assert.notStrictEqual(a, b);
  assert.ok(a.length <= 124 && b.length <= 124);
  assert.strictEqual(g.job_filename("Amazing Grace", "Default"), "Amazing Grace.pro");
});

function buildsFine(lyrics) {
  const clean = g.job_cleanLyrics(lyrics), tpl = g.tpl_default(), draft = g.draftSlides(clean, tpl.layout);
  const seq = g.job_sequence([], draft.groups);
  return { clean, draft, built: g.pw_build(draft.groups, clean, { title: "T", author: "", ccli: 0, year: 0 }, seq.sequence, null, tpl.assets) };
}

test("lines with punctuation inside closing quotes or brackets still build into a file", () => {
  const r = buildsFine("Verse 1\nHe said, \u201cGo.\u201d\nHe said \u201cgo,\u201d and I went on my way rejoicing\nThen sing aloud (aloud!)\n\u2018Tis so sweet.\u2019\n");
  assert.ok(r.built.slides >= 3);
});

test("copyright and license lines pasted with the lyrics never reach the slides", () => {
  const clean = g.job_cleanLyrics("Verse 1\nAmazing grace how sweet the sound\nCCLI Song # 22025\n\u00a9 Public Domain\nCopyright 1779 Public Domain\n(c) 1779 Somebody\nFor use solely with the SongSelect\u00ae Terms of Use. All rights reserved. www.ccli.com\nCCLI License # 1234567\nWords and Music by John Newton\nAll rights reserved\n");
  assert.strictEqual(clean, "Verse 1\nAmazing grace how sweet the sound\n");
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nAll rights to the throne are His\nWords of life\n"), "Verse 1\nAll rights to the throne are His\nWords of life\n");
});

test("a verse number on a line of its own is a verse label", () => {
  const clean = g.job_cleanLyrics("1\nAmazing grace how sweet the sound\n\n2.\nTwas grace that taught my heart to fear\n\n3)\nThrough many dangers\n");
  assert.strictEqual(clean, "Verse 1\nAmazing grace how sweet the sound\n\nVerse 2\nTwas grace that taught my heart to fear\n\nVerse 3\nThrough many dangers\n");
});

test("a huge pasted line is cleaned quickly and nothing in it is lost", () => {
  const t0 = Date.now();
  const clean = g.job_cleanLyrics("Verse 1\n" + "holy ".repeat(3000) + "\nword (" + "x".repeat(30000) + "\n");
  assert.ok(Date.now() - t0 < 3000, "took " + (Date.now() - t0) + " ms");
  assert.strictEqual(clean.split(/\s+/).filter((w) => w === "holy").length, 3000);
  assert.ok(clean.split("\n").every((line) => line.length <= 1000));
});

test("a title with a broken character still makes a readable file", () => {
  const bytes = g.pb_utf8("Grace \ud800 Song");
  assert.strictEqual(Buffer.from(bytes).toString("utf8"), "Grace \ufffd Song");
  assert.strictEqual(Buffer.from(g.pb_utf8("\ud83d\ude00 ok \udc00")).toString("utf8"), "\ud83d\ude00 ok \ufffd");
});

test("control characters never reach the slide text", () => {
  assert.strictEqual(g.pw_rtfEscape("a\u0000b\u0007c\u000bd\ne\tf"), "abcd\\\ne f");
});

test("with no order from Planning Center, the order typed in the lyrics is used, repeats included", () => {
  const lyrics = "Verse 1\nAmazing grace how sweet the sound\n\nRefrain\nI once was lost but now am found\n\nVerse 2\nTwas grace that taught my heart to fear\n\nRefrain\nI once was lost but now am found\n";
  const d = g.draftSlides(g.job_cleanLyrics(lyrics));
  assert.strictEqual(d.groups.length, 3);
  assert.strictEqual(g.job_sequence([], d.groups, d.order).sequence.join("|"), "Verse1|Refrain|Verse2|Refrain");
  assert.strictEqual(g.job_sequence(["Verse 2", "Refrain"], d.groups, d.order).sequence.join("|"), "Verse2|Refrain");
});

test("a repeat count after a bracketed label is not part of the label", () => {
  for (const label of ["[Chorus] x2", "(Chorus) 2x", "[Chorus x 2]:", "[Chorus] (x2) x2"]) {
    const d = g.draftSlides(g.job_cleanLyrics("Verse 1\nAmazing grace\n" + label + "\nI once was lost\n"));
    assert.strictEqual(d.groups.map((x) => x.label).join("|"), "Verse 1|Chorus", label);
  }
});

test("a change of punctuation or capitals only is not reported as changed lyrics", () => {
  const song = { ...GRACE_SONG, lyrics: "Verse 1\nSing to the Lord a new song!\n" };
  const pco = fakePco([PLAN([song])]);
  const e = env(pco, { mode: "live", approvalRequired: false });
  assert.strictEqual(g.job_run(e).report[0].status, "attached");
  song.lyrics = "Verse 1\nSing to the Lord, a new song?\n";
  assert.strictEqual(g.job_run(e).report[0].status, "ready");
  song.lyrics = "Verse 1\nSing to the Lord an old song\n";
  assert.strictEqual(g.job_run(e).report[0].status, "lyrics-changed");
});

test("file names stay short in bytes too, and never use a name Windows keeps for itself", () => {
  const korean = g.job_filename("\uc8fc".repeat(120), "Default");
  assert.ok(Buffer.byteLength(korean, "utf8") <= 204, Buffer.byteLength(korean, "utf8"));
  assert.match(korean, /^\uc8fc+ [0-9a-f]{8}\.pro$/);
  for (const t of ["CON", "nul", "Lpt1", "Com9"]) assert.notStrictEqual(g.job_filename(t, "").toLowerCase(), t.toLowerCase() + ".pro");
  assert.strictEqual(g.job_filename("Consider", ""), "Consider.pro");
});

test("a run that is out of time leaves the remaining songs for the next run, and says so", () => {
  const songs = [];
  for (let i = 1; i <= 30; i++) songs.push({ title: "Song " + i, song: "s" + i, arr: "a" + i, lyrics: GRACE });
  const pco = fakePco([PLAN(songs)]);
  const e = env(pco);
  let t = e.now.getTime();
  e.clock = () => new Date(t);
  const http = pco.client.http;
  pco.client.http = (req) => { t += 20000; return http(req); };   // every request takes 20 seconds
  const s = g.job_run(e);
  assert.strictEqual(s.report.length, 30);
  assert.strictEqual(s.report[0].status, "pending-approval");
  assert.strictEqual(s.report[29].status, "not-reached");
  assert.match(s.report[29].note, /next run/);
  assert.ok(s.counts["not-reached"] > 0 && s.counts["pending-approval"] > 0);
});

test("a song too long to preview in full is not offered for approval", () => {
  let lyrics = "";
  for (let v = 1; v <= 60; v++) { lyrics += "Verse " + v + "\n"; for (let l = 0; l < 30; l++) lyrics += "Line " + v + " " + l + " of a very long medley of songs\n"; lyrics += "\n"; }
  const pco = fakePco([PLAN([{ ...GRACE_SONG, lyrics }])]);
  const e = env(pco, { mode: "live" });
  const s = g.job_run(e);
  assert.strictEqual(s.report[0].status, "too-long");
  assert.strictEqual(e._.approvalRows.length, 0);
  assert.strictEqual(pco.writes.length, 0);
});

test("only credit lines are dropped, never a lyric that starts with the same word", () => {
  const keep = ["Music by the river", "Words of life", "Text me when you come", "Tune my heart to sing Thy grace", "Copyright of heaven", "All rights to the throne are His"];
  assert.strictEqual(g.job_cleanLyrics("Verse 1\n" + keep.join("\n") + "\n"), "Verse 1\n" + keep.join("\n") + "\n");
  const drop = ["Words and Music by John Newton", "Words by John Newton", "Music by William Walker", "WORDS AND MUSIC BY JOHN NEWTON", "Words & Music by John Newton"];
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nAmazing grace\n" + drop.join("\n") + "\n"), "Verse 1\nAmazing grace\n");
});

test("a number is a verse label only at the start of a stanza", () => {
  assert.strictEqual(g.job_cleanLyrics("1\nAmazing grace\n\n2\nTwas grace\n"), "Verse 1\nAmazing grace\n\nVerse 2\nTwas grace\n");
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nCount with me\n7\n12\nAmen\n"), "Verse 1\nCount with me\n7\n12\nAmen\n");
});

test("a soft line break from a word processor is a line break, not a missing space", () => {
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nAmazing grace\u000bhow sweet the sound\u000cThat saved\n"), "Verse 1\nAmazing grace\nhow sweet the sound\nThat saved\n");
  assert.strictEqual(g.job_cleanLyrics("Verse 1\n\u0e2a\u0e23\u0e23\u200b\u0e40\u0e2a\u0e23\u0e34\u0e0d\n"), "Verse 1\n\u0e2a\u0e23\u0e23\u200b\u0e40\u0e2a\u0e23\u0e34\u0e0d\n");   // Thai keeps its word breaks
});

test("a very long line is reported on the song, in the real job too", () => {
  const pco = fakePco([PLAN([{ ...GRACE_SONG, lyrics: "Verse 1\n" + "holy ".repeat(300) + "\n", sequence: [] }])]);
  const e = env(pco);
  g.job_run(e);
  assert.match(e._.approvalRows[0].notes, /very long line was cut into pieces/);
});

test("when runs keep running out of time, each run starts where the last one stopped, so every song is reached", () => {
  const songs = [];
  for (let i = 1; i <= 30; i++) songs.push({ title: "Song " + i, song: "s" + i, arr: "a" + i, lyrics: GRACE });
  const pco = fakePco([PLAN(songs)]);
  const e = env(pco);
  let t = e.now.getTime();
  e.clock = () => new Date(t);
  const http = pco.client.http;
  pco.client.http = (req) => { t += 20000; return http(req); };
  const reached = new Set();
  let runs = 0;
  for (; runs < 6 && reached.size < 30; runs++) {
    e.now = new Date(t);
    g.job_run(e).report.forEach((r) => { if (r.status !== "not-reached") reached.add(r.title); });
  }
  assert.strictEqual(reached.size, 30, "reached " + reached.size + " songs in " + runs + " runs");
  pco.client.http = http;                       // a fast run reaches everything and forgets where it was
  assert.strictEqual(g.job_run(e).counts["not-reached"], undefined);
  assert.strictEqual(e._.state.cursor, null);
});

test("repeat counts with punctuation after them are still repeat counts", () => {
  assert.strictEqual(g.job_cleanLyrics("Chorus x2:\nI once was lost x2,\n2x.\n[Chorus] x2:\nBut now am found (x3).\n"), "Chorus\nI once was lost\nChorus\nBut now am found.\n");
});

test("lines that only look like credits are kept; publisher lines are dropped", () => {
  const keep = ["Words: You are holy", "Music: let heaven sing", "Text: Your love remains"];
  assert.strictEqual(g.job_cleanLyrics("Verse 1\n" + keep.join("\n") + "\n"), "Verse 1\n" + keep.join("\n") + "\n");
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nAmazing grace\nPublished by Example Music\nAdministered by Example Songs\nWords by John Newton\n"), "Verse 1\nAmazing grace\n");
});

test("a sung countdown is not a set of verse numbers", () => {
  assert.strictEqual(g.job_cleanLyrics("Bridge\nCount it down\n\n3\n2.\n1)\nShout\n"), "Bridge\nCount it down\n\n3\n2.\n1)\nShout\n");
  assert.strictEqual(g.job_cleanLyrics("1\nAmazing grace\n\n2.\nTwas grace\n"), "Verse 1\nAmazing grace\n\nVerse 2\nTwas grace\n");
});

test("a changed symbol or emoji is a change to the lyrics; unseen marks at the ends of a line are dropped", () => {
  assert.notStrictEqual(g.job_shownKey("Verse 1\nJesus \u2665\n"), g.job_shownKey("Verse 1\nJesus \u271d\n"));
  assert.notStrictEqual(g.job_shownKey("Verse 1\nJesus \ud83d\ude00\n"), g.job_shownKey("Verse 1\nJesus \ud83d\ude4f\n"));
  assert.strictEqual(g.job_shownKey("Verse 1\nSing, sing!\n"), g.job_shownKey("verse 1\nsing SING\n"));
  const word = "\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd";
  assert.strictEqual(g.job_cleanLyrics("\u200f[Verse 1]\n\u200f" + word + "\u200e\n\u200f\n"), "Verse 1\n" + word + "\n");
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nA\u0080B\u009fC\n"), "Verse 1\nABC\n");
  assert.strictEqual(g.pw_rtfEscape("a\u0085b\u009fc"), "abc");
});

test("unseen marks: dropped at the ends of a line, kept inside it, and never in the way of reading a line", () => {
  const thai = "\u0e2a\u0e23\u0e23\u200b\u0e40\u0e2a\u0e23\u0e34\u0e0d";
  assert.strictEqual(g.job_cleanLyrics("Verse 1\n" + thai + " (x2)\n\u200f" + thai + "\u200e (soft)\n"), "Verse 1\n" + thai + "\n" + thai + "\n");
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nAmazing grace\n\u061cWords by John Newton\u061c\n\u061cRepeat Chorus\u061c\n"), "Verse 1\nAmazing grace\n");
  assert.strictEqual(g.job_cleanLyrics("\u061c1\u061c\nAmazing grace\n"), "Verse 1\nAmazing grace\n");
  const d = g.draftSlides("Verse 1\n\u200eHoly holy.\u200e\nLord God Almighty\n");
  assert.strictEqual(d.groups[0].slides.length, 2);                     // the full stop still ends the sentence
  assert.strictEqual(JSON.stringify(d.groups[0].slides[0]), JSON.stringify(["Holy holy"]));
});

test("lyrics-changed ignores an apostrophe or hyphen that comes or goes; repeat counts end in ? or an ellipsis too", () => {
  assert.strictEqual(g.job_shownKey("Verse 1\nI can't, God\u2019s ever-lasting\n"), g.job_shownKey("Verse 1\nI cant Gods everlasting\n"));
  assert.notStrictEqual(g.job_shownKey("Verse 1\nI cant\n"), g.job_shownKey("Verse 1\nI can\n"));
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nSing x2?\nSing x2\u2026\n[Chorus x2]\nSing\n"), "Verse 1\nSing\nSing\nChorus\nSing\n");
});

test("a song used in two plans is listed under each plan's own title", () => {
  const shared = { ...GRACE_SONG };
  const pco = fakePco([PLAN([{ ...shared, title: "Shared rehearsal" }], "300"), PLAN([{ ...shared, title: "Shared Sunday" }], "301")]);
  const s = g.job_run(env(pco));
  assert.strictEqual(s.report.map((r) => r.title).join("|"), "Shared rehearsal|Shared Sunday");
});

test("labels like Verse 1a and Verse 1b build into a file and follow the order", () => {
  const r = buildsFine("VERSE 1A\nAmazing grace how sweet the sound\n\nVerse 1b\nI once was lost but now am found\n\nChorus\nGlory be to the Father\n");
  assert.ok(r.built.slides >= 3);
  const seq = g.job_sequence(["Verse 1a", "Chorus", "Verse 1b", "Chorus"], r.draft.groups, r.draft.order);
  assert.strictEqual(seq.sequence.join("|"), "Verse1a|Chorus|Verse1b|Chorus");
  assert.strictEqual(seq.skipped.length, 0);
});

test("a forced dry run neither uses nor moves the place where the last slow run stopped", () => {
  const songs = [];
  for (let i = 1; i <= 4; i++) songs.push({ title: "Song " + i, song: "s" + i, arr: "a" + i, lyrics: GRACE });
  const pco = fakePco([PLAN(songs)]);
  const e = env(pco);
  e.state.set("cursor", "100:a3");
  e.forced = true;
  g.job_run(e);
  assert.strictEqual(e._.state.cursor, "100:a3");
  e.forced = false;
  g.job_run(e);
  assert.strictEqual(e._.state.cursor, null);
});

test("a file someone attaches while the slides are being uploaded is never joined by a second one", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const http = pco.client.http;
  pco.client.http = (req) => {
    if (req.url.startsWith("https://upload.")) pco.attachments.a1.push({ attributes: { filename: "Hand made.pro" } });
    return http(req);
  };
  const e = env(pco, { mode: "live", approvalRequired: false });
  const first = g.job_run(e).report[0];
  assert.strictEqual(first.status, "error");
  assert.match(first.note, /appeared/);
  assert.strictEqual(pco.attachments.a1.length, 1, "only the hand-made file is there");
  pco.client.http = http;
  assert.strictEqual(g.job_run(e).report[0].status, "ready");
  assert.strictEqual(pco.attachments.a1.length, 1);
});

test("the Planning Center order is matched whatever its capitals, and labels of two words build", () => {
  const lyrics = "Verse 1\nAmazing grace how sweet the sound\n\nChorus\nGlory be to the Father\n\nFinal Chorus\nGlory be to the Father and to the Son\n";
  const r = buildsFine(lyrics);
  assert.ok(r.built.slides >= 3);
  for (const order of [["VERSE 1", "CHORUS", "FINAL CHORUS"], ["verse 1", "chorus 1", "final chorus"], ["Verse 1", "Chorus", "Final Chorus"]]) {
    const seq = g.job_sequence(order, r.draft.groups, r.draft.order);
    assert.strictEqual(seq.sequence.join("|"), "Verse1|Chorus|FinalChorus", order.join(","));
    assert.strictEqual(seq.skipped.length, 0, order.join(","));
  }
  const built = g.pw_build(r.draft.groups, r.clean, { title: "T", author: "", ccli: 0, year: 0 }, ["verse1", "CHORUS", "FinalChorus", "chorus"], null, g.tpl_default().assets);
  assert.ok(built.slides >= 3);
});

test("a credit line with both words and music is dropped whatever the capitals of the name", () => {
  assert.strictEqual(g.job_cleanLyrics("Verse 1\nAmazing grace\nWords and Music by john newton\nwords & music by JOHN NEWTON\nMusic by the river\n"), "Verse 1\nAmazing grace\nMusic by the river\n");
});

test("a record made before fingerprints were kept gets one, so a later change of punctuation is not a change", () => {
  const song = { ...GRACE_SONG, lyrics: "Verse 1\nSing to the Lord a new song\n", attachments: ["Amazing Grace.pro"] };
  const pco = fakePco([PLAN([song])]);
  const e = env(pco, { mode: "live", approvalRequired: false });
  e.state.set("att:a1", { hash: g.job_hash(song.lyrics), filename: "Amazing Grace.pro", at: "2026-10-01T00:00:00.000Z" });
  assert.strictEqual(g.job_run(e).report[0].status, "ready");
  assert.strictEqual(e._.state["att:a1"].shown, g.job_shownKey(song.lyrics));
  song.lyrics = "Verse 1\nSing to the Lord, a new song! (softly)\n";
  assert.strictEqual(g.job_run(e).report[0].status, "ready");
  song.lyrics = "Verse 1\nSing to the Lord an old song\n";
  assert.strictEqual(g.job_run(e).report[0].status, "lyrics-changed");
  assert.strictEqual(pco.writes.length, 0);
});

test("a very long word is cut between whole characters", () => {
  const word = "a".repeat(399) + "\ud83d\ude00" + "b".repeat(700);
  const clean = g.job_cleanLyrics("Verse 1\n" + word + "\n");
  assert.ok(clean.includes("\ud83d\ude00"));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(clean), "no half character");
});

test("a removed file whose record was cleared by hand goes back to waiting for approval", () => {
  const pco = fakePco([PLAN([GRACE_SONG])]);
  const e = env(pco, { mode: "live", approvalRequired: true });
  g.job_run(e);
  const key = e._.approvalRows[0].key;
  e._.approvals[key] = "APPROVED";
  assert.strictEqual(g.job_run(e).report[0].status, "attached");
  assert.strictEqual(e._.approvals[key], "ATTACHED");
  pco.attachments.a1.length = 0;                 // someone removes the file
  e.state.set("att:a1", null);                    // and clears the record, as the instructions say
  assert.strictEqual(g.job_run(e).report[0].status, "pending-approval");
  assert.strictEqual(e._.approvals[key], "PENDING");
  e._.approvals[key] = "APPROVED";
  assert.strictEqual(g.job_run(e).report[0].status, "attached");
});

test("a line stuffed with unseen characters is cleaned quickly", () => {
  const t0 = Date.now();
  const row = "a" + "\u200b".repeat(120000) + "a";
  const clean = g.job_cleanLyrics("Verse 1\n" + row + "\n" + "\u200b".repeat(120000) + "\nAmazing grace\n");
  g.job_shownKey("Verse 1\n" + row + "\n");
  g.job_longLines("Verse 1\n" + row + "\n");
  assert.ok(Date.now() - t0 < 3000, "took " + (Date.now() - t0) + " ms");
  assert.ok(/Amazing grace/.test(clean));
});

test("the place a slow run stopped is always short enough to save", () => {
  const songs = [];
  for (let i = 1; i <= 30; i++) songs.push({ title: "T".repeat(20000) + i, song: null, arr: null, lyrics: "" });
  const pco = fakePco([PLAN(songs)]);
  const e = env(pco);
  let t = e.now.getTime();
  e.clock = () => new Date((t += 60000));
  g.job_run(e);
  assert.ok(String(e._.state.cursor || "").length < 300, String(e._.state.cursor || "").length);
});
