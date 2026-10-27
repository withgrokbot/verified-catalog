// 0.53.3 post-payment delivery check, read side. Rows in D1 delivery_checks (migration 0020) come from our own paid
// check rounds (scripts/run_checks.py --pay classifies the seller's response after settlement: scripts/delivery.py);
// the Worker never pays a seller, so it never classifies a paid response itself.
// Effects (flag DELIVERY_CHECK=1; off = no D1 read, nothing changes):
//  - a NEW check whose verdict would be pay returns recheck / delivery_failed when the endpoint's latest delivery check
//    in the last DELIVERY_RECENT_DAYS days failed. skip and recheck verdicts are never touched, stored receipts are
//    never rewritten, and an endpoint without delivery rows (or whose latest one is ok) is decided exactly as before.
//  - seller reputation gets a delivery component (share of ok delivery checks on the host in 30 days) only when the
//    host has delivery rows; hosts without rows keep the same score, breakdown keys and inputs.
export const DELIVERY_RECENT_DAYS = 14;
export const DELIVERY_WEIGHT = 15;
export const DELIVERY_REASONS = Object.freeze(["server_error", "http_error", "empty_body", "challenge_page", "soft_paywall", "canned_refusal", "error_body", "placeholder_body", "no_response"]);
const DAY = 86400000;
const on = (v) => ["1", "on", "true"].includes(String(v || "").toLowerCase());
export const deliveryOn = (env) => on(env && env.DELIVERY_CHECK);

/** Latest delivery row for an endpoint within DELIVERY_RECENT_DAYS, or null (flag off, no table, no row). Never throws. */
export async function latestDelivery(env, hkey, now = new Date()) {
  if (!deliveryOn(env) || !env.RECEIPTS_DB || !hkey) return null;
  try {
    const since = new Date(now.getTime() - DELIVERY_RECENT_DAYS * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
    return (await env.RECEIPTS_DB.prepare("SELECT checked_at, flag, reason, http_status FROM delivery_checks WHERE hkey = ? AND checked_at >= ? ORDER BY checked_at DESC LIMIT 1").bind(hkey, since).first()) || null;
  } catch (_) { return null; } // migration 0020 not applied yet
}

/** Pure. d = {verdict, reason, ...}. Only a pay becomes recheck, and only on a recent failed delivery. */
export function applyDelivery(d, latest) {
  if (!d || d.verdict !== "pay" || !latest || latest.flag !== "failed") return { d, delivery: null };
  const delivery = { flag: "failed", reason: DELIVERY_REASONS.includes(latest.reason) ? latest.reason : "other", checked_at: latest.checked_at };
  return { d: { ...d, verdict: "recheck", reason: "delivery_failed" }, delivery };
}

/** Per-host rows for reputation (30 days, newest first), [] when off / missing. */
export async function hostDeliveries(env, host, now = new Date()) {
  if (!deliveryOn(env) || !env.RECEIPTS_DB || !host) return [];
  try {
    const since = new Date(now.getTime() - 30 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
    const r = await env.RECEIPTS_DB.prepare("SELECT hkey, checked_at, flag, reason FROM delivery_checks WHERE host = ? AND checked_at >= ? ORDER BY checked_at DESC LIMIT 200").bind(String(host).toLowerCase(), since).all();
    return (r && r.results) || [];
  } catch (_) { return []; }
}
