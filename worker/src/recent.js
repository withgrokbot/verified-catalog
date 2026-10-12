// Shared short reason texts (no prices). 0.24.0: used by redacted receipts and the free answer's plain reason.
export const REASON_TEXT = {
  no_x402: "no payment request",
  no_paywall: "no paywall (no payment request)",
  server_error: "server error, check again",
  network_unsupported: "asks for a network we do not support (testnet or unknown)",
  free_trial_active: "seller reports a free trial in use, no payment terms yet, check again",
  price_mismatch: "asks a different price than listed",
  timeout: "endpoint timed out, check again",
  unreachable: "endpoint unreachable, check again",
  ambiguous: "payment request unclear",
  bad_challenge: "payment request unreadable",
  price_ok: "payment request matches",
  network_mismatch: "asks for a different network than expected",
  pay_to_mismatch: "pays a different wallet than expected",
  asset_not_usdc: "asks for a token other than USDC",
};
export const shortReason = (code) => REASON_TEXT[code] || "see receipt";
