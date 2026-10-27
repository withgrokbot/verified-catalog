// 0.53.3 post-payment delivery check, Worker read side (worker/src/delivery.js + reputation + verdict path).
// Real SQLite (node:sqlite) with every migration behind a tiny D1 adapter; seller fetches are stubbed. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { historyKey } from "../worker/src/lib.js";
import * as D from "../worker/src/delivery.js";
import { computeReputation, REPUTATION_WEIGHTS } from "../worker/src/reputation.js";
import { REASON_CODES } from "../worker/src/rules.js";

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
const NOW = Date.now();
const DAY = 86400000;
const SELLER_URL = "https://api.deliveryfixture.dev/v1/data";
const OTHER_URL = "https://api.deliveryfixture.dev/v1/other";
const PAY_TO = "0x" + "aa".repeat(20);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://cloudflare-dns.com/dns-query")) {
    const type = new URL(u).searchParams.get("type") || "A";
    return Response.json(type === "A" ? { Answer: [{ type: 1, data: "93.184.216.34" }] } : { Answer: [] });
  }
  if (u.startsWith("https://api.deliveryfixture.dev/")) {
    const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300 }];
    const body = { x402Version: 2, error: "Payment required", resource: { url: u }, accepts };
    return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json", "payment-required": btoa(JSON.stringify(body)) } });
  }
  return new Response("not stubbed: " + u, { status: 599 });
};

async function addDelivery(db, url, at, flag, reason = null) {
  db.raw.prepare("INSERT INTO delivery_checks (hkey, host, checked_at, flag, reason, http_status) VALUES (?, ?, ?, ?, ?, 200)").run(await historyKey(url), new URL(url).host, iso(at), flag, reason);
}
let ipN = 10;
async function check(env, url) {
  const r = await worker.fetch(new Request("https://api.402xagent.com/v1/products/endpoint-spot-check?url=" + encodeURIComponent(url) + "&claimed_price=0.001&pay_to=" + PAY_TO, { headers: { accept: "application/json", "cf-connecting-ip": "203.0.113." + ipN++ } }), env, { waitUntil() {} });
  return r.json();
}

test("migration 0020 is additive + idempotent", () => {
  const sql = readFileSync(join(MIG_DIR, "0020_delivery_checks.sql"), "utf8").replace(/--.*$/gm, "");
  assert.ok(!/\b(ALTER|DROP|UPDATE|DELETE|INSERT)\b/i.test(sql));
  const db = new DatabaseSync(":memory:"); db.exec(sql); db.exec(sql);
  assert.deepEqual(db.prepare("PRAGMA table_info(delivery_checks)").all().map((c) => c.name), ["hkey", "host", "checked_at", "flag", "reason", "http_status"]);
});

test("applyDelivery: only pay -> recheck/delivery_failed, only on a failed latest delivery", () => {
  const pay = { verdict: "pay", reason: "price_ok" };
  const failed = { flag: "failed", reason: "canned_refusal", checked_at: "2026-10-26T00:00:00Z" };
  assert.deepEqual(D.applyDelivery(pay, failed).d, { verdict: "recheck", reason: "delivery_failed" });
  assert.deepEqual(D.applyDelivery(pay, { flag: "ok" }).d, pay);
  assert.deepEqual(D.applyDelivery(pay, null).d, pay);
  for (const d of [{ verdict: "skip", reason: "pay_to_mismatch" }, { verdict: "recheck", reason: "timeout" }]) assert.deepEqual(D.applyDelivery(d, failed).d, d);
  assert.ok(REASON_CODES.some((r) => r.code === "delivery_failed" && r.verdict === "recheck" && r.confidence === "low"));
});

test("latestDelivery: flag off never reads D1; missing table, old rows and an ok after a failure all mean no effect", async () => {
  const boom = { prepare() { throw new Error("must not read"); } };
  assert.equal(await D.latestDelivery({ RECEIPTS_DB: boom }, "h:x"), null);
  assert.equal(await D.latestDelivery({ DELIVERY_CHECK: "1", RECEIPTS_DB: boom }, "h:x"), null); // throws -> null (0020 not applied)
  const db = d1(); const env = { DELIVERY_CHECK: "1", RECEIPTS_DB: db };
  const hk = await historyKey(SELLER_URL);
  await addDelivery(db, SELLER_URL, NOW - 20 * DAY, "failed", "server_error");
  assert.equal(await D.latestDelivery(env, hk, new Date(NOW)), null, "older than 14 days");
  await addDelivery(db, SELLER_URL, NOW - 3 * DAY, "failed", "soft_paywall");
  assert.equal((await D.latestDelivery(env, hk, new Date(NOW))).reason, "soft_paywall");
  await addDelivery(db, SELLER_URL, NOW - 1 * DAY, "ok");
  assert.equal((await D.latestDelivery(env, hk, new Date(NOW))).flag, "ok");
});

test("verdict path: a recent failed delivery turns a NEW pay into recheck/delivery_failed; past receipts and sellers without data unchanged", async () => {
  const db = d1();
  const env = { RECEIPTS_DB: db, CLIENT_SALT: "salt" };
  const before = await check(env, SELLER_URL);
  assert.equal(before.verdict, "pay", JSON.stringify(before).slice(0, 300));
  const pastId = before.receipt_id;
  assert.ok(pastId, "the first check stored a receipt");
  const pastRow = pastId ? JSON.stringify(db.raw.prepare("SELECT * FROM spot_receipts WHERE id = ?").get(pastId)) : null;
  await addDelivery(db, SELLER_URL, NOW - 2 * DAY, "failed", "canned_refusal");
  // flag off: unchanged even with data
  assert.equal((await check(env, SELLER_URL)).verdict, "pay");
  env.DELIVERY_CHECK = "1";
  const after = await check(env, SELLER_URL);
  assert.equal(after.verdict, "recheck");
  assert.equal(after.reason_code, "delivery_failed");
  assert.equal(after.confidence, "low");
  assert.ok(!after.payment_terms_sha256, "a recheck approves no terms");
  // the same host's other endpoint has no delivery rows: still pay
  assert.equal((await check(env, OTHER_URL)).verdict, "pay");
  // the earlier pay receipt is untouched
  if (pastId) assert.equal(JSON.stringify(db.raw.prepare("SELECT * FROM spot_receipts WHERE id = ?").get(pastId)), pastRow);
  // a later ok delivery clears it
  await addDelivery(db, SELLER_URL, NOW - 1 * DAY, "ok");
  assert.equal((await check(env, SELLER_URL)).verdict, "pay");
});

test("reputation: delivery is an extra component only with data; failures lower the score; no data = identical output", () => {
  const now = new Date(NOW);
  const receipts = Array.from({ length: 8 }, (_, i) => ({ url: SELLER_URL, created_at: iso(NOW - i * 3600000), verdict: "pay" }));
  const base = { host: "api.deliveryfixture.dev", receipts, firstSeen: iso(NOW - 10 * DAY), now };
  const plain = computeReputation(base);
  assert.deepEqual(computeReputation({ ...base, deliveries: [] }), plain);
  assert.deepEqual(Object.keys(plain.breakdown), Object.keys(REPUTATION_WEIGHTS));
  assert.ok(!("delivery_checks_30d" in plain.inputs));
  const bad = computeReputation({ ...base, deliveries: [{ flag: "failed", reason: "challenge_page" }, { flag: "failed", reason: "empty_body" }, { flag: "ok" }] });
  assert.ok(bad.score < plain.score, `${bad.score} < ${plain.score}`);
  assert.equal(bad.breakdown.delivery.weight, D.DELIVERY_WEIGHT);
  assert.equal(bad.breakdown.delivery.value, 0.333);
  assert.deepEqual([bad.inputs.delivery_checks_30d, bad.inputs.delivery_failed_30d], [3, 2]);
  const good = computeReputation({ ...base, deliveries: [{ flag: "ok" }, { flag: "ok" }] });
  assert.ok(good.score >= plain.score);
});

test.after(() => { globalThis.fetch = origFetch; });
