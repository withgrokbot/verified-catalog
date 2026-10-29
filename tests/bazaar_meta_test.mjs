// 0.58.9: Bazaar service metadata (x402 v2 specs/extensions/bazaar.md, "Service Metadata on resource") on every
// 402xAgent check-family 402. Locks the values, the spec limits, and that nothing else in any 402 changed vs 0.58.7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bodies402 } from "./helpers/bodies402.mjs";
import { snapshot } from "./helpers/machine_snapshot.mjs";
import { BAZAAR_SERVICE_NAME, BAZAAR_ICON_URL, BAZAAR_META, bazaarServiceMeta } from "../worker/src/spotcheck.js";
import { spotCfg, spotPaymentRequired, paidPaymentRequired, paymentRequired, psPaymentRequired, erPaymentRequired, bulkPaymentRequired, cfg } from "../worker/src/lib.js";

const W = fileURLToPath(new URL("../worker/src/index.js", import.meta.url));
const fx = (f) => JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/machine_0.58.7/" + f, import.meta.url)), "utf8"));
const META = ["serviceName", "tags", "iconUrl"];
const ASCII = /^[\x20-\x7e]+$/;

test("0.58.9 Bazaar metadata values and spec limits", () => {
  assert.equal(BAZAAR_SERVICE_NAME, "402xAgent Check");
  assert.equal(BAZAAR_ICON_URL, "https://402xagent.com/apple-touch-icon.png");
  assert.ok(BAZAAR_SERVICE_NAME.length <= 32 && ASCII.test(BAZAAR_SERVICE_NAME));
  for (const [k, m] of Object.entries(BAZAAR_META)) {
    assert.ok(m.tags.length <= 5, k);
    assert.equal(new Set(m.tags.map((t) => t.toLowerCase())).size, m.tags.length, k);
    for (const t of m.tags) assert.ok(t.length <= 32 && ASCII.test(t), k + " " + t);
    assert.deepEqual(Object.keys(bazaarServiceMeta(k)), META);
  }
  const c = spotCfg({ PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674" });
  const d = BAZAAR_META.spot.description(c);
  assert.ok(d.length <= 500, "CDP rejects descriptions over 500");
  assert.match(d, /\$0\.02 USDC on Base after 5 free checks per UTC day\.$/);
  assert.match(d, /Never pays the target/);
});

test("0.58.9 every builder carries the metadata; price, free tier and accepts unchanged", () => {
  const PAY_TO = "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674";
  const c = spotCfg({ PAY_TO }), lc = cfg({ PAY_TO, PRICE_ATOMIC: "20000" }), R = "https://api.402xagent.com/v1/x";
  const all = { spot: spotPaymentRequired(c, R, "e", 5), lookupPaid: paidPaymentRequired(lc, R, "e"), lookup: paymentRequired(lc, new URL(R), "e", 5),
    ps: psPaymentRequired(c, R, "e", 5), er: erPaymentRequired(c, R, "e"), bulk: bulkPaymentRequired(c, R, "e", 2) };
  for (const [k, b] of Object.entries(all)) {
    assert.equal(b.resource.serviceName, "402xAgent Check", k);
    assert.equal(b.resource.iconUrl, BAZAAR_ICON_URL, k);
    assert.ok(b.resource.tags.length <= 5, k);
  }
  assert.equal(all.spot.accepts[0].amount, "20000");
  assert.equal(all.spot.free_per_day, 5);
  assert.equal(all.spot.resource.description, BAZAAR_META.spot.description(c));
});

test("0.58.9 each 0.58.7 402 differs only in resource serviceName/tags/iconUrl (+ spot-check description); header = body", async () => {
  const old = fx("bodies402.json"), now = await bodies402(W);
  assert.deepEqual(Object.keys(now.bodies).sort(), Object.keys(old.bodies).sort(), "same set of 402 answers");
  for (const [k, o] of Object.entries(old.bodies)) {
    const n = now.bodies[k], ob = JSON.parse(o.body), nb = JSON.parse(n.body);
    const isSpot = /endpoint-spot-check/.test(nb.resource.url), isPack = /overnight-cos-pack/.test(nb.resource.url);
    if (isPack) { assert.equal(n.body, o.body, k); continue; } // a different product: untouched
    assert.equal(nb.resource.serviceName, "402xAgent Check", k);
    assert.equal(nb.resource.iconUrl, BAZAAR_ICON_URL, k);
    const back = { ...nb, resource: { ...nb.resource } };
    for (const f of META) { if (f in ob.resource) back.resource[f] = ob.resource[f]; else delete back.resource[f]; }
    if (isSpot) back.resource.description = ob.resource.description;
    assert.equal(JSON.stringify(back, null, o.body.startsWith("{\n") ? 2 : 0), o.body, k + ": nothing but the metadata changed (key order kept)");
    const hdr = n.headers["payment-required"];
    if (hdr) assert.deepEqual(JSON.parse(Buffer.from(hdr, "base64").toString()), nb, k);
    const strip = (h) => Object.fromEntries(Object.entries(h).filter(([x]) => !["payment-required", "content-length"].includes(x)));
    assert.deepEqual(strip(n.headers), strip(o.headers), k + ": other headers identical");
  }
});

test("0.58.9 every non-402 surface byte-identical to 0.58.7 (status, headers, body sha256)", async () => {
  const want = fx("snapshot.json"), got = await snapshot(W), old = fx("bodies402.json").bodies;
  const diff = Object.keys(want).filter((k) => !(k in old) && JSON.stringify(got[k]) !== JSON.stringify(want[k]));
  assert.deepEqual(diff, []);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort());
});
