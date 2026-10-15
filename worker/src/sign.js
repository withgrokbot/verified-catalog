// 0.38.0: signed receipts. ed25519 over RFC 8785 (JCS) canonical JSON of the receipt minus `signature` (so `kid` is
// signed). The private key is a Worker secret RECEIPT_SIGNING_KEY (a JSON JWK {kty:"OKP",crv:"Ed25519",kid,x,d}); it is
// never logged or returned. Without the secret (or on any error) receipts stay unsigned and nothing else changes.
// The public keys below are published at /.well-known/402xagent-keys.json. Rotation: add the new key here, deploy,
// then switch the secret; keep old keys listed so old receipts still verify.
export const RECEIPT_PUBLIC_KEYS = Object.freeze([
  // RECEIPT_PUBLIC_KEYS_BEGIN (written by scripts/gen-receipt-key.mjs, public part only)
  { kid: "402xagent-20261015-be7f1a32", x: "Mg-pJzwWOqg5rsQwXjNa3b7VSvI9dkm_-Y0amZfkC34", created: "2026-10-15" },
  // RECEIPT_PUBLIC_KEYS_END
]);
const extraKeys = []; // tests only (_addTestKey); never set in production code paths
const publishedKeys = () => RECEIPT_PUBLIC_KEYS.concat(extraKeys);
export const _addTestKey = (k) => { extraKeys.push(k); };
export function receiptKeysDoc() {
  return {
    issuer: "402xAgent",
    purpose: "ed25519 signatures on 402xAgent check receipts",
    algorithm: "Ed25519 (EdDSA), signature base64url, 64 bytes",
    signed_bytes: "RFC 8785 (JCS) canonical JSON of the receipt with only the signature field removed (kid is signed)",
    verify: "npm x402-spotcheck >= 1.1.0: verifyReceipt(receipt); or see /docs#receipt-signatures",
    keys: publishedKeys().map((k) => ({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: k.kid, x: k.x, ...(k.created ? { created: k.created } : {}) })),
  };
}
export function canonicalize(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new TypeError("JCS: non-finite number"); return JSON.stringify(v); }
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined || typeof x === "function" ? "null" : canonicalize(x))).join(",") + "]";
  if (typeof v === "object") {
    if (typeof v.toJSON === "function") return canonicalize(v.toJSON());
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== "function").sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
  }
  throw new TypeError("JCS: unsupported type " + typeof v);
}
export function signingInput(obj) {
  const { signature, ...rest } = obj || {};
  return new TextEncoder().encode(canonicalize(rest));
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let cached = { raw: null, key: null, kid: null };
async function signer(env) {
  const raw = env && typeof env.RECEIPT_SIGNING_KEY === "string" ? env.RECEIPT_SIGNING_KEY : "";
  if (!raw) return null;
  if (cached.raw === raw) return cached.key ? cached : null;
  cached = { raw, key: null, kid: null };
  try {
    const j = JSON.parse(raw);
    if (!j || j.kty !== "OKP" || j.crv !== "Ed25519" || typeof j.d !== "string" || typeof j.x !== "string" || typeof j.kid !== "string") return null;
    if (!publishedKeys().some((k) => k.kid === j.kid && k.x === j.x)) return null; // only sign with a published key
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: j.x, d: j.d }, { name: "Ed25519" }, false, ["sign"]);
    cached = { raw, key, kid: j.kid };
    return cached;
  } catch (_) {
    return null;
  }
}
/** Returns {...obj, kid, signature} or null when signing is off or fails. Never throws. */
export async function signObject(env, obj) {
  try {
    const s = await signer(env);
    if (!s) return null;
    const body = { ...obj, kid: s.kid };
    delete body.signature;
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, s.key, signingInput(body));
    return { ...body, signature: b64u(sig) };
  } catch (_) {
    return null;
  }
}
export const _resetSigner = () => { cached = { raw: null, key: null, kid: null }; };
