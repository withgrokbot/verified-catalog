#!/usr/bin/env node
// Open Wallet Standard executable policy (https://github.com/open-wallet-standard/core, docs/03-policy-engine.md).
// OWS writes the PolicyContext JSON to stdin; we write { allow, reason } to stdout and ALWAYS exit 0, so a deny is
// an explicit verdict (OWS also denies on a non-zero exit, bad JSON or a 5 s timeout). No network: the 402xAgent
// check already ran in the client layer (client-hook.mjs), which left an approval in policy_config.approvals_dir.
// policy_config: { "approvals_dir": "/abs/dir", "allow_request_types": [] }   (e.g. ["read_balance"])
import { FileApprovals, checkTypedData } from "./approvals.mjs";

export function evaluate(ctx, now = Date.now()) {
  if (!ctx || typeof ctx !== "object") return { allow: false, reason: "no PolicyContext" };
  const cfg = ctx.policy_config || {};
  const extra = Array.isArray(cfg.allow_request_types) ? cfg.allow_request_types : [];
  if (ctx.request_type !== "sign_typed_data") {
    return extra.includes(ctx.request_type) ? { allow: true, reason: ctx.request_type + " allowed by policy_config" }
      : { allow: false, reason: "verify-before-sign allows only x402 typed data (" + ctx.request_type + " denied)" };
  }
  if (typeof cfg.approvals_dir !== "string" || !cfg.approvals_dir.startsWith("/")) return { allow: false, reason: "policy_config.approvals_dir (absolute path) is required" };
  const raw = ctx.typed_data && ctx.typed_data.raw_json;
  if (typeof raw !== "string") return { allow: false, reason: "no typed_data.raw_json" };
  return checkTypedData(new FileApprovals(cfg.approvals_dir), raw, { now, expectedChain: ctx.chain_id });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  let done = false;
  const finish = (v) => {
    if (done) return; done = true;
    process.stdout.write(JSON.stringify({ allow: v.allow === true, reason: String(v.reason || "") }) + "\n", () => process.exit(0));
  };
  setTimeout(() => finish({ allow: false, reason: "stdin read timeout" }), 3000).unref();
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("error", () => finish({ allow: false, reason: "stdin error" }));
  process.stdin.on("end", () => {
    let v;
    try { v = evaluate(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { v = { allow: false, reason: "bad PolicyContext: " + (e && e.message) }; }
    finish(v);
  });
}
