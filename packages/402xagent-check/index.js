// 402xagent-check: a thin client of the free 402xAgent check (GET /v1/products/endpoint-spot-check?url=...).
// Zero dependencies; uses the global fetch (Node 18+, browsers, Workers).
export const DEFAULT_BASE = "https://api.402xagent.com";
export const CHECK_PATH = "/v1/products/endpoint-spot-check";

export class CheckError extends Error {
  constructor(message, status, body) { super(message); this.name = "CheckError"; this.status = status; this.body = body; }
}

/** The request URL for a check (exported for tests and for anyone who wants plain curl). */
export function checkUrl(url, { base = DEFAULT_BASE } = {}) {
  if (typeof url !== "string" || !url.trim()) throw new TypeError("check(url): url must be a non-empty string");
  return base.replace(/\/+$/, "") + CHECK_PATH + "?" + new URLSearchParams({ url: url.trim() }).toString();
}

/**
 * Check an x402 endpoint. Resolves to the verdict JSON ({ verdict: "pay" | "skip" | "recheck", reason, reason_code, ... }).
 * Rejects with CheckError (status + parsed body) on 400 (bad URL), 402 (free quota used up), 429 or any other non-2xx.
 */
export async function check(url, { base = DEFAULT_BASE, fetch: f = globalThis.fetch, signal, timeoutMs = 20000 } = {}) {
  if (typeof f !== "function") throw new TypeError("check(url): no fetch available (Node 18+ required)");
  const req = checkUrl(url, { base });
  const ctl = !signal && typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await f(req, { headers: { accept: "application/json", "user-agent": "402xagent-check/0.1.0" }, signal: signal || (ctl && ctl.signal) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) {
      const msg = res.status === 402 ? "Free checks used up for today (5 a day; they reset at 00:00 UTC). Paid checks are $0.02 over x402."
        : res.status === 429 ? "Rate limited; try again later."
        : (body && body.error) || `HTTP ${res.status}`;
      throw new CheckError(msg, res.status, body);
    }
    return body;
  } finally { if (timer) clearTimeout(timer); }
}
export default check;
