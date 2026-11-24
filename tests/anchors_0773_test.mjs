// 0.77.3: the stored .ots proof must come back out of D1 as bytes. D1 returns a BLOB column as a plain
// Array of numbers, so before this version /anchors/<id>.ots was a 200 with an empty body even though
// the proof was stored. These tests use a D1-shaped wrapper (blobs come back as Arrays) so they fail on 0.77.2.
// Calendar HTTP is mocked. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import { sqliteD1 } from "./helpers/sqlite_d1.mjs";
import { sha256, hex, hexToBytes, OTS_HEADER, pendingCalendarBody, bitcoinUpgradeBody, parseDetached, serializeDetached, hasBitcoin, walkAttestations } from "../worker/src/ots.js";
import { anchorTick, anchorsPageHtml, asBytes, OTS_RE } from "../worker/src/anchors.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FIX = join(ROOT, "fixtures", "anchors");
const meta = JSON.parse(readFileSync(join(FIX, "an-1063df4cc4c91307.json"), "utf8"));
const fixture = new Uint8Array(readFileSync(join(FIX, "an-1063df4cc4c91307.ots")));
const utf8 = (s) => new TextEncoder().encode(s);
const ctx = { waitUntil() {}, passThroughOnException() {} };
const realFetch = globalThis.fetch;
const startsWithMagic = (b) => OTS_HEADER.every((x, i) => b[i] === x);

// D1 hands BLOB columns back as Arrays of numbers. Wrap node:sqlite so rows look like that.
function d1Shaped(inner) {
  const conv = (row) => {
    if (!row) return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = v instanceof Uint8Array ? Array.from(v) : v;
    return out;
  };
  const wrap = (stmt) => ({
    bind: (...a) => wrap(stmt.bind(...a)),
    first: async () => conv(await stmt.first()),
    all: async () => { const r = await stmt.all(); return { ...r, results: (r.results || []).map(conv) }; },
    run: () => stmt.run(),
    _run: () => stmt._run(),
  });
  return { raw: inner.raw, prepare: (sql) => wrap(inner.prepare(sql)), batch: (st) => inner.batch(st.map((s) => s._inner || s)) };
}
const id = (ch) => "sc-" + ch.repeat(16);
function put(d, receipt, at) {
  return d.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, body) VALUES (?, ?, ?, ?, 'price_ok', 'live', ?)")
    .bind(receipt.id, "https://seller.example/" + receipt.id, at, receipt.verdict, JSON.stringify(receipt)).run();
}
function calendars({ upgrade = false } = {}) {
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const host = new URL(u).host;
    if (u.endsWith("/digest")) return new Response(pendingCalendarBody(new Uint8Array(init.body), u.slice(0, -"/digest".length), utf8(host)));
    if (u.includes("/timestamp/")) {
      if (!upgrade) return new Response("not yet", { status: 404 });
      return new Response(bitcoinUpgradeBody(hexToBytes(u.split("/timestamp/")[1]), 840123));
    }
    throw new Error("unexpected " + u);
  };
  return { fetchImpl };
}
const envOf = (d) => ({ ANCHORS: "1", RECEIPTS_DB: d, BAZAAR_PAGE: "off", DAILY_RECHECK: "off", STALE_RECHECK: "off" });
async function withNoNet(fn) {
  globalThis.fetch = () => { throw new Error("network used"); };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}
const get = (env, path, method = "GET") => worker.fetch(new Request("https://402xagent.com" + path, { method }), env, ctx);
async function seedAnchor(raw, anchorTime = "2026-11-19T03:41:00Z") {
  for (const [i, ch] of ["a", "b", "c"].entries()) await put(raw, { id: id(ch), verdict: "pay" }, `2026-11-18T00:00:0${i}Z`);
  const out = await withNoNet(() => anchorTick(envOf(raw), new Date(anchorTime), { fetchImpl: calendars().fetchImpl }));
  assert.equal(out.created.did, "created");
  return out.created.id;
}

test("0.77.3 version", () => assert.equal(VERSION, "0.80.0"));

test("asBytes turns a D1 BLOB (Array of numbers) into the same bytes, and never invents bytes", () => {
  assert.deepEqual(Array.from(asBytes([0, 79, 112, 255])), [0, 79, 112, 255]);
  assert.deepEqual(Array.from(asBytes(new Uint8Array([1, 2]))), [1, 2]);
  assert.deepEqual(Array.from(asBytes(new Uint8Array([3, 4]).buffer)), [3, 4]);
  assert.equal(asBytes(null).length, 0);
  assert.equal(asBytes(undefined).length, 0);
});

test("OTS route matches .ots and .bin.ots only for a well-formed id", () => {
  for (const ok of ["/anchors/an-1063df4cc4c91307.ots", "/anchors/an-1063df4cc4c91307.bin.ots"]) assert.equal(OTS_RE.exec(ok)[1], "an-1063df4cc4c91307", ok);
  for (const bad of ["/anchors/an-1063df4cc4c91307.bin", "/anchors/an-1063df4cc4c9130.ots", "/anchors/an-1063df4cc4c91307.bin.bin.ots", "/anchors/../an-1063df4cc4c91307.ots", "/anchors/an-1063df4cc4c91307.ots/x"]) assert.equal(OTS_RE.test(bad), false, bad);
});

test("real captured proof (an-1063df4cc4c91307): magic, sha256 file-hash op, digest, and both calendars", () => {
  assert.equal(fixture.length, meta.ots_bytes);
  assert.equal(startsWithMagic(fixture), true);
  const det = parseDetached(fixture);
  assert.equal(hex(det.digest), meta.file_sha256);
  assert.equal(hex(det.digest), createHash("sha256").update(Buffer.from(meta.merkle_root, "hex")).digest("hex"), "digest is SHA-256 of the raw 32-byte root");
  assert.equal(hasBitcoin(det.timestamp), false);
  const uris = walkAttestations(det.timestamp).filter((x) => x.att.kind === "pending").map((x) => x.att.uri).sort();
  assert.deepEqual(uris, meta.calendars);
  assert.equal(hex(serializeDetached(det.digest, det.timestamp)), hex(fixture), "re-serialising the parsed proof gives the same bytes");
});

test("the route serves a prod-shaped stored proof byte for byte, on .ots and .bin.ots, GET and HEAD", async () => {
  const raw = sqliteD1();
  await raw.prepare("INSERT INTO receipt_anchors (id, created_at, merkle_root, file_sha256, receipt_count, first_receipt_id, last_receipt_id, first_created_at, last_created_at, status, ots_proof, calendars) VALUES (?, ?, ?, ?, 2000, 'a', 'b', 'x', 'y', 'pending', ?, ?)")
    .bind(meta.id, meta.created_at, meta.merkle_root, meta.file_sha256, fixture, JSON.stringify(meta.calendars)).run();
  const env = envOf(d1Shaped(raw));
  const stored = await env.RECEIPTS_DB.prepare("SELECT ots_proof FROM receipt_anchors WHERE id = ?").bind(meta.id).first();
  assert.equal(Array.isArray(stored.ots_proof), true, "the wrapper must look like D1 (Array), otherwise this test proves nothing");
  for (const path of ["/anchors/" + meta.id + ".ots", "/anchors/" + meta.id + ".bin.ots"]) {
    const res = await get(env, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), "application/vnd.opentimestamps.ots");
    assert.equal(res.headers.get("content-length"), String(fixture.length));
    assert.match(res.headers.get("content-disposition"), /filename="an-1063df4cc4c91307\.bin\.ots"/);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.equal(body.length, 373);
    assert.equal(startsWithMagic(body), true);
    assert.equal(hex(body), hex(fixture));
    const head = await get(env, path, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "373");
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
});

test("a fresh nightly anchor is stored with, and served with, a non-empty proof naming both calendars", async () => {
  const raw = sqliteD1();
  const aid = await seedAnchor(raw);
  const env = envOf(d1Shaped(raw));
  const res = await get(env, "/anchors/" + aid + ".ots");
  assert.equal(res.status, 200);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.ok(body.length > OTS_HEADER.length + 32);
  assert.equal(res.headers.get("content-length"), String(body.length));
  assert.equal(startsWithMagic(body), true);
  const row = raw.raw.prepare("SELECT merkle_root, ots_proof FROM receipt_anchors WHERE id = ?").get(aid);
  assert.equal(hex(body), hex(new Uint8Array(row.ots_proof)));
  const det = parseDetached(body);
  assert.equal(hex(det.digest), hex(sha256(hexToBytes(row.merkle_root))));
  const uris = walkAttestations(det.timestamp).filter((x) => x.att.kind === "pending").map((x) => x.att.uri).sort();
  assert.deepEqual(uris, ["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org"]);
});

test("never a 200 with an empty body: missing proof is 404, empty or non-OTS proof is 503, unknown id is 404", async () => {
  const raw = sqliteD1();
  const ins = (aid, proof) => raw.prepare("INSERT INTO receipt_anchors (id, created_at, merkle_root, file_sha256, receipt_count, first_receipt_id, last_receipt_id, first_created_at, last_created_at, status, ots_proof, calendars) VALUES (?, '2026-11-19T03:41:00Z', 'r', 'f', 1, 'a', 'a', 'x', 'x', 'pending', ?, '[]')").bind(aid, proof).run();
  await ins("an-0000000000000002", new Uint8Array(0));
  await ins("an-0000000000000003", new Uint8Array([1, 2, 3, 4]));
  const env = envOf(d1Shaped(raw));
  // The column is NOT NULL, so a NULL proof can only come from a store that drops the value. Stub that.
  const nullEnv = envOf({ prepare: () => ({ bind: () => ({ first: async () => ({ id: "an-0000000000000001", status: "pending", ots_proof: null }) }) }) });
  for (const suffix of [".ots", ".bin.ots"]) {
    const none = await get(nullEnv, "/anchors/an-0000000000000001" + suffix);
    assert.equal(none.status, 404);
    assert.match(none.headers.get("content-type"), /json/);
    for (const n of ["2", "3"]) {
      const res = await get(env, "/anchors/an-000000000000000" + n + suffix);
      assert.equal(res.status, 503, n);
      assert.equal(res.headers.get("retry-after"), "60");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal((await res.json()).error, "proof not ready");
    }
    assert.equal((await get(env, "/anchors/an-00000000000000ff" + suffix)).status, 404);
  }
});

test("the /anchors page links to a path that works", async () => {
  const raw = sqliteD1();
  const aid = await seedAnchor(raw);
  const env = envOf(d1Shaped(raw));
  const html = await (await get(env, "/anchors")).text();
  const m = html.match(/href="(\/anchors\/an-[0-9a-f]{16}\.bin\.ots)"/);
  assert.ok(m, "page links to the .bin.ots name");
  assert.equal(m[1], "/anchors/" + aid + ".bin.ots");
  const res = await get(env, m[1]);
  assert.equal(res.status, 200);
  assert.ok((await res.arrayBuffer()).byteLength > 100);
  assert.match(anchorsPageHtml("https://402xagent.com", [{ id: "an-1063df4cc4c91307", created_at: "2026-11-19T03:41:32Z", merkle_root: "r", receipt_count: 1, status: "pending" }]), /href="\/anchors\/an-1063df4cc4c91307\.bin\.ots"/);
  const js = await (await get(env, "/anchors.json")).json();
  assert.equal(js.anchors[0].ots, "https://402xagent.com/anchors/" + aid + ".ots", "documented path unchanged");
});

test("the nightly upgrade can read the stored proof back from D1 and confirms it", async () => {
  const raw = sqliteD1();
  const aid = await seedAnchor(raw);
  const d = d1Shaped(raw);
  const out = await withNoNet(() => anchorTick(envOf(d), new Date("2026-11-20T03:41:00Z"), { fetchImpl: calendars({ upgrade: true }).fetchImpl }));
  assert.equal(out.upgraded.n, 1, "0.77.2 read an empty proof here and upgraded nothing");
  const row = raw.raw.prepare("SELECT status, btc_height, ots_proof FROM receipt_anchors WHERE id = ?").get(aid);
  assert.equal(row.status, "confirmed");
  assert.equal(row.btc_height, 840123);
  const res = await get(envOf(d), "/anchors/" + aid + ".bin.ots");
  assert.equal(res.status, 200);
  assert.equal(hasBitcoin(parseDetached(new Uint8Array(await res.arrayBuffer())).timestamp), true);
});
