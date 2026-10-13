// 0.30.0: stable reason codes + confidence, published at /rules (HTML) and /rules.json. Additive only: the human
// reason stays in `reason` (free) / `reason_text` (receipts); `reason_code` is the stable machine code.
import { REASON_TEXT } from "./recent.js";

export const RULES_VERSION = "2026-10-13";
// code -> verdict it produces, and its default confidence
export const REASON_CODES = [
  { code: "price_ok", verdict: "pay", confidence: "high", rule: "Live 402 offers canonical USDC on a supported mainnet, to the listed wallet and network, at the listed price (within 1%)." },
  { code: "price_below_listing", verdict: "pay", confidence: "high", rule: "As price_ok, but the live price is more than 1% below the listed price." },
  { code: "price_mismatch", verdict: "skip", confidence: "high", rule: "Live price is more than 1% above the listed or claimed price." },
  { code: "pay_to_mismatch", verdict: "skip", confidence: "high", rule: "The 402 pays a different wallet than listed." },
  { code: "network_mismatch", verdict: "skip", confidence: "high", rule: "The 402 asks for payment on a different network than listed." },
  { code: "asset_not_usdc", verdict: "skip", confidence: "high", rule: "The 402 asks for a token other than canonical USDC." },
  { code: "network_unsupported", verdict: "skip", confidence: "high", rule: "The 402 only offers a testnet or a network we do not support." },
  { code: "ssrf_blocked", verdict: "skip", confidence: "high", rule: "Private, local or otherwise unsafe address; never fetched." },
  { code: "no_paywall", verdict: "skip", confidence: "medium", rule: "The endpoint answered without an x402 payment request (one probe; a route may need another method or path)." },
  { code: "bad_challenge", verdict: "skip", confidence: "medium", rule: "A 402 came back but its payment request has no readable USDC price." },
  { code: "ambiguous", verdict: "skip", confidence: "medium", rule: "The payment request is unclear (several incompatible offers)." },
  { code: "free_trial_active", verdict: "recheck", confidence: "low", rule: "The seller says a free trial is active, so there is no price to check yet." },
  { code: "timeout", verdict: "recheck", confidence: "low", rule: "The endpoint did not answer in time." },
  { code: "unreachable", verdict: "recheck", confidence: "low", rule: "Could not connect (DNS, TLS or network error)." },
  { code: "server_error", verdict: "recheck", confidence: "low", rule: "The endpoint returned a 5xx." },
];
const BY_CODE = Object.fromEntries(REASON_CODES.map((r) => [r.code, r]));
export const CONFIDENCE_RULES = [
  "high: the verdict follows from terms we read in the live 402 and compared with the listing (or a definite safety block).",
  "medium: one probe without readable terms (no_paywall, bad_challenge, ambiguous); or a pay with no listed price to compare; or a pay whose terms changed since the previous observation (history.drift true).",
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
    fields: {
      reason_code: "stable machine code (this list); never renamed, new codes may be added",
      reason: "free answers: one plain-words line; paid answers: the code (unchanged since 0.6)",
      confidence: "high | medium | low (rules above)",
      history: "summary of the last 30 observations: stable_for_days, stable_since, last_changed, drift",
      history_observations: "paid, router and exempt answers only: the last 30 observations (time, price, network, pay_to, asset, status)",
    },
    price_tolerance: "within 1% of the listed price counts as the listed price",
    limits: {
      free_live_checks: "5 per client name per UTC day, and at most 25 per network (IP; IPv6 /64) per UTC day across all client names; over the network cap: HTTP 429 with Retry-After until 00:00 UTC. The IP is only kept as a salted hash.",
      dry_runs: "separate caps per caller and per network; never an approval to pay",
      paid: "one tenth of the endpoint's quoted price (min $0.01, cap $0.25) per check; router tier $0.01 for 10 checks; rate limited per payer per hour",
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
<h2>Limits</h2><ul>${Object.entries(j.limits).map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join("")}</ul>
<h2>Fields</h2><ul>${Object.entries(j.fields).map(([k, v]) => `<li><code>${esc(k)}</code>: ${esc(v)}</li>`).join("")}</ul>
<p><a href="/">402xAgent</a></p></body></html>`;
}
