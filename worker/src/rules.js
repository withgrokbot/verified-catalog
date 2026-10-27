import { GRADES } from "./report.js";
// 0.30.0: stable reason codes + confidence, published at /rules (HTML) and /rules.json. Additive only: the human
// reason stays in `reason` (free) / `reason_text` (receipts); `reason_code` is the stable machine code.
import { REASON_TEXT } from "./recent.js";
import { QUALITY_CODES } from "./quality.js";
import { REPUTATION_RULES } from "./reputation.js";

export const RULES_VERSION = "2026-10-27"; // 0.37.0: + quality_codes, reputation (additive); 0.53.3: + delivery_failed (additive); 0.54.0: + terms_changed_since_quote, terms_stale (additive); 0.55.0: + rate_limited, waf_challenge, dns_error (recheck) and their *_persistent skips (new checks only)
// code -> verdict it produces, and its default confidence
export const REASON_CODES = [
  { code: "price_ok", verdict: "pay", confidence: "high", rule: "Live 402 offers canonical USDC on a supported mainnet, to the listed wallet and network, at the listed price (within 1%)." },
  { code: "price_below_listing", verdict: "pay", confidence: "high", rule: "As price_ok, but the live price is more than 1% below the listed price." },
  { code: "price_mismatch", verdict: "skip", confidence: "high", rule: "Live price is more than 1% above the listed or claimed price." },
  { code: "pay_to_mismatch", verdict: "skip", confidence: "high", rule: "The 402 pays a different wallet than listed." },
  { code: "network_mismatch", verdict: "skip", confidence: "high", rule: "The 402 asks for payment on a different network than listed." },
  { code: "asset_not_usdc", verdict: "skip", confidence: "high", rule: "The 402 asks for a token other than canonical USDC." },
  { code: "network_unsupported", verdict: "skip", confidence: "high", rule: "The 402 only offers a testnet or a network we do not support." },
  { code: "ssrf_blocked", verdict: "skip", confidence: "high", rule: "Private, local or otherwise unsafe address; never fetched. (0.55.0: a host that does not resolve is dns_error, not this.)" },
  { code: "no_paywall", verdict: "skip", confidence: "medium", rule: "The endpoint answered without an x402 payment request (one probe; a route may need another method or path). Includes a plain 403; since 0.55.0 not a 429 (rate_limited) or a WAF-challenge 403 (waf_challenge)." },
  { code: "bad_challenge", verdict: "skip", confidence: "medium", rule: "A 402 came back but its payment request has no readable USDC price." },
  { code: "challenge_expired", verdict: "skip", confidence: "high", rule: "Opt-in only (&check_expiry=1): every Base USDC option has an absolute expiry (extra.validBefore/expiresAt/expiry/deadline) at or within skew_s (default 30, max 300) of now, or maxTimeoutSeconds <= 5." },
  { code: "ambiguous", verdict: "skip", confidence: "medium", rule: "The payment request is unclear (several incompatible offers)." },
  { code: "free_trial_active", verdict: "recheck", confidence: "low", rule: "The seller says a free trial is active, so there is no price to check yet." },
  { code: "timeout", verdict: "recheck", confidence: "low", rule: "The endpoint did not answer in time." },
  { code: "unreachable", verdict: "recheck", confidence: "low", rule: "Could not connect (TLS or network error; an unresolvable host is dns_error since 0.55.0)." },
  { code: "server_error", verdict: "recheck", confidence: "low", rule: "The endpoint returned a 5xx." },
  { code: "delivery_failed", verdict: "recheck", confidence: "low", rule: "0.53.3 (DELIVERY_CHECK): the terms would pass, but our latest paid call to this endpoint (within 14 days) settled and got back a failed delivery (5xx, challenge/CAPTCHA page, sign-in/subscribe wall, canned refusal, error-only or placeholder body). Applies to new checks only; past pay/skip verdicts and receipts are never changed; endpoints without delivery data are unaffected." },
  { code: "terms_changed_since_quote", verdict: "recheck", confidence: "low", rule: "0.54.0 opt-in (&quote=<receipt id>): the live terms would pass, but the price, pay_to, network or asset differs from the quote (crawl or live receipt) the buyer was shown. Check again without quote to approve the new terms." },
  { code: "rate_limited", verdict: "recheck", confidence: "low", rule: "0.55.0 (new checks only): HTTP 429 with no x402 terms. Was skip/no_paywall. After TRANSIENT_SKIP_AFTER_HOURS (default 24 h) of only rate_limited / waf_challenge / dns_error answers for the same URL + method: skip/rate_limited_persistent." },
  { code: "waf_challenge", verdict: "recheck", confidence: "low", rule: "0.55.0 (new checks only): HTTP 403 with a firewall/WAF signature: a cf-mitigated or x-amzn-waf-action header, a Cloudflare-served challenge/block page (server: cloudflare plus challenge-platform / cf_chl_opt / cf-chl- markers, 'Just a moment...', 'Attention Required! | Cloudflare', or 'Sorry, you have been blocked' with a Cloudflare Ray ID), or an AkamaiGHost 'Access Denied' page with its Reference #. A plain 403 stays skip/no_paywall. Was skip/no_paywall. Persisting: skip/waf_blocked_persistent." },
  { code: "dns_error", verdict: "recheck", confidence: "low", rule: "0.55.0 (new checks only): the host did not resolve (no A/AAAA answer or a resolver error) on the first lookup and on exactly one retry; the URL is never fetched. A live DNS failure uses no free check and is never charged (also as dns_error_persistent). Hosts that resolve to private, loopback or link-local addresses are still skip/ssrf_blocked. Was skip/ssrf_blocked (live) or skip 'domain does not resolve' (crawl). Persisting: skip/dns_error_persistent." },
  { code: "rate_limited_persistent", verdict: "skip", confidence: "medium", rule: "0.55.0: the endpoint has answered only rate_limited / waf_challenge / dns_error for at least TRANSIENT_SKIP_AFTER_HOURS (default 24 h; from our stored checks of the same URL + method) and the latest was a 429." },
  { code: "waf_blocked_persistent", verdict: "skip", confidence: "medium", rule: "0.55.0: as rate_limited_persistent, and the latest answer was a WAF-challenge 403." },
  { code: "dns_error_persistent", verdict: "skip", confidence: "medium", rule: "0.55.0: as rate_limited_persistent, and the latest lookup failed DNS (after one retry)." },
  { code: "terms_stale", verdict: "recheck", confidence: "low", rule: "0.54.0 catalog/crawl answers only (discover; effective_verdict on crawl receipts, by-url, skips and lookup): the stored pay's terms are older than TERMS_MAX_AGE_HOURS (7 days in production; see each discover answer's terms_max_age_hours). Never produced by a live check, which always re-reads the 402." },
];
const BY_CODE = Object.fromEntries(REASON_CODES.map((r) => [r.code, r]));
export const CONFIDENCE_RULES = [
  "high: the verdict follows from terms we read in the live 402 and compared with the listing (or a definite safety block).",
  "medium: one probe without readable terms (no_paywall, bad_challenge, ambiguous); a 0.55.0 *_persistent skip (rate limit, WAF or DNS for the whole retry window); or a pay with no listed price to compare; or a pay whose terms changed since the previous observation (history.drift true).",
  "low: every recheck (timeouts, 5xx, network errors, free trials), and any code not in this list.",
];

// Deterministic. d = { verdict, reason }, claimed = listed/claimed price or null, history = 0.29.0 summary or null.
export function confidenceFor(d, claimed = null, history = null) {
  if (!d || d.verdict === "recheck") return "low";
  const r = BY_CODE[d.reason];
  if (!r) return "low";
  if (d.verdict === "pay") {
    if (claimed == null) return "medium";
    if (history && history.drift === true) return "medium";
    return "high";
  }
  return r.confidence;
}
export function reasonFields(d, claimed = null, history = null) {
  return { reason_code: d && d.reason ? String(d.reason) : null, confidence: confidenceFor(d, claimed, history) };
}

export function rulesJson(origin) {
  return {
    rules_version: RULES_VERSION,
    page: origin + "/rules",
    verdicts: { pay: "safe to pay these exact terms now", skip: "do not pay (we saw a concrete problem)", recheck: "no decision yet: try again later" },
    reason_codes: REASON_CODES.map((r) => ({ ...r, text: REASON_TEXT[r.code] || null })),
    confidence: { levels: ["high", "medium", "low"], rules: CONFIDENCE_RULES },
    // 0.37.0 (additive, separate from reason_code: never changes a verdict)
    quality_codes: QUALITY_CODES.map((q) => ({ code: q.code, reputation_value: q.score, rule: q.rule })),
    hygiene_grades: Object.fromEntries(Object.entries(GRADES).map(([k, v]) => [k, v.reason ? { grade: v.grade, reason: v.reason } : { grade: v.grade }])), // 0.46.0 locked teaser grade
    reputation: REPUTATION_RULES,
    fields: {
      reason_code: "stable machine code (this list); never renamed, new codes may be added",
      reason: "free answers: one plain-words line; paid answers: the code (unchanged since 0.6)",
      confidence: "high | medium | low (rules above)",
      history: "summary of the last 30 observations: stable_for_days, stable_since, last_changed, drift",
      history_observations: "paid, router and exempt answers only: the last 30 observations (time, price, network, pay_to, asset, status)",
      quality: "0.37.0: paid, router and exempt answers: {code, checks {reachable, http_status, status_is_402, content_type, content_type_ok, body_bytes, schema_declared, schema_source, schema_match}}; free answers and dry runs: {code} only. Metadata of the unpaid 402 response; never changes verdict or reason_code.",
      reputation: "0.37.0: seller host reputation. Paid, router and exempt answers: {host, score 0..100 or null, band, confidence, low_data, provisional_score?, breakdown, inputs}; free answers and dry runs: {host, band} only. Free page: /reputation/<host>.",
    },
    price_tolerance: "within 1% of the listed price counts as the listed price",
    limits: {
      free_live_checks: "5 per client name per UTC day, and at most 25 per network (IP; IPv6 /64) per UTC day across all client names; over the network cap: HTTP 429 with Retry-After until 00:00 UTC. The IP is only kept as a salted hash.",
      dry_runs: "separate caps per caller and per network; never an approval to pay",
      paid: "$0.02 USDC per check (flat); router tier $0.20 for 10 checks; rate limited per payer per hour",
    },
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function rulesHtml(origin) {
  const j = rulesJson(origin);
  const rows = j.reason_codes.map((r) => `<tr><td><code>${esc(r.code)}</code></td><td>${esc(r.verdict)}</td><td>${esc(r.confidence)}</td><td>${esc(r.rule)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>402xAgent rules: verdicts, reason codes, confidence</title><link rel="alternate" type="application/json" href="${esc(origin)}/rules.json"><style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left;vertical-align:top}code{background:#f5f5f5;padding:1px 4px;border-radius:4px}</style></head><body>
<h1>402xAgent rules</h1><p>How a check turns a live x402 payment request into <b>pay</b>, <b>skip</b> or <b>recheck</b>. Machine-readable: <a href="/rules.json">/rules.json</a> (version ${esc(j.rules_version)}).</p>
<h2>Verdicts</h2><ul>${Object.entries(j.verdicts).map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join("")}</ul>
<h2>Reason codes</h2><table><tr><th>reason_code</th><th>verdict</th><th>default confidence</th><th>rule</th></tr>${rows}</table>
<p>${esc(j.price_tolerance)}.</p>
<h2>Confidence</h2><ul>${j.confidence.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
<h2>Quality codes</h2><p>Separate from reason_code; never changes a verdict. Folded into reputation.</p><table><tr><th>code</th><th>reputation value</th><th>rule</th></tr>${j.quality_codes.map((q) => `<tr><td><code>${esc(q.code)}</code></td><td>${esc(q.reputation_value)}</td><td>${esc(q.rule)}</td></tr>`).join("")}</table>
<h2>Seller reputation</h2><p>${esc(j.reputation.formula)}</p><table><tr><th>component</th><th>weight</th><th>definition</th></tr>${Object.entries(j.reputation.weights).map(([k, w]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(w)}</td><td>${esc(j.reputation.components[k])}</td></tr>`).join("")}</table><ul><li>${esc(j.reputation.insufficient_data)}</li><li>bands: ${esc(j.reputation.bands)}</li><li>confidence: ${esc(j.reputation.confidence)}</li><li>${esc(j.reputation.tiers)}</li><li>${esc(j.reputation.note)}</li></ul>
<h2>Limits</h2><ul>${Object.entries(j.limits).map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join("")}</ul>
<h2>Fields</h2><ul>${Object.entries(j.fields).map(([k, v]) => `<li><code>${esc(k)}</code>: ${esc(v)}</li>`).join("")}</ul>
<p><a href="/">402xAgent</a></p></body></html>`;
}
