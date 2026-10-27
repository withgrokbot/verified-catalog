// 402xAgent facilitator-check gate: the same allow/deny shape as decide() in gate.mjs, but it calls
// POST /v1/facilitator/check, which re-fetches the seller's live x402 terms and compares them with the requirement.
// No dependencies (Node 18+). Never signs, never pays. Fails closed on a timeout, a network error, any non-200
// status, or a body that is not the expected JSON.
import { termsSha256, amountOf } from "./gate.mjs";

export const FACILITATOR_CHECK_URL = "https://api.402xagent.com/v1/facilitator/check";
const EVM_ALIASES = { base: "eip155:8453", "base-sepolia": "eip155:84532" }; // x402 v1 names we key on

/** CAIP-2 id for an EVM network ("eip155:8453", or v1 "base"), else null (unsupported here). */
export function evmNetwork(n) {
  const s = String(n ?? "").trim().toLowerCase();
  if (/^eip155:[1-9]\d*$/.test(s)) return s;
  return EVM_ALIASES[s] || null;
}

/** termsSha256 (service formula) with the network normalized to CAIP-2, so v1 and v2 requirements key the same. */
export function termsKey(req) {
  const network = evmNetwork(req && req.network);
  return network ? termsSha256({ ...req, network }) : null;
}

/**
 * POST the requirement to the facilitator check. Returns { status, body } or { unavailable: "<why>" }.
 * opts: { endpoint, fetch, timeoutMs (default 8000) }
 */
export async function facilitatorCheck({ url, method = "GET", requirement }, opts = {}) {
  const doFetch = opts.fetch ?? fetch;
  const r = requirement || {};
  const paymentRequirements = { scheme: r.scheme, network: r.network, amount: amountOf(r), asset: r.asset, payTo: r.payTo };
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error("timeout")); }, opts.timeoutMs ?? 8000); });
  try {
    const res = await Promise.race([
      doFetch(opts.endpoint ?? FACILITATOR_CHECK_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ paymentRequirements, url, method: String(method).toUpperCase() }),
        signal: ctl.signal,
      }),
      timeout,
    ]);
    const text = await Promise.race([res.text(), timeout]);
    let body = null;
    try { body = JSON.parse(text); } catch (_) {}
    return { status: res.status, body };
  } catch (e) {
    return { unavailable: e && e.message === "timeout" ? "timeout" : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The gate. Allow only when: HTTP 200, a JSON object with match === true, recommendation "settle", no mismatches,
 * and live_terms_sha256 equal to termsKey(requirement). Everything else is a deny with a reason_code.
 */
export async function decideFacilitator({ url, method = "GET", requirement }, opts = {}) {
  const key = termsKey(requirement);
  const check = { endpoint: url, method: String(method).toUpperCase(), source: "facilitator_check", terms_sha256: key, recommendation: null };
  const deny = (reason_code, reason) => ({ allow: false, reason_code, reason, check });
  if (!key) return deny("unsupported_network", "only EVM networks are keyed here");
  const out = await facilitatorCheck({ url, method, requirement }, opts);
  if (out.unavailable) return deny("check_unavailable", "facilitator check unavailable: " + out.unavailable);
  const b = out.body;
  if (out.status !== 200) return deny("check_http_" + out.status, (b && typeof b.error === "string" && b.error) || "HTTP " + out.status);
  if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.match !== "boolean" || !Array.isArray(b.mismatches)) return deny("check_malformed", "unexpected response body");
  check.recommendation = b.recommendation ?? null;
  check.checked_at = typeof b.checked_at === "string" ? b.checked_at : null;
  if (b.match !== true || b.recommendation !== "settle" || b.mismatches.length) {
    return deny("terms_mismatch", b.mismatches.map((m) => m && m.field).filter(Boolean).join(",") || "live terms do not match");
  }
  if (b.live_terms_sha256 !== key) return deny("check_malformed", "live_terms_sha256 does not equal the requirement's terms hash");
  return { allow: true, reason_code: "match", reason: "live terms match", check };
}
