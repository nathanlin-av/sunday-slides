/**
 * Planning Center Services client. Pure logic over an injected transport, so the same code runs in Apps Script
 * (UrlFetchApp) and in Node tests (a fake, or curl for a real dry run).
 * client = { http: function(req) -> { code, text, retryAfter }, auth: "Basic ...", sleep: function(ms) }
 * req = { method, url, auth, contentType, payload } where payload is a string, Uint8Array or null.
 */

var PCO_API = "https://api.planningcenteronline.com";
var PCO_UPLOAD = "https://upload.planningcenteronline.com/v2/files";

var PCO_MAX_WAIT_SECONDS = 60;   // never sleep longer than this for one Retry-After

var PCO_HOSTS = /^https:\/\/(api|upload)\.planningcenteronline\.com\//;

function pco_errorText(text) {
  try {
    var e = JSON.parse(text).errors || [];
    return e.map(function (x) { return [x.title, x.detail].filter(Boolean).join(": "); }).join("; ").slice(0, 200);
  } catch (ignored) { return "(no details)"; }
}

function pco_request(c, method, url, payload, contentType) {
  if (url.charAt(0) === "/") url = PCO_API + url;
  if (!PCO_HOSTS.test(url)) throw new Error("refusing to send the Planning Center key outside Planning Center");
  for (var attempt = 0; attempt < 5; attempt++) {
    var r = c.http({ method: method, url: url, auth: c.auth, payload: payload || null,
      contentType: payload ? (contentType || "application/json") : null });
    if (r.code === 429 && attempt < 4) { c.sleep(1000 * Math.min(PCO_MAX_WAIT_SECONDS, parseInt(r.retryAfter || "5", 10) || 5)); continue; }
    if (r.code < 200 || r.code >= 300) throw new Error("Planning Center said " + r.code + " to " + method + " " + url.split("?")[0].replace(PCO_HOSTS, "/") + ": " + pco_errorText(r.text));
    return r.text ? JSON.parse(r.text) : {};
  }
  throw new Error("Planning Center kept rate-limiting " + url);
}

function pco_get(c, path) { return pco_request(c, "GET", path); }

function pco_getAll(c, path) {
  var out = [], included = [], url = path;
  for (var page = 0; url && page < 20; page++) {
    var r = pco_get(c, url);
    out = out.concat(r.data || []);
    included = included.concat(r.included || []);
    url = r.links && r.links.next ? r.links.next : null;
  }
  return { data: out, included: included };
}

function pco_post(c, path, data) { return pco_request(c, "POST", path, JSON.stringify({ data: data })); }

/** Next `count` dated plans of a service type, soonest first. */
function pco_upcomingPlans(c, serviceTypeId, count) {
  return pco_get(c, "/services/v2/service_types/" + serviceTypeId + "/plans?filter=future&order=sort_date&per_page=" + count).data || [];
}

function pco_plan(c, serviceTypeId, planId) {
  return pco_get(c, "/services/v2/service_types/" + serviceTypeId + "/plans/" + planId).data;
}

/** Song items of a plan, in plan order, with the song and arrangement records attached. */
function pco_planSongs(c, serviceTypeId, planId) {
  var r = pco_getAll(c, "/services/v2/service_types/" + serviceTypeId + "/plans/" + planId + "/items?include=song,arrangement&per_page=100");
  var inc = {};
  r.included.forEach(function (x) { inc[x.type + ":" + x.id] = x; });
  var items = r.data.slice().sort(function (a, b) { return (a.attributes.sequence || 0) - (b.attributes.sequence || 0); });
  return items.filter(function (it) { return it.attributes.item_type === "song"; }).map(function (it) {
    var rel = it.relationships || {};
    var sid = rel.song && rel.song.data ? rel.song.data.id : null;
    var aid = rel.arrangement && rel.arrangement.data ? rel.arrangement.data.id : null;
    return { itemId: it.id, title: it.attributes.title, songId: sid, arrangementId: aid,
      song: sid ? (inc["Song:" + sid] || null) : null, arrangement: aid ? (inc["Arrangement:" + aid] || null) : null };
  });
}

function pco_attachments(c, songId, arrangementId) {
  return pco_getAll(c, "/services/v2/songs/" + songId + "/arrangements/" + arrangementId + "/attachments?per_page=100").data;
}

/**
 * Planning Center's own "Import from SongSelect" with Lyrics ONLY (the same request its button sends).
 * Chord sheets are switched off by name: each ChordSheet import counts against the church's yearly allowance.
 */
var PCO_LYRICS_ONLY = { data: { attributes: { import_chord_chart: false, import_chord_pro: false, import_lyrics: true,
  import_chord_chart_options: { import_single_column: null, import_double_column: null } } } };

function pco_importLyrics(c, songId, arrangementId) {
  return pco_request(c, "POST", "/services/v2/songs/" + songId + "/arrangements/" + arrangementId + "/import_ccli",
    JSON.stringify(PCO_LYRICS_ONLY));
}

function pco_arrangement(c, songId, arrangementId) {
  return pco_get(c, "/services/v2/songs/" + songId + "/arrangements/" + arrangementId).data;
}

function pco_upload(c, filename, bytes) {
  var boundary = "ss" + pw_newIdDefault().replace(/-/g, "");
  var head = pb_utf8("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" +
    filename.replace(/["\r\n]/g, "") + "\"\r\nContent-Type: application/octet-stream\r\n\r\n");
  var body = pb_concat([head, bytes, pb_utf8("\r\n--" + boundary + "--\r\n")]);
  var r = pco_request(c, "POST", PCO_UPLOAD, body, "multipart/form-data; boundary=" + boundary);
  if (!r.data || !r.data[0] || !r.data[0].id) throw new Error("upload returned no identifier");
  return r.data[0].id;
}

/** Attach a .pro to an arrangement. Refuses when ANY .pro is already there: never replace slides. */
function pco_attachPro(c, songId, arrangementId, filename, bytes) {
  var existing = pco_attachments(c, songId, arrangementId).filter(function (a) { return /\.pro\d?$/i.test(a.attributes.filename || ""); });
  if (existing.length) throw new Error("arrangement " + arrangementId + " already has " + existing[0].attributes.filename + "; not adding another");
  var ident = pco_upload(c, filename, bytes);
  return pco_post(c, "/services/v2/songs/" + songId + "/arrangements/" + arrangementId + "/attachments",
    { type: "Attachment", attributes: { file_upload_identifier: ident, filename: filename } }).data;
}
