// pdf-tables (draft, OFF by default): POST|GET /v1/products/pdf-tables?url=<pdf> -> tables (CSV / JSON / Markdown) and
// per-page text, extracted by the private Apify Actor withgrokbot/pdf-table-extractor (Python: pdfplumber + Tesseract;
// a Worker can't run it). The Worker handles payment, the SSRF guard, rate limits and the proxy call only.
// Flow: fetch the PDF (SSRF-guarded, 10 MB cap) -> count pages -> 402 quoting pages x price (x402 v2 exact) -> paid
// retry: re-quote, checkPayload against that amount -> run the Actor synchronously -> settle ONLY if every quoted page
// succeeded; otherwise 422 "not charged". No free tier.
// Fails closed: PDF_TABLES must be "1" (route 404s otherwise) and env.APIFY_TOKEN must be set (503, nothing quoted or charged).
import { assertSafeUrl, API_ORIGIN } from "./spotcheck.js";
import { cfg, checkPayload, decodePaymentHeader, verifyAndSettle, paymentRequirements, takeFree } from "./lib.js";

export const PDF_PATH = "/v1/products/pdf-tables";
export const PDF_DEFAULT_PRICE_ATOMIC = "5000"; // $0.005 per digital page (ocr=never)
export const PDF_DEFAULT_OCR_UNITS = 3; // ocr=auto|always quotes 3x per page ($0.015), same as the Actor's 'page' events
export const PDF_MAX_SYNC_PAGES = 20;
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_PER_MIN = 10;
export const PDF_ACTOR = "withgrokbot~pdf-table-extractor";
export const PDF_ACTOR_TIMEOUT_S = 150;
export const PDF_CACHE_TTL_S = 24 * 3600;
export const PDF_CACHE_MAX_BYTES = 900 * 1024; // larger bodies aren't cached (D1 row limit); a replay then re-runs the Actor but settle stays idempotent (no 2nd charge)
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

const latin1 = (u8) => { let out = ""; for (let i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return out; };
async function inflate(u8) {
  const ds = new DecompressionStream("deflate");
  const w = ds.writable.getWriter(); w.write(u8).catch(() => {}); w.close().catch(() => {});
  const buf = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(buf);
}
function countIn(text) {
  let best = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) best = Math.max(best, Number(m[1] || m[2]));
  return { pagesCount: best, leaves: (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length };
}
export const PDF_MAX_OBJSTM = 200; // object streams inflated per PDF (each capped at 8 MB out)
/**
 * Page count of a PDF (bytes or a latin1 string). Reads the page tree: the largest /Count of a /Type /Pages node, else the
 * number of /Type /Page leaves. Page-tree objects inside compressed object streams (PDF 1.5+, /Type /ObjStm with
 * /FlateDecode) are inflated with DecompressionStream. Returns null for non-PDFs or when no page tree is found.
 */
export async function countPdfPages(input) {
  const u8 = typeof input === "string" ? Uint8Array.from(input, (c) => c.charCodeAt(0) & 255) : input;
  const text = latin1(u8);
  const at = text.indexOf("%PDF-");
  if (at < 0 || at > 1024) return null;
  let { pagesCount, leaves } = countIn(text);
  if (!pagesCount) {
    const re = /\/Type\s*\/ObjStm\b/g; let m, n = 0;
    while ((m = re.exec(text)) && n++ < PDF_MAX_OBJSTM) {
      const dictStart = text.lastIndexOf("obj", m.index);
      const st = text.indexOf("stream", m.index);
      if (dictStart < 0 || st < 0) continue;
      const dict = text.slice(dictStart, st);
      if (!/\/FlateDecode/.test(dict) || /\/DecodeParms/.test(dict)) continue;
      let s0 = st + 6; if (text[s0] === "\r") s0++; if (text[s0] === "\n") s0++;
      const lm = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      const end = lm ? s0 + Number(lm[1]) : text.indexOf("endstream", s0);
      if (end <= s0 || end > u8.length) continue;
      let out; try { out = await inflate(u8.subarray(s0, end)); } catch (_) { continue; }
      if (out.length > 8 * 1024 * 1024) continue;
      const c = countIn(latin1(out)); pagesCount = Math.max(pagesCount, c.pagesCount); leaves += c.leaves;
    }
  }
  if (pagesCount > 0) return pagesCount;
  return leaves > 0 ? leaves : null;
}

/** SSRF-guarded GET of raw bytes (every redirect hop checked), byte cap + timeout. {status, url, bytes} or {error}. */
export async function guardedGetBytes(raw, { fetchImpl = fetch, resolveHostFn, maxBytes = PDF_MAX_BYTES, timeoutMs = 15000 } = {}) {
  let cur = raw; const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop < 6; hop++) {
    const safe = await assertSafeUrl(cur, resolveHostFn ? { resolveHostFn, fetchImpl } : { fetchImpl });
    if (!safe.ok) return { error: "ssrf_blocked", detail: safe.reason };
    let r;
    try { r = await fetchImpl(safe.url.href, { method: "GET", redirect: "manual", headers: { "user-agent": "402xAgent-PdfTables/0.1 (+https://api.402xagent.com" + PDF_PATH + "/docs)", accept: "application/pdf,*/*;q=0.5" }, signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())) }); }
    catch (e) { return { error: /timeout|abort/i.test(String(e && (e.name || e.message))) ? "timeout" : "fetch_failed" }; }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { cur = new URL(r.headers.get("location"), safe.url).href; continue; }
    if (Number(r.headers.get("content-length") || 0) > maxBytes) return { error: "too_large" };
    const chunks = []; let n = 0;
    if (r.body && r.body.getReader) {
      const rd = r.body.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; if (n > maxBytes) { try { rd.cancel(); } catch (_) {} return { error: "too_large" }; } chunks.push(value); }
    } else { const b = new Uint8Array(await r.arrayBuffer()); if (b.length > maxBytes) return { error: "too_large" }; chunks.push(b); n = b.length; }
    const bytes = new Uint8Array(n); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    return { status: r.status, url: safe.url.href, bytes };
  }
  return { error: "too_many_redirects" };
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

const sha = async (str) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function settlementKey(payload) {
  const p = (payload && payload.payload) || {};
  return sha(String(p.signature || "") + "|" + String((p.authorization && p.authorization.nonce) || ""));
}
/** {hit:true, bind, body} | {hit:false}; fail-soft (missing table/DB = miss). */
export async function cacheGet(env, key, nowS = Math.floor(Date.now() / 1000)) {
  try {
    const row = env.RECEIPTS_DB && await env.RECEIPTS_DB.prepare("SELECT bind, body FROM pdf_results WHERE key = ? AND expires_at > ?").bind(key, nowS).first();
    return row ? { hit: true, bind: row.bind, body: JSON.parse(row.body) } : { hit: false };
  } catch (_) { return { hit: false }; }
}
export async function cachePut(env, key, bind, body, nowS = Math.floor(Date.now() / 1000)) {
  try {
    const txt = JSON.stringify(body);
    if (!env.RECEIPTS_DB || txt.length > PDF_CACHE_MAX_BYTES) return false;
    await env.RECEIPTS_DB.prepare("INSERT OR REPLACE INTO pdf_results (key, bind, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(key, bind, txt, nowS, nowS + PDF_CACHE_TTL_S).run();
    await env.RECEIPTS_DB.prepare("DELETE FROM pdf_results WHERE expires_at <= ?").bind(nowS).run();
    return true;
  } catch (_) { return false; }
}
/** true iff the Actor returned exactly one successful row for every requested page and nothing else. */
export function pagesMatch(requested, items) {
  if (!Array.isArray(items) || items.length !== requested.length) return false;
  if (items.some((i) => !i || i.status !== "success" || !Number.isInteger(i.page))) return false;
  const got = items.map((i) => i.page).sort((a, b) => a - b);
  return got.every((p, k) => p === requested[k]);
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
  const g = await guardedGetBytes(target, { ...(opts.resolveHostFn ? { resolveHostFn: opts.resolveHostFn } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  if (g.error) return J({ error: "pdf not fetched", reason: g.error, charged: false }, g.error === "ssrf_blocked" ? 400 : 422);
  if (g.status >= 400) return J({ error: "pdf not fetched", reason: "http_" + g.status, charged: false }, 422);
  const isPdf = latin1(g.bytes.subarray(0, 1024)).includes("%PDF-");
  const total = isPdf ? await countPdfPages(g.bytes) : null;
  if (!total) return J({ error: "not a PDF, or its page count can't be read", reason: isPdf ? "page_count_unknown" : "not_pdf", charged: false }, 422);
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

  const key = await settlementKey(payload);
  const bind = await sha(target + "#" + pages.join(",") + "#" + ocr);
  const cached = await cacheGet(env, key);
  if (cached.hit) {
    if (cached.bind !== bind) return J({ error: "this payment signature was already used for a different request", charged: false, note: "Nothing more was charged." }, 409);
    return J({ ...cached.body, access: { ...(cached.body.access || {}), replayed: true, cached: true } });
  }
  const t0 = Date.now();
  const run = await runActor(env, { pdfUrls: [target], pageRange: pages.join(","), maxPages: pages.length, ocr: ocr === "never" ? "never" : "auto", outputFormats: ["csv", "json", "markdown"], includeText: true }, opts.actorFetch ? { fetchImpl: opts.actorFetch } : {});
  if (!run.ok) return J({ error: "extraction failed", reason: run.reason, charged: false, note: "Nothing was charged." }, 502);
  if (!pagesMatch(pages, run.items)) return J({ error: "the extracted pages don't match the requested pages", charged: false, note: "Nothing was charged.", requested: pages, pages: run.items.map((i) => ({ page: i && i.page != null ? i.page : null, status: i && i.status, reason: (i && i.reason) || null })) }, 422);
  const rows = run.items.slice().sort((x, y) => x.page - y.page);

  const r = await verifyAndSettle(cc, payload, new URL(resourceUrl), { paidPath: true, description: "PDF tables", bind: { target: target + "#" + pages.join(",") + "#" + ocr, method: "GET" } });
  if (!r.ok && r.pending) return J({ error: "payment pending", reason: r.reason, ref: r.ref || null, note: "Do not sign a new payment; retry the same request with the same PAYMENT-SIGNATURE." }, 503, { "retry-after": "10" });
  if (!r.ok) { const body = paymentRequired(c, resourceUrl, q, "payment rejected: " + r.reason); return J(body, 402, { "payment-required": b64(body) }); }
  const enc = b64(r.settle);
  const out = rows.map((i) => ({ page: i.page, mode: i.mode, tables: (i.tables || []).map((t) => ({ index: t.index, method: t.method, rows: t.rows, csv: t.csv, json: t.json, markdown: t.markdown })), text: i.text }));
  const body = { url: target, total_pages: total, pages: out, extractor: "apify:" + PDF_ACTOR, ms: Date.now() - t0, access: { tier: "paid", quoted_pages: q.pages, charged_usd: usd(q.amountAtomic), asset: "USDC on Base", ...(r.recovered ? { replayed: true } : {}) } };
  await cachePut(env, key, bind, body);
  return J(body, 200, { "payment-response": enc, "x-payment-response": enc });
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
