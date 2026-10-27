// 0.50.0 x402 hygiene scorer + free GET /v1/hygiene. All data synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hygiene, gradeOf, handleHygiene, HYGIENE_FREE_PER_DAY, HYGIENE_TTL_S, cachedHygiene } from "../worker/src/hygiene.js";
import { GOOD, BAZAAR_MISMATCH, FRANTIC_MIX, V1_OK, v2 } from "./fixtures/hygiene.mjs";
import { VERSION } from "../worker/src/lib.js";
import worker from "../worker/src/index.js";
import { readFileSync } from "node:fs";

const codes = (r) => r.deductions.map((d) => d.code).sort();
const sum = (r) => r.deductions.reduce((a, d) => a + d.points, 0);

test("0.56.0 version", () => assert.equal(VERSION, "0.56.0"));

test("good fixture: 100 / A, no deductions, 402 discipline scored", () => {
  const r = hygiene(GOOD);
  assert.deepEqual([r.score, r.grade, r.deductions.length], [100, "A", 0]);
  assert.deepEqual(Object.keys(r).sort(), ["deductions", "grade", "na", "score"]);
});

test("v1-only seller is neutral (no deduction for an older valid version)", () => {
  const r = hygiene(V1_OK);
  assert.equal(r.score, 100);
  assert.equal(r.grade, "A");
});

test("Frantic-style v1/v2 mix: version_inconsistent with the fix note; latency half", () => {
  const r = hygiene(FRANTIC_MIX);
  const d = r.deductions.find((x) => x.code === "version_inconsistent");
  assert.ok(d && d.points === 20);
  assert.match(d.fix, /one x402Version/);
  assert.ok(r.deductions.find((x) => x.code === "latency_slow" && x.points === 5));
  assert.equal(r.score, 100 - sum(r));
  assert.ok(r.score < 90);
});

test("CDP Bazaar network mismatch: network_mismatch deduction", () => {
  const r = hygiene(BAZAAR_MISMATCH);
  assert.deepEqual(codes(r), ["network_mismatch"]);
  assert.equal(r.score, 90);
  assert.equal(r.grade, "A");
});

test("amount and timeout sanity", () => {
  const bad = { ...GOOD, headers: {}, bodyText: JSON.stringify(v2({ amount: "0.01", maxTimeoutSeconds: 5 })) };
  assert.deepEqual(codes(hygiene(bad)), ["amount_not_atomic", "timeout_out_of_range"]);
  const huge = { ...GOOD, headers: {}, bodyText: JSON.stringify(v2({ amount: "99999999999999" })) };
  assert.deepEqual(codes(hygiene(huge)), ["amount_implausible"]);
});

test("parseability and size", () => {
  const junk = { status: 402, headers: {}, bodyText: "<html>pay me</html>", latencies: [100] };
  const r = hygiene(junk);
  assert.ok(codes(r).includes("unparseable"));
  assert.ok(r.score < 40 && r.grade === "F");
  const big = { ...GOOD, headers: {}, bodyText: JSON.stringify({ ...v2(), pad: "x".repeat(5000) }) };
  assert.deepEqual(codes(hygiene(big)), ["quote_too_large"]);
  const unk = { ...GOOD, headers: {}, bodyText: JSON.stringify(v2({ network: "mars:1" })) };
  assert.deepEqual(codes(hygiene(unk)), ["unknown_network"]);
});

test("402-vs-400 only from the normal probe: a 400 carrying x402 terms is a deduction; otherwise n/a and reweighted", () => {
  const r400 = hygiene({ ...GOOD, status: 400 });
  assert.ok(codes(r400).includes("paywall_on_400"));
  const r200 = hygiene({ ...GOOD, status: 200 });
  assert.ok(r200.na.includes("status_discipline"));
  assert.equal(r200.score, 100);
});

test("latency bands and n/a reweighting to 100", () => {
  assert.equal(hygiene({ ...GOOD, latencies: [500, 500, 500] }).score, 100);
  const half = hygiene({ ...GOOD, latencies: [1500, 1400, 1600] });
  assert.equal(half.deductions[0].code, "latency_slow");
  assert.equal(half.deductions[0].points, 5);
  assert.match(half.deductions[0].fix, /p50 was 1500 ms/);
  assert.equal(hygiene({ ...GOOD, latencies: [2000, 2000, 2000] }).deductions[0].points, 10);
  const na2 = hygiene({ ...GOOD, status: 200, latencies: [], bodyText: JSON.stringify(v2({ maxTimeoutSeconds: 5 })), headers: {} });
  assert.deepEqual(na2.na.sort(), ["latency", "status_discipline"]);
  assert.equal(na2.deductions[0].points, 13); // 10 of 80 reweighted to 100 -> 12.5 -> 13
  assert.equal(na2.score, 100 - 13);
});

test("grade bands", () => {
  assert.deepEqual([90, 89, 75, 74, 60, 59, 40, 39].map(gradeOf), ["A", "B", "B", "C", "C", "D", "D", "F"]);
});

// ---- endpoint
function fakeD1() {
  const cache = new Map(), quota = new Map();
  return {
    cache, quota,
    prepare(sql) {
      const st = { args: [], bind(...a) { st.args = a; return st; },
        async first() {
          if (/FROM hygiene_cache/.test(sql)) { const r = cache.get(st.args[0]); return r && r.scored_at >= st.args[1] ? r : null; }
          if (/INTO hygiene_quota/.test(sql)) { const k = st.args[0] + "|" + st.args[1]; quota.set(k, (quota.get(k) || 0) + 1); return { n: quota.get(k) }; }
          return null;
        },
        async run() { if (/INTO hygiene_cache/.test(sql)) cache.set(st.args[0], { hkey: st.args[0], scored_at: st.args[1], json: st.args[2] }); return {}; },
      };
      return st;
    },
  };
}
const deps = (calls) => ({
  resolveHostFn: async () => ["203.0.113.50"],
  fetchImpl: async (u, init) => { calls.push({ u: String(u), init }); return new Response(GOOD.bodyText, { status: 402, headers: GOOD.headers }); },
});
const get = (q, ip = "198.51.100.23") => new Request("https://api.402xagent.com/v1/hygiene" + q, { headers: { "cf-connecting-ip": ip } });

test("GET /v1/hygiene: guards before any probe or quota (bad url, placeholder, SSRF)", async () => {
  const db = fakeD1(), calls = [], env = { RECEIPTS_DB: db, CLIENT_SALT: "s" };
  for (const q of ["", "?url=notaurl", "?url=https://example.com/x", "?url=http://127.0.0.1/x", "?url=http://10.0.0.1/x"]) {
    const r = await handleHygiene(get(q), env, { ...deps(calls), resolveHostFn: async () => ["10.0.0.1"] });
    assert.equal(r.status, 400, q);
  }
  assert.equal(calls.length, 0);
  assert.equal(db.quota.size, 0);
});

test("GET /v1/hygiene: shape, unpaid normal requests only (no payment headers, no bad params), cache 24h hit", async () => {
  const db = fakeD1(), calls = [], env = { RECEIPTS_DB: db, CLIENT_SALT: "s" };
  const r = await handleHygiene(get("?url=https://seller.fixture/api?q=1"), env, deps(calls));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(Object.keys(b).sort(), ["cached", "deductions", "grade", "score", "scored_at", "url"]);
  assert.equal(b.grade, "A");
  assert.ok(calls.length >= 1 && calls.length <= 3);
  for (const c of calls) {
    assert.equal(c.u, "https://seller.fixture/api?q=1");
    const h = new Headers((c.init && c.init.headers) || {});
    assert.ok(!h.has("x-payment") && !h.has("payment-signature"));
  }
  const r2 = await handleHygiene(get("?url=https://seller.fixture/api?q=1"), env, deps(calls));
  const b2 = await r2.json();
  assert.equal(b2.cached, true);
  assert.equal(calls.length <= 3, true);
  assert.equal(HYGIENE_TTL_S, 86400);
  assert.ok((await cachedHygiene(env, "https://seller.fixture/api?q=1")).grade === "A");
});

test("GET /v1/hygiene: 20 free per /24 per day (D1, hashed prefix, no raw IP), then 429", async () => {
  const db = fakeD1(), calls = [], env = { RECEIPTS_DB: db, CLIENT_SALT: "s" };
  assert.equal(HYGIENE_FREE_PER_DAY, 20);
  for (let i = 0; i < 20; i++) assert.equal((await handleHygiene(get(`?url=https://s${i}.fixture/a`, "198.51.100." + (i + 1)), env, deps(calls))).status, 200);
  assert.equal((await handleHygiene(get("?url=https://s99.fixture/a", "198.51.100.200"), env, deps(calls))).status, 429);
  assert.equal((await handleHygiene(get("?url=https://s99.fixture/a", "192.0.2.9"), env, deps(calls))).status, 200);
  const keys = [...db.quota.keys()].join(" ");
  assert.ok(!/198\.51|192\.0/.test(keys), "no raw IP or prefix stored");
});

test("routed via the worker; listed in llms.txt, skill.md, MCP tools/list; never in public lists", async () => {
  const env = { DATA_BASE_URL: "https://data.fixture/vc/", CLIENT_SALT: "s" };
  const res = await worker.fetch(new Request("https://api.402xagent.com/v1/hygiene?url=https://example.com/x"), env, { waitUntil() {} });
  assert.equal(res.status, 400);
  const txt = async (p) => (await worker.fetch(new Request("https://api.402xagent.com" + p), env, { waitUntil() {} })).text();
  assert.match(await txt("/llms.txt"), /\/v1\/hygiene\?url=/);
  assert.match(await txt("/skill.md"), /\/v1\/hygiene\?url=/);
  const m = await worker.fetch(new Request("https://api.402xagent.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, { waitUntil() {} });
  assert.ok((await m.json()).result.tools.some((t) => t.name === "x402_hygiene"));
  // privacy: hygiene_cache is only read by hygiene.js
  const src = readFileSync(new URL("../worker/src/lib.js", import.meta.url), "utf8") + readFileSync(new URL("../worker/src/ops.js", import.meta.url), "utf8");
  assert.ok(!/hygiene_cache|hygiene_quota/.test(src));
});

test("paid report hygiene field never changes the verdict", async () => {
  const { reportHygiene } = await import("../worker/src/hygiene.js");
  const env = { RECEIPTS_DB: fakeD1(), CLIENT_SALT: "s" };
  const none = await reportHygiene(env, "https://seller.fixture/none");
  assert.deepEqual(none, { score: null, grade: null, deductions: [], note: "not scored in the last 24 h; GET /v1/hygiene?url= (free) scores it; never affects the verdict" });
  await handleHygiene(get("?url=https://seller.fixture/api"), env, deps([]));
  const h = await reportHygiene(env, "https://seller.fixture/api");
  assert.equal(h.grade, "A");
  assert.ok(!("verdict" in h));
});

test("0.50.1: our own endpoint-report and endpoint-spot-check are probed in-process and score well (same-zone fetch would 522)", async () => {
  const realFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (u, init) => {
    const s = String(typeof u === "string" ? u : u.url);
    if (s.startsWith("https://cloudflare-dns.com/")) return new Response(JSON.stringify({ Answer: /type=A$/.test(s) ? [{ type: 1, data: "104.21.0.1" }] : [] }), { headers: { "content-type": "application/dns-json" } });
    outbound.push(s);
    return new Response("error code: 522", { status: 522 });
  };
  try {
    const env = { RECEIPTS_DB: fakeD1(), CLIENT_SALT: "s", ENDPOINT_REPORT: "1", PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", DATA_BASE_URL: "https://data.fixture/vc/" };
    for (const p of ["/v1/products/endpoint-report", "/v1/products/endpoint-spot-check"]) {
      const target = "https://api.402xagent.com" + p;
      const res = await worker.fetch(get("?url=" + encodeURIComponent(target)), env, { waitUntil() {} });
      const j = await res.json();
      assert.equal(res.status, 200, p + " " + JSON.stringify(j));
      const c = j.deductions.map((d) => d.code);
      assert.ok(!c.includes("version_missing") && !c.includes("unparseable"), p + " " + c.join(","));
      assert.ok(j.score >= 70, p + " score " + j.score + " " + c.join(","));
    }
    assert.ok(!outbound.some((u) => u.includes("402xagent.com")), "own hosts never fetched over the network: " + outbound.join(" "));
  } finally { globalThis.fetch = realFetch; }
});
