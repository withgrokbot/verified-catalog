// HMAC-SHA256 of the raw body, header x-email-probe-signature: v1=<hex>. The body carries ts.
// Reject a stale timestamp and a second use of the same signature inside the skew window.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SKEW_S = 300;
export const MIN_SECRET = 16;

export function hmacHex(secret, body) {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export function signaturesMatch(secret, body, header) {
  const m = /^v1=([0-9a-f]{64})$/i.exec(String(header || "").trim());
  const want = hmacHex(secret, body);
  const got = m ? m[1].toLowerCase() : "0".repeat(64);
  const eq = timingSafeEqual(Buffer.from(got), Buffer.from(want));
  return !!(m && eq);
}

export function createReplayCache(max = 20000) {
  const seen = new Map();
  return {
    seen(sig, nowMs, ttlMs) {
      for (const [k, exp] of seen) if (exp <= nowMs) seen.delete(k);
      if (seen.has(sig)) return true;
      seen.set(sig, nowMs + ttlMs);
      while (seen.size > max) seen.delete(seen.keys().next().value);
      return false;
    },
  };
}

/** {ok:true, email, ts} or {ok:false, status, reason}. Checks the signature before it parses. */
export function verifySignedBody(secret, raw, header, nowMs, replay, skewS = SKEW_S) {
  if (!secret || String(secret).length < MIN_SECRET) return { ok: false, status: 503, reason: "not_configured" };
  if (!signaturesMatch(String(secret), raw, header)) return { ok: false, status: 401, reason: "bad_signature" };
  let obj;
  try { obj = JSON.parse(raw); } catch (_) { return { ok: false, status: 400, reason: "bad_json" }; }
  if (!obj || obj.v !== 1 || typeof obj.email !== "string") return { ok: false, status: 400, reason: "bad_body" };
  if (!Number.isInteger(obj.ts)) return { ok: false, status: 401, reason: "bad_timestamp" };
  if (Math.abs(Math.floor(nowMs / 1000) - obj.ts) > skewS) return { ok: false, status: 401, reason: "stale" };
  const sig = String(header || "").trim().toLowerCase();
  if (replay.seen(sig, nowMs, skewS * 1000)) return { ok: false, status: 409, reason: "replay" };
  return { ok: true, email: obj.email, ts: obj.ts };
}
