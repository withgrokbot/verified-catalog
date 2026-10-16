// 0.42.0 opt-in expiry check for endpoint-spot-check (&check_expiry=1, skew_s 0..300). Same rules as x402-spotcheck 1.4.0 checkExpiry.
// Expiry signals, any hit = skip "challenge_expired":
//  1. the signed EIP-3009 authorization's validBefore (paid path) vs now + skew
//  2. an absolute expiry in the 402's extra: validBefore | expiresAt | expiry | deadline (unix s, unix ms, or ISO 8601)
//  3. maxTimeoutSeconds <= minWindowS (relative window too short to complete); missing = no opinion
// Unparseable or absent values never block.
export const EXPIRY_CODE = "challenge_expired";
export const EXPIRY_FIELDS = Object.freeze(["validBefore", "expiresAt", "expiry", "deadline"]);
export const MAX_SKEW_S = 300;

export function expiryOpts(v) {
  if (!v) return null;
  const o = v === true ? {} : v;
  const skew = Number(o.skewS ?? 30);
  return {
    skewS: Math.max(0, Math.min(MAX_SKEW_S, Number.isFinite(skew) ? skew : 30)),
    minWindowS: Math.max(0, Number(o.minWindowS ?? 5) || 0),
    now: typeof o.now === "function" ? o.now : () => Date.now(),
  };
}

/** Seconds since epoch from unix s, unix ms or ISO; null if unreadable. */
export function toUnixS(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  if (typeof v === "number" || /^\d{1,16}$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  return null;
}

const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
function at(field, s, nowS, skew) {
  if (s == null || nowS + skew < s) return "";
  return s <= nowS
    ? `${EXPIRY_CODE}: ${field} ${iso(s)} expired ${Math.round(nowS - s)}s ago`
    : `${EXPIRY_CODE}: ${field} ${iso(s)} is in ${Math.round(s - nowS)}s, under the ${skew}s skew`;
}

/** "" if fine, else "challenge_expired: ..." for one accepts entry (and the signed authorization if given). */
export function judgeExpiry(req, authorization, eo) {
  if (!eo) return "";
  try {
    const nowS = eo.now() / 1000;
    if (authorization && authorization.validBefore != null) {
      const w = at("authorization.validBefore", toUnixS(authorization.validBefore), nowS, eo.skewS);
      if (w) return w;
    }
    const extra = (req && req.extra) || {};
    for (const f of EXPIRY_FIELDS) {
      const s = toUnixS(extra[f]);
      if (s == null) continue;
      const w = at("extra." + f, s, nowS, eo.skewS);
      if (w) return w;
      break; // the first readable field decides
    }
    const mt = req ? req.maxTimeoutSeconds : undefined;
    if (mt != null && mt !== "" && Number.isFinite(Number(mt)) && Number(mt) <= eo.minWindowS) return `${EXPIRY_CODE}: maxTimeoutSeconds ${Number(mt)} is at or under ${eo.minWindowS}s`;
    return "";
  } catch {
    return "";
  }
}

/** Apply to a live-check decision: skip when every Base USDC option in the live 402 is expired. */
export function applyExpiry(d, probe, eo) {
  const accepts = (Array.isArray(probe && probe.accepts) ? probe.accepts : []).filter((a) => a && String(a.network || "").toLowerCase() === "eip155:8453" || (a && a.network === "base"));
  // The probe flattens the 402's extra (validBefore etc.) onto each option; read both places.
  const lift = (a) => { const x = { ...(a.extra || {}) }; for (const f of EXPIRY_FIELDS) if (x[f] == null && a[f] != null) x[f] = a[f]; return { ...a, extra: x }; };
  const whys = accepts.map((a) => judgeExpiry(lift(a), null, eo));
  const check = { checked: true, skew_s: eo.skewS, options_checked: accepts.length, expired: false, why: null };
  if (!d || d.verdict !== "pay" || !accepts.length || !whys.every(Boolean)) return { d, check };
  check.expired = true;
  check.why = whys[0].slice(EXPIRY_CODE.length + 2);
  return { d: { ...d, verdict: "skip", reason: EXPIRY_CODE }, check };
}
