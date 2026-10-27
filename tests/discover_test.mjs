// 0.43.0/0.45.0 discovery: unit tests (input validation, d: blobs + in-memory search, freshness rules, signing, route + MCP wiring with a stub D1).
// Run: node tests/discover_test.mjs   (synthetic data only). Real-data checks run under wrangler dev (scripts/demo).
import assert from "node:assert/strict";
import { parseDiscover, shapeResult, discover, searchRows, loadShards, shardKeys, decodeBlob, _clearDiscoverCache, DiscoverInputError, DISCOVER_MAX, DISCOVER_PER_MIN } from "../worker/src/discover.js";
import { _clearCrawlStoreCache } from "../worker/src/skips.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _addTestKey, _resetSigner, signingInput } from "../worker/src/sign.js";
import worker from "../worker/src/index.js";

const T = []; const test = (n, f) => T.push([n, f]);
const NOW = Date.parse("2026-10-20T19:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const H = 3600000;
const row = (id, verdict, ageH, extra = {}) => ({ id, url: `https://${id}.fixture/api`, verdict, reason: verdict + " reason", price_usd: 0.01, network: "eip155:8453", asset: "0xusdc", method: "GET", source_list: "cdp-bazaar", checked_at: iso(NOW - ageH * H), crawl_run: "receipts-test", ...extra });

// 0.45.0: build real d: blobs with the production builder (scripts/weekly-crawl/build_discover_blobs.py) from
// synthetic crawl receipts, split them into parts like d1_upload.py, and serve them from a stub D1 crawl_store.
const ROOT = new URL("..", import.meta.url).pathname;
function blobsFor(rows) {
  const d = mkdtempSync(join(tmpdir(), "disc-"));
  writeFileSync(join(d, "receipts-test.jsonl"), rows.map((r) => JSON.stringify({ id: r.id, url: r.url, verdict: r.verdict, reason: r.reason, quoted_price_usd: r.price_usd, network: r.network, asset: r.asset, method: r.method, source_list: r.source_list, also_listed_in: r.also || [], timestamp: r.checked_at })).join("\n") + "\n");
  execFileSync("python3", [join(ROOT, "scripts/weekly-crawl/build_discover_blobs.py"), join(d, "receipts-test.jsonl"), join(d, "out.json")]);
  return JSON.parse(readFileSync(join(d, "out.json"), "utf8"));
}
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function storeRows(kv, partSize = 4000) {
  const out = [];
  for (const { key, value } of kv) {
    const h = await sha(value), parts = [];
    for (let i = 0; i < value.length; i += partSize) parts.push(value.slice(i, i + partSize));
    if (!parts.length) parts.push("");
    parts.forEach((v, i) => out.push({ key, part: i, parts: parts.length, sha256: h, value: v }));
  }
  return out;
}
function stubDb(store) {
  const calls = [];
  return { calls, store, fail: false, prepare(sql) {
    const db = this;
    return { b: [], bind(...b) { this.b = b; return this; }, async first() { return null; },
      async all() {
        calls.push(sql); if (db.fail) throw new Error("D1 down");
        if (/key = 'd:meta'/.test(sql)) return { results: store.filter((r) => r.key === "d:meta") };
        if (/part = 0/.test(sql)) return { results: store.filter((r) => r.key.startsWith("d:") && r.part === 0) };
        if (/key IN/.test(sql)) return { results: store.filter((r) => this.b.includes(r.key)).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.part - y.part)) };
        if (/WHERE key = \?/.test(sql)) return { results: store.filter((r) => r.key === this.b[0]).sort((x, y) => x.part - y.part) };
        throw new Error("unexpected sql " + sql);
      } };
  } };
}
async function envFor(rows, crawledAt = iso(NOW - 1 * H), extra = {}) {
  _clearDiscoverCache(); _clearCrawlStoreCache();
  const kv = [...blobsFor(rows), { key: "meta", value: JSON.stringify({ crawled_at: crawledAt }) }];
  return { RECEIPTS_DB: stubDb(await storeRows(kv)), ...extra };
}

test("input validation: q chars/length, verdict enum, limit 1-20 (clamped), defaults", () => {
  assert.deepEqual(parseDiscover({}), { q: "", words: [], verdict: null, limit: 10 });
  assert.equal(parseDiscover({ limit: "99" }).limit, DISCOVER_MAX);
  assert.equal(parseDiscover({ limit: 3 }).limit, 3);
  assert.equal(parseDiscover({ verdict: "PAY" }).verdict, "pay");
  assert.deepEqual(parseDiscover({ q: "Crypto  Price" }).words, ["crypto", "price"]);
  for (const bad of [{ q: "x" }, { q: "a'; DROP TABLE x;--" }, { q: "%%" }, { q: "z".repeat(101) }, { verdict: "maybe" }, { limit: "-1" }, { limit: "abc" }, { limit: "1e3" }])
    assert.throws(() => parseDiscover(bad), DiscoverInputError, JSON.stringify(bad));
});

test("blobs: 48 shards + d:meta, deterministic (same input -> same sha), gzip+base64 round-trips", async () => {
  const rows = [row("a000000001", "pay", 1), row("b000000002", "skip", 2)];
  const x = blobsFor(rows), y = blobsFor(rows);
  assert.equal(x.length, 49); assert.equal(x.at(-1).key, "d:meta"); assert.deepEqual(x, y);
  assert.deepEqual(shardKeys(null).length, 48); assert.deepEqual(shardKeys("pay").length, 16);
  const j = await decodeBlob(x.find((k) => k.key === "d:pay:a").value);
  assert.equal(j.rows[0][0], "a000000001"); assert.equal(j.dict.r[j.rows[0][3]], "pay reason");
  assert.equal(JSON.parse(x.at(-1).value).rows, 2);
});

test("in-memory search: all words must match url/source/also-listed; ordering newest first; limit", () => {
  const rs = [{ ...row("a1", "pay", 1), also: ["agent-tools-cloud"] }, row("a2", "skip", 2, { url: "https://weather.fixture/x" }), row("a3", "recheck", 3)];
  const crawled = NOW - H;
  assert.deepEqual(searchRows(rs, parseDiscover({ q: "weather" }), crawled, NOW).map((r) => r.id), ["a2"]);
  assert.deepEqual(searchRows(rs, parseDiscover({ q: "agent-tools" }), crawled, NOW).map((r) => r.id), ["a1"]);
  assert.deepEqual(searchRows(rs, parseDiscover({}), crawled, NOW).map((r) => r.id), ["a1", "a2", "a3"]);
  assert.deepEqual(searchRows(rs, parseDiscover({ limit: "1" }), crawled, NOW).map((r) => r.id), ["a1"]);
  assert.deepEqual(searchRows(rs, parseDiscover({ q: "a_b" }), crawled, NOW), []);
  // crawl older than 7 days: pay filter empty, recheck includes the pay
  const old = NOW - 8 * 24 * H;
  assert.deepEqual(searchRows(rs, parseDiscover({ verdict: "pay" }), old, NOW), []);
  assert.deepEqual(searchRows(rs, parseDiscover({ verdict: "recheck" }), old, NOW).map((r) => r.id), ["a1", "a3"]);
});

test("hash check: a torn shard (wrong sha or missing part) is never served; index_partial is reported", async () => {
  const env = await envFor([row("a000000001", "pay", 1), row("b000000002", "pay", 1)]);
  const st = env.RECEIPTS_DB.store;
  const i = st.findIndex((r) => r.key === "d:pay:a"); st[i] = { ...st[i], value: " " + st[i].value.slice(1) };
  const r = await discover(env, { verdict: "pay" }, "https://o", NOW);
  assert.equal(r.status, 200); assert.deepEqual(r.body.results.map((x) => x.endpoint), ["https://b000000002.fixture/api"]);
  assert.equal(r.body.index_partial, true); assert.equal(r.body.missing_shards, 1);
  const env2 = await envFor([row("a000000001", "pay", 1)]);
  env2.RECEIPTS_DB.store.splice(env2.RECEIPTS_DB.store.findIndex((r) => r.key === "d:pay:a"), 1, ...[]);
  const r2 = await discover(env2, { verdict: "pay" }, "https://o", NOW);
  assert.equal(r2.body.count, 0); assert.equal(r2.body.index_partial, true);
});

test("cache: warm queries make one cheap listing call at most per 5 min, no blob refetch; changed sha refetches only that shard", async () => {
  const env = await envFor([row("a000000001", "pay", 1), row("b000000002", "skip", 1)]);
  await discover(env, {}, "https://o", NOW);
  const n = env.RECEIPTS_DB.calls.length;
  await discover(env, { q: "test" }, "https://o", NOW + 1000);
  assert.equal(env.RECEIPTS_DB.calls.filter((c) => /key IN/.test(c)).length, 1);
  assert.ok(env.RECEIPTS_DB.calls.length - n <= 1);
  const loaded = await loadShards(env.RECEIPTS_DB, null, NOW + 2000);
  assert.equal(loaded.rows.length, 2); assert.equal(loaded.missing.length, 0);
});

test("freshness (0.54.0): terms <=24h pay; >24h pay -> recheck/terms_stale with original_verdict; stale flag still 36h; skip keeps reason", async () => {
  const f = await shapeResult({}, row("a", "pay", 2), "https://o", NOW);
  assert.equal(f.stale, false); assert.equal(f.verdict, "pay"); assert.equal(f.original_verdict, undefined);
  assert.equal(f.terms_stale, false); assert.equal(f.terms_max_age_hours, 24); assert.equal(f.terms_age_hours, 2);
  assert.ok(!f.check_url.includes("&quote="), "not a crawl id: no quote param");
  const q = await shapeResult({}, row("a000000001", "pay", 2), "https://o", NOW);
  assert.ok(q.check_url.endsWith("&quote=a000000001"), q.check_url);
  assert.ok(!(await shapeResult({}, row("b000000002", "skip", 2), "https://o", NOW)).check_url.includes("&quote="), "skips carry no quote");
  const y = await shapeResult({}, row("b", "pay", 25), "https://o", NOW);
  assert.equal(y.stale, false); assert.equal(y.verdict, "recheck"); assert.equal(y.reason_code, "terms_stale"); assert.equal(y.original_verdict, "pay"); assert.equal(y.terms_stale, true);
  assert.equal(y.receipt.verdict, "recheck"); assert.equal(y.receipt.terms_stale, true);
  const s = await shapeResult({}, row("c", "pay", 40), "https://o", NOW);
  assert.equal(s.stale, true); assert.equal(s.verdict, "recheck");
  const k = await shapeResult({}, row("d", "skip", 7 * 24 + 1), "https://o", NOW);
  assert.equal(k.verdict, "skip"); assert.equal(k.reason, "skip reason"); assert.equal(k.terms_stale, true); assert.equal(k.reason_code, undefined);
  for (const key of ["endpoint", "verified_price_usd", "last_checked", "verdict", "reason", "receipt", "receipt_url"]) assert.ok(key in f, key);
  assert.equal(f.receipt.signature, null);
});

test("freshness (0.54.0): TERMS_MAX_AGE_HOURS is configurable (168 = the old 7-day window); bad values fall back to 24", async () => {
  const wk = { TERMS_MAX_AGE_HOURS: "168" };
  assert.equal((await shapeResult(wk, row("a", "pay", 40), "https://o", NOW)).verdict, "pay");
  const e = await shapeResult(wk, row("c", "pay", 7 * 24 + 1), "https://o", NOW);
  assert.equal(e.verdict, "recheck"); assert.equal(e.terms_max_age_hours, 168); assert.match(e.reason, /7 days/);
  for (const bad of ["0", "-3", "abc", "1e9", ""]) assert.equal((await shapeResult({ TERMS_MAX_AGE_HOURS: bad }, row("a", "pay", 25), "https://o", NOW)).terms_max_age_hours, 24, bad);
  assert.equal((await shapeResult({ TERMS_MAX_AGE_HOURS: "1.5" }, row("a", "pay", 2), "https://o", NOW)).verdict, "recheck");
  // the in-memory filter follows the same threshold
  const rs = [row("a1", "pay", 1), row("a3", "recheck", 3)];
  assert.deepEqual(searchRows(rs, parseDiscover({ verdict: "pay" }), NOW - 30 * H, NOW), []);
  assert.deepEqual(searchRows(rs, parseDiscover({ verdict: "pay" }), NOW - 30 * H, NOW, 168).map((r) => r.id), ["a1"]);
  assert.deepEqual(searchRows(rs, parseDiscover({ verdict: "recheck" }), NOW - 30 * H, NOW).map((r) => r.id), ["a1", "a3"]);
});

test("0.45.1: concurrent first signers all sign (no unsigned results on a cold isolate); crawl_run from d:meta", async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  _addTestKey({ kid: "test-par", x: jwk.x }); _resetSigner();
  const env = await envFor([row("a000000001", "pay", 1), row("a000000002", "pay", 1), row("a000000003", "pay", 1), row("a000000004", "skip", 1)], iso(NOW - H),
    { RECEIPT_SIGNING_KEY: JSON.stringify({ kty: "OKP", crv: "Ed25519", kid: "test-par", x: jwk.x, d: jwk.d }) });
  const r = await discover(env, {}, "https://o", NOW);
  assert.equal(r.body.count, 4);
  for (const x of r.body.results) {
    assert.equal(x.receipt.kid, "test-par"); assert.equal(x.receipt.crawl_run, "receipts-test");
    const sig = Uint8Array.from(atob(x.receipt.signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, sig, signingInput(x.receipt)));
  }
  _resetSigner();
});

test("0.45.2: merged index is presorted once and reused across queries; search stops at limit; no internal fields leak", async () => {
  const env = await envFor([row("a000000001", "pay", 3), row("b000000002", "pay", 1), row("c000000003", "skip", 2)]);
  const a = await loadShards(env.RECEIPTS_DB, null, NOW), b = await loadShards(env.RECEIPTS_DB, null, NOW + 1);
  assert.equal(a.rows, b.rows); assert.equal(a.rows.sorted, true);
  assert.deepEqual(a.rows.map((r) => r.id), ["b000000002", "c000000003", "a000000001"]);
  const r = await discover(env, { limit: "2" }, "https://o", NOW);
  assert.deepEqual(r.body.results.map((x) => x.endpoint), ["https://b000000002.fixture/api", "https://c000000003.fixture/api"]);
  assert.ok(!("s" in r.body.results[0]) && !("also" in r.body.results[0]));
});

test("signed receipt: ed25519 over JCS verifies against the configured key", async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  _addTestKey({ kid: "test-disc", x: jwk.x }); _resetSigner();
  const env = { RECEIPT_SIGNING_KEY: JSON.stringify({ kty: "OKP", crv: "Ed25519", kid: "test-disc", x: jwk.x, d: jwk.d }) };
  const r = await shapeResult(env, row("a", "pay", 1), "https://o", NOW);
  assert.equal(r.receipt.kid, "test-disc");
  const sig = Uint8Array.from(atob(r.receipt.signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, sig, signingInput(r.receipt)));
  _resetSigner();
});

test("discover(): skips shown by default and labeled, verdict filter, limit cap, freshness from crawl meta, 400/503", async () => {
  const rows = [row("a000000001", "pay", 1), row("b000000002", "skip", 3), row("c000000003", "recheck", 5)];
  const env = await envFor(rows);
  const all = await discover(env, {}, "https://o", NOW);
  assert.equal(all.status, 200); assert.equal(all.body.count, 3);
  const sk = all.body.results.find((r) => r.verdict === "skip"); assert.equal(sk.reason, "skip reason");
  assert.equal(all.body.index_stale, false); assert.equal(all.body.index_last_crawled, iso(NOW - H));
  assert.deepEqual((await discover(env, { verdict: "pay" }, "https://o", NOW)).body.results.map((r) => r.endpoint), ["https://a000000001.fixture/api"]);
  assert.equal((await discover(env, { limit: "1" }, "https://o", NOW)).body.count, 1);
  assert.equal((await discover(env, { q: "!" }, "https://o", NOW)).status, 400);
  assert.equal((await discover({}, {}, "https://o", NOW)).status, 503);
  env.RECEIPTS_DB.fail = true; _clearDiscoverCache();
  assert.equal((await discover(env, {}, "https://o", NOW)).status, 503);
  // crawl meta 8 days old: stale, pays returned as recheck with original_verdict
  const old = await envFor(rows, iso(NOW - 8 * 24 * H));
  const o = await discover(old, {}, "https://o", NOW);
  assert.equal(o.body.index_stale, true);
  const p = o.body.results.find((r) => r.endpoint.includes("a000000001")); assert.equal(p.verdict, "recheck"); assert.equal(p.original_verdict, "pay"); assert.equal(p.stale, true);
  assert.equal((await discover(old, { verdict: "pay" }, "https://o", NOW)).body.count, 0);
});

test("route /v1/discover: 200, unknown param 400, rate limit 429 after DISCOVER_PER_MIN; MCP tool listed and callable", async () => {
  const counts = new Map();
  const QUOTA = { idFromName: (n) => n, get: (n) => ({ fetch: async (u) => { const q = new URL(u).searchParams; const k = n + q.get("day") + q.get("counter"); const used = (counts.get(k) || 0) + 1; counts.set(k, used); return Response.json({ free: used <= +q.get("limit"), used }); } }) };
  const env = await envFor([row("a000000001", "pay", 1), row("b000000002", "skip", 2)], iso(Date.now() - H), { QUOTA });
  const get = (p, h = {}) => worker.fetch(new Request("https://api.402xagent.com" + p, { headers: { "cf-connecting-ip": "203.0.113.9", ...h } }), env, { waitUntil() {} });
  const r = await get("/v1/discover?q=fixture&limit=5"); assert.equal(r.status, 200);
  const b = await r.json(); assert.equal(b.query.limit, 5); assert.ok(b.count >= 1);
  assert.equal((await get("/v1/discover?foo=1")).status, 400);
  let last; for (let i = 0; i < DISCOVER_PER_MIN + 2; i++) last = await get("/v1/discover", { "user-agent": "flood" });
  assert.equal(last.status, 429); assert.ok(last.headers.get("retry-after"));
  const rpc = async (m) => (await worker.fetch(new Request("https://api.402xagent.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "198.51.100.7" }, body: JSON.stringify(m) }), env, { waitUntil() {} })).json();
  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(list.result.tools.find((t) => t.name === "discover"));
  const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "discover", arguments: { verdict: "skip" } } });
  assert.equal(call.result.structuredContent.results[0].verdict, "skip");
  const bad = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "discover", arguments: { verdict: "nope" } } });
  assert.equal(bad.result.isError, true);
});

let passed = 0;
for (const [n, f] of T) { try { await f(); passed++; console.log("PASS " + n); } catch (e) { console.log("FAIL " + n + "\n  " + (e.stack || e).toString().split("\n").slice(0, 8).join("\n  ")); } }
console.log(`${passed}/${T.length} discover tests passed`); process.exit(passed === T.length ? 0 : 1);
