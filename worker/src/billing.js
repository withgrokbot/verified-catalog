// Render API billing (0.66.0, OFF by default): Stripe monthly plans for API keys. BILLING must be "1" AND the secrets
// STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET AND the vars STRIPE_PRICE_STARTER + STRIPE_PRICE_PRO must be set, else every
// billing route 404s. Plans: starter $10 = 5,000 renders/month, pro $29 = 25,000. The monthly quota stays a HARD CAP:
// nothing is metered or billed as overage. Cancel or a failed payment keeps the plan to the end of the paid period, then
// the key drops to free (500/month). A social card (0.67.0) spends one render on this same quota; the grace period
// still applies, because the card path loads the key through loadKey / applyPlanEnd.
//   POST /v1/render/billing/checkout {plan: "starter"|"pro"}  (x-api-key)  -> {url} Stripe Checkout (mode=subscription)
//   POST /v1/render/billing/portal                            (x-api-key)  -> {url} Stripe customer portal (optional STRIPE_PORTAL_CONFIGURATION, omitted when unset)
//   POST /v1/render/billing/webhook                           (Stripe)     -> signature-checked, idempotent by event id
// Stripe only ever sees the key's internal id (a UUID), never the API key.
import { API_ORIGIN } from "./spotcheck.js";
import { RENDER_PLANS, keyFromReq, loadKey } from "./render.js";
import { EMAIL_PLANS } from "./email.js";

export const BILLING_CHECKOUT_PATH = "/v1/render/billing/checkout";
export const BILLING_PORTAL_PATH = "/v1/render/billing/portal";
export const BILLING_WEBHOOK_PATH = "/v1/render/billing/webhook";
export const STRIPE_API = "https://api.stripe.com/v1";
export const WEBHOOK_TOLERANCE_S = 300;
export const DEFAULT_GRACE_DAYS = 3;
/** BILLING_GRACE_DAYS: whole or fractional days, 0-30; anything else = 3. */
export function graceDays(env) { const n = Number(env && env.BILLING_GRACE_DAYS); return env && env.BILLING_GRACE_DAYS !== undefined && env.BILLING_GRACE_DAYS !== "" && Number.isFinite(n) && n >= 0 && n <= 30 ? n : DEFAULT_GRACE_DAYS; }
export const billingOn = (env) => String((env && env.BILLING) || "") === "1";
export const billingReady = (env) => billingOn(env) && !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_STARTER && env.STRIPE_PRICE_PRO && env.RECEIPTS_DB);
const PAID = ["starter", "pro"];
const priceFor = (env, plan) => (plan === "starter" ? env.STRIPE_PRICE_STARTER : plan === "pro" ? env.STRIPE_PRICE_PRO : null);
/** A configured Stripe price id, or null when the value is missing, blank, or only whitespace. */
export function configuredPriceId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
export const planForPrice = (env, price) => {
  const id = configuredPriceId(price);
  if (!id || !env) return null;
  if (id === configuredPriceId(env.STRIPE_PRICE_STARTER)) return "starter";
  if (id === configuredPriceId(env.STRIPE_PRICE_PRO)) return "pro";
  return null;
};
/** Email plan for a Stripe price id. STRIPE_PRICE_EMAIL_STARTER / PRO / SCALE must be non-blank.
 * A missing, blank, or whitespace-only value never equals a price id, and never selects a plan. The free tier has no price id. A render price id never maps to an email plan. */
export function emailPlanForPrice(env, price) {
  const id = configuredPriceId(price);
  if (!id || !env) return null;
  if (id === configuredPriceId(env.STRIPE_PRICE_STARTER) || id === configuredPriceId(env.STRIPE_PRICE_PRO)) return null;
  const table = [["STRIPE_PRICE_EMAIL_STARTER", "starter"], ["STRIPE_PRICE_EMAIL_PRO", "pro"], ["STRIPE_PRICE_EMAIL_SCALE", "scale"]];
  for (const [key, plan] of table) { const configured = configuredPriceId(env[key]); if (configured && id === configured) return plan; }
  return null;
}
/** {product:"render"|"email", plan} or null. Render price ids win, so existing render mapping is unchanged when email price ids are blank. */
export function priceToPlan(env, price) {
  const render = planForPrice(env, price);
  if (render) return { product: "render", plan: render };
  const email = emailPlanForPrice(env, price);
  return email ? { product: "email", plan: email } : null;
}
const J = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
const NF = () => J({ error: "not found" }, 404);
const nowS = (now) => Math.floor((now || new Date()).getTime() / 1000);

// ---------- Stripe REST (form-encoded) ----------
export function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out); else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  }
  return out.join("&");
}
async function stripe(env, path, params, idem) {
  let r;
  try {
    r = await fetch(STRIPE_API + path, { method: "POST", headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded", ...(idem ? { "idempotency-key": idem } : {}) }, body: formEncode(params), signal: AbortSignal.timeout(10000) });
  } catch (_) { return { ok: false, status: 502, error: "stripe_unreachable" }; }
  let j = {}; try { j = await r.json(); } catch (_) {}
  // never echo Stripe's error text (it can quote request parameters); a short code is enough
  return r.ok ? { ok: true, body: j } : { ok: false, status: 502, error: "stripe_" + ((j.error && j.error.type) || r.status) };
}

async function authKey(req, env) {
  const raw = keyFromReq(req);
  if (!raw) return { res: J({ error: "send your API key as x-api-key" }, 401) };
  const key = await loadKey(env, raw);
  if (!key || key.status !== "active") return { res: J({ error: "unknown or inactive api key" }, 401) };
  return { key };
}
async function bodyJson(req) { try { const t = await req.text(); return t ? JSON.parse(t) : {}; } catch (_) { return null; } }

export async function handleCheckout(req, env) {
  if (!billingReady(env)) return NF();
  if (req.method !== "POST") return J({ error: "use POST" }, 405, { allow: "POST" });
  const a = await authKey(req, env); if (a.res) return a.res;
  const b = await bodyJson(req);
  const plan = b && b.plan;
  if (!PAID.includes(plan)) return J({ error: "plan must be starter ($10, 5,000 renders/month) or pro ($29, 25,000 renders/month)" }, 400);
  const row = await env.RECEIPTS_DB.prepare("SELECT stripe_customer_id, stripe_subscription_id FROM api_keys WHERE id = ?").bind(a.key.id).first();
  if (row && row.stripe_subscription_id && a.key.plan !== "free") return J({ error: "this key already has a subscription; change or cancel it in the billing portal", portal: API_ORIGIN + BILLING_PORTAL_PATH }, 409);
  const r = await stripe(env, "/checkout/sessions", {
    mode: "subscription", line_items: { 0: { price: priceFor(env, plan), quantity: 1 } },
    client_reference_id: a.key.id, metadata: { key_id: a.key.id, plan }, subscription_data: { metadata: { key_id: a.key.id, plan } },
    ...(row && row.stripe_customer_id ? { customer: row.stripe_customer_id } : {}),
    success_url: API_ORIGIN + "/v1/render/docs?billing=success", cancel_url: API_ORIGIN + "/v1/render/docs?billing=cancelled",
  }, `checkout-${a.key.id}-${plan}-${Math.floor(Date.now() / 600000)}`);
  if (!r.ok) return J({ error: "could not start checkout", reason: r.error }, r.status);
  return J({ url: r.body.url, plan, note: "The new quota applies when Stripe confirms the payment. The quota is a hard cap; nothing is billed as overage." });
}

export async function handlePortal(req, env) {
  if (!billingReady(env)) return NF();
  if (req.method !== "POST") return J({ error: "use POST" }, 405, { allow: "POST" });
  const a = await authKey(req, env); if (a.res) return a.res;
  const row = await env.RECEIPTS_DB.prepare("SELECT stripe_customer_id FROM api_keys WHERE id = ?").bind(a.key.id).first();
  if (!row || !row.stripe_customer_id) return J({ error: "no billing account for this key yet; start with " + BILLING_CHECKOUT_PATH }, 404);
  const r = await stripe(env, "/billing_portal/sessions", { customer: row.stripe_customer_id, return_url: API_ORIGIN + "/v1/render/docs", configuration: env.STRIPE_PORTAL_CONFIGURATION || undefined });
  if (!r.ok) return J({ error: "could not open the billing portal", reason: r.error }, r.status);
  return J({ url: r.body.url });
}

// ---------- webhook ----------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
export function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ (b.charCodeAt(i) | 0);
  return d === 0;
}
/** Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]. HMAC-SHA256 over `${t}.${rawBody}`, constant-time compare, |now - t| <= tolerance. */
export async function verifyStripeSignature(header, raw, secret, now = new Date(), tolerance = WEBHOOK_TOLERANCE_S) {
  const parts = String(header || "").split(",").map((p) => p.trim().split("="));
  const t = Number((parts.find(([k]) => k === "t") || [])[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v || "");
  if (!Number.isInteger(t) || !sigs.length) return { ok: false, reason: "malformed" };
  if (Math.abs(nowS(now) - t) > tolerance) return { ok: false, reason: "stale" };
  const want = await hmacHex(secret, `${t}.${raw}`);
  let match = false; for (const s of sigs) match = timingSafeEqual(want, s) || match; // check all, no early exit
  return match ? { ok: true } : { ok: false, reason: "bad_signature" };
}

async function setPlan(env, where, plan, fields = {}, now) {
  const p = RENDER_PLANS[plan] || RENDER_PLANS.free;
  const sets = ["plan = ?", "monthly_quota = ?", "updated_at = ?"], vals = [plan, p.quota, nowS(now)];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  const r = await env.RECEIPTS_DB.prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE ${where.sql}`).bind(...vals, ...where.vals).run();
  return (r.meta && r.meta.changes) || 0;
}
const bySub = (sub, keyId) => keyId ? { sql: "id = ?", vals: [keyId] } : { sql: "stripe_subscription_id = ?", vals: [sub] };
const byEmailSub = (sub, keyId) => keyId ? { sql: "id = ?", vals: [keyId] } : { sql: "email_stripe_subscription_id = ?", vals: [sub] };
const periodEnd = (sub) => Number(sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || 0) || null;
const subPrice = (o) => o && o.items && o.items.data && o.items.data[0] && o.items.data[0].price && o.items.data[0].price.id;
const eventPrice = (o) => configuredPriceId(subPrice(o) || (o && o.metadata && o.metadata.price));
const EMAIL_FIELDS = new Set(["email_stripe_subscription_id", "email_grace_ends_at"]);
async function setEmailPlan(env, where, plan, fields = {}, now = new Date()) {
  const p = EMAIL_PLANS[plan] || EMAIL_PLANS.free;
  const sets = ["email_plan = ?", "email_monthly_quota = ?", "updated_at = ?"], vals = [plan, p.quota, nowS(now)];
  for (const [k, v] of Object.entries(fields)) { if (!EMAIL_FIELDS.has(k)) continue; sets.push(`${k} = ?`); vals.push(v); }
  const r = await env.RECEIPTS_DB.prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE ${where.sql}`).bind(...vals, ...where.vals).run();
  return (r.meta && r.meta.changes) || 0;
}
async function markEmailGrace(env, where, sub, now, at) {
  const until = at + Math.round(graceDays(env) * 86400);
  const r = await env.RECEIPTS_DB.prepare(`UPDATE api_keys SET email_stripe_subscription_id = COALESCE(email_stripe_subscription_id, ?), email_grace_ends_at = CASE WHEN email_grace_ends_at IS NULL OR email_grace_ends_at > ? THEN ? ELSE email_grace_ends_at END, updated_at = ? WHERE ${where.sql} AND email_plan != 'free'`).bind(sub, until, until, nowS(now), ...where.vals).run();
  return { changes: (r.meta && r.meta.changes) || 0, until };
}

/** Apply one verified event. Returns a short outcome string (no ids or keys). */
export async function applyEvent(env, ev, now = new Date()) {
  const o = (ev && ev.data && ev.data.object) || {};
  switch (ev.type) {
    case "checkout.session.completed": {
      if (o.mode !== "subscription") return "ignored_mode";
      const keyId = o.client_reference_id || (o.metadata && o.metadata.key_id);
      const plan = o.metadata && o.metadata.plan;
      if (o.payment_status && o.payment_status !== "paid" && o.payment_status !== "no_payment_required") return "ignored_unpaid";
      if (o.metadata && o.metadata.product === "email") {
        const emailPlan = emailPlanForPrice(env, eventPrice(o));
        if (!emailPlan) return "ignored_no_price";
        if (!keyId) return "ignored_no_key";
        const fields = { email_grace_ends_at: null };
        if (o.subscription) fields.email_stripe_subscription_id = o.subscription;
        const n = await setEmailPlan(env, { sql: "id = ?", vals: [keyId] }, emailPlan, fields, now);
        return n ? "email_plan_" + emailPlan : "unknown_key";
      }
      if (!keyId || !PAID.includes(plan)) return "ignored_no_key";
      const n = await setPlan(env, { sql: "id = ?", vals: [keyId] }, plan, { stripe_customer_id: o.customer || null, stripe_subscription_id: o.subscription || null, plan_ends_at: null, grace_ends_at: null }, now);
      return n ? "plan_" + plan : "unknown_key";
    }
    case "customer.subscription.updated": {
      const keyId = o.metadata && o.metadata.key_id;
      const price = subPrice(o);
      const emailPlan = emailPlanForPrice(env, price);
      const emailTagged = !!(o.metadata && o.metadata.product === "email");
      if (emailPlan || emailTagged) {
        const where = byEmailSub(o.id, keyId);
        if (["active", "trialing"].includes(o.status) && emailPlan) {
          const n = await setEmailPlan(env, where, emailPlan, { email_stripe_subscription_id: o.id || null, email_grace_ends_at: null }, now);
          return n ? "email_plan_" + emailPlan : "unknown_key";
        }
        if (emailPlan && ["past_due", "unpaid"].includes(o.status)) {
          const g = await markEmailGrace(env, where, o.id, now, Number(ev.created) || nowS(now));
          return g.changes ? "email_grace_until_" + (g.until <= nowS(now) ? "now" : "later") : "unknown_key";
        }
        if (emailPlan && ["incomplete_expired", "canceled", "paused"].includes(o.status)) {
          const n = await setEmailPlan(env, where, "free", { email_grace_ends_at: null }, now);
          return n ? "email_free" : "unknown_key";
        }
        return emailPlan ? "ignored_status" : "ignored_no_price";
      }
      const plan = planForPrice(env, price);
      if (["active", "trialing"].includes(o.status) && plan) {
        const ends = o.cancel_at_period_end ? periodEnd(o) : (o.cancel_at ? Number(o.cancel_at) : null);
        const n = await setPlan(env, bySub(o.id, keyId), plan, { stripe_subscription_id: o.id, stripe_customer_id: o.customer || null, plan_ends_at: ends, grace_ends_at: null }, now);
        return n ? (ends ? "plan_" + plan + "_until_period_end" : "plan_" + plan) : "unknown_key";
      }
      if (["past_due", "unpaid", "incomplete_expired", "canceled", "paused"].includes(o.status)) return endAtPeriod(env, bySub(o.id, keyId), periodEnd(o), now);
      return "ignored_status";
    }
    case "customer.subscription.deleted": {
      const price = subPrice(o);
      if (emailPlanForPrice(env, price) || (o.metadata && o.metadata.product === "email")) {
        if (!emailPlanForPrice(env, price)) return "ignored_no_price";
        const n = await setEmailPlan(env, byEmailSub(o.id, o.metadata && o.metadata.key_id), "free", { email_grace_ends_at: null }, now);
        return n ? "email_free" : "unknown_key";
      }
      return endAtPeriod(env, bySub(o.id, o.metadata && o.metadata.key_id), periodEnd(o), now);
    }
    case "invoice.payment_failed": {
      const sub = o.subscription || (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription);
      if (!sub) return "ignored_no_subscription";
      // grace: keep the paid plan for BILLING_GRACE_DAYS from the event time; an earlier grace end is never extended.
      // The same window applies to an email subscription, stored on email_grace_ends_at so it does not clobber render grace.
      const at = Number(ev.created) || nowS(now);
      const until = at + Math.round(graceDays(env) * 86400);
      const email = await markEmailGrace(env, { sql: "email_stripe_subscription_id = ?", vals: [sub] }, sub, now, at);
      const r = await env.RECEIPTS_DB.prepare("UPDATE api_keys SET grace_ends_at = CASE WHEN grace_ends_at IS NULL OR grace_ends_at > ? THEN ? ELSE grace_ends_at END, updated_at = ? WHERE stripe_subscription_id = ? AND plan != 'free'").bind(until, until, nowS(now), sub).run();
      if (r.meta && r.meta.changes) return "grace_until_" + (until <= nowS(now) ? "now" : "later");
      if (email.changes) return "email_grace_until_" + (email.until <= nowS(now) ? "now" : "later");
      return "unknown_key";
    }
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const sub = o.subscription || (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription);
      if (!sub) return "ignored_no_subscription";
      const email = await env.RECEIPTS_DB.prepare("UPDATE api_keys SET email_grace_ends_at = NULL, updated_at = ? WHERE email_stripe_subscription_id = ? AND email_grace_ends_at IS NOT NULL").bind(nowS(now), sub).run();
      const r = await env.RECEIPTS_DB.prepare("UPDATE api_keys SET grace_ends_at = NULL, updated_at = ? WHERE stripe_subscription_id = ? AND grace_ends_at IS NOT NULL").bind(nowS(now), sub).run();
      if (r.meta && r.meta.changes) return "grace_cleared";
      if (email.meta && email.meta.changes) return "email_grace_cleared";
      return "no_grace";
    }
    default: return "ignored_type";
  }
}
/** Keep the paid plan until `end`, then free. If the period is already over (or unknown), free now. Never extends a date. */
async function endAtPeriod(env, where, end, now) {
  const t = nowS(now);
  if (!end || end <= t) { const n = await setPlan(env, where, "free", { plan_ends_at: null, grace_ends_at: null }, now); return n ? "free_now" : "unknown_key"; }
  const r = await env.RECEIPTS_DB.prepare(`UPDATE api_keys SET plan_ends_at = CASE WHEN plan_ends_at IS NULL OR plan_ends_at > ? THEN ? ELSE plan_ends_at END, updated_at = ? WHERE ${where.sql}`).bind(end, end, t, ...where.vals).run();
  return (r.meta && r.meta.changes) ? "free_at_period_end" : "unknown_key";
}

export async function handleWebhook(req, env, ctx, url, opts = {}) {
  if (!billingReady(env)) return NF();
  if (req.method !== "POST") return J({ error: "use POST" }, 405, { allow: "POST" });
  const raw = await req.text();
  if (raw.length > 512 * 1024) return J({ error: "too large" }, 413);
  const now = opts.now || new Date();
  const v = await verifyStripeSignature(req.headers.get("stripe-signature"), raw, env.STRIPE_WEBHOOK_SECRET, now);
  if (!v.ok) return J({ error: "invalid signature", reason: v.reason }, 400);
  let ev; try { ev = JSON.parse(raw); } catch (_) { return J({ error: "bad json" }, 400); }
  if (!ev || typeof ev.id !== "string" || typeof ev.type !== "string") return J({ error: "bad event" }, 400);
  try { await env.RECEIPTS_DB.prepare("INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)").bind(ev.id, ev.type, nowS(now)).run(); }
  catch (_) { return J({ received: true, duplicate: true }); }
  let outcome;
  try { outcome = await applyEvent(env, ev, now); }
  catch (_) { // let Stripe retry: forget the event id
    await env.RECEIPTS_DB.prepare("DELETE FROM stripe_events WHERE id = ?").bind(ev.id).run().catch(() => {});
    return J({ error: "could not apply event" }, 500);
  }
  return J({ received: true, outcome });
}

/** Lazy downgrade used by the render key path (only with BILLING=1): a key past plan_ends_at becomes free. */
export async function applyPlanEnd(env, key, now = new Date()) {
  const t = nowS(now);
  const due = (v) => v != null && Number(v) <= t;
  if (!key || key.plan === "free" || !(due(key.plan_ends_at) || due(key.grace_ends_at))) return key;
  await env.RECEIPTS_DB.prepare("UPDATE api_keys SET plan = 'free', monthly_quota = ?, plan_ends_at = NULL, grace_ends_at = NULL, updated_at = ? WHERE id = ? AND ((plan_ends_at IS NOT NULL AND plan_ends_at <= ?) OR (grace_ends_at IS NOT NULL AND grace_ends_at <= ?))").bind(RENDER_PLANS.free.quota, t, key.id, t, t).run();
  return { ...key, plan: "free", monthly_quota: RENDER_PLANS.free.quota, plan_ends_at: null, grace_ends_at: null };
}

export function billingDocs(env) {
  return {
    enabled: billingReady(env),
    checkout: { method: "POST", url: API_ORIGIN + BILLING_CHECKOUT_PATH, auth: "x-api-key", body: { plan: "starter | pro" }, returns: "{url} of a Stripe Checkout page" },
    portal: { method: "POST", url: API_ORIGIN + BILLING_PORTAL_PATH, auth: "x-api-key", returns: "{url} of the Stripe billing portal (change plan, card, cancel)" },
    rules: ["The plan's monthly quota is a hard cap. Nothing is metered or billed as overage; at quota you get 429 with an upgrade note.",
      `Cancel keeps the paid plan until the end of the paid period. A failed payment keeps it for a ${graceDays(env)}-day grace period (a later successful payment clears it). After that the key returns to free (500 renders a month). The same grace applies to an email subscription, then that plan returns to the free tier (100 validations a month).`,
      "Stripe sees an internal key id only, never your API key.",
      "A PDF, a screenshot and a social card each spend one render. A failed render is refunded. A cached card is free."],
  };
}
