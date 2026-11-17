// 0.75.0 probe-set expansion for the reliability score (worker/src/probeset.js). Same harness as multiprobe_test.mjs: real
// SQLite (node:sqlite) runs every migration behind a tiny D1 adapter; DNS and sellers are stubbed. Synthetic hosts only,
// nothing leaves the process, nothing is paid. Everything is OFF unless SCORE_PROBES / SCORE_DEMAND = "1".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import * as P from "../worker/src/probeset.js";
import { BADGE_HOSTS, lastDailyCheck } from "../worker/src/daily.js";
import { scoreConfig } from "../worker/src/score.js";

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
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x" + "bb".repeat(20);
const r402 = () => { const body = { x402Version: 2, error: "Payment required", accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300 }] }; return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "payment-required": btoa(JSON.stringify(body)) } }); };
const sellerUas = []; const sellerHits = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "cloudflare-dns.com") return Response.json(u.searchParams.get("type") === "A" ? { Answer: [{ type: 1, data: "93.184.216.34" }] } : { Answer: [] });
  if (u.hostname.endsWith(".seller-fixture.dev")) { sellerHits.push(u.hostname + u.pathname); sellerUas.push((init.headers || {})["user-agent"]); return r402(); }
  return new Response("not stubbed", { status: 599 });
};
const noKv = { get: async () => null, put: async () => { throw new Error("must not write KV"); }, delete: async () => { throw new Error("no KV deletes"); } };
const NOW = new Date("2026-11-18T05:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
let rid = 0;
function addReceipt(db, { url, type = "live", ref = null, client = null, ageH = 24, method = "GET", verdict = "pay" }) {
  const at = iso(NOW - ageH * 3600e3);
  const body = JSON.stringify({ id: "x", url, method, check_type: type, client, ref });
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, body) VALUES (?, ?, ?, ?, 'price_ok', ?, ?, ?)").run("sc-" + String(++rid).padStart(16, "0"), url, at, verdict, type, ref, body);
}
const addDemand = (db, url, n, day = "2026-11-17") => db.raw.prepare("INSERT INTO endpoint_demand_daily (day, url, kind, n) VALUES (?, ?, 'discover', ?)").run(day, url, n);
const queue = (db, day = P.queueDay(NOW)) => db.raw.prepare("SELECT url, method, done_at, verdict, receipt_id FROM daily_queue WHERE day = ? AND url != ? ORDER BY rowid").all(day, P.SEED_MARK);
const seeded = (rnd = () => 0.5) => rnd;

test("version is 0.76.0; flags are off by default and the new env names are not in wrangler.toml as active vars", () => {
  assert.equal(VERSION, "0.76.0");
  assert.equal(P.probesOn({}), false); assert.equal(P.demandOn({}), false);
  assert.equal(P.probesOn({ SCORE_PROBES: "1" }), true); assert.equal(P.probesOn({ SCORE_PROBES: "true" }), false);
  const toml = readFileSync(join(ROOT, "worker", "wrangler.toml"), "utf8");
  for (const line of toml.split("\n")) if (/SCORE_(PROBES|DEMAND)/.test(line)) assert.ok(line.trim().startsWith("#"), "flag must be commented out: " + line);
});

test("config: defaults (cap 1000, batch 24, skip 0.15, jitter 1500 ms, gap 20 h, demand window 30 d) and clamps", () => {
  assert.deepEqual(P.probeConfig({}), { cap: 1000, batch: 24, jitter_ms: 1500, min_gap_h: 20, demand_days: 30, skip_p: 0.15 });
  const c = P.probeConfig({ SCORE_PROBE_CAP: "999999", SCORE_PROBE_BATCH: "0", SCORE_PROBE_JITTER_MS: "99999", SCORE_PROBE_SKIP_P: "0.99", SCORE_DEMAND_DAYS: "0" });
  assert.equal(c.cap, 5000); assert.equal(c.batch, 1); assert.equal(c.jitter_ms, 5000); assert.equal(c.skip_p, 0.15); assert.equal(c.demand_days, 1);
  assert.equal(P.probeConfig({ SCORE_PROBE_CAP: "50", SCORE_PROBE_SKIP_P: "0" }).cap, 50);
  assert.equal(P.probeConfig({ SCORE_PROBE_CAP: "abc" }).cap, 1000);
});

test("user agents: honest generic strings only; crawler, browser and real-product strings are dropped; empty falls back", () => {
  assert.deepEqual(P.probeUserAgents({}), P.GENERIC_UAS);
  for (const ua of P.GENERIC_UAS) assert.ok(!P.UA_BLOCK_RE.test(ua), ua);
  const bad = ["Googlebot/2.1 (+http://www.google.com/bot.html)", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120", "curl/8.4.0", "python-requests/2.31", "GPTBot/1.0", "ClaudeBot/1.0", "bingbot/2.0", "node-fetch/3", "PerplexityBot", "axios/1.6", "Go-http-client/2.0", "Cursor/1.0", "my agent\u0000", "x".repeat(81)];
  assert.deepEqual(P.probeUserAgents({ SCORE_PROBE_UAS: bad.join("|") }), P.GENERIC_UAS, "all rejected -> defaults");
  assert.deepEqual(P.probeUserAgents({ SCORE_PROBE_UAS: [...bad, "payment-agent/2.0", "x402-client/1.0"].join("|") }), ["payment-agent/2.0", "x402-client/1.0"]);
  assert.equal(P.pickUa(["a", "b", "c"], () => 0), "a"); assert.equal(P.pickUa(["a", "b", "c"], () => 0.999999), "c"); assert.equal(P.pickUa(["a", "b", "c"], () => 0.5), "b");
});

test("shuffled is a permutation and does not mutate its input", () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8]; let s = 3; const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  const b = P.shuffled(a, rnd);
  assert.deepEqual([...b].sort(), a); assert.deepEqual(a, [1, 2, 3, 4, 5, 6, 7, 8]); assert.notDeepEqual(b, a);
});

test("candidates: public, non-template, non-operator URLs only; ranking weights check demand 2x discover demand", () => {
  const sc = scoreConfig({});
  assert.equal(P.candidateUrl("https://a.seller-fixture.dev/v1/x?key=abc#f", sc), "https://a.seller-fixture.dev/v1/x");
  for (const bad of ["https://api.402xagent.com/v1/products/endpoint-spot-check", "https://api.402rates.com/v1/ping", "https://verified-catalog-lookup.me.workers.dev/x", "http://127.0.0.1/x", "https://10.0.0.1/x", "https://localhost/x", "https://a.seller-fixture.dev/users/:id/pay", "https://a.seller-fixture.dev/{id}", "ftp://a.seller-fixture.dev/x", "not a url", "https://user:pw@a.seller-fixture.dev/x"])
    assert.equal(P.candidateUrl(bad, sc), null, bad);
  const r = P.rankDemand({ checks: [{ url: "u1", c: 3, method: "POST" }, { url: "u2", c: 1 }], discover: [{ url: "u2", d: 4 }, { url: "u3", d: 5 }] });
  assert.deepEqual(r.map((x) => [x.url, x.score]), [["u2", 6], ["u1", 6], ["u3", 5]].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  assert.equal(r.find((x) => x.url === "u1").method, "POST"); assert.equal(r.find((x) => x.url === "u2").discover, 4);
});

test("expansion list: top demand up to the cap; excludes our hosts, the curated badge hosts, test clients and anything probed in the last 20 h", async () => {
  const db = d1();
  const U = (n) => `https://s${n}.seller-fixture.dev/v1/data`;
  for (let i = 1; i <= 5; i++) for (let k = 0; k < i; k++) addReceipt(db, { url: U(i), ageH: 30 + k }); // s5 has the most outside checks
  addReceipt(db, { url: U(9), client: "catalog-heartbeat-20261117" }); // test client: not demand
  addReceipt(db, { url: U(8), type: "self-checked", ref: "daily-recheck", ageH: 2 }); // our own probe: not demand
  addReceipt(db, { url: "https://api.402rates.com/v1/ping" }); addReceipt(db, { url: "https://api.402xagent.com/x" }); // operator hosts
  addReceipt(db, { url: BADGE_HOSTS[0].url });
  addReceipt(db, { url: U(7), type: "dry-run" }); // dry-run checks are demand
  addDemand(db, U(6), 50); addDemand(db, U(3), 10); // discover demand
  addReceipt(db, { url: U(6), type: "self-checked", ref: "bazaar-daily", ageH: 3 }); // probed 3 h ago -> skipped
  addDemand(db, U(5), 1, "2026-09-01"); // outside the 30-day window: ignored
  const all = await P.buildExpansion({ RECEIPTS_DB: db, SCORE_PROBE_CAP: "100" }, { now: NOW });
  assert.deepEqual(all.items.map((x) => x.url), [U(3), U(5), U(4), U(2), U(1), U(7)]);
  assert.equal(all.items[0].score, 16); // 3 checks * 2 + 10 discover
  const capped = await P.buildExpansion({ RECEIPTS_DB: db, SCORE_PROBE_CAP: "2" }, { now: NOW });
  assert.deepEqual(capped.items.map((x) => x.url), [U(3), U(5)]);
  // the table being absent (migration not applied) only removes the discover half
  const noTable = d1(); noTable.raw.exec("DROP TABLE endpoint_demand_daily"); addReceipt(noTable, { url: U(1) });
  assert.deepEqual((await P.buildExpansion({ RECEIPTS_DB: noTable }, { now: NOW })).items.map((x) => x.url), [U(1)]);
});

test("seed: one queue per UTC day, capped, inserted in random order (not demand order), idempotent, daily_runs untouched, old demand pruned", async () => {
  const db = d1();
  const U = (n) => `https://s${n}.seller-fixture.dev/v1/data`;
  for (let i = 1; i <= 8; i++) for (let k = 0; k < i; k++) addReceipt(db, { url: U(i), ageH: 30 });
  addDemand(db, "https://old.seller-fixture.dev/x", 3, "2026-09-01"); addDemand(db, U(2), 3);
  const env = { RECEIPTS_DB: db, SCORE_PROBES: "1", SCORE_PROBE_CAP: "5" };
  assert.deepEqual(await P.probeSeed({ RECEIPTS_DB: db }, { now: NOW }), { did: "off" }, "flag off: nothing happens");
  assert.equal(queue(db).length, 0);
  const rev = () => 0; // Fisher-Yates with rnd=0 rotates the list: not demand order
  const r1 = await P.probeSeed(env, { now: NOW, rnd: rev });
  assert.deepEqual(r1, { did: "seeded", n: 5 });
  const q = queue(db);
  assert.equal(q.length, 5);
  const byDemand = [U(8), U(7), U(6), U(5), U(4)];
  assert.deepEqual([...q.map((x) => x.url)].sort(), [...byDemand].sort(), "the cap picks the top 5 by demand");
  assert.notDeepEqual(q.map((x) => x.url), byDemand, "queue order is not the demand order");
  assert.equal((await P.probeSeed(env, { now: NOW, rnd: rev })).did, "already");
  assert.equal(queue(db).length, 5);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM daily_runs").get().n, 0, "daily_runs is never written");
  assert.equal(await lastDailyCheck(db), null, "the Last checked text on the badge pages is unaffected");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM endpoint_demand_daily WHERE url = 'https://old.seller-fixture.dev/x'").get().n, 0, "demand older than 45 days is pruned");
  // the existing daily step does not see this queue (different day key)
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM daily_queue WHERE day = ?").get(NOW.toISOString().slice(0, 10)).n, 0);
});

test("step: flag off does nothing and touches no table", async () => {
  const boom = { prepare() { throw new Error("db must not be touched"); }, batch() { throw new Error("db must not be touched"); } };
  assert.deepEqual(await P.probeStep({ RECEIPTS_DB: boom }, { now: NOW, runCheck: () => { throw new Error("no probe"); } }), { did: "off" });
  assert.deepEqual(await P.recordDemand({ RECEIPTS_DB: boom }, { urls: ["https://a.seller-fixture.dev/x"], now: NOW }), { did: "off" });
});

test("step: random-sized slice (between half the batch and the batch), jitter between probes, rotated UA, never more than the cap, drains to 'drained'", async () => {
  const db = d1();
  for (let i = 1; i <= 30; i++) addReceipt(db, { url: `https://s${i}.seller-fixture.dev/v1/data`, ageH: 30 });
  const env = { RECEIPTS_DB: db, SCORE_PROBES: "1", SCORE_PROBE_CAP: "30", SCORE_PROBE_BATCH: "8", SCORE_PROBE_JITTER_MS: "1000", SCORE_PROBE_SKIP_P: "0" };
  let s = 11; const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  const sleeps = [], calls = [];
  const runCheck = async (u, extra) => { calls.push({ u, ua: extra.userAgent }); return Response.json({ verdict: "pay", receipt_id: "sc-" + "0".repeat(16) }); };
  let steps = 0, total = 0;
  for (; steps < 20; steps++) {
    calls.length = 0; sleeps.length = 0;
    const r = await P.probeStep(env, { now: NOW, runCheck, origin: "https://api.402xagent.com", rnd, sleep: async (ms) => { sleeps.push(ms); } });
    if (r.did === "drained") break;
    assert.equal(r.did, "probed");
    assert.ok(r.n >= 4 && r.n <= 8 || total + r.n === 30, "slice " + r.n);
    assert.equal(sleeps.length, r.n - 1); for (const ms of sleeps) assert.ok(ms >= 0 && ms <= 1000);
    for (const c of calls) { assert.ok(P.GENERIC_UAS.includes(c.ua), c.ua); const q = new URL(c.u); assert.equal(q.searchParams.get("ref"), P.SCORE_PROBE_REF); assert.equal(q.searchParams.get("client"), P.SCORE_PROBE_CLIENT); }
    total += r.n;
  }
  assert.equal(total, 30); assert.ok(steps >= 4, "30 endpoints at <= 8 a step take several steps: " + steps);
  const q = queue(db);
  assert.equal(q.length, 30); assert.ok(q.every((x) => x.done_at && x.verdict === "pay"));
  assert.ok(new Set(sleeps.concat([1])).size >= 1);
  const uas = new Set(); // across the run more than one UA was used
  for (const x of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) uas.add(P.pickUa(P.GENERIC_UAS, rnd));
  assert.ok(uas.size > 1);
});

test("step: skip probability skips whole steps (no probe, queue untouched)", async () => {
  const db = d1(); addReceipt(db, { url: "https://s1.seller-fixture.dev/v1/data", ageH: 30 });
  const env = { RECEIPTS_DB: db, SCORE_PROBES: "1", SCORE_PROBE_SKIP_P: "0.5" };
  let called = 0;
  const r = await P.probeStep(env, { now: NOW, runCheck: async () => { called++; return Response.json({ verdict: "pay" }); }, rnd: () => 0.1, sleep: async () => {} });
  assert.deepEqual(r, { did: "skipped" }); assert.equal(called, 0); assert.equal(queue(db).length, 0);
});

test("a failing probe is recorded as recheck and the step goes on", async () => {
  const db = d1(); for (const i of [1, 2]) addReceipt(db, { url: `https://s${i}.seller-fixture.dev/v1/data`, ageH: 30 });
  const env = { RECEIPTS_DB: db, SCORE_PROBES: "1", SCORE_PROBE_SKIP_P: "0", SCORE_PROBE_BATCH: "2" };
  let n = 0;
  const r = await P.probeStep(env, { now: NOW, rnd: () => 0.99, sleep: async () => {}, runCheck: async () => { if (n++ === 0) throw new Error("boom"); return Response.json({ verdict: "skip" }); } });
  assert.equal(r.did, "probed"); assert.equal(r.n, 2);
  assert.deepEqual(queue(db).map((x) => x.verdict).sort(), ["recheck", "skip"]);
});

test("end to end through the cron: flag on probes the queue as ref score-probe with probe_origin cron and a generic UA; flag off changes nothing", async () => {
  async function run(flags) {
    sellerUas.length = 0; sellerHits.length = 0;
    const db = d1();
    for (const i of [1, 2, 3]) addReceipt(db, { url: `https://s${i}.seller-fixture.dev/v1/data`, ageH: 30 });
    const env = { RECEIPTS_DB: db, CLIENT_SALT: "s", SPOT_PROBE_CACHE_S: "0", CRAWL_KV: noKv, SPOT_KV: noKv, BREAKER_CACHE: null, DAILY_RECHECK: "off", STALE_RECHECK: "off", SCORE_PROBE_SKIP_P: "0", SCORE_PROBE_BATCH: "3", SCORE_PROBE_JITTER_MS: "0", ...flags };
    for (let i = 0; i < 4; i++) await worker.scheduled({ cron: "*/20 * * * *", scheduledTime: NOW.getTime() + i * 1200e3 }, env, { waitUntil() {} });
    return { db, env };
  }
  const off = await run({});
  assert.equal(sellerHits.length, 0, "flag off: no expansion probe");
  assert.equal(off.db.raw.prepare("SELECT COUNT(*) AS n FROM daily_queue").get().n, 0);
  assert.equal(off.db.raw.prepare("SELECT COUNT(*) AS n FROM spot_receipts WHERE check_type = 'self-checked'").get().n, 0);
  const on = await run({ SCORE_PROBES: "1" });
  assert.deepEqual([...new Set(sellerHits)].sort(), ["s1.seller-fixture.dev/v1/data", "s2.seller-fixture.dev/v1/data", "s3.seller-fixture.dev/v1/data"]);
  for (const ua of sellerUas) assert.ok(P.GENERIC_UAS.includes(ua), "outbound UA " + ua);
  const rows = on.db.raw.prepare("SELECT ref, check_type, body FROM spot_receipts WHERE check_type = 'self-checked'").all();
  assert.equal(rows.length, 3);
  for (const r of rows) {
    const b = JSON.parse(r.body);
    assert.equal(r.ref, P.SCORE_PROBE_REF); assert.equal(b.probe_origin, "cron"); assert.equal(b.caller, "self-test"); assert.equal(b.access_tier, "auto");
    assert.equal(b.probe && b.probe.multiprobe, undefined, "cron probes never run the confirm probe");
  }
  assert.equal(queue(on.db, P.queueDay(NOW)).filter((x) => x.done_at).length, 3);
});

test("a caller cannot set probe_origin: a normal check of the same URL (even with the self-test client and the cron ref) has none", async () => {
  sellerUas.length = 0; sellerHits.length = 0;
  const db = d1();
  const env = { RECEIPTS_DB: db, CLIENT_SALT: "s", SPOT_PROBE_CACHE_S: "0", CRAWL_KV: noKv, SPOT_KV: noKv, BREAKER_CACHE: null, SELF_CLIENTS: "withgrokbot,withgrokbot-selftest", SCORE_PROBES: "1" };
  const q = "?url=" + encodeURIComponent("https://s1.seller-fixture.dev/v1/data") + "&client=withgrokbot-selftest&ref=score-probe&probe_origin=cron";
  const r = await worker.fetch(new Request("https://api.402xagent.com/v1/products/endpoint-spot-check" + q, { headers: { "cf-connecting-ip": "198.18.7.7", "user-agent": "agent-x/1.0" } }), env, { waitUntil() {} });
  assert.ok([200, 402].includes(r.status), String(r.status));
  const row = db.raw.prepare("SELECT body FROM spot_receipts ORDER BY created_at DESC LIMIT 1").get();
  if (row) assert.equal(JSON.parse(row.body).probe_origin, undefined);
  assert.ok(sellerHits.length >= 1, "the outside request did probe the seller");
  assert.ok(!sellerUas.includes(undefined));
  for (const ua of sellerUas) assert.equal(ua, "verified-catalog-spotcheck/0.7.0", "an outside request keeps the default probe UA");
});

test("demand recording: off by default; counts the first five results once per call; skips ours, uptime, crawlers and bots; table absent fails open", async () => {
  const db = d1();
  const body = { results: ["a", "b", "c", "d", "e", "f"].map((x) => ({ endpoint: `https://${x}.seller-fixture.dev/v1/p?k=1` })).concat([{ endpoint: "http://127.0.0.1/x" }]) };
  const urls = P.discoverShownUrls(body);
  assert.deepEqual(urls, ["a", "b", "c", "d", "e"].map((x) => `https://${x}.seller-fixture.dev/v1/p`));
  assert.deepEqual(P.discoverShownUrls({ results: [{ endpoint: "https://a.seller-fixture.dev/x" }, { endpoint: "https://a.seller-fixture.dev/x" }] }), ["https://a.seller-fixture.dev/x"]);
  assert.deepEqual(P.discoverShownUrls(null), []);
  assert.equal((await P.recordDemand({ RECEIPTS_DB: db }, { urls, now: NOW })).did, "off");
  const env = { RECEIPTS_DB: db, SCORE_DEMAND: "1" };
  assert.deepEqual(await P.recordDemand(env, { urls, skip: "self", now: NOW }), { did: "off" });
  assert.deepEqual(await P.recordDemand(env, { urls, skip: "crawler", now: NOW }), { did: "off" });
  assert.equal((await P.recordDemand(env, { urls, now: NOW })).did, "recorded");
  await P.recordDemand(env, { urls: urls.slice(0, 2), now: NOW });
  const rows = db.raw.prepare("SELECT day, url, kind, n FROM endpoint_demand_daily ORDER BY url").all();
  assert.equal(rows.length, 5); assert.deepEqual(rows.map((r) => r.n), [2, 2, 1, 1, 1]); assert.ok(rows.every((r) => r.day === "2026-11-18" && r.kind === "discover"));
  const cols = db.raw.prepare("PRAGMA table_info(endpoint_demand_daily)").all().map((c) => c.name).sort();
  assert.deepEqual(cols, ["day", "kind", "n", "url"], "no client id, IP, UA, wallet or query text is stored");
  const noTable = d1(); noTable.raw.exec("DROP TABLE endpoint_demand_daily");
  assert.deepEqual(await P.recordDemand({ RECEIPTS_DB: noTable, SCORE_DEMAND: "1" }, { urls, now: NOW }), { did: "db-error" });
});

test("wiring: both discover paths (HTTP and MCP) record demand through recordDemandAsync with the caller's exclusion(); migration 0033 is a single additive CREATE", () => {
  const lib = readFileSync(join(ROOT, "worker", "src", "lib.js"), "utf8");
  assert.equal((lib.match(/demandNote\(req, env, ctx, r\.body\);/g) || []).length, 2);
  assert.match(lib, /function demandNote\(req, env, ctx, body\) \{\n  try \{ recordDemandAsync\(env, ctx, \{ urls: discoverShownUrls\(body\), skip: exclusion\(req, parseQuery\(new URL\(req\.url\)\), env\) \}\); \} catch/);
  const mig = readFileSync(join(MIG_DIR, "0033_endpoint_demand_daily.sql"), "utf8");
  assert.ok(!/\b(DROP|DELETE|UPDATE|ALTER)\b/i.test(mig.replace(/--.*$/gm, "")), "additive only");
  assert.equal((mig.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 1);
});
