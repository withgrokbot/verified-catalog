// 0.55.0 skip-reason tuning (new checks only; stored receipts and verdicts are never rewritten, no KV writes).
// Three results that used to be a skip are now a recheck, because they say "not now" rather than "these terms are wrong":
//   rate_limited  - HTTP 429 without x402 terms (was skip/no_paywall)
//   waf_challenge - HTTP 403 that carries a firewall/WAF challenge or block signature (was skip/no_paywall). A plain 403
//                   (no signature below) is unchanged: skip/no_paywall.
//   dns_error     - the host did not resolve, after exactly one retry (was skip/ssrf_blocked; the URL is still never fetched)
// Guard: when the same endpoint (normalized URL + method) has answered only these rechecks for at least
// TRANSIENT_SKIP_AFTER_HOURS (env, default 24), the next check falls back to skip with a *_persistent code. The streak is
// read from the existing D1 spot_receipts rows (indexed by norm_key, probed_at); nothing new is stored.
export const TRANSIENT_SKIP_AFTER_HOURS_DEFAULT = 24;
export const TRANSIENT_SKIP_AFTER_HOURS_MAX = 24 * 365;
export const PERSISTENT_OF = Object.freeze({ rate_limited: "rate_limited_persistent", waf_challenge: "waf_blocked_persistent", dns_error: "dns_error_persistent" });
export const TRANSIENT_CODES = Object.freeze(Object.keys(PERSISTENT_OF));
export const STREAK_CODES = Object.freeze([...TRANSIENT_CODES, ...Object.values(PERSISTENT_OF)]);

/** TRANSIENT_SKIP_AFTER_HOURS from env: positive hours (decimals allowed, max one year); anything else -> 24. */
export function transientSkipAfterHours(env) {
  const raw = env && env.TRANSIENT_SKIP_AFTER_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return TRANSIENT_SKIP_AFTER_HOURS_DEFAULT;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 && n <= TRANSIENT_SKIP_AFTER_HOURS_MAX ? n : TRANSIENT_SKIP_AFTER_HOURS_DEFAULT;
}

// Conservative WAF signatures. Only an HTTP 403 qualifies, and only with one of:
//  - header cf-mitigated (Cloudflare sets it on challenge responses)
//  - header x-amzn-waf-action (AWS WAF captcha/challenge/block)
//  - server: cloudflare AND a Cloudflare-generated challenge/block page (challenge-platform / cf_chl_opt / cf-chl- markers,
//    "Just a moment...", "Attention Required! | Cloudflare", or "Sorry, you have been blocked" with a Cloudflare Ray ID)
//  - server: AkamaiGHost AND Akamai's "Access Denied" page with its "Reference #" id
// A 403 from the seller's own app (JSON error, plain text, or an origin page that merely sits behind Cloudflare) is not a WAF.
const CF_PAGE_RE = /challenge-platform|cf_chl_opt|cf-chl-|<title>\s*Just a moment\.\.\.\s*<\/title>|Attention Required! \| Cloudflare|Sorry, you have been blocked[\s\S]{0,4000}Cloudflare Ray ID|Cloudflare Ray ID[\s\S]{0,4000}Sorry, you have been blocked/i;
const AKAMAI_PAGE_RE = /Access Denied[\s\S]{0,2000}Reference(?:&#32;|\s)#\d+\.[0-9a-f]+/i;
export function wafSignature(status, headers, bodyText) {
  if (Number(status) !== 403) return null;
  const get = (n) => (headers && typeof headers.get === "function" ? headers.get(n) : null);
  if (get("cf-mitigated") != null) return { vendor: "cloudflare", signal: "cf-mitigated" };
  if (get("x-amzn-waf-action") != null) return { vendor: "aws", signal: "x-amzn-waf-action" };
  const server = String(get("server") || "").toLowerCase();
  const body = String(bodyText || "").slice(0, 65536);
  if (server === "cloudflare" && CF_PAGE_RE.test(body)) return { vendor: "cloudflare", signal: "challenge_page" };
  if (server.startsWith("akamaighost") && AKAMAI_PAGE_RE.test(body)) return { vendor: "akamai", signal: "access_denied_page" };
  return null;
}

// 0.56.0: codes that are neutral for the streak: they neither count toward it nor break it. host_unstable = our own
// per-host circuit breaker answered without fetching the target (breaker.js), so it says nothing about the endpoint.
export const STREAK_NEUTRAL_CODES = Object.freeze(["host_unstable"]);
const IN = "(" + STREAK_CODES.map((c) => `'${c}'`).join(",") + ")";
const IN_OR_NEUTRAL = "(" + [...STREAK_CODES, ...STREAK_NEUTRAL_CODES].map((c) => `'${c}'`).join(",") + ")";
// Oldest probe of the unbroken run of transient results for this endpoint (rows newer than the newest other result;
// neutral rows are skipped on both sides). One indexed D1 read, only when the current answer is one of the three rechecks.
export const STREAK_SQL =
  `SELECT MIN(probed_at) AS since FROM spot_receipts WHERE norm_key = ?1 AND probed_at IS NOT NULL AND reason IN ${IN} ` +
  `AND probed_at > COALESCE((SELECT MAX(probed_at) FROM spot_receipts WHERE norm_key = ?1 AND probed_at IS NOT NULL AND reason NOT IN ${IN_OR_NEUTRAL}), '')`;
export async function transientSince(env, normKey) {
  const db = env && env.RECEIPTS_DB;
  if (!db || !normKey) return null;
  try {
    const row = await db.prepare(STREAK_SQL).bind(normKey).first();
    return row && row.since ? String(row.since) : null;
  } catch (_) {
    return null; // fail open: no history = stays recheck
  }
}

/**
 * d = decision after decideVerdict/applyExpected/... ; returns {d, transient} where transient is null unless d is one of
 * the three rechecks. since = oldest probe of the current streak (null when this is the first). With since at least
 * maxH hours before probedAt, d becomes skip/<code>_persistent.
 */
export async function applyTransientGuard(env, d, normKey, probedAt, now = Date.now()) {
  if (!d || d.verdict !== "recheck" || !PERSISTENT_OF[d.reason]) return { d, transient: null };
  const maxH = transientSkipAfterHours(env);
  const since = await transientSince(env, normKey);
  const at = Date.parse(String(probedAt || "")) || now;
  const t0 = since ? Date.parse(since) : NaN;
  const hours = Number.isFinite(t0) ? Math.max(0, Math.round(((at - t0) / 3600000) * 10) / 10) : 0;
  const transient = { code: d.reason, since: Number.isFinite(t0) ? since : null, hours, skip_after_hours: maxH, fell_back: false };
  if (Number.isFinite(t0) && at - t0 >= maxH * 3600000) {
    return { d: { ...d, verdict: "skip", reason: PERSISTENT_OF[d.reason], transient_code: d.reason }, transient: { ...transient, fell_back: true } };
  }
  return { d, transient };
}
