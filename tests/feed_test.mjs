// 0.52.0 Watchtower drift & liveness feed tests. Real SQLite (node:sqlite) runs migrations 0011, 0013, 0016, 0017 and 0018
// behind a tiny D1 adapter; the facilitator is stubbed. All data is synthetic. Run: npx -y -p node@22 node tests/feed_test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { feedDeps } from "../worker/src/lib.js";
import * as S from "../worker/src/sign.js";
import * as W from "../worker/src/watch.js";
import * as F from "../worker/src/feed.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mig = (f) => readFileSync(join(ROOT, "worker", "migrations", f), "utf8");
const MIGS = ["0011_crawl_store.sql", "0013_watchtower.sql", "0016_hygiene.sql", "0017_settled_payments.sql", "0018_feed.sql"].map(mig);
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
const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "test-feed-key" };
S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();

// synthetic secrets that must never appear in any feed output
const BUYER = "0x" + "b1".repeat(20);
const TX = "0x" + "c7".repeat(32);
const IP = "198.51.100.23";
const HOOK = "https://hooks.leak-fixture.example/very-secret-path";
const SELLER = "0x" + "aa".repeat(20);
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const T0 = Date.parse("2026-10-20T12:00:00Z");
const H = 3600000;
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

function setup(extra = {}) {
  const env = { FEED: "1", FEED_OBSERVE: "1", WATCHTOWER: "1", RECEIPTS_DB: d1(), WATCH_PEPPER: "test-pepper", CLIENT_SALT: "salt", RECEIPT_SIGNING_KEY: JSON.stringify(jwk), ...extra };
  const settled = [];
  let clock = T0 + 72 * H;
  const deps = () => ({ ...feedDeps(env), now: () => new Date(clock),
    verifyAndSettle: async (c, payload, url) => { settled.push({ amount: c.priceAtomic, network: c.network, url }); return { ok: true, settle: { success: true, transaction: TX, payer: BUYER, network: c.network } }; } });
  const outputs = [];
  const call = async (path, init = {}) => {
    const url = new URL("https://api.402xagent.com" + path);
    const req = new Request(url, { method: init.method || "GET", headers: { "cf-connecting-ip": IP, ...(init.headers || {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    const r = await F.handleFeed(req, env, url, deps());
    const text = await r.text();
    outputs.push(text + "\n" + [...r.headers].map(([k, v]) => k + ": " + v).join("\n") + "\n" + [...r.headers].filter(([k]) => /payment/.test(k)).map(([, v]) => { try { return atob(v); } catch (_) { return v; } }).join("\n"));
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { status: r.status, headers: r.headers, text, j };
  };
  const payHdr = (k) => {
    const c = F.feedCfg(env, feedDeps(env), k);
    return { "payment-signature": btoa(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: c.network, amount: c.priceAtomic, asset: c.asset, payTo: c.payTo }, payload: { signature: "0x00", authorization: { from: BUYER, to: c.payTo, value: c.priceAtomic, nonce: TX } } })) };
  };
  return { env, db: env.RECEIPTS_DB, call, payHdr, settled, outputs, setClock: (t) => { clock = t; }, now: () => clock };
}
async function seedCrawl(db, n, at, extra = {}, tag = "") {
  for (let i = 0; i < n; i++) {
    const url = `https://api${tag}${i % 7}.fixture-sellers.example/v1/${["price", "search", "chat", "video", "rpc", "misc"][i % 6]}/${i}`;
    const pu = F.publicUrl(url);
    const t = { network: "eip155:8453", asset: USDC_BASE, pay_to: SELLER, amount_atomic: String(10000 + i) };
    const ep = { hkey: await F.feedKey(url), ...pu, method: "GET", category: F.categoryOf({ url }), crawl_known: 1, watch_opt_in: 0 };
    await db.batch(F.observationStatements(db, ep, { observed_at: iso(at), src: "c", state: "up", http_status: 402, ...t, price_usd: F.priceUsdOf(t.amount_atomic, t.asset), terms_sig: await F.termsSig(t), event: null, ...extra }));
  }
}
// private data in every sensitive table: the feed must never read or echo any of it
async function seedPrivate(db) {
  const raw = db.raw;
  raw.prepare("INSERT INTO watches (id, secret_hash, url, method, hkey, webhook_url, webhook_hash, webhook_domain_hash, ip_hash, status, created_at, paid_until, period_start, next_probe_at, baseline_json, baseline_sig, baseline_at) VALUES (?, ?, ?, 'GET', ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)")
    .run("wt-00000000000000aa", "secrethash-" + "e".repeat(40), "https://private-endpoint.leak-fixture.example/hidden", "watchhkey-" + "f".repeat(40), HOOK, "webhookhash-" + "9".repeat(40), "domhash-" + "8".repeat(40), "iphash-" + "7".repeat(40), iso(T0), iso(T0 + 30 * 24 * H), iso(T0), iso(T0), JSON.stringify({ paywall: true }), "sha256:x", iso(T0));
  raw.prepare("INSERT INTO watch_events (id, watch_id, type, created_at, payload) VALUES ('wr-00000000000000aa', 'wt-00000000000000aa', 'receipt', ?, ?)").run(iso(T0), JSON.stringify({ payer: BUYER, transaction: TX, ip: IP }));
  raw.prepare("INSERT INTO settled_payments (key, resource, amount, settle, facilitator, created_at) VALUES (?, ?, '10000', ?, 'payai', ?)").run("st-" + "1".repeat(64), "https://api.402xagent.com/v1/feed", JSON.stringify({ transaction: TX, payer: BUYER }), iso(T0));
  raw.prepare("INSERT INTO hygiene_quota (day, pkey, n) VALUES ('2026-10-20', 'pk-hyg', 1)").run();
  raw.prepare("INSERT INTO trial_claims (key_hash, kind, n, claimed_at) VALUES ('trial-" + "6".repeat(40) + "', 'domain', 1, ?)").run(iso(T0));
}
const probeOf = (amount, payTo = SELLER, status = 402) => ({ reachable: true, http_status: status, paywall: status === 402, x402_version: 2, schemes: ["exact"], terms: status === 402 ? { network: "eip155:8453", asset: USDC_BASE, payTo, amount } : null });
async function addWatch(db, id, url, optIn) {
  const base = W.baselineOf(probeOf("10000"));
  db.raw.prepare("INSERT INTO watches (id, secret_hash, url, method, hkey, webhook_url, webhook_hash, webhook_domain_hash, ip_hash, status, created_at, paid_until, period_start, next_probe_at, baseline_json, baseline_sig, baseline_at, feed_opt_in) VALUES (?, ?, ?, 'GET', ?, ?, 'wh', 'dh', 'ih', 'active', ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, await W.sha256Hex("test-pepper:wts_" + "1".repeat(48)), url, "hk-" + id, HOOK, iso(T0), iso(T0 + 30 * 24 * H), iso(T0), iso(T0), JSON.stringify(base), await W.sigOf(base), iso(T0), optIn ? 1 : 0);
}
const watchRow = (db, id) => db.raw.prepare("SELECT id, url, method, webhook_url, status, paused_reason, state, fail_streak, ok_streak, pending_sig, pending_count, was_paused, quiet_until, baseline_json, baseline_sig, last_event_id, fail_days, fail_day, ok_day, consecutive_failed, paid_until, feed_opt_in FROM watches WHERE id = ?").get(id);

test("migration 0018 applies on a local D1 with the four feed tables + watches.feed_opt_in", () => {
  const { db } = setup();
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'feed_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ["feed_endpoints", "feed_keys", "feed_observations", "feed_quota"]);
  assert.ok(db.raw.prepare("PRAGMA table_info(watches)").all().some((c) => c.name === "feed_opt_in" && c.dflt_value === "0"));
  const obsCols = db.raw.prepare("PRAGMA table_info(feed_observations)").all().map((c) => c.name);
  for (const bad of ["webhook_url", "ip_hash", "payer", "transaction", "tx_hash"]) assert.ok(!obsCols.includes(bad));
});

test("categories: fixed set, mapped from URL/source-list fields only", () => {
  assert.deepEqual(F.FEED_CATEGORIES, ["search/data", "inference", "crypto-market", "content", "infra", "other"]);
  assert.equal(F.categoryOf({ url: "https://x.example/v1/price/btc" }), "crypto-market");
  assert.equal(F.categoryOf({ url: "https://x.example/v1/chat/completions" }), "inference");
  assert.equal(F.categoryOf({ url: "https://x.example/api/search" }), "search/data");
  assert.equal(F.categoryOf({ url: "https://x.example/api/video/42" }), "content");
  assert.equal(F.categoryOf({ url: "https://x.example/rpc" }), "infra");
  assert.equal(F.categoryOf({ url: "https://x.example/zzz" }), "other");
  assert.equal(F.categoryOf({ url: "https://x.example/zzz", source_list: "weather-feeds" }), "search/data");
});

test("drift computation against fixtures (diffTerms / eventOf)", async () => {
  const a = { state: "up", network: "eip155:8453", asset: USDC_BASE, pay_to: SELLER, amount_atomic: "10000" };
  const b = { ...a, amount_atomic: "20000", pay_to: "0x" + "bb".repeat(20) };
  a.terms_sig = await F.termsSig(a); b.terms_sig = await F.termsSig(b);
  assert.deepEqual(F.diffTerms(a, b), [{ field: "pay_to", from: SELLER, to: "0x" + "bb".repeat(20) }, { field: "amount_atomic", from: "10000", to: "20000" }]);
  assert.equal(F.eventOf(a, b).event, "drift");
  assert.equal(F.eventOf(a, { ...a }).event, null);
  assert.equal(F.eventOf(a, { ...a, state: "down" }).event, "down");
  assert.equal(F.eventOf({ ...a, state: "down" }, a).event, "recovery");
  assert.equal(F.eventOf(null, a).event, null);
  const crawl = { state: "up", network: "eip155:8453", asset: USDC_BASE, pay_to: null, amount_atomic: null };
  crawl.terms_sig = await F.termsSig(crawl);
  assert.equal(F.eventOf(crawl, a).event, null); // a field the crawl never recorded is not drift
  assert.equal(await F.termsSig({ network: "eip155:8453", asset: USDC_BASE, payTo: SELLER.toUpperCase().replace("0X", "0x"), amount: 10000 }), a.terms_sig);
});

test("stepWatch writes hourly observations only for opted-in watches; drift event carries allowlisted changes", async () => {
  const s = setup();
  await addWatch(s.db, "wt-000000000000000a", "https://opted.fixture-sellers.example/v1/price?apikey=SECRET", true);
  await addWatch(s.db, "wt-000000000000000b", "https://private.fixture-sellers.example/v1/hidden", false);
  for (let h = 0; h < 3; h++) for (const id of ["wt-000000000000000a", "wt-000000000000000b"]) await W.stepWatch(s.env, watchRow(s.db, id), probeOf(h === 0 ? "10000" : "30000"), new Date(T0 + h * H));
  const eps = s.db.raw.prepare("SELECT * FROM feed_endpoints").all();
  assert.equal(eps.length, 1);
  assert.equal(eps[0].url, "https://opted.fixture-sellers.example/v1/price");
  assert.equal(eps[0].category, "crypto-market");
  const obs = s.db.raw.prepare("SELECT * FROM feed_observations ORDER BY observed_at").all();
  assert.equal(obs.length, 3);
  assert.deepEqual(obs.map((o) => o.event), [null, null, "drift"]); // two consecutive changed probes confirm drift (watch rule)
  assert.deepEqual(JSON.parse(obs[2].changes), [{ field: "amount_atomic", from: "10000", to: "30000" }]);
  assert.equal(eps[0].amount_atomic, "30000");
  // FEED_OBSERVE off: no feed writes, and the tick never selects feed_opt_in (works before 0018 is applied)
  const off = setup({ FEED_OBSERVE: "" });
  await addWatch(off.db, "wt-000000000000000c", "https://opted.fixture-sellers.example/v1/price", true);
  await W.stepWatch(off.env, watchRow(off.db, "wt-000000000000000c"), probeOf("10000"), new Date(T0));
  assert.equal(off.db.raw.prepare("SELECT COUNT(*) AS n FROM feed_observations").get().n, 0);
});

test("opt-in toggle: POST /v1/watch/{id}/feed (Bearer); opting out removes watch-only rows", async () => {
  const s = setup();
  await addWatch(s.db, "wt-000000000000000d", "https://toggle.fixture-sellers.example/v1/search", true);
  await W.stepWatch(s.env, watchRow(s.db, "wt-000000000000000d"), probeOf("10000"), new Date(T0));
  assert.equal(s.db.raw.prepare("SELECT COUNT(*) AS n FROM feed_endpoints").get().n, 1);
  const url = new URL("https://api.402xagent.com/v1/watch/wt-000000000000000d/feed");
  const r = await W.handleWatch(new Request(url, { method: "POST", headers: { authorization: "Bearer wts_" + "1".repeat(48), "content-type": "application/json" }, body: JSON.stringify({ opt_in: false }) }), s.env, null, url, { ...feedDeps(s.env), cfg: {}, now: () => new Date(T0) });
  assert.equal(r.status, 200);
  assert.equal(s.db.raw.prepare("SELECT feed_opt_in FROM watches WHERE id = 'wt-000000000000000d'").get().feed_opt_in, 0);
  assert.equal(s.db.raw.prepare("SELECT COUNT(*) AS n FROM feed_endpoints").get().n, 0);
  assert.equal(s.db.raw.prepare("SELECT COUNT(*) AS n FROM feed_observations").get().n, 0);
});

test("tier gating: free is 24 h delayed and capped at 100 rows; live=1 without payment is a 402 on Base Sepolia", async () => {
  const s = setup();
  await seedCrawl(s.db, 150, T0);
  await F.buildSnapshot(s.env, new Date(T0 + H)); // snapshot 71 h old at "now"
  await seedCrawl(s.db, 3, s.now() - H, {}); // fresh rows (1 h old): not in the free tier
  const fr = await s.call("/v1/feed");
  assert.equal(fr.status, 200);
  assert.equal(fr.j.access, "free");
  assert.equal(fr.j.delayed_hours, 24);
  assert.equal(fr.j.count, 100);
  assert.equal(fr.j.total, 150);
  assert.equal(fr.j.next_offset, 100);
  assert.ok(fr.j.rows.every((r) => r.observed_at <= iso(s.now() - 24 * H)));
  assert.deepEqual(Object.keys(fr.j.rows[0]), [...F.FEED_COLUMNS]);
  assert.equal((await s.call("/v1/feed?limit=500")).j.count, 100);
  assert.equal((await s.call("/v1/feed?category=crypto-market")).j.rows.every((r) => r.category === "crypto-market"), true);
  assert.equal((await s.call("/v1/feed?category=nope")).status, 400);
  const p = await s.call("/v1/feed?live=1");
  assert.equal(p.status, 402);
  assert.equal(p.j.x402Version, 2);
  assert.equal(p.j.accepts[0].network, "eip155:84532");
  assert.equal(p.j.accepts[0].amount, "10000");
  assert.equal(p.j.accepts[0].asset.toLowerCase(), "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  assert.equal(p.j.testnet, true);
  assert.ok(p.headers.get("payment-required"));
  const d = await s.call("/v1/feed/drift?full=1");
  assert.equal(d.status, 402);
  assert.equal(d.j.accepts[0].amount, "50000");
  // mainnet only behind FEED_MAINNET=1
  const m = setup({ FEED_MAINNET: "1" });
  assert.equal((await m.call("/v1/feed?live=1")).j.accepts[0].network, "eip155:8453");
});

test("paid per call: $0.01 real-time feed (<= 1000 rows, includes fresh rows); PAYMENT-RESPONSE has no tx hash or payer", async () => {
  const s = setup();
  await seedCrawl(s.db, 20, s.now() - H);
  const r = await s.call("/v1/feed?live=1", { headers: s.payHdr("call") });
  assert.equal(r.status, 200);
  assert.equal(r.j.access, "paid");
  assert.equal(r.j.count, 20);
  assert.deepEqual(s.settled.map((x) => [x.amount, x.network]), [["10000", "eip155:84532"]]);
  const pr = JSON.parse(atob(r.headers.get("payment-response")));
  assert.deepEqual(pr, { success: true, network: "eip155:84532" });
  const hk = r.j.rows[0].hkey;
  const one = await s.call("/v1/feed/endpoint/" + hk + "?live=1", { headers: s.payHdr("call") });
  assert.equal(one.status, 200);
  assert.equal(one.j.observations.length, 1);
  const freeOne = await s.call("/v1/feed/endpoint/" + hk);
  assert.equal(freeOne.j.endpoint, null); // nothing 24 h old yet
  assert.equal(freeOne.j.observations.length, 0);
  // wrong amount is refused before any facilitator call
  const bad = await s.call("/v1/feed/drift?full=1", { headers: s.payHdr("call") });
  assert.equal(bad.status, 402);
  assert.match(bad.j.error, /amount does not match/);
  assert.equal(s.settled.length, 2);
});

test("drift history: free 7 days and 24 h delayed; paid $0.05 full history", async () => {
  const s = setup();
  const now = s.now();
  for (const [ago, amt] of [[30 * 24, "1"], [5 * 24, "2"], [2 * 24, "3"], [2, "4"]]) {
    await seedCrawl(s.db, 1, now - ago * H, { amount_atomic: amt, terms_sig: "sha256:" + amt, event: "drift", changes: [{ field: "amount_atomic", from: "0", to: amt }] });
  }
  const f = await s.call("/v1/feed/drift");
  assert.equal(f.status, 200);
  assert.deepEqual(f.j.events.map((e) => e.changes[0].to), ["3", "2"]);
  assert.deepEqual(Object.keys(f.j.events[0]), [...F.EVENT_COLUMNS]);
  const p = await s.call("/v1/feed/drift?full=1", { headers: s.payHdr("drift") });
  assert.equal(p.status, 200);
  assert.deepEqual(p.j.events.map((e) => e.changes[0].to), ["4", "3", "2", "1"]);
  const rng = await s.call("/v1/feed/drift?full=1&from=" + iso(now - 6 * 24 * H) + "&to=" + iso(now - 24 * H), { headers: s.payHdr("drift") });
  assert.deepEqual(rng.j.events.map((e) => e.changes[0].to), ["3", "2"]);
});

test("subscriptions: $1 endpoint / $10 category / $49 firehose keys, shown once, stored hashed, scoped", async () => {
  const s = setup();
  await seedCrawl(s.db, 12, s.now() - H);
  const info = await s.call("/v1/feed/subscribe");
  assert.equal(info.status, 402);
  assert.deepEqual(info.j.tiers, { endpoint: "1.00", category: "10.00", firehose: "49.00" });
  const need = await s.call("/v1/feed/subscribe", { method: "POST", body: { tier: "category", scope: "inference" } });
  assert.equal(need.status, 402);
  assert.equal(need.j.accepts[0].amount, "10000000");
  const sub = await s.call("/v1/feed/subscribe", { method: "POST", body: { tier: "category", scope: "inference" }, headers: s.payHdr("category") });
  assert.equal(sub.status, 201);
  assert.match(sub.j.feed_key, /^fk_[0-9a-f]{48}$/);
  const stored = s.db.raw.prepare("SELECT * FROM feed_keys").all();
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].key_hash, sub.j.feed_key);
  assert.ok(!JSON.stringify(stored).includes(sub.j.feed_key));
  const auth = { authorization: "Bearer " + sub.j.feed_key };
  const live = await s.call("/v1/feed", { headers: auth });
  assert.equal(live.j.access, "key");
  assert.ok(live.j.count > 0 && live.j.rows.every((r) => r.category === "inference"));
  const other = live.j.rows.length ? (await s.call("/v1/feed?live=1", { headers: s.payHdr("call") })).j.rows.find((r) => r.category !== "inference") : null;
  assert.equal((await s.call("/v1/feed/endpoint/" + other.hkey, { headers: auth })).status, 403);
  const fh = await s.call("/v1/feed/subscribe", { method: "POST", body: { tier: "firehose" } });
  assert.equal(fh.j.accepts[0].amount, "49000000");
  const ep = await s.call("/v1/feed/subscribe", { method: "POST", body: { tier: "endpoint", scope: other.hkey } });
  assert.equal(ep.j.accepts[0].amount, "1000000");
  const renew = await s.call("/v1/feed/subscribe", { method: "POST", body: { tier: "category", scope: "inference" }, headers: { ...auth, ...s.payHdr("category") } });
  assert.equal(renew.j.renewed, true);
  assert.equal(s.db.raw.prepare("SELECT periods FROM feed_keys").get().periods, 2);
  s.setClock(s.now() + 90 * 24 * H);
  assert.equal((await s.call("/v1/feed", { headers: auth })).status, 402); // expired key
});

test("snapshot: CSV/JSON parity and a verifiable Ed25519 signature over csv_sha256; firehose gets the latest", async () => {
  const s = setup();
  await seedCrawl(s.db, 30, T0);
  await F.buildSnapshot(s.env, new Date(T0 + H));
  await seedCrawl(s.db, 2, s.now() - 2 * H, {}, "new");
  await F.buildSnapshot(s.env, new Date(s.now() - H));
  const j = await s.call("/v1/feed/snapshot.json");
  const c = await s.call("/v1/feed/snapshot.csv");
  assert.equal(j.status, 200); assert.equal(c.status, 200);
  assert.equal(j.j.rows.length, 30); // free: the snapshot at least 24 h old
  assert.equal(c.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(F.toCsv(j.j.rows), c.text);
  const parsed = F.parseCsv(c.text);
  assert.deepEqual(parsed[0], [...F.FEED_COLUMNS]);
  assert.equal(parsed.length - 1, j.j.rows.length);
  assert.deepEqual(parsed.slice(1).map((r) => r[0]), j.j.rows.map((r) => r.hkey));
  const h = j.j.header;
  assert.equal(h.csv_sha256, await F.sha256Hex(c.text));
  assert.equal(c.headers.get("x-feed-csv-sha256"), h.csv_sha256);
  const k = S.receiptKeysDoc().keys.find((x) => x.kid === h.kid);
  const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: k.x }, { name: "Ed25519" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(h.signature.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
  assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, S.signingInput(h)));
  assert.ok(!(await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, S.signingInput({ ...h, count: 31 }))));
  // firehose key: today's snapshot (32 rows)
  const sub = await s.call("/v1/feed/subscribe", { method: "POST", body: { tier: "firehose" }, headers: s.payHdr("firehose") });
  const fj = await s.call("/v1/feed/snapshot.json", { headers: { authorization: "Bearer " + sub.j.feed_key } });
  assert.equal(fj.j.rows.length, 32);
  assert.equal(fj.j.delayed, false);
  // keeps the newest 3 snapshots
  for (let d = 1; d <= 4; d++) await F.buildSnapshot(s.env, new Date(s.now() + d * 24 * H));
  assert.equal(s.db.raw.prepare("SELECT COUNT(DISTINCT key) AS n FROM crawl_store WHERE source = 'feed'").get().n, 3);
});

test("free quota: 200 calls per UTC day per network (hashed prefix, no raw IP stored), then 429", async () => {
  const s = setup();
  for (let i = 0; i < F.FEED_FREE_PER_DAY; i++) assert.equal((await s.call("/v1/feed/drift")).status, 200);
  const r = await s.call("/v1/feed/drift");
  assert.equal(r.status, 429);
  const q = s.db.raw.prepare("SELECT * FROM feed_quota").all();
  assert.equal(q.length, 1);
  assert.ok(!JSON.stringify(q).includes("198.51.100"));
  assert.equal((await s.call("/v1/feed/manifest")).status, 200); // manifest is not metered
});

test("pruning: observations older than 400 days are deleted on the daily cron; snapshot is rebuilt", async () => {
  const s = setup();
  await seedCrawl(s.db, 1, s.now() - 401 * 24 * H);
  await seedCrawl(s.db, 1, s.now() - 399 * 24 * H, {}, "b");
  s.db.raw.prepare("INSERT INTO feed_quota (day, pkey, n) VALUES ('2020-01-01', 'old', 1)").run();
  const r = await F.feedDaily(s.env, new Date(s.now()));
  assert.equal(r.pruned.observations, 1);
  assert.equal(s.db.raw.prepare("SELECT COUNT(*) AS n FROM feed_observations").get().n, 1);
  assert.equal(s.db.raw.prepare("SELECT COUNT(*) AS n FROM feed_quota").get().n, 0);
  assert.equal(r.snapshot.count, 2);
  assert.deepEqual(await F.feedDaily({ RECEIPTS_DB: s.db }, new Date()), { did: "off" });
});

test("manifest: schema, tiers ($0.01 / $0.05 / $1 / $10 / $49), Base Sepolia, signing kid; no stable badge", async () => {
  const s = setup();
  const m = (await s.call("/v1/feed/manifest")).j;
  assert.equal(m.kid, "test-feed-key");
  assert.ok(m.signature);
  assert.deepEqual(Object.fromEntries(Object.entries(m.paid).map(([k, v]) => [k, v.price_usd])), { call: "0.01", drift: "0.05", endpoint: "1.00", category: "10.00", firehose: "49.00" });
  assert.equal(m.payment.network, "eip155:84532");
  assert.deepEqual(m.categories, [...F.FEED_CATEGORIES]);
  assert.ok(!/stable[ _-]?30/i.test(JSON.stringify(m)));
});

test("routing: worker.fetch serves /v1/feed only when FEED=1", async () => {
  const off = await worker.fetch(new Request("https://api.402xagent.com/v1/feed/manifest"), { RECEIPTS_DB: d1() }, { waitUntil() {} });
  assert.equal(off.status, 404);
  const s = setup();
  const on = await worker.fetch(new Request("https://api.402xagent.com/v1/feed/manifest"), s.env, { waitUntil() {} });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).schema, "feed.v1");
});

test("privacy leak scan: no buyer wallet, tx hash, proof, IP, webhook URL/hash, secret, receipt or score in any output", async () => {
  const s = setup();
  await seedPrivate(s.db);
  await addWatch(s.db, "wt-00000000000000bb", "https://not-opted.leak-fixture.example/private", false);
  await addWatch(s.db, "wt-00000000000000cc", "https://opted.leak-fixture.example/v1/data?token=QUERYSECRET", true);
  for (let h = 0; h < 30; h++) for (const id of ["wt-00000000000000bb", "wt-00000000000000cc"]) await W.stepWatch(s.env, watchRow(s.db, id), probeOf(h < 10 ? "10000" : "20000", h < 20 ? SELLER : "0x" + "ab".repeat(20)), new Date(T0 + h * H));
  await seedCrawl(s.db, 10, T0);
  await F.buildSnapshot(s.env, new Date(T0 + 40 * H));
  const sub = await s.call("/v1/feed/subscribe", { method: "POST", body: { tier: "firehose" }, headers: s.payHdr("firehose") });
  const auth = { authorization: "Bearer " + sub.j.feed_key };
  const hk = await F.feedKey("https://opted.leak-fixture.example/v1/data");
  const paths = ["/v1/feed", "/v1/feed?live=1", "/v1/feed/endpoint/" + hk, "/v1/feed/endpoint/" + hk + "?live=1", "/v1/feed/drift", "/v1/feed/drift?full=1", "/v1/feed/snapshot.json", "/v1/feed/snapshot.csv", "/v1/feed/manifest", "/v1/feed/subscribe"];
  for (const p of paths) {
    await s.call(p);
    await s.call(p, { headers: auth });
    if (/live=1/.test(p)) await s.call(p, { headers: s.payHdr("call") });
    if (/full=1/.test(p)) await s.call(p, { headers: s.payHdr("drift") });
  }
  const all = s.outputs.join("\n");
  assert.ok(all.includes("opted.leak-fixture.example/v1/data"), "the opted-in watch is in the feed");
  assert.ok(/"event": "drift"/.test(all), "drift events are present");
  const forbidden = [BUYER, TX, IP, HOOK, "hooks.leak-fixture.example", "not-opted.leak-fixture.example", "private-endpoint.leak-fixture", "QUERYSECRET", "token=", "secrethash-", "webhookhash-", "iphash-", "domhash-", "trial-666", "st-1111", "wr-00000000000000aa", "wt-00000000000000", "pk-hyg", "settled_payments", "webhook", "secret_hash", "ip_hash"];
  for (const f of forbidden) assert.ok(!all.toLowerCase().includes(f.toLowerCase()), "leaked: " + f);
  assert.ok(!/0x[0-9a-f]{64}/i.test(all), "a 64-hex tx hash / proof appears");
  assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(all.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "")), "an IPv4 address appears");
  const c = F.feedCfg(s.env, feedDeps(s.env), "call");
  const allowed = new Set([SELLER, "0x" + "ab".repeat(20), USDC_BASE, c.payTo.toLowerCase(), c.asset.toLowerCase()]);
  for (const a of all.toLowerCase().match(/0x[0-9a-f]{40}\b/g) || []) assert.ok(allowed.has(a), "unexpected address " + a);
  for (const k of ["score", "grade", "rating", "rank", "quality", "stable_for"]) assert.ok(!new RegExp('"' + k + '[a-z_]*"\\s*:', "i").test(all), "judgement field in output: " + k);
  assert.ok(!all.includes(sub.j.feed_key.slice(3)) || s.outputs.filter((o) => o.includes(sub.j.feed_key)).length === 1, "feed key echoed after creation");
});
