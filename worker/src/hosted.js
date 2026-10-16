// 0.41.0 hosted mode, part one: opt-in integrator keys (routers, wallets), metering and receipts. No invoices yet.
// Keys: "402x_live_<8 hex id>_<43 char base64url secret>", sent as `Authorization: Bearer <key>` or `x-402xagent-key`.
// D1 stores only sha256(pepper ":" secret); the pepper is the Worker secret HOSTED_KEY_PEPPER. No KV.
// Prices (Max 2026-10-16): 1,000 free hosted checks per integrator (lifetime), then $0.02; a billable check after the
// 1,000th billable one in a UTC calendar month is $0.01 (marginal). Cached answers are billable. Credit limit (computed from
// hosted_usage): $20 until the first invoice is paid, then $100; over it the call falls back to the normal x402 path.
// A request with neither header never reaches this code path (byte-for-byte unchanged).

export const HOSTED_FREE_TOTAL = 1000;
export const HOSTED_VOLUME_AFTER = 1000;
export const HOSTED_STANDARD_ATOMIC = 20000;
export const HOSTED_VOLUME_ATOMIC = 10000;
export const HOSTED_CREDIT_FIRST_ATOMIC = 20_000000;
export const HOSTED_CREDIT_ATOMIC = 100_000000;
export const HOSTED_PER_MIN = 120;
export const KEY_RE = /^402x_live_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

/** The raw key the caller sent, or null when the request carries no integrator key at all. */
export function hostedKeyFrom(req) {
  const x = req.headers.get("x-402xagent-key");
  if (x != null && x !== "") return x.trim();
  const a = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(402x_\S+)$/i.exec(a.trim());
  return m ? m[1] : null;
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function eq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export const keyHash = (pepper, secret) => sha256hex(String(pepper) + ":" + String(secret));
export const utcMonth = (now = new Date()) => now.toISOString().slice(0, 7);

/** Price for the next hosted check from the meter. */
export function hostedPrice(meter, integ) {
  const freeTotal = Number(integ.free_total ?? HOSTED_FREE_TOTAL);
  if (Number(meter.total || 0) < freeTotal) return { price_atomic: 0, band: "free_allowance" };
  if (Number(meter.month_billable || 0) >= HOSTED_VOLUME_AFTER) return { price_atomic: HOSTED_VOLUME_ATOMIC, band: "volume" };
  return { price_atomic: HOSTED_STANDARD_ATOMIC, band: "standard" };
}
export const creditLimitAtomic = (integ) => (Number(integ.first_invoice_paid || 0) ? HOSTED_CREDIT_ATOMIC : HOSTED_CREDIT_FIRST_ATOMIC);

export async function readMeter(env, id, month) {
  const r = await env.RECEIPTS_DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN month = ?1 THEN 1 ELSE 0 END) AS month_checks, SUM(CASE WHEN month = ?1 AND price_atomic > 0 THEN 1 ELSE 0 END) AS month_billable, SUM(CASE WHEN invoiced = 0 THEN price_atomic ELSE 0 END) AS outstanding_atomic FROM hosted_usage WHERE integrator_id = ?2",
  ).bind(month, id).first();
  return { total: Number((r && r.total) || 0), month_checks: Number((r && r.month_checks) || 0), month_billable: Number((r && r.month_billable) || 0), outstanding_atomic: Number((r && r.outstanding_atomic) || 0) };
}

const err = (status, code, error) => ({ response: { status, body: { error, code, docs: "https://402xagent.com/docs#hosted" } } });

/**
 * null: no key sent (normal path). {response}: refuse (401/429/501/503). {fallback}: over the credit limit, use normal x402.
 * {ok}: hosted call, with {integ, price_atomic, band, month, meter, end_user_hash}.
 */
export async function resolveHosted(env, req, { takeFree, salt, now = new Date() } = {}) {
  const raw = hostedKeyFrom(req);
  if (raw == null) return null;
  if (!env.HOSTED_KEY_PEPPER) return err(501, "hosted_not_enabled", "hosted mode is not enabled on this deployment");
  if (!env.RECEIPTS_DB) return err(503, "hosted_unavailable", "hosted mode needs the receipts store, which is unavailable; retry shortly or send the request without a key");
  const m = KEY_RE.exec(raw);
  if (!m) return err(401, "bad_key", "integrator key not recognised");
  let integ;
  try {
    integ = await env.RECEIPTS_DB.prepare("SELECT id, name, status, key_hash, free_total, first_invoice_paid FROM integrators WHERE id = ?").bind(m[1]).first();
  } catch (_) {
    return err(503, "hosted_unavailable", "could not read the integrator store; retry shortly or send the request without a key");
  }
  const h = await keyHash(env.HOSTED_KEY_PEPPER, m[2]);
  if (!integ || !eq(h, String(integ.key_hash || ""))) return err(401, "bad_key", "integrator key not recognised");
  if (integ.status !== "active") return err(401, "key_" + String(integ.status || "inactive"), "this integrator key is " + String(integ.status || "inactive"));
  const perMin = Math.max(1, parseInt(env.HOSTED_PER_MIN || "", 10) || HOSTED_PER_MIN);
  if (takeFree) {
    const rl = await takeFree(env, "hosted:" + integ.id, perMin, now, "take", "hosted-min", now.toISOString().slice(0, 16));
    if (rl && rl.free === false) return { response: { status: 429, body: { error: `hosted rate limit: ${perMin} checks per minute per key`, code: "hosted_rate_limited", retry_after_s: 60 - now.getUTCSeconds() }, headers: { "retry-after": String(60 - now.getUTCSeconds()) } } };
  }
  const month = utcMonth(now);
  let meter;
  try {
    meter = await readMeter(env, integ.id, month);
  } catch (_) {
    return err(503, "hosted_unavailable", "could not read the hosted meter; retry shortly or send the request without a key");
  }
  const p = hostedPrice(meter, integ);
  const limit = creditLimitAtomic(integ);
  if (p.price_atomic > 0 && meter.outstanding_atomic + p.price_atomic > limit) return { fallback: true, integ, reason: "credit_limit", limit_atomic: limit, outstanding_atomic: meter.outstanding_atomic };
  const eu = (req.headers.get("x-402xagent-end-user") || "").trim().slice(0, 64);
  const end_user_hash = eu ? (await sha256hex(String(salt || "") + ":" + integ.id + ":" + eu)).slice(0, 24) : null;
  return { ok: true, integ, ...p, month, meter, end_user_hash };
}

/** The access block (also embedded in the signed receipt as `hosted`). */
export function hostedAccess(h) {
  return {
    tier: "hosted",
    integrator: h.integ.id,
    integrator_name: h.integ.name || null,
    end_user_hash: h.end_user_hash,
    price_atomic: String(h.price_atomic),
    price_usd: (h.price_atomic / 1e6).toString(),
    band: h.band,
    month: h.month,
    billed_on: "invoice",
    invoice_period: h.month,
    free_allowance_remaining: Math.max(0, Number(h.integ.free_total ?? HOSTED_FREE_TOTAL) - h.meter.total - 1),
  };
}

/** One usage row per hosted check, keyed by the receipt it produced (the invoice source of truth). */
export async function recordHosted(env, h, receiptId, product, now = new Date()) {
  try {
    await env.RECEIPTS_DB.prepare("INSERT INTO hosted_usage (receipt_id, integrator_id, product, created_at, month, price_atomic, band, end_user_hash, invoiced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)")
      .bind(String(receiptId), h.integ.id, product, now.toISOString(), h.month, h.price_atomic, h.band, h.end_user_hash).run();
    return true;
  } catch (_) {
    return false;
  }
}

/** /v1/integrators/me: the caller's own meter (bearer auth). */
export async function integratorMe(env, req) {
  const h = await resolveHosted(env, req, {});
  if (!h) return { status: 401, body: { error: "send your integrator key as Authorization: Bearer 402x_live_...", code: "no_key" } };
  if (h.response) return h.response;
  const meter = h.ok ? h.meter : await readMeter(env, h.integ.id, utcMonth());
  const next = h.ok ? { price_atomic: String(h.price_atomic), band: h.band } : { fallback: "x402", reason: h.reason };
  return { status: 200, body: { integrator: h.integ.id, name: h.integ.name || null, month: utcMonth(), meter, next_check: next, credit_limit_atomic: String(creditLimitAtomic(h.integ)), free_total: Number(h.integ.free_total ?? HOSTED_FREE_TOTAL) } };
}
