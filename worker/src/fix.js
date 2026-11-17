// 0.71.0 "fix the asking": every 400 and 422 JSON body (and the two default 404s for known wrong URLs, and MCP tool
// input errors) carries one machine-readable `fix` object so a caller can correct the request without reading docs:
//   fix: { expected: { required: {name: type}, optional: {name: type}, rules?: [...] },
//          endpoint: { method, url },            // the one correct route (method + URL)
//          example:  { method, url, headers?, body? },   // one working request
//          docs: url }
// Everything here is static: nothing the caller sent is echoed, so no secret or unbounded input can leak into a fix.
// Import-free on purpose (ops.js and lib.js both use it).
const A = "https://api.402xagent.com";
const C = "https://402xagent.com";
const JSON_HDR = { "content-type": "application/json" };
const EX_TARGET = "https://api.402rates.com/v1/ping";
export const FIX_OPENAPI = A + "/openapi.json";

const get = (path, query) => ({ method: "GET", url: A + path + (query ? "?" + query : "") });
const post = (path, body) => ({ method: "POST", url: A + path, headers: JSON_HDR, ...(body !== undefined ? { body } : {}) });

// One entry per route family. `match` is tested against the lower-cased path without a trailing slash.
// `methods` lists the example per request method when a route takes both GET and POST (the first is the default).
export const FIX_ROUTES = [
  { id: "spot-check", match: /^\/v1\/products\/endpoint-spot-check$/, endpoint: { method: "GET", url: A + "/v1/products/endpoint-spot-check" },
    expected: { required: { url: "string, full public http(s) URL of the x402 endpoint to check" }, optional: { claimed_price: "number, USD you expect, e.g. 0.01", pay_to: "string, wallet you expect to be paid", network: "string, CAIP-2 id such as eip155:8453", method: "GET | POST (method of the endpoint being checked)", mode: "live | dry-run", client: "string, 1-64 chars", ref: "string, attribution tag" }, rules: ["GET with ?url=<endpoint> (URL-encode it if it has its own query), or POST a JSON body {\"url\": \"<endpoint>\"}", "placeholder hosts (example.com, localhost, *.test) are refused"] },
    expected_compact: { required: { url: "full http(s) endpoint URL" }, optional: { claimed_price: "USD number", pay_to: "wallet", network: "CAIP-2 id", method: "GET|POST", mode: "live|dry-run" } },
    example: get("/v1/products/endpoint-spot-check", "url=" + EX_TARGET), post_example: post("/v1/products/endpoint-spot-check", { url: EX_TARGET }), docs: A + "/v1/products/endpoint-spot-check/docs" },
  { id: "hygiene", match: /^\/v1\/hygiene$/, endpoint: { method: "GET", url: A + "/v1/hygiene" },
    expected: { required: { url: "string, full public http(s) URL of your x402 endpoint" }, optional: {} }, example: get("/v1/hygiene", "url=" + EX_TARGET), docs: C + "/docs" },
  { id: "lookup", match: /^\/v1\/lookup(\/paid)?$/, endpoint: { method: "GET", url: A + "/v1/lookup" },
    expected: { required: {}, optional: { task: "string, task slug from /v1/tasks (task or endpoint is required)", endpoint: "string, service id or endpoint URL (instead of task)", max_price: "number, USD per call, e.g. 0.05", n: "integer 1-20, default 5", limit: "integer 1-20, default 10", client: "string, 1-64 chars", ref: "string, attribution tag", payer: "string, your 0x wallet" }, rules: ["send task or endpoint"] },
    example: get("/v1/lookup", "task=web-search&max_price=0.05&n=3"), docs: FIX_OPENAPI },
  { id: "endpoint-report", match: /^\/v1\/products\/endpoint-report$/, endpoint: { method: "POST", url: A + "/v1/products/endpoint-report" },
    expected: { required: { url: "string, full http(s) endpoint URL" }, optional: { commitment_ref: "string, cm- + 16 hex from a free check's locked_commitments.ref", include_current: "boolean", client: "string" }, rules: ["JSON body, content-type: application/json"] },
    example: post("/v1/products/endpoint-report", { url: EX_TARGET }), docs: C + "/docs#endpoint-report" },
  { id: "endpoint-report-bulk", match: /^\/v1\/products\/endpoint-report\/bulk$/, endpoint: { method: "POST", url: A + "/v1/products/endpoint-report/bulk" },
    expected: { required: { urls: "array of 1-N distinct endpoint URL strings (N in the 402 body and OpenAPI)" }, optional: { commitment_refs: "object, url -> cm- ref", include_current: "boolean" }, rules: ["JSON body, content-type: application/json"] },
    example: post("/v1/products/endpoint-report/bulk", { urls: [EX_TARGET] }), docs: C + "/docs#endpoint-report" },
  { id: "payment-status", match: /^\/v1\/products\/payment-status$/, endpoint: { method: "POST", url: A + "/v1/products/payment-status" },
    expected: { required: { "payment_payload | tx_hash | from+nonce": "one reference to the payment: base64 PAYMENT-SIGNATURE value, a 0x tx hash, or the signer 0x address plus its nonce" }, optional: { seller_url: "string, the seller URL you paid", valid_before: "integer unix seconds", client: "string" }, rules: ["JSON body, content-type: application/json"] },
    example: post("/v1/products/payment-status", { payment_payload: "<base64 PAYMENT-SIGNATURE value you sent>", seller_url: "https://seller.example/api/x" }), docs: C + "/docs#payment-status" },
  { id: "page-to-markdown", match: /^\/v1\/products\/page-to-markdown$/, endpoint: { method: "GET", url: A + "/v1/products/page-to-markdown" },
    expected: { required: { url: "string, public http(s) page URL" }, optional: { format: "json | markdown (default json)" }, rules: ["GET ?url=..., or POST {\"url\": \"...\"}"] },
    example: get("/v1/products/page-to-markdown", "url=https://example.org/article"), post_example: post("/v1/products/page-to-markdown", { url: "https://example.org/article" }), docs: A + "/v1/products/page-to-markdown/docs",
    reasons: { robots_txt_disallow: "the site forbids automated fetching; nothing to fix on the request", login_wall: "the page needs a login; use a public URL", paywall: "the page is paywalled; use a public URL", not_html: "the URL is not an HTML page", too_large: "the page is over the size limit; use a smaller page", timeout: "the site was too slow; retry later" } },
  { id: "pdf-tables", match: /^\/v1\/products\/pdf-tables$/, endpoint: { method: "GET", url: A + "/v1/products/pdf-tables" },
    expected: { required: { url: "string, public http(s) URL of a PDF" }, optional: { pages: "string, page range such as 1-3 or 1-3,7 (default the first pages)", ocr: "never | auto (default never)" }, rules: ["GET ?url=..., or POST {\"url\": \"...\"}"] },
    example: get("/v1/products/pdf-tables", "url=https://example.org/report.pdf&pages=1-3"), post_example: post("/v1/products/pdf-tables", { url: "https://example.org/report.pdf", pages: "1-3" }), docs: A + "/v1/products/pdf-tables/docs",
    reasons: { not_pdf: "the URL did not return a PDF; point url at the .pdf file itself", page_count_unknown: "the PDF's page count could not be read; try another file", too_large: "the file is over the size limit" } },
  { id: "render-card", match: /^\/v1\/render\/card$/, endpoint: { method: "POST", url: A + "/v1/render/card" },
    expected: { required: { "template+fields | html": "either template (basic | article | product) with a fields object, or an html string; not both" }, optional: { size: "og | twitter | square | custom (custom takes width and height, integers 1-2400)", format: "png | jpeg (default png)" }, rules: ["POST JSON, content-type: application/json", "fields (strings, 300 chars max): basic {eyebrow,title,subtitle,footer}, article {kicker,title,author,date,excerpt,site}, product {badge,title,price,description}; any template also takes image (public http(s) URL)", "GET /v1/render/card only serves a signed link (?t=&sig=) that a keyed POST returns in the x-card-url header; it cannot take fields", "send an x-api-key (free key: POST /v1/render/keys) or pay the x402 402 with PAYMENT-SIGNATURE"] },
    example: post("/v1/render/card", { template: "basic", fields: { title: "Hello" }, size: "og", format: "png" }), docs: A + "/v1/render/docs" },
  { id: "render-pdf", match: /^\/v1\/render\/pdf$/, endpoint: { method: "POST", url: A + "/v1/render/pdf" },
    expected: { required: { "url | html": "send exactly one: a public http(s) URL or an html string" }, optional: { format: "A4 | Letter (default A4)", landscape: "boolean" }, rules: ["POST JSON, content-type: application/json", "x-api-key header or the x402 402"] },
    example: post("/v1/render/pdf", { url: "https://example.org/", format: "A4" }), docs: A + "/v1/render/docs" },
  { id: "render-screenshot", match: /^\/v1\/render\/screenshot$/, endpoint: { method: "POST", url: A + "/v1/render/screenshot" },
    expected: { required: { "url | html": "send exactly one: a public http(s) URL or an html string" }, optional: { format: "png | jpeg (default png)", width: "integer 320-1920", height: "integer 240-4000", fullPage: "boolean" }, rules: ["POST JSON, content-type: application/json", "x-api-key header or the x402 402"] },
    example: post("/v1/render/screenshot", { url: "https://example.org/", format: "png" }), docs: A + "/v1/render/docs" },
  { id: "render-keys", match: /^\/v1\/render\/keys$/, endpoint: { method: "POST", url: A + "/v1/render/keys" },
    expected: { required: { email: "string, a real (non-disposable) email address" }, optional: {}, rules: ["POST JSON, content-type: application/json; GET is not supported"] },
    example: post("/v1/render/keys", { email: "you@yourdomain.com" }), docs: A + "/v1/render/docs" },
  { id: "email", match: /^\/v1\/email\/(validate|batch)$/, endpoint: { method: "POST", url: A + "/v1/email/validate" },
    expected: { required: { email: "string (validate), or emails: array of strings (batch)" }, optional: {}, rules: ["POST JSON, x-api-key header"] },
    example: post("/v1/email/validate", { email: "you@yourdomain.com" }), docs: A + "/v1/email/docs" },
  { id: "watch", match: /^\/v1\/watch(\/.*)?$/, endpoint: { method: "POST", url: A + "/v1/watch" },
    expected: { required: { url: "string, endpoint to watch", webhook_url: "string, public https URL (port 443) that receives change events" }, optional: { method: "GET | POST" }, rules: ["POST JSON, content-type: application/json"] },
    example: post("/v1/watch", { url: EX_TARGET, method: "GET", webhook_url: "https://hooks.yourdomain.com/402x" }), docs: C + "/docs#watch" },
  { id: "facilitator-check", match: /^\/v1\/facilitator\/check$/, endpoint: { method: "POST", url: A + "/v1/facilitator/check" },
    expected: { required: { paymentRequirements: "object, the x402 accepts entry you are about to settle (scheme, network, asset, amount in atomic units, payTo)", "url": "string, the seller's resource URL (or resource / paymentRequirements.resource)" }, optional: { method: "GET | POST" }, rules: ["POST JSON, content-type: application/json"] },
    example: post("/v1/facilitator/check", { url: EX_TARGET, paymentRequirements: { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x<seller wallet>" } }), docs: C + "/docs" },
  { id: "receipts-by-url", match: /^\/v1\/receipts\/by-url$/, endpoint: { method: "GET", url: A + "/v1/receipts/by-url" },
    expected: { required: { url: "string, the endpoint URL whose receipts you want" }, optional: {} }, example: get("/v1/receipts/by-url", "url=" + EX_TARGET), docs: FIX_OPENAPI },
  { id: "receipts", match: /^\/v1\/receipts(\/[^/]+)?$/, endpoint: { method: "GET", url: A + "/v1/receipts" },
    expected: { required: { type: "dry-run | self-checked | live (for the list)" }, optional: { ref: "string, 1-64 chars [a-z0-9._-]", limit: "integer 1-100, default 20", cursor: "string, next_cursor from the previous page, unchanged" }, rules: ["one receipt: GET /v1/receipts/<id>?format=json with an id from a check's receipt_id"] },
    example: get("/v1/receipts", "type=live&limit=20"), docs: FIX_OPENAPI },
  { id: "discover", match: /^\/v1\/discover$/, endpoint: { method: "GET", url: A + "/v1/discover" },
    expected: { required: {}, optional: { q: "string 2-100 chars: letters, digits, space and . _ : / -", verdict: "pay | skip | recheck", limit: "integer 1-20" } }, example: get("/v1/discover", "q=weather&verdict=pay&limit=5"), docs: FIX_OPENAPI },
  { id: "feed", match: /^\/v1\/feed(\/.*)?$/, endpoint: { method: "GET", url: A + "/v1/feed" },
    expected: { required: {}, optional: { category: "search/data | inference | crypto-market | content | infra | other", host: "string, hostname", since: "string, ISO 8601 time", limit: "integer" }, rules: ["one endpoint: GET /v1/feed/endpoint/<hkey> with hkey = h:<64 hex> from a /v1/feed row"] },
    example: get("/v1/feed"), docs: A + "/v1/feed/manifest" },
  { id: "reputation", match: /^\/reputation\/.*$/, endpoint: { method: "GET", url: A + "/reputation/{host}" },
    expected: { required: { host: "path segment: a hostname such as api.402rates.com" }, optional: {}, rules: ["replace {host} with a real hostname"] }, example: { method: "GET", url: A + "/reputation/api.402rates.com" }, docs: FIX_OPENAPI },
  { id: "badge", match: /^\/(v1\/)?badge\/.*$/, endpoint: { method: "GET", url: A + "/v1/badge/{host}.svg" },
    expected: { required: { host: "path segment: a hostname such as api.402rates.com" }, optional: {}, rules: ["/v1/badge/<host>.svg or .json; /badge/<host> is the HTML page"] }, example: { method: "GET", url: A + "/v1/badge/api.402rates.com.svg" }, docs: FIX_OPENAPI },
  { id: "mcp", match: /^\/mcp$/, endpoint: { method: "POST", url: A + "/mcp" },
    expected: { required: { jsonrpc: "\"2.0\"", method: "initialize | tools/list | tools/call", id: "number or string" }, optional: { params: "object; tools/call takes {name, arguments}" }, rules: ["POST one JSON-RPC 2.0 message (or a batch array), content-type: application/json"] },
    example: post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "endpoint_spot_check", arguments: { url: EX_TARGET } } }), docs: A + "/llms.txt" },
];

// Fallback when a 400 comes from a route this table does not know: point at the one free entry point.
const FALLBACK = { id: "start", endpoint: { method: "GET", url: A + "/v1/products/endpoint-spot-check" },
  expected: { required: { url: "string, full public http(s) URL of the x402 endpoint to check" }, optional: {}, rules: ["the full route list is in the OpenAPI document"] },
  example: get("/v1/products/endpoint-spot-check", "url=" + EX_TARGET), docs: FIX_OPENAPI };

const clean = (p) => String(p || "/").toLowerCase().split("?")[0].replace(/\/+$/, "") || "/";
export function routeFor(path) { const p = clean(path); return FIX_ROUTES.find((r) => r.match.test(p)) || null; }
const out = (r, extra) => ({ expected: r.expected, endpoint: r.endpoint, example: r.example, docs: r.docs, ...extra });

/** The fix object for a 400/422 on `path` (+ request `method`). Static data only. */
export function fixFor(path, method, status) {
  const r = routeFor(path) || FALLBACK;
  const m = String(method || "GET").toUpperCase();
  const body = r.post_example && m === "POST" ? { example: r.post_example } : {};
  const fix = out(r, body);
  if (r.expected_compact) fix.expected = r.expected_compact; // the spot-check 400 keeps its small-body budget (see worker_test)
  if (r.id === "receipts" && /^\/v1\/receipts\/[^/]+$/i.test(clean(path))) { fix.endpoint = { method: "GET", url: A + "/v1/receipts/{id}?format=json" }; fix.example = { method: "GET", url: A + "/v1/receipts/sc-0123456789abcdef?format=json" }; }
  if (status === 422 && r.reasons) fix.reasons = r.reasons;
  return fix;
}

/** Fix for a JSON-RPC (MCP) tool: expected from the tool's own inputSchema, example from TOOL_EXAMPLES. */
const TOOL_EXAMPLES = {
  search_catalog: { query: "weather", max_price_usd: 0.05 }, get_service: { id: "<service id from search_catalog>" }, lookup: { task: "web-search", max_price_usd: 0.05 },
  get_overnight_cos_pack: {}, get_receipt: { url: EX_TARGET }, endpoint_spot_check: { url: EX_TARGET }, payment_status: { payment_payload: "<base64 PAYMENT-SIGNATURE value you sent>" },
  x402_hygiene: { url: EX_TARGET }, discover: { q: "weather", verdict: "pay", limit: 5 }, endpoint_report: { url: EX_TARGET }, page_to_markdown: { url: "https://example.org/article" }, pdf_tables: { url: "https://example.org/report.pdf", pages: "1-3" },
};
export function toolFix(name, tools) {
  const t = (tools || []).find((x) => x && x.name === name);
  const args = TOOL_EXAMPLES[name];
  if (!t || !args) return { expected: FALLBACK.expected, endpoint: { method: "POST", url: A + "/mcp" }, example: { method: "POST", url: A + "/mcp", headers: JSON_HDR, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }, docs: A + "/llms.txt" };
  const props = (t.inputSchema && t.inputSchema.properties) || {}, req = new Set((t.inputSchema && t.inputSchema.required) || []);
  const typ = (s) => (s && (Array.isArray(s.enum) ? s.enum.join(" | ") : [].concat(s.type || "any").join(" | "))) + (s && s.description ? ", " + String(s.description).slice(0, 120) : "");
  const required = {}, optional = {};
  for (const [k, s] of Object.entries(props)) (req.has(k) ? required : optional)[k] = typ(s);
  return { expected: { required, optional, rules: ["send the tool's arguments as the `arguments` object of a tools/call"] }, endpoint: { method: "POST", url: A + "/mcp" }, example: { method: "POST", url: A + "/mcp", headers: JSON_HDR, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } }, docs: A + "/llms.txt" };
}

// Wrong URLs callers really hit (404 path log, Nov 2026) -> the right route. Only used for a 404 on that exact path.
const WRONG = [
  { paths: ["/render", "/docs/render", "/v1/render", "/docs/render-api", "/v1/render-api"], to: "render-docs", render: true },
  { paths: ["/v1/render/cards", "/v1/cards", "/v1/card", "/render/card", "/card", "/v1/render/og", "/v1/og", "/v1/render/image", "/v1/render/social-card"], to: "render-card", render: true },
  { paths: ["/v1/render/pdfs", "/v1/pdf", "/render/pdf"], to: "render-pdf", render: true },
  { paths: ["/v1/render/shot", "/v1/render/screenshots", "/v1/screenshot", "/render/screenshot"], to: "render-screenshot", render: true },
  { paths: ["/v1/render/keys"], to: "render-keys", render: true }, // GET/HEAD only: the route exists for POST
  { paths: ["/mcp/mcp", "/mcp/v1", "/sse", "/api/mcp", "/mcp/sse", "/v1/mcp"], to: "mcp" },
];
/** A fix object for a 404 on a known wrong URL, else null. `flags.render` must be true for render routes. */
export function fixFor404(path, method, flags = {}) {
  const p = clean(path);
  const w = WRONG.find((x) => x.paths.includes(p));
  if (!w || (w.render && !flags.render)) return null;
  if (w.to === "render-docs") return { expected: { required: {}, optional: {}, rules: ["the render docs live at one URL"] }, endpoint: { method: "GET", url: A + "/v1/render/docs" }, example: { method: "GET", url: A + "/v1/render/docs" }, docs: A + "/v1/render/docs", note: "this path does not exist" };
  const r = FIX_ROUTES.find((x) => x.id === w.to);
  return { ...out(r), note: p === r.endpoint.url.slice(A.length).toLowerCase() ? "this route takes " + r.endpoint.method + ", not " + String(method || "GET").slice(0, 10).toUpperCase().replace(/[^A-Z]/g, "") : "this path does not exist; the route is " + r.endpoint.method + " " + r.endpoint.url };
}
