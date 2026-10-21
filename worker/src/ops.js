// 0.48.0 ops counters and explicit error bodies.
//  - paywall funnel per route (402 served, payment attempts, failures by reason, settlements), self/drill vs outside
//  - 404 path log (normalized method + path only)
//  - 405: Allow header + JSON naming the right method(s)
//  - 400: every 400 names the field, what was expected, what was received (sanitized) and the openapi.json link
// Storage: aggregate daily counts in D1 (migration 0014). Never stored: IPs, wallets, payment proofs, tx hashes,
// query strings, client values. The self/drill decision uses the signer at request time and keeps only the label.

export const OPENAPI_URL = "https://api.402xagent.com/openapi.json";
export const SKILL_URL = "https://api.402xagent.com/skill.md";
export const FAIL_REASONS = ["bad_sig", "wrong_network_or_asset", "insufficient_amount", "expired", "facilitator_error", "other"];
const NF_MAX = 120;

const day = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

// ------------------------------------------------------------------ paywall funnel
// Routes that can answer 402. Anything else that answers 402 is counted under its normalized path.
export function paywallRoute(path) {
  if (path === "/v1/lookup/paid" || path === "/v1/products/overnight-cos-pack" || path === "/v1/products/endpoint-spot-check" ||
      path === "/v1/products/payment-status" || path === "/v1/products/endpoint-report" || path === "/v1/products/endpoint-report/bulk" || path === "/v1/watch") return path;
  if (/^\/v1\/watch\/wt-[0-9a-f]{16}\/renew$/.test(path)) return "/v1/watch/:id/renew";
  return "";
}

/** Failure reason bucket from the rejection text the handlers already return (never stored itself). */
export function failReason(text) {
  const t = String(text || "").toLowerCase();
  if (/facilitator unreachable|settlement failed|settlement_pending|http 5\d\d|unexpected_(verify|settle)_error|timeout/.test(t)) return "facilitator_error";
  if (/valid_before|valid_after|validbefore|validafter|expired|too early|not yet valid/.test(t)) return "expired";
  if (/insufficient|amount does not match|value does not match|invalid_exact_evm_payload_authorization_value/.test(t)) return "insufficient_amount";
  if (/scheme or network|invalid_network|unsupported_scheme|asset is not|invalid_asset|x402version|network_mismatch/.test(t)) return "wrong_network_or_asset";
  if (/signature|invalid_exact_evm_payload(?!_authorization_va)|recover|not valid base64|invalid_payload/.test(t)) return "bad_sig";
  return "other";
}

const ADDR = /^0x[0-9a-f]{40}$/;
/** self = the payment signer is our own payTo or one of DRILL_WALLETS (comma list, config). Nothing is kept but the label. */
export function segmentOf(payload, env, payTo) {
  try {
    const from = String((((payload || {}).payload || {}).authorization || {}).from || "").toLowerCase();
    if (!ADDR.test(from)) return "outside";
    const own = [String(payTo || env.PAY_TO || ""), ...String(env.DRILL_WALLETS || env.DRILL_WALLET || "").split(",")].map((s) => s.trim().toLowerCase()).filter((s) => ADDR.test(s));
    return own.includes(from) ? "self" : "outside";
  } catch (_) { return "outside"; }
}

/** Counter rows for one request/response pair. `payload` = decoded payment header or null; `errText` = response error text. */
export function funnelRows({ route, hasPayment, status, settled, errText, segment }) {
  const rows = [];
  const seg = segment || "outside";
  if (status === 402) rows.push([route, seg, "402", ""]);
  if (hasPayment) {
    rows.push([route, seg, "attempt", ""]);
    if (settled) rows.push([route, seg, "settled", ""]);
    else if (status === 402) rows.push([route, seg, "failed", failReason(errText)]);
    else rows.push([route, seg, "not_charged", ""]);
  }
  return rows;
}

export async function writeFunnel(db, rows, now = new Date()) {
  if (!db || !rows.length) return;
  const d = day(now);
  const sql = "INSERT INTO paywall_daily (day, route, segment, event, reason, n) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(day, route, segment, event, reason) DO UPDATE SET n = n + 1";
  const st = rows.map((r) => db.prepare(sql).bind(d, ...r));
  if (db.batch && st.length > 1) await db.batch(st); else for (const s of st) await s.run();
}

// ------------------------------------------------------------------ 404 path log
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
export function normMethod(m) { const u = String(m || "").toUpperCase(); return METHODS.has(u) ? u : "OTHER"; }
/** Path only (no query), ids and hex runs collapsed, no emails/wallets/tokens, <= 120 chars. */
export function normalizePath(p) {
  let s = String(p || "/").split("?")[0].split("#")[0];
  try { s = decodeURIComponent(s); } catch (_) {}
  s = s.replace(/[^\x21-\x7e]/g, "").replace(/\/{2,}/g, "/");
  const segs = s.split("/").map((g) => {
    if (!g) return g;
    if (g.includes("@")) return ":email";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g)) return ":uuid";
    if (/^\d+$/.test(g)) return ":n";
    let x = g.replace(/0x[0-9a-f]+/gi, ":hex").replace(/[0-9a-f]{8,}/gi, ":hex");
    if (/^[A-Za-z0-9_\-+=]{24,}$/.test(x) && /\d/.test(x)) return ":id";
    x = x.replace(/\d{4,}/g, ":n");
    return x.length > 48 ? x.slice(0, 48) + "…" : x;
  });
  s = segs.join("/") || "/";
  if (s.length > NF_MAX) s = s.slice(0, NF_MAX - 1) + "…";
  return s;
}
export async function writeNotFound(db, method, path, now = new Date()) {
  if (!db) return;
  await db.prepare("INSERT INTO notfound_daily (day, method, path, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, method, path) DO UPDATE SET n = n + 1").bind(day(now), normMethod(method), normalizePath(path)).run();
}

// ------------------------------------------------------------------ stats (Bearer WATCH_STATS_TOKEN)
export async function opsStats(db, { days = 7, now = new Date() } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const since = day(new Date(new Date(now).getTime() - (n - 1) * 86400000));
  const f = ((await db.prepare("SELECT route, segment, event, reason, SUM(n) AS n FROM paywall_daily WHERE day >= ? GROUP BY route, segment, event, reason ORDER BY route, segment, event, reason").bind(since).all()) || {}).results || [];
  const funnel = {};
  for (const r of f) {
    const x = ((funnel[r.route] ||= {})[r.segment] ||= { "402": 0, attempt: 0, settled: 0, not_charged: 0, failed: 0, failed_by_reason: Object.fromEntries(FAIL_REASONS.map((k) => [k, 0])) });
    if (r.event === "failed") { x.failed += r.n; x.failed_by_reason[r.reason in x.failed_by_reason ? r.reason : "other"] += r.n; }
    else if (r.event in x) x[r.event] += r.n;
  }
  const top = ((await db.prepare("SELECT method, path, SUM(n) AS n FROM notfound_daily WHERE day >= ? GROUP BY method, path ORDER BY n DESC, path LIMIT 20").bind(since).all()) || {}).results || [];
  const tot = (await db.prepare("SELECT SUM(n) AS n FROM notfound_daily WHERE day >= ?").bind(since).first()) || {};
  return { since, until: day(now), days: n, paywall_funnel: funnel, not_found: { total: tot.n || 0, top20: top } };
}

// ------------------------------------------------------------------ 405
export function methodNotAllowed(method, allow, path, extra = {}) {
  const allowed = String(allow).split(",").map((s) => s.trim()).filter(Boolean);
  const use = allowed.filter((m) => m !== "OPTIONS" && m !== "HEAD");
  const body = {
    error: "method_not_allowed",
    message: `${normMethod(method)} is not allowed on ${normalizePath(path)}; use ${use.join(" or ")}`,
    method: normMethod(method), allowed, path: normalizePath(path),
    openapi: OPENAPI_URL, skill: SKILL_URL, ...extra,
  };
  return new Response(JSON.stringify(body), { status: 405, headers: { "content-type": "application/json; charset=utf-8", allow: allowed.join(", "), "access-control-allow-origin": "*", "cache-control": "no-store" } });
}

// ------------------------------------------------------------------ 400
const SENSITIVE = new Set(["payment_payload", "tx_hash", "from", "nonce", "payer", "pay_to", "client", "webhook_url", "commitment_ref", "authorization", "signature"]);
/** What the caller sent, safe to echo: never wallets, hashes, proofs or tokens; capped. */
export function sanitizeReceived(field, v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") return Array.isArray(v) ? `[array of ${v.length}]` : `[object with keys: ${Object.keys(v).slice(0, 8).map((k) => String(k).replace(/[^A-Za-z0-9_.\-]/g, "").slice(0, 24)).join(", ")}]`;
  let s = String(v);
  if (SENSITIVE.has(field)) return s ? `[${s.length} chars, not echoed]` : "";
  if (/^https?:\/\//i.test(s.trim())) { try { const u = new URL(s.trim()); s = u.origin + u.pathname; } catch (_) {} }
  if (/0x[0-9a-f]{16,}/i.test(s) || /[A-Za-z0-9+\/=_\-]{40,}/.test(s) || /@/.test(s)) return `[${s.length} chars, not echoed]`;
  s = s.replace(/[^\x20-\x7e]/g, "?");
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}
const EXPECTED = {
  url: "a full http(s) URL of an x402 endpoint, e.g. https://api.402rates.com/v1/ping",
  max_price: "a non-negative USD number, e.g. 0.01",
  claimed_price: "a non-negative USD number, e.g. 0.01",
  client: "1-64 characters: letters, digits, dot, dash, underscore",
  ref: "1-64 characters: lowercase letters, digits, dot, dash, underscore",
  payer: "a 0x address (40 hex characters)",
  q: "2-100 characters: letters, digits, space and . _ : / -",
  verdict: "pay, skip or recheck",
  limit: "an integer 1-20",
  type: "dry-run, self-checked or live",
  cursor: "the next_cursor value from the previous page, unchanged",
  body: "a JSON object sent with content-type: application/json",
  task: "a task slug from https://api.402xagent.com/v1/tasks (or endpoint=<url>)",
  network: "a CAIP-2 network id, e.g. eip155:8453",
  pay_to: "the wallet you expect to pay (0x... or base58)",
  mode: "dry-run or live",
  host: "a hostname, e.g. api.402rates.com",
  path: "a concrete path: replace every {placeholder} with a real value",
  method: "GET or POST",
  webhook_url: "a public https webhook URL",
  seller_url: "the seller's full https URL",
  payment_payload: "the base64 PAYMENT-SIGNATURE value you sent",
  tx_hash: "a 0x transaction hash (64 hex characters)",
  commitment_ref: "a commitment ref from a free check's locked_commitments",
};
const FIELD_FROM_MSG = /^(?:invalid |missing )?"?([a-z_]+)"? (?:must|is required|or endpoint)/i;
export function inferField(body, path) {
  if (body.field) return String(body.field);
  const msg = String(body.error || body.message || "");
  let m = /^unknown parameter (\S+)/.exec(msg); if (m) return m[1];
  if (body.error === "unfilled_template") return "path";
  if (path.startsWith("/reputation")) return "host";
  m = FIELD_FROM_MSG.exec(msg); if (m) return m[1].toLowerCase();
  return "request";
}
export function receivedFor(field, { url, path, method, jsonBody }) {
  if (field === "path") return sanitizeReceived("path", normalizePath(path));
  if (field === "host") return sanitizeReceived("host", decodeURIComponent(path.replace(/^\/reputation\/?/, "")));
  if (field === "method") return normMethod(method);
  if (field === "body") return jsonBody === undefined ? "[no JSON body]" : jsonBody === null ? "[not a JSON object]" : sanitizeReceived("body", jsonBody);
  if (url.searchParams.has(field)) return sanitizeReceived(field, url.searchParams.get(field));
  if (jsonBody && typeof jsonBody === "object" && field in jsonBody) return sanitizeReceived(field, jsonBody[field]);
  if (/^unknown/.test(field)) return null;
  return null; // not sent
}
/** Adds field/expected/received/openapi to a 400 JSON body (existing keys win). */
export function explain400(body, ctx) {
  const field = inferField(body, ctx.path);
  const unknownParam = /^unknown parameter /.test(String(body.error || ""));
  const expected = body.expected || (unknownParam ? "one of: " + (body.allowed || []).join(", ") : EXPECTED[field] || String(body.problem || body.error || body.message || "see openapi.json").replace(/\. Example:.*$/s, "").slice(0, 300));
  let received = receivedFor(field, ctx);
  if (unknownParam) received = sanitizeReceived(field, ctx.url.searchParams.get(field));
  return { ...body, field, expected, received: body.received !== undefined ? body.received : (received === null ? "[not sent]" : received), openapi: body.openapi || OPENAPI_URL };
}
