// 0.50.0 hygiene fixtures. SYNTHETIC and anonymised: hosts, payTo and asset addresses are made up; shapes mirror
// patterns we saw (CDP Bazaar listing-vs-402 network mismatch, a "Frantic-style" v1/v2 mix) without copying any capture.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // public Base USDC contract (not seller data)
const PAYTO = "0x00000000000000000000000000000000000000a1";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const v2 = (over = {}) => ({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 300, ...over }] });
export const GOOD = { status: 402, headers: { "content-type": "application/json", "payment-required": b64(v2()) }, bodyText: JSON.stringify(v2()), latencies: [120, 180, 150] };
// Bazaar listing says Base mainnet; the live 402 quotes Base Sepolia.
export const BAZAAR_MISMATCH = { status: 402, headers: { "content-type": "application/json" }, bodyText: JSON.stringify(v2({ network: "eip155:84532" })), latencies: [300, 320, 310], listing: { network: "eip155:8453" } };
// Body says v2 with v1 field names; header says v1.
const mix = { x402Version: 2, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "10000", asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 300 }] };
export const FRANTIC_MIX = { status: 402, headers: { "content-type": "application/json", "payment-required": b64({ ...mix, x402Version: 1 }) }, bodyText: JSON.stringify(mix), latencies: [900, 1100, 1000] };
export const V1_OK = { status: 402, headers: { "content-type": "application/json" }, bodyText: JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "10000", asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 300, resource: "https://seller.fixture/x", description: "d", mimeType: "application/json" }] }), latencies: [100, 100, 100] };
export { b64, v2 };
