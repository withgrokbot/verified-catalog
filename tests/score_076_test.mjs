// 0.76.0 reliability score, PR 3: storage, daily rollup and serving behind SCORE_BAND = off (default) | shadow | on
// (worker/src/scorestore.js, migration 0034). Same harness as probeset_075_test.mjs: real SQLite (node:sqlite) runs every
// migration behind a tiny D1 adapter. Synthetic hosts only; nothing leaves the process, nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { VERSION, historyKey } from "../worker/src/lib.js";
import * as P from "../worker/src/probeset.js";
import * as S from "../worker/src/scorestore.js";
import { _addTestKey, _resetSigner, signingInput } from "../worker/src/sign.js";

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
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname === "cloudflare-dns.com") return Response.json(u.searchParams.get("type") === "A" ? { Answer: [{ type: 1, data: "93.184.216.34" }] } : { Answer: [] });
  return new Response("not stubbed", { status: 599 });
};
const noKv = { get: async () => null, put: async () => { throw new Error("must not write KV"); }, delete: async () => { throw new Error("no KV deletes"); } };
const NOW = new Date("2026-11-18T05:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x" + "bb".repeat(20);
let rid = 0;
function addReceipt(db, { url, type = "self-checked", ref = "daily-recheck", client = "withgrokbot-selftest", caller = "self-test", origin = "cron", ageH = 24, verdict = "pay", reason = "price_ok", http = 402, method = "GET" }) {
  const body = { id: "x", url, method, check_type: type, client, caller, ref, ...(origin ? { probe_origin: origin } : {}), reason_code: reason, live_402: { http_status: http, x402_challenge: http === 402, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC, amount_atomic: "1000", pay_to: PAY_TO }] }, listing: { source: "cdp-bazaar" } };
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("sc-" + String(++rid).padStart(16, "0"), url, iso(NOW - ageH * 3600e3), verdict, reason, type, ref, JSON.stringify(body));
}
const goodHost = (db, host, n = 14) => { for (let i = 0; i < n; i++) addReceipt(db, { url: `https://${host}/v1/data`, ageH: i * 24 + (i * 7) % 20 + 2 }); };
const failHost = (db, host, n = 14) => { for (let i = 0; i < n; i++) addReceipt(db, { url: `https://${host}/v1/data`, ageH: i * 24 + (i * 7) % 20 + 2, verdict: "recheck", reason: "server_error", http: 500 }); };
const deps = { historyKey };
const mkEnv = (flags = {}, db = d1()) => ({ RECEIPTS_DB: db, CLIENT_SALT: "s", SPOT_PROBE_CACHE_S: "0", CRAWL_KV: noKv, SPOT_KV: noKv, BREAKER_CACHE: null, DAILY_RECHECK: "off", STALE_RECHECK: "off", ...flags });
const call = (env, path, init = {}) => worker.fetch(new Request("https://api.402xagent.com" + path, { headers: { "cf-connecting-ip": "198.18." + (1 + (++rid % 200)) + ".9", "user-agent": "agent-x/1.0" }, ...init }), env, { waitUntil() {} });
const rpc = async (env, method, params) => (await (await call(env, "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": "198.18.250." + (1 + (++rid % 200)) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
const cron = (env, i = 0) => worker.scheduled({ cron: "*/20 * * * *", scheduledTime: NOW.getTime() + i * 1200e3 }, env, { waitUntil() {} });
const rows = (db) => db.raw.prepare("SELECT * FROM endpoint_score_daily ORDER BY url").all();

test("version is 0.77.1; SCORE_BAND is shadow in wrangler.toml (owner-approved 7-day hidden test); code still defaults off when unset", () => {
  assert.equal(VERSION, "0.80.0");
  assert.equal(S.scoreMode({}), "off"); assert.equal(S.scoreMode({ SCORE_BAND: "bogus" }), "off");
  assert.equal(S.scoreMode({ SCORE_BAND: "Shadow" }), "shadow"); assert.equal(S.scoreMode({ SCORE_BAND: "on" }), "on");
  assert.equal(S.scoreServeOn({ SCORE_BAND: "shadow" }), false); assert.equal(S.scoreRecordOn({ SCORE_BAND: "shadow" }), true);
  assert.equal(S.scoreRecordOn({}), false); assert.equal(S.scoreServeOn({ SCORE_BAND: "on" }), true);
  const toml = readFileSync(join(ROOT, "worker", "wrangler.toml"), "utf8");
  assert.match(toml, /^SCORE_BAND\s*=\s*"shadow"/m);
  assert.match(toml, /^SCORE_ORIGIN_FROM\s*=\s*"20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"/m);
  assert.doesNotMatch(toml, /^SCORE_BAND\s*=\s*"on"/m);
  for (const line of toml.split("\n")) if (/SCORE_ROLLUP/.test(line)) assert.ok(line.trim().startsWith("#"), "rollup batch stays at the code default: " + line);
});

test("migration 0034 is additive and creates endpoint_score_daily with both bands, keyed by (day, url)", () => {
  const sql = readFileSync(join(MIG_DIR, "0034_endpoint_score_daily.sql"), "utf8");
  assert.ok(!/DROP |ALTER |DELETE FROM (?!endpoint_score_daily)/i.test(sql.replace(/--.*$/gm, "")));
  const db = d1();
  const cols = db.raw.prepare("PRAGMA table_info(endpoint_score_daily)").all().map((c) => c.name);
  for (const c of ["day", "url", "band", "internal_band", "confidence", "flags", "formula_version", "inputs_digest", "computed_at"]) assert.ok(cols.includes(c), c);
  assert.ok(!cols.some((c) => /payer|wallet|tx|ip|client/.test(c)), "no buyer, wallet, tx, ip or client columns");
});

test("scoreEndpoint reads receipts and stamps: good for a clean probed endpoint, internal avoid for a failing one; test traffic is excluded", async () => {
  const db = d1();
  goodHost(db, "good.seller-fixture.dev"); failHost(db, "bad.seller-fixture.dev");
  for (let i = 0; i < 6; i++) addReceipt(db, { url: "https://noisy.seller-fixture.dev/v1/data", ageH: 10 + i, type: "dry-run", ref: null, caller: null, client: null, origin: null });
  addReceipt(db, { url: "https://noisy.seller-fixture.dev/v1/data", ageH: 5, type: "live", ref: null, caller: null, client: "catalog-heartbeat-20261117", origin: null });
  const env = mkEnv({}, db);
  const g = await S.scoreEndpoint(env, "https://good.seller-fixture.dev/v1/data", NOW, deps);
  assert.equal(g.band, "good"); assert.match(g.inputs_digest, /^sha256:[0-9a-f]{64}$/);
  const b = await S.scoreEndpoint(env, "https://bad.seller-fixture.dev/v1/data", NOW, deps);
  assert.equal(b.band, "avoid");
  const n = await S.scoreEndpoint(env, "https://noisy.seller-fixture.dev/v1/data", NOW, deps);
  assert.equal(n.band, "unknown"); assert.equal(n.observations, 0); assert.ok(n.excluded.dry_run >= 6 && n.excluded.test_client >= 1);
  assert.equal(await S.scoreEndpoint(env, "http://127.0.0.1/x", NOW, deps), null, "private hosts are not scored");
});

test("flag off: nothing runs, nothing is written, /v1/score and /score-rules.json do not exist, no MCP tool, no OpenAPI path", async () => {
  const db = d1(); goodHost(db, "good.seller-fixture.dev");
  const env = mkEnv({}, db);
  assert.deepEqual(await S.scoreTick(env, { now: NOW, deps }), { did: "off" });
  await cron(env);
  assert.equal(rows(db).length, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM daily_queue").get().n, 0);
  for (const p of ["/v1/score?url=https://good.seller-fixture.dev/v1/data", "/score-rules.json"]) assert.equal((await call(env, p)).status, 404, p);
  assert.ok(!(await rpc(env, "tools/list")).result.tools.some((t) => t.name === "safe_to_pay"));
  assert.ok((await rpc(env, "tools/call", { name: "safe_to_pay", arguments: { url: "https://good.seller-fixture.dev/v1/data" } })).error, "tool unknown while off");
  assert.ok(!JSON.stringify(await (await call(env, "/openapi.json")).json()).includes("/v1/score"));
});

test("shadow: the rollup records bands (public and internal) across cron steps, serves nothing, and stamps probe_origin on cron probes", async () => {
  const db = d1();
  goodHost(db, "good.seller-fixture.dev"); failHost(db, "bad.seller-fixture.dev");
  goodHost(db, "api.402xagent.com", 8); // our own host: operator_endpoint, never ranked
  const env = mkEnv({ SCORE_BAND: "shadow", SCORE_ROLLUP_BATCH: "1" }, db);
  for (let i = 0; i < 5; i++) await cron(env, i);
  const r = Object.fromEntries(rows(db).map((x) => [x.url, x]));
  assert.equal(Object.keys(r).length, 2, "operator hosts are not queued; the other two are scored one per step");
  assert.equal(r["https://good.seller-fixture.dev/v1/data"].band, "good");
  const bad = r["https://bad.seller-fixture.dev/v1/data"];
  assert.equal(bad.internal_band, "avoid"); assert.equal(bad.band, "caution", "avoid is recorded internally, caution is what could be served");
  assert.ok(JSON.parse(bad.flags).some((f) => f.code === "failing_now"));
  assert.ok(!JSON.stringify(rows(db).map((x) => x.band)).includes("avoid"));
  assert.equal(r["https://good.seller-fixture.dev/v1/data"].formula_version.length > 0, true);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM daily_runs").get().n, 0, "daily_runs (badge 'last checked') untouched");
  for (const p of ["/v1/score?url=https://good.seller-fixture.dev/v1/data", "/score-rules.json"]) assert.equal((await call(env, p)).status, 404, "shadow serves nothing: " + p);
  assert.ok(!(await rpc(env, "tools/list")).result.tools.some((t) => t.name === "safe_to_pay"));
  const s = await S.scoreSummary(db, "2026-11-18");
  assert.deepEqual(s.band, { good: 1, caution: 1 }); assert.deepEqual(s.internal_band, { good: 1, avoid: 1 });
  // the seed ran once for the day, a repeat does not re-queue
  assert.equal((await S.scoreSeed(env, { now: NOW })).did, "already");
});

test("shadow re-run is idempotent per day (one row per url per day) and old rows are pruned", async () => {
  const db = d1(); goodHost(db, "good.seller-fixture.dev");
  db.raw.prepare("INSERT INTO endpoint_score_daily (day, url, band, internal_band, confidence, formula_version, computed_at) VALUES ('2025-01-01', 'https://old.seller-fixture.dev/x', 'good', 'good', 'high', 'v', 'x')").run();
  const env = mkEnv({ SCORE_BAND: "shadow" }, db);
  await S.scoreTick(env, { now: NOW, deps });
  await S.scoreEndpoint(env, "https://good.seller-fixture.dev/v1/data", NOW, deps);
  const again = await S.scoreTick(env, { now: new Date(NOW.getTime() + 1200e3), deps });
  assert.equal(again.did, "drained");
  assert.equal(rows(db).length, 1); assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM endpoint_score_daily WHERE day < '2026-01-01'").get().n, 0);
});

test("a database error in the rollup fails open (no throw)", async () => {
  const env = mkEnv({ SCORE_BAND: "shadow" }, { prepare: () => { throw new Error("boom"); } });
  const r = await S.scoreTick(env, { now: NOW, deps });
  assert.ok(["db-error"].includes(r.did));
});

test("on: /v1/score is signed like a receipt, free answer has a band and no number, never says avoid, links rules and receipts", async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  _addTestKey({ kid: "test-score", x: jwk.x }); _resetSigner();
  const db = d1(); goodHost(db, "good.seller-fixture.dev"); failHost(db, "bad.seller-fixture.dev");
  const env = mkEnv({ SCORE_BAND: "on", RECEIPT_SIGNING_KEY: JSON.stringify({ kty: "OKP", crv: "Ed25519", kid: "test-score", x: jwk.x, d: jwk.d }) }, db);
  const g = await call(env, "/v1/score?url=" + encodeURIComponent("https://good.seller-fixture.dev/v1/data?x=1"));
  assert.equal(g.status, 200);
  const gb = await g.json();
  assert.equal(gb.band, "good"); assert.equal(gb.kid, "test-score");
  const sig = Uint8Array.from(atob(gb.signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, sig, signingInput(gb)));
  assert.ok(!("score" in gb) && !("raw" in gb) && !("breakdown" in gb) && !("input_ids" in gb));
  assert.match(gb.inputs_digest, /^sha256:/); assert.equal(gb.rules, "https://402xagent.com/score-rules.json"); assert.ok(gb.detail.paid_check);
  assert.ok(gb.valid_until > gb.computed_at && gb.formula_version);
  const bad = await (await call(env, "/v1/score?url=" + encodeURIComponent("https://bad.seller-fixture.dev/v1/data"))).json();
  assert.equal(bad.band, "caution"); assert.ok(bad.flags.some((f) => f.code === "failing_now"));
  assert.ok(!JSON.stringify(bad).includes("avoid"), "no public avoid label");
  const unk = await (await call(env, "/v1/score?url=" + encodeURIComponent("https://never-seen.seller-fixture.dev/x"))).json();
  assert.equal(unk.band, "unknown"); assert.equal(unk.confidence, "none");
  _resetSigner();
});

test("on: operator hosts answer operator_endpoint (ranked false); bad input gets a 400 with a fix; unknown params and POST-less abuse are rejected", async () => {
  const db = d1(); goodHost(db, "api.402xagent.com", 10);
  const env = mkEnv({ SCORE_BAND: "on" }, db);
  const op = await (await call(env, "/v1/score?url=" + encodeURIComponent("https://api.402xagent.com/v1/data"))).json();
  assert.equal(op.band, "operator_endpoint"); assert.equal(op.ranked, false);
  for (const q of ["", "?url=http://127.0.0.1/x", "?url=ftp://x.example/a", "?url=https://a.seller-fixture.dev/x&method=PUT", "?url=https://a.seller-fixture.dev/x&limit=3"]) {
    const r = await call(env, "/v1/score" + q);
    assert.equal(r.status, 400, q); assert.ok((await r.json()).error);
  }
  assert.equal((await call(env, "/v1/score?url=https://a.seller-fixture.dev/x", { method: "POST" })).status, 404);
  const rules = await (await call(env, "/score-rules.json")).json();
  assert.equal(rules.version, (await import("../worker/src/score.js")).SCORE_VERSION);
  assert.match(rules.probes, /generic client User-Agents/); assert.ok(rules.public_avoid);
});

test("on: MCP tool safe_to_pay is listed, callable, validates input, and discovery/OpenAPI advertise the route", async () => {
  const db = d1(); goodHost(db, "good.seller-fixture.dev");
  const env = mkEnv({ SCORE_BAND: "on" }, db);
  const tools = (await rpc(env, "tools/list")).result.tools;
  const t = tools.find((x) => x.name === "safe_to_pay");
  assert.ok(t && t.annotations.readOnlyHint === true && t.inputSchema.required[0] === "url");
  const ok = await rpc(env, "tools/call", { name: "safe_to_pay", arguments: { url: "https://good.seller-fixture.dev/v1/data" } });
  assert.equal(ok.result.isError, undefined);
  const body = ok.result.structuredContent || JSON.parse(ok.result.content[0].text);
  assert.equal(body.band, "good");
  const bad = await rpc(env, "tools/call", { name: "safe_to_pay", arguments: { url: "not a url" } });
  assert.equal(bad.result.isError, true);
  assert.ok(JSON.stringify(await (await call(env, "/openapi.json")).json()).includes("/v1/score"));
});

test("annotateDiscover adds band, confidence and a link from the latest daily row; unknown without one; operator hosts labelled; never avoid", async () => {
  const db = d1();
  const put = (url, day, band, internal, conf) => db.raw.prepare("INSERT INTO endpoint_score_daily (day, url, band, internal_band, confidence, formula_version, computed_at) VALUES (?, ?, ?, ?, ?, 'v', 'x')").run(day, url, band, internal, conf);
  put("https://a.seller-fixture.dev/x", "2026-11-17", "good", "good", "high");
  put("https://a.seller-fixture.dev/x", "2026-11-18", "caution", "avoid", "medium");
  put("https://old.seller-fixture.dev/x", "2026-11-01", "good", "good", "high");
  const list = [{ endpoint: "https://a.seller-fixture.dev/x" }, { endpoint: "https://old.seller-fixture.dev/x" }, { endpoint: "https://api.402xagent.com/v1/data" }, { endpoint: "https://nope.seller-fixture.dev/x" }];
  await S.annotateDiscover(mkEnv({ SCORE_BAND: "on" }, db), list, NOW);
  assert.deepEqual(list.map((r) => r.band), ["caution", "unknown", "operator_endpoint", "unknown"], "a 15-day-old row is not served");
  assert.equal(list[0].band_confidence, "medium"); assert.match(list[0].band_url, /\/v1\/score\?url=/);
  assert.ok(!JSON.stringify(list).includes("avoid"));
  const failing = mkEnv({ SCORE_BAND: "on" }, { prepare: () => { throw new Error("boom"); } });
  const l2 = [{ endpoint: "https://a.seller-fixture.dev/x" }];
  await S.annotateDiscover(failing, l2, NOW);
  assert.equal(l2[0].band, "unknown", "a read failure degrades to unknown");
});

test("SCORE_BAND shadow/on stamp probe_origin on the cron probes even without SCORE_PROBES; a caller still cannot set it", async () => {
  const hits = [];
  const f = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname.endsWith(".seller-fixture.dev")) { hits.push(init.headers && init.headers["user-agent"]); return new Response(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300 }] }), { status: 402, headers: { "content-type": "application/json" } }); }
    return f(url, init);
  };
  try {
    const db = d1(); addReceipt(db, { url: "https://s1.seller-fixture.dev/v1/data", ageH: 30, origin: null });
    db.raw.prepare("INSERT INTO daily_queue (day, url, method, host) VALUES ('2026-11-18', 'https://s1.seller-fixture.dev/v1/data', 'GET', 's1.seller-fixture.dev')").run();
    const env = mkEnv({ SCORE_BAND: "shadow", DAILY_RECHECK: undefined, CRAWL_KV: undefined }, db);
    await cron(env, 0);
    const rec = db.raw.prepare("SELECT body FROM spot_receipts WHERE check_type = 'self-checked' AND body LIKE '%\"probe_origin\":\"cron\"%'").all();
    assert.ok(hits.length >= 1 && rec.length >= 1, "the queued probe ran and was stamped");
    for (const h of hits) assert.equal(h, P.GENERIC_UAS[0], "SCORE_PROBES off: the default spot-check UA only (" + h + ")");
    const off = d1(); addReceipt(off, { url: "https://s2.seller-fixture.dev/v1/data", ageH: 30, origin: null });
    off.raw.prepare("INSERT INTO daily_queue (day, url, method, host) VALUES ('2026-11-18', 'https://s2.seller-fixture.dev/v1/data', 'GET', 's2.seller-fixture.dev')").run();
    await cron(mkEnv({ DAILY_RECHECK: undefined, CRAWL_KV: undefined }, off), 0);
    assert.equal(off.raw.prepare("SELECT COUNT(*) AS n FROM spot_receipts WHERE body LIKE '%\"probe_origin\"%'").get().n, 0, "all flags off: no stamp");
  } finally { globalThis.fetch = f; }
});
