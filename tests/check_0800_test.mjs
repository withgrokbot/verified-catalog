// 0.80.0 paid check + crawl follow-up to 0.79.0: the check's verdict accepts any LISTED payTo on the same network
// (listed_pay_tos from the weekly crawl), and a listing price of $0 is no claim (check, crawl and score). Real SQLite behind
// a tiny D1 adapter for the end-to-end checks; seller fetches stubbed; synthetic hosts and wallets only; nothing is paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { VERSION, applyExpected, pickPayment, applyNoTermsListing, payToListed, listingClaim } from "../worker/src/lib.js";
import { decideVerdict } from "../worker/src/spotcheck.js";
import { receiptIdFor, _clearCrawlStoreCache } from "../worker/src/skips.js";
import { computeScore, scoreConfig, SCORE_RULES } from "../worker/src/score.js";
import * as S from "../worker/src/scorestore.js";

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const BASE = "eip155:8453", POLY = "eip155:137";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", S1 = "So1Se11erAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", S2 = "So1Se11erBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const acc = (payTo, network = BASE, amount = "1000") => ({ scheme: "exact", network, asset: USDC, amount, payTo });
const ALTS = [{ network: BASE, pay_to: A, scope: "endpoint" }, { network: BASE, pay_to: B, scope: "site" }, { network: POLY, pay_to: C, scope: "endpoint" }];
const pay = { verdict: "pay", reason: "price_ok" };

test("0.80.0 version", () => assert.equal(VERSION, "0.80.0"));

test("payToListed: expected wallet, or a listed alternative on the SAME network; Solana exact", () => {
  const exp = { pay_to: A, pay_tos: ALTS };
  assert.ok(payToListed({ payTo: A, network: BASE }, exp));
  assert.ok(payToListed({ payTo: B.toUpperCase().replace("0X", "0x"), network: "base" }, exp), "EVM case and v1 alias");
  assert.ok(!payToListed({ payTo: C, network: BASE }, exp), "C is listed on Polygon only");
  assert.ok(payToListed({ payTo: C, network: POLY }, exp));
  assert.ok(!payToListed({ payTo: B, network: BASE }, { pay_to: A, pay_tos: null }), "no alternatives: only the expected wallet");
  const sol = { pay_to: S1, pay_tos: [{ network: SOL, pay_to: S2 }] };
  assert.ok(payToListed({ payTo: S2, network: SOL }, sol));
  assert.ok(!payToListed({ payTo: S2.toLowerCase(), network: SOL }, sol));
});

test("applyExpected: a 402 paying a listed alternative is not pay_to_mismatch; an unlisted wallet still is", () => {
  assert.deepEqual(applyExpected(pay, { accepts: [acc(B)] }, { pay_to: A, pay_tos: ALTS }), pay);
  assert.deepEqual(applyExpected(pay, { accepts: [acc(B)] }, { pay_to: A }), { verdict: "skip", reason: "pay_to_mismatch" });
  assert.deepEqual(applyExpected(pay, { accepts: [acc(C)] }, { pay_to: A, pay_tos: ALTS }), { verdict: "skip", reason: "pay_to_mismatch" }, "C on Base is not listed");
});

test("pickPayment prefers the expected wallet, then a listed alternative, over an unlisted one", () => {
  assert.equal(pickPayment({ accepts: [acc(C), acc(B), acc(A)] }, { pay_to: A, pay_tos: ALTS, network: BASE }).pay_to, A);
  assert.equal(pickPayment({ accepts: [acc(C), acc(B)] }, { pay_to: A, pay_tos: ALTS, network: BASE }).pay_to, B);
});

test("applyNoTermsListing: the crawl's own 402 or the caller's pay_to on a listed alternative is not a skip", () => {
  const d = { verdict: "recheck", reason: "free_trial_active" };
  const listing = { listed_pay_to: A, listed_network: BASE, listed_pay_tos: ALTS, pay_to: B, network: BASE };
  assert.equal(applyNoTermsListing(d, {}, {}, listing).verdict, "recheck");
  assert.equal(applyNoTermsListing(d, {}, { pay_to: B }, listing).verdict, "recheck");
  assert.deepEqual(applyNoTermsListing(d, {}, { pay_to: C }, listing), { verdict: "skip", reason: "pay_to_mismatch" });
  assert.deepEqual(applyNoTermsListing(d, {}, {}, { ...listing, listed_pay_tos: undefined }), { verdict: "skip", reason: "pay_to_mismatch" });
});

test("listingClaim: $0, missing or junk listing prices are no claim", () => {
  assert.equal(listingClaim(null), null);
  assert.equal(listingClaim({}), null);
  assert.equal(listingClaim({ claimed_price_usd: 0 }), null);
  assert.equal(listingClaim({ claimed_price_usd: "0" }), null);
  assert.equal(listingClaim({ claimed_price_usd: "x" }), null);
  assert.equal(listingClaim({ claimed_price_usd: 0.01 }), 0.01);
  // decideVerdict with no claim answers on the 402 alone (unchanged rule)
  assert.deepEqual(decideVerdict({ reachable: true, x402_challenge: true, known_answer: true, quoted_price_usd: 0.01 }, listingClaim({ claimed_price_usd: 0 })), pay);
});

// ---- end to end through the free spot-check (listing from crawl_store)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(ROOT, "worker", "migrations");
const MIGS = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(MIG_DIR, f), "utf8"));
function d1() {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGS) db.exec(m);
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({ sql, args, bind: (...a) => mk(sql, norm(a)), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }, _run: () => db.prepare(sql).run(...args) });
  return { raw: db, prepare: (sql) => mk(sql), batch: async (st) => { db.exec("BEGIN"); try { for (const s of st) s._run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; } };
}
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const seller = { payTo: B, amount: "10000" };
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://cloudflare-dns.com/dns-query")) return Response.json(new URL(u).searchParams.get("type") === "A" || !new URL(u).searchParams.get("type") ? { Answer: [{ type: 1, data: "93.184.216.34" }] } : { Answer: [] });
  if (u.startsWith("https://api.altfixture.dev/")) {
    const body = { x402Version: 2, error: "Payment required", resource: { url: u }, accepts: [{ ...acc(seller.payTo, BASE, seller.amount), maxTimeoutSeconds: 300 }] };
    return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "payment-required": btoa(JSON.stringify(body)) } });
  }
  return new Response("not stubbed: " + u, { status: 599 });
};
const noKv = { get: async () => null, put: async () => { throw new Error("must not write KV"); }, delete: async () => { throw new Error("no KV deletes"); } };
async function addCrawl(db, url, extra) {
  const id = await receiptIdFor(url);
  const rec = { id, url, verdict: "skip", reason: "pays a different wallet than listed", timestamp: iso(Date.now() - 3600e3), source_list: "cdp-bazaar", check_type: "self-checked", listed_pay_to: A, listed_network: BASE, ...extra };
  const key = "c:" + id.slice(0, 2), text = JSON.stringify({ [id]: rec });
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  db.raw.prepare("INSERT OR REPLACE INTO crawl_store (key, part, parts, sha256, value, source, updated_at) VALUES (?, 0, 1, ?, ?, 'test', ?)").run(key, sha, text, iso(Date.now()));
  _clearCrawlStoreCache();
}
let ip = 20;
const check = async (env, url, extra = "") => {
  const r = await worker.fetch(new Request("https://api.402xagent.com/v1/products/endpoint-spot-check?url=" + encodeURIComponent(url) + extra, { headers: { accept: "application/json", "cf-connecting-ip": "203.0.113." + ip++ } }), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const envFor = (db) => ({ RECEIPTS_DB: db, CLIENT_SALT: "salt", SPOT_PROBE_CACHE_S: "0", CRAWL_KV: noKv, SPOT_KV: noKv, CRAWL_STORE: "d1" });

test("free check end to end: listing names A and B, the 402 pays B -> pay (before 0.80.0: skip/pay_to_mismatch)", async () => {
  const db = d1(), env = envFor(db);
  const u1 = "https://api.altfixture.dev/v1/alt", u2 = "https://api.altfixture.dev/v1/single";
  await addCrawl(db, u1, { claimed_price_usd: 0.01, listed_pay_tos: ALTS });
  await addCrawl(db, u2, { claimed_price_usd: 0.01 });
  seller.payTo = B; seller.amount = "10000";
  const ok = await check(env, u1);
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.equal(ok.body.verdict, "pay", JSON.stringify(ok.body).slice(0, 400));
  const single = await check(env, u2);
  assert.equal(single.body.verdict, "skip"); assert.equal(single.body.reason_code, "pay_to_mismatch");
  // a caller's explicit pay_to stays strict: alternatives come from the listing only
  const strict = await check(env, u1, "&pay_to=" + A);
  assert.equal(strict.body.verdict, "skip");
  seller.payTo = C;
  assert.equal((await check(env, u1)).body.verdict, "skip", "an unlisted wallet is still a skip");
});

test("free check end to end: a $0 listing price is no claim (pay on the 402's own terms, not price_mismatch)", async () => {
  const db = d1(), env = envFor(db);
  const u = "https://api.altfixture.dev/v1/zero";
  await addCrawl(db, u, { claimed_price_usd: 0, listed_pay_to: B });
  seller.payTo = B; seller.amount = "10000";
  const r = await check(env, u);
  assert.equal(r.body.verdict, "pay", JSON.stringify(r.body).slice(0, 400));
  await addCrawl(db, u, { claimed_price_usd: 0.001, listed_pay_to: B });
  const lower = (await check(env, u)).body;
  assert.equal(lower.verdict, "skip"); assert.equal(lower.reason_code, "price_mismatch", "a real lower listing price is still price_mismatch");
});

// ---- score: price claims
const NOW = new Date("2026-11-24T12:00:00Z"), DAY = 86400e3, HOUR = 3600e3;
let seq = 0;
const probe = (d, h, o = {}) => ({ id: "sc-" + String(++seq).padStart(16, "0"), at: iso(NOW - d * DAY - h * HOUR), check_type: "self-checked", ref: "score-probe", caller: "self-test", client: "withgrokbot-selftest", verdict: "pay", reason_code: "price_ok", http_status: 402, listing_source: "listing", terms: { pay_to: A, network: BASE, asset: USDC, amount: "10000" }, ...o });
const run = Array.from({ length: 12 }, (_, i) => probe(Math.floor(i / 2) + 1, (i % 2) * 6 + 1));
const pm = (d, h, claimed) => probe(d, h, { verdict: "skip", reason_code: "price_mismatch", claimed });
const sc = (obs, listing = null) => computeScore({ url: "https://api.altfixture.dev/v1/s", observations: obs, listing, now: NOW, cfg: scoreConfig({}) });

test("score: price_mismatch against a $0 listing price is not price_above_listing", () => {
  assert.ok(sc([...run, pm(0, 2, 0.001)]).flags.some((f) => f.code === "price_above_listing"));
  const zero = sc([...run, pm(0, 2, 0)]);
  assert.ok(!zero.flags.some((f) => f.code === "price_above_listing"), JSON.stringify(zero.flags));
  assert.equal(zero.band, "good");
  assert.ok(SCORE_RULES.price_claim);
});

test("score: when the current listing names no price, older price_mismatch rows do not count; a priced listing keeps them", () => {
  const obs = [...run, pm(0, 2, 0.001)];
  assert.ok(!sc(obs, { listed_pay_to: A, claimed_price_usd: null }).flags.some((f) => f.code === "price_above_listing"));
  assert.ok(!sc(obs, { listed_pay_to: A, claimed_price_usd: 0 }).flags.some((f) => f.code === "price_above_listing"));
  assert.ok(sc(obs, { listed_pay_to: A, claimed_price_usd: 0.001 }).flags.some((f) => f.code === "price_above_listing"));
  assert.ok(sc(obs, { listed_pay_to: A }).flags.some((f) => f.code === "price_above_listing"), "a listing object without the field: unchanged");
});

test("scorestore: price_mismatch rows carry the claimed price; the crawl's claim reaches the scorer", async () => {
  const o = S.receiptObservation({ id: "sc-1", at: iso(NOW), check_type: "self-checked", reason_code: "price_mismatch", claimed: 0 });
  assert.equal(o.claimed, 0);
  assert.ok(!("claimed" in S.receiptObservation({ id: "sc-2", at: iso(NOW), check_type: "self-checked", reason_code: "price_ok" })));
  const db = d1();
  const U = "https://api.altfixture.dev/v1/store";
  const add = (ageH, reason, claimed) => db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, body) VALUES (?, ?, ?, ?, ?, 'self-checked', 'score-probe', ?)").run("sc-" + String(++seq).padStart(16, "0"), U, iso(NOW - ageH * HOUR), reason === "price_ok" ? "pay" : "skip", reason,
    JSON.stringify({ url: U, method: "GET", check_type: "self-checked", client: "withgrokbot-selftest", caller: "self-test", ref: "score-probe", probe_origin: "cron", reason_code: reason, live_402: { http_status: 402, x402_challenge: true, accepts: [{ scheme: "exact", network: BASE, asset: USDC, amount_atomic: "10000", pay_to: A }] }, listing: { source: "listing" }, expected: { claimed_price_usd: claimed, pay_to: A, network: BASE, source: "listing" } }));
  for (let i = 0; i < 14; i++) add(30 + i * 12, "price_ok", 0.01);
  add(2, "price_mismatch", 0.001);
  const env = { RECEIPTS_DB: db, SCORE_BAND: "shadow" };
  const dep = (claimed) => ({ listingForAsync: async () => ({ id: "c1", url: U, timestamp: iso(NOW - 3 * DAY), verdict: "pay", listed_pay_to: A, listed_network: BASE, ...(claimed == null ? {} : { claimed_price_usd: claimed }) }) });
  assert.ok((await S.scoreEndpoint(env, U, NOW, dep(0.001))).flags.some((f) => f.code === "price_above_listing"));
  assert.ok(!(await S.scoreEndpoint(env, U, NOW, dep(null))).flags.some((f) => f.code === "price_above_listing"), "listing no longer names a price");
});
