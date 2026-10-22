// 0.51.0 facilitator adapter. Default (FACILITATOR_PRIMARY unset or "payai") = PayAI only, byte-for-byte the 0.50.2 calls.
// FACILITATOR_PRIMARY = "cdp" + secrets CDP_API_KEY_ID / CDP_API_KEY_SECRET: verify/settle on the CDP facilitator
// (Bearer JWT, minted per request with WebCrypto), PayAI as fallback. Optional FACILITATOR_CDP_ROUTES = comma list of
// route paths that use CDP (empty = all). Fallback rules (no double settle):
//   - CDP verify 5xx / timeout / network error -> PayAI verify + settle.
//   - CDP verify 4xx or isValid=false -> declined, no fallback.
//   - once CDP has verified, settle stays on CDP; a CDP settle 5xx/timeout is reported as a failure, never re-settled
//     elsewhere (CDP may already have submitted the authorization).
// Keys are never logged or returned. Without both CDP secrets, "cdp" silently stays on PayAI.

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
export const FAC_TIMEOUT_MS = 10000;
export const CDP_JWT_TTL_S = 120;

const te = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o) => b64url(te.encode(JSON.stringify(o)));
const b64dec = (s) => Uint8Array.from(atob(String(s).replace(/\s+/g, "")), (c) => c.charCodeAt(0));
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const cat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { out.set(x, i); i += x.length; } return out; };
const derLen = (n) => n < 128 ? Uint8Array.of(n) : n < 256 ? Uint8Array.of(0x81, n) : Uint8Array.of(0x82, n >> 8, n & 255);
const der = (tag, body) => cat(Uint8Array.of(tag), derLen(body.length), body);

// SEC1 ECPrivateKey (P-256) -> PKCS8 PrivateKeyInfo, so WebCrypto can import CDP's "EC PRIVATE KEY" PEMs.
function sec1ToPkcs8(sec1) {
  const algId = der(0x30, cat(Uint8Array.of(0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01), Uint8Array.of(0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07)));
  return der(0x30, cat(Uint8Array.of(0x02, 0x01, 0x00), algId, der(0x04, sec1)));
}
const ED25519_PKCS8_PREFIX = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);

const keyCache = new Map(); // secret -> {alg, key}; the secret itself is only a Map key in memory
async function importCdpKey(secret) {
  if (keyCache.has(secret)) return keyCache.get(secret);
  let out;
  const s = String(secret || "").trim();
  const pem = s.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (pem) {
    const body = b64dec(pem[2]);
    const pkcs8 = pem[1] === "EC PRIVATE KEY" ? sec1ToPkcs8(body) : body;
    out = { alg: "ES256", key: await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) };
  } else {
    const raw = b64dec(s); // CDP Ed25519 secret: base64(seed32 || pub32)
    if (raw.length !== 64 && raw.length !== 32) throw new Error("unsupported CDP key format");
    out = { alg: "EdDSA", key: await crypto.subtle.importKey("pkcs8", cat(ED25519_PKCS8_PREFIX, raw.slice(0, 32)), { name: "Ed25519" }, false, ["sign"]) };
  }
  keyCache.set(secret, out);
  return out;
}

/** CDP API bearer JWT for one request: header {alg, kid, typ, nonce}, claims {sub, iss:"cdp", nbf, exp, uris:["METHOD host/path"]}. */
export async function cdpJwt({ keyId, keySecret, method, url, now = Math.floor(Date.now() / 1000) }) {
  const { alg, key } = await importCdpKey(keySecret);
  const u = new URL(url);
  const header = { alg, kid: keyId, typ: "JWT", nonce: hex(crypto.getRandomValues(new Uint8Array(16))) };
  const claims = { sub: keyId, iss: "cdp", nbf: now, exp: now + CDP_JWT_TTL_S, uris: [`${String(method).toUpperCase()} ${u.host}${u.pathname}`] };
  const input = b64urlJson(header) + "." + b64urlJson(claims);
  const sig = alg === "EdDSA"
    ? await crypto.subtle.sign({ name: "Ed25519" }, key, te.encode(input))
    : await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(input)); // raw r||s = JWS ES256
  return input + "." + b64url(sig);
}

export const primaryOf = (env) => (String((env && env.FACILITATOR_PRIMARY) || "payai").toLowerCase() === "cdp" ? "cdp" : "payai");
const hasCdpKeys = (env) => !!(env && env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
function cdpRouteOn(env, path) {
  const list = String((env && env.FACILITATOR_CDP_ROUTES) || "").split(",").map((s) => s.trim()).filter(Boolean);
  return !list.length || list.includes(path);
}

/** Ordered facilitators for a route: [{name, url, auth?}] where auth(method, url) -> headers. Default: [payai]. */
export function facilitatorChain(env, path, payaiUrl) {
  const payai = { name: "payai", url: payaiUrl || "https://facilitator.payai.network" };
  if (primaryOf(env) !== "cdp" || !hasCdpKeys(env) || !cdpRouteOn(env, path)) return [payai];
  const keyId = String(env.CDP_API_KEY_ID), keySecret = String(env.CDP_API_KEY_SECRET);
  const cdp = { name: "cdp", url: String(env.CDP_FACILITATOR_URL || CDP_FACILITATOR_URL).replace(/\/+$/, ""), auth: async (method, url) => ({ authorization: "Bearer " + (await cdpJwt({ keyId, keySecret, method, url })) }) };
  return [cdp, payai];
}

/** One facilitator call with a timeout. Throws on network error/timeout; returns {status, body}. */
export async function callFacilitator(f, path, body, { timeoutMs = FAC_TIMEOUT_MS } = {}) {
  const url = f.url + path;
  const headers = { "content-type": "application/json", accept: "application/json", ...(f.auth ? await f.auth("POST", url) : {}) };
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  let j = null;
  try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j || {} };
}
export const isRetryable = (res) => !res || res.status >= 500; // 5xx; thrown errors (timeout/network) are handled by the caller
