// 402xAgent decision gate: call endpoint-spot-check before an agent signs an x402 payment (or requests a
// card credential), and only proceed on verdict "pay" for the exact terms the agent is about to sign.
// No dependencies (Node 18+). Never signs, never pays the target. 5 free checks per day, then the service
// itself answers 402 ($0.02); this helper treats that 402 as "unavailable" and does not pay it.
import { createHash } from "node:crypto";

export const SPOT_CHECK_URL = "https://api.402xagent.com/v1/products/endpoint-spot-check";
export const RISK_KEY = "com.402xagent.check";

const lc = (v) => String(v ?? "").toLowerCase();
const isSolana = (network) => lc(network).startsWith("solana");

/** amount as a decimal string (x402 v2 `amount`, v1 `maxAmountRequired`), or "" */
export function amountOf(req) {
  const a = req && (req.amount ?? req.maxAmountRequired);
  return a == null ? "" : String(a);
}

/**
 * Same formula as the service's payment_terms_sha256: sha256("network|asset|amount|payTo"), network and
 * EVM addresses lowercased (Solana addresses are case-sensitive and kept as-is).
 */
export function termsSha256(req) {
  if (!req) return null;
  const addr = isSolana(req.network) ? (v) => String(v ?? "") : lc;
  const s = [lc(req.network), addr(req.asset), amountOf(req), addr(req.payTo ?? req.pay_to)].join("|");
  return createHash("sha256").update(s).digest("hex");
}

/** "" if the requirement fits what the service approved, else why not. */
export function termsMismatch(req, answer) {
  const p = answer && answer.payment;
  if (p) {
    const atomic = String(p.amount && typeof p.amount === "object" ? p.amount.atomic : p.amount_atomic ?? "");
    const same = isSolana(p.network) ? (a, b) => String(a) === String(b) : (a, b) => lc(a) === lc(b);
    if (lc(req.network) !== lc(p.network)) return "network differs from approved " + p.network;
    if (!same(req.asset, p.asset)) return "asset differs from approved " + p.asset;
    if (!same(req.payTo, p.pay_to)) return "payTo differs from approved " + p.pay_to;
    const amt = amountOf(req);
    if (!/^\d+$/.test(amt) || !/^\d+$/.test(atomic) || BigInt(amt) > BigInt(atomic)) return "amount " + amt + " is above approved " + atomic;
    return "";
  }
  if (answer && answer.payment_terms_sha256) {
    return termsSha256(req) === answer.payment_terms_sha256 ? "" : "terms differ from the approved payment";
  }
  return "no approved terms in the answer";
}

/**
 * Ask the service about `url`. Returns the parsed JSON answer, or { verdict: null, unavailable: "<why>" }.
 * opts: { method, client, ref, endpoint, fetch, timeoutMs }
 */
export async function spotCheck(url, opts = {}) {
  const q = new URLSearchParams({ url, ref: opts.ref ?? "via-decision-gate" });
  if (opts.client) q.set("client", opts.client);
  if (lc(opts.method) === "post") q.set("method", "POST");
  const doFetch = opts.fetch ?? fetch;
  try {
    const r = await doFetch((opts.endpoint ?? SPOT_CHECK_URL) + "?" + q, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (r.status !== 200) return { verdict: null, unavailable: "HTTP " + r.status };
    return await r.json();
  } catch (e) {
    return { verdict: null, unavailable: e && e.message ? e.message : String(e) };
  }
}

/**
 * The gate. `requirement` is the x402 accepts entry the agent is about to sign.
 * Returns { allow, verdict, reason_code, reason, check } where `check` is the record the adapters use.
 * Default is fail closed: allow only on "pay" with matching terms (opts.allowRecheck / opts.allowIfUnavailable relax it).
 */
export async function decide({ url, method = "GET", requirement }, opts = {}) {
  const answer = await spotCheck(url, { ...opts, method });
  const now = opts.now ? opts.now() : new Date();
  const check = {
    endpoint: url,
    method: String(method).toUpperCase(),
    verdict: answer.verdict ?? null,
    reason_code: answer.reason_code ?? (answer.unavailable ? "spot_check_unavailable" : null),
    // The free answer carries no timestamp; paid answers carry probe.probed_at. Else we stamp the client clock.
    checked_at: answer.checked_at ?? (answer.probe && answer.probe.probed_at) ?? now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    terms_sha256: termsSha256(requirement),
    approved_terms_sha256: answer.payment_terms_sha256 ?? null,
    receipt_url: answer.receipt_url ?? null,
  };
  if (answer.unavailable) {
    const allow = opts.allowIfUnavailable === true;
    return { allow, verdict: null, reason_code: check.reason_code, reason: "spot-check unavailable: " + answer.unavailable, check };
  }
  if (answer.verdict === "pay") {
    const why = termsMismatch(requirement, answer);
    if (why) check.reason_code = "terms_mismatch";
    return { allow: !why, verdict: "pay", reason_code: check.reason_code, reason: why || answer.reason || "pay", check };
  }
  const allow = answer.verdict === "recheck" && opts.allowRecheck === true;
  return { allow, verdict: answer.verdict ?? null, reason_code: check.reason_code, reason: answer.reason ?? null, check };
}
