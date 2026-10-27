// Offline fixtures. TYPED_DATA is what @x402/evm 2.28.0 (exact scheme, EIP-3009) passed to signer.signTypedData
// for ACCEPTS, captured with a stub signer (synthetic addresses, nothing signed). Values are BigInts, as viem gets them.
export const RESOURCE = "https://seller.example/api/data";
export const ACCEPTS = {
  scheme: "exact", network: "eip155:8453", amount: "20000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0xabcdef0123456789abcdef0123456789abcdef01",
  maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
};
export const PAYMENT_REQUIRED = { x402Version: 2, resource: { url: RESOURCE, description: "", mimeType: "application/json" }, accepts: [ACCEPTS] };

export function typedData({ nowS, nonce = "0x1e8c572e07e5e9e38fbbffc796a4e3de91e3bfb51c396d5c6c141f6cd25e8645", value = 20000n, to = "0xabCDeF0123456789AbcdEf0123456789aBCDEF01", chainId = 8453 } = {}) {
  return {
    domain: { name: "USD Coin", version: "2", chainId, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: "0x2222222222222222222222222222222222222222", to, value, validAfter: 0n, validBefore: BigInt(nowS + 60), nonce },
  };
}

/** JSON form, as OWS hands it to a policy in typed_data.raw_json. */
export const toJson = (td) => JSON.stringify(td, (k, v) => (typeof v === "bigint" ? v.toString() : v));

/** Stub fetch for POST /v1/facilitator/check. kind: match | mismatch | 429 | 500 | malformed | html | down | hang | badhash */
export function stubFacilFetch(kind = "match", liveHash) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    switch (kind) {
      case "down": throw new TypeError("fetch failed");
      case "hang": return new Promise((_, rej) => init.signal && init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
      case "429": return J({ error: "rate limited", code: "rate_limited", recommendation: "hold" }, 429);
      case "500": return new Response("oops", { status: 500 });
      case "html": return new Response("<html>ok</html>", { status: 200 });
      case "malformed": return J({ match: "yes" });
      case "mismatch": return J({ match: false, mismatches: [{ field: "payTo", expected: "a", live: "b" }], live_terms_sha256: liveHash, checked_at: "2026-10-27T17:00:00Z", recommendation: "hold" });
      case "badhash": return J({ match: true, mismatches: [], live_terms_sha256: "0".repeat(64), checked_at: "2026-10-27T17:00:00Z", recommendation: "settle" });
      default: return J({ match: true, mismatches: [], live_terms_sha256: liveHash, checked_at: "2026-10-27T17:00:00Z", recommendation: "settle", live_status: 402 });
    }
  };
  f.calls = calls;
  return f;
}
