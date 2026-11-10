// 0.70.0: nightly OpenTimestamps anchors. No network: calendar HTTP is a mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import { sqliteD1 } from "./helpers/sqlite_d1.mjs";
import { verifierCore } from "../worker/src/verify-core.js";
import { canonicalize } from "../worker/src/sign.js";
import {
  sha256, hex, hexToBytes, OTS_HEADER, pendingCalendarBody, bitcoinUpgradeBody, parseTimestamp,
  parseDetached, serializeDetached, hasBitcoin, bitcoinHeight, allowedCalendar, DEFAULT_CALENDARS,
} from "../worker/src/ots.js";
import {
  merkle, receiptLeaf, anchoredReceipt, anchorTick, anchorNew, upgradePendingAnchors, ANCHOR_CRON,
  anchorsPageHtml, HASH_DOC, PENDING_NOTE, CONFIRMED_NOTE,
} from "../worker/src/anchors.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest();
const utf8 = (s) => new TextEncoder().encode(s);
const V = verifierCore([]);
const ctx = { waitUntil() {}, passThroughOnException() {} };
const realFetch = globalThis.fetch;

test("0.70.0 version, migration 0032, ANCHORS off, nightly cron", () => {
  assert.equal(VERSION, "0.70.0");
  const files = readdirSync(join(ROOT, "..", "worker", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.equal(files.at(-1), "0032_receipt_anchors.sql");
  const toml = readFileSync(join(ROOT, "..", "worker", "wrangler.toml"), "utf8");
  assert.match(toml, /# ANCHORS = "1"/);
  assert.doesNotMatch(toml, /^ANCHORS\s*=/m);
  assert.match(toml, new RegExp(ANCHOR_CRON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const sql = readFileSync(join(ROOT, "..", "worker", "migrations", "0032_receipt_anchors.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS receipt_anchors/);
  assert.match(sql, /receipt_anchor_items/);
  assert.doesNotMatch(sql, /ALTER TABLE spot_receipts/);
});

test("SHA-256 matches Node, including the verifier fallback", () => {
  for (const s of ["", "abc", "a", "The quick brown fox jumps over the lazy dog", "é"]) {
    const b = utf8(s);
    assert.equal(hex(sha256(b)), sha(b).toString("hex"), s);
    assert.equal(hex(V._sha256js(b)), sha(b).toString("hex"), "js " + s);
  }
  const header = new Uint8Array([0, ...utf8("OpenTimestamps"), 0, 0, ...utf8("Proof"), 0, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]);
  assert.deepEqual(OTS_HEADER, header);
  assert.equal(allowedCalendar("https://a.pool.opentimestamps.org"), true);
  assert.equal(allowedCalendar("http://a.pool.opentimestamps.org"), false);
  assert.equal(allowedCalendar("https://evil.example/digest"), false);
  assert.deepEqual(DEFAULT_CALENDARS.length >= 2, true);
});

function walk(leaf, path) {
  let h = leaf;
  for (const step of path) {
    const sib = hexToBytes(step.sibling);
    h = sha256(Uint8Array.of(1, ...(step.side === "left" ? [...sib, ...h] : [...h, ...sib])));
  }
  return hex(h);
}

test("Merkle root and paths, including odd counts", () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8]) {
    const leaves = Array.from({ length: n }, (_, i) => sha256(utf8("leaf-" + i)));
    const { root, paths } = merkle(leaves);
    assert.equal(root.length, 32);
    assert.equal(paths.length, n);
    if (n === 1) assert.deepEqual(paths[0], []);
    for (let i = 0; i < n; i++) assert.equal(walk(leaves[i], paths[i]), hex(root), n + ":" + i);
    const bad = paths[0].map((s) => ({ ...s }));
    if (bad.length) {
      bad[0] = { ...bad[0], sibling: "00".repeat(32) };
      assert.notEqual(walk(leaves[0], bad), hex(root));
    }
  }
});

test("receipt leaf is JCS with a 0x00 prefix, and a signed view is what is hashed", () => {
  const plain = { id: "sc-" + "a".repeat(16), verdict: "pay", n: 1 };
  assert.equal(canonicalize(plain), V.jcs(plain));
  const leaf = receiptLeaf(plain);
  const pre = utf8(canonicalize(plain));
  const buf = new Uint8Array(1 + pre.length); buf[0] = 0; buf.set(pre, 1);
  assert.equal(hex(leaf), hex(sha256(buf)));
  const signed = { id: "sc-" + "b".repeat(16), verdict: "skip", signature: "abc" };
  const stored = { id: signed.id, client: "hidden", signed_view: signed };
  assert.equal(hex(receiptLeaf(anchoredReceipt(stored))), hex(receiptLeaf(signed)));
  assert.notEqual(hex(receiptLeaf(stored)), hex(receiptLeaf(signed)));
});

test("OTS pending body round-trips and a Bitcoin upgrade is detected", () => {
  const digest = sha256(utf8("root-file"));
  const nonce = utf8("n");
  const uri = "https://a.pool.opentimestamps.org";
  const body = pendingCalendarBody(digest, uri, nonce);
  const ts = parseTimestamp(body, digest);
  assert.equal(hasBitcoin(ts), false);
  assert.equal(bitcoinHeight(ts), null);
  const again = parseTimestamp(body, digest);
  assert.equal(hex(again.msg), hex(digest));
  const detached = serializeDetached(digest, ts);
  const parsed = parseDetached(detached);
  assert.equal(hex(parsed.digest), hex(digest));
  assert.equal(hasBitcoin(parsed.timestamp), false);
  const commitment = sha256(Uint8Array.of(...digest, ...nonce));
  const up = parseTimestamp(bitcoinUpgradeBody(commitment, 840123), commitment);
  assert.equal(bitcoinHeight(up), 840123);
  assert.equal(hasBitcoin(up), true);
});

function db() { return sqliteD1(); }
const id = (ch) => "sc-" + ch.repeat(16);
function put(d, receipt, at) {
  const body = receipt.signature ? { id: receipt.id, client: "not-hashed", signed_view: receipt } : receipt;
  return d.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, body) VALUES (?, ?, ?, ?, 'price_ok', 'live', ?)")
    .bind(receipt.id, "https://seller.example/" + receipt.id, at, receipt.verdict, JSON.stringify(body)).run();
}
function calendars({ upgrade = false, fail = new Set() } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", len: init.body ? init.body.length : 0 });
    const u = String(url);
    const host = new URL(u).host;
    if (fail.has(host)) return new Response("down", { status: 503 });
    if (u.endsWith("/digest")) {
      if (!init.body || init.body.length !== 32) throw new Error("digest was not 32 bytes");
      const base = u.slice(0, -"/digest".length);
      return new Response(pendingCalendarBody(new Uint8Array(init.body), base, utf8(host)));
    }
    if (u.includes("/timestamp/")) {
      if (!upgrade) return new Response("not yet", { status: 404 });
      const msg = hexToBytes(u.split("/timestamp/")[1]);
      return new Response(bitcoinUpgradeBody(msg, 840123));
    }
    throw new Error("unexpected " + u);
  };
  return { calls, fetchImpl };
}
const envOf = (d, extra = {}) => ({ ANCHORS: "1", RECEIPTS_DB: d, BAZAAR_PAGE: "off", DAILY_RECHECK: "off", STALE_RECHECK: "off", ...extra });

async function withNoNet(fn) {
  globalThis.fetch = () => { throw new Error("network used"); };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

test("calendar submission is mocked, both pools are POSTed, and a failed calendar is skipped", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-01T00:00:03Z");
  await put(d, { id: id("b"), verdict: "skip" }, "2026-11-01T00:00:01Z");
  await put(d, { id: id("c"), verdict: "pay", signature: "sig" }, "2026-11-01T00:00:02Z");
  const mock = calendars();
  const out = await withNoNet(() => anchorTick(envOf(d), new Date("2026-11-10T03:41:00Z"), { fetchImpl: mock.fetchImpl }));
  assert.equal(out.created.did, "created");
  assert.equal(out.created.count, 3);
  assert.equal(out.created.status, "pending");
  const posts = mock.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((c) => new URL(c.url).host).sort(), ["a.pool.opentimestamps.org", "b.pool.opentimestamps.org"]);
  assert.ok(posts.every((c) => c.len === 32 && c.url.endsWith("/digest")));
  const row = await d.prepare("SELECT status, receipt_count, merkle_root, btc_height FROM receipt_anchors").first();
  assert.equal(row.status, "pending");
  assert.equal(row.receipt_count, 3);
  assert.equal(row.btc_height, null);
  const order = (await d.prepare("SELECT receipt_id FROM receipt_anchor_items ORDER BY position").all()).results.map((r) => r.receipt_id);
  assert.deepEqual(order, [id("b"), id("c"), id("a")]);

  const d2 = db();
  await put(d2, { id: id("d"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const oneDown = calendars({ fail: new Set(["b.pool.opentimestamps.org"]) });
  const partial = await withNoNet(() => anchorNew(envOf(d2), new Date("2026-11-10T03:41:00Z"), { fetchImpl: oneDown.fetchImpl }));
  assert.equal(partial.status, "pending");
  assert.equal(oneDown.calls.filter((c) => c.method === "POST").length, 2);
  const cals = JSON.parse((await d2.prepare("SELECT calendars FROM receipt_anchors").first()).calendars);
  assert.deepEqual(cals, ["https://a.pool.opentimestamps.org"]);

  const d3 = db();
  await put(d3, { id: id("e"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const both = calendars({ fail: new Set(["a.pool.opentimestamps.org", "b.pool.opentimestamps.org"]) });
  const none = await withNoNet(() => anchorNew(envOf(d3), new Date("2026-11-10T03:41:00Z"), { fetchImpl: both.fetchImpl }));
  assert.equal(none.did, "calendar_failed");
  assert.equal(await d3.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 0);
});

test("proof endpoint, page, pending then confirmed, and the offline verifier", async () => {
  const d = db();
  const receipts = [
    { id: id("b"), verdict: "skip" },
    { id: id("c"), verdict: "pay", signature: "sig" },
    { id: id("a"), verdict: "recheck" },
  ];
  await put(d, receipts[2], "2026-11-01T00:00:03Z");
  await put(d, receipts[0], "2026-11-01T00:00:01Z");
  await put(d, receipts[1], "2026-11-01T00:00:02Z");
  const mock = calendars();
  await withNoNet(() => anchorTick(envOf(d), new Date("2026-11-10T03:41:00Z"), { fetchImpl: mock.fetchImpl }));
  const env = envOf(d);
  const get = (path, headers) => worker.fetch(new Request("https://402xagent.com" + path, { headers }), env, ctx);

  const missing = await get("/v1/receipts/" + id("f") + "/proof");
  assert.equal(missing.status, 404);
  const missBody = await missing.json();
  assert.equal(missBody.error, "not yet anchored");
  assert.equal(missBody.bitcoin_confirmed, undefined);

  for (const r of [receipts[0], receipts[1], receipts[2]]) {
    const res = await get("/v1/receipts/" + r.id + "/proof");
    assert.equal(res.status, 200, r.id);
    const proof = await res.json();
    assert.equal(proof.bitcoin_confirmed, false);
    assert.equal(proof.status, "pending");
    assert.match(proof.pending, /not a Bitcoin confirmation/);
    assert.equal(proof.path.length > 0, true);
    const anchored = r.signature ? r : r;
    const check = await V.verifyAnchor(anchored, proof);
    assert.equal(check.ok, true, check.detail);
    assert.equal(check.bitcoin_confirmed, false);
    assert.match(check.detail, /not a Bitcoin confirmation/);
    assert.doesNotMatch(check.detail, /status is confirmed/);
    const tampered = { ...proof, path: proof.path.map((s, i) => i ? s : { ...s, sibling: "11".repeat(32) }) };
    const bad = await V.verifyAnchor(anchored, tampered);
    assert.equal(bad.ok, false);
    assert.equal(bad.bitcoin_confirmed, false);
  }

  const page = await get("/anchors", { accept: "text/html" });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /Receipt anchors/);
  assert.match(html, /class="an-pending"/);
  assert.doesNotMatch(html, /class="an-confirmed"/);
  assert.match(html, /Not a Bitcoin confirmation/);
  assert.match(html, /ots verify/);
  assert.match(html, /<time datetime="2026-11-10T03:41:00Z">2026-11-10<\/time>/);
  const root = (await d.prepare("SELECT merkle_root, receipt_count, id FROM receipt_anchors").first());
  assert.match(html, new RegExp(root.merkle_root));
  assert.match(html, new RegExp(">" + root.receipt_count + "<"));
  assert.match(html, new RegExp('href="/anchors/' + root.id + '\\.ots"'));

  const js = await (await get("/anchors.json")).json();
  assert.equal(js.anchors.length, 1);
  assert.equal(js.anchors[0].status, "pending");
  assert.equal(js.anchors[0].bitcoin_confirmed, false);
  assert.equal(js.anchors[0].receipt_count, 3);
  assert.equal(js.anchors[0].merkle_root, root.merkle_root);
  assert.match(js.verify, /ots verify/);
  assert.match(js.pending, /not a Bitcoin confirmation/);
  assert.match(js.hash, /0x00/);

  const ots = await get("/anchors/" + root.id + ".ots");
  assert.equal(ots.status, 200);
  assert.match(ots.headers.get("content-type"), /opentimestamps/);
  assert.match(ots.headers.get("content-disposition"), new RegExp(root.id + "\\.bin\\.ots"));
  const file = parseDetached(new Uint8Array(await ots.arrayBuffer()));
  assert.equal(hex(file.digest), hex(sha256(hexToBytes(root.merkle_root))));
  assert.equal(hasBitcoin(file.timestamp), false);

  const up = calendars({ upgrade: true });
  globalThis.fetch = up.fetchImpl;
  try {
    await worker.scheduled({ cron: "*/20 * * * *", scheduledTime: Date.parse("2026-11-10T04:00:00Z") }, env, ctx);
  } finally { globalThis.fetch = realFetch; }
  assert.ok(up.calls.some((c) => c.url.includes("/timestamp/")));
  assert.equal((await d.prepare("SELECT status, btc_height FROM receipt_anchors").first()).status, "confirmed");
  assert.equal((await d.prepare("SELECT btc_height FROM receipt_anchors").first()).btc_height, 840123);
  const confirmedPage = await (await get("/anchors", { accept: "text/html" })).text();
  assert.match(confirmedPage, /class="an-confirmed"/);
  assert.match(confirmedPage, /Bitcoin block header attestation at height 840123/);
  const confirmedProof = await (await get("/v1/receipts/" + id("b") + "/proof")).json();
  assert.equal(confirmedProof.status, "confirmed");
  assert.equal(confirmedProof.bitcoin_confirmed, true);
  assert.equal(confirmedProof.btc_height, 840123);
  const confirmedCheck = await V.verifyAnchor(receipts[0], confirmedProof);
  assert.equal(confirmedCheck.ok, true);
  assert.equal(confirmedCheck.bitcoin_confirmed, true);
  assert.match(confirmedCheck.detail, /Bitcoin block header attestation/);

  const off = { ...env, ANCHORS: undefined };
  assert.equal((await worker.fetch(new Request("https://402xagent.com/anchors"), off, ctx)).status, 404);
  assert.equal((await worker.fetch(new Request("https://402xagent.com/anchors.json"), off, ctx)).status, 404);
  const llmsOff = await (await worker.fetch(new Request("https://402xagent.com/llms.txt"), off, ctx)).text();
  assert.doesNotMatch(llmsOff, /Receipt anchors/);
  const apiOff = await (await worker.fetch(new Request("https://api.402xagent.com/openapi.json"), off, ctx)).json();
  assert.equal(apiOff.paths["/anchors.json"], undefined);
  assert.equal(apiOff.paths["/v1/receipts/{id}/proof"], undefined);
  const docsOff = await (await worker.fetch(new Request("https://402xagent.com/docs/receipt-verification"), off, ctx)).text();
  assert.doesNotMatch(docsOff, /id="receipt-anchors"/);

  const llms = await (await get("/llms.txt")).text();
  assert.match(llms, /Receipt anchors \(0\.70\.0/);
  assert.match(llms, /not a Bitcoin confirmation/);
  assert.match(llms, /a\.pool\.opentimestamps\.org/);
  assert.match(llms, /b\.pool\.opentimestamps\.org/);
  const api = await (await worker.fetch(new Request("https://api.402xagent.com/openapi.json"), env, ctx)).json();
  assert.equal(api.info.version, "0.70.0");
  assert.ok(api.paths["/anchors.json"]);
  assert.ok(api.paths["/v1/receipts/{id}/proof"]);
  assert.match(JSON.stringify(api.paths["/v1/receipts/{id}/proof"]), /not a Bitcoin confirmation/);
  const docs = await (await get("/docs/receipt-verification")).text();
  assert.match(docs, /id="receipt-anchors"/);
  assert.match(docs, /not a Bitcoin confirmation/);
});

test("the nightly cron anchors only when ANCHORS=1, and the next run continues after the cursor", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-03T00:00:00Z");
  globalThis.fetch = () => { throw new Error("network used while off"); };
  try {
    await worker.scheduled({ cron: ANCHOR_CRON, scheduledTime: Date.parse("2026-11-10T03:41:00Z") }, { RECEIPTS_DB: d }, ctx);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 0);

  const mock = calendars();
  globalThis.fetch = mock.fetchImpl;
  try {
    await worker.scheduled({ cron: ANCHOR_CRON, scheduledTime: Date.parse("2026-11-10T03:41:00Z") }, envOf(d), ctx);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(mock.calls.filter((c) => c.method === "POST").length, 2);
  await put(d, { id: id("b"), verdict: "pay" }, "2026-11-04T00:00:00Z");
  const again = calendars();
  const second = await withNoNet(() => anchorNew(envOf(d), new Date("2026-11-11T03:41:00Z"), { fetchImpl: again.fetchImpl }));
  assert.equal(second.count, 1);
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 2);
  const idle = await withNoNet(() => anchorNew(envOf(d), new Date("2026-11-12T03:41:00Z"), { fetchImpl: calendars().fetchImpl }));
  assert.equal(idle.did, "idle");
});

test("a single receipt has an empty path whose root is the leaf", async () => {
  const d = db();
  const r = { id: id("a"), verdict: "pay" };
  await put(d, r, "2026-11-05T00:00:00Z");
  await withNoNet(() => anchorTick(envOf(d), new Date("2026-11-10T03:41:00Z"), { fetchImpl: calendars().fetchImpl }));
  const proof = await (await worker.fetch(new Request("https://402xagent.com/v1/receipts/" + r.id + "/proof"), envOf(d), ctx)).json();
  assert.deepEqual(proof.path, []);
  assert.equal(proof.receipt_hash, proof.root);
  assert.equal(proof.status, "pending");
  const check = await V.verifyAnchor(r, proof);
  assert.equal(check.ok, true);
  assert.equal(check.bitcoin_confirmed, false);
  const html = anchorsPageHtml("https://402xagent.com", [{ id: "an-0123456789abcdef", created_at: "2026-11-10T03:41:00Z", merkle_root: proof.root, receipt_count: 1, status: "pending", btc_height: null }]);
  assert.match(html, /ots verify/);
  assert.match(html, /Not a Bitcoin confirmation/);
  assert.doesNotMatch(html, /class="an-confirmed"/);
});

test("upgrade leaves a still-pending proof pending when the calendar has no Bitcoin attestation yet", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-06T00:00:00Z");
  await withNoNet(() => anchorTick(envOf(d), new Date("2026-11-10T03:41:00Z"), { fetchImpl: calendars().fetchImpl }));
  const still = await withNoNet(() => upgradePendingAnchors(envOf(d), new Date("2026-11-10T05:00:00Z"), { fetchImpl: calendars({ upgrade: false }).fetchImpl }));
  assert.equal(still.n, 0);
  assert.equal((await d.prepare("SELECT status FROM receipt_anchors").first()).status, "pending");
});
