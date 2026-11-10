// 0.70.0: nightly OpenTimestamps anchoring. OFF unless ANCHORS=1.
// A cron builds one SHA-256 Merkle root over spot_receipts stored since the previous anchor
// (created_at, id order) and submits SHA-256 of the raw 32-byte root to the public calendars
// https://a.pool.opentimestamps.org and https://b.pool.opentimestamps.org. Those pools are free
// and aggregate many digests into a Bitcoin transaction they pay for. This Worker does not
// create a Bitcoin transaction and does not change receipt signing.
// status pending: calendars accepted the digest. Not a Bitcoin confirmation.
// status confirmed: the .ots proof contains a Bitcoin block-header attestation. `ots verify` checks it.
import { canonicalize } from "./sign.js";
import { chromePage, esc } from "./chrome.js";
import {
  sha256, hex, hexToBytes, concat, calendarList, submitDigest, upgradeTimestamp, parseDetached,
  serializeDetached, hasBitcoin, bitcoinHeight, allowedCalendar,
} from "./ots.js";

export const ANCHOR_CRON = "41 3 * * *"; // 03:41 UTC, clear of the other crons
export const ANCHOR_MAX_PER_RUN = 2000;
export const ANCHOR_PAGE = 200;
export const anchorsOn = (env) => String((env && env.ANCHORS) || "") === "1";

export const HASH_DOC = "Leaf hash is SHA-256 of a 0x00 byte followed by the UTF-8 RFC 8785 (JCS) JSON of the anchored receipt. A signed receipt is anchored as its signed view (the public receipt, including kid and signature). An unsigned receipt is anchored as the stored JSON body. Parent hash is SHA-256 of a 0x01 byte, the left child, and the right child. An odd node with no sibling is carried up unchanged. Receipt order is created_at ascending, then id ascending.";
export const PENDING_NOTE = "status pending means the digest was submitted to OpenTimestamps calendars. It is not a Bitcoin confirmation.";
export const CONFIRMED_NOTE = "status confirmed means the .ots proof contains a Bitcoin block header attestation. ots verify checks that attestation against Bitcoin. This service does not re-query Bitcoin.";
export const VERIFY_DOC = "The .ots file is a detached OpenTimestamps proof of the 32-byte merkle root (raw bytes, not the hex text). Save that file as <id>.bin and the proof as <id>.bin.ots, then run: ots verify <id>.bin.ots. While the status is pending, ots upgrade <id>.bin.ots asks the calendars again. Pending is not a Bitcoin confirmation.";

const OTS_RE = /^\/anchors\/(an-[0-9a-f]{16})\.ots$/;
const PROOF_RE = /^\/v1\/receipts\/([A-Za-z0-9_-]{1,64})\/proof$/;
const stampOf = (now) => now.toISOString().replace(/\.\d{3}Z$/, "Z");
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj, null, 2), {
  status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": status === 200 ? "public, max-age=60" : "no-store", ...extra },
});

function asBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array();
}

/** The object that is hashed. Signed rows use signed_view so it matches the public receipt. */
export function anchoredReceipt(body) {
  const o = typeof body === "string" ? JSON.parse(body) : body;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("receipt body is not an object");
  if (o.signed_view && typeof o.signed_view === "object" && !Array.isArray(o.signed_view) && typeof o.signed_view.signature === "string") return o.signed_view;
  return o;
}
export function receiptLeaf(obj) {
  const pre = new TextEncoder().encode(canonicalize(obj));
  const buf = new Uint8Array(1 + pre.length);
  buf[0] = 0x00;
  buf.set(pre, 1);
  return sha256(buf);
}

/** Merkle tree. `leaves` are raw 32-byte leaf hashes. Odd nodes are carried up, not duplicated. */
export function merkle(leaves) {
  if (!leaves.length) return { root: null, paths: [] };
  const paths = leaves.map(() => []);
  let level = leaves.map((hash, i) => ({ hash, idxs: [i] }));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) { next.push(level[i]); continue; }
      const L = level[i], R = level[i + 1];
      const hash = sha256(concat([new Uint8Array([0x01]), L.hash, R.hash]));
      const right = hex(R.hash), left = hex(L.hash);
      for (const ix of L.idxs) paths[ix].push({ sibling: right, side: "right" });
      for (const ix of R.idxs) paths[ix].push({ sibling: left, side: "left" });
      next.push({ hash, idxs: L.idxs.concat(R.idxs) });
    }
    level = next;
  }
  return { root: level[0].hash, paths };
}

async function lastCursor(db) {
  const row = await db.prepare("SELECT last_created_at, last_receipt_id FROM receipt_anchors WHERE last_created_at IS NOT NULL ORDER BY last_created_at DESC, last_receipt_id DESC LIMIT 1").first();
  return row && row.last_receipt_id ? { created_at: row.last_created_at, id: row.last_receipt_id } : null;
}
async function pageReceipts(db, cursor, limit) {
  const stmt = cursor
    ? db.prepare("SELECT id, created_at, body FROM spot_receipts WHERE created_at > ? OR (created_at = ? AND id > ?) ORDER BY created_at ASC, id ASC LIMIT ?").bind(cursor.created_at, cursor.created_at, cursor.id, limit)
    : db.prepare("SELECT id, created_at, body FROM spot_receipts ORDER BY created_at ASC, id ASC LIMIT ?").bind(limit);
  const res = await stmt.all();
  return (res && res.results) || [];
}

export async function upgradePendingAnchors(env, now = new Date(), opts = {}) {
  if (!anchorsOn(env) || !env.RECEIPTS_DB) return { did: "off", n: 0 };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let rows;
  try {
    rows = ((await env.RECEIPTS_DB.prepare("SELECT id, ots_proof FROM receipt_anchors WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20").all()) || {}).results || [];
  } catch (_) { return { did: "no-table", n: 0 }; }
  let n = 0;
  for (const row of rows) {
    try {
      const det = parseDetached(asBytes(row.ots_proof));
      const changed = await upgradeTimestamp(det.timestamp, fetchImpl);
      if (!changed || !hasBitcoin(det.timestamp)) continue;
      const ots = serializeDetached(det.digest, det.timestamp);
      await env.RECEIPTS_DB.prepare("UPDATE receipt_anchors SET status = 'confirmed', ots_proof = ?, btc_height = ?, confirmed_at = ? WHERE id = ? AND status = 'pending'")
        .bind(ots, bitcoinHeight(det.timestamp), stampOf(now), row.id).run();
      n++;
      console.log(JSON.stringify({ anchor: "confirmed", id: row.id, btc_height: bitcoinHeight(det.timestamp) }));
    } catch (e) {
      console.log(JSON.stringify({ anchor: "upgrade_error", id: String(row.id || "").slice(0, 32), error: String((e && e.message) || e).slice(0, 200) }));
    }
  }
  return { did: "upgraded", n };
}

async function collectReceipts(db) {
  const cursor0 = await lastCursor(db);
  const collected = [];
  let cursor = cursor0;
  while (collected.length < ANCHOR_MAX_PER_RUN) {
    const page = await pageReceipts(db, cursor, Math.min(ANCHOR_PAGE, ANCHOR_MAX_PER_RUN - collected.length));
    if (!page.length) break;
    for (const row of page) {
      const leaf = receiptLeaf(anchoredReceipt(row.body));
      collected.push({ id: row.id, created_at: row.created_at, hash: hex(leaf), raw: leaf });
    }
    const last = page[page.length - 1];
    cursor = { created_at: last.created_at, id: last.id };
  }
  return collected;
}

export async function anchorNew(env, now = new Date(), opts = {}) {
  if (!anchorsOn(env) || !env.RECEIPTS_DB) return { did: "off" };
  const db = env.RECEIPTS_DB;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let collected;
  try { collected = await collectReceipts(db); }
  catch (e) {
    console.log(JSON.stringify({ anchor: "read_error", error: String((e && e.message) || e).slice(0, 200) }));
    return { did: "read_error" };
  }
  if (!collected.length) return { did: "idle" };
  const { root } = merkle(collected.map((r) => r.raw));
  const rootHex = hex(root);
  const fileDigest = sha256(root);
  const calendars = calendarList(env).filter(allowedCalendar);
  const submitted = await submitDigest(fileDigest, { fetchImpl, calendars });
  if (!submitted) {
    console.log(JSON.stringify({ anchor: "calendar_failed", count: collected.length }));
    return { did: "calendar_failed", count: collected.length };
  }
  const createdAt = stampOf(now);
  const id = "an-" + hex(sha256(new TextEncoder().encode(rootHex + "|" + createdAt + "|" + collected[0].id))).slice(0, 16);
  const first = collected[0], last = collected[collected.length - 1];
  try {
    await db.prepare("INSERT INTO receipt_anchors (id, created_at, merkle_root, file_sha256, receipt_count, first_receipt_id, last_receipt_id, first_created_at, last_created_at, status, ots_proof, calendars, btc_height, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)")
      .bind(id, createdAt, rootHex, hex(fileDigest), collected.length, first.id, last.id, first.created_at, last.created_at, submitted.ots, JSON.stringify(submitted.calendars)).run();
    const chunk = 40;
    for (let i = 0; i < collected.length; i += chunk) {
      const part = collected.slice(i, i + chunk);
      const stmts = part.map((row, j) => db.prepare("INSERT INTO receipt_anchor_items (receipt_id, anchor_id, position, receipt_hash) VALUES (?, ?, ?, ?)").bind(row.id, id, i + j, row.hash));
      if (typeof db.batch === "function") await db.batch(stmts);
      else for (const s of stmts) await s.run();
    }
  } catch (e) {
    try { await db.prepare("DELETE FROM receipt_anchor_items WHERE anchor_id = ?").bind(id).run(); } catch (_) {}
    try { await db.prepare("DELETE FROM receipt_anchors WHERE id = ?").bind(id).run(); } catch (_) {}
    console.log(JSON.stringify({ anchor: "write_error", error: String((e && e.message) || e).slice(0, 200) }));
    return { did: "write_error" };
  }
  console.log(JSON.stringify({ anchor: "created", id, count: collected.length, calendars: submitted.calendars.length, status: "pending", capped: collected.length === ANCHOR_MAX_PER_RUN }));
  return { did: "created", id, count: collected.length, status: "pending" };
}

/** Upgrade pending proofs, then anchor receipts stored since the last anchor. */
export async function anchorTick(env, now = new Date(), opts = {}) {
  if (!anchorsOn(env)) return { did: "off" };
  const upgraded = await upgradePendingAnchors(env, now, opts);
  const created = await anchorNew(env, now, opts);
  return { did: "tick", upgraded, created };
}

function publicAnchor(row, origin) {
  const confirmed = row.status === "confirmed";
  return {
    id: row.id,
    created_at: row.created_at,
    merkle_root: row.merkle_root,
    receipt_count: row.receipt_count,
    first_receipt_id: row.first_receipt_id,
    last_receipt_id: row.last_receipt_id,
    status: row.status,
    bitcoin_confirmed: confirmed,
    btc_height: confirmed && row.btc_height != null ? row.btc_height : null,
    file_sha256: row.file_sha256,
    ots: origin + "/anchors/" + row.id + ".ots",
  };
}

async function listAnchors(env) {
  const res = await env.RECEIPTS_DB.prepare("SELECT id, created_at, merkle_root, file_sha256, receipt_count, first_receipt_id, last_receipt_id, status, btc_height FROM receipt_anchors ORDER BY created_at DESC, id DESC LIMIT 100").all();
  return (res && res.results) || [];
}

export function anchorsDocument(origin, rows) {
  return {
    anchors: rows.map((r) => publicAnchor(r, origin)),
    hash: HASH_DOC,
    verify: VERIFY_DOC,
    pending: PENDING_NOTE,
    confirmed: CONFIRMED_NOTE,
    calendars: calendarList({}),
    ots_client: "https://opentimestamps.org",
  };
}

const CSS = `
.an-card{background:#fff;border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px 20px;margin:0 0 16px}
.an-card h2{font-size:18px;margin:0 0 8px;color:var(--forest)}
.an-table{width:100%;border-collapse:collapse;font-size:14px}
.an-table th,.an-table td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--bg-subtle)}
.an-table code{font-family:var(--mono);font-size:12px;word-break:break-all}
.an-pending{color:#8a5a00;font-weight:700}.an-confirmed{color:#1f7a3a;font-weight:700}
@media(max-width:760px){.an-table,.an-table tbody,.an-table tr,.an-table td{display:block;width:100%}.an-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.an-table tr{border-bottom:1px solid var(--border);padding:8px 0}}`;

function statusCell(r) {
  if (r.status === "confirmed") return `<span class="an-confirmed">confirmed</span>. Bitcoin block header attestation${r.btc_height != null ? ` at height ${esc(r.btc_height)}` : ""}.`;
  return `<span class="an-pending">pending</span>. Not a Bitcoin confirmation.`;
}

export function anchorsPageHtml(origin, rows) {
  const tr = rows.map((r) => `<tr><td><time datetime="${esc(r.created_at)}">${esc(String(r.created_at).slice(0, 10))}</time></td><td><code>${esc(r.merkle_root)}</code></td><td>${esc(r.receipt_count)}</td><td>${statusCell(r)}</td><td><a href="/anchors/${esc(r.id)}.ots">${esc(r.id)}.bin.ots</a></td></tr>`).join("");
  const table = rows.length
    ? `<table class="an-table"><thead><tr><th scope="col">Date</th><th scope="col">Merkle root</th><th scope="col">Receipts</th><th scope="col">Status</th><th scope="col">Proof</th></tr></thead><tbody>${tr}</tbody></table>`
    : `<p>No anchors yet. The nightly job has not stored one.</p>`;
  const main = `<section class="pg-hero"><h1>Receipt anchors</h1><p class="pg-lead">Each night, when anchoring is on, new check receipts are folded into one SHA-256 Merkle root and that root is submitted to public OpenTimestamps calendars. A pending anchor is a calendar submission, not a Bitcoin confirmation.</p></section>
<div class="pg-body">
<section class="an-card" aria-labelledby="an-list"><h2 id="an-list">Anchors</h2>
${table}
<p>JSON: <a href="/anchors.json">/anchors.json</a>. One receipt's path: <code>/v1/receipts/&lt;id&gt;/proof</code>.</p>
</section>
<section class="an-card" aria-labelledby="an-how"><h2 id="an-how">Check a root with ots verify</h2>
<p>${esc(VERIFY_DOC)}</p>
<p>${esc(PENDING_NOTE)} ${esc(CONFIRMED_NOTE)}</p>
<p>${esc(HASH_DOC)}</p>
<p>Calendars: ${calendarList({}).map((u) => `<code>${esc(u)}</code>`).join(", ")}. They aggregate digests and pay the Bitcoin transaction. This service does not create one.</p>
<p>Docs: <a href="/docs/receipt-verification#receipt-anchors">receipt anchors</a>.</p>
</section>
</div>`;
  return chromePage({
    title: "Receipt anchors · 402xAgent",
    desc: "Nightly SHA-256 Merkle roots of 402xAgent receipts, timestamped with OpenTimestamps. Pending is not a Bitcoin confirmation.",
    canonical: origin + "/anchors",
    current: "",
    css: CSS,
    main,
    alternate: origin + "/anchors.json",
    footer: {},
  });
}

export async function handleAnchors(req, env, url, path, origin) {
  if (!anchorsOn(env)) return json({ error: "not found" }, 404);
  if (!env.RECEIPTS_DB) return json({ error: "anchor store unavailable" }, 503);
  const ots = OTS_RE.exec(path);
  try {
    if (ots) {
      const row = await env.RECEIPTS_DB.prepare("SELECT id, status, ots_proof FROM receipt_anchors WHERE id = ?").bind(ots[1]).first();
      if (!row) return json({ error: "anchor not found", id: ots[1] }, 404);
      const bytes = asBytes(row.ots_proof);
      const headers = {
        "content-type": "application/vnd.opentimestamps.ots",
        "content-disposition": `attachment; filename="${row.id}.bin.ots"`,
        "cache-control": row.status === "confirmed" ? "public, max-age=86400" : "public, max-age=60",
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": "*",
      };
      return new Response(req.method === "HEAD" ? null : bytes, { status: 200, headers });
    }
    const rows = await listAnchors(env);
    if (path === "/anchors.json") return json(anchorsDocument(origin, rows));
    const html = anchorsPageHtml(origin, rows);
    return new Response(req.method === "HEAD" ? null : html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" } });
  } catch (_) {
    return json({ error: "anchor store unavailable" }, 503);
  }
}

export function proofPathId(path) {
  const m = PROOF_RE.exec(path);
  return m ? m[1] : null;
}

export async function handleReceiptProof(env, path, origin) {
  if (!anchorsOn(env)) return json({ error: "not found" }, 404);
  const id = proofPathId(path);
  if (!id) return json({ error: "not found" }, 404);
  if (!env.RECEIPTS_DB) return json({ error: "anchor store unavailable" }, 503);
  try {
    const item = await env.RECEIPTS_DB.prepare("SELECT anchor_id, position, receipt_hash FROM receipt_anchor_items WHERE receipt_id = ?").bind(id).first();
    if (!item) return json({ error: "not yet anchored", receipt_id: id, proof: origin + "/v1/receipts/" + id + "/proof" }, 404);
    const anchor = await env.RECEIPTS_DB.prepare("SELECT id, merkle_root, status, btc_height, created_at, receipt_count FROM receipt_anchors WHERE id = ?").bind(item.anchor_id).first();
    if (!anchor) return json({ error: "not yet anchored", receipt_id: id }, 404);
    const all = ((await env.RECEIPTS_DB.prepare("SELECT position, receipt_hash FROM receipt_anchor_items WHERE anchor_id = ? ORDER BY position ASC").bind(anchor.id).all()) || {}).results || [];
    if (all.length !== Number(anchor.receipt_count) || all.some((r, i) => r.position !== i)) return json({ error: "anchor incomplete", receipt_id: id }, 503);
    const leaves = all.map((r) => hexToBytes(r.receipt_hash));
    if (leaves.some((h) => !h || h.length !== 32)) return json({ error: "anchor incomplete", receipt_id: id }, 503);
    const built = merkle(leaves);
    if (hex(built.root) !== anchor.merkle_root) return json({ error: "anchor root mismatch", receipt_id: id }, 503);
    const confirmed = anchor.status === "confirmed";
    return json({
      receipt_id: id,
      receipt_hash: item.receipt_hash,
      path: built.paths[item.position] || [],
      root: anchor.merkle_root,
      anchor_id: anchor.id,
      status: anchor.status,
      bitcoin_confirmed: confirmed,
      btc_height: confirmed && anchor.btc_height != null ? anchor.btc_height : null,
      created_at: anchor.created_at,
      hash: HASH_DOC,
      pending: PENDING_NOTE,
      confirmed: CONFIRMED_NOTE,
      ots: origin + "/anchors/" + anchor.id + ".ots",
      docs: origin + "/docs/receipt-verification#receipt-anchors",
    });
  } catch (_) {
    return json({ error: "anchor store unavailable" }, 503);
  }
}

export const ANCHOR_DOCS_HTML = `<h2 id="receipt-anchors">Receipt anchors (0.70.0)</h2>
<p>When <code>ANCHORS=1</code>, a nightly job (03:41 UTC) builds one SHA-256 Merkle root over check receipts stored since the previous anchor and submits that root to the public OpenTimestamps calendars <code>https://a.pool.opentimestamps.org</code> and <code>https://b.pool.opentimestamps.org</code>. The flag is off unless set. Receipt signatures are unchanged. The calendars are free and aggregate many digests into a Bitcoin transaction they pay for. This service does not create a Bitcoin transaction.</p>
<p>${HASH_DOC}</p>
<p>The list is <a href="/anchors">/anchors</a> (JSON: <a href="/anchors.json">/anchors.json</a>). Each row has the date, the merkle root, the receipt count, the status, and a <code>.ots</code> download. ${VERIFY_DOC}</p>
<p>${PENDING_NOTE} ${CONFIRMED_NOTE}</p>
<p>One receipt: <code>GET /v1/receipts/&lt;id&gt;/proof</code>. Until that receipt is in an anchor the response is 404 <code>not yet anchored</code>. Otherwise the body has <code>receipt_hash</code>, <code>path</code> (each step is <code>sibling</code> plus <code>side</code> <code>left</code> or <code>right</code>), <code>root</code>, <code>anchor_id</code> and <code>status</code>. <code>bitcoin_confirmed</code> is true only when <code>status</code> is <code>confirmed</code>. The offline verifier checks the same path: <code>node verify-receipt.mjs receipt.json proof.json</code>.</p>`;

export function anchorsOpenApiPaths(origin) {
  const anchorSchema = { type: "object", required: ["id", "created_at", "merkle_root", "receipt_count", "status", "bitcoin_confirmed", "ots"], properties: {
    id: { type: "string", example: "an-0123456789abcdef" },
    created_at: { type: "string", description: "UTC time the anchor was built" },
    merkle_root: { type: "string", description: "64 hex characters, SHA-256 Merkle root" },
    receipt_count: { type: "integer" },
    status: { type: "string", enum: ["pending", "confirmed"], description: "pending: submitted to calendars, not a Bitcoin confirmation. confirmed: the .ots proof contains a Bitcoin block header attestation." },
    bitcoin_confirmed: { type: "boolean", description: "true only when status is confirmed" },
    btc_height: { type: ["integer", "null"] },
    ots: { type: "string" },
  } };
  return {
    "/anchors": { get: { operationId: "anchorsPage", security: [], summary: "HTML list of receipt anchors (0.70.0, ANCHORS=1). Date, merkle root, receipt count, status, .ots download, and ots verify instructions. Pending is not a Bitcoin confirmation.", responses: { 200: { description: "HTML" }, 404: { description: "ANCHORS is not 1" } } } },
    "/anchors.json": { get: { operationId: "anchorsJson", security: [], summary: "JSON list of receipt anchors (0.70.0, ANCHORS=1). " + PENDING_NOTE + " " + CONFIRMED_NOTE, responses: { 200: { description: "anchors, hash algorithm, verify instructions", content: { "application/json": { schema: { type: "object", properties: { anchors: { type: "array", items: anchorSchema }, hash: { type: "string" }, verify: { type: "string" }, pending: { type: "string" }, confirmed: { type: "string" } } } } } }, 404: { description: "ANCHORS is not 1" } } } },
    "/anchors/{id}.ots": { get: { operationId: "anchorOts", security: [], summary: "Detached OpenTimestamps proof of the 32-byte merkle root (0.70.0, ANCHORS=1). Save the root bytes as <id>.bin and this file as <id>.bin.ots, then: ots verify <id>.bin.ots", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^an-[0-9a-f]{16}$" } }], responses: { 200: { description: "application/vnd.opentimestamps.ots", content: { "application/vnd.opentimestamps.ots": { schema: { type: "string", format: "binary" } } } }, 404: { description: "unknown id, or ANCHORS is not 1" } } } },
    "/v1/receipts/{id}/proof": { get: { operationId: "receiptAnchorProof", security: [], summary: "Merkle proof that a stored receipt is in an anchor (0.70.0, ANCHORS=1). 404 not yet anchored when it is not. bitcoin_confirmed is true only when status is confirmed. " + PENDING_NOTE + " " + HASH_DOC, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "receipt id" }], responses: {
      200: { description: "receipt_hash, path[{sibling, side:left|right}], root, anchor_id, status, bitcoin_confirmed", content: { "application/json": { schema: { type: "object", required: ["receipt_id", "receipt_hash", "path", "root", "anchor_id", "status", "bitcoin_confirmed"], properties: {
        receipt_id: { type: "string" }, receipt_hash: { type: "string" },
        path: { type: "array", items: { type: "object", properties: { sibling: { type: "string" }, side: { type: "string", enum: ["left", "right"] } } } },
        root: { type: "string" }, anchor_id: { type: "string" }, status: { type: "string", enum: ["pending", "confirmed"] }, bitcoin_confirmed: { type: "boolean" },
        docs: { type: "string", example: origin + "/docs/receipt-verification#receipt-anchors" },
      } } } } },
      404: { description: "not yet anchored, or ANCHORS is not 1" },
    } } },
  };
}

export function anchorsLlmsLine(origin) {
  return `- Receipt anchors (0.70.0, flag ANCHORS=1; off unless set): ${origin}/anchors (JSON: ${origin}/anchors.json). Nightly SHA-256 Merkle root over new check receipts, submitted to the public OpenTimestamps calendars https://a.pool.opentimestamps.org and https://b.pool.opentimestamps.org. Those calendars are free and pay the Bitcoin aggregation; this service does not create a Bitcoin transaction. Each row has the date, root, receipt count, status and a .ots file. ${PENDING_NOTE} ${CONFIRMED_NOTE} ${VERIFY_DOC} One receipt: GET ${origin}/v1/receipts/<id>/proof returns receipt_hash, Merkle path, root, anchor id and status, or 404 not yet anchored. ${HASH_DOC} Docs: ${origin}/docs/receipt-verification#receipt-anchors\n`;
}
