// Approval records shared by the client layer (which knows the URL and runs the check) and the signer layer
// (which only sees EIP-712 typed data and must not touch the network). No dependencies, no network.
//
// Keying: termsSha256 (network|asset|amount|payTo, the service's formula, network normalized to CAIP-2).
// The EIP-3009 nonce and validBefore are created by @x402/evm AFTER onBeforePaymentCreation runs, so they cannot
// be part of the key. Instead the signer layer (1) consumes the approval (single use), (2) requires validBefore
// to be no later than now + the approved maxTimeoutSeconds (+5 s clock slack), and (3) refuses a nonce it has
// already seen while its validBefore has not passed (see prune()).
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { termsKey, evmNetwork } from "../decision-gate/facilitator-gate.mjs";

export class VerifyBeforeSignDenied extends Error {
  constructor(reason) { super("verify-before-sign denied: " + reason); this.name = "VerifyBeforeSignDenied"; }
}

export const DEFAULT_TTL_MS = 60_000;
const SLACK_S = 5;

/** New approval record for an x402 requirement that passed the check. Holds seller-side terms only. */
export function makeApproval(req, { url, method = "GET", source, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const key = termsKey(req);
  if (!key) throw new Error("unsupported network");
  return {
    key, url, method, source: source ?? null,
    network: evmNetwork(req.network), asset: req.asset, amount: String(req.amount ?? req.maxAmountRequired), payTo: req.payTo,
    maxTimeoutSeconds: Number.isFinite(req.maxTimeoutSeconds) && req.maxTimeoutSeconds > 0 ? req.maxTimeoutSeconds : 60,
    created_ms: now, expires_ms: now + ttlMs,
  };
}

// Seen nonces are kept only while their authorization could still settle: an entry is pruned once
// validBefore + SLACK_S has passed (the token contract rejects it after validBefore). checkTypedData prunes on every
// call. maxNonces (default 10000) is a hard cap: when the store is full of still-valid nonces, new signatures are
// denied (fail closed) rather than evicting an entry that could still be replayed.
const nonceExpired = (validBeforeS, now) => validBeforeS + SLACK_S <= Math.floor(now / 1000);
export const DEFAULT_MAX_NONCES = 10_000;

/** In-process store (AgentKit and Turnkey wrappers). take() removes the record: single use. */
export class MemoryApprovals {
  constructor({ maxNonces = DEFAULT_MAX_NONCES } = {}) { this.byKey = new Map(); this.nonces = new Map(); this.maxNonces = maxNonces; }
  /** Drops expired approvals and nonces whose validBefore has passed. */
  prune(now = Date.now()) {
    for (const [k, l] of this.byKey) { const live = l.filter((r) => r.expires_ms > now); if (live.length) this.byKey.set(k, live); else this.byKey.delete(k); }
    for (const [n, vb] of this.nonces) if (nonceExpired(vb, now)) this.nonces.delete(n);
  }
  add(rec) { const l = this.byKey.get(rec.key) || []; l.push(rec); this.byKey.set(rec.key, l); }
  take(key, now = Date.now()) {
    const l = (this.byKey.get(key) || []).filter((r) => r.expires_ms > now);
    const rec = l.shift() || null;
    if (l.length) this.byKey.set(key, l); else this.byKey.delete(key);
    return rec;
  }
  /** true the first time a nonce is seen; false if seen (and not yet expired) or if the store is full. */
  markNonce(nonce, validBeforeS) {
    if (this.nonces.has(nonce) || this.nonces.size >= this.maxNonces) return false;
    this.nonces.set(nonce, validBeforeS); return true;
  }
}

/**
 * Directory store, for a signer in another process (the OWS policy executable). One file per approval;
 * take() claims a file with an atomic rename, so two signers cannot use the same approval.
 */
export class FileApprovals {
  constructor(dir, { maxNonces = DEFAULT_MAX_NONCES } = {}) { this.dir = dir; this.maxNonces = maxNonces; mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  /** Deletes expired approval files and nonce files whose validBefore (the file's content) has passed. */
  prune(now = Date.now()) {
    for (const f of readdirSync(this.dir)) {
      const p = join(this.dir, f);
      try {
        if (f.startsWith("nonce-")) { const t = readFileSync(p, "utf8").trim(); if (/^\d+$/.test(t) && nonceExpired(Number(t), now)) unlinkSync(p); } // "" = being written
        else if (f.endsWith(".json") && !f.startsWith(".")) { const r = JSON.parse(readFileSync(p, "utf8")); if (!(r.expires_ms > now)) unlinkSync(p); }
      } catch (_) {} // claimed or removed by another signer meanwhile
    }
  }
  add(rec) {
    const name = `${rec.key}.${rec.created_ms}.${randomBytes(6).toString("hex")}.json`;
    const tmp = join(this.dir, "." + name + ".tmp");
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, join(this.dir, name));
  }
  take(key, now = Date.now()) {
    if (!/^[0-9a-f]{64}$/.test(String(key))) return null;
    const files = readdirSync(this.dir).filter((f) => f.startsWith(key + ".") && f.endsWith(".json")).sort();
    for (const f of files) {
      const claimed = join(this.dir, f + ".claimed-" + process.pid + "-" + randomBytes(4).toString("hex"));
      try { renameSync(join(this.dir, f), claimed); } catch (_) { continue; } // another signer took it
      let rec = null;
      try { rec = JSON.parse(readFileSync(claimed, "utf8")); } catch (_) {}
      try { unlinkSync(claimed); } catch (_) {}
      if (rec && rec.key === key && rec.expires_ms > now) return rec;
    }
    return null;
  }
  markNonce(nonce, validBeforeS) {
    if (!/^0x[0-9a-f]{64}$/.test(nonce) || !Number.isSafeInteger(validBeforeS)) return false;
    if (readdirSync(this.dir).filter((f) => f.startsWith("nonce-")).length >= this.maxNonces) return false;
    let fd;
    try { fd = openSync(join(this.dir, "nonce-" + nonce), "wx", 0o600); } catch (_) { return false; } // already seen
    try { writeSync(fd, String(validBeforeS)); } finally { closeSync(fd); }
    return true;
  }
}

const big = (v) => {
  if (typeof v === "bigint") return v >= 0n ? v.toString() : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v.trim())) return BigInt(v.trim()).toString();
  return null;
};

/**
 * The x402 requirement implied by EIP-3009 TransferWithAuthorization typed data (what @x402/evm signs for
 * scheme "exact"), or null. Accepts an object (bigints allowed) or a JSON string (OWS raw_json).
 */
export function requirementFromTypedData(td) {
  try { if (typeof td === "string") td = JSON.parse(td); } catch (_) { return null; }
  if (!td || td.primaryType !== "TransferWithAuthorization" || !td.domain || !td.message) return null;
  const chainId = big(td.domain.chainId), amount = big(td.message.value), validBefore = big(td.message.validBefore);
  const { verifyingContract: asset } = td.domain, { to: payTo, nonce } = td.message;
  const addr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!chainId || chainId === "0" || !amount || !validBefore || !addr(asset) || !addr(payTo)) return null;
  if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
  return { scheme: "exact", network: "eip155:" + chainId, asset, amount, payTo, validBefore: Number(validBefore), nonce: nonce.toLowerCase() };
}

/** Signer-side verdict for typed data: { allow, reason }. Never throws, never uses the network. */
export function checkTypedData(store, typedData, { now = Date.now(), expectedChain } = {}) {
  try {
    if (typeof store.prune === "function") store.prune(now);
    const req = requirementFromTypedData(typedData);
    if (!req) return { allow: false, reason: "not an EIP-3009 TransferWithAuthorization this policy can check" };
    if (expectedChain && evmNetwork(expectedChain) !== req.network) return { allow: false, reason: "typed data chainId does not match the signing chain" };
    const rec = store.take(termsKey(req), now);
    if (!rec) return { allow: false, reason: "no approval for these terms (missing, expired or already used)" };
    if (req.validBefore > Math.floor(now / 1000) + rec.maxTimeoutSeconds + SLACK_S) return { allow: false, reason: "validBefore is later than the approved timeout allows" };
    if (!store.markNonce(req.nonce, req.validBefore)) return { allow: false, reason: "nonce already used (or nonce store full)" };
    return { allow: true, reason: "approved " + rec.source + " check for " + rec.url };
  } catch (e) {
    return { allow: false, reason: "policy error: " + (e && e.message) };
  }
}
