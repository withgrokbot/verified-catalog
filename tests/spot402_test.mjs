// 0.50.2: the endpoint-spot-check 402 body is trimmed to < 4 KB. Accepts must stay byte-identical to 0.50.1
// (snapshot in fixtures/spot402_0.50.1.json); long docs/examples move to GET /v1/products/endpoint-spot-check/docs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker/src/index.js";
import { spotPaymentRequired, spotCfg } from "../worker/src/lib.js";
const b64encode = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const SNAP = JSON.parse(readFileSync(new URL("./fixtures/spot402_0.50.1.json", import.meta.url), "utf8"));
const env = { DATA_BASE_URL: "https://data.fixture/vc/", CLIENT_SALT: "s", PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", ENDPOINT_REPORT: "1" };
const R = "https://api.402xagent.com/v1/products/endpoint-spot-check";
const go = (p, init) => worker.fetch(new Request(R + p, init), env, { waitUntil() {} });
const LIMIT = 4096;
// fields existing x402 clients and our own SDK read from the 402 body
const REQUIRED = ["x402Version", "error", "resource", "accepts", "price_usd", "asset", "product", "free_per_day", "free_used_today", "free_resets", "free_check", "how_to_pay"];

function checkBody(name, t, hdr) {
  assert.ok(t.length < LIMIT, `${name}: body ${t.length} bytes >= ${LIMIT}`);
  const j = JSON.parse(t);
  assert.equal(JSON.stringify(j.accepts), SNAP[name].accepts, `${name}: accepts byte-identical to 0.50.1`);
  for (const k of REQUIRED) assert.ok(k in j, `${name}: missing ${k}`);
  assert.equal(j.x402Version, 2);
  const a = j.accepts[0];
  assert.equal(a.amount, "20000"); assert.equal(a.network, "eip155:8453");
  assert.ok(a.asset && a.payTo);
  assert.match(j.docs, /\/v1\/products\/endpoint-spot-check\/docs$/);
  if (hdr !== undefined) {
    assert.ok(hdr, `${name}: PAYMENT-REQUIRED header present`);
    const h = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
    assert.equal(h.x402Version, 2);
    assert.equal(JSON.stringify(h.accepts), SNAP[name].accepts, `${name}: header accepts identical`);
    assert.ok(hdr.length < 6 * 1024, `${name}: header ${hdr.length} chars`);
  }
  return j;
}

test("0.50.2 discovery 402 (no url): < 4 KB, accepts identical, header intact, discovery fields kept", async () => {
  const r = await go("");
  assert.equal(r.status, 402);
  const j = checkBody("discovery", await r.text(), r.headers.get("payment-required"));
  assert.equal(j.discovery, true); assert.equal(j.field, "url"); assert.ok(j.example && j.hint && j.pricing);
  assert.ok(j.extensions && j.extensions.bazaar && j.extensions.bazaar.info.input.method === "GET", "Bazaar input metadata kept");
});

test("0.50.2 placeholder 402: < 4 KB, accepts identical; with a payment header still a strict 400 (input_error behaviour)", async () => {
  const r = await go("?url=https://example.com/api/paid");
  assert.equal(r.status, 402);
  checkBody("placeholder", await r.text(), r.headers.get("payment-required") || undefined);
  const r2 = await go("?url=https://example.com/api/paid", { headers: { "payment-signature": "e30=" } });
  assert.equal(r2.status, 400);
});

test("0.50.2 deny 402 body (free quota used): < 4 KB, accepts identical", () => {
  const d = spotPaymentRequired(spotCfg(env), R, "Free checks used.", 5, "https://seller.fixture/x");
  checkBody("deny", JSON.stringify(d)); // served compact via json402c
  assert.ok(b64encode(d).length < 6 * 1024);
});

test("0.50.2 GET /v1/products/endpoint-spot-check/docs: free 200 JSON with the moved examples + full Bazaar schema", async () => {
  const r = await go("/docs");
  assert.equal(r.status, 200);
  const j = await r.json();
  for (const k of ["paid_fields", "paid_example", "paid_example_note", "free_example", "skips_page", "bazaar"]) assert.ok(k in j, "docs missing " + k);
  assert.ok(j.bazaar.schema && j.bazaar.info.output.example);
});
