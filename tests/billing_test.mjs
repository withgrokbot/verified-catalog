// 0.66.0 render billing: off by default / without secrets, Stripe Checkout + portal (Stripe mocked, no network), webhook
// signature (valid, invalid, stale, multiple v1), idempotency by event id, plan changes, downgrade at period end, hard cap
// kept, and no API key ever sent to Stripe, stored, or echoed. D1 is in-memory SQLite with every migration (local only).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";
import { QuotaCounter } from "../worker/src/lib.js";
import { hashKey, RENDER_PDF_PATH, handleRender } from "../worker/src/render.js";
import { verifyStripeSignature, hmacHex, timingSafeEqual, formEncode, BILLING_CHECKOUT_PATH, BILLING_PORTAL_PATH, BILLING_WEBHOOK_PATH } from "../worker/src/billing.js";
import { sqliteD1 as d1 } from "./helpers/sqlite_d1.mjs";

const API = "https://api.402xagent.com";
const WHSEC = "whsec_test_fixture";
const SK = "rk_test_fixture_secret";
let stripeCalls = [];
globalThis.fetch = async (u, init = {}) => {
  const s = String(u && u.url ? u.url : u);
  if (s.startsWith("https://api.stripe.com/v1/")) {
    stripeCalls.push({ url: s, headers: init.headers, body: String(init.body || "") });
    if (s.endsWith("/checkout/sessions")) return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    if (s.endsWith("/billing_portal/sessions")) return Response.json({ id: "bps_1", url: "https://billing.stripe.com/p/session/bps_1" });
    return Response.json({ error: { type: "invalid_request_error", message: "No such thing: " + init.body } }, { status: 400 });
  }
  if (s.startsWith("https://cloudflare-dns.com/")) return Response.json({ Answer: [{ type: 1, data: "93.184.216.34" }] });
  return new Response("nope", { status: 404 });
};
function quotaNs() {
  const objs = new Map();
  return { idFromName: (n) => n, get: (id) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new QuotaCounter({ storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) } }, {})); } const o = objs.get(id); return { fetch: (u) => o.fetch(new Request(u)) }; } };
}
const env = (x = {}) => ({ RENDER: "1", BILLING: "1", STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_PRO: "price_pro", CLIENT_SALT: "t", QUOTA: quotaNs(), RECEIPTS_DB: d1(), BROWSER: {}, ...x });
const RAW = "rk_" + "A".repeat(32);
async function addKey(e, id = "key-1", raw = RAW) {
  await e.RECEIPTS_DB.prepare("INSERT INTO api_keys (id, key_hash, email_hash, plan, monthly_quota, status, created_at, updated_at) VALUES (?, ?, 'eh-' || ?, 'free', 500, 'active', 0, 0)").bind(id, await hashKey(e, raw), id).run();
}
const keyRow = (e, id = "key-1") => e.RECEIPTS_DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(id).first();
const W = (e, p, init = {}) => worker.fetch(new Request(API + p, { method: "POST", ...init }), e, { waitUntil() {} });
const T0 = new Date("2026-11-04T22:00:00Z"), t0 = Math.floor(T0.getTime() / 1000);
async function signed(e, ev, { t = Math.floor(Date.now() / 1000), secret = WHSEC, extra = "" } = {}) {
  const raw = JSON.stringify(ev);
  return W(e, BILLING_WEBHOOK_PATH, { headers: { "stripe-signature": `t=${t},v1=${await hmacHex(secret, `${t}.${raw}`)}${extra}`, "content-type": "application/json" }, body: raw });
}
const nowS = () => Math.floor(Date.now() / 1000);
const subEv = (id, status, price, extra = {}) => ({ id, type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status, metadata: { key_id: "key-1" }, items: { data: [{ price: { id: price } }] }, current_period_end: nowS() + 86400 * 20, ...extra } } });
const completed = (id, plan) => ({ id, type: "checkout.session.completed", data: { object: { mode: "subscription", payment_status: "paid", client_reference_id: "key-1", customer: "cus_1", subscription: "sub_1", metadata: { key_id: "key-1", plan } } } });

test("off by default, and off when any Stripe secret or price is missing: every billing route 404s", async () => {
  for (const x of [{ BILLING: undefined }, { STRIPE_SECRET_KEY: undefined }, { STRIPE_WEBHOOK_SECRET: "" }, { STRIPE_PRICE_PRO: undefined }]) {
    const e = env(x); await addKey(e);
    for (const p of [BILLING_CHECKOUT_PATH, BILLING_PORTAL_PATH, BILLING_WEBHOOK_PATH]) assert.equal((await W(e, p, { headers: { "x-api-key": RAW }, body: "{}" })).status, 404, p + " " + JSON.stringify(x));
  }
  const docs = await (await worker.fetch(new Request(API + "/v1/render/docs"), env({ BILLING: undefined }), { waitUntil() {} })).json();
  assert.equal(docs.billing, undefined);
});

test("checkout: subscription session for starter/pro with the configured price; only the key's internal id goes to Stripe", async () => {
  const e = env(); await addKey(e); stripeCalls = [];
  assert.equal((await W(e, BILLING_CHECKOUT_PATH, { body: JSON.stringify({ plan: "pro" }) })).status, 401);
  assert.equal((await W(e, BILLING_CHECKOUT_PATH, { headers: { "x-api-key": "rk_wrong" }, body: JSON.stringify({ plan: "pro" }) })).status, 401);
  assert.equal((await W(e, BILLING_CHECKOUT_PATH, { headers: { "x-api-key": RAW }, body: JSON.stringify({ plan: "enterprise" }) })).status, 400);
  const r = await W(e, BILLING_CHECKOUT_PATH, { headers: { "x-api-key": RAW }, body: JSON.stringify({ plan: "pro" }) });
  assert.equal(r.status, 200); const b = await r.json(); assert.equal(b.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(stripeCalls.length, 1); const c = stripeCalls[0]; const q = new URLSearchParams(c.body);
  assert.equal(q.get("mode"), "subscription"); assert.equal(q.get("line_items[0][price]"), "price_pro"); assert.equal(q.get("line_items[0][quantity]"), "1");
  assert.equal(q.get("client_reference_id"), "key-1"); assert.equal(q.get("subscription_data[metadata][key_id]"), "key-1");
  assert.equal(c.headers.authorization, "Bearer " + SK); assert.ok(c.headers["idempotency-key"]);
  assert.ok(!c.body.includes(RAW) && !JSON.stringify(c.headers).includes(RAW), "the API key never goes to Stripe");
  assert.ok(!JSON.stringify(b).includes(RAW) && !JSON.stringify(b).includes(SK));
  assert.equal(new URLSearchParams(formEncode({ a: { 0: { b: 1 } } })).get("a[0][b]"), "1");
});

test("portal: needs a Stripe customer; returns the portal url; Stripe errors are not echoed", async () => {
  const e = env(); await addKey(e); stripeCalls = [];
  assert.equal((await W(e, BILLING_PORTAL_PATH, { headers: { "x-api-key": RAW } })).status, 404);
  await e.RECEIPTS_DB.prepare("UPDATE api_keys SET stripe_customer_id = 'cus_1'").run();
  const r = await W(e, BILLING_PORTAL_PATH, { headers: { "x-api-key": RAW } });
  assert.equal(r.status, 200); assert.equal((await r.json()).url, "https://billing.stripe.com/p/session/bps_1");
  assert.equal(new URLSearchParams(stripeCalls[0].body).get("customer"), "cus_1");
  assert.equal(new URLSearchParams(stripeCalls[0].body).get("return_url"), API + "/v1/render/docs");
  assert.equal(new URLSearchParams(stripeCalls[0].body).get("configuration"), null, "unset portal configuration is omitted");
  e.STRIPE_PORTAL_CONFIGURATION = "bpc_test";
  const cfg = await W(e, BILLING_PORTAL_PATH, { headers: { "x-api-key": RAW } });
  assert.equal(cfg.status, 200);
  const q = new URLSearchParams(stripeCalls.at(-1).body);
  assert.equal(q.get("configuration"), "bpc_test");
  assert.equal(q.get("customer"), "cus_1");
  assert.equal(q.get("return_url"), API + "/v1/render/docs");
  await e.RECEIPTS_DB.prepare("UPDATE api_keys SET stripe_customer_id = 'cus_bad'").run();
  const saved = globalThis.fetch; globalThis.fetch = async () => Response.json({ error: { type: "invalid_request_error", message: "No such customer cus_bad " + SK } }, { status: 400 });
  const bad = await W(e, BILLING_PORTAL_PATH, { headers: { "x-api-key": RAW } }); globalThis.fetch = saved;
  assert.equal(bad.status, 502); const t = await bad.text(); assert.ok(!t.includes(SK) && !t.includes("cus_bad")); assert.match(t, /stripe_invalid_request_error/);
});

test("webhook signature: valid accepted; wrong secret, tampered body, missing header and stale timestamp rejected; any v1 may match", async () => {
  const e = env(); await addKey(e);
  assert.equal((await signed(e, completed("evt_ok", "starter"))).status, 200);
  assert.equal((await signed(e, completed("evt_a", "pro"), { secret: "whsec_other" })).status, 400);
  const raw = JSON.stringify(completed("evt_b", "pro")); const t = nowS(); const sig = await hmacHex(WHSEC, `${t}.${raw}`);
  assert.equal((await W(e, BILLING_WEBHOOK_PATH, { headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: raw.replace("pro", "starter") })).status, 400, "tampered");
  assert.equal((await W(e, BILLING_WEBHOOK_PATH, { body: raw })).status, 400, "no header");
  const stale = await signed(e, completed("evt_c", "pro"), { t: nowS() - 301 }); assert.equal(stale.status, 400); assert.equal((await stale.json()).reason, "stale");
  assert.equal((await signed(e, completed("evt_d", "pro"), { t: nowS() + 301 })).status, 400, "future");
  assert.equal((await verifyStripeSignature(`t=${t},v1=${"0".repeat(64)},v1=${sig}`, raw, WHSEC)).ok, true, "rotated secrets: second v1 matches");
  assert.equal((await verifyStripeSignature(`t=${t},v0=${sig}`, raw, WHSEC)).reason, "malformed");
  assert.equal((await keyRow(e)).plan, "starter", "rejected events changed nothing");
  assert.ok(timingSafeEqual("abc", "abc") && !timingSafeEqual("abc", "abd") && !timingSafeEqual("abc", "ab") && !timingSafeEqual("ab", "abc"));
});

test("idempotency: a redelivered event id is acknowledged once and not applied again", async () => {
  const e = env(); await addKey(e);
  await signed(e, completed("evt_1", "starter"));
  await signed(e, subEv("evt_2", "active", "price_pro")); assert.equal((await keyRow(e)).plan, "pro");
  const again = await signed(e, completed("evt_1", "starter"));
  assert.equal(again.status, 200); assert.equal((await again.json()).duplicate, true);
  assert.equal((await keyRow(e)).plan, "pro", "the replayed checkout did not move the key back to starter");
  assert.equal((await e.RECEIPTS_DB.prepare("SELECT COUNT(*) AS n FROM stripe_events").first()).n, 2);
});

test("plan changes: checkout -> starter 5,000; upgrade -> pro 25,000; downgrade -> starter; quota stays a hard cap", async () => {
  const e = env(); await addKey(e);
  await signed(e, completed("evt_s", "starter")); let k = await keyRow(e);
  assert.deepEqual([k.plan, k.monthly_quota, k.stripe_customer_id, k.stripe_subscription_id, k.plan_ends_at], ["starter", 5000, "cus_1", "sub_1", null]);
  await signed(e, subEv("evt_up", "active", "price_pro")); k = await keyRow(e); assert.deepEqual([k.plan, k.monthly_quota], ["pro", 25000]);
  await signed(e, subEv("evt_down", "active", "price_starter")); k = await keyRow(e); assert.deepEqual([k.plan, k.monthly_quota], ["starter", 5000]);
  assert.equal((await (await signed(e, subEv("evt_x", "active", "price_unknown"))).json()).outcome, "ignored_status");
  // hard cap still applies on a paid plan: at quota -> 429, nothing billed
  await e.RECEIPTS_DB.prepare("UPDATE api_keys SET monthly_quota = 1").run();
  const call = () => { const url = new URL(API + RENDER_PDF_PATH); return handleRender(new Request(url, { method: "POST", headers: { "x-api-key": RAW, "cf-connecting-ip": "203.0.113." + Math.floor(Math.random() * 250) }, body: JSON.stringify({ url: "https://ok.fixture/" }) }), e, {}, url, "pdf", { launch: async () => ({ newPage: async () => ({ setRequestInterception: async () => {}, on: () => {}, goto: async () => ({ status: () => 200 }), pdf: async () => new Uint8Array(10) }), close: async () => {} }) }); };
  assert.equal((await call()).status, 200); const r = await call(); assert.equal(r.status, 429); assert.equal((await r.json()).reason, "quota_exceeded");
});

test("downgrade: cancel at period end, past_due and deletion keep the paid plan until period end, then free (500)", async () => {
  for (const [name, ev] of [
    ["cancel_at_period_end", subEv("evt_c1", "active", "price_pro", { cancel_at_period_end: true })],
    ["past_due", subEv("evt_p1", "past_due", "price_pro")],
    ["deleted_mid_period", { id: "evt_d1", type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "canceled", metadata: { key_id: "key-1" }, current_period_end: nowS() + 86400 * 20 } } }],
  ]) {
    const e = env(); await addKey(e); await signed(e, completed("evt_0", "pro"));
    await signed(e, ev); let k = await keyRow(e);
    assert.equal(k.plan, "pro", name + ": still pro until period end"); assert.ok(k.plan_ends_at > nowS(), name);
    const later = new Date((k.plan_ends_at + 1) * 1000);
    const url = new URL(API + RENDER_PDF_PATH);
    await handleRender(new Request(url, { method: "POST", headers: { "x-api-key": RAW, "cf-connecting-ip": "198.51.100.9" }, body: JSON.stringify({ url: "https://ok.fixture/" }) }), e, {}, url, "pdf", { now: later, launch: async () => ({ newPage: async () => ({ setRequestInterception: async () => {}, on: () => {}, goto: async () => ({ status: () => 200 }), pdf: async () => new Uint8Array(10) }), close: async () => {} }) });
    k = await keyRow(e); assert.deepEqual([k.plan, k.monthly_quota, k.plan_ends_at], ["free", 500, null], name + ": free after period end");
  }
  const e = env(); await addKey(e); await signed(e, completed("evt_0", "pro"));
  await signed(e, { id: "evt_gone", type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "canceled", metadata: {}, current_period_end: nowS() - 10 } } });
  assert.deepEqual([(await keyRow(e)).plan, (await keyRow(e)).monthly_quota], ["free", 500], "period already over -> free now");
  // resubscribe/reactivate clears a pending downgrade
  const e2 = env(); await addKey(e2); await signed(e2, completed("evt_0", "pro"));
  await signed(e2, subEv("evt_c", "active", "price_pro", { cancel_at_period_end: true })); assert.ok((await keyRow(e2)).plan_ends_at);
  await signed(e2, subEv("evt_r", "active", "price_pro", { cancel_at_period_end: false })); assert.equal((await keyRow(e2)).plan_ends_at, null);
});

test("no leaks: D1 rows hold only Stripe ids, docs list the plans, and the raw key or secrets never appear", async () => {
  const e = env(); await addKey(e); await signed(e, completed("evt_z", "starter"));
  const dump = JSON.stringify([await keyRow(e), (await e.RECEIPTS_DB.prepare("SELECT * FROM stripe_events").all()).results]);
  for (const s of [RAW, SK, WHSEC]) assert.ok(!dump.includes(s));
  const docs = await (await worker.fetch(new Request(API + "/v1/render/docs"), e, { waitUntil() {} })).json();
  assert.equal(docs.billing.enabled, true); assert.match(docs.billing.rules[0], /hard cap/);
  assert.deepEqual([docs.price.plans.starter.usd_per_month, docs.price.plans.starter.monthly_renders, docs.price.plans.pro.usd_per_month, docs.price.plans.pro.monthly_renders], [10, 5000, 29, 25000]);
  for (const s of [RAW, SK, WHSEC, "price_pro"]) assert.ok(!JSON.stringify(docs).includes(s));
});

// ---- 0.66.1 grace period after invoice.payment_failed
const failed = (id, created) => ({ id, type: "invoice.payment_failed", created, data: { object: { subscription: "sub_1", customer: "cus_1", lines: { data: [{ period: { end: nowS() + 86400 * 20 } }] } } } });
const fakeLaunch = async () => ({ newPage: async () => ({ setRequestInterception: async () => {}, on: () => {}, goto: async () => ({ status: () => 200 }), pdf: async () => new Uint8Array(10) }), close: async () => {} });
const useKey = (e, now) => { const url = new URL(API + RENDER_PDF_PATH); return handleRender(new Request(url, { method: "POST", headers: { "x-api-key": RAW, "cf-connecting-ip": "198.51.100." + Math.floor(Math.random() * 250) }, body: JSON.stringify({ url: "https://ok.fixture/" }) }), e, {}, url, "pdf", { now, launch: fakeLaunch }); };

test("grace: payment_failed keeps the paid plan for 3 days from the event time, then free (500) on next use", async () => {
  const e = env(); await addKey(e); await signed(e, completed("evt_0", "pro"));
  const created = nowS() - 3600;
  const r = await signed(e, failed("evt_f", created)); assert.equal((await r.json()).outcome, "grace_until_later");
  let k = await keyRow(e); assert.equal(k.plan, "pro"); assert.equal(k.grace_ends_at, created + 3 * 86400); assert.equal(k.plan_ends_at, null, "grace is separate from the period end");
  assert.equal((await useKey(e, new Date((created + 3 * 86400 - 60) * 1000))).status, 200);
  k = await keyRow(e); assert.deepEqual([k.plan, k.monthly_quota], ["pro", 25000], "inside the grace window");
  const res = await useKey(e, new Date((created + 3 * 86400 + 1) * 1000));
  assert.equal(res.headers.get("x-quota-limit"), "500");
  k = await keyRow(e); assert.deepEqual([k.plan, k.monthly_quota, k.grace_ends_at], ["free", 500, null], "expired grace drops to free");
  // a second failure never extends an earlier grace end
  const e2 = env(); await addKey(e2); await signed(e2, completed("evt_0", "pro"));
  await signed(e2, failed("evt_f1", created)); await signed(e2, failed("evt_f2", created + 86400));
  assert.equal((await keyRow(e2)).grace_ends_at, created + 3 * 86400);
});

test("grace recovery: a later successful payment or a subscription update to active clears it; cancel-at-period-end is kept", async () => {
  for (const rec of [
    { id: "evt_paid", type: "invoice.paid", data: { object: { subscription: "sub_1" } } },
    { id: "evt_ok", type: "invoice.payment_succeeded", data: { object: { parent: { subscription_details: { subscription: "sub_1" } } } } },
    subEv("evt_active", "active", "price_pro"),
  ]) {
    const e = env(); await addKey(e); await signed(e, completed("evt_0", "pro"));
    await signed(e, failed("evt_f", nowS())); assert.ok((await keyRow(e)).grace_ends_at, rec.type);
    await signed(e, rec); const k = await keyRow(e); assert.equal(k.grace_ends_at, null, rec.type + " clears grace"); assert.equal(k.plan, "pro");
    await useKey(e, new Date((nowS() + 10 * 86400) * 1000)); assert.equal((await keyRow(e)).plan, "pro", rec.type + ": no drop after recovery");
  }
  const e = env(); await addKey(e); await signed(e, completed("evt_0", "pro"));
  await signed(e, subEv("evt_c", "active", "price_pro", { cancel_at_period_end: true }));
  const ends = (await keyRow(e)).plan_ends_at;
  await signed(e, failed("evt_f", nowS())); await signed(e, { id: "evt_p", type: "invoice.paid", data: { object: { subscription: "sub_1" } } });
  assert.equal((await keyRow(e)).plan_ends_at, ends, "a recovered payment does not undo a cancel at period end");
});

test("grace: BILLING_GRACE_DAYS is configurable (0 = drop on next use; bad values fall back to 3)", async () => {
  const { graceDays } = await import("../worker/src/billing.js");
  assert.equal(graceDays({}), 3); assert.equal(graceDays({ BILLING_GRACE_DAYS: "7" }), 7); assert.equal(graceDays({ BILLING_GRACE_DAYS: "-1" }), 3); assert.equal(graceDays({ BILLING_GRACE_DAYS: "abc" }), 3); assert.equal(graceDays({ BILLING_GRACE_DAYS: "0" }), 0);
  const e = env({ BILLING_GRACE_DAYS: "7" }); await addKey(e); await signed(e, completed("evt_0", "pro"));
  const c = nowS(); await signed(e, failed("evt_f", c)); assert.equal((await keyRow(e)).grace_ends_at, c + 7 * 86400);
  const z = env({ BILLING_GRACE_DAYS: "0" }); await addKey(z); await signed(z, completed("evt_0", "pro"));
  await signed(z, failed("evt_f", nowS() - 5)); await useKey(z, new Date()); assert.equal((await keyRow(z)).plan, "free");
  const docs = await (await worker.fetch(new Request(API + "/v1/render/docs"), e, { waitUntil() {} })).json();
  assert.match(docs.billing.rules[1], /7-day grace period/);
});
