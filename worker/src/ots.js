// OpenTimestamps detached proofs (0.70.0). Binary layout matches python-opentimestamps
// (DetachedTimestampFile + Timestamp + PendingAttestation + BitcoinBlockHeaderAttestation).
// Calendars are the public pools only. Upgrade GETs stay on that allowlist so a proof cannot
// point this Worker at an arbitrary host. No Bitcoin node: "confirmed" means the proof bytes
// contain a Bitcoin block-header attestation, which `ots verify` checks against Bitcoin.

export const OTS_HEADER = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73,
  0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const TAG_PENDING = hexToBytes("83dfe30d2ef90c8e");
const TAG_BITCOIN = hexToBytes("0588960d73d71901");
const OP_SHA256 = 0x08;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;
const MAX_MSG = 4096;
const MAX_PAYLOAD = 8192;

// Public calendars. a.pool and b.pool are the OpenTimestamps project pools (free, no key).
// The other two are well-known public calendars an operator can name in ANCHOR_CALENDARS.
export const DEFAULT_CALENDARS = ["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org"];
const CALENDAR_HOSTS = new Set([
  "a.pool.opentimestamps.org",
  "b.pool.opentimestamps.org",
  "a.pool.eternitywall.com",
  "ots.btc.catallaxy.com",
]);

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of bytes. Sync so Merkle construction and OTS op application stay simple. */
export function sha256(msg) {
  const src = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
  const bitLen = src.length * 8;
  const padLen = ((src.length + 9 + 63) >> 6) << 6;
  const p = new Uint8Array(padLen);
  p.set(src);
  p[src.length] = 0x80;
  const view = new DataView(p.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 4294967296), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const T1 = (h + S1 + ch + K256[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const T2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + T1) >>> 0; d = c; c = b; b = a; a = (T1 + T2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
  return out;
}

export function hex(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, "0");
  return s;
}
export function hexToBytes(s) {
  if (typeof s !== "string" || !/^[0-9a-fA-F]*$/.test(s) || s.length % 2) return null;
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return o;
}
export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const o = new Uint8Array(n);
  let i = 0;
  for (const p of parts) { o.set(p, i); i += p.length; }
  return o;
}
function utf8(s) { return new TextEncoder().encode(s); }
function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function varuint(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("bad varuint");
  const o = [];
  if (n === 0) return new Uint8Array([0]);
  while (n > 0) {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    o.push(b);
  }
  return new Uint8Array(o);
}
function varbytes(b) { return concat([varuint(b.length), b]); }

class W {
  constructor() { this.parts = []; }
  u8(n) { this.parts.push(new Uint8Array([n])); }
  bytes(b) { this.parts.push(b); }
  done() { return concat(this.parts); }
}
class R {
  constructor(buf) { this.b = buf; this.i = 0; }
  need(n) { if (this.i + n > this.b.length) throw new Error("truncated ots"); }
  u8() { this.need(1); return this.b[this.i++]; }
  bytes(n) { this.need(n); const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
  varuint() {
    let value = 0, shift = 0;
    for (let k = 0; k < 9; k++) {
      const b = this.u8();
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
    }
    throw new Error("varuint too long");
  }
  varbytes(max) {
    const n = this.varuint();
    if (n > max) throw new Error("varbytes too long");
    return this.bytes(n);
  }
  rest() { return this.i < this.b.length; }
}

function writeAttestation(w, a) {
  if (a.kind === "pending") {
    w.bytes(TAG_PENDING);
    w.bytes(varbytes(varbytes(utf8(a.uri))));
  } else if (a.kind === "bitcoin") {
    w.bytes(TAG_BITCOIN);
    w.bytes(varbytes(varuint(a.height)));
  } else {
    w.bytes(a.tag);
    w.bytes(varbytes(a.payload));
  }
}
function readAttestation(r) {
  const tag = r.bytes(8);
  const payload = r.varbytes(MAX_PAYLOAD);
  const pr = new R(payload);
  let att;
  if (bytesEq(tag, TAG_PENDING)) {
    const uriB = pr.varbytes(1000);
    const uri = new TextDecoder().decode(uriB);
    if (!/^[\x21-\x7e]+$/.test(uri)) throw new Error("bad pending uri");
    att = { kind: "pending", uri };
  } else if (bytesEq(tag, TAG_BITCOIN)) {
    const height = pr.varuint();
    if (height > 0xffffffff) throw new Error("block height");
    att = { kind: "bitcoin", height };
  } else {
    att = { kind: "unknown", tag: new Uint8Array(tag), payload: new Uint8Array(payload) };
    return att;
  }
  if (pr.rest()) throw new Error("attestation trailing");
  return att;
}

function opTag(op) { return op.op === "sha256" ? OP_SHA256 : op.op === "append" ? OP_APPEND : OP_PREPEND; }
function applyOp(op, msg) {
  if (msg.length > MAX_MSG) throw new Error("msg too long");
  if (op.op === "sha256") return sha256(msg);
  if (op.op === "append") return concat([msg, op.arg]);
  if (op.op === "prepend") return concat([op.arg, msg]);
  throw new Error("op");
}
function cmpOp(a, b) {
  const t = opTag(a) - opTag(b);
  if (t) return t;
  if (a.op === "sha256") return 0;
  return cmpBytes(a.arg, b.arg);
}
function cmpAtt(a, b) {
  const ta = a.kind === "bitcoin" ? TAG_BITCOIN : a.kind === "pending" ? TAG_PENDING : a.tag;
  const tb = b.kind === "bitcoin" ? TAG_BITCOIN : b.kind === "pending" ? TAG_PENDING : b.tag;
  const c = cmpBytes(ta, tb);
  if (c) return c;
  if (a.kind === "pending") return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
  if (a.kind === "bitcoin") return a.height - b.height;
  return cmpBytes(a.payload, b.payload);
}

export function serializeTimestamp(ts) {
  const atts = ts.attestations.slice().sort(cmpAtt);
  const ops = ts.ops.slice().sort((x, y) => cmpOp(x.op, y.op));
  if (!atts.length && !ops.length) throw new Error("empty timestamp");
  const w = new W();
  if (atts.length > 1) {
    for (let i = 0; i < atts.length - 1; i++) { w.u8(0xff); w.u8(0x00); writeAttestation(w, atts[i]); }
  }
  if (!ops.length) { w.u8(0x00); writeAttestation(w, atts[atts.length - 1]); }
  else {
    if (atts.length) { w.u8(0xff); w.u8(0x00); writeAttestation(w, atts[atts.length - 1]); }
    for (let i = 0; i < ops.length - 1; i++) {
      w.u8(0xff);
      writeOp(w, ops[i].op);
      w.bytes(serializeTimestamp(ops[i].child));
    }
    writeOp(w, ops[ops.length - 1].op);
    w.bytes(serializeTimestamp(ops[ops.length - 1].child));
  }
  return w.done();
}
function writeOp(w, op) {
  w.u8(opTag(op));
  if (op.op !== "sha256") w.bytes(varbytes(op.arg));
}

function parseTs(r, msg, depth) {
  if (depth <= 0) throw new Error("ots depth");
  if (msg.length > MAX_MSG) throw new Error("msg too long");
  const ts = { msg: new Uint8Array(msg), attestations: [], ops: [] };
  const seen = new Set();
  const edge = (tag) => {
    if (tag === 0x00) { ts.attestations.push(readAttestation(r)); return; }
    let op;
    if (tag === OP_SHA256) op = { op: "sha256" };
    else if (tag === OP_APPEND || tag === OP_PREPEND) {
      const arg = r.varbytes(MAX_MSG);
      if (!arg.length) throw new Error("empty op arg");
      op = { op: tag === OP_APPEND ? "append" : "prepend", arg: new Uint8Array(arg) };
    } else throw new Error("unknown op " + tag);
    const key = tag + ":" + (op.arg ? hex(op.arg) : "");
    if (seen.has(key)) throw new Error("repeated op");
    seen.add(key);
    const child = parseTs(r, applyOp(op, ts.msg), depth - 1);
    ts.ops.push({ op, child });
  };
  let tag = r.u8();
  while (tag === 0xff) { edge(r.u8()); tag = r.u8(); }
  edge(tag);
  return ts;
}
export function parseTimestamp(bytes, initialMsg) {
  const r = new R(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const ts = parseTs(r, initialMsg, 256);
  if (r.rest()) throw new Error("trailing ots");
  return ts;
}

/** Detached .ots of a file whose SHA-256 is `digest` (32 bytes). */
export function serializeDetached(digest, timestamp) {
  if (digest.length !== 32) throw new Error("digest");
  if (!bytesEq(timestamp.msg, digest)) throw new Error("timestamp msg is not the file digest");
  const w = new W();
  w.bytes(OTS_HEADER);
  w.u8(1);
  w.u8(OP_SHA256);
  w.bytes(digest);
  w.bytes(serializeTimestamp(timestamp));
  return w.done();
}
export function parseDetached(bytes) {
  const r = new R(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const magic = r.bytes(OTS_HEADER.length);
  if (!bytesEq(magic, OTS_HEADER)) throw new Error("bad ots magic");
  if (r.u8() !== 1) throw new Error("ots version");
  if (r.u8() !== OP_SHA256) throw new Error("ots file hash");
  const digest = new Uint8Array(r.bytes(32));
  const ts = parseTs(r, digest, 256);
  if (r.rest()) throw new Error("trailing ots");
  return { digest, timestamp: ts };
}

export function walkAttestations(ts, out = []) {
  for (const a of ts.attestations) out.push({ msg: ts.msg, att: a });
  for (const edge of ts.ops) walkAttestations(edge.child, out);
  return out;
}
export function bitcoinHeight(ts) {
  const hs = walkAttestations(ts).filter((x) => x.att.kind === "bitcoin").map((x) => x.att.height);
  return hs.length ? Math.min(...hs) : null;
}
export function hasBitcoin(ts) { return bitcoinHeight(ts) != null; }

function sameOp(a, b) { return cmpOp(a, b) === 0 && a.op === b.op; }
function merge(dst, src) {
  if (!bytesEq(dst.msg, src.msg)) throw new Error("merge msg");
  for (const a of src.attestations) {
    if (!dst.attestations.some((x) => cmpAtt(x, a) === 0 && x.kind === a.kind)) dst.attestations.push(a);
  }
  for (const edge of src.ops) {
    const have = dst.ops.find((e) => sameOp(e.op, edge.op));
    if (have) merge(have.child, edge.child);
    else dst.ops.push(edge);
  }
}

/** A calendar /digest body: append a nonce, SHA-256, pending attestation of `uri`. */
export function pendingCalendarBody(digest, uri, nonce) {
  const appended = concat([digest, nonce]);
  const hashed = sha256(appended);
  const leaf = { msg: hashed, attestations: [{ kind: "pending", uri }], ops: [] };
  const mid = { msg: appended, attestations: [], ops: [{ op: { op: "sha256" }, child: leaf }] };
  const root = { msg: new Uint8Array(digest), attestations: [], ops: [{ op: { op: "append", arg: nonce }, child: mid }] };
  return serializeTimestamp(root);
}
/** Upgrade body: a Bitcoin block-header attestation of `msg` at `height`. */
export function bitcoinUpgradeBody(msg, height) {
  return serializeTimestamp({ msg: new Uint8Array(msg), attestations: [{ kind: "bitcoin", height }], ops: [] });
}

export function allowedCalendar(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash && (u.pathname === "/" || u.pathname === "") && CALENDAR_HOSTS.has(u.hostname);
  } catch (_) { return false; }
}
export function calendarList(env) {
  const raw = String((env && env.ANCHOR_CALENDARS) || "").trim();
  const list = (raw ? raw.split(",") : DEFAULT_CALENDARS).map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const out = [];
  for (const u of list) if (allowedCalendar(u) && !out.includes(u)) out.push(u);
  return out.length ? out : DEFAULT_CALENDARS.slice();
}

async function readBody(res) { return new Uint8Array(await res.arrayBuffer()); }

/**
 * POST each calendar /digest with the 32-byte file digest. Returns a merged timestamp of that digest,
 * or null when every calendar fails. `fetchImpl` is required so tests never touch the network.
 */
export async function submitDigest(digest, { fetchImpl, calendars, timeoutMs = 8000 }) {
  if (!fetchImpl) throw new Error("fetchImpl required");
  if (digest.length !== 32) throw new Error("digest");
  const root = { msg: new Uint8Array(digest), attestations: [], ops: [] };
  const used = [];
  for (const base of calendars) {
    if (!allowedCalendar(base)) continue;
    try {
      const res = await fetchImpl(base + "/digest", {
        method: "POST",
        headers: { accept: "application/vnd.opentimestamps.v1", "content-type": "application/octet-stream", "user-agent": "402xagent-anchor/0.70.0" },
        body: digest,
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (!res || !res.ok) continue;
      const ts = parseTimestamp(await readBody(res), digest);
      const pend = walkAttestations(ts).filter((x) => x.att.kind === "pending");
      if (!pend.length || pend.some((x) => !allowedCalendar(x.att.uri))) continue;
      if (!root.ops.length && !root.attestations.length) {
        root.attestations = ts.attestations;
        root.ops = ts.ops;
      } else merge(root, ts);
      used.push(base);
    } catch (_) { /* one calendar down: try the next */ }
  }
  if (!used.length) return null;
  return { timestamp: root, calendars: used, ots: serializeDetached(digest, root) };
}

/** Replace pending calendar attestations once the calendar returns a Bitcoin attestation. */
export async function upgradeTimestamp(ts, fetchImpl, timeoutMs = 8000) {
  if (!fetchImpl) throw new Error("fetchImpl required");
  let changed = false;
  async function walk(node) {
    const pend = node.attestations.filter((a) => a.kind === "pending" && allowedCalendar(a.uri));
    for (const p of pend) {
      let res;
      try {
        res = await fetchImpl(p.uri.replace(/\/+$/, "") + "/timestamp/" + hex(node.msg), {
          method: "GET",
          headers: { accept: "application/vnd.opentimestamps.v1", "user-agent": "402xagent-anchor/0.70.0" },
          signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
        });
      } catch (_) { continue; }
      if (!res || !res.ok) continue;
      let up;
      try { up = parseTimestamp(await readBody(res), node.msg); } catch (_) { continue; }
      if (!hasBitcoin(up)) continue;
      merge(node, up);
      node.attestations = node.attestations.filter((a) => !(a.kind === "pending" && a.uri === p.uri));
      changed = true;
    }
    for (const edge of node.ops) await walk(edge.child);
  }
  await walk(ts);
  return changed;
}
