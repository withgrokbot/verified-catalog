// Unit tests for worker/src/index.js with a stubbed fetch and a stubbed Analytics Engine binding.
// All data here is synthetic. Run: node tests/worker_test.mjs   (Node 18+; no dependencies)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { _resetCache, isoWeek, ipPrefix, saltPeriod, QuotaCounter, takeFree, quotaKey, PAYMENT_POLICY } from "../worker/src/lib.js";

const BASE = "https://data.test/vc/";
const H = 3600000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const svc = (id, price, tasks, extra = {}) => ({
  id, name: id.toUpperCase(), endpoint: `https://${id}.test/api`, category: "web search", description: "synthetic",
  tasks, advertised_price: { amount_usd: price }, sample_request: { method: "GET" },
  latest: { checked_at: iso(now - H), reachable: true, x402_challenge: true, quoted_price_usd: price, price_matches_listing: true },
  page_url: `${BASE}services/${id}.html`, ...extra,
});
const rc = (ageH, quality, payTo = "0x00000000000000000000000000000000000000aa") => ({
  time: iso(now - ageH * H), tx: "0x" + "ab".repeat(32), basescan_url: "https://basescan.org/tx/0x" + "ab".repeat(32),
  charged_usd: "0.01", delivered: quality !== "fail", http_status: 200, quality, quality_reason: "synthetic", pay_to: payTo,
  raw_log_url: BASE + "results/raw/x.json",
});
const CATALOG = {
  generated_at: iso(now), methodology_url: BASE + "methodology.html", contest_url: "https://issues.test/new",
  services: [
    svc("alpha", "0.01", ["web-search"]),
    svc("beta", "0.005", ["web-search"]),
    svc("gamma", "0.002", ["web-search"]),
    svc("delta", "0.05", ["web-search"]),
    svc("broken", "0.01", ["web-search"]),
    svc("weather1", "0.001", ["weather"], { category: "weather", description: "current weather for a city" }),
  ],
};
const MCP_PY = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.py");
const CAT_FILE = join(mkdtempSync(join(tmpdir(), "vc-mcp-")), "catalog.json");
const RECEIPTS = {
  stale_after_hours: 36,
  services: {
    alpha: { quality_test: { input: "q", pass_if: "p", facts_only: false }, receipts: [rc(2, "pass"), rc(26, "pass"), rc(50, "fail"), rc(74, "pass"), rc(98, "pass"), rc(122, "fail")] },
    beta: { quality_test: { input: "q", pass_if: "p", facts_only: false }, receipts: [rc(1, "pass"), rc(25, "fail"), rc(49, null)] },
    gamma: { quality_test: { input: "q", pass_if: "p", facts_only: false }, receipts: [rc(40, "pass")] },
    delta: { receipts: [rc(1, "pass")] },
    broken: { quality_test: { input: "q", pass_if: "p", facts_only: true, facts_only_reason: "HTTP 500 after payment" }, receipts: [rc(3, null)] },
    weather1: { receipts: [] },
  },
};

writeFileSync(CAT_FILE, JSON.stringify(CATALOG));
let serveReceipts = true;
let fetches = 0;
const FAC = "https://facilitator.test";
const facCalls = [];
let facMode = "ok"; // ok | invalid | settle-fail
const TX = "0x" + "cd".repeat(32);
let spotTargetMode = "402"; // 402 | timeout | huge | echo-init
let lastSpotFetchInit = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(FAC)) {
    const body = JSON.parse(init.body || "{}");
    facCalls.push([u.slice(FAC.length), body]);
    if (u.endsWith("/verify"))
      return Response.json(facMode === "invalid" ? { isValid: false, invalidReason: "insufficient_funds" } : { isValid: true, payer: "0x" + "11".repeat(20) });
    if (u.endsWith("/settle"))
      return Response.json(facMode === "settle-fail" ? { success: false, errorReason: "transaction_failed" } : { success: true, transaction: TX, network: "eip155:8453", payer: "0x" + "11".repeat(20) });
  }
  // DoH for SSRF resolve (spot-check)
  if (u.startsWith("https://cloudflare-dns.com/dns-query")) {
    const name = new URL(u).searchParams.get("name") || "";
    const type = new URL(u).searchParams.get("type") || "A";
    if (/^(localhost|metadata\.google\.internal)$/i.test(name)) {
      return Response.json({ Answer: [{ type: type === "A" ? 1 : 28, data: name === "localhost" ? "127.0.0.1" : "169.254.169.254" }] });
    }
    // Realistic CNAME + A chain (must ignore type 5)
    if (type === "A") return Response.json({ Answer: [{ type: 5, data: "cdn.example.test." }, { type: 1, data: "93.184.216.34" }] });
    return Response.json({ Answer: [{ type: 5, data: "cdn.example.test." }] });
  }
  // Spot-check probe targets (never expect payment headers)
  if (u.startsWith("https://spot.target.test/") || u.startsWith("https://x402.example.test/")) {
    lastSpotFetchInit = init || {};
    if (spotTargetMode === "timeout") {
      const err = new Error("timeout"); err.name = "AbortError"; throw err;
    }
    if (spotTargetMode === "huge") {
      return new Response("x".repeat(200000), { status: 200, headers: { "content-type": "text/plain" } });
    }
    const challenge = {
      x402Version: 2,
      error: "Payment required",
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", maxTimeoutSeconds: 300 }],
    };
    const b64c = Buffer.from(JSON.stringify(challenge)).toString("base64");
    return new Response(JSON.stringify({ error: "payment_required", accepts: challenge.accepts, price: "$0.001" }), {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": b64c },
    });
  }
  fetches++;
  if (u === BASE + "catalog.json") return new Response(JSON.stringify(CATALOG), { status: 200 });
  if (u === BASE + "receipts.json") return serveReceipts ? new Response(JSON.stringify(RECEIPTS), { status: 200 }) : new Response("nope", { status: 404 });
  return new Response("not found", { status: 404 });
};

// In-memory Durable Object namespace that runs the real QuotaCounter class.
function fakeQuotaNamespace({ broken = false } = {}) {
  const objects = new Map();
  const names = [];
  return {
    names,
    idFromName(name) {
      names.push(name);
      return name;
    },
    get(id) {
      if (broken) return { fetch: async () => { throw new Error("DO down"); } };
      if (!objects.has(id)) {
        const store = new Map();
        const state = { storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, structuredClone(v)) } };
        objects.set(id, new QuotaCounter(state, {}));
      }
      const obj = objects.get(id);
      return { fetch: (u) => obj.fetch(new Request(u)) };
    },
  };
}

function mkEnv(opts = {}) {
  const points = [];
  return {
    points,
    env: {
      DATA_BASE_URL: BASE, CLIENT_SALT: "test-salt", SELF_CLIENTS: "withgrokbot,withgrokbot-selftest,sam-selftest",
      LOOKUPS: { writeDataPoint: (p) => { if (opts.throwing) throw new Error("AE down"); points.push(p); } },
      ...(opts.quota ? { QUOTA: opts.quota, FACILITATOR_URL: FAC, FREE_PER_DAY: "5", PRICE_ATOMIC: "20000",
                         PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674" } : {}),
    },
  };
}
async function call(path, { ua = "agent-x/1.0", ip = "203.0.113.7", envo, headers = {} } = {}) {
  const e = envo || mkEnv();
  const req = new Request("https://lookup.test" + path, { headers: { "user-agent": ua, "cf-connecting-ip": ip, ...headers } });
  const res = await worker.fetch(req, e.env, { waitUntil() {} });
  return { status: res.status, body: res.status === 204 ? null : await res.json(), points: e.points, headers: res.headers };
}

const T = [];
const test = (name, fn) => T.push([name, fn]);

test("lookup filters by task and max_price, sorts by pass rate then price, separates facts-only", async () => {
  const r = await call("/v1/lookup?task=web-search&max_price=0.01&n=5");
  assert.equal(r.status, 200);
  // alpha last 5: pass,pass,fail,pass,pass = 0.8; beta last 5 graded: pass,fail = 0.5; gamma 1/1 = 1.0; delta over price
  assert.deepEqual(r.body.results.map((x) => [x.id, x.pass_rate]), [["gamma", 1], ["alpha", 0.8], ["beta", 0.5]]);
  assert.deepEqual(r.body.facts_only.map((x) => x.id), ["broken"]);
  assert.equal(r.body.facts_only[0].pass_rate, undefined, "facts-only services carry no pass rate");
  assert.match(r.body.facts_only[0].facts_only_reason, /HTTP 500/);
  const a = r.body.results[1];
  assert.equal(a.receipts.length, 5);
  for (const k of ["time", "tx", "basescan_url", "charged_usd", "delivered", "quality"]) assert.ok(k in a.receipts[0], k);
  assert.equal(a.stale, false);
  assert.equal(r.body.results[0].stale, true, "gamma's newest receipt is 40 h old");
  assert.ok(a.last_check_at && a.endpoint && a.price_usd === "0.01");
});

test("n limits receipts per service and pass rate uses only those; ties sort by price", async () => {
  const r = await call("/v1/lookup?task=web-search&max_price=0.01&n=1");
  assert.deepEqual(r.body.results.map((x) => [x.id, x.pass_rate, x.receipts.length]), [["gamma", 1, 1], ["beta", 1, 1], ["alpha", 1, 1]]);
});

test("endpoint lookup by id or URL, and unknown task falls back to text match", async () => {
  let r = await call("/v1/lookup?endpoint=alpha");
  assert.deepEqual(r.body.results.map((x) => x.id), ["alpha"]);
  r = await call("/v1/lookup?endpoint=" + encodeURIComponent("https://beta.test/api"));
  assert.deepEqual(r.body.results.map((x) => x.id), ["beta"]);
  r = await call("/v1/lookup?task=web-search&max_price=1&limit=20");
  assert.ok(!r.body.results.some((x) => x.id === "weather1"), "known task names match exactly");
  r = await call("/v1/lookup?task=weather&max_price=1");
  assert.deepEqual(r.body.results.map((x) => x.id), ["weather1"], "description text does not widen a known task");
  r = await call("/v1/lookup?task=city%20weather&max_price=1");
  assert.deepEqual(r.body.results.map((x) => x.id), ["weather1"]);
  assert.equal(r.body.results[0].pass_rate, null);
  assert.equal(r.body.results[0].stale, true, "no receipts means stale");
});

test("qualifying lookup is counted once with a hashed client id and no raw IP", async () => {
  const r = await call("/v1/lookup?task=web-search&max_price=0.01", { ip: "198.51.100.23" });
  assert.equal(r.points.length, 1);
  const p = r.points[0];
  assert.equal(p.doubles[0], 1, "qualifying");
  assert.equal(p.blobs[5], "");
  assert.match(p.blobs[0], /^h:[0-9a-f]{20}$/);
  assert.equal(p.indexes[0], p.blobs[0]);
  assert.ok(!JSON.stringify(p).includes("198.51.100"), "raw IP must never be stored");
  assert.ok(p.blobs[7].includes("0x00000000000000000000000000000000000000aa"), "returned vendor pay_to recorded");
});

test("ref is recorded for attribution and never changes the client id", async () => {
  const a = (await call("/v1/lookup?task=web-search&max_price=0.01", { ip: "198.51.100.23" })).points[0];
  const b = (await call("/v1/lookup?task=web-search&max_price=0.01&ref=via-README", { ip: "198.51.100.23" })).points[0];
  assert.equal(b.blobs[0], a.blobs[0], "same client id with or without ref");
  assert.equal(b.blobs[10], "via-readme");
  assert.equal(b.doubles[0], 1, "still qualifying");
  const bad = (await call("/v1/lookup?task=web-search&max_price=0.01&ref=a%20b", { ip: "198.51.100.23" })).points[0];
  assert.equal(bad.blobs[10], "", "invalid ref ignored, not an error");
});

test("client id: same /24 + UA -> same id; other /24, other UA, or client param -> different", async () => {
  const id = async (o, q = "") => (await call("/v1/lookup?task=web-search&max_price=0.01" + q, o)).points[0].blobs[0];
  const a = await id({ ip: "198.51.100.23" });
  assert.equal(await id({ ip: "198.51.100.99" }), a);
  assert.notEqual(await id({ ip: "198.51.101.23" }), a);
  assert.notEqual(await id({ ip: "198.51.100.23", ua: "other/2" }), a);
  assert.equal(await id({}, "&client=My-Agent"), "c:my-agent");
  assert.equal(ipPrefix("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(ipPrefix("2001:db8::1"), "2001:db8:0::/48");
  assert.equal(isoWeek(new Date(Date.UTC(2026, 8, 30))), "2026-W40");
  const ep = { WEEK_EPOCH: "2026-10-05" };
  assert.equal(saltPeriod(new Date(Date.UTC(2026, 9, 5, 0, 0, 1)), ep), "w0", "test day 1");
  assert.equal(saltPeriod(new Date(Date.UTC(2026, 9, 11, 23, 59)), ep), "w0", "test day 7");
  assert.equal(saltPeriod(new Date(Date.UTC(2026, 9, 12, 0, 1)), ep), "w1", "test day 8");
  assert.equal(saltPeriod(new Date(Date.UTC(2026, 9, 18, 23, 59)), ep), "w1", "test day 14");
});

test("not qualifying: self, crawler, uptime bot, missing price, no candidates, bad params", async () => {
  const q = async (path, o) => (await call(path, o)).points[0];
  let p = await q("/v1/lookup?task=web-search&max_price=0.01&client=withgrokbot-selftest");
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "self"]);
  p = await q("/v1/lookup?task=web-search&max_price=0.01", { ua: "Mozilla/5.0 (compatible; Googlebot/2.1)" });
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "crawler"]);
  p = await q("/v1/lookup?task=web-search&max_price=0.01", { ua: "UptimeRobot/2.0" });
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "uptime"]);
  p = await q("/v1/lookup?task=web-search");
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "missing-task-or-price"]);
  p = await q("/v1/lookup?task=web-search&max_price=0.0001");
  assert.deepEqual([p.doubles[0], p.blobs[5]], [0, "no-candidates"]);
  const r = await call("/v1/lookup?task=web-search&max_price=abc&payer=0x12");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /max_price/);
  assert.match(r.body.error, /payer/);
  assert.deepEqual([r.points[0].doubles[0], r.points[0].blobs[5]], [0, "bad-params"]);
  const r2 = await call("/v1/lookup");
  assert.equal(r2.status, 400);
  assert.ok(r2.body.tasks.includes("web-search"));
  assert.ok(r2.body.try_free_lookup.url.includes("ref=via-402-hint"));
  assert.match(r2.body.also_available.url, /\/v1\/products\/overnight-cos-pack$/);
  p = await q("/v1/lookup?task=web-search&max_price=0.01", { ua: "curl/8.5.0" });
  assert.equal(p.doubles[0], 1, "an agent with a generic UA still counts");
});

test("payer is stored lower-case for the later on-chain check", async () => {
  const p = (await call("/v1/lookup?task=web-search&max_price=0.01&payer=0xABCDEFabcdef0123456789012345678901234567")).points[0];
  assert.equal(p.blobs[6], "0xabcdefabcdef0123456789012345678901234567");
});

test("tasks, openapi, health, help, 404 and CORS; counting failure never breaks an answer", async () => {
  let r = await call("/v1/tasks");
  assert.deepEqual(r.body.tasks["web-search"].length, 5);
  assert.equal(r.points.length, 0, "only lookups are counted");
  r = await call("/openapi.json");
  assert.equal(r.body.openapi, "3.1.0");
  assert.ok(r.body.paths["/v1/lookup"]);
  r = await call("/health");
  assert.equal(r.body.ok, true);
  r = await call("/");
  assert.match(r.body.usage, /\/v1\/lookup\?task=/);
  r = await call("/nope");
  assert.equal(r.status, 404);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  r = await call("/v1/lookup?task=web-search&max_price=0.01", { envo: mkEnv({ throwing: true }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 3);
});

test("data is cached between requests; missing receipts.json still answers", async () => {
  _resetCache();
  fetches = 0;
  await call("/v1/lookup?task=web-search&max_price=0.01");
  await call("/v1/lookup?task=web-search&max_price=0.01");
  assert.equal(fetches, 2, "catalog + receipts fetched once, then served from cache");
  _resetCache();
  serveReceipts = false;
  const r = await call("/v1/lookup?task=web-search&max_price=0.01");
  serveReceipts = true;
  _resetCache();
  assert.equal(r.status, 200);
  assert.ok(r.body.results.every((x) => x.pass_rate === null && x.stale === true));
});

// ------------------------------------------------------------------ quota and x402
const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const meteredEnv = (o = {}) => mkEnv({ quota: fakeQuotaNamespace(o) });
const LQ = "/v1/lookup?task=web-search&max_price=0.01";
const v2Payment = (over = {}) => b64({
  x402Version: 2,
  resource: { url: "https://lookup.test" + LQ },
  accepted: { scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over },
  payload: { signature: "0x" + "ee".repeat(65), authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: over.amount || "20000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } },
});

test("quota: 5 free lookups per client per UTC day, then 402; other clients and other days are separate", async () => {
  const e = meteredEnv();
  for (let i = 1; i <= 5; i++) {
    const r = await call(LQ + "&client=agent-a", { envo: e });
    assert.equal(r.status, 200, "call " + i);
    assert.equal(r.body.access.tier, "free");
    assert.equal(r.body.access.free_used_today, i);
    assert.equal(r.body.access.free_remaining_today, 5 - i);
  }
  const r6 = await call(LQ + "&client=agent-a", { envo: e });
  assert.equal(r6.status, 402);
  assert.equal((await call(LQ + "&client=agent-b", { envo: e })).status, 200, "a different client has its own quota");
  // bad parameters never use the quota
  assert.equal((await call("/v1/lookup?task=web-search&max_price=abc&client=agent-c", { envo: e })).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await call(LQ + "&client=agent-c", { envo: e })).status, 200);
  // the counter resets on the next UTC day
  const ns = fakeQuotaNamespace();
  const env2 = { QUOTA: ns };
  const d1 = new Date(Date.UTC(2026, 9, 3, 23, 59)), d2 = new Date(Date.UTC(2026, 9, 4, 0, 1));
  for (let i = 0; i < 5; i++) assert.equal((await takeFree(env2, "c:x", 5, d1)).free, true);
  assert.equal((await takeFree(env2, "c:x", 5, d1)).free, false);
  assert.deepEqual(await takeFree(env2, "c:x", 5, d2), { free: true, used: 1, limit: 5 });
  // points: free calls are qualifying and record access=free; the 402 is not qualifying
  const freeP = e.points.find((p) => p.blobs[0] === "c:agent-a" && p.blobs[12] === "free");
  assert.equal(freeP.doubles[0], 1);
  const p402 = e.points.filter((p) => p.blobs[0] === "c:agent-a").pop();
  assert.deepEqual([p402.blobs[12], p402.blobs[5], p402.doubles[0], p402.doubles[2]], ["payment-required", "payment-required", 0, 402]);
});

test("quota without a client value: keyed by a salted hash of the IP (not the User-Agent); raw IP never stored", async () => {
  const ns = fakeQuotaNamespace();
  const e = mkEnv({ quota: ns });
  for (let i = 0; i < 5; i++) assert.equal((await call(LQ, { envo: e, ip: "198.51.100.23", ua: "ua-" + i })).status, 200);
  assert.equal((await call(LQ, { envo: e, ip: "198.51.100.23", ua: "another-ua" })).status, 402, "changing the UA does not reset the quota");
  assert.equal((await call(LQ, { envo: e, ip: "198.51.100.24" })).status, 200, "another IP has its own quota");
  assert.ok(ns.names.every((n) => /^ip:[0-9a-f]{24}$/.test(n)), ns.names.join(","));
  assert.ok(!JSON.stringify(ns.names).includes("198.51.100"));
  const req = new Request("https://x.test/", { headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(await quotaKey(req, { client: "bob" }, {}), "c:bob");
});

test("402 shape: x402 v2 PAYMENT-REQUIRED header and body, $0.02 USDC on Base to our wallet, payment policy stated", async () => {
  const e = meteredEnv();
  for (let i = 0; i < 5; i++) await call(LQ + "&client=shape", { envo: e });
  const r = await call(LQ + "&client=shape", { envo: e });
  assert.equal(r.status, 402);
  const hdr = unb64(r.headers.get("payment-required"));
  assert.deepEqual(hdr, r.body, "header and body carry the same requirement");
  assert.equal(hdr.x402Version, 2);
  assert.match(hdr.error, /Free lookups used up/);
  assert.equal(hdr.resource.url, "https://lookup.test" + LQ + "&client=shape");
  assert.equal(hdr.resource.mimeType, "application/json");
  assert.deepEqual(hdr.accepts, [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }]);
  assert.equal(hdr.price_usd, "0.02");
  assert.equal(hdr.free_per_day, 5);
  assert.equal(hdr.free_used_today, 5);
  assert.equal(hdr.payment_policy, PAYMENT_POLICY);
  assert.match(PAYMENT_POLICY, /never changes results, sort order, listings/);
  assert.ok(!("results" in r.body), "a 402 carries no results");
  assert.ok(r.body.try_free_lookup.url.includes("ref=via-402-hint"));
  assert.match(r.body.also_available.url, /\/v1\/products\/overnight-cos-pack$/);
  assert.match(r.body.also_available_spot_check.url, /\/v1\/products\/endpoint-spot-check/);
  assert.equal(r.body.also_available_spot_check.price_usdc, 0.25);
  assert.match(r.headers.get("access-control-expose-headers"), /PAYMENT-REQUIRED/);
  // OpenAPI and the help page document the 402 and the policy
  const oa = (await call("/openapi.json", { envo: e })).body;
  assert.match(oa.paths["/v1/lookup"].get.responses["402"].description, /0\.02 USDC on Base/);
  assert.match(oa.info.description, /never changes results, sort order/);
  const help = (await call("/", { envo: e })).body;
  assert.equal(help.pricing.free_per_day, 5);
  assert.equal(help.payment_policy, PAYMENT_POLICY);
  const pre = await worker.fetch(new Request("https://lookup.test/v1/lookup", { method: "OPTIONS" }), e.env, {});
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /PAYMENT-SIGNATURE/);
});

test("self clients are exempt by client value only; a self User-Agent alone is metered", async () => {
  const e = meteredEnv();
  for (const cl of ["withgrokbot", "withgrokbot-selftest", "sam-selftest"])
    for (let i = 0; i < 7; i++) {
      const r = await call(LQ + "&client=" + cl, { envo: e });
      assert.equal(r.status, 200);
      assert.equal(r.body.access.tier, "exempt");
    }
  assert.ok(e.points.every((p) => p.blobs[12] === "exempt" && p.blobs[5] === "self"));
  for (let i = 0; i < 5; i++) await call(LQ, { envo: e, ua: "WithGrokBot-test/1" });
  assert.equal((await call(LQ, { envo: e, ua: "WithGrokBot-test/1" })).status, 402);
});

test("paid lookup: verify + settle through the facilitator, identical results, PAYMENT-RESPONSE, logged with amount, tx and ref", async () => {
  const e = meteredEnv();
  facCalls.length = 0;
  facMode = "ok";
  const free = await call(LQ + "&client=payer1&ref=via-readme", { envo: e });
  for (let i = 0; i < 4; i++) await call(LQ + "&client=payer1&ref=via-readme", { envo: e });
  assert.equal(facCalls.length, 0);
  const r = await call(LQ + "&client=payer1&ref=via-readme", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, free.body.results, "payment never changes results or sort order");
  assert.deepEqual(r.body.facts_only, free.body.facts_only, "payment never changes listings");
  assert.equal(r.body.matched, free.body.matched);
  assert.deepEqual(r.body.access, { tier: "paid", charged_usd: "0.02", asset: "USDC on Base", tx: TX, basescan_url: "https://basescan.org/tx/" + TX, payer: "0x" + "11".repeat(20) });
  assert.equal(r.body.payment_policy, PAYMENT_POLICY);
  assert.deepEqual(unb64(r.headers.get("payment-response")), { success: true, transaction: TX, network: "eip155:8453", payer: "0x" + "11".repeat(20) });
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify", "/settle"]);
  const req = facCalls[0][1];
  assert.equal(req.x402Version, 2);
  assert.deepEqual(req.paymentRequirements, { scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
  const p = e.points.pop();
  assert.deepEqual([p.blobs[12], p.blobs[13], p.blobs[14], p.blobs[10], p.doubles[4], p.doubles[2]], ["paid", TX, "0x" + "11".repeat(20), "via-readme", 0.02, 200]);
  assert.equal(p.doubles[0], 1, "an outside paid lookup is qualifying");
  // X-PAYMENT carrying a v2 payload is accepted too
  const r2 = await call(LQ + "&client=payer1", { envo: e, headers: { "x-payment": v2Payment() } });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.access.tier, "paid");
});

test("payment rejected: wrong amount or payTo (facilitator not called), invalid, settle failure, garbage header", async () => {
  const e = meteredEnv();
  for (let i = 0; i < 5; i++) await call(LQ + "&client=rej", { envo: e });
  facCalls.length = 0;
  facMode = "ok";
  let r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment({ amount: "10000" }) } });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /amount does not match/);
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment({ payTo: "0x" + "33".repeat(20) }) } });
  assert.match(r.body.error, /payTo does not match/);
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment({ network: "eip155:84532" }) } });
  assert.match(r.body.error, /scheme or network/);
  assert.equal(facCalls.length, 0);
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": "not base64 json" } });
  assert.equal(r.status, 402);
  facMode = "invalid";
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /insufficient_funds/);
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify"], "no settle after a failed verify");
  facMode = "settle-fail";
  r = await call(LQ + "&client=rej", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /settlement failed: transaction_failed/);
  assert.ok(r.headers.get("payment-required"));
  facMode = "ok";
  const p = e.points.pop();
  assert.deepEqual([p.blobs[12], p.doubles[0], p.doubles[4]], ["payment-failed", 0, 0]);
});

test("free calls left: a payment header is ignored (nothing settled); counter outage fails open", async () => {
  const e = meteredEnv();
  facCalls.length = 0;
  const r = await call(LQ + "&client=early", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 200);
  assert.equal(r.body.access.tier, "free");
  assert.equal(facCalls.length, 0);
  const broken = mkEnv({ quota: fakeQuotaNamespace({ broken: true }) });
  for (let i = 0; i < 7; i++) assert.equal((await call(LQ + "&client=x", { envo: broken })).status, 200);
});

// ---------------------------------------------------------------- 0.4.0: always-paid path with Bazaar metadata
const PQ = "/v1/lookup/paid?task=web-search&max_price=0.01";
async function send(path, { method = "GET", body, headers = {}, envo, ua = "agent-x/1.0", ip = "203.0.113.7" } = {}) {
  const e = envo || meteredEnv();
  const req = new Request("https://lookup.test" + path, { method, body, headers: { "user-agent": ua, "cf-connecting-ip": ip, ...headers } });
  const res = await worker.fetch(req, e.env, { waitUntil() {} });
  const txt = await res.text();
  return { status: res.status, body: txt ? JSON.parse(txt) : null, headers: res.headers, points: e.points };
}

test("paid path: every unpaid call (no params, GET or POST, first call of the day) gets a 402 with Bazaar discovery metadata", async () => {
  const e = meteredEnv();
  for (const [path, method] of [["/v1/lookup/paid", "GET"], ["/v1/lookup/paid", "POST"], [PQ, "GET"], ["/v1/lookup/paid/", "GET"]]) {
    const r = await send(path, { method, envo: e });
    assert.equal(r.status, 402, path + " " + method);
    assert.deepEqual(unb64(r.headers.get("payment-required")), r.body);
  }
  const b = (await send(PQ, { envo: e })).body;
  assert.equal(b.x402Version, 2);
  assert.equal(b.resource.url, "https://lookup.test/v1/lookup/paid", "resource is the path without the query");
  assert.equal(b.resource.serviceName, "Verified Catalog Lookup");
  assert.ok(b.resource.serviceName.length <= 32 && b.resource.tags.length <= 5);
  assert.deepEqual(b.accepts, [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }]);
  const bz = b.extensions.bazaar;
  assert.deepEqual(bz.info.input, { type: "http", method: "GET", queryParams: { task: "web-search", max_price: "0.01", n: "5" } });
  assert.equal(bz.info.output.type, "json");
  assert.equal(bz.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(bz.schema.required, ["input"]);
  assert.equal(bz.schema.properties.input.properties.type.const, "http");
  assert.deepEqual(bz.schema.properties.input.required, ["type", "method"]);
  // info validates against its schema (input keys allowed, queryParams keys declared, no external refs)
  const ip = bz.schema.properties.input;
  assert.ok(Object.keys(bz.info.input).every((k) => k in ip.properties));
  assert.ok(Object.keys(bz.info.input.queryParams).every((k) => k in ip.properties.queryParams.properties));
  assert.ok(!JSON.stringify(bz.schema).includes('"$ref"'));
  assert.equal(b.payment_policy, PAYMENT_POLICY);
  assert.ok(b.try_free_lookup.url.includes("ref=via-402-hint"), "402 try_free_lookup must carry via-402-hint");
  assert.equal(b.try_free_lookup.ref, "via-402-hint");
  assert.match(b.also_available.url, /\/v1\/products\/overnight-cos-pack$/);
  assert.equal(b.also_available.product, "overnight-cos-pack");
  assert.equal(b.also_available.price_usdc, 9);
  assert.ok(!("results" in b));
  assert.ok(e.points.every((p) => p.blobs[12] === "payment-required" && p.doubles[2] === 402 && p.doubles[0] === 0));
  // discovery documents
  const wk = (await send("/.well-known/x402", { envo: e })).body;
  assert.deepEqual(wk, { version: 1, resources: ["https://lookup.test/v1/lookup/paid", "https://lookup.test/v1/products/overnight-cos-pack", "https://lookup.test/v1/products/endpoint-spot-check"] });
  const oa = (await send("/openapi.json", { envo: e })).body;
  const op = oa.paths["/v1/lookup/paid"].get;
  assert.deepEqual(op["x-payment-info"].protocols, [{ x402: { scheme: "exact", network: "eip155:8453", asset: USDC, payTo: PAY_TO } }]);
  assert.deepEqual(oa.paths["/v1/lookup"].get.security, [], "free-first routes are explicitly public");
  assert.deepEqual(op["x-payment-info"].price, { mode: "fixed", currency: "USD", amount: "0.02" });
  assert.ok(op.responses["402"]);
  assert.ok(oa.paths["/mcp"].post);
  assert.ok(!("x-payment-info" in oa.paths["/v1/lookup"].get), "/v1/lookup is free first, so it is not declared paid");
});

test("paid path: paid call returns the identical lookup result; bad params with a payment get a 400 and nothing is settled", async () => {
  const e = meteredEnv();
  facCalls.length = 0;
  facMode = "ok";
  const free = await send(LQ + "&client=pp", { envo: e });
  assert.equal(free.status, 200);
  const r = await send(PQ + "&client=pp&ref=via-x402scan", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, free.body.results, "payment never changes results");
  assert.deepEqual(r.body.facts_only, free.body.facts_only);
  assert.equal(r.body.matched, free.body.matched);
  assert.deepEqual(r.body.query, free.body.query);
  assert.equal(r.body.access.tier, "paid");
  assert.equal(r.body.access.tx, TX);
  assert.equal(unb64(r.headers.get("payment-response")).transaction, TX);
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify", "/settle"]);
  assert.equal(facCalls[0][1].paymentRequirements.amount, "20000");
  const p = e.points.pop();
  assert.deepEqual([p.blobs[12], p.blobs[13], p.blobs[10], p.doubles[4], p.doubles[2], p.doubles[0]], ["paid", TX, "via-x402scan", 0.02, 200, 1]);
  // the free quota is untouched by the paid path (1 used above)
  const f2 = await send(LQ + "&client=pp", { envo: e });
  assert.equal(f2.body.access.free_used_today, 2);
  facCalls.length = 0;
  let bad = await send("/v1/lookup/paid", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /task or endpoint is required.*nothing was charged/);
  assert.ok(bad.body.try_free_lookup.url.includes("ref=via-402-hint"));
  assert.match(bad.body.also_available.url, /\/v1\/products\/overnight-cos-pack$/);
  bad = await send("/v1/lookup/paid?task=web-search&max_price=abc", { envo: e, headers: { "payment-signature": v2Payment() } });
  assert.equal(bad.status, 400);
  assert.equal(facCalls.length, 0, "no verify or settle for bad parameters");
  const wrong = await send(PQ, { envo: e, headers: { "payment-signature": v2Payment({ amount: "10000" }) } });
  assert.equal(wrong.status, 402);
  assert.match(wrong.body.error, /amount does not match/);
  assert.ok(wrong.body.extensions.bazaar);
  facMode = "invalid";
  const inv = await send(PQ, { envo: e, headers: { "x-payment": v2Payment() } });
  assert.equal(inv.status, 402);
  assert.match(inv.body.error, /insufficient_funds/);
  facMode = "ok";
});

// ---------------------------------------------------------------- 0.4.0: remote MCP at /mcp
const rpc = (m, o = {}) => send("/mcp", { method: "POST", body: JSON.stringify(m), headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, ...o });

test("MCP /mcp: initialize, tools/list (catalog tools + products), ping, notifications, errors", async () => {
  const e = meteredEnv();
  let r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { envo: e });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/json/);
  assert.deepEqual(r.body, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "verified-catalog", version: "0.6.2" } } });
  assert.equal(r.headers.get("mcp-session-id"), null, "stateless: no session");
  r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { envo: e });
  assert.equal(r.status, 202);
  assert.equal(r.body, null);
  r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { envo: e });
  const py = spawnSync("python3", [MCP_PY, "--catalog", CAT_FILE], { input: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n", env: { ...process.env, VC_LOOKUP_URL: "off" }, encoding: "utf8" });
  const pyTools = JSON.parse(py.stdout).result.tools;
  const workerTools = r.body.result.tools;
  assert.deepEqual(workerTools.slice(0, 3), pyTools, "first 3 tools match mcp/server.py");
  assert.deepEqual(workerTools.map((t) => t.name), ["search_catalog", "get_service", "lookup", "get_overnight_cos_pack", "endpoint_spot_check"]);
  assert.deepEqual((await rpc({ jsonrpc: "2.0", id: 3, method: "ping" }, { envo: e })).body, { jsonrpc: "2.0", id: 3, result: {} });
  assert.equal((await rpc({ jsonrpc: "2.0", id: 4, method: "nope" }, { envo: e })).body.error.code, -32601);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } }, { envo: e })).body.error.message, "unknown tool 'nope'");
  r = await send("/mcp", { method: "POST", body: "{not json", envo: e });
  assert.equal(r.body.error.code, -32700);
  assert.equal((await send("/mcp", { envo: e })).status, 405, "GET: no SSE stream on a stateless server");
  const batch = await rpc([{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }], { envo: e });
  assert.deepEqual(batch.body, [{ jsonrpc: "2.0", id: 6, result: {} }]);
  const pre = await worker.fetch(new Request("https://lookup.test/mcp", { method: "OPTIONS" }), e.env, {});
  assert.match(pre.headers.get("access-control-allow-methods"), /POST/);
});

test("MCP /mcp tools/call: search_catalog and get_service give results identical to mcp/server.py", async () => {
  const e = meteredEnv();
  const cases = [
    ["search_catalog", {}],
    ["search_catalog", { query: "synthetic", max_price_usd: 0.005, limit: 2 }],
    ["search_catalog", { category: "weather", reachable_only: true }],
    ["search_catalog", { max_price_usd: "abc" }],
    ["get_service", { id: "beta" }],
    ["get_service", { id: "missing" }],
  ];
  const msgs = cases.map(([name, args], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }));
  const py = spawnSync("python3", [MCP_PY, "--catalog", CAT_FILE], { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", env: { ...process.env, VC_LOOKUP_URL: "off" }, encoding: "utf8" });
  const pyOut = py.stdout.trim().split("\n").map((l) => JSON.parse(l));
  for (let i = 0; i < msgs.length; i++) {
    const r = await rpc(msgs[i], { envo: e });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, pyOut[i], "identical to mcp/server.py for " + JSON.stringify(cases[i]));
  }
  assert.equal(pyOut[1].result.structuredContent.count, 2);
  assert.equal(pyOut[3].result.isError, true);
  assert.equal(pyOut[5].result.isError, true);
});

test("MCP /mcp lookup: same /v1/lookup result, client=vc-mcp with its 5 free calls, then the 402 is reported (never paid)", async () => {
  const e = meteredEnv();
  facCalls.length = 0;
  const direct = await send(LQ + "&n=3&client=withgrokbot", { envo: e });
  const call1 = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lookup", arguments: { task: "web-search", max_price_usd: 0.01, n: 3 } } };
  for (let i = 1; i <= 5; i++) {
    const r = await rpc(call1, { envo: e });
    const sc = r.body.result.structuredContent;
    assert.deepEqual(sc.results, direct.body.results, "identical results");
    assert.deepEqual(sc.facts_only, direct.body.facts_only);
    assert.deepEqual(sc.access, { tier: "free", free_per_day: 5, free_used_today: i, free_remaining_today: 5 - i, then: "$0.02 USDC on Base per lookup via x402 (HTTP 402)" });
    assert.deepEqual(JSON.parse(r.body.result.content[0].text), sc);
  }
  const p = e.points[e.points.length - 1];
  assert.equal(p.blobs[0], "c:vc-mcp");
  const r6 = await rpc(call1, { envo: e });
  assert.equal(r6.body.result.isError, true);
  assert.match(r6.body.result.content[0].text, /^lookup returned HTTP 402: Free lookups used up for today.*payment never changes results\.$/);
  assert.equal(facCalls.length, 0);
  const none = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup", arguments: {} } }, { envo: e });
  assert.equal(none.body.result.content[0].text, "give a task (e.g. web-search) or an endpoint (service id or URL)");
  // the remote MCP lookup and the stdio server share one quota key: client=vc-mcp
  assert.ok(e.env.QUOTA.names.filter((n) => n === "c:vc-mcp").length >= 6);
});


// ---------------------------------------------------------------- 0.5.0: Overnight CoS Setup Pack ($9, always paid)
const PACK = "/v1/products/overnight-cos-pack";
const packPayment = (over = {}) => b64({
  x402Version: 2,
  resource: { url: "https://lookup.test" + PACK },
  accepted: { scheme: "exact", network: "eip155:8453", amount: "9000000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over },
  payload: { signature: "0x" + "ee".repeat(65), authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: over.amount || "9000000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } },
});
function packEnv(extra = {}) {
  const e = meteredEnv();
  e.env.PACK_PRICE_ATOMIC = "9000000";
  e.env.PACK_BLOBS = {
    get: async (key, type) => {
      if (key !== "overnight-cos-pack/guide.pdf") return null;
      const bytes = new TextEncoder().encode("%PDF-1.4 fake-guide");
      return type === "arrayBuffer" ? bytes.buffer : bytes;
    },
  };
  Object.assign(e.env, extra);
  return e;
}

test("overnight-cos-pack: unpaid GET/POST return 402 with amount 9000000, payTo, bazaar extension", async () => {
  const e = packEnv();
  for (const [path, method] of [[PACK, "GET"], [PACK, "POST"], [PACK + "/", "GET"]]) {
    const r = await send(path, { method, envo: e });
    assert.equal(r.status, 402, path + " " + method);
    assert.deepEqual(unb64(r.headers.get("payment-required")), r.body);
  }
  const b = (await send(PACK, { envo: e })).body;
  assert.equal(b.x402Version, 2);
  assert.equal(b.resource.url, "https://lookup.test" + PACK);
  assert.equal(b.resource.serviceName, "Overnight CoS Setup Pack");
  assert.ok(b.resource.serviceName.length <= 32);
  assert.equal(b.resource.tags.length, 5);
  assert.deepEqual(b.accepts, [{ scheme: "exact", network: "eip155:8453", amount: "9000000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }]);
  assert.equal(b.price_usd, "9");
  assert.equal(b.product, "overnight-cos-pack");
  assert.ok(b.extensions.bazaar);
  assert.equal(b.extensions.bazaar.info.input.type, "http");
  assert.equal(b.extensions.bazaar.info.output.type, "json");
  assert.ok(b.extensions.bazaar.info.output.example.files.guide);
  // SELF_CLIENTS do not get the pack free
  const self = await send(PACK + "?client=withgrokbot", { envo: e });
  assert.equal(self.status, 402);
  // discovery docs
  const wk = (await send("/.well-known/x402", { envo: e })).body;
  assert.ok(wk.resources.includes("https://lookup.test" + PACK));
  const oa = (await send("/openapi.json", { envo: e })).body;
  assert.equal(oa.info.version, "0.6.2");
  const op = oa.paths[PACK].get;
  assert.deepEqual(op["x-payment-info"].price, { mode: "fixed", currency: "USD", amount: "9" });
  assert.equal(op["x-payment-info"].protocols[0].x402.payTo, PAY_TO);
  assert.ok(oa.paths[PACK].post);
  const health = (await send("/health", { envo: e })).body;
  assert.equal(health.version, "0.6.2");
});

test("overnight-cos-pack: paid path with mocked facilitator returns prompts+template+guide; wrong amount rejected", async () => {
  const e = packEnv();
  facCalls.length = 0;
  facMode = "ok";
  const wrong = await send(PACK, { envo: e, headers: { "payment-signature": packPayment({ amount: "20000" }) } });
  assert.equal(wrong.status, 402);
  assert.match(wrong.body.error, /amount does not match/);
  assert.equal(facCalls.length, 0);
  const r = await send(PACK, { envo: e, headers: { "payment-signature": packPayment() } });
  assert.equal(r.status, 200);
  assert.equal(r.body.product, "overnight-cos-pack");
  assert.equal(r.body.title, "Overnight Chief of Staff: Multi-Bot Setup Pack");
  assert.equal(r.body.price_usdc, 9);
  assert.ok(r.body.files.prompts["00_overnight_cos_combiner.txt"].length > 100);
  assert.ok(r.body.files.prompts["01_inbox_bot.txt"]);
  assert.ok(r.body.files.templates["morning_briefing_template.html"].includes("html"));
  assert.equal(r.body.files.guide.filename, "Overnight_Chief_of_Staff_Setup_Guide.pdf");
  assert.equal(r.body.files.guide.encoding, "base64");
  assert.ok(r.body.files.guide.data.length > 10);
  assert.equal(r.body.access.tier, "paid");
  assert.equal(r.body.access.charged_usd, "9");
  assert.equal(r.body.access.tx, TX);
  assert.equal(unb64(r.headers.get("payment-response")).transaction, TX);
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify", "/settle"]);
  assert.equal(facCalls[0][1].paymentRequirements.amount, "9000000");
  // dry structure check without settling: PACK_PREVIEW stub
  const preview = packEnv({ PACK_PREVIEW: "1" });
  const stub = await send(PACK, { envo: preview });
  assert.equal(stub.status, 200);
  assert.equal(stub.body.access.tier, "preview");
  assert.ok(stub.body.files.prompts["00_overnight_cos_combiner.txt"]);
});

test("MCP get_overnight_cos_pack: unpaid returns payment instructions; paid header forwards to product handler", async () => {
  const e = packEnv();
  facCalls.length = 0;
  facMode = "ok";
  const unpaid = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_overnight_cos_pack", arguments: {} } }, { envo: e });
  assert.equal(unpaid.body.result.isError, true);
  assert.match(unpaid.body.result.content[0].text, /Payment required: \$9 USDC/);
  assert.match(unpaid.body.result.content[0].text, /overnight-cos-pack/);
  assert.match(unpaid.body.result.content[0].text, /9000000/);
  const paid = await send("/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_overnight_cos_pack", arguments: {} } }),
    headers: { "content-type": "application/json", "payment-signature": packPayment() },
    envo: e,
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.result.isError, undefined);
  const sc = paid.body.result.structuredContent;
  assert.equal(sc.product, "overnight-cos-pack");
  assert.ok(sc.files.prompts["04_cos_writer_bot.txt"]);
  assert.equal(sc.access.tier, "paid");
});


// ---------------------------------------------------------------- 0.6.0: Endpoint Spot-Check ($0.25, 1 free/day)
const SPOT = "/v1/products/endpoint-spot-check";
const spotPayment = (over = {}) => b64({
  x402Version: 2,
  resource: { url: "https://lookup.test" + SPOT },
  accepted: { scheme: "exact", network: "eip155:8453", amount: "250000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...over },
  payload: { signature: "0x" + "ee".repeat(65), authorization: { from: "0x" + "11".repeat(20), to: PAY_TO, value: over.amount || "250000", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } },
});
function spotEnv(extra = {}) {
  const e = meteredEnv();
  e.env.SPOT_PRICE_ATOMIC = "250000";
  e.env.SPOT_FREE_PER_DAY = "1";
  e.env.SPOT_PAID_PER_HOUR = "30";
  Object.assign(e.env, extra);
  return e;
}

test("spot-check SSRF: localhost, 127.0.0.1, 169.254.169.254, 10.x → 400 skip/ssrf_blocked, no outbound fetch", async () => {
  const e = spotEnv();
  lastSpotFetchInit = null;
  const blocked = [
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/secret",
    "http://192.168.1.1/",
    "http://[::1]/",
  ];
  for (const u of blocked) {
    const r = await send(SPOT + "?url=" + encodeURIComponent(u) + "&client=ssrf-a", { envo: e });
    assert.equal(r.status, 400, u);
    assert.equal(r.body.verdict, "skip", u);
    assert.equal(r.body.reason, "ssrf_blocked", u);
    assert.equal(r.body.quoted_price_usd, null, u);
    assert.ok(!("ssrf_blocked" in r.body) || r.body.ssrf_blocked === undefined, "slim body only");
  }
  assert.equal(lastSpotFetchInit, null, "must not fetch blocked targets");
});

test("spot-check free path: first call/day succeeds without payment (mock outbound 402)", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  lastSpotFetchInit = null;
  const r = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=0.001&client=spot-free-1", { envo: e });
  assert.equal(r.status, 200);
  assert.equal(r.body.access.tier, "free");
  assert.equal(r.body.verdict, "pay");
  assert.equal(r.body.reason, "price_ok");
  assert.equal(r.body.quoted_price_usd, 0.001);
  assert.equal(r.body.claimed_price_usd, 0.001);
  // slim: only decision fields + access
  for (const k of Object.keys(r.body)) {
    assert.ok(["verdict", "reason", "quoted_price_usd", "claimed_price_usd", "access"].includes(k), "unexpected field " + k);
  }
  assert.ok(lastSpotFetchInit);
  const h = lastSpotFetchInit.headers || {};
  const hdrObj = h instanceof Headers ? Object.fromEntries(h.entries()) : h;
  const keys = Object.keys(hdrObj).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("payment-signature") && !keys.includes("x-payment"), "never send payment headers outbound");
  // second call same day → 402 for $0.25
  const r2 = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-free-1", { envo: e });
  assert.equal(r2.status, 402);
  assert.equal(r2.body.accepts[0].amount, "250000");
  assert.equal(r2.body.price_usd, "0.25");
  assert.equal(r2.body.product, "endpoint-spot-check");
});

test("spot-check unpaid after free exhausted → 402 amount 250000; paid path works; never pays target", async () => {
  const e = spotEnv();
  facCalls.length = 0;
  facMode = "ok";
  spotTargetMode = "402";
  await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", { envo: e });
  const unpaid = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", { envo: e });
  assert.equal(unpaid.status, 402);
  assert.equal(unpaid.body.accepts[0].amount, "250000");
  lastSpotFetchInit = null;
  const paid = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=spot-pay-1", {
    envo: e,
    headers: { "payment-signature": spotPayment() },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.access.tier, "paid");
  assert.equal(paid.body.access.charged_usd, "0.25");
  assert.equal(paid.body.verdict, "pay");
  assert.equal(paid.body.reason, "price_ok");
  assert.equal(paid.body.quoted_price_usd, 0.001);
  assert.equal(paid.body.claimed_price_usd, null);
  assert.deepEqual(facCalls.map((x) => x[0]), ["/verify", "/settle"]);
  const h = lastSpotFetchInit.headers || {};
  const hdrObj = h instanceof Headers ? Object.fromEntries(h.entries()) : h;
  assert.ok(!Object.keys(hdrObj).some((k) => /payment/i.test(k)), "outbound must not carry payment headers");
});

test("spot-check timeout and oversized body handled safely", async () => {
  const e = spotEnv();
  spotTargetMode = "timeout";
  const t = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/slow") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(t.status, 200);
  assert.equal(t.body.access.tier, "exempt");
  assert.equal(t.body.verdict, "skip");
  assert.equal(t.body.reason, "timeout");
  assert.equal(t.body.quoted_price_usd, null);
  spotTargetMode = "huge";
  const h = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/huge") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(h.status, 200);
  assert.equal(h.body.verdict, "skip");
  assert.equal(h.body.reason, "no_x402");
  spotTargetMode = "402";
});

test("MCP endpoint_spot_check listed; unpaid after free returns pay instructions", async () => {
  const e = spotEnv();
  const listed = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { envo: e });
  const tool = listed.body.result.tools.find((t) => t.name === "endpoint_spot_check");
  assert.ok(tool);
  assert.match(tool.description, /verdict/);
  spotTargetMode = "402";
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "endpoint_spot_check", arguments: { url: "https://spot.target.test/api", claimed_price: 0.001 } } };
  const free = await rpc(call, { envo: e });
  assert.equal(free.body.result.isError, undefined);
  assert.equal(free.body.result.structuredContent.verdict, "pay");
  assert.equal(free.body.result.structuredContent.reason, "price_ok");
  assert.equal(free.body.result.structuredContent.quoted_price_usd, 0.001);
  const paidNeed = await rpc(call, { envo: e });
  assert.equal(paidNeed.body.result.isError, true);
  assert.match(paidNeed.body.result.content[0].text, /Payment required: \$0\.25 USDC/);
  const health = (await send("/health", { envo: e })).body;
  assert.equal(health.version, "0.6.2");
  const oa = (await send("/openapi.json", { envo: e })).body;
  assert.ok(oa.paths[SPOT]);
  assert.match(oa.paths[SPOT].get.responses[200].description, /verdict/);
});

test("spot-check price_mismatch → skip; no claimed → pay when challenge ok", async () => {
  const e = spotEnv();
  spotTargetMode = "402";
  const mismatch = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&claimed_price=9.99&client=withgrokbot-selftest", { envo: e });
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.body.verdict, "skip");
  assert.equal(mismatch.body.reason, "price_mismatch");
  assert.equal(mismatch.body.quoted_price_usd, 0.001);
  assert.equal(mismatch.body.claimed_price_usd, 9.99);
  const noclaim = await send(SPOT + "?url=" + encodeURIComponent("https://spot.target.test/api") + "&client=withgrokbot-selftest", { envo: e });
  assert.equal(noclaim.status, 200);
  assert.equal(noclaim.body.verdict, "pay");
  assert.equal(noclaim.body.reason, "price_ok");
  assert.equal(noclaim.body.claimed_price_usd, null);
});

let passed = 0;
for (const [name, fn] of T) {
  try {
    await fn();
    passed++;
    console.log("PASS " + name);
  } catch (e) {
    console.log("FAIL " + name + "\n  " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n  ") : e));
  }
}
console.log(`${passed}/${T.length} worker tests passed`);
process.exit(passed === T.length ? 0 : 1);
