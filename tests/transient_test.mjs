// 0.55.0 skip-reason tuning (worker/src/transient.js + spotcheck.js): 429 / WAF-challenge 403 / DNS error -> recheck with
// clear codes, exactly one DNS retry, a plain 403 unchanged, and the ~24 h fallback to skip read from existing D1
// spot_receipts rows. Real SQLite (node:sqlite) with every migration behind a tiny D1 adapter; DNS and sellers are stubbed.
// Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { probeKeyHash } from "../worker/src/lib.js";
import { decideVerdict } from "../worker/src/spotcheck.js";
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
const H = 3600000;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x" + "bb".repeat(20);

// hosts: behaviour of the stubbed seller
const SELLERS = {
  "api.ratefix.dev": () => new Response("slow down", { status: 429, headers: { "retry-after": "60" } }),
  "api.waffix.dev": () => new Response("", { status: 403, headers: { "cf-mitigated": "challenge", server: "cloudflare" } }),
  "api.cfpage.dev": () => new Response("<html><head><title>Just a moment...</title></head><body><script src=\"/cdn-cgi/challenge-platform/h/b\"></script></body></html>", { status: 403, headers: { server: "cloudflare", "content-type": "text/html" } }),
  "api.plain403.dev": () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { server: "cloudflare", "content-type": "application/json" } }),
  "api.flakydns.dev": () => pay402(),
  "api.okfix.dev": () => pay402(),
};
function pay402() {
  const body = { x402Version: 2, error: "Payment required", accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300 }] };
  return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "payment-required": btoa(JSON.stringify(body)) } });
}
// review follow-up: hostnames that resolve to private / loopback / link-local / CGNAT / ULA / mapped addresses
const PRIV_DNS = {
  "api.loopfix.dev": { A: ["127.0.0.1"] }, "api.priv10fix.dev": { A: ["10.0.0.5"] }, "api.priv192fix.dev": { A: ["192.168.1.20"] },
  "api.priv172fix.dev": { A: ["172.16.4.4"] }, "api.metafix.dev": { A: ["169.254.169.254"] }, "api.cgnatfix.dev": { A: ["100.64.0.9"] },
  "api.mixfix.dev": { A: ["93.184.216.34", "10.1.2.3"] }, // one public + one private answer: still blocked
  "api.v6loopfix.dev": { AAAA: ["::1"] }, "api.v6llfix.dev": { AAAA: ["fe80::1"] }, "api.v6ulafix.dev": { AAAA: ["fd12:3456::1"] },
  "api.v6mapfix.dev": { AAAA: ["::ffff:127.0.0.1"] }, "api.v6mapllfix.dev": { AAAA: ["::ffff:169.254.169.254"] },
};
// a public seller that redirects to an unsafe target (?to=...)
SELLERS["api.redirfix.dev"] = (u) => new Response("", { status: 302, headers: { location: u.searchParams.get("to") } });
const otherHits = []; // any non-DoH, non-seller fetch (e.g. a facilitator): must stay empty for the no-charge path
const doh = []; // every DoH lookup: {name, type, retry}
const sellerHits = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === "cloudflare-dns.com") {
    const name = u.searchParams.get("name"), type = u.searchParams.get("type"), retry = u.searchParams.get("do") === "false";
    doh.push({ name, type, retry });
    if (name === "api.nodns.dev") return Response.json({ Status: 3, Answer: [] });
    if (name === "api.flakydns.dev" && !retry) return new Response("resolver busy", { status: 502 });
    if (name === "api.privfix.dev") return Response.json(type === "A" ? { Answer: [{ type: 1, data: "10.0.0.5" }] } : { Answer: [] });
    if (PRIV_DNS[name]) { const a = PRIV_DNS[name][type] || []; return Response.json({ Answer: a.map((data) => ({ type: type === "A" ? 1 : 28, data })) }); }
    return Response.json(type === "A" ? { Answer: [{ type: 1, data: "93.184.216.34" }] } : { Answer: [] });
  }
  if (SELLERS[u.hostname]) { sellerHits.push(u.hostname); return SELLERS[u.hostname](u); }
  otherHits.push(u.hostname);
  return new Response("not stubbed: " + u, { status: 599 });
};
const noKv = { get: async () => null, put: async () => { throw new Error("0.55.0 must not write KV"); }, delete: async () => { throw new Error("no KV deletes"); } };
const envFor = (db, extra = {}) => ({ RECEIPTS_DB: db, CLIENT_SALT: "salt", SPOT_PROBE_CACHE_S: "0", CRAWL_KV: noKv, SPOT_KV: noKv, ...extra });
let ipN = 1;
async function call(env, path) {
  const r = await worker.fetch(new Request("https://api.402xagent.com" + path, { headers: { accept: "application/json", "cf-connecting-ip": `198.51.${ipN++}.9` } }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const check = (env, url, extra = "") => call(env, "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(url) + extra);
async function seed(db, url, ageH, verdict, reason, extra = {}) {
  const id = "sc-" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const at = iso(Date.now() - ageH * H);
  const body = JSON.stringify({ id, url, verdict, reason, checked_at: at, probe: { probed_at: at }, ...extra });
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, norm_key, probed_at, body) VALUES (?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?)")
    .run(id, url, at, verdict, reason, await probeKeyHash(url, "GET"), at, body);
  return { id, body };
}

test("wafSignature: conservative (403 only; header or vendor page); same answers as crawl_probe.py waf_signature", () => {
  const cases = [
    [403, { "cf-mitigated": "challenge" }, "", "cloudflare"],
    [403, { "x-amzn-waf-action": "captcha" }, "", "aws"],
    [403, { server: "cloudflare" }, "<title>Just a moment...</title>", "cloudflare"],
    [403, { server: "cloudflare" }, "<div>Attention Required! | Cloudflare</div>", "cloudflare"],
    [403, { server: "cloudflare" }, "Sorry, you have been blocked. Cloudflare Ray ID: 8f00", "cloudflare"],
    [403, { server: "AkamaiGHost" }, "<H1>Access Denied</H1> Reference #18.2f3e4d5c.1730000000.abc", "akamai"],
    [403, { server: "cloudflare" }, JSON.stringify({ error: "forbidden" }), null], // origin 403 behind Cloudflare: plain
    [403, { server: "nginx" }, "<title>Just a moment...</title>", null], // challenge-looking text, not served by Cloudflare
    [403, { server: "AkamaiGHost" }, "Forbidden", null],
    [403, {}, "Access denied", null],
    [401, { "cf-mitigated": "challenge" }, "", null], // only a 403 qualifies
    [429, { server: "cloudflare" }, "<title>Just a moment...</title>", null],
  ];
  for (const [st, hd, body, vendor] of cases) assert.equal((T.wafSignature(st, new Headers(hd), body) || {}).vendor ?? null, vendor, JSON.stringify([st, hd, body]));
  const py = spawnSync("python3", ["-c", "import sys,json;sys.path.insert(0,sys.argv[1]);from crawl_probe import waf_signature;print(json.dumps([(waf_signature(s,h,b) or {}).get('vendor') for s,h,b in json.loads(sys.stdin.read())]))", join(ROOT, "scripts", "weekly-crawl")], { input: JSON.stringify(cases.map(([s, h, b]) => [s, h, b])), encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), cases.map((c) => c[3]), "crawl and live checks classify the same");
});

test("decideVerdict: 429 -> recheck/rate_limited, WAF 403 -> recheck/waf_challenge, DNS -> recheck/dns_error; plain 403 and other codes unchanged", () => {
  const p = (o) => ({ reachable: true, ssrf_blocked: false, x402_challenge: false, accepts: [], ...o });
  assert.deepEqual(decideVerdict(p({ http_status: 429 })), { verdict: "recheck", reason: "rate_limited" });
  assert.deepEqual(decideVerdict(p({ http_status: 403, waf: { vendor: "cloudflare", signal: "cf-mitigated" } })), { verdict: "recheck", reason: "waf_challenge" });
  assert.deepEqual(decideVerdict(p({ http_status: 403, waf: null })), { verdict: "skip", reason: "no_paywall" });
  assert.deepEqual(decideVerdict(p({ http_status: 404 })), { verdict: "skip", reason: "no_paywall" });
  assert.deepEqual(decideVerdict(p({ http_status: 503 })), { verdict: "recheck", reason: "server_error" });
  assert.deepEqual(decideVerdict(p({ http_status: 429, free_trial: { active: true } })), { verdict: "recheck", reason: "free_trial_active" });
  assert.deepEqual(decideVerdict({ reachable: false, dns_error: true }), { verdict: "recheck", reason: "dns_error" });
  assert.deepEqual(decideVerdict({ reachable: false, error: "fetch failed" }), { verdict: "recheck", reason: "unreachable" });
  assert.deepEqual(decideVerdict({ reachable: false, ssrf_blocked: true }), { verdict: "skip", reason: "ssrf_blocked" });
  for (const c of ["rate_limited", "waf_challenge", "dns_error"]) {
    assert.equal(REASON_CODES.find((r) => r.code === c).verdict, "recheck"); assert.ok(REASON_TEXT[c]);
    const pc = T.PERSISTENT_OF[c]; assert.equal(REASON_CODES.find((r) => r.code === pc).verdict, "skip"); assert.ok(REASON_TEXT[pc]);
  }
  assert.equal(T.transientSkipAfterHours({}), 24); assert.equal(T.transientSkipAfterHours({ TRANSIENT_SKIP_AFTER_HOURS: "48" }), 48);
  for (const bad of ["0", "-1", "abc", "1e9", ""]) assert.equal(T.transientSkipAfterHours({ TRANSIENT_SKIP_AFTER_HOURS: bad }), 24, bad);
});

test("live check: 429 and WAF 403 are recheck with clear codes; a plain 403 is still skip/no_paywall", async () => {
  const db = d1(); const env = envFor(db);
  let r = (await check(env, "https://api.ratefix.dev/v1/x")).body;
  assert.equal(r.verdict, "recheck"); assert.equal(r.reason_code, "rate_limited"); assert.match(r.reason, /HTTP 429/);
  assert.deepEqual(r.transient, { code: "rate_limited", since: null, hours: 0, skip_after_hours: 24, fell_back: false });
  for (const host of ["api.waffix.dev", "api.cfpage.dev"]) {
    r = (await check(env, `https://${host}/v1/x`)).body;
    assert.equal(r.verdict, "recheck", host); assert.equal(r.reason_code, "waf_challenge", host);
  }
  r = (await check(env, "https://api.plain403.dev/v1/x")).body;
  assert.equal(r.verdict, "skip"); assert.equal(r.reason_code, "no_paywall"); assert.equal(r.transient, undefined);
  r = (await check(env, "https://api.okfix.dev/v1/x")).body;
  assert.equal(r.verdict, "pay"); assert.equal(r.transient, undefined);
  const rows = db.raw.prepare("SELECT reason, verdict FROM spot_receipts ORDER BY created_at").all().map((x) => x.verdict + "/" + x.reason);
  assert.deepEqual(rows.sort(), ["pay/price_ok", "recheck/rate_limited", "recheck/waf_challenge", "recheck/waf_challenge", "skip/no_paywall"].sort());
});

test("live check DNS: exactly one retry, then recheck/dns_error (HTTP 200, never fetched); a retry that resolves probes normally", async () => {
  const db = d1(); const env = envFor(db);
  doh.length = 0; sellerHits.length = 0;
  const r = await check(env, "https://api.nodns.dev/v1/x");
  assert.equal(r.status, 200, "was a 400 ssrf_blocked before 0.55.0");
  assert.equal(r.body.verdict, "recheck"); assert.equal(r.body.reason_code, "dns_error"); assert.match(r.body.reason, /did not resolve/);
  const lookups = doh.filter((x) => x.name === "api.nodns.dev");
  assert.deepEqual(lookups.map((x) => x.retry), [false, false, true, true], "first lookup (A+AAAA) and exactly one retry (A+AAAA)");
  assert.deepEqual(sellerHits, [], "the URL is never fetched");
  doh.length = 0;
  const ok = (await check(env, "https://api.flakydns.dev/v1/x")).body;
  assert.equal(ok.verdict, "pay");
  assert.deepEqual(doh.filter((x) => x.name === "api.flakydns.dev").map((x) => x.retry), [false, false, true, true]);
  assert.deepEqual(sellerHits, ["api.flakydns.dev"]);
  // private / blocked hosts are unchanged: immediate 400, no retry
  doh.length = 0;
  const blocked = await check(env, "https://api.privfix.dev/v1/x");
  assert.equal(blocked.status, 400); assert.equal(blocked.body.reason_code, "ssrf_blocked");
  assert.deepEqual(doh.map((x) => x.retry), [false, false], "no DNS retry for a private answer");
});

test("24 h guard: a streak of transient rechecks >= TRANSIENT_SKIP_AFTER_HOURS falls back to skip/*_persistent; shorter, broken or first-time streaks stay recheck; past rows untouched", async () => {
  const URL_ = "https://api.ratefix.dev/v1/guard";
  // 1) 25 h of rate_limited -> skip/rate_limited_persistent
  let db = d1(); let env = envFor(db);
  const old = await seed(db, URL_, 25, "recheck", "rate_limited");
  await seed(db, URL_, 3, "recheck", "waf_challenge"); // mixed transient codes keep the streak
  let r = (await check(env, URL_)).body;
  assert.equal(r.verdict, "skip"); assert.equal(r.reason_code, "rate_limited_persistent"); assert.equal(r.confidence, "medium");
  assert.equal(r.transient.fell_back, true); assert.equal(r.transient.code, "rate_limited"); assert.ok(r.transient.hours >= 25 && r.transient.hours < 25.2, String(r.transient.hours));
  assert.equal(r.transient.since, JSON.parse(old.body).probe.probed_at);
  assert.equal(db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(old.id).body, old.body, "past receipt unchanged");
  // the fallback row itself keeps the streak: the next check is still the persistent skip
  r = (await check(env, URL_)).body;
  assert.equal(r.reason_code, "rate_limited_persistent");
  // 2) only 23 h -> still recheck
  db = d1(); env = envFor(db);
  await seed(db, URL_, 23, "recheck", "rate_limited");
  r = (await check(env, URL_)).body;
  assert.equal(r.verdict, "recheck"); assert.equal(r.transient.fell_back, false); assert.ok(r.transient.hours >= 23 && r.transient.hours < 23.2);
  // 3) broken by any other answer (a pay 2 h ago) -> streak restarts after it
  db = d1(); env = envFor(db);
  await seed(db, URL_, 30, "recheck", "rate_limited");
  await seed(db, URL_, 2, "pay", "price_ok");
  r = (await check(env, URL_)).body;
  assert.equal(r.verdict, "recheck"); assert.equal(r.transient.since, null);
  // 4) pre-0.55.0 rows (a 429 stored as skip/no_paywall) are not re-read as part of a streak
  db = d1(); env = envFor(db);
  await seed(db, URL_, 72, "skip", "no_paywall");
  r = (await check(env, URL_)).body;
  assert.equal(r.verdict, "recheck"); assert.equal(r.transient.since, null);
  // 5) configurable: 25 h with TRANSIENT_SKIP_AFTER_HOURS=48 stays recheck
  db = d1(); env = envFor(db, { TRANSIENT_SKIP_AFTER_HOURS: "48" });
  await seed(db, URL_, 25, "recheck", "rate_limited");
  r = (await check(env, URL_)).body;
  assert.equal(r.verdict, "recheck"); assert.equal(r.transient.skip_after_hours, 48);
  // 6) DNS and WAF fall back with their own codes; dry runs use the same guard
  db = d1(); env = envFor(db);
  await seed(db, "https://api.nodns.dev/v1/x", 26, "recheck", "dns_error");
  await seed(db, "https://api.waffix.dev/v1/x", 26, "recheck", "waf_challenge");
  assert.equal((await check(env, "https://api.nodns.dev/v1/x")).body.reason_code, "dns_error_persistent");
  assert.equal((await check(env, "https://api.waffix.dev/v1/x")).body.reason_code, "waf_blocked_persistent");
  const dry = (await check(env, "https://api.waffix.dev/v1/x", "&mode=dry-run")).body;
  assert.equal(dry.mode, "dry-run"); assert.equal(dry.verdict, "skip"); assert.equal(dry.reason_code, "waf_blocked_persistent");
  // 7) no D1 store: fail open (stays recheck)
  const noDb = (await check(envFor(undefined), "https://api.ratefix.dev/v1/x")).body;
  assert.equal(noDb.verdict, "recheck"); assert.equal(noDb.reason_code, "rate_limited");
});

test("guard SQL uses the existing (norm_key, probed_at) index; no migration needed", () => {
  const db = d1();
  const plan = db.raw.prepare("EXPLAIN QUERY PLAN " + T.STREAK_SQL).all("k:x").map((x) => x.detail).join(" | ");
  assert.match(plan, /spot_receipts_probe_cache/, plan);
  assert.equal(MIGS.length, readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).length);
  assert.ok(!readdirSync(MIG_DIR).some((f) => /^002[1-9]/.test(f)), "0.55.0 adds no migration");
});

async function callAs(env, path, ip, headers = {}) {
  const r = await worker.fetch(new Request("https://api.402xagent.com" + path, { headers: { accept: "application/json", "user-agent": "agent-x/1.0", "cf-connecting-ip": ip, ...headers } }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

// in-memory stand-in for the QUOTA Durable Object (take / peek per key + counter + period); logs every operation
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

test("review 1: a live DNS failure is HTTP 200 recheck/dns_error, uses NO free check and is never charged (even with a payment header or after the fallback)", async () => {
  const db = d1(); const quota = fakeQuota(); const env = envFor(db, { QUOTA: quota });
  const ip = "198.18.7.7";
  const path = "/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://api.nodns.dev/v1/q");
  otherHits.length = 0; sellerHits.length = 0;
  for (let i = 0; i < 7; i++) { // more than the 5 free per day
    const r = await callAs(env, path, ip);
    assert.equal(r.status, 200, "call " + i); assert.equal(r.body.verdict, "recheck"); assert.equal(r.body.reason_code, "dns_error");
    assert.equal(r.body.access.tier, "free"); assert.equal(r.body.access.free_check_used, false); assert.equal(r.body.access.charged, false);
    assert.equal(r.body.access.free_used_today, undefined, "no quota counter was read or taken");
    assert.ok(r.body.receipt_id, "still stored: the guard reads it");
  }
  assert.deepEqual(quota.ops, [], "no quota counter touched by DNS failures");
  // the same client still has all 5 free checks
  const ok = await callAs(env, "/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://api.okfix.dev/v1/q"), ip);
  assert.equal(ok.status, 200); assert.equal(ok.body.verdict, "pay"); assert.equal(ok.body.access.free_used_today, 1); assert.equal(ok.body.access.free_remaining_today, 4);
  // a payment header is never verified or settled for a DNS failure
  const paid = await callAs(env, path, "198.18.7.8", { "payment-signature": btoa(JSON.stringify({ x402Version: 2, payload: { authorization: { from: "0x" + "dd".repeat(20) } } })) });
  assert.equal(paid.status, 200); assert.equal(paid.body.reason_code, "dns_error"); assert.equal(paid.body.access.charged, false);
  assert.equal(paid.headers.get("payment-response"), null); assert.equal(paid.headers.get("x-payment-response"), null);
  assert.equal(paid.body.access.tx, undefined);
  // after the 24 h window the persistent skip is also free and uncharged
  await seed(db, "https://api.nodns.dev/v1/q2", 30, "recheck", "dns_error");
  const p2 = await callAs(env, "/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://api.nodns.dev/v1/q2"), ip);
  assert.equal(p2.body.reason_code, "dns_error_persistent"); assert.equal(p2.body.access.free_check_used, false);
  assert.deepEqual(otherHits, [], "no facilitator or other outside call"); assert.deepEqual(sellerHits, ["api.okfix.dev"]);
  const again = await callAs(env, "/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://api.okfix.dev/v1/q3"), ip);
  assert.equal(again.body.access.free_used_today, 2, "only the two real checks counted");
  assert.equal(quota.ops.filter((o) => o.startsWith("take:")).length, 4, "two real checks x (client + network counter)");
});

const LITERALS = ["http://127.0.0.1/x", "http://127.1.2.3/x", "http://10.0.0.1/x", "http://172.16.0.1/x", "http://192.168.0.10/x", "http://169.254.169.254/latest/meta-data",
  "http://100.64.0.1/x", "http://0.0.0.0/x", "http://[::1]/x", "http://[fe80::1]/x", "http://[fd00::5]/x", "http://[::ffff:127.0.0.1]/x", "http://[::ffff:169.254.169.254]/x", "http://[::]/x"];
const PRIV_HOSTS = Object.keys(PRIV_DNS).map((h) => `https://${h}/v1/x`);

test("review 2a: SSRF at the probe: literal private/loopback/link-local IPs (v4 + v6) and hostnames resolving to them are skip/ssrf_blocked, never dns_error, no retry, never fetched", async () => {
  const { spotProbe } = await import("../worker/src/spotcheck.js");
  for (const u of [...LITERALS, ...PRIV_HOSTS]) {
    doh.length = 0; sellerHits.length = 0; otherHits.length = 0;
    const p = await spotProbe(u);
    assert.equal(p.ssrf_blocked, true, u); assert.equal(p.dns_error, undefined, u); assert.equal(p.dns_retried, undefined, u);
    assert.deepEqual(decideVerdict(p), { verdict: "skip", reason: "ssrf_blocked" }, u);
    assert.ok(!doh.some((x) => x.retry), "no DNS retry: " + u);
    if (LITERALS.includes(u)) assert.equal(doh.length, 0, "a literal IP is never looked up: " + u);
    assert.deepEqual(otherHits, [], u); assert.deepEqual(sellerHits, [], u);
  }
});

test("review 2b: SSRF at the route: hostnames resolving to private addresses -> HTTP 400 skip/ssrf_blocked; literal IPs are refused before any probe; never recheck", async () => {
  const db = d1(); const env = envFor(db);
  for (const u of PRIV_HOSTS) {
    doh.length = 0; otherHits.length = 0;
    const r = await check(env, u);
    assert.equal(r.status, 400, u); assert.equal(r.body.verdict, "skip", u); assert.equal(r.body.reason_code, "ssrf_blocked", u);
    assert.ok(!doh.some((x) => x.retry), "no retry: " + u); assert.deepEqual(otherHits, [], u);
  }
  for (const u of LITERALS) {
    doh.length = 0; otherHits.length = 0;
    const r = await check(env, u);
    assert.ok(r.status === 400 || r.status === 402, u + " -> " + r.status);
    assert.notEqual(r.body.verdict, "recheck", u); assert.notEqual(r.body.reason_code, "dns_error", u);
    if (r.status === 400) { assert.equal(r.body.verdict, "skip", u); assert.equal(r.body.reason_code, "ssrf_blocked", u); }
    else assert.match(JSON.stringify(r.body), /placeholder_host/, u + ": localhost-style hosts are refused as placeholders (unchanged, before the SSRF gate)");
    assert.equal(doh.length, 0, u); assert.deepEqual(otherHits, [], u);
  }
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM spot_receipts").get().n, 0, "nothing probed or stored");
});

test("review 2c: SSRF through redirects: a public seller redirecting to a private/loopback/link-local IP, an IPv6 one, a host resolving to one, or a host that does not resolve -> skip/ssrf_blocked (never dns_error/recheck), target never fetched", async () => {
  const db = d1(); const env = envFor(db);
  const targets = ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://[::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/",
    "https://api.metafix.dev/x", "https://api.v6loopfix.dev/x", "https://api.v6mapllfix.dev/x", "https://api.nodns.dev/x"];
  for (const t of targets) {
    sellerHits.length = 0; otherHits.length = 0; doh.length = 0;
    const r = await check(env, "https://api.redirfix.dev/v1/x?to=" + encodeURIComponent(t));
    assert.equal(r.body.verdict, "skip", t); assert.equal(r.body.reason_code, "ssrf_blocked", t);
    assert.equal(r.body.transient, undefined, t);
    assert.deepEqual(sellerHits, ["api.redirfix.dev"], "only the public seller was fetched: " + t); assert.deepEqual(otherHits, [], t);
    assert.ok(!doh.some((x) => x.retry), "no DNS retry on a redirect target: " + t);
  }
});

test("review 3: persistent skips are listed in the existing /v1/skips list under their own reason codes (recent_checks; crawl skip pages keep reason_code)", async () => {
  const db = d1(); const env = envFor(db);
  const U = "https://api.ratefix.dev/v1/listed";
  await seed(db, U, 26, "recheck", "rate_limited");
  const r = await callAs(env, "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(U), "198.18.9.1");
  assert.equal(r.body.reason_code, "rate_limited_persistent");
  const rec = await callAs(env, "/v1/products/endpoint-spot-check?url=" + encodeURIComponent("https://api.waffix.dev/v1/listed"), "198.18.9.2");
  assert.equal(rec.body.verdict, "recheck");
  const sk = (await callAs(env, "/v1/skips.json", "198.18.9.3")).body;
  const mine = sk.recent_checks.filter((x) => x.url.startsWith("https://api.ratefix.dev") || x.url.startsWith("https://api.waffix.dev"));
  assert.deepEqual(mine.map((x) => [x.url, x.verdict, x.reason_code]).sort(), [["https://api.ratefix.dev/v1/listed", "skip", "rate_limited_persistent"], ["https://api.waffix.dev/v1/listed", "recheck", "waf_challenge"]]);
  assert.equal(mine.find((x) => x.verdict === "skip").reason, REASON_TEXT.rate_limited_persistent);
  // crawl skip pages are the crawl records themselves, so a persistent crawl skip keeps its reason_code there
  const page2 = [{ id: "ab12cd34ef", url: "https://api.ratefix.dev/v1/crawl", method: "GET", verdict: "skip", reason_code: "rate_limited_persistent", reason: "endpoint has only answered HTTP 429 (rate limited) for longer than our retry window (since 2026-10-20T13:30:00Z)", transient_since: "2026-10-20T13:30:00Z", transient_code: "rate_limited", timestamp: "2026-10-27T13:30:00Z", source_list: "agent402", check_type: "self-checked" }];
  const text = JSON.stringify(page2);
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  db.raw.prepare("INSERT OR REPLACE INTO crawl_store (key, part, parts, sha256, value, source, updated_at) VALUES ('s:2', 0, 1, ?, ?, 'test', ?)").run(sha, text, iso(Date.now()));
  const { _clearCrawlStoreCache } = await import("../worker/src/skips.js"); _clearCrawlStoreCache();
  const p2 = (await callAs(env, "/v1/skips.json?page=2", "198.18.9.4")).body;
  assert.equal(p2.skips[0].reason_code, "rate_limited_persistent"); assert.equal(p2.skips[0].verdict, "skip");
});

test("price and free tier unchanged: paid check is still $0.02 (20000 atomic) and 5 free per day", async () => {
  const toml = readFileSync(join(ROOT, "worker", "wrangler.toml"), "utf8");
  assert.match(toml, /SPOT_FREE_PER_DAY = "5"/);
  const { SPOT_PAID_ATOMIC } = await import("../worker/src/lib.js");
  assert.equal(SPOT_PAID_ATOMIC, "20000");
});

test.after(() => { globalThis.fetch = origFetch; });
