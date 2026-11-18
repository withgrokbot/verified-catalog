// 0.72.1: the paid_check offer also on discover (HTTP, MCP) and MCP get_receipt (tests in discover_test.mjs and worker_test.mjs).
// Here: it stays OFF facilitator-check and payment-status.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";

test("0.72.1 version", () => assert.equal(VERSION, "0.77.2"));

test("facilitator/check and payment-status answers carry no paid_check (live routes, non-404)", async () => {
  const env = { CLIENT_SALT: "t", PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674" };
  for (const [m, path, body] of [["GET", "/v1/products/payment-status"], ["POST", "/v1/products/payment-status", "{}"], ["GET", "/v1/facilitator/check"], ["POST", "/v1/facilitator/check", "{}"]]) {
    const r = await worker.fetch(new Request("https://api.402xagent.com" + path, { method: m, body, headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.30" } }), env, { waitUntil() {} });
    const txt = await r.text();
    assert.notEqual(r.status, 404, m + " " + path + " must be a live route (a 404 would make the next assertion vacuous)");
    assert.ok(!txt.includes("paid_check"), m + " " + path + " (" + r.status + ")");
  }
});
