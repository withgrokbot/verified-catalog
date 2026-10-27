// 0.54.0 terms freshness (worker/src/freshness.js): unit rules, the opt-in &quote= live-check path, and the read-time
// freshness on catalog/crawl surfaces. Real SQLite (node:sqlite) with every migration behind a tiny D1 adapter; seller
// fetches are stubbed. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { summarize, caip, sameAddr, loadQuote } from "../worker/src/lib.js";
import { receiptIdFor, _clearCrawlStoreCache, skipsSummary } from "../worker/src/skips.js";
import * as F from "../worker/src/freshness.js";
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
const SELLER_URL = "https://api.freshfixture.dev/v1/data";
const OTHER_URL = "https://api.freshfixture.dev/v1/other";
const PAY_TO = "0x" + "bb".repeat(20);
const PAY_TO_2 = "0x" + "cc".repeat(20);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const seller = { amount: "1000", payTo: PAY_TO };

const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://cloudflare-dns.com/dns-query")) {
    const type = new URL(u).searchParams.get("type") || "A";
    return Response.json(type === "A" ? { Answer: [{ type: 1, data: "93.184.216.34" }] } : { Answer: [] });
  }
  if (u.startsWith("https://api.freshfixture.dev/")) {
    const accepts = [{ scheme: "exact", network: "eip155:8453", amount: seller.amount, asset: USDC, payTo: seller.payTo, maxTimeoutSeconds: 300 }];
    const body = { x402Version: 2, error: "Payment required", resource: { url: u }, accepts };
    return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "payment-required": btoa(JSON.stringify(body)) } });
  }
  return new Response("not stubbed: " + u, { status: 599 });
};
const noKv = { get: async () => null, put: async () => { throw new Error("0.54.0 must not write KV"); }, delete: async () => { throw new Error("no KV deletes"); } };
const envFor = (db) => ({ RECEIPTS_DB: db, CLIENT_SALT: "salt", SPOT_PROBE_CACHE_S: "0", CRAWL_KV: noKv, SPOT_KV: noKv });
let ipN = 10;
async function call(env, path, accept = "application/json") {
  const r = await worker.fetch(new Request("https://api.402xagent.com" + path, { headers: { accept, "cf-connecting-ip": "203.0.113." + ipN++ } }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const check = (env, url, extra = "") => call(env, "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(url) + "&claimed_price=0.001&pay_to=" + PAY_TO + extra);
const reset = () => { seller.amount = "1000"; seller.payTo = PAY_TO; };

async function addCrawlReceipt(db, rec) {
  const key = "c:" + rec.id.slice(0, 2);
  const text = JSON.stringify({ [rec.id]: rec });
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  db.raw.prepare("INSERT OR REPLACE INTO crawl_store (key, part, parts, sha256, value, source, updated_at) VALUES (?, 0, 1, ?, ?, 'test', ?)").run(key, sha, text, iso(Date.now()));
  _clearCrawlStoreCache();
}
const h = { caip, sameAddr };

test("termsMaxAgeHours: default 24, positive numbers up to a year, anything else falls back", () => {
  assert.equal(F.termsMaxAgeHours({}), 24);
  assert.equal(F.termsMaxAgeHours(undefined), 24);
  assert.equal(F.termsMaxAgeHours({ TERMS_MAX_AGE_HOURS: "168" }), 168);
  assert.equal(F.termsMaxAgeHours({ TERMS_MAX_AGE_HOURS: " 6.5 " }), 6.5);
  for (const bad of ["0", "-1", "abc", "1e9", "", "Infinity"]) assert.equal(F.termsMaxAgeHours({ TERMS_MAX_AGE_HOURS: bad }), 24, bad);
});

test("freshnessFor: only a pay past the limit becomes effective recheck/terms_stale; unknown age counts as stale", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const fresh = F.freshnessFor("pay", "2026-10-27T00:00:00Z", 24, now);
  assert.deepEqual(fresh, { terms_checked_at: "2026-10-27T00:00:00Z", terms_age_hours: 12, terms_max_age_hours: 24, terms_stale: false, effective_verdict: "pay" });
  const old = F.freshnessFor("pay", "2026-10-26T11:00:00Z", 24, now);
  assert.equal(old.terms_stale, true); assert.equal(old.effective_verdict, "recheck"); assert.equal(old.effective_reason_code, "terms_stale"); assert.match(old.effective_reason, /24 h/);
  assert.equal(F.freshnessFor("skip", "2026-10-01T00:00:00Z", 24, now).effective_verdict, "skip");
  assert.equal(F.freshnessFor("recheck", "2026-10-01T00:00:00Z", 24, now).effective_verdict, "recheck");
  const none = F.freshnessFor("pay", null, 24, now);
  assert.equal(none.terms_age_hours, null); assert.equal(none.effective_verdict, "recheck");
  assert.equal(F.freshnessFor("pay", "2026-10-26T11:00:00Z", 168, now).effective_verdict, "pay");
});

test("quoteDiff/applyQuote: price, pay_to, network, asset; only a would-be pay changes; missing fields are not compared", () => {
  const pm = { network: "eip155:8453", asset: USDC, amount_atomic: "1000", amount_usd: 0.001, pay_to: PAY_TO };
  const q = { amount_atomic: "1000", price_usd: 0.001, pay_to: PAY_TO.toUpperCase().replace("0X", "0x"), network: "base", asset: USDC.toLowerCase() };
  assert.deepEqual(F.quoteDiff(q, pm, h), [], "EVM case and v1 network alias are the same terms");
  assert.deepEqual(F.quoteDiff({ ...q, amount_atomic: "2000" }, pm, h), ["price"]);
  assert.deepEqual(F.quoteDiff({ ...q, amount_atomic: null, price_usd: 0.002 }, pm, h), ["price"]);
  assert.deepEqual(F.quoteDiff({ ...q, pay_to: PAY_TO_2, network: "eip155:137", asset: "0x" + "dd".repeat(20) }, pm, h), ["pay_to", "network", "asset"]);
  assert.deepEqual(F.quoteDiff({ pay_to: PAY_TO }, pm, h), []);
  const pay = { verdict: "pay", reason: "price_ok" };
  const ok = { id: "sc-0123456789abcdef", kind: "live", quoted_at: "2026-10-27T00:00:00Z", status: "ok", terms: q };
  assert.equal(F.applyQuote(pay, null, pm, h).quote_check, null);
  assert.deepEqual(F.applyQuote(pay, ok, pm, h), { d: pay, quote_check: { quote_id: ok.id, quote_type: "live", quoted_at: ok.quoted_at, status: "match", fields_changed: [] } });
  const ch = F.applyQuote(pay, { ...ok, terms: { ...q, amount_atomic: "5000" } }, pm, h);
  assert.equal(ch.d.verdict, "recheck"); assert.equal(ch.d.reason, "terms_changed_since_quote"); assert.deepEqual(ch.quote_check.fields_changed, ["price"]);
  for (const d of [{ verdict: "skip", reason: "pay_to_mismatch" }, { verdict: "recheck", reason: "timeout" }]) {
    const r = F.applyQuote(d, { ...ok, terms: { ...q, amount_atomic: "5000" } }, pm, h);
    assert.deepEqual(r.d, d, "skip and recheck reasons are never changed"); assert.equal(r.quote_check.status, "not_compared");
  }
  for (const status of ["not_found", "other_endpoint", "no_terms", "unavailable"]) assert.deepEqual(F.applyQuote(pay, { id: "abc", status }, pm, h).d, pay, status);
  assert.ok(F.QUOTE_ID_RE.test("0123456789") && F.QUOTE_ID_RE.test("sc-0123456789abcdef") && !F.QUOTE_ID_RE.test("sc-xyz") && !F.QUOTE_ID_RE.test("012345678g"));
});

test("rules: terms_changed_since_quote and terms_stale are recheck/low codes with reason text", () => {
  for (const code of ["terms_changed_since_quote", "terms_stale"]) {
    assert.ok(REASON_CODES.some((r) => r.code === code && r.verdict === "recheck" && r.confidence === "low"), code);
    assert.ok(REASON_TEXT[code], code);
  }
});

test("live check without quote: decided exactly as before (re-reads the live 402 every time; no quote_check)", async () => {
  reset();
  const env = envFor(d1());
  const a = (await check(env, SELLER_URL)).body;
  assert.equal(a.verdict, "pay"); assert.equal(a.quote_check, undefined);
  seller.amount = "900"; // live price moved (below the listing): the live check approves the new live terms
  const b = (await check(env, SELLER_URL)).body;
  assert.equal(b.verdict, "pay"); assert.notEqual(b.payment_terms_sha256, a.payment_terms_sha256, "terms come from the live 402, not from any stored quote");
  reset();
});

test("live check with quote=<sc- receipt>: changed terms -> recheck/terms_changed_since_quote; match -> pay; past receipt untouched", async () => {
  reset();
  const db = d1(); const env = envFor(db);
  const first = (await check(env, SELLER_URL)).body;
  assert.equal(first.verdict, "pay"); assert.ok(first.receipt_id);
  const pastRow = JSON.stringify(db.raw.prepare("SELECT * FROM spot_receipts WHERE id = ?").get(first.receipt_id));
  const same = (await check(env, SELLER_URL, "&quote=" + first.receipt_id)).body;
  assert.equal(same.verdict, "pay"); assert.equal(same.quote_check.status, "match"); assert.equal(same.quote_check.quote_type, "live");
  seller.amount = "900"; seller.payTo = PAY_TO_2;
  // (no expected pay_to this time: with pay_to=<old wallet> the existing skip/pay_to_mismatch rule answers first, unchanged)
  const moved = (await call(env, "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(SELLER_URL) + "&claimed_price=0.001&quote=" + first.receipt_id)).body;
  assert.equal(moved.verdict, "recheck", JSON.stringify(moved).slice(0, 400));
  assert.equal(moved.reason_code, "terms_changed_since_quote"); assert.equal(moved.confidence, "low");
  assert.deepEqual(moved.quote_check.fields_changed.sort(), ["pay_to", "price"]);
  assert.match(moved.reason, /differ from the quote you were given \(price, pay_to changed\)/);
  assert.ok(!moved.payment_terms_sha256, "a recheck approves no terms");
  assert.equal(moved.access.tier, "free", "free tier unchanged");
  const withPayTo = (await check(env, SELLER_URL, "&quote=" + first.receipt_id)).body;
  assert.equal(withPayTo.verdict, "skip"); assert.equal(withPayTo.reason_code, "pay_to_mismatch", "skip reasons are not changed by a quote");
  const stored = JSON.parse(db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(moved.receipt_id).body);
  assert.equal(stored.verdict, "recheck"); assert.equal(stored.quote_check.status, "changed");
  assert.equal(JSON.stringify(db.raw.prepare("SELECT * FROM spot_receipts WHERE id = ?").get(first.receipt_id)), pastRow, "the quoted receipt is never rewritten");
  reset();
});

test("live check with quote: unusable quotes never change the verdict; a malformed quote is a 400 before any probe", async () => {
  reset();
  const db = d1(); const env = envFor(db);
  const other = (await check(env, OTHER_URL)).body;
  const r1 = (await check(env, SELLER_URL, "&quote=" + other.receipt_id)).body;
  assert.equal(r1.verdict, "pay"); assert.equal(r1.quote_check.status, "other_endpoint");
  const r2 = (await check(env, SELLER_URL, "&quote=sc-ffffffffffffffff")).body;
  assert.equal(r2.verdict, "pay"); assert.equal(r2.quote_check.status, "not_found");
  const n = db.raw.prepare("SELECT COUNT(*) AS n FROM spot_receipts").get().n;
  const bad = await check(env, SELLER_URL, "&quote=not-an-id");
  assert.equal(bad.status, 400); assert.match(JSON.stringify(bad.body), /quote/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM spot_receipts").get().n, n, "nothing stored for a bad quote");
});

test("live check with quote=<crawl receipt id> (the discover check_url): moved price -> recheck; same terms -> pay", async () => {
  reset();
  const db = d1(); const env = envFor(db);
  const id = await receiptIdFor(SELLER_URL);
  await addCrawlReceipt(db, { id, url: SELLER_URL, norm_url: SELLER_URL, verdict: "pay", reason: "payment request matches the listing", quoted_price_usd: 0.001, claimed_price_usd: 0.001, pay_to: PAY_TO, network: "eip155:8453", asset: USDC, listed_pay_to: PAY_TO, listed_network: "eip155:8453", timestamp: iso(Date.now() - 30 * H), method: "GET" });
  const q = await loadQuote(env, id, SELLER_URL);
  assert.equal(q.status, "ok"); assert.equal(q.kind, "crawl");
  assert.equal((await check(env, SELLER_URL, "&quote=" + id)).body.quote_check.status, "match");
  seller.amount = "800";
  const moved = (await check(env, SELLER_URL, "&quote=" + id)).body;
  assert.equal(moved.verdict, "recheck"); assert.deepEqual(moved.quote_check.fields_changed, ["price"]); assert.equal(moved.quote_check.quote_type, "crawl");
  assert.equal((await check(env, SELLER_URL)).body.verdict, "pay", "without the quote the new live terms are approved");
  reset();
});

test("read-time freshness: by-url and crawl receipts carry it; stored rows unchanged; skips summary + recent pay entries; lookup", async () => {
  reset();
  const db = d1(); const env = envFor(db);
  const a = (await check(env, SELLER_URL)).body;
  // age the stored live receipt by 30 h (as if checked yesterday)
  const row = db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(a.receipt_id);
  const b = JSON.parse(row.body); const old = iso(Date.now() - 30 * H);
  b.checked_at = old; b.probe.probed_at = old;
  db.raw.prepare("UPDATE spot_receipts SET body = ?, created_at = ?, probed_at = ? WHERE id = ?").run(JSON.stringify(b), old, old, a.receipt_id);
  const before = JSON.stringify(db.raw.prepare("SELECT * FROM spot_receipts WHERE id = ?").get(a.receipt_id));
  const bu = (await call(env, "/v1/receipts/by-url?url=" + encodeURIComponent(SELLER_URL))).body;
  assert.equal(bu.latest_live.verdict, "pay", "the stored receipt keeps its verdict");
  assert.equal(bu.freshness.latest_live.terms_stale, true); assert.equal(bu.freshness.latest_live.effective_verdict, "recheck");
  assert.equal(bu.freshness.latest_live.terms_max_age_hours, 24);
  env.TERMS_MAX_AGE_HOURS = "48";
  assert.equal((await call(env, "/v1/receipts/by-url?url=" + encodeURIComponent(SELLER_URL))).body.freshness.latest_live.effective_verdict, "pay");
  delete env.TERMS_MAX_AGE_HOURS;
  assert.equal(JSON.stringify(db.raw.prepare("SELECT * FROM spot_receipts WHERE id = ?").get(a.receipt_id)), before, "reads never rewrite a receipt");
  // crawl receipt by id
  const id = await receiptIdFor(OTHER_URL);
  await addCrawlReceipt(db, { id, url: OTHER_URL, verdict: "pay", reason: "ok", quoted_price_usd: 0.001, pay_to: PAY_TO, network: "eip155:8453", asset: USDC, timestamp: iso(Date.now() - 50 * H) });
  const cr = (await call(env, "/v1/receipts/" + id)).body;
  assert.equal(cr.verdict, "pay"); assert.equal(cr.freshness.effective_verdict, "recheck"); assert.equal(cr.freshness.effective_reason_code, "terms_stale");
  // skips summary
  const sk = (await call(env, "/v1/skips.json")).body;
  assert.ok(sk.terms_freshness && typeof sk.terms_freshness.terms_stale === "boolean" && sk.terms_freshness.terms_max_age_hours === 24);
  const s0 = skipsSummary("https://o", {}, Date.parse("2099-01-01T00:00:00Z"));
  assert.equal(s0.terms_freshness.pay_effective_verdict, "recheck");
  // lookup summary
  const now = Date.parse("2026-10-27T12:00:00Z");
  const svc = { id: "s1", name: "n", endpoint: SELLER_URL, advertised_price: { amount_usd: 0.001 }, latest: { checked_at: "2026-10-26T00:00:00Z", quoted_price_usd: 0.001 } };
  const sum = summarize(svc, { receipts: [] }, 5, now, 36, 24);
  assert.deepEqual([sum.last_check.terms_age_hours, sum.last_check.terms_stale, sum.last_check.terms_max_age_hours], [36, true, 24]);
  assert.equal(summarize(svc, { receipts: [] }, 5, now, 36, 48).last_check.terms_stale, false);
});

test("price and free tier unchanged: paid check is still $0.02 (20000 atomic) and 5 free per day", async () => {
  const toml = readFileSync(join(ROOT, "worker", "wrangler.toml"), "utf8");
  assert.match(toml, /SPOT_FREE_PER_DAY = "5"/);
  const { SPOT_PAID_ATOMIC } = await import("../worker/src/lib.js");
  assert.equal(SPOT_PAID_ATOMIC, "20000");
});

test.after(() => { globalThis.fetch = origFetch; });
