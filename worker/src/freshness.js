// 0.54.0 terms freshness. Two rules, both read-time only (stored receipts are never rewritten, no KV writes):
//  1. Catalog / crawl-derived answers (/v1/discover + MCP discover, crawl receipts, /v1/receipts/by-url, /v1/skips(.json)
//     summary and recent_checks, /v1/lookup) carry the age of the payment terms they show. A crawl/catalog "pay" whose
//     terms are older than TERMS_MAX_AGE_HOURS (env var, default 24) is stale: discover returns it as verdict "recheck"
//     (reason_code terms_stale, original_verdict "pay"); the other surfaces keep the stored verdict and add a
//     `freshness` object whose effective_verdict is "recheck".
//  2. A live spot-check that is given the quote a buyer was shown (&quote=<receipt id>, a crawl id or an sc- id) and
//     whose live 402 terms differ from that quote (price, pay_to, network or asset) answers recheck /
//     terms_changed_since_quote instead of pay. Opt-in: without &quote the live check is decided exactly as before
//     (it always re-reads the live 402; probes are reused for at most SPOT_PROBE_CACHE_S = 5 min).
export const TERMS_MAX_AGE_HOURS_DEFAULT = 24;
export const TERMS_MAX_AGE_HOURS_MAX = 24 * 365;
export const QUOTE_ID_RE = /^([0-9a-f]{10}|sc-[0-9a-f]{16})$/;
export const QUOTE_FIELDS = Object.freeze(["price", "pay_to", "network", "asset"]);

/** TERMS_MAX_AGE_HOURS from env: a positive number of hours (decimals allowed, max one year); anything else -> 24. */
export function termsMaxAgeHours(env) {
  const raw = env && env.TERMS_MAX_AGE_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return TERMS_MAX_AGE_HOURS_DEFAULT;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 && n <= TERMS_MAX_AGE_HOURS_MAX ? n : TERMS_MAX_AGE_HOURS_DEFAULT;
}

/** Age in hours (one decimal) of an ISO timestamp, or null when it does not parse. */
export function ageHours(at, now = Date.now()) {
  const t = Date.parse(String(at || ""));
  if (!Number.isFinite(t)) return null;
  return Math.round(((now - t) / 3600000) * 10) / 10;
}

export const termsStaleText = (maxH) => `payment terms were last read more than ${fmtH(maxH)} ago; run the live check right before paying`;
const fmtH = (h) => (h % 24 === 0 && h >= 48 ? `${h / 24} days` : `${h} h`);

/**
 * Pure. Freshness of a stored/catalog answer: {terms_checked_at, terms_age_hours, terms_max_age_hours, terms_stale,
 * effective_verdict, effective_reason_code?}. Only a "pay" changes its effective verdict; an unknown age counts as stale.
 */
export function freshnessFor(verdict, checkedAt, maxH = TERMS_MAX_AGE_HOURS_DEFAULT, now = Date.now()) {
  const age = ageHours(checkedAt, now);
  const stale = age === null || age > maxH;
  const v = verdict || null;
  const expired = v === "pay" && stale;
  return {
    terms_checked_at: checkedAt || null,
    terms_age_hours: age,
    terms_max_age_hours: maxH,
    terms_stale: stale,
    effective_verdict: expired ? "recheck" : v,
    ...(expired ? { effective_reason_code: "terms_stale", effective_reason: termsStaleText(maxH) } : {}),
  };
}

/** The terms a quote showed, from a crawl receipt row or a stored live receipt body. null = no terms to compare. */
export function quoteTerms(rec, kind) {
  if (!rec || rec.verdict !== "pay") return null;
  if (kind === "live") {
    const ap = rec.approved_payment || rec.payment || null;
    if (!ap || !ap.pay_to) return null;
    return { amount_atomic: ap.amount_atomic != null ? String(ap.amount_atomic) : null, price_usd: ap.amount_usd ?? null, pay_to: ap.pay_to, network: ap.network || null, asset: ap.asset || null };
  }
  if (!rec.pay_to) return null;
  return { amount_atomic: rec.amount_atomic != null ? String(rec.amount_atomic) : null, price_usd: rec.quoted_price_usd ?? null, pay_to: rec.pay_to, network: rec.network || null, asset: rec.asset || null };
}

/**
 * Pure. Which quoted fields differ from the live payment pm (pickPayment output). A field missing on either side is
 * not compared. h = { caip, sameAddr } from lib.js (network aliases, EVM case-insensitive / Solana case-sensitive).
 */
export function quoteDiff(quote, pm, h) {
  if (!quote || !pm) return [];
  const out = [];
  if (quote.amount_atomic != null && pm.amount_atomic != null) { if (String(quote.amount_atomic) !== String(pm.amount_atomic)) out.push("price"); }
  else if (quote.price_usd != null && pm.amount_usd != null && Math.abs(Number(quote.price_usd) - Number(pm.amount_usd)) > 1e-9) out.push("price");
  if (quote.pay_to && pm.pay_to && !h.sameAddr(quote.pay_to, pm.pay_to, pm.network)) out.push("pay_to");
  if (quote.network && pm.network && h.caip(quote.network) !== h.caip(pm.network)) out.push("network");
  if (quote.asset && pm.asset && !h.sameAddr(quote.asset, pm.asset, pm.network)) out.push("asset");
  return out;
}

export const quoteChangedText = (fields) => `live payment terms differ from the quote you were given (${fields.join(", ")} changed); re-read the terms, then check again without quote to approve the new terms`;

/**
 * Pure. d = {verdict, reason}. quote = loadQuote() result or null. Only a would-be "pay" with comparable, differing
 * terms becomes recheck / terms_changed_since_quote. Returns { d, quote_check } (quote_check null when no quote given).
 */
export function applyQuote(d, quote, pm, h) {
  if (!quote) return { d, quote_check: null };
  const base = { quote_id: quote.id, quote_type: quote.kind || null, quoted_at: quote.quoted_at || null };
  if (quote.status !== "ok") return { d, quote_check: { ...base, status: quote.status } };
  if (!d || d.verdict !== "pay") return { d, quote_check: { ...base, status: "not_compared" } };
  const fields = quoteDiff(quote.terms, pm, h);
  if (!fields.length) return { d, quote_check: { ...base, status: "match", fields_changed: [] } };
  return { d: { ...d, verdict: "recheck", reason: "terms_changed_since_quote", quote_fields_changed: fields }, quote_check: { ...base, status: "changed", fields_changed: fields } };
}
