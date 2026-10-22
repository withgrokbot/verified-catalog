// 0.49.0 report tests: re-check window (RECHECK) and bulk report (BULK_REPORT) on real SQLite (node:sqlite, every
// migration) behind a tiny D1 adapter; facilitator stubbed; QUOTA = the real QuotaCounter class on in-memory storage.
// All data is synthetic. Run: npx -y -p node@22 node tests/report_test.mjs  (Node >= 22.5)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { QuotaCounter } from "../worker/src/lib.js";
import * as R from "../worker/src/report.js";
import * as S from "../worker/src/sign.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGDIR = join(ROOT, "worker", "migrations");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function d1() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGDIR).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(join(MIGDIR, f), "utf8"));
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({
    bind: (...a) => mk(sql, norm(a)),
    first: async () => { if (d1.fail && d1.fail.test(sql)) throw new Error("d1 down"); return db.prepare(sql).get(...args) ?? null; },
    all: async () => { if (d1.fail && d1.fail.test(sql)) throw new Error("d1 down"); return { results: db.prepare(sql).all(...args) }; },
    run: async () => { if (d1.fail && d1.fail.test(sql)) throw new Error("d1 down"); const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _run: () => db.prepare(sql).run(...args),
  });
  return { raw: db, prepare: (sql) => mk(sql), batch: async (st) => { for (const s of st) s._run(); return []; } };
}
function quotaNs() {
  const objs = new Map();
  return { idFromName: (n) => n, get: (id) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new QuotaCounter({ storage: { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); } } }, {})); } const o = objs.get(id); return { fetch: (u) => o.fetch(new Request(u)) }; } };
}
const PAY_TO = "0x00000000000000000000000000000000000000aa";
const PAYER = "0x00000000000000000000000000000000000000bb";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TXH = "0x" + "ab".repeat(32);
let fac = { valid: true, settles: 0, verifies: 0 };
const ofetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  const s = String(u);
  if (s.endsWith("/verify")) { fac.verifies++; return Response.json(fac.valid ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" }); }
  if (s.endsWith("/settle")) { fac.settles++; return Response.json({ success: true, transaction: TXH, network: "eip155:8453", payer: PAYER }); }
  return new Response("nope", { status: 404 });
};
const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "test-report-key" };
S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();
const KEYS = S.receiptKeysDoc();
function setup(extra = {}) {
  const env = { RECEIPTS_DB: d1(), QUOTA: quotaNs(), PAY_TO, ENDPOINT_REPORT: "1", RECHECK: "1", BULK_REPORT: "1", EXPLAIN_LINE: "1", RECHECK_PEPPER: "test-pepper-0123456789", CLIENT_SALT: "s", RECEIPT_SIGNING_KEY: JSON.stringify(jwk), ...extra };
  const pending = [];
  const call = async (method, path, { body, headers = {}, ip = "203.0.113.9" } = {}) => {
    const req = new Request("https://api.402xagent.com" + path, { method, headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    const r = await worker.fetch(req, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending.splice(0));
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { status: r.status, headers: r.headers, text, j };
  };
  const sql = (q, ...a) => env.RECEIPTS_DB.raw.prepare(q).all(...a);
  return { env, call, sql };
}
const pay = (amount) => ({ "payment-signature": btoa(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo: PAY_TO }, payload: { signature: "0x" + "11".repeat(65), authorization: { from: PAYER, to: PAY_TO, value: amount, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } } })) });
const ER = "/v1/products/endpoint-report";
const U = "https://seller.example.fixture/api/x";
async function paidReport(t, url = U) { const r = await t.call("POST", ER, { body: { url }, headers: pay("50000") }); assert.equal(r.status, 200, r.text); return r; }
const recheck = (t, id, secret, url = U, ip) => t.call("POST", ER, { body: { url, recheck_of: id }, headers: secret ? { "x-recheck-secret": secret } : {}, ip });
const clearGap = (t, id) => t.env.RECEIPTS_DB.raw.prepare("UPDATE recheck_credits SET last_used_at = NULL WHERE receipt_id = ?").run(id);

// ---------------------------------------------------------------- 2) re-check window
test("recheck: paid report returns a one-time rks_ secret outside the signature; D1 holds only an HMAC; public view has no secret", async () => {
  const t = setup();
  const r = await paidReport(t);
  const rc = r.j.recheck;
  assert.equal(rc.available, true); assert.match(rc.secret, R.RECHECK_SECRET_RE); assert.equal(rc.max_uses, 10); assert.equal(rc.receipt_id, r.j.id);
  const { recheck: _x, ...signed } = r.j;
  const dump = JSON.stringify([t.sql("SELECT * FROM recheck_credits"), t.sql("SELECT * FROM endpoint_reports")]);
  assert.ok(!dump.includes(rc.secret) && !dump.includes(rc.secret.slice(4)), "secret never stored in clear");
  const row = t.sql("SELECT * FROM recheck_credits")[0];
  assert.equal(row.secret_hash, await R.recheckHash(t.env, r.j.id, rc.secret)); assert.equal(row.kind, "window"); assert.equal(row.used, 0);
  for (const k of Object.keys(row)) assert.ok(!/^(ip|ip_hash|payer|wallet|tx|tx_hash|client)$/.test(k), k);
  const pub = await t.call("GET", "/v1/receipts/" + r.j.id);
  assert.equal(pub.status, 200); assert.ok(!pub.text.includes("rks_") && !pub.text.includes(PAYER.slice(2)) && !pub.text.includes(TXH.slice(2)));
  assert.ok(!JSON.stringify(signed).includes(rc.secret));
  // flag off: no recheck block, recheck_of ignored (normal payment path)
  const off = setup({ RECHECK: undefined });
  const r2 = await paidReport(off);
  assert.equal(r2.j.recheck, undefined); assert.equal(off.sql("SELECT COUNT(*) n FROM recheck_credits")[0].n, 0);
});

test("recheck: 10 uses then 402 exhausted; expired -> 402; no payment on a re-check; fresh signed er- with recheck_of + counter", async () => {
  const t = setup();
  const r = await paidReport(t); const { secret } = r.j.recheck; const id = r.j.id;
  const settlesBefore = fac.settles;
  for (let i = 1; i <= 10; i++) {
    clearGap(t, id);
    const x = await recheck(t, id, secret);
    assert.equal(x.status, 200, x.text); assert.equal(x.j.tier, "recheck"); assert.equal(x.j.recheck_of, id); assert.equal(x.j.recheck.used, i); assert.equal(x.j.payment_received, undefined);
    assert.ok(x.j.revealed && x.j.checked_at, "a re-check is a fresh report"); assert.notEqual(x.j.id, id);
  }
  assert.equal(fac.settles, settlesBefore, "nothing settled for re-checks");
  clearGap(t, id);
  const ex = await recheck(t, id, secret);
  assert.equal(ex.status, 402); assert.equal(ex.j.code, "recheck_exhausted"); assert.equal(ex.j.recheck.used, 10); assert.equal(ex.j.accepts[0].amount, "50000");
  const r2 = await paidReport(t); const id2 = r2.j.id;
  t.env.RECEIPTS_DB.raw.prepare("UPDATE recheck_credits SET expires_at = '2020-01-01T00:00:00Z' WHERE receipt_id = ?").run(id2);
  const exp = await recheck(t, id2, r2.j.recheck.secret);
  assert.equal(exp.status, 402); assert.equal(exp.j.code, "recheck_expired");
  const fn = t.sql("SELECT event, n FROM paywall_daily WHERE event = 'recheck'")[0];
  assert.equal(fn.n, 10, "funnel counts re-checks");
});

test("recheck: wrong / missing secret and unknown id are the same 401; wrong endpoint 409; within 60 s 429; 20 failures/day per network -> 429", async () => {
  const t = setup();
  const r = await paidReport(t); const id = r.j.id, secret = r.j.recheck.secret;
  const a = await recheck(t, id, "rks_" + "0".repeat(64));
  const b = await recheck(t, id, null);
  const c = await recheck(t, "er-0123456789abcdef", secret);
  for (const x of [a, b, c]) { assert.equal(x.status, 401); assert.equal(x.j.code, "recheck_unauthorized"); assert.equal(x.j.field, "X-Recheck-Secret"); }
  assert.equal(a.j.error, c.j.error, "unknown id indistinguishable from wrong secret");
  assert.ok(!a.text.includes("rks_0000"), "secret never echoed");
  const w = await recheck(t, id, secret, "https://other.example.fixture/y");
  assert.equal(w.status, 409); assert.equal(w.j.code, "recheck_wrong_endpoint"); assert.equal(w.j.field, "url");
  assert.equal((await recheck(t, id, secret)).status, 200);
  const g = await recheck(t, id, secret);
  assert.equal(g.status, 429); assert.equal(g.j.code, "recheck_rate_limited"); assert.ok(g.j.retry_after_s >= 1 && g.j.retry_after_s <= 60); assert.ok(g.headers.get("retry-after"));
  const bad = await recheck(t, id, secret.replace(/.$/, (ch) => (ch === "0" ? "1" : "0")));
  assert.equal(bad.status, 401);
  const t2 = setup();
  for (let i = 0; i < 20; i++) assert.equal((await recheck(t2, "er-0123456789abcdef", "rks_" + "1".repeat(64), U, "198.51.100.7")).status, 401);
  const lim = await recheck(t2, "er-0123456789abcdef", "rks_" + "1".repeat(64), U, "198.51.100.7");
  assert.equal(lim.status, 429); assert.equal(lim.j.code, "recheck_rate_limited");
  const bo = await t.call("POST", ER, { body: { url: U, recheck_of: "nope" }, headers: { "x-recheck-secret": secret } });
  assert.equal(bo.status, 400); assert.equal(bo.j.field, "recheck_of");
});

test("recheck: atomic counter (parallel redeems at 9 used -> exactly one wins); failure after the use is taken refunds it", async () => {
  const t = setup();
  const r = await paidReport(t); const id = r.j.id, secret = r.j.recheck.secret;
  t.env.RECEIPTS_DB.raw.prepare("UPDATE recheck_credits SET used = 9, last_used_at = NULL WHERE receipt_id = ?").run(id);
  const hk = t.sql("SELECT hkey FROM recheck_credits")[0].hkey;
  const res = await Promise.all(Array.from({ length: 12 }, () => R.redeemCredit(t.env, { receiptId: id, secret, hkey: hk })));
  assert.equal(res.filter((x) => x.ok).length, 1); assert.equal(t.sql("SELECT used FROM recheck_credits")[0].used, 10);
  t.env.RECEIPTS_DB.raw.prepare("UPDATE recheck_credits SET used = 3, last_used_at = NULL WHERE receipt_id = ?").run(id);
  d1.fail = /crawl_store|endpoint_history|FROM endpoint_quality|INTO commitments|FROM commitments/;
  const f = await recheck(t, id, secret);
  d1.fail = null;
  assert.equal(f.status, 503); assert.equal(f.j.credit_refunded, true); assert.equal(t.sql("SELECT used FROM recheck_credits")[0].used, 3, "use refunded");
  const noPep = setup({ RECHECK_PEPPER: undefined });
  const p = await paidReport(noPep);
  assert.equal(p.j.recheck.available, false, "no pepper -> no secret issued (fail closed)");
  assert.equal((await recheck(noPep, p.j.id, "rks_" + "1".repeat(64))).status, 503);
});

// ---------------------------------------------------------------- 3) bulk report
const BULK = "/v1/products/endpoint-report/bulk";
const urls = (n) => Array.from({ length: n }, (_, i) => `https://seller${i}.example.fixture/api/x`);
test("bulk: off -> 404; bare 402 discovery; price min(n x 50000, 200000); 6 URLs / bad URL / duplicate -> 400 with nothing verified or settled", async () => {
  assert.equal((await setup({ BULK_REPORT: undefined }).call("POST", BULK, { body: { urls: urls(2) } })).status, 404);
  const t = setup();
  const bare = await t.call("POST", BULK, { body: {} });
  assert.equal(bare.status, 402); assert.equal(bare.j.discovery, true); assert.equal(bare.j.accepts[0].amount, "200000");
  for (const [n, amt] of [[1, "50000"], [2, "100000"], [3, "150000"], [4, "200000"], [5, "200000"]]) {
    const r = await t.call("POST", BULK, { body: { urls: urls(n) } });
    assert.equal(r.status, 402); assert.equal(r.j.accepts[0].amount, amt, "n=" + n); assert.equal(r.j.accepts[0].network, "eip155:8453"); assert.equal(r.j.urls_count, n);
  }
  assert.equal(R.bulkAtomic(1), "50000"); assert.equal(R.bulkAtomic(5), "200000");
  const v0 = fac.verifies, s0 = fac.settles;
  const six = await t.call("POST", BULK, { body: { urls: urls(6) }, headers: pay("200000") });
  assert.equal(six.status, 400); assert.equal(six.j.field, "urls");
  const badu = await t.call("POST", BULK, { body: { urls: [urls(1)[0], "ftp://nope"] }, headers: pay("100000") });
  assert.equal(badu.status, 400); assert.equal(badu.j.field, "urls[1]");
  const dup = await t.call("POST", BULK, { body: { urls: [U, U + "/"] }, headers: pay("100000") });
  assert.equal(dup.status, 400); assert.equal(dup.j.code, "duplicate_url");
  const wrong = await t.call("POST", BULK, { body: { urls: urls(3) }, headers: pay("200000") });
  assert.equal(wrong.status, 402); assert.match(wrong.j.error, /amount does not match/, "3 URLs must pay 150000, not the cap");
  assert.equal(fac.verifies, v0); assert.equal(fac.settles, s0, "nothing verified or settled");
  const listed = await t.call("GET", "/.well-known/x402");
  assert.ok(listed.j.resources.includes("https://api.402xagent.com" + BULK));
});

test("bulk: 5 URLs, one settlement; 5 signed er- (bulk_id/index) + signed eb- envelope; per-URL re-check windows; privacy", async () => {
  const t = setup();
  const s0 = fac.settles;
  const r = await t.call("POST", BULK, { body: { urls: urls(5) }, headers: pay("200000") });
  assert.equal(r.status, 200, r.text); assert.equal(fac.settles, s0 + 1, "one settlement"); assert.ok(r.headers.get("payment-response"));
  assert.match(r.j.bulk_id, R.EB_RECEIPT_RE); assert.equal(r.j.results.length, 5);
  for (const [i, x] of r.j.results.entries()) {
    assert.equal(x.status, "ok"); assert.equal(x.index, i); assert.equal(x.receipt.bulk_id, r.j.bulk_id); assert.equal(x.receipt.bulk_index, i); assert.equal(x.receipt.tier, "bulk");
    assert.ok(x.receipt.signature, "each item signed"); assert.match(x.receipt.explain, /term change/);
    assert.equal(x.recheck.available, true); assert.equal(x.recheck.max_uses, 10);
    assert.ok(!JSON.stringify(x.receipt).includes("rks_"), "secret outside the signed item");
  }
  const E = r.j.envelope;
  assert.equal(E.count, 5); assert.equal(E.ok, 5); assert.equal(E.amount_atomic, "200000"); assert.ok(E.signature); assert.equal(E.payment_received.amount_atomic, "200000");
  const one = r.j.results[2];
  assert.equal((await recheck(t, one.receipt_id, one.recheck.secret, urls(5)[2])).status, 200, "bulk item re-check works");
  const pub = await t.call("GET", "/v1/receipts/" + r.j.bulk_id);
  assert.equal(pub.status, 200); assert.equal(pub.j.id, r.j.bulk_id);
  const dump = (JSON.stringify([t.sql("SELECT * FROM recheck_credits"), t.sql("SELECT * FROM paywall_daily"), t.sql("SELECT * FROM notfound_daily")]) + pub.text).toLowerCase();
  for (const x of [PAYER.slice(2), TXH.slice(2), "203.0.113", "rks_"]) assert.ok(!dump.includes(x), x);
  const fn = Object.fromEntries(t.sql("SELECT event, SUM(n) n FROM paywall_daily WHERE route = ? GROUP BY event", BULK).map((x) => [x.event, x.n]));
  assert.equal(fn.settled, 1); assert.equal(fn.attempt, 1);
});

test("bulk: a URL that fails after payment -> failed item + single-use 7-day bulk_retry credit that redeems once to a full report; credit store down -> unfulfilled logged", async () => {
  const t = setup();
  const list = urls(3);
  const r = await t.call("POST", BULK, { body: { urls: list, commitment_refs: { [list[1]]: "cm-0123456789abcdef" } }, headers: pay("150000") });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.j.results.map((x) => x.status), ["ok", "failed", "ok"]);
  const f = r.j.results[1];
  assert.equal(f.error.code, "commitment_not_found"); assert.equal(f.credit.kind, "bulk_retry"); assert.equal(f.credit.max_uses, 1); assert.match(f.credit.secret, R.RECHECK_SECRET_RE);
  const days = (Date.parse(f.credit.expires_at) - Date.now()) / 86400000; assert.ok(days > 6.9 && days <= 7.01, String(days));
  assert.equal(r.j.envelope.failed, 1); assert.equal(r.j.envelope.items[1].credit_receipt_id, f.credit.receipt_id);
  const red = await recheck(t, f.credit.receipt_id, f.credit.secret, list[1]);
  assert.equal(red.status, 200, red.text); assert.equal(red.j.id, f.credit.receipt_id, "the reserved id becomes the report"); assert.equal(red.j.tier, "bulk_retry"); assert.ok(red.j.revealed);
  clearGap(t, f.credit.receipt_id);
  const again = await recheck(t, f.credit.receipt_id, f.credit.secret, list[1]);
  assert.equal(again.status, 402); assert.equal(again.j.code, "recheck_exhausted", "single use");
  // credit store down after settlement: item marked unfulfilled + counted for the manual path
  const t2 = setup({ RECHECK: undefined });
  const r2 = await t2.call("POST", BULK, { body: { urls: list.slice(0, 2), commitment_refs: { [list[0]]: "cm-0123456789abcdef" } }, headers: pay("100000") });
  assert.equal(r2.j.results[0].credit, null); assert.equal(r2.j.results[0].unfulfilled, true);
  assert.equal(t2.sql("SELECT n FROM paywall_daily WHERE event = 'bulk_unfulfilled'")[0].n, 1);
  // store down BEFORE settlement: 503, nothing settled
  const t3 = setup(); const s0 = fac.settles;
  d1.fail = /endpoint_bulk/;
  const r3 = await t3.call("POST", BULK, { body: { urls: list }, headers: pay("150000") });
  d1.fail = null;
  assert.equal(r3.status, 503); assert.equal(fac.settles, s0);
});

test("bulk: CPU/time budget: 5 URLs well under 150 ms of handler time locally", async () => {
  const t = setup();
  await t.call("POST", BULK, { body: { urls: urls(5) }, headers: pay("200000") }); // warm
  const t0 = performance.now();
  const r = await t.call("POST", BULK, { body: { urls: urls(5).map((u) => u + "2") }, headers: pay("200000") });
  const ms = performance.now() - t0;
  assert.equal(r.status, 200); assert.ok(ms < 150, ms.toFixed(1) + " ms");
});

let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; console.log("FAIL " + name + "\n  " + String((e && e.stack) || e).split("\n").slice(0, 7).join("\n  ")); }
}
globalThis.fetch = ofetch;
console.log(`${pass}/${tests.length} report tests passed`);
if (fail) process.exit(1);
