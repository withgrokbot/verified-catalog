// 0.57.0 hardening (a): multi-probe before pay (worker/src/multiprobe.js). Same harness as breaker_test.mjs: real SQLite
// (node:sqlite) with every migration behind a tiny D1 adapter; DNS, sellers, quota and the Cache API are stubbed.
// Synthetic hosts only; nothing leaves the process, nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { VERSION, SPOT_PAID_ATOMIC } from "../worker/src/lib.js";
import { decideVerdict, SPOT_DEFAULT_FREE_PER_DAY } from "../worker/src/spotcheck.js";
import * as M from "../worker/src/multiprobe.js";
import * as B from "../worker/src/breaker.js";
import { REASON_CODES, RULES_VERSION } from "../worker/src/rules.js";
import { REASON_TEXT } from "../worker/src/recent.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(ROOT, "worker", "migrations");
const MIG_FILES = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
const MIGS = MIG_FILES.map((f) => readFileSync(join(MIG_DIR, f), "utf8"));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x" + "bb".repeat(20);
const OTHER_PAY_TO = "0x" + "cc".repeat(20);
const offer = (o = {}) => ({ scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, ...o });
function r402(accepts) {
  const body = { x402Version: 2, error: "Payment required", accepts };
  return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "payment-required": btoa(JSON.stringify(body)) } });
}
const hang = (init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));

// Per host: a list of answers, one per seller hit (the last one repeats). Each answer is a function (init) -> Response.
const A = {
  pay: () => r402([offer()]),
  payReordered: () => r402([offer({ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }), offer({ payTo: PAY_TO.toUpperCase().replace("0X", "0x") })]),
  payTwoOffers: () => r402([offer({ payTo: PAY_TO }), offer({ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" })]),
  payNewNonce: () => r402([offer({ maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2", nonce: String(Math.random()) } })]),
  pay2000: () => r402([offer({ amount: "2000" })]),
  pay1009: () => r402([offer({ amount: "1009" })]), // +0.9%: inside the existing 1% PRICE_TOLERANCE
  pay1011: () => r402([offer({ amount: "1011" })]), // +1.1%: outside it
  pay991: () => r402([offer({ amount: "991" })]), // -0.9%
  solPay: () => r402([{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "1000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", maxTimeoutSeconds: 60, extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" } }]),
  solPayLowerPayTo: () => r402([{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "1000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "9xqewvg816bux9epjhmat23yvvm2zwbrrpzb9pusvfin", maxTimeoutSeconds: 60 }]),
  payOtherWallet: () => r402([offer({ payTo: OTHER_PAY_TO })]),
  payOtherNet: () => r402([offer({ network: "eip155:1" })]),
  payOtherScheme: () => r402([offer({ scheme: "upto" })]),
  payOtherAsset: () => r402([offer({ asset: "0x" + "dd".repeat(20) })]),
  noTerms: () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
  s503: () => new Response("upstream down", { status: 503 }),
  s429: () => new Response("slow down", { status: 429 }),
  hang: (init) => hang(init),
  reset: () => { throw new TypeError("fetch failed: connection reset"); },
  slowPay: async () => { await sleep(600); return r402([offer()]); },
  toMetadata: () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
  toPrivateName: () => new Response("", { status: 302, headers: { location: "https://internal.privmp.dev/x" } }),
};
const script = new Map(); // host -> [answer names]
const hits = new Map(); // host -> count
const sellerHits = [], otherHits = [], doh = [];
let rebindAfter = new Map(); // host -> number of public A answers before it resolves to a private address
const setScript = (host, ...names) => { script.set(host, names); hits.set(host, 0); };
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "cloudflare-dns.com") {
    const name = u.searchParams.get("name"), type = u.searchParams.get("type");
    doh.push({ name, type });
    if (name === "internal.privmp.dev") return Response.json(type === "A" ? { Answer: [{ type: 1, data: "10.1.2.3" }] } : { Answer: [] });
    if (rebindAfter.has(name) && type === "A") {
      const left = rebindAfter.get(name);
      rebindAfter.set(name, left - 1);
      return Response.json({ Answer: [{ type: 1, data: left > 0 ? "93.184.216.34" : "127.0.0.1" }] });
    }
    return Response.json(type === "A" ? { Answer: [{ type: 1, data: "93.184.216.34" }] } : { Answer: [] });
  }
  if (script.has(u.hostname)) {
    sellerHits.push(u.hostname + u.pathname);
    const n = hits.get(u.hostname); hits.set(u.hostname, n + 1);
    const list = script.get(u.hostname);
    return A[list[Math.min(n, list.length - 1)]](init);
  }
  otherHits.push(u.hostname);
  return new Response("not stubbed: " + u, { status: 599 });
};
const noKv = { get: async () => null, put: async () => { throw new Error("0.57.0 must not write KV"); }, delete: async () => { throw new Error("no KV deletes"); } };
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
const envFor = (db, extra = {}) => ({ RECEIPTS_DB: db, CLIENT_SALT: "salt", SPOT_PROBE_CACHE_S: "0", CRAWL_KV: noKv, SPOT_KV: noKv, BREAKER_CACHE: null, ...extra });
let ipN = 0;
const nextIp = () => "198.18.40." + (++ipN % 250 + 1);
async function callAs(env, path, ip = nextIp(), headers = {}) {
  const r = await worker.fetch(new Request("https://api.402xagent.com" + path, { headers: { accept: "application/json", "user-agent": "agent-x/1.0", "cf-connecting-ip": ip, ...headers } }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}
const spot = (url, extra = "") => "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(url) + extra;
const stored = (db, id) => JSON.parse(db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(id).body);
const hitsOf = (host) => sellerHits.filter((h) => h.startsWith(host + "/")).length;

test("knobs: MULTIPROBE_COUNT default 2 (1 = off, max 3), MULTIPROBE_GAP_MS default 250 (0-2000); worst case = PROBE_TIMEOUT_MS + (count-1)*(gap+1500)", () => {
  assert.equal(VERSION, "0.59.2");
  const c = M.multiprobeCfg({});
  assert.deepEqual([c.enabled, c.count, c.gapMs, c.minConfirmMs], [true, 2, 250, 1500]);
  assert.equal(M.multiprobeCfg({ MULTIPROBE_COUNT: "1" }).enabled, false);
  assert.equal(M.multiprobeCfg({ MULTIPROBE_COUNT: "3" }).count, 3);
  for (const bad of ["", "0", "4", "2.5", "x", "-1"]) assert.equal(M.multiprobeCfg({ MULTIPROBE_COUNT: bad }).count, 2, bad);
  assert.equal(M.multiprobeCfg({ MULTIPROBE_GAP_MS: "0" }).gapMs, 0);
  for (const bad of ["-1", "2001", "1.5", "abc"]) assert.equal(M.multiprobeCfg({ MULTIPROBE_GAP_MS: bad }).gapMs, 250, bad);
  assert.equal(M.multiprobeWorstCaseMs(8000, M.multiprobeCfg({})), 9750);
  assert.equal(M.multiprobeWorstCaseMs(8000, M.multiprobeCfg({ MULTIPROBE_COUNT: "1" })), 8000);
  assert.equal(M.multiprobeWorstCaseMs(8000, M.multiprobeCfg({ MULTIPROBE_COUNT: "3" })), 11500);
});

test("termsFingerprint: scheme, network, asset, amount and payTo of every offer; order and EVM case do not matter; nonce / timeout / extra are not terms", () => {
  const p = (accepts) => ({ accepts });
  const base = M.termsFingerprint(p([{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: PAY_TO }]));
  assert.ok(base);
  assert.equal(M.termsFingerprint(p([{ scheme: "exact", network: "eip155:8453", asset: USDC.toLowerCase(), amount: "1000", payTo: PAY_TO.toUpperCase().replace("0X", "0x"), maxTimeoutSeconds: 5, validBefore: 1 }])), base);
  for (const [k, v] of [["scheme", "upto"], ["network", "eip155:1"], ["asset", "0x" + "dd".repeat(20)], ["amount", "1001"], ["payTo", OTHER_PAY_TO]])
    assert.notEqual(M.termsFingerprint(p([{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: PAY_TO, [k]: v }])), base, k);
  const two = [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: PAY_TO }, { scheme: "exact", network: "eip155:84532", asset: "0xabc", amount: "1000", payTo: PAY_TO }];
  assert.equal(M.termsFingerprint(p(two)), M.termsFingerprint(p([...two].reverse())));
  // Solana base58 is case-sensitive
  const sol = (mint) => M.termsFingerprint(p([{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: mint, amount: "1", payTo: "AbC" }]));
  assert.notEqual(sol("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), sol("epjfwdd5aufqssqem2qn1xzybapc8g4wegGkZwyTDt1v"));
  assert.equal(M.termsFingerprint(p([])), null);
  assert.equal(M.termsFingerprint({}), null);
});

test("live match: pay as before, probed twice, one free check, receipt carries probe.multiprobe outcome match; no KV writes", async () => {
  B._resetBreakers();
  const db = d1(); const quota = fakeQuota(); const env = envFor(db, { QUOTA: quota });
  setScript("api.stable.dev", "pay"); sellerHits.length = 0;
  const r = await callAs(env, spot("https://api.stable.dev/v1/a"));
  assert.equal(r.status, 200); assert.equal(r.body.verdict, "pay"); assert.equal(r.body.reason_code, "price_ok");
  assert.equal(hitsOf("api.stable.dev"), 2, "first probe + one confirm probe");
  assert.equal(r.body.access.free_used_today, 1, "one free check, not two");
  assert.deepEqual(quota.ops.filter((o) => o === "take:spotcheck"), ["take:spotcheck"]);
  const rec = stored(db, r.body.receipt_id);
  assert.equal(rec.probe.multiprobe.outcome, "match"); assert.equal(rec.probe.multiprobe.probes, 2); assert.equal(rec.probe.multiprobe.count, 2);
  assert.equal(rec.probe.multiprobe.gap_ms, 250); assert.equal(rec.probe.multiprobe.budget_ms, 8000);
  assert.deepEqual(rec.probe.multiprobe.results.map((x) => x.http_status), [402, 402]);
  assert.equal(rec.approved_payment.amount_atomic, "1000");
  // reordered offers / case / nonce-only changes are the same terms
  for (const [h, second] of [["api.reorder.dev", "payReordered"], ["api.nonce.dev", "payNewNonce"]]) {
    setScript(h, h === "api.reorder.dev" ? "payTwoOffers" : "pay", second);
    const x = await callAs(env, spot("https://" + h + "/v1/a"));
    assert.equal(x.body.verdict, "pay", h); assert.equal(hitsOf(h), 2, h);
  }
});

test("live mismatch: amount, payTo, network, asset or scheme differing on the confirm probe is recheck/terms_unstable (free shape names it; receipt keeps the first terms + both results)", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db);
  const want = { pay2000: ["amount"], payOtherWallet: ["payTo"], payOtherNet: ["network"], payOtherAsset: ["asset"], payOtherScheme: ["scheme"], noTerms: ["accepts"] };
  for (const [i, second] of ["pay2000", "payOtherWallet", "payOtherNet", "payOtherAsset", "payOtherScheme", "noTerms"].entries()) {
    const h = "api.flip" + i + ".dev";
    setScript(h, "pay", second); sellerHits.length = 0;
    const r = await callAs(env, spot("https://" + h + "/v1/a"));
    assert.equal(r.status, 200, second); assert.equal(r.body.verdict, "recheck", second); assert.equal(r.body.reason_code, "terms_unstable", second);
    assert.equal(r.body.confidence, "low"); assert.equal(r.body.payment_terms_sha256, null, "nothing approved");
    assert.match(r.body.reason, /different payment terms/);
    assert.equal(hitsOf(h), 2, second);
    const rec = stored(db, r.body.receipt_id);
    assert.equal(rec.reason, "terms_unstable"); assert.equal(rec.approved_payment, null);
    assert.equal(rec.probe.multiprobe.outcome, "terms_unstable"); assert.equal(rec.probe_snapshot.terms_unstable, true);
    assert.deepEqual(rec.probe.multiprobe.diff_fields, want[second], second);
  }
});

test("confirm probe fails: 5xx -> recheck/server_error, timeout -> recheck/timeout, connection error -> recheck/unreachable; each counts as a breaker failure (3 open it)", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db, { PROBE_TIMEOUT_MS: "1000" });
  setScript("api.c5xx.dev", "pay", "s503");
  let r = await callAs(env, spot("https://api.c5xx.dev/v1/a"));
  assert.equal(r.body.verdict, "recheck"); assert.equal(r.body.reason_code, "server_error");
  assert.equal(stored(db, r.body.receipt_id).probe.multiprobe.outcome, "confirm_failed");
  setScript("api.ctimeout.dev", "pay", "hang");
  const t0 = Date.now();
  r = await callAs(env, spot("https://api.ctimeout.dev/v1/a"));
  assert.equal(r.body.reason_code, "timeout"); assert.ok(Date.now() - t0 < 1000 + 250 + 1500 + 700, "inside the documented worst case");
  setScript("api.creset.dev", "pay", "reset");
  r = await callAs(env, spot("https://api.creset.dev/v1/a"));
  assert.equal(r.body.reason_code, "unreachable");
  // a confirm 429 keeps its own 0.55.0 code
  setScript("api.c429.dev", "pay", "s429");
  assert.equal((await callAs(env, spot("https://api.c429.dev/v1/a"))).body.reason_code, "rate_limited");
  // breaker: the first probes succeed (ok), only the confirm probes fail. 3 failed confirms in the window open it.
  B._resetBreakers();
  setScript("api.cbrk.dev", "pay", "s503", "pay", "s503", "pay", "s503");
  for (let i = 0; i < 3; i++) assert.equal((await callAs(env, spot("https://api.cbrk.dev/v1/b" + i))).body.reason_code, "server_error", "check " + i);
  // ok probes clear the counter in 0.56.0 (a success closes), so the failures here alternate with successes: still closed
  assert.notEqual((await callAs(env, spot("https://api.cbrk.dev/v1/c"))).body.reason_code, "host_unstable");
  // direct: a failing confirm probe is recorded as a normal failure
  B._resetBreakers();
  const env2 = { BREAKER_CACHE: null };
  for (let i = 0; i < 3; i++) await B.breakerRecord(env2, "api.direct.dev", B.breakerOutcome({ reachable: true, http_status: 503 }), {}, Date.now());
  assert.equal((await B.breakerGate(env2, "api.direct.dev")).allow, false);
});

test("confirm failures feed the breaker: once the host only fails, the confirm probe's failure is one of the 3 that open it", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db);
  // check 1: first ok, confirm 503 (fail #1); check 2 and 3: first probe 503 (fail #2, #3) -> open
  setScript("api.cfeed.dev", "pay", "s503");
  assert.equal((await callAs(env, spot("https://api.cfeed.dev/v1/a"))).body.reason_code, "server_error");
  assert.equal((await callAs(env, spot("https://api.cfeed.dev/v1/b"))).body.reason_code, "server_error");
  assert.equal((await callAs(env, spot("https://api.cfeed.dev/v1/c"))).body.reason_code, "server_error");
  const before = hitsOf("api.cfeed.dev");
  assert.equal(before, 4, "2 probes for the first check, 1 each after (5xx first probes are never confirmed)");
  assert.equal((await callAs(env, spot("https://api.cfeed.dev/v1/d"))).body.reason_code, "host_unstable");
  assert.equal(hitsOf("api.cfeed.dev"), before, "breaker open: not fetched");
});

test("MULTIPROBE_COUNT=1 turns it off: one probe, pay on the first answer even when the next one would differ (0.56.0 behaviour)", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db, { MULTIPROBE_COUNT: "1" });
  setScript("api.off.dev", "pay", "pay2000");
  const r = await callAs(env, spot("https://api.off.dev/v1/a"));
  assert.equal(r.body.verdict, "pay"); assert.equal(hitsOf("api.off.dev"), 1);
  assert.equal(stored(db, r.body.receipt_id).probe.multiprobe, undefined);
});

test("only live, uncached pay-bound probes re-probe: a skip, a recheck and a 5-minute cache hit cost no extra request; the cache repeats terms_unstable", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db, { SPOT_PROBE_CACHE_S: "300" });
  setScript("api.skipfirst.dev", "pay2000"); // listed/claimed $0.001, asks $0.002 -> skip/price_mismatch: no confirm
  let r = await callAs(env, spot("https://api.skipfirst.dev/v1/a", "&claimed_price=0.001"));
  assert.equal(r.body.reason_code, "price_mismatch"); assert.equal(hitsOf("api.skipfirst.dev"), 1);
  setScript("api.nopay.dev", "noTerms");
  r = await callAs(env, spot("https://api.nopay.dev/v1/a"));
  assert.equal(r.body.reason_code, "no_paywall"); assert.equal(hitsOf("api.nopay.dev"), 1);
  setScript("api.first5xx.dev", "s503");
  r = await callAs(env, spot("https://api.first5xx.dev/v1/a"));
  assert.equal(r.body.reason_code, "server_error"); assert.equal(hitsOf("api.first5xx.dev"), 1);
  // cache: the confirmed pay is reused, no new probes
  setScript("api.cached.dev", "pay");
  assert.equal((await callAs(env, spot("https://api.cached.dev/v1/a"))).body.verdict, "pay");
  assert.equal(hitsOf("api.cached.dev"), 2);
  assert.equal((await callAs(env, spot("https://api.cached.dev/v1/a"))).body.verdict, "pay");
  assert.equal(hitsOf("api.cached.dev"), 2, "cache hit: not re-probed");
  // cache: a terms_unstable answer is repeated from the cache (same verdict, no new probes)
  setScript("api.cachedflip.dev", "pay", "pay2000");
  assert.equal((await callAs(env, spot("https://api.cachedflip.dev/v1/a"))).body.reason_code, "terms_unstable");
  assert.equal((await callAs(env, spot("https://api.cachedflip.dev/v1/a"))).body.reason_code, "terms_unstable");
  assert.equal(hitsOf("api.cachedflip.dev"), 2);
  // dry runs share getProbe: confirmed too
  setScript("api.dry.dev", "pay", "pay2000");
  const dr = await callAs(envFor(d1()), spot("https://api.dry.dev/v1/a", "&mode=dry-run"));
  assert.equal(dr.body.mode, "dry-run"); assert.equal(dr.body.reason_code, "terms_unstable"); assert.equal(hitsOf("api.dry.dev"), 2);
});

test("timeout budget: the confirm probe gets what is left of PROBE_TIMEOUT_MS after the gap, at least 1500 ms; a slow-but-working first probe still pays", async () => {
  // unit: fake clock
  let now = 0; const budgets = [];
  const first = { reachable: true, http_status: 402, x402_challenge: true, known_answer: true, accepts: [offer()] };
  const run = async (elapsedFirst, cfg) => {
    now = elapsedFirst; budgets.length = 0;
    return M.confirmBeforePay({ first, cfg, timeoutMs: 8000, startedAt: 0, now: () => now, sleep: async (ms) => { now += ms; }, decide: (p) => decideVerdict(p, null),
      probeFn: async ({ timeoutMs }) => { budgets.push(timeoutMs); now += 100; return { ...first }; } });
  };
  let out = await run(300, M.multiprobeCfg({}));
  assert.deepEqual(budgets, [8000 - 300 - 250]); assert.equal(out.multiprobe.outcome, "match"); assert.equal(out.multiprobe.elapsed_ms, 650);
  out = await run(7900, M.multiprobeCfg({}));
  assert.deepEqual(budgets, [1500], "floor: a slow first probe still gets 1500 ms");
  out = await run(300, M.multiprobeCfg({ MULTIPROBE_GAP_MS: "0" }));
  assert.deepEqual(budgets, [7700]);
  // live: PROBE_TIMEOUT_MS=1000, the first probe takes 600 ms -> the confirm probe gets the 1500 ms floor and answers
  B._resetBreakers();
  const db = d1(); const env = envFor(db, { PROBE_TIMEOUT_MS: "1000" });
  setScript("api.slowpay.dev", "slowPay");
  const t0 = Date.now();
  const r = await callAs(env, spot("https://api.slowpay.dev/v1/a"));
  const took = Date.now() - t0;
  assert.equal(r.body.verdict, "pay"); assert.equal(hitsOf("api.slowpay.dev"), 2);
  assert.ok(took >= 600 + 250 + 600 - 50, "two slow probes + gap: " + took);
  assert.ok(took < M.multiprobeWorstCaseMs(1000, M.multiprobeCfg({})) + 700, "within the documented worst case: " + took);
  const mp = stored(db, r.body.receipt_id).probe.multiprobe;
  assert.equal(mp.budget_ms, 1000); assert.ok(mp.elapsed_ms > 1000, "the documented small extension past PROBE_TIMEOUT_MS");
  // a confirm probe that hangs is cut at its own budget (floor 1500 ms), never later
  setScript("api.slowhang.dev", "slowPay", "hang");
  const t1 = Date.now();
  const h = await callAs(env, spot("https://api.slowhang.dev/v1/a"));
  assert.equal(h.body.reason_code, "timeout");
  const tookH = Date.now() - t1;
  assert.ok(tookH >= 600 + 250 + 1500 - 50 && tookH < 600 + 250 + 1500 + 700, "floor-bounded: " + tookH);
});

test("SSRF on the confirm probe: it re-resolves the host (a rebind to loopback is skip/ssrf_blocked, not fetched) and re-validates every redirect hop (metadata IP and private names never fetched)", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db);
  // the route's own gate + the first probe see a public address; the confirm probe's lookup gets 127.0.0.1
  rebindAfter.set("api.rebind.dev", 2);
  setScript("api.rebind.dev", "pay");
  doh.length = 0;
  let r = await callAs(env, spot("https://api.rebind.dev/v1/a"));
  assert.equal(r.body.verdict, "skip"); assert.equal(r.body.reason_code, "ssrf_blocked");
  assert.equal(hitsOf("api.rebind.dev"), 1, "the confirm probe never fetched the rebound address");
  assert.equal(doh.filter((x) => x.name === "api.rebind.dev" && x.type === "A").length, 3, "route gate + first probe + confirm probe each resolved");
  otherHits.length = 0;
  setScript("api.redirmeta.dev", "pay", "toMetadata");
  r = await callAs(env, spot("https://api.redirmeta.dev/v1/a"));
  assert.equal(r.body.reason_code, "ssrf_blocked"); assert.equal(hitsOf("api.redirmeta.dev"), 2);
  setScript("api.redirpriv.dev", "pay", "toPrivateName");
  r = await callAs(env, spot("https://api.redirpriv.dev/v1/a"));
  assert.equal(r.body.reason_code, "ssrf_blocked");
  assert.deepEqual(otherHits, [], "no blocked hop was fetched");
  assert.equal(sellerHits.some((h) => h.startsWith("internal.privmp.dev")), false);
});

test("concurrency cap and tie-break: a confirm probe refused by our cap is a recheck (never pay); MULTIPROBE_COUNT=3 pays only when the 2nd and 3rd agree (on the newer terms)", async () => {
  const first = { reachable: true, http_status: 402, x402_challenge: true, known_answer: true, accepts: [offer()] };
  const capped = { reachable: false, http_status: null, latency_ms: null, ssrf_blocked: false, error: "too many concurrent probes; retry shortly", x402_challenge: false, accepts: [], quoted_price_usd: null, known_answer: null, body_truncated: false };
  const out = await M.confirmBeforePay({ first, cfg: M.multiprobeCfg({}), timeoutMs: 8000, startedAt: Date.now(), sleep: async () => {}, decide: (p) => decideVerdict(p, null), probeFn: async () => capped });
  assert.equal(decideVerdict(out).verdict, "recheck"); assert.equal(out.multiprobe.outcome, "confirm_failed");
  const thrown = await M.confirmBeforePay({ first, cfg: M.multiprobeCfg({}), timeoutMs: 8000, startedAt: Date.now(), sleep: async () => {}, decide: (p) => decideVerdict(p, null), probeFn: async () => { throw new Error("boom"); } });
  assert.deepEqual(decideVerdict(thrown), { verdict: "recheck", reason: "unreachable" });
  B._resetBreakers();
  const db = d1(); const env = envFor(db, { MULTIPROBE_COUNT: "3", MULTIPROBE_GAP_MS: "0" });
  setScript("api.tieok.dev", "pay", "pay2000", "pay2000"); // changed once, now stable -> decided on 2000
  let r = await callAs(env, spot("https://api.tieok.dev/v1/a"));
  assert.equal(r.body.verdict, "pay"); assert.equal(hitsOf("api.tieok.dev"), 3);
  let rec = stored(db, r.body.receipt_id);
  assert.equal(rec.probe.multiprobe.outcome, "match_after_change"); assert.equal(rec.approved_payment.amount_atomic, "2000");
  setScript("api.tieflap.dev", "pay", "pay2000", "pay"); // A, B, A -> unstable
  r = await callAs(env, spot("https://api.tieflap.dev/v1/a"));
  assert.equal(r.body.reason_code, "terms_unstable"); assert.equal(hitsOf("api.tieflap.dev"), 3);
  setScript("api.tienone.dev", "pay"); // match on the 2nd: the 3rd never runs
  r = await callAs(env, spot("https://api.tienone.dev/v1/a"));
  assert.equal(r.body.verdict, "pay"); assert.equal(hitsOf("api.tienone.dev"), 2);
  // the newer terms are judged in full: A then B, B where B is above the claimed price -> skip
  setScript("api.tieskip.dev", "pay", "pay2000", "pay2000");
  r = await callAs(env, spot("https://api.tieskip.dev/v1/a", "&claimed_price=0.001"));
  assert.equal(r.body.reason_code, "price_mismatch");
});

test("price and free tier unchanged ($0.02 = 20000 atomic, 5 free a day; the over-quota 402 is the same); reason code documented; no new migration; past receipts untouched", async () => {
  assert.equal(String(SPOT_PAID_ATOMIC), "20000"); assert.equal(SPOT_DEFAULT_FREE_PER_DAY, 5);
  B._resetBreakers();
  const db = d1(); const quota = fakeQuota(); const env = envFor(db, { QUOTA: quota });
  setScript("api.quota.dev", "pay");
  const ip = "198.18.41.1";
  for (let i = 0; i < 5; i++) assert.equal((await callAs(env, spot("https://api.quota.dev/v1/q" + i), ip)).body.access.free_used_today, i + 1);
  const hitsBefore = hitsOf("api.quota.dev");
  const over = await callAs(env, spot("https://api.quota.dev/v1/q9"), ip);
  assert.equal(over.status, 402);
  assert.equal(hitsOf("api.quota.dev") - hitsBefore, 1, "0.57.0 review: an unpaid over-quota request makes only one outbound probe");
  assert.equal(over.body.accepts[0].amount, "20000");
  // an old receipt (0.56.0, single probe) is served unchanged
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, norm_key, probed_at, body) VALUES ('sc-00000000000000bb', 'https://api.old.dev/v1/x', '2026-10-01T00:00:00Z', 'pay', 'price_ok', 'live', NULL, 'k:x', '2026-10-01T00:00:00Z', ?)")
    .run(JSON.stringify({ id: "sc-00000000000000bb", verdict: "pay", reason: "price_ok", worker_version: "0.56.0", probe: { probed_at: "2026-10-01T00:00:00Z", cached: false, cache_ttl_s: 300 } }));
  const old = (await callAs(env, "/v1/receipts/sc-00000000000000bb")).body;
  const ob = old.receipt || old;
  assert.equal(ob.verdict, "pay"); assert.equal(ob.worker_version, "0.56.0"); assert.equal(ob.probe.multiprobe, undefined);
  const rc = REASON_CODES.find((x) => x.code === "terms_unstable");
  assert.equal(rc.verdict, "recheck"); assert.equal(rc.confidence, "low"); assert.ok(REASON_TEXT.terms_unstable);
  assert.match(RULES_VERSION, /^2026-/);
  assert.equal(MIG_FILES[MIG_FILES.length - 1], "0021_breaker_events.sql", "0.57.0 adds no migration");
});

test("review 1: amounts use the existing 1% tolerance (priceMatchesClaimed / PRICE_TOLERANCE): +0.9% and -0.9% match, +1.1% is terms_unstable (diff_fields amount)", async () => {
  const SC = await import("../worker/src/spotcheck.js");
  assert.equal(SC.PRICE_TOLERANCE, 0.01);
  assert.equal(M.amountsMatch("1000", "1009"), true); assert.equal(M.amountsMatch("1000", "991"), true);
  assert.equal(M.amountsMatch("1000", "1011"), false); assert.equal(M.amountsMatch("1000", "989"), false);
  assert.ok(!/PRICE_TOLERANCE\s*=|0\.01/.test(readFileSync(join(ROOT, "worker", "src", "multiprobe.js"), "utf8")), "no new tolerance constant in multiprobe.js");
  B._resetBreakers();
  const db = d1(); const env = envFor(db);
  for (const [h, second, verdict] of [["api.tol1.dev", "pay1009", "pay"], ["api.tol2.dev", "pay991", "pay"], ["api.tol3.dev", "pay1011", "recheck"]]) {
    setScript(h, "pay", second);
    const r = await callAs(env, spot("https://" + h + "/v1/a"));
    assert.equal(r.body.verdict, verdict, second); assert.equal(hitsOf(h), 2);
    const rec = stored(db, r.body.receipt_id);
    if (verdict === "pay") { assert.equal(rec.probe.multiprobe.outcome, "match"); assert.equal(rec.approved_payment.amount_atomic, "1000", "the first probe's terms are approved"); }
    else { assert.equal(r.body.reason_code, "terms_unstable"); assert.deepEqual(rec.probe.multiprobe.diff_fields, ["amount"]); }
  }
});

test("review 2: diff_fields holds field names only (never values or addresses) and is countable with one D1 query (payTo-only cases)", async () => {
  const c = M.compareTerms({ accepts: [offer()] }, { accepts: [offer({ payTo: OTHER_PAY_TO, amount: "5000" })] });
  assert.deepEqual(c, { match: false, diff_fields: ["amount", "payTo"] });
  assert.deepEqual(M.compareTerms({ accepts: [offer()] }, { accepts: [offer(), offer({ network: "eip155:84532" })] }).diff_fields, ["accepts"]);
  assert.deepEqual(M.compareTerms({ accepts: [offer()] }, { accepts: [offer({ payTo: PAY_TO.toUpperCase().replace("0X", "0x") })] }), { match: true, diff_fields: [] });
  B._resetBreakers();
  const db = d1(); const env = envFor(db);
  const ids = [];
  for (const [h, second] of [["api.dpt1.dev", "payOtherWallet"], ["api.dpt2.dev", "payOtherWallet"], ["api.dam.dev", "pay2000"], ["api.dnone.dev", "noTerms"]]) {
    setScript(h, "pay", second);
    const r = await callAs(env, spot("https://" + h + "/v1/a"));
    assert.equal(r.body.reason_code, "terms_unstable"); ids.push(r.body.receipt_id);
    const mp = JSON.stringify(stored(db, r.body.receipt_id).probe.multiprobe);
    assert.ok(!/0x[0-9a-f]{40}|cccc|bbbb|"amount":/i.test(mp), "no values in multiprobe: " + mp);
  }
  setScript("api.dok.dev", "pay"); await callAs(env, spot("https://api.dok.dev/v1/a"));
  // the query documented in the PR body (D1 = SQLite JSON1); probed_at is an ISO-8601 UTC string
  const Q = "SELECT COUNT(*) AS n FROM spot_receipts WHERE reason = 'terms_unstable' AND probed_at >= ?1 AND json_extract(body, '$.probe.multiprobe.diff_fields') = '[\"payTo\"]'";
  assert.equal(db.raw.prepare(Q).get("2026-01-01T00:00:00Z").n, 2);
  const QB = "SELECT json_extract(body, '$.probe.multiprobe.diff_fields') AS diff_fields, COUNT(*) AS n FROM spot_receipts WHERE reason = 'terms_unstable' AND probed_at >= ?1 GROUP BY diff_fields ORDER BY n DESC";
  assert.deepEqual(Object.fromEntries(db.raw.prepare(QB).all("2026-01-01T00:00:00Z").map((r) => [r.diff_fields, r.n])), { '["payTo"]': 2, '["accepts"]': 1, '["amount"]': 1 });
});

test("review 4: cron self-checks (bazaar-daily, stale-recheck, daily-recheck) skip the confirm; the same exempt client without a cron ref still confirms", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db, { SELF_CLIENTS: "cron-selftest" });
  for (const ref of ["bazaar-daily", "stale-recheck", "daily-recheck"]) {
    const h = "api.cron-" + ref + ".dev";
    setScript(h, "pay", "pay2000");
    const r = await callAs(env, spot("https://" + h + "/v1/a", "&client=cron-selftest&ref=" + ref));
    assert.equal(r.body.verdict, "pay", ref); assert.equal(hitsOf(h), 1, ref + ": no confirm probe");
  }
  setScript("api.cron-none.dev", "pay", "pay2000");
  const r = await callAs(env, spot("https://api.cron-none.dev/v1/a", "&client=cron-selftest"));
  assert.equal(r.body.reason_code, "terms_unstable"); assert.equal(hitsOf("api.cron-none.dev"), 2);
});

test("Solana (solana:*) 402s are confirmed too: same terms pay, a case-changed base58 payTo is terms_unstable (payTo)", async () => {
  B._resetBreakers();
  const db = d1(); const env = envFor(db);
  setScript("api.solok.dev", "solPay");
  let r = await callAs(env, spot("https://api.solok.dev/v1/a"));
  assert.equal(r.body.verdict, "pay"); assert.equal(hitsOf("api.solok.dev"), 2);
  setScript("api.solcase.dev", "solPay", "solPayLowerPayTo");
  r = await callAs(env, spot("https://api.solcase.dev/v1/a"));
  assert.equal(r.body.reason_code, "terms_unstable"); assert.deepEqual(stored(db, r.body.receipt_id).probe.multiprobe.diff_fields, ["payTo"]);
});
