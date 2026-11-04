// pdf-tables (draft, OFF by default): POST|GET /v1/products/pdf-tables?url=<pdf> -> tables (CSV / JSON / Markdown) and
// per-page text, extracted by the private Apify Actor withgrokbot/pdf-table-extractor (Python: pdfplumber + Tesseract;
// a Worker can't run it). The Worker handles payment, the SSRF guard, rate limits and the proxy call only.
// Flow: fetch the PDF (SSRF-guarded, 10 MB cap) -> count pages -> 402 quoting pages x price (x402 v2 exact) -> paid
// retry: re-quote, checkPayload against that amount -> run the Actor synchronously -> settle ONLY if every quoted page
// succeeded; otherwise 422 "not charged". No free tier.
// Fails closed: PDF_TABLES must be "1" (route 404s otherwise) and env.APIFY_TOKEN must be set (503, nothing quoted or charged).
import { assertSafeUrl, API_ORIGIN } from "./spotcheck.js";
import { cfg, checkPayload, decodePaymentHeader, verifyAndSettle, paymentRequirements, takeFree } from "./lib.js";
import { guardedGet } from "./p2m.js";

export const PDF_PATH = "/v1/products/pdf-tables";
export const PDF_DEFAULT_PRICE_ATOMIC = "5000"; // $0.005 per digital page (ocr=never)
export const PDF_DEFAULT_OCR_UNITS = 3; // ocr=auto|always quotes 3x per page ($0.015), same as the Actor's 'page' events
export const PDF_MAX_SYNC_PAGES = 20;
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_PER_MIN = 10;
export const PDF_ACTOR = "withgrokbot~pdf-table-extractor";
export const PDF_ACTOR_TIMEOUT_S = 150;
export const pdfOn = (env) => String((env && env.PDF_TABLES) || "") === "1";
export function pdfCfg(env) {
  const c = cfg(env);
  const unit = /^[0-9]{1,12}$/.test(String(env.PDF_PRICE_ATOMIC || "")) ? String(env.PDF_PRICE_ATOMIC) : PDF_DEFAULT_PRICE_ATOMIC;
  const maxPages = Math.min(PDF_MAX_SYNC_PAGES, Math.max(1, parseInt(env.PDF_MAX_SYNC_PAGES || PDF_MAX_SYNC_PAGES, 10) || PDF_MAX_SYNC_PAGES));
  return { ...c, unitAtomic: unit, ocrUnits: PDF_DEFAULT_OCR_UNITS, maxPages };
}
const usd = (atomic) => (Number(atomic) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
export const PDF_MCP_TOOL = {
  name: "pdf_tables",
  description: "Extract the tables (CSV, JSON, Markdown) and per-page text from one PDF at a public URL. Digital PDFs ~97% cell accuracy; scanned pages (OCR) ~80%. Priced per page via x402 USDC on Base: $0.005/page with ocr=never, $0.015/page with ocr=auto. Charged only if every page succeeds. Max 20 pages per call. Retry with the PAYMENT-SIGNATURE header.",
  inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) URL of a PDF" }, pages: { type: "string", description: "page range, e.g. 1-3,7 (default: all, max 20)" }, ocr: { type: "string", enum: ["never", "auto"], description: "never (default, digital PDFs) or auto (OCR scanned pages, 3x price)" } }, required: ["url"] },
};
const b64 = (o) => { const bytes = new TextEncoder().encode(JSON.stringify(o)); let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const J = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE", "cache-control": "no-store", ...extra } });
async function netKey(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "";
  const pre = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip.split(".").slice(0, 3).join(".");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.CLIENT_SALT || "unsalted-dev"}|pdf|${pre}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Page count from raw PDF text: the largest /Count of a /Type /Pages node, else the number of /Type /Page objects; null if unknown (e.g. object streams). */
export function countPdfPages(text) {
  if (!/^%PDF-/.test(text.slice(0, 1024).replace(/^[\s\S]*?(?=%PDF-)/, ""))) return null;
  let best = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) best = Math.max(best, Number(m[1] || m[2]));
  if (best > 0) return best;
  const n = (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  return n > 0 ? n : null;
}
/** "1-3,7" -> sorted unique page numbers within 1..total, or null on a bad spec. */
export function parsePages(spec, total) {
  if (!spec) return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set();
  for (const part of String(spec).replace(/\s+/g, "").split(",").filter(Boolean)) {
    const m = /^(\d+)(?:-(\d*))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]), b = m[2] === undefined ? a : m[2] === "" ? total : Number(m[2]);
    for (let p = a; p <= Math.min(b, total); p++) if (p >= 1) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}
export function quote(c, pageCount, ocr) {
  const units = ocr === "never" ? 1 : c.ocrUnits;
  return { pages: pageCount, unitsPerPage: units, amountAtomic: String(BigInt(c.unitAtomic) * BigInt(units) * BigInt(pageCount)) };
}
function paymentRequired(c, resourceUrl, q, error) {
  const cc = { ...c, priceAtomic: q.amountAtomic };
  const desc = `PDF tables: ${q.pages} page(s) x $${usd(BigInt(c.unitAtomic) * BigInt(q.unitsPerPage))} = $${usd(q.amountAtomic)} USDC on Base; charged only if every page succeeds.`;
  return {
    x402Version: 2, error,
    resource: { url: resourceUrl, description: desc, mimeType: "application/json", serviceName: "402xAgent PDF Tables", tags: ["x402", "pdf", "tables", "ocr", "csv"] },
    accepts: [paymentRequirements(cc, resourceUrl, 2, { paidPath: true, description: desc })],
    quoted_pages: q.pages, units_per_page: q.unitsPerPage, price_usd: usd(q.amountAtomic), asset: "USDC on Base (eip155:8453)",
    how_to_pay: "Retry the same request (same url, pages and ocr) with a PAYMENT-SIGNATURE header for exactly this amount. Settled only if every quoted page is extracted.",
  };
}

/** Run the Actor synchronously. Returns {ok, items} or {ok:false, reason}. */
export async function runActor(env, input, { fetchImpl = fetch } = {}) {
  const u = `https://api.apify.com/v2/acts/${PDF_ACTOR}/run-sync-get-dataset-items?timeout=${PDF_ACTOR_TIMEOUT_S}&memory=2048&clean=1`;
  let r;
  try { r = await fetchImpl(u, { method: "POST", headers: { authorization: "Bearer " + env.APIFY_TOKEN, "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout((PDF_ACTOR_TIMEOUT_S + 15) * 1000) }); }
  catch (e) { return { ok: false, reason: /timeout|abort/i.test(String(e && (e.name || e.message))) ? "extractor_timeout" : "extractor_unreachable" }; }
  if (r.status === 408) return { ok: false, reason: "extractor_timeout" };
  if (!r.ok) return { ok: false, reason: "extractor_http_" + r.status };
  let items; try { items = await r.json(); } catch (_) { return { ok: false, reason: "extractor_bad_response" }; }
  return Array.isArray(items) ? { ok: true, items } : { ok: false, reason: "extractor_bad_response" };
}

export async function handlePdfTables(req, env, ctx, url, opts = {}) {
  if (!pdfOn(env)) return J({ error: "not found" }, 404);
  if (!env.APIFY_TOKEN) return J({ error: "pdf-tables is not configured on this deployment", reason: "extractor_not_configured", charged: false }, 503);
  const c = pdfCfg(env);
  const resourceUrl = url.origin + PDF_PATH;
  let target = url.searchParams.get("url") || "", pagesSpec = url.searchParams.get("pages") || "", ocr = url.searchParams.get("ocr") || "never";
  if (req.method === "POST" && !target) { try { const b = await req.clone().json(); target = String(b.url || ""); pagesSpec = String(b.pages || pagesSpec); ocr = String(b.ocr || ocr); } catch (_) {} }
  if (!["never", "auto"].includes(ocr)) return J({ error: "ocr must be never or auto", charged: false }, 400);
  if (!target) return J({ error: "url is required", usage: API_ORIGIN + PDF_PATH + "?url=https://example.com/report.pdf&pages=1-3", docs: API_ORIGIN + PDF_PATH + "/docs" }, 400);
  const safe = await assertSafeUrl(target, opts.resolveHostFn ? { resolveHostFn: opts.resolveHostFn, fetchImpl: opts.fetchImpl } : {});
  if (!safe.ok) return J({ error: "url not allowed: " + safe.reason, charged: false }, 400);
  target = safe.url.href;
  const now = new Date();
  if (!(await takeFree(env, "pdf-rl:" + (await netKey(req, env)), PDF_PER_MIN, now, "take", "pdf-rl", now.toISOString().slice(0, 16))).free) return J({ error: `rate limited: ${PDF_PER_MIN} requests per minute per network`, charged: false }, 429, { "retry-after": "60" });

  // quote: fetch the PDF and count pages (same fetch on the paid retry, so the amount is recomputed, not trusted)
  const g = await guardedGet(target, { ...(opts.resolveHostFn ? { resolveHostFn: opts.resolveHostFn } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), accept: "application/pdf,*/*;q=0.5", maxBytes: PDF_MAX_BYTES, timeoutMs: 15000 });
  if (g.error) return J({ error: "pdf not fetched", reason: g.error, charged: false }, g.error === "ssrf_blocked" ? 400 : 422);
  if (g.status >= 400) return J({ error: "pdf not fetched", reason: "http_" + g.status, charged: false }, 422);
  const total = countPdfPages(g.text);
  if (!total) return J({ error: "not a PDF, or its page count can't be read", reason: g.text.slice(0, 5) === "%PDF-" ? "page_count_unknown" : "not_pdf", charged: false }, 422);
  const pages = parsePages(pagesSpec, total);
  if (!pages || !pages.length) return J({ error: "bad or empty page range", total_pages: total, charged: false }, 400);
  if (pages.length > c.maxPages) return J({ error: `at most ${c.maxPages} pages per call; pass pages=1-${c.maxPages} and call again for the rest`, total_pages: total, charged: false }, 413);
  const q = quote(c, pages.length, ocr);

  const hdr = req.headers.get("payment-signature") || req.headers.get("x-payment") || "";
  if (!hdr) { const body = paymentRequired(c, resourceUrl, q, "Payment required"); return J(body, 402, { "payment-required": b64(body) }); }
  const payload = decodePaymentHeader(hdr);
  const cc = { ...c, priceAtomic: q.amountAtomic };
  if (!payload) { const body = paymentRequired(c, resourceUrl, q, "payment header is not valid base64 JSON x402 payload"); return J(body, 402, { "payment-required": b64(body) }); }
  const bad = checkPayload(payload, cc);
  if (bad) { const body = paymentRequired(c, resourceUrl, q, "payment rejected: " + bad); return J(body, 402, { "payment-required": b64(body) }); }

  const t0 = Date.now();
  const run = await runActor(env, { pdfUrls: [target], pageRange: pages.join(","), maxPages: pages.length, ocr: ocr === "never" ? "never" : "auto", outputFormats: ["csv", "json", "markdown"], includeText: true }, opts.actorFetch ? { fetchImpl: opts.actorFetch } : {});
  if (!run.ok) return J({ error: "extraction failed", reason: run.reason, charged: false, note: "Nothing was charged." }, 502);
  const rows = run.items.filter((i) => i && i.page != null);
  const failed = run.items.filter((i) => !i || i.status !== "success");
  if (failed.length || rows.length !== pages.length) return J({ error: "not every page was extracted", charged: false, note: "Nothing was charged.", pages: run.items.map((i) => ({ page: i.page ?? null, status: i.status, reason: i.reason || null })) }, 422);

  const r = await verifyAndSettle(cc, payload, new URL(resourceUrl), { paidPath: true, description: "PDF tables", bind: { target: target + "#" + pages.join(",") + "#" + ocr, method: "GET" } });
  if (!r.ok && r.pending) return J({ error: "payment pending", reason: r.reason, ref: r.ref || null, note: "Do not sign a new payment; retry the same request with the same PAYMENT-SIGNATURE." }, 503, { "retry-after": "10" });
  if (!r.ok) { const body = paymentRequired(c, resourceUrl, q, "payment rejected: " + r.reason); return J(body, 402, { "payment-required": b64(body) }); }
  const enc = b64(r.settle);
  const out = rows.map((i) => ({ page: i.page, mode: i.mode, tables: (i.tables || []).map((t) => ({ index: t.index, method: t.method, rows: t.rows, csv: t.csv, json: t.json, markdown: t.markdown })), text: i.text }));
  return J({ url: target, total_pages: total, pages: out, extractor: "apify:" + PDF_ACTOR, ms: Date.now() - t0, access: { tier: "paid", quoted_pages: q.pages, charged_usd: usd(q.amountAtomic), asset: "USDC on Base", ...(r.recovered ? { replayed: true } : {}) } }, 200, { "payment-response": enc, "x-payment-response": enc });
}

export function pdfDocs(c) {
  return {
    product: "pdf-tables", version: "0",
    what: "Tables (CSV, JSON, Markdown) and per-page text from one PDF at a public URL. Digital PDFs via pdfplumber, scanned pages via Tesseract OCR (ocr=auto).",
    route: { methods: ["GET", "POST"], url: API_ORIGIN + PDF_PATH + "?url=<pdf>&pages=1-3&ocr=never|auto" },
    price: { per_page_usd: usd(c.unitAtomic), per_page_ocr_auto_usd: usd(BigInt(c.unitAtomic) * BigInt(c.ocrUnits)), protocol: "x402 v2 exact, amount = pages x per-page price (quoted in the 402)", charged_only_if_all_pages_succeed: true, free_tier: false },
    accuracy: { digital_cell_accuracy: "~97%", scanned_cell_accuracy: "~80%", caveats: ["author blocks and form boxes can come back as tables", "long borderless tables can be split into fragments", "OCR can drop decimal points"] },
    limits: { max_pages_per_call: c.maxPages, max_bytes: PDF_MAX_BYTES, per_minute_per_network: PDF_PER_MIN },
    mcp: { url: API_ORIGIN + "/mcp", tool: "pdf_tables" },
  };
}
