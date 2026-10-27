// Client layer: an @x402/core onBeforePaymentCreation hook. It runs while the resource URL is known, calls the
// 402xAgent check, and on allow records a short-lived, single-use approval for the exact terms. On anything else
// it aborts payment creation, so nothing is signed.
//   import { x402Client } from "@x402/core/client";
//   client.onBeforePaymentCreation(verifyBeforeSignHook({ store }));
import { decideFacilitator } from "../decision-gate/facilitator-gate.mjs";
import { decide as decideSpot } from "../decision-gate/gate.mjs";
import { makeApproval, DEFAULT_TTL_MS } from "./approvals.mjs";

export const CHECKS = { facilitator: decideFacilitator, spot: decideSpot };

/** URL of the resource being paid for: v2 paymentRequired.resource.url, v1 requirement.resource. */
export function resourceUrlOf(ctx) {
  const r = ctx && ctx.paymentRequired && ctx.paymentRequired.resource;
  const v1 = ctx && ctx.selectedRequirements && ctx.selectedRequirements.resource;
  const u = (r && typeof r === "object" ? r.url : r) || (v1 && typeof v1 === "object" ? v1.url : v1);
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;
}

/**
 * opts: { store (required), check: "facilitator" (default, free) | "spot" | fn({url, method, requirement}, checkOpts),
 *         checkOpts, ttlMs (default 60000), method (default "GET": the hook cannot see the HTTP method), now }
 */
export function verifyBeforeSignHook(opts = {}) {
  const { store, ttlMs = DEFAULT_TTL_MS, method = "GET", checkOpts = {} } = opts;
  const check = typeof opts.check === "function" ? opts.check : CHECKS[opts.check ?? "facilitator"];
  if (!store || typeof store.add !== "function") throw new Error("verifyBeforeSignHook: store is required");
  if (!check) throw new Error("verifyBeforeSignHook: unknown check");
  const abort = (reason) => ({ abort: true, reason: "verify-before-sign: " + reason });
  return async (ctx) => {
    try {
      const req = ctx && ctx.selectedRequirements;
      if (!req || req.scheme !== "exact") return abort("only scheme exact is supported");
      if ((req.extra && req.extra.assetTransferMethod || "eip3009") !== "eip3009") return abort("only EIP-3009 transfers are supported");
      const url = resourceUrlOf(ctx);
      if (!url) return abort("no resource URL in the 402");
      const gate = await check({ url, method, requirement: req }, checkOpts);
      if (!gate || gate.allow !== true) return abort((gate && (gate.reason_code || gate.reason)) || "check denied");
      const now = opts.now ? opts.now() : Date.now();
      store.add(makeApproval(req, { url, method, source: gate.check && gate.check.source || (opts.check ?? "facilitator"), ttlMs, now }));
    } catch (e) {
      return abort("error: " + (e && e.message));
    }
  };
}
