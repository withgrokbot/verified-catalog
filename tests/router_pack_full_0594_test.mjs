// 0.59.5: a router-pack receipt (the router tier's paid settlement) is a paid receipt: served in the full view, like paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptIsFull, redactReceipt } from "../worker/src/lib.js";
const rec = (tier) => ({ id: "sc-0000000000000abc", verdict: "pay", reason: "r", access_tier: tier, live_402: { accepts: [{ network: "eip155:8453", pay_to: "0x" + "22".repeat(20), amount: "1000" }] }, live_demand: { http_status: 402, x402_challenge: true } });
test("0.59.5 router-pack receipts are full (not the redacted free view)", () => {
  assert.equal(receiptIsFull(rec("router-pack")), true);
  assert.deepEqual(redactReceipt(rec("router-pack")), rec("router-pack"));
});
test("0.59.5 other tiers unchanged", () => {
  for (const t of ["paid", "router-prepaid", "exempt", "hosted"]) assert.equal(receiptIsFull(rec(t)), true, t);
  for (const t of ["free", "bazaar", "auto", undefined]) assert.equal(receiptIsFull(rec(t)), false, String(t));
});
