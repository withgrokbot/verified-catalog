// 0.53.0 POST /v1/facilitator/check (facilitator onBeforeSettle). All data synthetic; no real network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleFacilitatorCheck, parseFacilInput, diffTerms, FACIL_CHECK_PATH, FACIL_CHECK_PER_MIN, FACIL_HOST_PER_MIN } from "../worker/src/facilcheck.js";
import { VERSION } from "../worker/src/lib.js";
import worker from "../worker/src/index.js";

const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAYTO = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const LIVE = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: ASSET, payTo: PAYTO, maxTimeoutSeconds: 60 };
const REQ = { ...LIVE, payTo: PAYTO.toLowerCase(), asset: ASSET.toUpperCase().replace("0X", "0x") }; // case differs only
const URL_ = "https://seller.fixture/api/data";
const NOW = new Date("2026-10-27T15:00:30Z");

function quota() {
  const calls = [], counts = new Map();
  return { calls, QUOTA: { idFromName: (n) => n, get: (n) => ({ fetch: async (u) => {
    const q = new URL(u).searchParams; calls.push({ key: n, counter: q.get("counter"), day: q.get("day") });
    const k = n + "|" + q.get("day") + "|" + q.get("counter"); const used = (counts.get(k) || 0) + 1; counts.set(k, used);
    return new Response(JSON.stringify({ free: used <= Number(q.get("limit")), used }));
  } }) } };
}
const seller = (accepts = [LIVE], status = 402, calls = []) => ({
  resolveHostFn: async () => ["203.0.113.50"],
  fetchImpl: async (u, init) => { calls.push({ u: String(u), init }); return new Response(JSON.stringify({ x402Version: 2, accepts }), { status, headers: { "content-type": "application/json" } }); },
});
const post = (body, { ip = "198.51.100.7", raw = false, q = "" } = {}) => new Request("https://api.402xagent.com" + FACIL_CHECK_PATH + q, {
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: raw ? body : JSON.stringify(body),
});
const run = async (body, deps, env = { CLIENT_SALT: "s", ...quota() }) => { const r = await handleFacilitatorCheck(post(body), env, deps, NOW); return { status: r.status, body: await r.json(), env }; };

test("0.58.9 version", () => assert.equal(VERSION, "0.58.9"));

test("match: same terms (EVM case-insensitive payTo/asset, v1 network alias) -> settle; shape; never pays", async () => {
  const calls = [];
  const { status, body } = await run({ paymentRequirements: REQ, url: URL_, paymentPayload: { payload: { authorization: { from: "0x9999999999999999999999999999999999999999" } }, signature: "0xdead" } }, seller([LIVE], 402, calls));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["checked_at", "live_accepts_count", "live_status", "live_terms_sha256", "match", "mismatches", "recommendation"]);
  assert.equal(body.match, true);
  assert.deepEqual(body.mismatches, []);
  assert.equal(body.recommendation, "settle");
  assert.equal(body.checked_at, "2026-10-27T15:00:30Z");
  assert.equal(body.live_terms_sha256, createHash("sha256").update(["eip155:8453", ASSET.toLowerCase(), "20000", PAYTO.toLowerCase()].join("|")).digest("hex"));
  const txt = JSON.stringify(body);
  assert.ok(!/9999999999|dead/.test(txt), "payer / payload never echoed");
  assert.equal(calls.length, 1);
  const h = new Headers(calls[0].init.headers);
  assert.ok(!h.has("x-payment") && !h.has("payment-signature"), "no payment headers to the seller");
  assert.equal(calls[0].u, URL_);
  assert.equal(diffTerms({ ...REQ, network: "base" }, LIVE).length, 0, "v1 'base' == eip155:8453");
});

test("each mismatch kind -> hold with {field, expected, live}", async () => {
  const cases = {
    amount: { amount: "10000" },
    payTo: { payTo: "0x1111111111111111111111111111111111111111" },
    network: { network: "eip155:84532" },
    asset: { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
    scheme: { scheme: "upto" },
  };
  for (const [field, change] of Object.entries(cases)) {
    const { status, body } = await run({ paymentRequirements: { ...REQ, ...change }, url: URL_ }, seller());
    assert.equal(status, 200, field);
    assert.equal(body.match, false, field);
    assert.equal(body.recommendation, "hold", field);
    assert.deepEqual(body.mismatches.map((m) => m.field), [field], field);
    assert.equal(body.mismatches[0].expected, change[field], field);
    assert.ok(body.mismatches[0].live != null, field);
  }
  // several live entries: an exact match anywhere settles
  const two = await run({ paymentRequirements: REQ, url: URL_ }, seller([{ ...LIVE, network: "eip155:1" }, LIVE]));
  assert.equal(two.body.recommendation, "settle");
  // seller answers 200 (no terms) -> hold
  const none = await run({ paymentRequirements: REQ, url: URL_ }, seller([], 200));
  assert.equal(none.body.recommendation, "hold");
  assert.equal(none.body.mismatches[0].field, "terms");
  // url from paymentRequirements.resource (v1 string) and v2 {url}
  assert.equal((await run({ paymentRequirements: { ...REQ, resource: URL_ } }, seller())).body.match, true);
  assert.equal((await run({ paymentRequirements: REQ, resource: { url: URL_ } }, seller())).body.match, true);
  assert.equal((await run({ paymentRequirements: { ...REQ, amount: undefined, maxAmountRequired: "20000" }, url: URL_ }, seller())).body.match, true);
});

test("SSRF-blocked url: 400 ssrf_blocked, hold, nothing probed, no quota used", async () => {
  for (const [u, ip] of [["http://127.0.0.2/x", null], ["http://[::1]/x", null], ["http://10.0.0.1/x", null], ["https://internal.fixture/x", "10.1.2.3"], ["http://169.254.169.254/latest", null]]) {
    const calls = [];
    const deps = { ...seller([LIVE], 402, calls), resolveHostFn: async (h) => [ip || h] };
    const { status, body, env } = await run({ paymentRequirements: REQ, url: u }, deps);
    assert.equal(status, 400, u);
    assert.equal(body.code, "ssrf_blocked", u);
    assert.equal(body.recommendation, "hold");
    assert.equal(calls.length, 0, u);
    assert.equal(env.calls.length, 0, "no rate-limit tick on a blocked url");
  }
  // redirect into a private address is blocked mid-flight -> 502 hold
  const redirect = { resolveHostFn: async (h) => (h === "seller.fixture" ? ["203.0.113.50"] : ["10.0.0.5"]), fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://inner.fixture/" } }) };
  const r = await run({ paymentRequirements: REQ, url: URL_ }, redirect);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "seller_redirect_blocked");
  assert.equal(r.body.recommendation, "hold");
});

test("unreachable / timed-out seller: 502 / 504, recommendation hold", async () => {
  const down = { resolveHostFn: async () => ["203.0.113.50"], fetchImpl: async () => { throw new TypeError("fetch failed"); } };
  const a = await run({ paymentRequirements: REQ, url: URL_ }, down);
  assert.deepEqual([a.status, a.body.code, a.body.recommendation, a.body.match], [502, "seller_unreachable", "hold", false]);
  const slow = { resolveHostFn: async () => ["203.0.113.50"], timeoutMs: 20, fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) };
  const b = await run({ paymentRequirements: REQ, url: URL_ }, slow);
  assert.deepEqual([b.status, b.body.code, b.body.recommendation], [504, "seller_timeout", "hold"]);
});

test("bad input: 400 bad_input, hold, nothing probed, never echoes the body", async () => {
  const bads = [
    [null, "body"], [[], "body"], [{}, "paymentRequirements"], [{ paymentRequirements: "x" }, "paymentRequirements"],
    [{ paymentRequirements: { ...REQ, payTo: "" }, url: URL_ }, "paymentRequirements.payTo"],
    [{ paymentRequirements: { ...REQ, scheme: undefined }, url: URL_ }, "paymentRequirements.scheme"],
    [{ paymentRequirements: { ...REQ, amount: "1.5" }, url: URL_ }, "paymentRequirements.amount"],
    [{ paymentRequirements: REQ }, "url"], [{ paymentRequirements: REQ, url: "ftp://x.fixture/" }, "url"],
    [{ paymentRequirements: REQ, url: "https://example.com/x" }, "url"], [{ paymentRequirements: REQ, url: URL_, method: "PUT" }, "method"],
  ];
  for (const [b, field] of bads) {
    const calls = [];
    const { status, body, env } = await run(b, seller([LIVE], 402, calls));
    assert.equal(status, 400, JSON.stringify(b));
    assert.deepEqual([body.code, body.field, body.recommendation, body.nothing_probed], ["bad_input", field, "hold", true], JSON.stringify(b));
    assert.equal(calls.length, 0);
    assert.equal(env.calls.length, 0, "bad input never uses the rate limit");
  }
  const notJson = await handleFacilitatorCheck(post("{nope", { raw: true }), { CLIENT_SALT: "s" }, seller(), NOW);
  assert.equal(notJson.status, 400);
  const big = await handleFacilitatorCheck(post(JSON.stringify({ paymentRequirements: REQ, url: URL_, pad: "x".repeat(20000) }), { raw: true }), { CLIENT_SALT: "s" }, seller(), NOW);
  assert.equal(big.status, 400);
  const get = await handleFacilitatorCheck(new Request("https://api.402xagent.com" + FACIL_CHECK_PATH), {}, seller(), NOW);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  assert.equal(parseFacilInput({ paymentRequirements: REQ, url: URL_ }).req.amount, "20000");
});

test("rate limit: 60/min per caller IP digest; rotating ?client= (or User-Agent) gains nothing; never the spot-check quota", async () => {
  const env = { CLIENT_SALT: "s", ...quota() };
  assert.equal(FACIL_CHECK_PER_MIN, 60);
  const body = (i) => ({ paymentRequirements: REQ, url: `https://s${i}.fixture/api` }); // distinct hosts: only the IP limit applies
  const call = (i, opts) => handleFacilitatorCheck(post(body(i), opts), env, seller(), NOW);
  for (let i = 0; i < FACIL_CHECK_PER_MIN; i++) assert.equal((await call(i, { q: "?client=rot-" + i })).status, 200, "call " + i);
  for (const q of ["", "?client=fresh-name", "?client=another"]) {
    const r = await call(100, { q });
    assert.equal(r.status, 429, "rotated client " + q);
    const j = await r.json();
    assert.deepEqual([j.code, j.recommendation], ["rate_limited", "hold"]);
    assert.ok(j.retry_after_seconds > 0 && r.headers.get("retry-after"));
  }
  const ua = new Request(post(body(101)), { headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7", "user-agent": "rotated/1" } });
  assert.equal((await handleFacilitatorCheck(ua, env, seller(), NOW)).status, 429, "rotated UA");
  assert.equal((await call(102, { ip: "192.0.2.80" })).status, 200, "another IP unaffected");
  assert.equal((await handleFacilitatorCheck(post(body(103)), env, seller(), new Date("2026-10-27T15:01:05Z"))).status, 200, "next minute");
  const ipKeys = env.calls.filter((c) => c.counter === "fck");
  assert.ok(ipKeys.length > 0);
  for (const c of ipKeys) { assert.match(c.key, /^fck:ip:[0-9a-f]{24}$/); assert.match(c.day, /^2026-10-27T15:0[01]$/); }
  assert.equal(new Set(ipKeys.filter((c) => c.day.endsWith("15:00")).map((c) => c.key)).size, 2, "one bucket per IP whatever the client name");
  for (const c of env.calls) assert.ok(["fck", "fckh"].includes(c.counter), c.counter);
  assert.ok(!env.calls.some((c) => /spotcheck|^ip:|^c:|rot-|fresh/.test(c.key) || c.counter === "spotcheck" || c.counter === "q"), "spot-check quota untouched, client names unused");
  assert.ok(!env.calls.some((c) => /198\.51|192\.0/.test(c.key)), "no raw IP in keys");
});

test("per seller host cap: 30 probes/min across all callers (lowercase host), then 429 hold with nothing probed", async () => {
  const env = { CLIENT_SALT: "s", ...quota() };
  assert.equal(FACIL_HOST_PER_MIN, 30);
  const calls = [];
  for (let i = 0; i < FACIL_HOST_PER_MIN; i++) {
    const host = i % 2 ? "SELLER.fixture" : "seller.fixture."; // case + trailing dot normalize to one host
    const r = await handleFacilitatorCheck(post({ paymentRequirements: REQ, url: `https://${host}/api/${i}` }, { ip: "203.0.113." + (i + 1) }), env, seller([LIVE], 402, calls), NOW);
    assert.equal(r.status, 200, "call " + i);
  }
  assert.equal(calls.length, FACIL_HOST_PER_MIN);
  const r = await handleFacilitatorCheck(post({ paymentRequirements: REQ, url: URL_ }, { ip: "192.0.2.200" }), env, seller([LIVE], 402, calls), NOW);
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.deepEqual([j.code, j.recommendation, j.nothing_probed], ["host_rate_limited", "hold", true]);
  assert.ok(j.retry_after_seconds > 0 && r.headers.get("retry-after"));
  assert.equal(calls.length, FACIL_HOST_PER_MIN, "no probe over the cap");
  assert.equal((await handleFacilitatorCheck(post({ paymentRequirements: REQ, url: "https://other.fixture/api" }, { ip: "192.0.2.200" }), env, seller([LIVE], 402, calls), NOW)).status, 200, "other hosts unaffected");
  const hostKeys = [...new Set(env.calls.filter((c) => c.counter === "fckh").map((c) => c.key))].sort();
  assert.deepEqual(hostKeys, ["fckh:other.fixture", "fckh:seller.fixture"]);
});

test("x402 v1 seller: live maxAmountRequired + v1 network name compare like v2 (settle / hold with the live value)", async () => {
  const V1 = { scheme: "exact", network: "base", maxAmountRequired: "20000", asset: ASSET, payTo: PAYTO, resource: URL_, maxTimeoutSeconds: 60 };
  const v1seller = (live) => ({ resolveHostFn: async () => ["203.0.113.50"], fetchImpl: async () => new Response(JSON.stringify({ x402Version: 1, accepts: [live] }), { status: 402, headers: { "content-type": "application/json" } }) });
  const ok = await run({ paymentRequirements: REQ, url: URL_ }, v1seller(V1));
  assert.deepEqual([ok.status, ok.body.match, ok.body.recommendation], [200, true, "settle"]);
  assert.equal(ok.body.live_terms_sha256, createHash("sha256").update(["eip155:8453", ASSET.toLowerCase(), "20000", PAYTO.toLowerCase()].join("|")).digest("hex"));
  const bad = await run({ paymentRequirements: REQ, url: URL_ }, v1seller({ ...V1, maxAmountRequired: "25000" }));
  assert.deepEqual([bad.body.match, bad.body.recommendation], [false, "hold"]);
  assert.deepEqual(bad.body.mismatches, [{ field: "amount", expected: "20000", live: "25000" }]);
  // diffTerms on a raw v1 entry (not via the probe summary) reads maxAmountRequired too
  assert.deepEqual(diffTerms(REQ, V1), []);
  assert.deepEqual(diffTerms(REQ, { ...V1, maxAmountRequired: "1" }), [{ field: "amount", expected: "20000", live: "1" }]);
  assert.deepEqual(diffTerms(REQ, { ...V1, network: "base-sepolia" }).map((m) => m.field), ["network"]);
});

test("limiter fails CLOSED on this route: counter error (IP or host) or no binding -> 503 limiter_unavailable, hold, no outbound fetch", async () => {
  const throwing = (failCounter) => ({ idFromName: (n) => n, get: () => ({ fetch: async (u) => {
    const c = new URL(u).searchParams.get("counter");
    if (!failCounter || c === failCounter) throw new Error("DO unavailable");
    return new Response(JSON.stringify({ free: true, used: 1 }));
  } }) });
  for (const [label, env] of [["ip counter throws", { CLIENT_SALT: "s", QUOTA: throwing("fck") }], ["host counter throws", { CLIENT_SALT: "s", QUOTA: throwing("fckh") }], ["every counter throws", { CLIENT_SALT: "s", QUOTA: throwing(null) }], ["no QUOTA binding", { CLIENT_SALT: "s" }]]) {
    const calls = [];
    const r = await handleFacilitatorCheck(post({ paymentRequirements: REQ, url: URL_ }), env, seller([LIVE], 402, calls), NOW);
    assert.equal(r.status, 503, label);
    const j = await r.json();
    assert.deepEqual([j.error, j.recommendation, j.nothing_probed], ["limiter_unavailable", "hold", true], label);
    assert.ok(r.headers.get("retry-after"), label);
    assert.equal(calls.length, 0, label + ": no outbound fetch to the seller");
  }
});

test("routed via the worker; listed in OpenAPI, llms.txt, skill.md, docs; not on the pricing page", async () => {
  const q = quota();
  const env = { DATA_BASE_URL: "https://data.fixture/vc/", CLIENT_SALT: "s", QUOTA: q.QUOTA };
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const s = String(u);
    if (s.startsWith("https://cloudflare-dns.com/")) return new Response(JSON.stringify({ Answer: new URL(s).searchParams.get("type") === "A" ? [{ type: 1, data: "203.0.113.50" }] : [] }), { headers: { "content-type": "application/dns-json" } });
    if (s === URL_) return new Response(JSON.stringify({ x402Version: 2, accepts: [LIVE] }), { status: 402, headers: { "content-type": "application/json" } });
    return real(u, init);
  };
  try {
    const res = await worker.fetch(post({ paymentRequirements: REQ, url: URL_ }), env, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).recommendation, "settle");
    assert.deepEqual(q.calls.map((c) => c.counter).sort(), ["fck", "fckh"]);
    const bad = await worker.fetch(post({}), env, { waitUntil() {} });
    assert.equal(bad.status, 400);
    const bb = await bad.json();
    assert.equal(bb.recommendation, "hold");
    assert.equal(bb.field, "paymentRequirements");
  } finally { globalThis.fetch = real; }
  const txt = async (p) => (await worker.fetch(new Request("https://api.402xagent.com" + p), env, { waitUntil() {} })).text();
  const oa = JSON.parse(await txt("/openapi.json"));
  assert.ok(oa.paths[FACIL_CHECK_PATH] && oa.paths[FACIL_CHECK_PATH].post);
  assert.deepEqual(oa.paths[FACIL_CHECK_PATH].post.security, []);
  assert.match(await txt("/llms.txt"), /\/v1\/facilitator\/check/);
  assert.match(await txt("/skill.md"), /\/v1\/facilitator\/check/);
  assert.match(await txt("/docs"), /id="facilitator-check"/);
  assert.doesNotMatch(await txt("/pricing"), /facilitator\/check/);
});
