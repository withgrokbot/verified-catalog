// Decision-gate adapters (examples/decision-gate): output shapes, gating, no signing on non-pay. Offline.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decide, termsSha256, termsMismatch, RISK_KEY } from "../examples/decision-gate/gate.mjs";
import { ap2RiskDataEntry, attachToPaymentMandate } from "../examples/decision-gate/ap2.mjs";
import { counterpartyConstraint, satisfies, VI_TYPE } from "../examples/decision-gate/verifiable-intent.mjs";
import { payIfSafe } from "../examples/decision-gate/check-before-sign.mjs";
import { checkBeforeVoucher } from "../examples/decision-gate/mastercard-check-before-voucher.mjs";
import { REQUIREMENT, RESOURCE, seller402, stubSpotFetch } from "../examples/decision-gate/fixtures.mjs";

const NOW = () => new Date("2026-10-27T15:00:00Z");
const run = (v, extra = {}) => decide({ url: RESOURCE, requirement: REQUIREMENT }, { fetch: stubSpotFetch(v), now: NOW, ...extra });

test("termsSha256 uses the service formula (lowercased EVM, network|asset|amount|payTo)", () => {
  const want = createHash("sha256").update(["eip155:8453", REQUIREMENT.asset.toLowerCase(), "10000", REQUIREMENT.payTo].join("|")).digest("hex");
  assert.equal(termsSha256(REQUIREMENT), want);
  assert.equal(termsSha256({ ...REQUIREMENT, payTo: REQUIREMENT.payTo.toUpperCase().replace("0X", "0x") }), want);
  const sol = { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1", payTo: "AbC" };
  assert.notEqual(termsSha256(sol), termsSha256({ ...sol, payTo: "abc" }), "solana addresses stay case-sensitive");
});

test("termsMismatch: hash and payment-object forms", () => {
  assert.equal(termsMismatch(REQUIREMENT, { payment_terms_sha256: termsSha256(REQUIREMENT) }), "");
  assert.match(termsMismatch({ ...REQUIREMENT, amount: "10001" }, { payment_terms_sha256: termsSha256(REQUIREMENT) }), /terms differ/);
  const payment = { network: "eip155:8453", asset: REQUIREMENT.asset, amount: { atomic: "10000", usd: 0.01 }, pay_to: REQUIREMENT.payTo };
  assert.equal(termsMismatch(REQUIREMENT, { payment }), "");
  assert.match(termsMismatch({ ...REQUIREMENT, amount: "20000" }, { payment }), /above approved/);
  assert.match(termsMismatch({ ...REQUIREMENT, payTo: "0x2222222222222222222222222222222222222222" }, { payment }), /payTo/);
  assert.match(termsMismatch(REQUIREMENT, {}), /no approved terms/);
});

test("decide: pay allows, skip/recheck/unavailable/quota-402 block by default", async () => {
  const pay = await run("pay");
  assert.equal(pay.allow, true);
  assert.deepEqual(Object.keys(pay.check).sort(), ["approved_terms_sha256", "checked_at", "endpoint", "method", "reason_code", "receipt_url", "terms_sha256", "verdict"]);
  assert.equal(pay.check.checked_at, "2026-10-27T15:00:00Z");
  for (const v of ["skip", "recheck", "down", "quota"]) assert.equal((await run(v)).allow, false, v);
  assert.equal((await run("recheck", { allowRecheck: true })).allow, true);
  assert.equal((await run("down", { allowIfUnavailable: true })).allow, true);
  assert.equal((await run("quota")).reason_code, "spot_check_unavailable");
});

test("decide: pay answer for different terms is blocked as terms_mismatch", async () => {
  const g = await decide({ url: RESOURCE, requirement: { ...REQUIREMENT, amount: "99999" } }, { fetch: stubSpotFetch("pay"), now: NOW });
  assert.equal(g.allow, false);
  assert.equal(g.reason_code, "terms_mismatch");
});

test("decide: query carries url, ref and method=POST; never sends payment headers", async () => {
  const f = stubSpotFetch("pay");
  let init;
  const spy = async (u, i) => { init = i; return f(u, i); };
  await decide({ url: RESOURCE, method: "POST", requirement: REQUIREMENT }, { fetch: spy, client: "c1" });
  const u = new URL(f.calls[0]);
  assert.equal(u.origin + u.pathname, "https://api.402xagent.com/v1/products/endpoint-spot-check");
  assert.equal(u.searchParams.get("url"), RESOURCE);
  assert.equal(u.searchParams.get("method"), "POST");
  assert.equal(u.searchParams.get("client"), "c1");
  assert.equal(u.searchParams.get("ref"), "via-decision-gate");
  assert.deepEqual(Object.keys(init.headers), ["accept"]);
});

test("AP2 risk_data entry shape and mandate merge", async () => {
  const { check } = await run("pay");
  const e = ap2RiskDataEntry(check);
  assert.deepEqual(Object.keys(e), [RISK_KEY]);
  assert.equal(RISK_KEY, "com.402xagent.check");
  assert.deepEqual(Object.keys(e[RISK_KEY]), ["v", "verdict", "reason_code", "checked_at", "endpoint", "terms_sha256", "terms_match", "receipt_url", "source"]);
  assert.equal(e[RISK_KEY].verdict, "pay");
  assert.equal(e[RISK_KEY].reason_code, "price_ok");
  assert.equal(e[RISK_KEY].endpoint, RESOURCE);
  assert.match(e[RISK_KEY].terms_sha256, /^[0-9a-f]{64}$/);
  assert.equal(e[RISK_KEY].terms_match, true);
  assert.doesNotThrow(() => JSON.stringify(e));
  const mandate = { vct: "mandate.payment.1", transaction_id: "t", payee: { id: "m" }, payment_amount: { currency: "USD", amount: 1 }, payment_instrument: { type: "x402" }, risk_data: { other: 1 } };
  const m2 = attachToPaymentMandate(mandate, check);
  assert.equal(m2.risk_data.other, 1, "keeps other risk signals");
  assert.deepEqual(m2.risk_data[RISK_KEY], e[RISK_KEY]);
  assert.equal(mandate.risk_data[RISK_KEY], undefined, "input not mutated");
  assert.equal(ap2RiskDataEntry((await run("skip")).check)[RISK_KEY].terms_match, null);
  assert.throws(() => ap2RiskDataEntry({}), TypeError);
});

test("check-before-sign: signs only on pay", async () => {
  const ok = await payIfSafe({ url: RESOURCE, fetchTarget: async () => seller402(), spotOpts: { fetch: stubSpotFetch("pay") } });
  assert.equal(ok.paid, true);
  for (const v of ["skip", "recheck", "down"]) {
    const r = await payIfSafe({ url: RESOURCE, fetchTarget: async () => seller402(), spotOpts: { fetch: stubSpotFetch(v) } });
    assert.equal(r.paid, false, v);
    assert.equal(r.signature, undefined);
  }
  const no402 = await payIfSafe({ url: RESOURCE, fetchTarget: async () => new Response("ok"), spotOpts: { fetch: stubSpotFetch("pay") } });
  assert.equal(no402.paid, false);
});

test("Mastercard check-before-voucher: stub voucher only requested on pay", async () => {
  const mk = () => ({ calls: [], async requestVoucher(a) { this.calls.push(a); return { stub: true, voucher_id: "STUB" }; } });
  const mc = mk();
  const ok = await checkBeforeVoucher({ url: RESOURCE, requirement: REQUIREMENT, spotOpts: { fetch: stubSpotFetch("pay") }, mc });
  assert.equal(ok.voucher.stub, true);
  assert.equal(mc.calls.length, 1);
  assert.deepEqual(mc.calls[0].amountMinor, 1);
  assert.equal(mc.calls[0].riskSignals["com.402xagent.check"].verdict, "pay");
  const mc2 = mk();
  const blocked = await checkBeforeVoucher({ url: RESOURCE, requirement: REQUIREMENT, spotOpts: { fetch: stubSpotFetch("skip") }, mc: mc2 });
  assert.equal(blocked.voucher, null);
  assert.equal(blocked.blocked, "skip/pay_to_mismatch");
  assert.equal(mc2.calls.length, 0, "no credential requested when not pay");
});

test("Verifiable Intent counterparty_check constraint", async () => {
  const c = counterpartyConstraint();
  assert.deepEqual(c, { type: VI_TYPE, allowed_verdicts: ["pay"], max_age_s: 300, service: "https://api.402xagent.com" });
  assert.equal(VI_TYPE, "com.402xagent.counterparty_check");
  const { check } = await run("pay");
  assert.equal(satisfies(c, check, new Date("2026-10-27T15:04:00Z")).ok, true);
  assert.equal(satisfies(c, check, new Date("2026-10-27T15:06:00Z")).ok, false);
  assert.equal(satisfies(c, (await run("skip")).check, new Date("2026-10-27T15:01:00Z")).ok, false);
  assert.equal(satisfies({ type: "x" }, check).ok, false);
});
