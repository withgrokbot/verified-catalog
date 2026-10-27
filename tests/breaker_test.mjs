// 0.56.0 hardening (b): per-target probe timeout (PROBE_TIMEOUT_MS) + per-host circuit breaker (worker/src/breaker.js).
// Real SQLite (node:sqlite) with every migration behind a tiny D1 adapter (same harness as transient_test.mjs); DNS,
// sellers, quota and the Cache API are stubbed. Synthetic hosts only; nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { probeKeyHash, VERSION, SPOT_PAID_ATOMIC } from "../worker/src/lib.js";
import { spotProbe, decideVerdict } from "../worker/src/spotcheck.js";
import * as B from "../worker/src/breaker.js";
import * as T from "../worker/src/transient.js";
import { REASON_CODES } from "../worker/src/rules.js";
import { REASON_TEXT } from "../worker/src/recent.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(ROOT, "worker", "migrations");
const MIGS = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(MIG_DIR, f), "utf8"));
function d1() {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGS) db.exec(m);
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({
    sql, args, bind: (...a) => mk(sql, norm(a)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _run: () => db.prepare(sql).run(...args),
  });
  return { raw: db, prepare: (sql) => mk(sql), batch: async (st) => { db.exec("BEGIN"); try { for (const s of st) s._run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; } };
}
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const H = 3600000, MIN = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x" + "bb".repeat(20);
function pay402() {
  const body = { x402Version: 2, error: "Payment required", accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300 }] };
  return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "payment-required": btoa(JSON.stringify(body)) } });
}
const hang = (init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));

// seller behaviour per host; mode can be switched by a test
const mode = { "api.flaky5xx.dev": "5xx", "api.slowfix.dev": "hang", "api.plain403b.dev": "403", "api.rate429b.dev": "429", "api.healthyb.dev": "pay" };
const sellerHits = [], otherHits = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "cloudflare-dns.com") {
    const name = u.searchParams.get("name"), type = u.searchParams.get("type");
    if (name === "api.privb.dev") return Response.json(type === "A" ? { Answer: [{ type: 1, data: "10.0.0.7" }] } : { Answer: [] });
    return Response.json(type === "A" ? { Answer: [{ type: 1, data: "93.184.216.34" }] } : { Answer: [] });
  }
  if (mode[u.hostname]) {
    sellerHits.push(u.hostname + u.pathname);
    const m = mode[u.hostname];
    if (m === "5xx") return new Response("upstream down", { status: 503 });
    if (m === "hang") return hang(init);
    if (m === "403") return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
    if (m === "429") return new Response("slow down", { status: 429 });
    if (m === "reset") throw new TypeError("fetch failed: connection reset");
    return pay402();
  }
  otherHits.push(u.hostname);
  return new Response("not stubbed: " + u, { status: 599 });
};
const noKv = { get: async () => null, put: async () => { throw new Error("0.56.0 must not write KV"); }, delete: async () => { throw new Error("no KV deletes"); } };
// in-memory stand-in for the QUOTA Durable Object; logs every operation
function fakeQuota() {
  const n = new Map(); const ops = [];
  return { ops, idFromName: (k) => k, get: (k) => ({ fetch: async (u) => {
    const x = new URL(u); const op = x.pathname.slice(1), limit = Number(x.searchParams.get("limit")), key = k + "|" + x.searchParams.get("counter") + "|" + x.searchParams.get("day");
    ops.push(op + ":" + x.searchParams.get("counter"));
    const used = n.get(key) || 0;
    if (op === "take" && used < limit) { n.set(key, used + 1); return Response.json({ free: true, used: used + 1 }); }
    return Response.json({ free: used < limit, used });
  } }) };
}
// stand-in for caches.default (one data center): Map of key URL -> body text; logs puts
function fakeCache() {
  const m = new Map(); const puts = [];
  return { m, puts, match: async (k) => (m.has(String(k)) ? new Response(m.get(String(k))) : undefined), put: async (k, r) => { puts.push(String(k)); m.set(String(k), await r.text()); }, delete: async (k) => m.delete(String(k)) };
}
const envFor = (db, extra = {}) => ({ RECEIPTS_DB: db, CLIENT_SALT: "salt", SPOT_PROBE_CACHE_S: "0", CRAWL_KV: noKv, SPOT_KV: noKv, BREAKER_CACHE: null, ...extra });
async function callAs(env, path, ip, headers = {}) {
  const r = await worker.fetch(new Request("https://api.402xagent.com" + path, { headers: { accept: "application/json", "user-agent": "agent-x/1.0", "cf-connecting-ip": ip, ...headers } }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}
const spot = (url, extra = "") => "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(url) + extra;

test("knobs: PROBE_TIMEOUT_MS default 8000 (1000-30000), BREAKER_FAILS 3 / WINDOW 10 min / COOLDOWN 15 min, BREAKER_FAILS=0 turns it off", () => {
  assert.equal(VERSION, "0.56.0");
  assert.equal(B.probeTimeoutMs({}), 8000); assert.equal(B.probeTimeoutMs({ PROBE_TIMEOUT_MS: "5000" }), 5000);
  for (const bad of ["", "abc", "999", "30001", "-1", "2500.5"]) assert.equal(B.probeTimeoutMs({ PROBE_TIMEOUT_MS: bad }), 8000, bad);
  const c = B.breakerCfg({});
  assert.deepEqual([c.enabled, c.fails, c.windowMin, c.cooldownMin, c.windowMs, c.cooldownMs], [true, 3, 10, 15, 10 * MIN, 15 * MIN]);
  assert.equal(B.breakerCfg({ BREAKER_FAILS: "0" }).enabled, false);
  assert.deepEqual([B.breakerCfg({ BREAKER_FAILS: "x", BREAKER_WINDOW_MIN: "-1", BREAKER_COOLDOWN_MIN: "9999" })].map((x) => [x.fails, x.windowMin, x.cooldownMin])[0], [3, 10, 15]);
});

test("breakerOutcome: 5xx / timeout / connection error fail; any other HTTP answer (402, 403, 404, 429) is ok; SSRF, DNS, own concurrency cap are ignored", () => {
  assert.equal(B.breakerOutcome({ reachable: true, http_status: 503 }), "fail");
  assert.equal(B.breakerOutcome({ reachable: false, error: "fetch timeout" }), "fail");
  assert.equal(B.breakerOutcome({ reachable: false, http_status: 200, error: "fetch timeout (body)" }), "fail");
  assert.equal(B.breakerOutcome({ reachable: false, error: "fetch failed" }), "fail");
  for (const s of [200, 402, 403, 404, 429]) assert.equal(B.breakerOutcome({ reachable: true, http_status: s }), "ok", String(s));
  assert.equal(B.breakerOutcome({ reachable: false, ssrf_blocked: true, error: "fetch failed" }), null);
  assert.equal(B.breakerOutcome({ reachable: false, dns_error: true }), null);
  assert.equal(B.breakerOutcome({ reachable: false, error: "too many concurrent probes; retry shortly" }), null);
  assert.equal(B.breakerOutcome(B.hostUnstableProbe({})), null);
  assert.deepEqual(decideVerdict(B.hostUnstableProbe({ state: "open" })), { verdict: "recheck", reason: "host_unstable" });
  assert.deepEqual(decideVerdict({ reachable: false, ssrf_blocked: true, host_unstable: true }), { verdict: "skip", reason: "ssrf_blocked" }, "SSRF wins");
});

test("state machine: open after 3 failures in the window, half-open single probe after the cooldown, success closes, failure re-opens", async () => {
  B._resetBreakers();
  const env = { BREAKER_CACHE: null }, h = "api.state.dev";
  let t = 1_000_000_000_000;
  assert.equal(await B.breakerRecord(env, h, "fail", {}, t), "counting");
  assert.equal(await B.breakerRecord(env, h, "fail", {}, t + MIN), "counting");
  assert.equal((await B.breakerGate(env, h, t + 2 * MIN)).allow, true, "2 failures: still closed");
  assert.equal(await B.breakerRecord(env, h, "fail", {}, t + 2 * MIN), "open");
  let g = await B.breakerGate(env, h, t + 3 * MIN);
  assert.equal(g.allow, false); assert.equal(g.breaker.state, "open"); assert.equal(g.breaker.retry_after_s, 14 * 60);
  assert.deepEqual([g.breaker.fails_to_open, g.breaker.window_min, g.breaker.cooldown_min], [3, 10, 15]);
  assert.equal((await B.breakerGate(env, h, t + 16 * MIN)).allow, false, "cooldown is 15 min from opening");
  // cooldown over: exactly one half-open probe
  g = await B.breakerGate(env, h, t + 17.5 * MIN);
  assert.deepEqual([g.allow, g.half_open], [true, true]);
  const g2 = await B.breakerGate(env, h, t + 17.5 * MIN + 10);
  assert.equal(g2.allow, false, "a second check while the half-open probe runs is still host_unstable"); assert.equal(g2.breaker.state, "half_open");
  // the half-open probe fails -> a full new cooldown
  assert.equal(await B.breakerRecord(env, h, "fail", { halfOpen: true }, t + 17.6 * MIN), "open");
  assert.equal((await B.breakerGate(env, h, t + 30 * MIN)).allow, false);
  g = await B.breakerGate(env, h, t + 33 * MIN);
  assert.deepEqual([g.allow, g.half_open], [true, true]);
  // ... and this time it succeeds -> closed, the next check is a normal probe
  assert.equal(await B.breakerRecord(env, h, "ok", { halfOpen: true }, t + 33.1 * MIN), "closed");
  g = await B.breakerGate(env, h, t + 33.2 * MIN);
  assert.deepEqual([g.allow, g.half_open], [true, false]);
  // a half-open probe that says nothing about the host (e.g. our own concurrency cap) hands the lease back
  for (let i = 0; i < 3; i++) await B.breakerRecord(env, h, "fail", {}, t + 40 * MIN + i);
  assert.equal((await B.breakerGate(env, h, t + 56 * MIN)).half_open, true);
  await B.breakerRecord(env, h, null, { halfOpen: true }, t + 56 * MIN + 5);
  assert.equal((await B.breakerGate(env, h, t + 56 * MIN + 10)).half_open, true, "lease released");
  t += 100 * MIN;
});

test("state machine: failures older than the window or separated by a success do not add up; hosts are independent; BREAKER_FAILS=0 never opens", async () => {
  B._resetBreakers();
  const env = { BREAKER_CACHE: null }, t = 2_000_000_000_000;
  await B.breakerRecord(env, "a.dev", "fail", {}, t);
  await B.breakerRecord(env, "a.dev", "fail", {}, t + 1 * MIN);
  assert.equal(await B.breakerRecord(env, "a.dev", "fail", {}, t + 11 * MIN), "counting", "the first failure left the 10 min window");
  await B.breakerRecord(env, "b.dev", "fail", {}, t); await B.breakerRecord(env, "b.dev", "fail", {}, t + 1);
  await B.breakerRecord(env, "b.dev", "ok", {}, t + 2);
  assert.equal(await B.breakerRecord(env, "b.dev", "fail", {}, t + 3), "counting", "a success in between resets the count");
  assert.equal((await B.breakerGate(env, "c.dev", t)).allow, true, "other hosts unaffected");
  const off = { BREAKER_CACHE: null, BREAKER_FAILS: "0" };
  for (let i = 0; i < 10; i++) await B.breakerRecord(off, "d.dev", "fail", {}, t + i);
  assert.equal((await B.breakerGate(off, "d.dev", t + 20)).allow, true);
});

test("store: per-isolate memory written through to the Cache API (one data center): a new isolate sees an open breaker; cache key is a hashed name under our API origin, never fetched; no cache = memory only", async () => {
  B._resetBreakers();
  const cache = fakeCache(); const env = { BREAKER_CACHE: cache }, h = "api.cachefix.dev", t = 3_000_000_000_000;
  for (let i = 0; i < 3; i++) await B.breakerRecord(env, h, "fail", {}, t + i);
  assert.equal(cache.m.size, 1);
  const key = [...cache.m.keys()][0];
  assert.ok(key.startsWith(B.BREAKER_KEY_ORIGIN)); assert.ok(!key.includes("cachefix"), "the host name is hashed in the key");
  B._resetBreakers(); // another isolate in the same colo
  assert.equal((await B.breakerGate(env, h, t + MIN)).allow, false);
  assert.equal((await B.breakerGate({ BREAKER_CACHE: null }, h, t + MIN)).allow, true, "no shared cache and a fresh isolate: closed (fails open)");
  // closing deletes the entry
  await B.breakerRecord(env, h, "ok", {}, t + 2 * MIN);
  assert.equal(cache.m.size, 0);
  // a broken cache fails open to memory
  B._resetBreakers();
  const broken = { match: async () => { throw new Error("cache down"); }, put: async () => { throw new Error("cache down"); }, delete: async () => { throw new Error("x"); } };
  for (let i = 0; i < 3; i++) await B.breakerRecord({ BREAKER_CACHE: broken }, h, "fail", {}, t + i);
  assert.equal((await B.breakerGate({ BREAKER_CACHE: broken }, h, t + MIN)).allow, false, "memory still trips it");
  // a healthy host never writes: one cache read per gate, zero puts
  B._resetBreakers(); cache.puts.length = 0;
  await B.breakerGate(env, "api.healthy.dev", t); await B.breakerRecord(env, "api.healthy.dev", "ok", {}, t);
  assert.deepEqual(cache.puts, []);
});

test("per-target timeout: a hanging seller is recheck/timeout (never pay), one budget covers all redirect hops and the body", async () => {
  const resolveHostFn = async () => ["93.184.216.34"];
  // 1) no answer at all
  let t0 = Date.now();
  let p = await spotProbe("https://api.hangfix.dev/x", { resolveHostFn, timeoutMs: 60, fetchImpl: (u, init) => hang(init) });
  assert.equal(p.error, "fetch timeout"); assert.equal(p.timeout_ms, 60); assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(decideVerdict(p), { verdict: "recheck", reason: "timeout" });
  // 2) each redirect hop takes ~45 ms: before 0.56.0 each hop had the full budget (4 x 60 ms passes); now the target has 60 ms total
  let hops = 0;
  const slowRedirect = (u, init) => new Promise((res, rej) => {
    const tm = setTimeout(() => { hops++; res(hops < 3 ? new Response("", { status: 302, headers: { location: "/next" + hops } }) : pay402()); }, 45);
    init.signal.addEventListener("abort", () => { clearTimeout(tm); rej(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  });
  p = await spotProbe("https://api.hopfix.dev/x", { resolveHostFn, timeoutMs: 60, fetchImpl: slowRedirect });
  assert.equal(decideVerdict(p).reason, "timeout", JSON.stringify(p)); assert.ok(hops <= 2);
  hops = 0;
  p = await spotProbe("https://api.hopfix.dev/x", { resolveHostFn, timeoutMs: 1000, fetchImpl: slowRedirect });
  assert.equal(decideVerdict(p).verdict, "pay", "within budget: unchanged");
  // 3) headers arrive, the body stalls (a 402 that never finishes) -> timeout, not pay
  const stallBody = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"x402Version":2,')); } }), { status: 402, headers: { "content-type": "application/json" } });
  t0 = Date.now();
  p = await spotProbe("https://api.stallfix.dev/x", { resolveHostFn, timeoutMs: 80, fetchImpl: async () => stallBody() });
  assert.equal(p.error, "fetch timeout (body)"); assert.equal(p.http_status, 402); assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(decideVerdict(p), { verdict: "recheck", reason: "timeout" });
  assert.equal(B.breakerOutcome(p), "fail");
});

test("live route: PROBE_TIMEOUT_MS from env drives the probe; a timeout is recheck/timeout and counts toward the breaker", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db, { PROBE_TIMEOUT_MS: "1000" });
  const t0 = Date.now();
  const r = await callAs(env, spot("https://api.slowfix.dev/v1/a"), "198.18.20.1");
  assert.ok(Date.now() - t0 < 4000, "the 1 s budget, not the 8 s default");
  assert.equal(r.body.verdict, "recheck"); assert.equal(r.body.reason_code, "timeout");
  const row = db.raw.prepare("SELECT body FROM spot_receipts").get();
  assert.equal(JSON.parse(row.body).probe_snapshot.timeout_ms, 1000);
  for (let i = 0; i < 2; i++) assert.equal((await callAs(env, spot("https://api.slowfix.dev/v1/b" + i), "198.18.20." + (i + 2))).body.reason_code, "timeout");
  const n = sellerHits.length;
  const r4 = await callAs(env, spot("https://api.slowfix.dev/v1/c"), "198.18.20.9");
  assert.equal(r4.body.reason_code, "host_unstable", "3 timeouts opened the breaker"); assert.equal(sellerHits.length, n, "not fetched");
});

test("live route: 3 x 5xx open the breaker; then recheck/host_unstable for the whole host, target not fetched, NO free check used, never charged or settled", async () => {
  B._resetBreakers();
  const db = d1(); const quota = fakeQuota(); const env = envFor(db, { QUOTA: quota });
  sellerHits.length = 0; otherHits.length = 0;
  const ip = "198.18.21.1";
  for (let i = 0; i < 3; i++) {
    const r = await callAs(env, spot("https://api.flaky5xx.dev/v1/q" + i), ip);
    assert.equal(r.body.reason_code, "server_error"); assert.equal(r.body.access.free_used_today, i + 1);
  }
  assert.equal(sellerHits.length, 3);
  const opsBefore = quota.ops.length;
  for (let i = 0; i < 6; i++) { // more than the free tier: none of these touch it
    const r = await callAs(env, spot("https://api.flaky5xx.dev/v1/other" + i), ip);
    assert.equal(r.status, 200); assert.equal(r.body.verdict, "recheck"); assert.equal(r.body.reason_code, "host_unstable"); assert.equal(r.body.confidence, "low");
    assert.equal(r.body.reason, "price unlisted, " + REASON_TEXT.host_unstable);
    assert.equal(r.body.access.tier, "free"); assert.equal(r.body.access.free_check_used, false); assert.equal(r.body.access.charged, false);
    assert.equal(r.body.breaker.state, "open"); assert.ok(r.body.breaker.retry_after_s > 0 && r.body.breaker.retry_after_s <= 900);
    assert.equal(r.headers.get("retry-after"), String(r.body.breaker.retry_after_s));
    assert.ok(r.body.receipt_id, "receipt stored");
  }
  assert.equal(sellerHits.length, 3, "the target is not fetched while the breaker is open");
  assert.equal(quota.ops.length, opsBefore, "no quota counter read or taken");
  // a payment header is never verified or settled
  const paid = await callAs(env, spot("https://api.flaky5xx.dev/v1/p"), "198.18.21.2", { "payment-signature": btoa(JSON.stringify({ x402Version: 2, payload: { authorization: { from: "0x" + "dd".repeat(20) } } })) });
  assert.equal(paid.status, 200); assert.equal(paid.body.reason_code, "host_unstable"); assert.equal(paid.body.access.charged, false); assert.equal(paid.body.access.tx, undefined);
  assert.equal(paid.headers.get("payment-response"), null); assert.equal(paid.headers.get("x-payment-response"), null);
  assert.deepEqual(otherHits, [], "no facilitator or other outside call");
  // dry runs see the same answer without a fetch
  const dry = await callAs(env, spot("https://api.flaky5xx.dev/v1/d", "&mode=dry-run"), "198.18.21.3");
  assert.equal(dry.body.mode, "dry-run"); assert.equal(dry.body.reason_code, "host_unstable");
  assert.equal(sellerHits.length, 3);
  // the same client still has its remaining free checks for other hosts
  const ok = await callAs(env, spot("https://api.healthyb.dev/v1/q"), ip);
  assert.equal(ok.body.verdict, "pay"); assert.equal(ok.body.access.free_used_today, 4);
  // stored breaker answers are not public recent checks
  const hist = db.raw.prepare("SELECT COUNT(*) AS n FROM spot_receipts WHERE reason = 'host_unstable' AND pub_url IS NOT NULL").get().n;
  assert.equal(hist, 0);
});

test("live route: after the cooldown one half-open probe decides: a recovered host closes (normal pay), a still-failing host re-opens", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db, { BREAKER_COOLDOWN_MIN: "0.002" }); // 120 ms
  sellerHits.length = 0;
  mode["api.flaky5xx.dev"] = "5xx";
  for (let i = 0; i < 3; i++) await callAs(env, spot("https://api.flaky5xx.dev/v1/h" + i), "198.18.22." + (i + 1));
  assert.equal((await callAs(env, spot("https://api.flaky5xx.dev/v1/h"), "198.18.22.9")).body.reason_code, "host_unstable");
  await sleep(150);
  // still failing -> the half-open probe fetches once, then the breaker re-opens
  let r = await callAs(env, spot("https://api.flaky5xx.dev/v1/h"), "198.18.22.10");
  assert.equal(r.body.reason_code, "server_error"); assert.equal(sellerHits.length, 4);
  r = await callAs(env, spot("https://api.flaky5xx.dev/v1/h"), "198.18.22.11");
  assert.equal(r.body.reason_code, "host_unstable"); assert.equal(sellerHits.length, 4);
  await sleep(150);
  mode["api.flaky5xx.dev"] = "pay"; // recovered
  r = await callAs(env, spot("https://api.flaky5xx.dev/v1/h"), "198.18.22.12");
  assert.equal(r.body.verdict, "pay"); assert.equal(sellerHits.length, 5);
  r = await callAs(env, spot("https://api.flaky5xx.dev/v1/h2"), "198.18.22.13");
  assert.equal(r.body.verdict, "pay", "closed: normal probes again"); assert.equal(sellerHits.length, 6);
  mode["api.flaky5xx.dev"] = "5xx";
});

test("connection errors trip it too; SSRF stays skip/ssrf_blocked (400, never fetched, never counted); a plain 403 and a 429 are unchanged and never trip it", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db);
  mode["api.resetfix.dev"] = "reset";
  for (let i = 0; i < 3; i++) assert.equal((await callAs(env, spot("https://api.resetfix.dev/v1/x" + i), "198.18.23." + (i + 1))).body.reason_code, "unreachable");
  assert.equal((await callAs(env, spot("https://api.resetfix.dev/v1/y"), "198.18.23.9")).body.reason_code, "host_unstable");
  for (let i = 0; i < 4; i++) {
    const s = await callAs(env, spot("https://api.privb.dev/v1/x"), "198.18.24." + (i + 1));
    assert.equal(s.status, 400); assert.equal(s.body.verdict, "skip"); assert.equal(s.body.reason_code, "ssrf_blocked");
  }
  for (let i = 0; i < 5; i++) {
    const a = (await callAs(env, spot("https://api.plain403b.dev/v1/x" + i), "198.18.25." + (i + 1))).body;
    assert.equal(a.verdict, "skip"); assert.equal(a.reason_code, "no_paywall");
    const b = (await callAs(env, spot("https://api.rate429b.dev/v1/x" + i), "198.18.26." + (i + 1))).body;
    assert.equal(b.verdict, "recheck"); assert.equal(b.reason_code, "rate_limited");
  }
});

async function seed(db, url, ageH, verdict, reason) {
  const id = "sc-" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const at = iso(Date.now() - ageH * H);
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, norm_key, probed_at, body) VALUES (?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?)")
    .run(id, url, at, verdict, reason, await probeKeyHash(url, "GET"), at, JSON.stringify({ id, url, verdict, reason, checked_at: at, probe: { probed_at: at } }));
  return id;
}

test("0.55.0 transient fallback: host_unstable is neutral (never counts toward a streak, never breaks one, never becomes a skip); past rows untouched", async () => {
  B._resetBreakers();
  const U = "https://api.rate429b.dev/v1/streak";
  // a 30 h rate_limited streak with a breaker answer in the middle still falls back to the persistent skip
  let db = d1(); let env = envFor(db);
  await seed(db, U, 30, "recheck", "rate_limited");
  const mid = await seed(db, U, 2, "recheck", "host_unstable");
  const before = db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(mid).body;
  let r = (await callAs(env, spot(U), "198.18.27.1")).body;
  assert.equal(r.reason_code, "rate_limited_persistent", "host_unstable did not break the streak");
  assert.equal(r.transient.hours >= 30, true);
  assert.equal(db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(mid).body, before, "past receipt unchanged");
  // only host_unstable rows (30 h of them) do not start a streak: the next 429 is a first-time recheck
  db = d1(); env = envFor(db);
  await seed(db, U, 30, "recheck", "host_unstable");
  r = (await callAs(env, spot(U), "198.18.27.2")).body;
  assert.equal(r.verdict, "recheck"); assert.equal(r.reason_code, "rate_limited"); assert.equal(r.transient.since, null);
  // and the guard never converts host_unstable itself
  const g = await T.applyTransientGuard({ RECEIPTS_DB: db }, { verdict: "recheck", reason: "host_unstable" }, "k:x", iso(Date.now()));
  assert.deepEqual(g, { d: { verdict: "recheck", reason: "host_unstable" }, transient: null });
  assert.ok(!T.STREAK_CODES.includes("host_unstable")); assert.ok(T.STREAK_NEUTRAL_CODES.includes("host_unstable"));
  const plan = db.raw.prepare("EXPLAIN QUERY PLAN " + T.STREAK_SQL).all("k:x").map((x) => x.detail).join(" | ");
  assert.match(plan, /spot_receipts_probe_cache/, "still the existing index");
});

test("a stored host_unstable answer is never reused as the 5-min probe cache; rules, reason text, OpenAPI enum and llms.txt list host_unstable; price and free tier unchanged; no new migration", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db, { SPOT_PROBE_CACHE_S: "300" });
  const U = "https://api.healthyb.dev/v1/cached";
  const at = iso(Date.now() - 1000);
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, norm_key, probed_at, body) VALUES ('sc-00000000000000aa', ?, ?, 'recheck', 'host_unstable', 'live', NULL, ?, ?, ?)")
    .run(U, at, await probeKeyHash(U, "GET"), at, JSON.stringify({ id: "sc-00000000000000aa", probe: { probed_at: at }, probe_snapshot: B.hostUnstableProbe({ state: "open" }) }));
  sellerHits.length = 0;
  const r = (await callAs(env, spot(U), "198.18.28.1")).body;
  assert.equal(r.verdict, "pay"); assert.deepEqual(sellerHits, ["api.healthyb.dev/v1/cached"]);
  const rc = REASON_CODES.find((x) => x.code === "host_unstable");
  assert.equal(rc.verdict, "recheck"); assert.equal(rc.confidence, "low"); assert.ok(REASON_TEXT.host_unstable);
  const oa = (await callAs(envFor(d1()), "/openapi.json", "198.18.28.2")).body;
  assert.ok(JSON.stringify(oa).includes('"host_unstable"'));
  assert.match(oa.paths["/v1/products/endpoint-spot-check"].get.responses[200].description, /recheck\/host_unstable/);
  assert.match(oa.paths["/v1/products/endpoint-spot-check"].get.responses[200].description, /PROBE_TIMEOUT_MS, default 8000 ms/);
  const llms = await (await worker.fetch(new Request("https://api.402xagent.com/llms.txt", { headers: { "user-agent": "agent-x/1.0" } }), envFor(d1()), { waitUntil() {} })).text();
  assert.match(llms, /host_unstable/); assert.match(llms, /PROBE_TIMEOUT_MS/);
  const toml = readFileSync(join(ROOT, "worker", "wrangler.toml"), "utf8");
  assert.match(toml, /SPOT_FREE_PER_DAY = "5"/); assert.equal(SPOT_PAID_ATOMIC, "20000");
  assert.ok(!readdirSync(MIG_DIR).some((f) => /^002[1-9]/.test(f)), "0.56.0 adds no migration");
});

test.after(() => { globalThis.fetch = origFetch; });
