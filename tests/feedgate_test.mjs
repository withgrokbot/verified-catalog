// 0.59.8: firehose-competitor gate (indexer UAs log-only; FEED_DENY_KEYS / FEED_DENY_PREFIXES -> 403) and the
// observe-mode false-alarm metric (feed.js falseAlarmsOf / falseAlarmStats, reported in /v1/watch/stats).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { feedDeps, INDEXER_RE, ipPrefix } from "../worker/src/lib.js";
import * as F from "../worker/src/feed.js";
import * as W from "../worker/src/watch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGS = ["0011_crawl_store.sql", "0013_watchtower.sql", "0016_hygiene.sql", "0017_settled_payments.sql", "0018_feed.sql"].map((f) => readFileSync(join(ROOT, "worker", "migrations", f), "utf8"));
function d1() {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGS) db.exec(m);
  const mk = (sql, args = []) => ({ sql, args, bind: (...a) => mk(sql, a.map((x) => (x === undefined ? null : x))),
    first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }), _run: () => db.prepare(sql).run(...args) });
  return { raw: db, prepare: (sql) => mk(sql), batch: async (st) => { for (const s of st) s._run(); return []; } };
}
const IP = "198.51.100.23";
const KEY = "fk_" + "ab".repeat(24);
const PEPPER = "test-pepper";
const env0 = (extra = {}) => ({ FEED: "1", FEED_OBSERVE: "1", RECEIPTS_DB: d1(), WATCH_PEPPER: PEPPER, CLIENT_SALT: "salt", ...extra });
async function call(env, path, { method = "GET", headers = {}, body } = {}) {
  const url = new URL("https://api.402xagent.com" + path);
  const req = new Request(url, { method, headers: { "cf-connecting-ip": IP, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const r = await F.handleFeed(req, env, url, feedDeps(env));
  return { status: r.status, j: JSON.parse((await r.text()) || "null") };
}
function captureLogs(fn) {
  const orig = console.log, lines = [];
  console.log = (s) => lines.push(String(s));
  return Promise.resolve(fn()).finally(() => { console.log = orig; }).then((v) => ({ v, lines }));
}

test("deny list is empty by default: nothing is blocked", async () => {
  const env = env0();
  assert.deepEqual([...F.feedDenyList(env).keys], []);
  assert.deepEqual([...F.feedDenyList(env).prefixes], []);
  assert.notEqual((await call(env, "/v1/feed/manifest")).status, 403);
  assert.notEqual((await call(env, "/v1/feed?category=content")).status, 403);
});

test("indexer UA (INDEXER_RE) is log-only: never blocked, one structured gate line, no UA/IP in it", async () => {
  const env = env0();
  const { v, lines } = await captureLogs(() => call(env, "/v1/feed?category=content", { headers: { "user-agent": "x402scan-indexer/1.0" } }));
  assert.equal(v.status, 200);
  const g = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((o) => o && o.feed === "gate");
  assert.equal(g.length, 1);
  assert.equal(g[0].indexer_ua, true); assert.equal(g[0].denied, null); assert.equal(g[0].path, "/v1/feed");
  assert.ok(!lines.join("\n").includes(IP) && !lines.join("\n").includes("x402scan-indexer"));
  // a normal UA writes no gate line
  const n = await captureLogs(() => call(env, "/v1/feed?category=content", { headers: { "user-agent": "curl/8" } }));
  assert.equal(n.lines.filter((l) => l.includes('"gate"')).length, 0);
  assert.ok(INDEXER_RE.test("x402scan-indexer/1.0"));
});

test("FEED_DENY_PREFIXES: 403 on every feed route, incl. manifest and POST /v1/feed/subscribe firehose", async () => {
  const env = env0({ FEED_DENY_PREFIXES: " 192.0.2.0/24 , " + ipPrefix(IP) });
  for (const p of ["/v1/feed/manifest", "/v1/feed?category=content", "/v1/feed/drift", "/v1/feed/snapshot.json"]) {
    const r = await call(env, p);
    assert.equal(r.status, 403, p); assert.equal(r.j.code, "feed_denied");
  }
  for (const tier of ["firehose", "category", "endpoint"]) {
    const r = await call(env, "/v1/feed/subscribe", { method: "POST", body: { tier, scope: "content" } });
    assert.equal(r.status, 403, tier);
  }
  // another prefix is not affected
  const other = env0({ FEED_DENY_PREFIXES: "192.0.2.0/24" });
  assert.notEqual((await call(other, "/v1/feed/manifest")).status, 403);
});

test("FEED_DENY_KEYS takes key hashes (sha256(pepper:key)), never raw keys; a denied key gets 403 incl. subscribe renewals", async () => {
  const hash = await F.sha256Hex(PEPPER + ":" + KEY);
  const env = env0({ FEED_DENY_KEYS: hash });
  const auth = { authorization: "Bearer " + KEY };
  assert.equal((await call(env, "/v1/feed?category=content", { headers: auth })).status, 403);
  assert.equal((await call(env, "/v1/feed/subscribe", { method: "POST", headers: auth, body: { tier: "firehose" } })).status, 403);
  assert.notEqual((await call(env, "/v1/feed?category=content")).status, 403); // same client without the key
  const raw = env0({ FEED_DENY_KEYS: KEY }); // raw key in the list matches nothing
  assert.notEqual((await call(raw, "/v1/feed?category=content", { headers: auth })).status, 403);
});

const H = 3600000, T = Date.parse("2026-10-20T00:00:00Z");
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const ob = (hkey, h, state, sig = "a", event = null, http = state === "up" ? 402 : 503) => ({ hkey, observed_at: iso(T + h * H), state, http_status: http, terms_sig: sig, event });

test("false-alarm metric: revert within N hours = false alarm; reproduced = held; no next row yet = pending", () => {
  const rows = [
    // h1: down at 2h, back up at 3h -> false alarm
    ob("h1", 0, "up"), ob("h1", 2, "down", null, "down"), ob("h1", 3, "up", "a", "recovery"),
    // h2: terms drift a->b at 1h, next obs at 4h still b -> held (reproduced)
    ob("h2", 0, "up"), ob("h2", 1, "up", "b", "drift"), ob("h2", 4, "up", "b"),
    // h3: drift at 10h, reverts only at 30h (outside 6 h) -> held
    ob("h3", 0, "up"), ob("h3", 10, "up", "b", "drift"), ob("h3", 30, "up", "a", "drift"),
    // h4: heartbeats only -> no candidates
    ob("h4", 0, "up"), ob("h4", 24, "up"),
  ];
  const now = T + 100 * H;
  const r = F.falseAlarmsOf(rows, now, 6);
  // candidates: h1 down, h1 recovery, h2 drift, h3 drift@10, h3 drift@30
  assert.equal(r.candidates, 5);
  assert.equal(r.false_alarms, 1);
  // h1 recovery (no next, old) held; h2 held; h3@10 held; h3@30 held
  assert.equal(r.held, 4); assert.equal(r.pending, 0);
  assert.equal(r.rate, 0.2);
  // a fresh candidate with no next observation is pending, not in the rate
  const p = F.falseAlarmsOf([ob("h5", 0, "up"), ob("h5", 99, "down", null, "down")], now, 6);
  assert.deepEqual({ c: p.candidates, p: p.pending, rate: p.rate }, { c: 1, p: 1, rate: null });
  assert.equal(F.falseAlarmsOf([], now).rate, null);
});

test("FEED_FA_HOURS widens the window; bad values fall back to 6", () => {
  assert.equal(F.faHours({}), 6); assert.equal(F.faHours({ FEED_FA_HOURS: "abc" }), 6); assert.equal(F.faHours({ FEED_FA_HOURS: "500" }), 6);
  assert.equal(F.faHours({ FEED_FA_HOURS: "24" }), 24);
  const rows = [ob("h3", 0, "up"), ob("h3", 10, "up", "b", "drift"), ob("h3", 30, "up", "a", "drift")];
  assert.equal(F.falseAlarmsOf(rows, T + 100 * H, 24).false_alarms, 1);
});

test("observe mode (FEED=observe) computes it from feed_observations and /v1/watch/stats reports feed_false_alarms", async () => {
  const env = { FEED: "observe", RECEIPTS_DB: d1() };
  const db = env.RECEIPTS_DB.raw;
  const ins = db.prepare("INSERT INTO feed_observations (hkey, observed_at, src, state, http_status, terms_sig, event) VALUES (?, ?, 'w', ?, ?, ?, ?)");
  const now = new Date(T + 48 * H);
  for (const o of [ob("h1", 20, "up"), ob("h1", 22, "down", null, "down"), ob("h1", 23, "up", "a", "recovery")]) ins.run(o.hkey, o.observed_at, o.state, o.http_status, o.terms_sig, o.event);
  const s = await F.falseAlarmStats(env, now);
  assert.equal(s.mode, "observe"); assert.equal(s.revert_hours, 6); assert.equal(s.observations, 3);
  assert.equal(s.false_alarms, 1); assert.equal(s.held, 1); assert.equal(s.rate, 0.5);
  assert.match(s.definition, /next observation within revert_hours/);
  const st = await W.stats(env, now);
  assert.equal(st.feed_false_alarms.false_alarms, 1);
  // feed off: zeros, rate null, no query
  const off = await F.falseAlarmStats({ RECEIPTS_DB: env.RECEIPTS_DB }, now);
  assert.deepEqual([off.mode, off.candidates, off.rate], ["off", 0, null]);
});

test("wrangler.toml keeps FEED = \"observe\" (0.59.8 changes no flag)", () => {
  const toml = readFileSync(join(ROOT, "worker", "wrangler.toml"), "utf8");
  assert.match(toml, /^FEED = "observe"/m);
  assert.doesNotMatch(toml, /^FEED_DENY_(KEYS|PREFIXES) = "[^"]+"/m);
});
