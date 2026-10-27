// 0.52.0 spot funnel module: digests, SQL, summary (liteConversion), admin auth, cap-hit 402 size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { funnelDigest, funnelEvent, funnelSql, funnelSummary, handleFunnelAdmin } from "../worker/src/funnel.js";
import { spotPaymentRequired, spotCapHitOffer, spotCfg } from "../worker/src/lib.js";

test("digest is per-day, salted and never contains the key", async () => {
  const a = await funnelDigest("s", "ip:abc", "2026-10-27"), b = await funnelDigest("s", "ip:abc", "2026-10-28");
  assert.match(a, /^[0-9a-f]{32}$/); assert.notEqual(a, b);
  assert.notEqual(a, await funnelDigest("t", "ip:abc", "2026-10-27"));
});

test("funnelEvent ignores unknown events and never throws", () => {
  const pts = [];
  assert.equal(funnelEvent({ FUNNEL: { writeDataPoint: (p) => pts.push(p) } }, { event: "bogus", digest: "d" }), false);
  assert.equal(funnelEvent({ FUNNEL: { writeDataPoint() { throw new Error("x"); } } }, { event: "paid", digest: "d" }), false);
  assert.equal(funnelEvent({}, { event: "paid", digest: "d" }), false);
  assert.equal(pts.length, 0);
});

test("SQL clamps days and excludes self-test rows", () => {
  const q = funnelSql("999");
  assert.equal(q.days, 30);
  assert.match(q.daily, /double3 = 0/); assert.match(q.top, /blob1 = 'cap_hit'/);
  assert.equal(funnelSql("x").days, 7);
});

test("summary: liteConversion = paid digests / cap_hit digests", () => {
  const s = funnelSummary([
    { day: "2026-10-27 00:00:00", event: "free_check", digests: 40, events: 120 },
    { day: "2026-10-27 00:00:00", event: "cap_hit", digests: 10, events: 300 },
    { day: "2026-10-27 00:00:00", event: "paid", digests: 1, events: 1 },
  ], [{ ua: "node", digest_days: 3, cap_hits: 90 }], 7);
  assert.equal(s.liteConversion, 0.1);
  assert.equal(s.daily[0].liteConversion, 0.1);
  assert.equal(s.top_cap_hitters_by_ua[0].ua, "node");
  assert.equal(funnelSummary([], [], 7).liteConversion, null);
});

test("admin: 404 without the right bearer, 503 unconfigured, 200 with the AE read", async () => {
  const req = (tok) => new Request("https://api.402xagent.com/v1/admin/funnel?days=3", { headers: tok ? { authorization: "Bearer " + tok } : {} });
  assert.equal((await handleFunnelAdmin(req(), { FUNNEL_ADMIN_TOKEN: "k" })).status, 404);
  assert.equal((await handleFunnelAdmin(req("bad"), { FUNNEL_ADMIN_TOKEN: "k" })).status, 404);
  assert.equal((await handleFunnelAdmin(req("k"), {})).status, 404, "no token configured = closed");
  assert.equal((await handleFunnelAdmin(req("k"), { FUNNEL_ADMIN_TOKEN: "k" })).status, 503);
  const sqls = [];
  const fetchImpl = async (u, i) => { sqls.push(i.body); return Response.json({ data: /blob3 AS ua/.test(i.body) ? [] : [{ day: "2026-10-27", event: "cap_hit", digests: 2, events: 5 }] }); };
  const r = await handleFunnelAdmin(req("k"), { FUNNEL_ADMIN_TOKEN: "k", CF_ACCOUNT_ID: "acc", AE_READ_TOKEN: "t" }, { fetchImpl });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.days, 3); assert.equal(j.totals.cap_hit_digest_days, 2); assert.equal(j.liteConversion, 0);
  assert.ok(sqls.every((s) => /INTERVAL '3' DAY/.test(s)));
});

test("cap-hit 402 stays < 4 KB with the offer; accepts unchanged; price fields match accepts", () => {
  const c = spotCfg({ PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674" });
  const R = "https://api.402xagent.com/v1/products/endpoint-spot-check";
  const base = spotPaymentRequired(c, R, "Free 402xAgent checks used up for today (5 per UTC day). Pay $0.02 USDC on Base via x402 to continue.", 5, "https://seller.example.org/api/v1/x");
  const body = { ...base, ...spotCapHitOffer(c) };
  const t = JSON.stringify(body);
  assert.ok(t.length < 4096, "body " + t.length);
  assert.ok(Buffer.from(t).toString("base64").length < 6 * 1024);
  assert.deepEqual(body.accepts, base.accepts);
  const a = body.accepts[0];
  assert.equal(body.price.amount_atomic, a.amount); assert.equal(body.price.pay_to, a.payTo); assert.equal(body.price.network, a.network); assert.equal(body.price.asset, a.asset);
  assert.equal(body.price.amount_usd, "0.02");
  assert.match(body.verdict_note, /Same verdict/);
});
