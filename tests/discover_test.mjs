// 0.43.0 discovery: unit tests (input validation, SQL, freshness rules, signing, route + MCP wiring with a stub D1).
// Run: node tests/discover_test.mjs   (synthetic data only). Real-data checks run under wrangler dev (scripts/demo).
import assert from "node:assert/strict";
import { parseDiscover, discoverSql, shapeResult, discover, DiscoverInputError, DISCOVER_MAX, DISCOVER_PER_MIN } from "../worker/src/discover.js";
import { _addTestKey, _resetSigner, signingInput } from "../worker/src/sign.js";
import worker from "../worker/src/index.js";

const T = []; const test = (n, f) => T.push([n, f]);
const NOW = Date.parse("2026-10-20T19:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const H = 3600000;
const row = (id, verdict, ageH, extra = {}) => ({ id, url: `https://${id}.test/api`, verdict, reason: verdict + " reason", price_usd: 0.01, network: "eip155:8453", asset: "0xusdc", method: "GET", source_list: "cdp-bazaar", checked_at: iso(NOW - ageH * H), crawl_run: "receipts-test", ...extra });

// Stub D1 that evaluates the WHERE shape produced by discoverSql (LIKE words + verdict/cutoff) over an array.
function stubDb(rows) {
  const calls = [];
  return { calls, prepare(sql) {
    return { bind(...b) { this.b = b; return this; }, async first() { return { t: rows.map((r) => r.checked_at).sort().pop() || null }; },
      async all() {
        calls.push([sql, this.b]); const b = [...this.b]; const limit = b.pop();
        const words = (sql.match(/search LIKE/g) || []).length; const likes = b.splice(0, words).map((x) => x.slice(1, -1).replace(/\\(.)/g, "$1"));
        const cutoff = b[0];
        let out = rows.filter((r) => likes.every((w) => (r.url + " " + r.source_list).toLowerCase().includes(w)));
        if (sql.includes("verdict = 'pay' AND checked_at >= ?") && !sql.includes("recheck")) out = out.filter((r) => r.verdict === "pay" && r.checked_at >= cutoff);
        else if (sql.includes("verdict = 'skip'")) out = out.filter((r) => r.verdict === "skip");
        else if (sql.includes("verdict = 'recheck' OR")) out = out.filter((r) => r.verdict === "recheck" || (r.verdict === "pay" && r.checked_at < cutoff));
        out.sort((a, c) => (a.checked_at < c.checked_at ? 1 : -1));
        return { results: out.slice(0, limit) };
      } };
  } };
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

test("SQL is parameterized; pay filter excludes pays older than 7 days; recheck includes them", () => {
  const p = discoverSql(parseDiscover({ q: "weather", verdict: "pay", limit: "5" }), NOW);
  assert.ok(!p.sql.includes("weather")); assert.deepEqual(p.binds, ["%weather%", iso(NOW - 7 * 24 * H), 5]);
  assert.match(discoverSql(parseDiscover({ verdict: "recheck" }), NOW).sql, /verdict = 'recheck' OR \(verdict = 'pay' AND checked_at < \?\)/);
  assert.equal(discoverSql(parseDiscover({ q: "a_b" }), NOW).binds[0], "%a\\_b%");
});

test("freshness: <36h fresh; >36h stale; pay >7d -> recheck with original_verdict; skip keeps reason", async () => {
  const f = await shapeResult({}, row("a", "pay", 2), "https://o", NOW);
  assert.equal(f.stale, false); assert.equal(f.verdict, "pay"); assert.equal(f.original_verdict, undefined);
  const s = await shapeResult({}, row("b", "pay", 40), "https://o", NOW);
  assert.equal(s.stale, true); assert.equal(s.verdict, "pay");
  const e = await shapeResult({}, row("c", "pay", 7 * 24 + 1), "https://o", NOW);
  assert.equal(e.verdict, "recheck"); assert.equal(e.original_verdict, "pay"); assert.equal(e.receipt.verdict, "recheck");
  const k = await shapeResult({}, row("d", "skip", 7 * 24 + 1), "https://o", NOW);
  assert.equal(k.verdict, "skip"); assert.equal(k.reason, "skip reason");
  for (const key of ["endpoint", "verified_price_usd", "last_checked", "verdict", "reason", "receipt", "receipt_url"]) assert.ok(key in f, key);
  assert.equal(f.receipt.signature, null);
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

test("discover(): skips shown by default, verdict filter, limit cap, index_stale, 400/503", async () => {
  const rows = [row("p1", "pay", 1), row("p2", "pay", 200), row("s1", "skip", 3), row("r1", "recheck", 5)];
  const env = { RECEIPTS_DB: stubDb(rows) };
  const all = await discover(env, {}, "https://o", NOW);
  assert.equal(all.status, 200); assert.equal(all.body.count, 4); assert.ok(all.body.results.some((r) => r.verdict === "skip"));
  assert.equal(all.body.index_stale, false);
  assert.deepEqual((await discover(env, { verdict: "pay" }, "https://o", NOW)).body.results.map((r) => r.endpoint), ["https://p1.test/api"]);
  assert.deepEqual((await discover(env, { verdict: "recheck" }, "https://o", NOW)).body.results.map((r) => r.verdict), ["recheck", "recheck"]);
  assert.equal((await discover(env, { limit: "1" }, "https://o", NOW)).body.count, 1);
  assert.equal((await discover(env, { q: "!" }, "https://o", NOW)).status, 400);
  assert.equal((await discover({}, {}, "https://o", NOW)).status, 503);
});

test("route /v1/discover: 200, unknown param 400, rate limit 429 after DISCOVER_PER_MIN; MCP tool listed and callable", async () => {
  const counts = new Map();
  const QUOTA = { idFromName: (n) => n, get: (n) => ({ fetch: async (u) => { const q = new URL(u).searchParams; const k = n + q.get("day") + q.get("counter"); const used = (counts.get(k) || 0) + 1; counts.set(k, used); return Response.json({ free: used <= +q.get("limit"), used }); } }) };
  const env = { RECEIPTS_DB: stubDb([row("p1", "pay", 1), row("s1", "skip", 2)]), QUOTA };
  const get = (p, h = {}) => worker.fetch(new Request("https://api.402xagent.com" + p, { headers: { "cf-connecting-ip": "203.0.113.9", ...h } }), env, { waitUntil() {} });
  const r = await get("/v1/discover?q=test&limit=5"); assert.equal(r.status, 200);
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
