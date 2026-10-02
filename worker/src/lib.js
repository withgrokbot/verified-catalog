// Reliability lookup Worker (logic; entry point is index.js) for the Verified Pay-Per-Call Catalog (demand test, see DEMAND_TEST.md in the job).
//
//   GET /v1/lookup?task=web-search&max_price=0.01&n=5[&endpoint=<id|url>][&client=<name>][&ref=<source>][&payer=<0x wallet>][&limit=10]
//   GET /v1/tasks        task names and how many services each has
//   GET /openapi.json    OpenAPI 3.1 description
//   GET /                short help
//
// Data: catalog.json and receipts.json from the Pages site (DATA_BASE_URL), cached. The Worker holds no data of its
// own; it only answers queries and counts distinct clients (one Analytics Engine data point per lookup).
// Privacy: raw IPs are never stored. Without a `client` value the client id is a hash of the IP /24 (IPv6 /48)
// plus the User-Agent, salted with a secret that changes every ISO week.
// No runtime dependencies.

export const VERSION = "0.2.0";
const DEFAULT_DATA = "https://withgrokbot.github.io/verified-catalog/";
const CACHE_TTL_S = 300;
const STALE_AFTER_H_DEFAULT = 36;
// Known search/AI crawlers and link unfurlers (not agents acting on a task). Generic "bot" is not excluded:
// many real agents call themselves bots.
const CRAWLER_RE = /(googlebot|google-inspectiontool|googleother|bingbot|bingpreview|applebot|duckduckbot|yandex|baiduspider|slurp|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|seznambot|gptbot|oai-searchbot|ccbot|claudebot|anthropic-ai|perplexitybot|bytespider|amazonbot|facebookexternalhit|meta-externalagent|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|embedly|crawler|spider|scrapy|headlesschrome|lighthouse)/i;
const UPTIME_RE = /(uptime|pingdom|statuscake|site24x7|betteruptime|better stack|hetrixtools|freshping|nodeping|monitis|checkly|updown\.io|cron-job\.org|healthcheck|monitor)/i;
const SELF_UA_RE = /withgrokbot/i;

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...extra,
    },
  });

// ------------------------------------------------------------------ data
const memo = new Map(); // url -> {at, data}

async function getJson(url, env, ctx) {
  const now = Date.now();
  const hit = memo.get(url);
  if (hit && now - hit.at < CACHE_TTL_S * 1000) return hit.data;
  let resp;
  try {
    resp = await fetch(url, { cf: { cacheTtl: CACHE_TTL_S, cacheEverything: true }, headers: { accept: "application/json" } });
  } catch (e) {
    if (hit) return hit.data; // serve the last good copy
    throw new Error(`data fetch failed: ${url}`);
  }
  if (resp.status === 404) {
    memo.set(url, { at: now, data: null });
    return null;
  }
  if (!resp.ok) {
    if (hit) return hit.data;
    throw new Error(`data fetch failed: ${url} HTTP ${resp.status}`);
  }
  const data = await resp.json();
  memo.set(url, { at: now, data });
  return data;
}

export async function loadData(env, ctx) {
  const base = (env.DATA_BASE_URL || DEFAULT_DATA).replace(/\/?$/, "/");
  const [catalog, receipts] = await Promise.all([
    getJson(base + "catalog.json", env, ctx),
    getJson(base + "receipts.json", env, ctx),
  ]);
  if (!catalog || !Array.isArray(catalog.services)) throw new Error("catalog.json missing or invalid");
  return { base, catalog, receipts: receipts || { services: {}, stale_after_hours: STALE_AFTER_H_DEFAULT } };
}

export function _resetCache() {
  memo.clear();
}

// ------------------------------------------------------------------ matching
const norm = (s) => String(s || "").toLowerCase().trim();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function taskIndex(catalog) {
  const idx = {};
  for (const s of catalog.services) for (const t of s.tasks || []) (idx[t] ||= []).push(s.id);
  return idx;
}

function matchesTask(s, task, known) {
  if (!task) return true;
  const t = slug(task);
  if ((s.tasks || []).map(slug).includes(t)) return true;
  if (known.has(t)) return false; // a known task name matches exactly, never by description text
  // fallback for unknown task names: every word appears in the service's name, category or description
  const hay = norm([s.id, s.name, s.category, s.description, (s.tasks || []).join(" ")].join(" "));
  const words = t.split("-").filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

function matchesEndpoint(s, ep) {
  if (!ep) return true;
  const e = norm(ep).replace(/\/+$/, "");
  const url = norm(s.endpoint).replace(/\/+$/, "");
  return norm(s.id) === e || url === e || (e.startsWith("http") && (e.startsWith(url) || url.startsWith(e)));
}

// ------------------------------------------------------------------ one service record
export function summarize(s, rec, n, now, staleH) {
  const all = (rec && rec.receipts) || [];
  const last = all.slice(0, n);
  const graded = last.filter((r) => r.quality === "pass" || r.quality === "fail");
  const passes = graded.filter((r) => r.quality === "pass").length;
  const newest = all.length ? Date.parse(all[0].time) : NaN;
  const ageH = Number.isFinite(newest) ? (now - newest) / 3600000 : null;
  const qt = (rec && rec.quality_test) || s.quality_test || null;
  const latest = s.latest || {};
  return {
    id: s.id,
    name: s.name,
    endpoint: s.endpoint,
    method: (s.sample_request && s.sample_request.method) || "GET",
    price_usd: s.advertised_price && s.advertised_price.amount_usd,
    price_asset: "USDC on Base",
    tasks: s.tasks || [],
    pass_rate: graded.length ? Math.round((passes / graded.length) * 1000) / 1000 : null,
    graded_receipts: graded.length,
    passed_receipts: passes,
    receipts_considered: last.length,
    quality_test: qt ? { input: qt.input, pass_if: qt.pass_if } : null,
    last_check_at: latest.checked_at || null,
    last_check: {
      reachable: latest.reachable ?? null,
      x402_challenge: latest.x402_challenge ?? null,
      quoted_price_usd: latest.quoted_price_usd ?? null,
      price_matches_listing: latest.price_matches_listing ?? null,
    },
    newest_receipt_at: all.length ? all[0].time : null,
    stale: ageH === null || ageH > staleH,
    receipts: last.map((r) => ({
      time: r.time,
      tx: r.tx,
      basescan_url: r.basescan_url,
      charged_usd: r.charged_usd,
      delivered: r.delivered,
      quality: r.quality,
      quality_reason: r.quality_reason,
      raw_log_url: r.raw_log_url,
    })),
    pay_to: [...new Set(all.map((r) => r.pay_to).filter(Boolean))],
    page_url: s.page_url,
  };
}

function isFactsOnly(s, rec) {
  const qt = (rec && rec.quality_test) || s.quality_test;
  return qt && qt.facts_only ? qt.facts_only_reason || "broken on the seller's side" : null;
}

export function lookup(data, q, now = Date.now()) {
  const { catalog, receipts } = data;
  const staleH = Number(receipts.stale_after_hours) || STALE_AFTER_H_DEFAULT;
  const n = q.n;
  const known = new Set(Object.keys(taskIndex(catalog)).map(slug));
  const cands = catalog.services.filter(
    (s) =>
      matchesTask(s, q.task, known) &&
      matchesEndpoint(s, q.endpoint) &&
      (q.max_price === null || Number(s.advertised_price && s.advertised_price.amount_usd) <= q.max_price + 1e-12)
  );
  const results = [];
  const factsOnly = [];
  for (const s of cands) {
    const rec = (receipts.services || {})[s.id];
    const sum = summarize(s, rec, n, now, staleH);
    const why = isFactsOnly(s, rec);
    if (why) {
      delete sum.pass_rate;
      delete sum.graded_receipts;
      delete sum.passed_receipts;
      factsOnly.push({ ...sum, facts_only_reason: why });
    } else results.push(sum);
  }
  results.sort((a, b) => {
    const pa = a.pass_rate === null ? -1 : a.pass_rate;
    const pb = b.pass_rate === null ? -1 : b.pass_rate;
    if (pb !== pa) return pb - pa;
    const d = Number(a.price_usd) - Number(b.price_usd);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  return { results: results.slice(0, q.limit), facts_only: factsOnly, matched: cands.length };
}

// ------------------------------------------------------------------ params
export function parseQuery(url) {
  const p = url.searchParams;
  const errors = [];
  const task = p.get("task") ? slug(p.get("task")).slice(0, 64) : null;
  let max_price = null;
  if (p.get("max_price") !== null && p.get("max_price") !== "") {
    max_price = Number(p.get("max_price"));
    if (!Number.isFinite(max_price) || max_price < 0) errors.push("max_price must be a non-negative number (USD)");
  }
  const clampInt = (v, d, lo, hi) => {
    const x = parseInt(v ?? "", 10);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  const endpoint = p.get("endpoint") ? p.get("endpoint").slice(0, 300) : null;
  const clientRaw = p.get("client");
  const client = clientRaw && /^[A-Za-z0-9._\-]{1,64}$/.test(clientRaw) ? clientRaw.toLowerCase() : null;
  if (clientRaw && !client) errors.push("client must be 1-64 characters: letters, digits, dot, dash, underscore");
  const payerRaw = p.get("payer");
  const payer = payerRaw && /^0x[0-9a-fA-F]{40}$/.test(payerRaw) ? payerRaw.toLowerCase() : null;
  if (payerRaw && !payer) errors.push("payer must be a 0x address (40 hex characters)");
  // ref = where the caller found us (e.g. via-awesome-x402). Attribution only: it never changes the client id.
  const refRaw = p.get("ref");
  const ref = refRaw && /^[A-Za-z0-9._\-]{1,64}$/.test(refRaw) ? refRaw.toLowerCase() : "";
  return {
    task,
    max_price,
    ref,
    n: clampInt(p.get("n"), 5, 1, 20),
    limit: clampInt(p.get("limit"), 10, 1, 20),
    endpoint,
    client,
    payer,
    errors,
  };
}

// ------------------------------------------------------------------ client identity
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

export function ipPrefix(ip) {
  if (!ip) return "unknown";
  if (ip.includes(":")) {
    const parts = ip.split(":");
    // expand "::" enough to take the first 3 groups (/48)
    const full = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "" && i > 0 && i < parts.length - 1) {
        const missing = 8 - (parts.length - 1);
        for (let k = 0; k < missing; k++) full.push("0");
      } else full.push(parts[i] || "0");
    }
    return full.slice(0, 3).join(":") + "::/48";
  }
  const o = ip.split(".");
  return o.length === 4 ? `${o[0]}.${o[1]}.${o[2]}.0/24` : "unknown";
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The salt changes every 7 days. With WEEK_EPOCH set to the day the first listing went live (YYYY-MM-DD), salt weeks
// line up exactly with test days 1-7 and 8-14, so a client keeps one id for the whole week that is measured.
// Without it, ISO weeks are used.
export function saltPeriod(now, env) {
  const ep = Date.parse(String(env.WEEK_EPOCH || "") + "T00:00:00Z");
  if (Number.isFinite(ep)) return "w" + Math.floor((now.getTime() - ep) / (7 * 86400000));
  return isoWeek(now);
}

export async function clientId(req, q, env, now = new Date()) {
  if (q.client) return { id: "c:" + q.client, source: "client_param" };
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
  const ua = req.headers.get("user-agent") || "";
  const salt = `${env.CLIENT_SALT || "unsalted-dev"}|${saltPeriod(now, env)}`;
  const h = await sha256hex(`${salt}|${ipPrefix(ip)}|${ua}`);
  return { id: "h:" + h.slice(0, 20), source: "ip24_ua_hash" };
}

export function exclusion(req, q, env) {
  const ua = req.headers.get("user-agent") || "";
  const self = String(env.SELF_CLIENTS || "withgrokbot,withgrokbot-selftest").toLowerCase().split(",").map((x) => x.trim());
  if ((q.client && self.includes(q.client)) || SELF_UA_RE.test(ua)) return "self";
  if (UPTIME_RE.test(ua)) return "uptime";
  if (CRAWLER_RE.test(ua)) return "crawler";
  return "";
}

function uaFamily(ua) {
  const m = String(ua || "").match(/^[A-Za-z][\w.\-]*/);
  return m ? m[0].slice(0, 40) : "none";
}

// ------------------------------------------------------------------ counting
export function refererHost(req) {
  try {
    return new URL(req.headers.get("referer") || "").hostname.slice(0, 100);
  } catch (_) {
    return "";
  }
}

export function dataPoint({ cid, q, excluded, candidates, ua, returnedPayTo, status, referer = "" }) {
  const qualifying =
    !excluded && q.errors.length === 0 && ((q.task && q.max_price !== null) || !!q.endpoint) && candidates >= 1 ? 1 : 0;
  let reason = excluded;
  if (!reason && q.errors.length) reason = "bad-params";
  if (!reason && !((q.task && q.max_price !== null) || q.endpoint)) reason = "missing-task-or-price";
  if (!reason && candidates < 1) reason = "no-candidates";
  return {
    indexes: [cid.id.slice(0, 96)],
    blobs: [
      cid.id, // blob1 client id
      cid.source, // blob2
      q.task || "", // blob3
      (q.endpoint || "").slice(0, 200), // blob4
      q.max_price === null ? "" : String(q.max_price), // blob5
      reason || "", // blob6 why not qualifying ("" = qualifying)
      q.payer || "", // blob7
      returnedPayTo.join(",").slice(0, 1000), // blob8 vendor pay_to addresses returned (for the payer check)
      uaFamily(ua), // blob9
      VERSION, // blob10
      q.ref || "", // blob11 ref parameter (source attribution)
      referer || "", // blob12 Referer host (browser clicks only)
    ],
    doubles: [qualifying, candidates, status, q.n], // double1..4
  };
}

function writePoint(env, dp) {
  try {
    if (env.LOOKUPS && typeof env.LOOKUPS.writeDataPoint === "function") env.LOOKUPS.writeDataPoint(dp);
  } catch (_) {
    // counting must never break an answer
  }
}

// ------------------------------------------------------------------ OpenAPI
export function openapi(origin) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Verified catalog reliability lookup",
      version: VERSION,
      description:
        "Is an x402 endpoint reliable for task X at price <= Y? Free during the demand test. Facts from our own paid calls: receipts with settlement tx, delivered yes/no and a known-answer pass/fail. Not investment advice; we hold no funds.",
    },
    servers: [{ url: origin }],
    paths: {
      "/v1/lookup": {
        get: {
          operationId: "lookup",
          summary: "Services for a task at or under a price, sorted by known-answer pass rate over the last n paid calls, then price",
          parameters: [
            { name: "task", in: "query", schema: { type: "string" }, description: "task name, e.g. web-search (see /v1/tasks)" },
            { name: "max_price", in: "query", schema: { type: "number" }, description: "maximum listed price per call, USD" },
            { name: "n", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 5 }, description: "paid receipts per service" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 10 }, description: "services returned" },
            { name: "endpoint", in: "query", schema: { type: "string" }, description: "a service id or endpoint URL" },
            { name: "client", in: "query", schema: { type: "string" }, description: "your agent or app name (optional)" },
            { name: "ref", in: "query", schema: { type: "string" }, description: "where you found this lookup, e.g. via-readme (optional, attribution only)" },
            { name: "payer", in: "query", schema: { type: "string" }, description: "your 0x wallet, if you want to report which vendor you paid (optional)" },
          ],
          responses: { 200: { description: "results (sorted), facts_only (broken on the seller's side, not sorted)" }, 400: { description: "bad parameters" } },
        },
      },
      "/v1/tasks": { get: { operationId: "tasks", summary: "Task names", responses: { 200: { description: "task -> service ids" } } } },
    },
  };
}

// ------------------------------------------------------------------ handler
async function handleLookup(req, env, ctx, url) {
  const q = parseQuery(url);
  const cid = await clientId(req, q, env);
  const excluded = exclusion(req, q, env);
  const ua = req.headers.get("user-agent") || "";
  if (!q.task && !q.endpoint) q.errors.push("task or endpoint is required (see /v1/tasks)");
  let data;
  try {
    data = await loadData(env, ctx);
  } catch (e) {
    writePoint(env, dataPoint({ cid, q, excluded, candidates: 0, ua, returnedPayTo: [], status: 503, referer: refererHost(req) }));
    return json({ error: "catalog data unavailable, try again shortly" }, 503);
  }
  if (q.errors.length) {
    writePoint(env, dataPoint({ cid, q, excluded, candidates: 0, ua, returnedPayTo: [], status: 400, referer: refererHost(req) }));
    return json({ error: q.errors.join("; "), tasks: Object.keys(taskIndex(data.catalog)).sort(), docs: url.origin + "/openapi.json" }, 400);
  }
  const out = lookup(data, q);
  const payTo = [...new Set(out.results.concat(out.facts_only).flatMap((r) => r.pay_to))];
  writePoint(env, dataPoint({ cid, q, excluded, candidates: out.results.length + out.facts_only.length, ua, returnedPayTo: payTo, status: 200, referer: refererHost(req) }));
  return json({
    query: { task: q.task, max_price_usd: q.max_price, n: q.n, limit: q.limit, endpoint: q.endpoint },
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    data_generated_at: data.catalog.generated_at || null,
    matched: out.matched,
    results: out.results,
    facts_only: out.facts_only,
    sorting: "known-answer pass rate over the last n paid calls (services with no graded calls last), then price, then id",
    notes:
      "Facts from our own paid calls. stale = newest paid receipt older than " +
      (Number(data.receipts.stale_after_hours) || STALE_AFTER_H_DEFAULT) +
      " h (or none yet). facts_only services are broken on the seller's side right now: shown, not graded or sorted. Results can be wrong; see methodology. Free during the demand test.",
    methodology_url: data.catalog.methodology_url,
    catalog_url: data.base + "catalog.json",
    receipts_url: data.base + "receipts.json",
    contest_url: data.catalog.contest_url,
  });
}

export const handler = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400" },
      });
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405, { allow: "GET, OPTIONS" });
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/v1/lookup") return handleLookup(req, env, ctx, url);
    if (path === "/v1/tasks") {
      try {
        const data = await loadData(env, ctx);
        return json({ tasks: taskIndex(data.catalog) });
      } catch (e) {
        return json({ error: "catalog data unavailable, try again shortly" }, 503);
      }
    }
    if (path === "/openapi.json") return json(openapi(url.origin));
    if (path === "/health") return json({ ok: true, version: VERSION });
    if (path === "/")
      return json({
        name: "Verified catalog reliability lookup",
        version: VERSION,
        usage: url.origin + "/v1/lookup?task=web-search&max_price=0.01&n=5",
        tasks: url.origin + "/v1/tasks",
        openapi: url.origin + "/openapi.json",
        catalog: (env.DATA_BASE_URL || DEFAULT_DATA).replace(/\/?$/, "/") + "catalog.json",
        privacy: "Raw IPs are never stored. Lookups are counted by a weekly-salted hash of IP /24 + User-Agent, or by the client value you send.",
      });
    return json({ error: "not found", usage: url.origin + "/v1/lookup?task=web-search&max_price=0.01&n=5" }, 404);
  },
};
