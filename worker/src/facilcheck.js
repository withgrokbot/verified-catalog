// 0.53.0 POST /v1/facilitator/check: for a facilitator's onBeforeSettle hook. Re-fetches the seller's live
// advertised x402 terms for the resource (the spot probe: SSRF guards on every hop, timeout, body cap, never any
// payment header) and compares them with the paymentRequirements about to be settled.
// Free for now. Two limits on the QuotaCounter DO, each under its own key prefix + counter (never the spot-check
// 5/day; a counter error fails CLOSED here: 503 limiter_unavailable, hold, nothing probed): 60/min per caller IP (salted daily IP digest from quotaKey; ?client= is ignored, so rotating it gains
// nothing) and 30 probes/min per seller host across all callers (over it: 429 hold, nothing probed). No D1 or
// KV writes, nothing logged. paymentPayload (payer, signature) is never read, stored or echoed: only the seller-side
// requirement fields below are used.
import { spotProbe, assertSafeUrl, resolveHost } from "./spotcheck.js";
import { isPlaceholderUrl, methodNotAllowed } from "./ops.js";
import { caip, sameAddr, termsSha256, takeFree, quotaKey, selfFetch, utcMinute } from "./lib.js";

export const FACIL_CHECK_PATH = "/v1/facilitator/check";
export const FACIL_CHECK_PER_MIN = 60;
export const FACIL_CHECK_COUNTER = "fck";
export const FACIL_HOST_PER_MIN = 30;
export const FACIL_HOST_COUNTER = "fckh";
/** Normalized seller host for the per-host cap: lowercase, trailing dots removed. */
export const sellerHostKey = (u) => "fckh:" + new URL(u).hostname.toLowerCase().replace(/\.+$/, "");
export const FACIL_CHECK_MAX_BODY = 16384;
export const FACIL_FIELDS = ["scheme", "network", "amount", "asset", "payTo"];
export const FACIL_EXAMPLE = {
  paymentRequirements: {
    scheme: "exact", network: "eip155:8453", amount: "1000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x<seller payTo>",
  },
  url: "https://api.402rates.com/v1/ping",
};

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const J = (o, status = 200, extra = {}) => new Response(JSON.stringify(o, null, 2), {
  status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", ...extra },
});
const bad = (error, field, expected, received) => J({ error, code: "bad_input", field, expected, received, recommendation: "hold", nothing_probed: true }, 400);
const typeOf = (v) => (v === undefined ? "[not sent]" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

const amountOf = (r) => { const a = r && (r.amount ?? r.maxAmountRequired); return a == null ? null : String(a).trim(); };
const resourceUrl = (v) => (typeof v === "string" ? v : v && typeof v === "object" && typeof v.url === "string" ? v.url : null);

/** Validates the body; returns { req, url, method } or { error: Response }. */
export function parseFacilInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: bad("body must be a JSON object", "body", "{paymentRequirements, url?}", typeOf(body)) };
  const pr = body.paymentRequirements;
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) return { error: bad('"paymentRequirements" is required: the x402 accepts entry about to be settled', "paymentRequirements", "object {scheme, network, amount, asset, payTo}", typeOf(pr)) };
  for (const f of FACIL_FIELDS) {
    const v = f === "amount" ? amountOf(pr) : pr[f];
    if (typeof v !== "string" || !v.trim() || v.length > 200) return { error: bad(`paymentRequirements.${f} is required (non-empty string)`, "paymentRequirements." + f, "string", typeOf(f === "amount" ? (pr.amount ?? pr.maxAmountRequired) : pr[f])) };
  }
  if (!/^\d{1,78}$/.test(amountOf(pr))) return { error: bad("paymentRequirements.amount must be an integer string in atomic units", "paymentRequirements.amount", "decimal integer string, e.g. \"20000\"", "string") };
  const url = resourceUrl(body.url) || resourceUrl(body.resource) || resourceUrl(pr.resource) || resourceUrl(pr.url);
  if (!url) return { error: bad("resource url is required: body.url, body.resource(.url) or paymentRequirements.resource(.url)", "url", "full http(s) URL of the seller's x402 resource", "[not sent]") };
  let u; try { u = new URL(url); } catch (_) {}
  if (!u || !/^https?:$/.test(u.protocol) || url.length > 2048) return { error: bad("url must be a full http(s) URL", "url", "full http(s) URL", "invalid url") };
  if (isPlaceholderUrl(url)) return { error: bad("This looks like the docs placeholder. Submit the real resource URL.", "url", "a real x402 resource URL", "placeholder host") };
  const m = body.method == null ? "GET" : String(body.method).toUpperCase();
  if (m !== "GET" && m !== "POST") return { error: bad("method must be GET or POST", "method", "GET | POST", "other") };
  const req = { scheme: pr.scheme.trim(), network: pr.network.trim(), amount: amountOf(pr), asset: pr.asset.trim(), payTo: pr.payTo.trim() };
  return { req, url: u.toString(), method: m };
}

/** Field-by-field diff of one live accepts entry against the requirement ([] = match). */
export function diffTerms(req, live) {
  const out = [];
  const net = caip(req.network);
  if (String(live.scheme || "") !== req.scheme) out.push({ field: "scheme", expected: req.scheme, live: live.scheme ?? null });
  if (caip(live.network) !== net) out.push({ field: "network", expected: req.network, live: live.network ?? null });
  const liveAmt = live.amount ?? live.maxAmountRequired ?? null; // x402 v1 sellers advertise maxAmountRequired
  let same = false; try { same = liveAmt != null && BigInt(String(liveAmt)) === BigInt(req.amount); } catch (_) {}
  if (!same) out.push({ field: "amount", expected: req.amount, live: liveAmt == null ? null : String(liveAmt) });
  if (!sameAddr(req.asset, live.asset, net)) out.push({ field: "asset", expected: req.asset, live: live.asset ?? null });
  if (!sameAddr(req.payTo, live.payTo, net)) out.push({ field: "payTo", expected: req.payTo, live: live.payTo ?? null });
  return out;
}

/** Picks the live entry to report: an exact match, else the fewest mismatches (ties: first). */
export function compareLive(req, accepts) {
  let best = null;
  for (const a of accepts || []) {
    if (!a || a.raw) continue;
    const d = diffTerms(req, a);
    if (!best || d.length < best.mismatches.length) best = { entry: a, mismatches: d };
    if (!d.length) break;
  }
  return best;
}

const limiterDown = () => J({ error: "limiter_unavailable", code: "limiter_unavailable", recommendation: "hold", nothing_probed: true, retry_after_seconds: 5 }, 503, { "retry-after": "5" });
const hold = (status, error, code, checkedAt, extra = {}) => J({ match: false, mismatches: [], live_terms_sha256: null, checked_at: checkedAt, recommendation: "hold", error, code, ...extra }, status);

export async function handleFacilitatorCheck(req, env, deps = {}, now = new Date()) {
  if (req.method !== "POST") return methodNotAllowed(req.method, "POST, OPTIONS", FACIL_CHECK_PATH, { example: FACIL_EXAMPLE });
  const text = await req.text().catch(() => "");
  if (text.length > FACIL_CHECK_MAX_BODY) return bad(`body too large (max ${FACIL_CHECK_MAX_BODY} bytes)`, "body", "JSON object under 16 KB", "too large");
  let body; try { body = JSON.parse(text); } catch (_) { return bad("body must be JSON", "body", "{paymentRequirements, url?}", text ? "invalid JSON" : "[not sent]"); }
  const p = parseFacilInput(body);
  if (p.error) return p.error;
  const fetchImpl = deps.fetchImpl || fetch;
  const resolveHostFn = deps.resolveHostFn || resolveHost;
  const safe = await assertSafeUrl(p.url, { resolveHostFn, fetchImpl });
  if (!safe.ok) return J({ error: "blocked: " + safe.reason, code: "ssrf_blocked", field: "url", expected: "a public http(s) URL", received: "blocked host", recommendation: "hold", nothing_probed: true }, 400);
  // limits after validation (bad input never counts); own key prefixes + counters, so the spot-check quota is untouched.
  // 1) per caller IP: quotaKey with no client -> "ip:" + salted daily digest of the IP (IPv6 /64); never the raw IP.
  const ra = String(60 - now.getUTCSeconds());
  const minute = utcMinute(now);
  const t = await takeFree(env, "fck:" + (await quotaKey(req, {}, env, now)), FACIL_CHECK_PER_MIN, now, "take", FACIL_CHECK_COUNTER, minute);
  // Fail CLOSED on this route only: takeFree fails open (free: true + error) on a counter error or a missing binding;
  // here that is a 503 hold and nothing is probed. Other routes keep takeFree's fail-open behaviour.
  if (t.error) return limiterDown();
  if (!t.free) return J({ error: "rate limited", code: "rate_limited", limit: `${FACIL_CHECK_PER_MIN} requests per minute per IP`, retry_after_seconds: Number(ra), recommendation: "hold" }, 429, { "retry-after": ra });
  // 2) per seller host across all callers, checked before any probe
  const h = await takeFree(env, sellerHostKey(p.url), FACIL_HOST_PER_MIN, now, "take", FACIL_HOST_COUNTER, minute);
  if (h.error) return limiterDown();
  if (!h.free) return J({ error: "too many checks for this seller host, retry shortly", code: "host_rate_limited", limit: `${FACIL_HOST_PER_MIN} probes per minute per seller host`, retry_after_seconds: Number(ra), recommendation: "hold", nothing_probed: true }, 429, { "retry-after": ra });
  const probeOpts = { fetchImpl: selfFetch(env, fetchImpl), resolveHostFn, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) };
  let probe = await spotProbe(p.url, { ...probeOpts, method: p.method });
  if (probe && probe.http_status === 405 && !probe.x402_challenge && p.method === "GET") {
    try { const p2 = await spotProbe(p.url, { ...probeOpts, method: "POST" }); if (p2 && p2.x402_challenge) probe = p2; } catch (_) {}
  }
  const checkedAt = iso(now);
  if (!probe || probe.ssrf_blocked) return hold(502, "seller redirect blocked (" + String((probe && probe.error) || "unsafe") + ")", "seller_redirect_blocked", checkedAt);
  if (!probe.reachable) {
    if (probe.error === "fetch timeout") return hold(504, "seller timed out", "seller_timeout", checkedAt);
    if (/too many concurrent/.test(String(probe.error))) return hold(503, "busy, retry shortly", "busy", checkedAt, { retry_after_seconds: 2 });
    return hold(502, "seller unreachable", "seller_unreachable", checkedAt);
  }
  const best = compareLive(p.req, probe.accepts);
  if (!probe.x402_challenge || !best) {
    return J({ match: false, mismatches: [{ field: "terms", expected: "an x402 402 with accepts", live: "HTTP " + probe.http_status + " without readable terms" }], live_terms_sha256: null, checked_at: checkedAt, recommendation: "hold", live_status: probe.http_status });
  }
  const e = best.entry;
  const liveHash = await termsSha256({ network: caip(e.network), asset: e.asset, amount_atomic: e.amount ?? e.maxAmountRequired, pay_to: e.payTo });
  const match = best.mismatches.length === 0;
  return J({ match, mismatches: best.mismatches, live_terms_sha256: liveHash, checked_at: checkedAt, recommendation: match ? "settle" : "hold", live_status: probe.http_status, live_accepts_count: probe.accepts.length });
}
