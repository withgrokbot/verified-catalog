// 0.52.0 spot funnel module: digests, SQL, summary (liteConversion), admin auth, cap-hit 402 size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { funnelDigest, funnelEvent, funnelSql, funnelSummary, handleFunnelAdmin, callsSql, callKind, callsSummary, callerClass, callHost } from "../worker/src/funnel.js";
import { spotPaymentRequired, spotCapHitOffer, spotCfg } from "../worker/src/lib.js";

test("digest is per-day, salted and never contains the key", async () => {
  const a = await funnelDigest("s", "ip:abc", "2026-10-27"), b = await funnelDigest("s", "ip:abc", "2026-10-28");
  assert.match(a, /^[0-9a-f]{32}$/); assert.notEqual(a, b);
  assert.notEqual(a, await funnelDigest("t", "ip:abc", "2026-10-27"));
  assert.equal(await funnelDigest("", "ip:abc", "2026-10-27"), "", "no salt = no digest");
  assert.equal(await funnelDigest(undefined, "ip:abc", "2026-10-27"), "");
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

test("call kind uses fields already on vc_lookups; dry runs and prepaid credits are not the three counters", () => {
  assert.equal(callKind({ product: "lookup", access: "free", status: 200 }), "free_checks");
  assert.equal(callKind({ product: "spot", access: "exempt", status: 200 }), "free_checks");
  assert.equal(callKind({ product: "spot", access: "partner", status: 200 }), "free_checks");
  assert.equal(callKind({ product: "lookup-paid", access: "paid", status: 200 }), "paid_events");
  assert.equal(callKind({ product: "spot", access: "paid-unstored", status: 503 }), "paid_events");
  assert.equal(callKind({ product: "lookup", access: "payment-required", status: 402 }), "payment_required_402");
  assert.equal(callKind({ product: "spot", access: "payment-failed", status: 402 }), "payment_required_402");
  assert.equal(callKind({ product: "view", access: "view-pack-402", status: 402 }), "payment_required_402");
  assert.equal(callKind({ product: "spot", access: "dry-run", status: 200 }), "");
  assert.equal(callKind({ product: "lookup", access: "lookup-usage", status: 200 }), "");
  assert.equal(callKind({ product: "spot", access: "router-prepaid", status: 200 }), "");
  assert.equal(callerClass("self"), "self");
  assert.equal(callerClass("scanner"), "outside");
  assert.equal(callerClass(""), "outside");
  assert.equal(callHost("verified-catalog-lookup.withgrokbot.workers.dev"), "workers.dev");
  assert.equal(callHost("api.payscout.dev"), "payscout");
  assert.equal(callHost("api.402xagent.com"), "api.402xagent.com");
  assert.equal(callHost(""), "unrecorded");
  assert.equal(callHost("evil.example"), "other");
});

test("calls summary splits self and outside and buckets hosts", () => {
  const s = callsSummary([
    { day: "2026-11-09 00:00:00", reason: "self", access: "exempt", product: "spot", host: "api.402xagent.com", status: 200, n: 4 },
    { day: "2026-11-09 00:00:00", reason: "", access: "free", product: "lookup", host: "x.withgrokbot.workers.dev", status: 200, n: 3 },
    { day: "2026-11-09 00:00:00", reason: "scanner", access: "payment-required", product: "lookup", host: "api.402xagent.com", status: 402, n: 2 },
    { day: "2026-11-09 00:00:00", reason: "self", access: "payment-failed", product: "spot", host: "", status: 402, n: 1 },
    { day: "2026-11-09 00:00:00", reason: "", access: "paid", product: "lookup-paid", host: "402xagent.com", status: 200, n: 1 },
    { day: "2026-11-09 00:00:00", reason: "self", access: "paid-unstored", product: "spot", host: "api.payscout.dev", status: 503, n: 1 },
    { day: "2026-11-09 00:00:00", reason: "", access: "dry-run", product: "spot", host: "api.402xagent.com", status: 200, n: 9 },
    { day: "2026-11-08 00:00:00", reason: "self", access: "partner", product: "spot", host: "evil.example", status: 200, n: 2 },
  ]);
  assert.deepEqual(s.daily.map((d) => d.day), ["2026-11-08", "2026-11-09"]);
  const d = s.daily[1];
  assert.deepEqual(d.free_checks, { total: 7, self: 4, outside: 3 });
  assert.deepEqual(d.payment_required_402, { total: 3, self: 1, outside: 2 });
  assert.deepEqual(d.paid_events, { total: 2, self: 1, outside: 1 });
  assert.deepEqual(d.by_host["api.402xagent.com"].free_checks, { total: 4, self: 4, outside: 0 });
  assert.deepEqual(d.by_host["workers.dev"].free_checks, { total: 3, self: 0, outside: 3 });
  assert.deepEqual(d.by_host["unrecorded"].payment_required_402, { total: 1, self: 1, outside: 0 });
  assert.deepEqual(d.by_host["402xagent.com"].paid_events, { total: 1, self: 0, outside: 1 });
  assert.deepEqual(d.by_host["payscout"].paid_events, { total: 1, self: 1, outside: 0 });
  assert.equal(d.by_host["api.402xagent.com"].paid_events.total, 0);
  assert.deepEqual(s.daily[0].by_host.other.free_checks, { total: 2, self: 2, outside: 0 });
  assert.deepEqual(s.totals.free_checks, { total: 9, self: 6, outside: 3 });
  assert.deepEqual(s.totals.paid_events, { total: 2, self: 1, outside: 1 });
  assert.deepEqual(Object.keys(d.by_host), ["402xagent.com", "api.402xagent.com", "payscout", "unrecorded", "workers.dev"]);
});

test("admin calls: mocked AE fetch, self/outside/host, no personal columns", async () => {
  const sqls = [];
  const rows = [
    { day: "2026-11-09 00:00:00", reason: "self", access: "exempt", product: "spot", host: "api.402xagent.com", status: 200, n: 4 },
    { day: "2026-11-09 00:00:00", reason: "", access: "free", product: "spot", host: "402xagent.com", status: 200, n: 1 },
    { day: "2026-11-09 00:00:00", reason: "", access: "payment-required", product: "lookup", host: "api.402xagent.com", status: 402, n: 2 },
    { day: "2026-11-09 00:00:00", reason: "self", access: "paid", product: "spot", host: "api.402xagent.com", status: 200, n: 1 },
  ];
  const fetchImpl = async (u, i) => {
    sqls.push(i.body);
    assert.equal(i.method, "POST");
    assert.equal(i.headers.authorization, "Bearer read-token");
    assert.match(u, /\/accounts\/acc\/analytics_engine\/sql$/);
    if (/vc_lookups/.test(i.body)) return Response.json({ data: rows });
    if (/blob3 AS ua/.test(i.body)) return Response.json({ data: [] });
    return Response.json({ data: [{ day: "2026-11-09", event: "paid", digests: 1, events: 1 }, { day: "2026-11-09", event: "cap_hit", digests: 4, events: 4 }] });
  };
  const req = new Request("https://api.402xagent.com/v1/admin/funnel?days=3", { headers: { authorization: "Bearer secret" } });
  const r = await handleFunnelAdmin(req, { FUNNEL_ADMIN_TOKEN: "secret", CF_ACCOUNT_ID: "acc", AE_READ_TOKEN: "read-token" }, { fetchImpl });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.days, 3);
  assert.equal(j.daily[0].paid_events, 1, "spot-funnel sample count is unchanged");
  assert.equal(j.liteConversion, 0.25);
  const day = j.calls[0];
  assert.equal(day.day, "2026-11-09");
  assert.deepEqual(day.free_checks, { total: 5, self: 4, outside: 1 });
  assert.deepEqual(day.payment_required_402, { total: 2, self: 0, outside: 2 });
  assert.deepEqual(day.paid_events, { total: 1, self: 1, outside: 0 });
  assert.deepEqual(day.by_host["api.402xagent.com"].free_checks, { total: 4, self: 4, outside: 0 });
  assert.deepEqual(day.by_host["402xagent.com"].free_checks, { total: 1, self: 0, outside: 1 });
  assert.deepEqual(j.calls_totals.free_checks, { total: 5, self: 4, outside: 1 });
  assert.match(j.calls_definition, /history is the Analytics Engine retention/);
  assert.match(j.calls_definition, /No new blobs in 0.69.1/);
  const lookups = sqls.filter((s) => /vc_lookups/.test(s));
  assert.equal(lookups.length, 1);
  assert.match(lookups[0], /INTERVAL '3' DAY/);
  assert.match(lookups[0], /blob6 AS reason/);
  assert.match(lookups[0], /blob20 AS host/);
  assert.match(lookups[0], /SUM\(_sample_interval\)/);
  assert.doesNotMatch(lookups[0], /\bblob1 AS|\bblob7\b|\bblob8\b|\bblob12\b|\bblob14\b|\bblob15\b/);
  assert.equal(callsSql(3), lookups[0]);
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
