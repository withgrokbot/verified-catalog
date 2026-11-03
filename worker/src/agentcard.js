// 0.61.0: A2A AgentCard (A2A spec v1.0, https://a2a-protocol.org/latest/specification/) served at /.well-known/agent.json
// and the spec's well-known path /.well-known/agent-card.json. Public facts only: no personal identifiers, no email.
// The service URL lives in supportedInterfaces[].url (v1.0 has no top-level url; the AgentCard schema has additionalProperties false).
import { API_ORIGIN, CANON_ORIGIN } from "./spotcheck.js";

export const AGENT_CARD_PATHS = new Set(["/.well-known/agent.json", "/.well-known/agent-card.json"]);
export const AGENT_DESCRIPTION = "Check an x402 endpoint before your agent pays: pay, skip or recheck, with Ed25519-signed receipts."; // = server.json description
export const X_HANDLE = "@402xAgent";
export const X_URL = "https://x.com/402xAgent";
export const LOGO_400_URL = CANON_ORIGIN + "/logo-400.png";

export function agentCard(version) {
  return {
    name: "402xAgent",
    description: AGENT_DESCRIPTION,
    supportedInterfaces: [{ url: API_ORIGIN, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
    provider: { organization: "402xAgent", url: CANON_ORIGIN },
    version,
    documentationUrl: CANON_ORIGIN + "/docs",
    iconUrl: LOGO_400_URL,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "free-check",
        name: "Free x402 pre-payment check",
        description:
          "GET " + API_ORIGIN + "/v1/products/endpoint-spot-check?url=<endpoint> probes a public x402 endpoint once without paying it and answers " +
          "pay, skip or recheck with a stable reason_code, the price quoted in its live 402 versus the listing, and an Ed25519-signed receipt. " +
          "5 free checks per client per UTC day (at most 25 per network); add &mode=dry-run for a free dry run that never approves a payment. " +
          "Also the MCP tool endpoint_spot_check at " + API_ORIGIN + "/mcp.",
        tags: ["x402", "payments", "pre-payment check", "free"],
        examples: [API_ORIGIN + "/v1/products/endpoint-spot-check?url=https://api.402rates.com/v1/ping", "Should my agent pay https://api.402rates.com/v1/ping?"],
        inputModes: ["application/json", "text/plain"],
        outputModes: ["application/json"],
      },
      {
        id: "spot-check",
        name: "Paid spot-check with full payment terms",
        description:
          "The same check after the free quota: HTTP 402, $0.02 USDC on Base via x402 (exact scheme, amount 20000). Never pays the target. " +
          "Adds the full payment details to the verdict (the exact payment terms, pay_to and deadline); optional claimed_price, " +
          "pay_to, network and quote turn a mismatch into skip or recheck. Rules and reason codes: " + CANON_ORIGIN + "/rules.json.",
        tags: ["x402", "payments", "spot-check", "paid", "USDC", "Base"],
        examples: [API_ORIGIN + "/v1/products/endpoint-spot-check?url=https://api.402rates.com/v1/ping&pay_to=0x...&network=eip155:8453"],
        inputModes: ["application/json", "text/plain"],
        outputModes: ["application/json"],
      },
    ],
  };
}
