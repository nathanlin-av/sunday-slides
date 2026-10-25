/**
 * Minimal protobuf wire codec for the .pro writer. It works one message level at a time and keeps every field's
 * original bytes, so anything the writer does not touch is copied exactly. No schema: callers name fields by
 * number (the numbers come from PP_ASSETS, generated from the ProPresenter schema).
 */

function pb_readVarint(buf, pos) {
  var result = 0, mul = 1, b;
  do {
    if (pos >= buf.length) throw new Error("protobuf: varint runs past the end");
    b = buf[pos++];
    result += (b & 0x7f) * mul;
    mul *= 128;
    if (mul > Math.pow(2, 70)) throw new Error("protobuf: varint too long");
  } while (b & 0x80);
  return { value: result, pos: pos };
}

function pb_varint(n) {
  if (n < 0 || n > Number.MAX_SAFE_INTEGER || Math.floor(n) !== n) throw new Error("protobuf: bad varint " + n);
  var out = [];
  do {
    var b = n % 128;
    n = Math.floor(n / 128);
    out.push(n > 0 ? b | 0x80 : b);
  } while (n > 0);
  return new Uint8Array(out);
}

function pb_concat(parts) {
  var len = 0, i;
  for (i = 0; i < parts.length; i++) len += parts[i].length;
  var out = new Uint8Array(len), at = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
  return out;
}

/** One level of a message: [{ n: fieldNumber, wt: wireType, tag: Uint8Array, body: Uint8Array }]. */
function pb_fields(buf) {
  var fields = [], pos = 0;
  while (pos < buf.length) {
    var start = pos, t = pb_readVarint(buf, pos);
    pos = t.pos;
    var n = Math.floor(t.value / 8), wt = t.value % 8, bodyStart = pos;
    if (n < 1) throw new Error("protobuf: field number 0");
    if (wt === 0) pos = pb_readVarint(buf, pos).pos;
    else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else if (wt === 2) {
      var l = pb_readVarint(buf, pos);
      bodyStart = l.pos;
      pos = l.pos + l.value;
    } else throw new Error("protobuf: unsupported wire type " + wt);
    if (pos > buf.length) throw new Error("protobuf: field " + n + " runs past the end");
    fields.push({ n: n, wt: wt, tag: buf.subarray(start, wt === 2 ? bodyStart : t.pos), body: buf.subarray(bodyStart, pos) });
  }
  return fields;
}

/** Encode fields back. A field whose body changed gets a fresh tag and length; untouched ones keep their bytes. */
function pb_encode(fields) {
  var parts = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.tag) parts.push(f.tag);
    else {
      parts.push(pb_varint(f.n * 8 + f.wt));
      if (f.wt === 2) parts.push(pb_varint(f.body.length));
    }
    parts.push(f.body);
  }
  return pb_concat(parts);
}

function pb_bytesField(n, body) { return { n: n, wt: 2, tag: null, body: body }; }
function pb_varintField(n, value) { return { n: n, wt: 0, tag: null, body: pb_varint(value) }; }

/** proto3 semantics: default values (empty, 0, false) are not written. */
function pb_stringField(n, s) { return s ? pb_bytesField(n, pb_utf8(s)) : null; }
function pb_uintField(n, v) { return v ? pb_varintField(n, v) : null; }

function pb_message(fields) {
  var kept = [];
  for (var i = 0; i < fields.length; i++) if (fields[i]) kept.push(fields[i]);
  return pb_encode(kept);
}

/** Replace the body of the k-th occurrence of field n (k counts from 0). Returns a new fields array. */
function pb_withBody(fields, n, k, body) {
  var seen = -1;
  var out = fields.map(function (f) {
    if (f.n !== n) return f;
    seen++;
    return seen === k ? { n: f.n, wt: f.wt, tag: null, body: body } : f;
  });
  if (seen < k) throw new Error("protobuf: no occurrence " + k + " of field " + n);
  return out;
}

function pb_first(fields, n) {
  for (var i = 0; i < fields.length; i++) if (fields[i].n === n) return fields[i];
  return null;
}

/** The k-th occurrence (from 0) of field n, or null. */
function pb_nth(fields, n, k) {
  var seen = -1;
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].n === n && ++seen === k) return fields[i];
  }
  return null;
}

/** A path step is a field number (its first occurrence) or [field number, k] (its k-th occurrence, from 0). */
function pb_step(step) { return typeof step === "number" ? { n: step, k: 0 } : { n: step[0], k: step[1] }; }

/** Rewrite the message at a path of steps (see pb_step) with fn(bytes) -> bytes. */
function pb_editPath(buf, path, fn) {
  if (!path.length) return fn(buf);
  var s = pb_step(path[0]), fields = pb_fields(buf), f = pb_nth(fields, s.n, s.k);
  if (!f || f.wt !== 2) throw new Error("protobuf: path field " + s.n + " missing");
  return pb_encode(pb_withBody(fields, s.n, s.k, pb_editPath(f.body, path.slice(1), fn)));
}

/** The bytes of the message at a path of steps. */
function pb_atPath(buf, path) {
  for (var i = 0; i < path.length; i++) {
    var s = pb_step(path[i]), f = pb_nth(pb_fields(buf), s.n, s.k);
    if (!f) throw new Error("protobuf: path field " + s.n + " missing");
    buf = f.body;
  }
  return buf;
}

/** A double (fixed 64) or float (fixed 32) field's value. */
function pb_readDouble(body) {
  if (body.length !== 8) throw new Error("protobuf: not a double");
  return new DataView(new Uint8Array(body).buffer).getFloat64(0, true);
}
function pb_readFloat(body) {
  if (body.length !== 4) throw new Error("protobuf: not a float");
  return new DataView(new Uint8Array(body).buffer).getFloat32(0, true);
}

function pb_utf8(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function pb_utf8Decode(bytes) {
  var s = "", i = 0;
  while (i < bytes.length) {
    var b = bytes[i++], cp;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) { cp = ((b & 15) << 12) | ((bytes[i] & 63) << 6) | (bytes[i + 1] & 63); i += 2; }
    else { cp = ((b & 7) << 18) | ((bytes[i] & 63) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
    s += cp > 0xffff ? String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 1023)) : String.fromCharCode(cp);
  }
  return s;
}

function pb_latin1(s) {
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c > 255) throw new Error("protobuf: character outside latin-1 in RTF");
    out[i] = c;
  }
  return out;
}

function pb_latin1Decode(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

var PB_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function pb_b64decode(s) {
  s = s.replace(/=+$/, "");
  var out = new Uint8Array(Math.floor(s.length * 3 / 4)), bits = 0, val = 0, at = 0;
  for (var i = 0; i < s.length; i++) {
    var v = PB_B64.indexOf(s.charAt(i));
    if (v < 0) throw new Error("base64: bad character");
    val = ((val << 6) | v) & 0xffffff; bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (val >> bits) & 0xff; }
  }
  return out.subarray(0, at);
}

function pb_b64encode(bytes) {
  var out = "", i;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += PB_B64.charAt(n >> 18) + PB_B64.charAt((n >> 12) & 63) + PB_B64.charAt((n >> 6) & 63) + PB_B64.charAt(n & 63);
  }
  var rest = bytes.length - i;
  if (rest === 1) { var a = bytes[i] << 16; out += PB_B64.charAt(a >> 18) + PB_B64.charAt((a >> 12) & 63) + "=="; }
  else if (rest === 2) { var b = (bytes[i] << 16) | (bytes[i + 1] << 8); out += PB_B64.charAt(b >> 18) + PB_B64.charAt((b >> 12) & 63) + PB_B64.charAt((b >> 6) & 63) + "="; }
  return out;
}

/** Positions of every occurrence of an ASCII string inside bytes. */
function pb_findAll(bytes, ascii) {
  var hits = [], n = ascii.length;
  outer: for (var i = 0; i + n <= bytes.length; i++) {
    for (var j = 0; j < n; j++) if (bytes[i + j] !== ascii.charCodeAt(j)) continue outer;
    hits.push(i);
  }
  return hits;
}
