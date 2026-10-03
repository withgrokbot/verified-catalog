// Reliability lookup Worker (logic; entry point is index.js) for the Verified Pay-Per-Call Catalog (demand test, see DEMAND_TEST.md in the job).
//
// Access (0.3.0): each client gets FREE_PER_DAY (5) free /v1/lookup calls per UTC day, counted in a Durable Object
// (free plan, SQLite-backed). The client is the `client` value when sent, otherwise a salted hash of the IP. After that
// the lookup answers HTTP 402 with an x402 payment requirement ($0.02 USDC on Base, exact scheme), verified and settled
// through a public x402 facilitator. Payment buys query access only: it never changes results, sort order or listings
// (the same lookup() runs for free, paid and exempt calls). SELF_CLIENTS are exempt.
//
//   GET /v1/lookup?task=web-search&max_price=0.01&n=5[&endpoint=<id|url>][&client=<name>][&ref=<source>][&payer=<0x wallet>][&limit=10]
//   GET /v1/lookup/paid  same lookup, always x402 ($0.02 USDC on Base, no free quota), with Bazaar discovery metadata
//   POST /mcp            free remote MCP server (Streamable HTTP, stateless JSON-RPC): search_catalog, get_service, lookup
//   GET /.well-known/x402  x402 discovery fan-out
//   GET /v1/tasks        task names and how many services each has
//   GET /openapi.json    OpenAPI 3.1 description
//   GET /                short help
//
// Data: catalog.json and receipts.json from the Pages site (DATA_BASE_URL), cached. The Worker holds no data of its
// own; it only answers queries and counts distinct clients (one Analytics Engine data point per lookup).
// Privacy: raw IPs are never stored. Without a `client` value the client id is a hash of the IP /24 (IPv6 /48)
// plus the User-Agent, salted with a secret that changes every ISO week.
// No runtime dependencies.

export const VERSION = "0.4.0";
export const PAYMENT_POLICY =
  "Payment buys query access only. It never changes results, sort order, listings, check results or known-answer outcomes: free, paid and exempt lookups run the same code on the same data and get identical results.";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULTS = {
  FREE_PER_DAY: 5,
  PRICE_ATOMIC: "20000", // $0.02 USDC (6 decimals)
  PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674",
  NETWORK: "eip155:8453", // Base mainnet
  FACILITATOR_URL: "https://facilitator.payai.network",
};
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
      "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
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
  if (isExempt(q, env) || SELF_UA_RE.test(ua)) return "self";
  if (UPTIME_RE.test(ua)) return "uptime";
  if (CRAWLER_RE.test(ua)) return "crawler";
  return "";
}

function uaFamily(ua) {
  const m = String(ua || "").match(/^[A-Za-z][\w.\-]*/);
  return m ? m[0].slice(0, 40) : "none";
}

// ------------------------------------------------------------------ access: free quota, exemptions, x402
export function cfg(env) {
  const free = parseInt(env.FREE_PER_DAY ?? "", 10);
  const price = /^[0-9]{1,12}$/.test(String(env.PRICE_ATOMIC || "")) ? String(env.PRICE_ATOMIC) : DEFAULTS.PRICE_ATOMIC;
  const payTo = /^0x[0-9a-fA-F]{40}$/.test(String(env.PAY_TO || "")) ? String(env.PAY_TO) : DEFAULTS.PAY_TO;
  return {
    freePerDay: Number.isFinite(free) && free >= 0 ? free : DEFAULTS.FREE_PER_DAY,
    priceAtomic: price,
    priceUsd: (Number(price) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
    payTo,
    network: DEFAULTS.NETWORK,
    facilitator: String(env.FACILITATOR_URL || DEFAULTS.FACILITATOR_URL).replace(/\/+$/, ""),
  };
}

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function selfClients(env) {
  return String(env.SELF_CLIENTS || "withgrokbot,withgrokbot-selftest").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
}

// Billing exemption is by the `client` value only (a User-Agent never exempts a caller from the quota).
export function isExempt(q, env) {
  return !!q.client && selfClients(env).includes(q.client);
}

// Full IPv4 address, or the IPv6 /64, hashed with the salt and the UTC day. Raw IPs are never stored.
export function ipQuotaPrefix(ip) {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const parts = ip.split(":");
  const full = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "" && i > 0 && i < parts.length - 1) {
      for (let k = 0; k < 8 - (parts.length - 1); k++) full.push("0");
    } else full.push(parts[i] || "0");
  }
  return full.slice(0, 4).join(":") + "::/64";
}

export async function quotaKey(req, q, env, now = new Date()) {
  if (q.client) return "c:" + q.client;
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";
  const h = await sha256hex(`${env.CLIENT_SALT || "unsalted-dev"}|quota|${utcDay(now)}|${ipQuotaPrefix(ip)}`);
  return "ip:" + h.slice(0, 24);
}

// One Durable Object per client key holds {day, used}. take: use one free call if any are left today.
// peek: read without using one. Free plan: SQLite-backed Durable Objects.
export class QuotaCounter {
  constructor(state, env) {
    this.state = state;
  }
  async fetch(req) {
    const u = new URL(req.url);
    const day = u.searchParams.get("day") || "";
    const limit = Math.max(0, parseInt(u.searchParams.get("limit") || "0", 10) || 0);
    let rec = (await this.state.storage.get("q")) || { day, used: 0 };
    if (rec.day !== day) rec = { day, used: 0 };
    if (u.pathname === "/peek") return Response.json({ free: rec.used < limit, used: rec.used, limit });
    if (rec.used < limit) {
      rec.used += 1;
      await this.state.storage.put("q", rec);
      return Response.json({ free: true, used: rec.used, limit });
    }
    return Response.json({ free: false, used: rec.used, limit });
  }
}

// Returns {free, used, limit, error?}. If the counter is unavailable the call is served free (fail open):
// counting must never break an answer.
export async function takeFree(env, key, limit, now = new Date(), op = "take") {
  if (limit <= 0) return { free: false, used: 0, limit };
  try {
    if (!env.QUOTA || typeof env.QUOTA.idFromName !== "function") return { free: true, used: null, limit, error: "no-quota-binding" };
    const stub = env.QUOTA.get(env.QUOTA.idFromName(key));
    const r = await stub.fetch(`https://quota.internal/${op}?day=${utcDay(now)}&limit=${limit}`);
    const j = await r.json();
    return { free: !!j.free, used: j.used, limit };
  } catch (e) {
    return { free: true, used: null, limit, error: "quota-error" };
  }
}

export function paymentRequirements(c, resourceUrl, version = 2, paidPath = false) {
  const extra = { name: "USD Coin", version: "2" };
  const description = paidPath
    ? `Verified catalog reliability lookup, paid per call (no free quota on this path). ${PAYMENT_POLICY}`
    : `Verified catalog reliability lookup, one call after the ${c.freePerDay} free calls per UTC day. ${PAYMENT_POLICY}`;
  if (version === 1)
    return {
      scheme: "exact",
      network: "base",
      maxAmountRequired: c.priceAtomic,
      resource: resourceUrl,
      description,
      mimeType: "application/json",
      payTo: c.payTo,
      maxTimeoutSeconds: 300,
      asset: USDC_BASE,
      extra,
    };
  return { scheme: "exact", network: c.network, amount: c.priceAtomic, asset: USDC_BASE, payTo: c.payTo, maxTimeoutSeconds: 300, extra };
}

// Bazaar discovery extension (x402 v2 specs/extensions/bazaar.md): info + a JSON Schema (draft 2020-12) for info.
export const SERVICE_NAME = "Verified Catalog Lookup";
export const SERVICE_TAGS = ["x402", "reliability", "receipts", "catalog", "agents"];
const QUERY_PROPS = {
  task: { type: "string", description: "task name, e.g. web-search (see /v1/tasks); task or endpoint is required" },
  max_price: { type: "string", description: "maximum listed price per call, USD, e.g. 0.01" },
  n: { type: "string", description: "paid receipts per service, 1-20 (default 5)" },
  limit: { type: "string", description: "services returned, 1-20 (default 10)" },
  endpoint: { type: "string", description: "a service id or endpoint URL instead of a task" },
  client: { type: "string", description: "your agent or app name (optional)" },
  ref: { type: "string", description: "where you found this lookup (optional, attribution only)" },
  payer: { type: "string", description: "your 0x wallet (optional)" },
};
export function bazaarExtension() {
  return {
    info: {
      input: { type: "http", method: "GET", queryParams: { task: "web-search", max_price: "0.01", n: "5" } },
      output: {
        type: "json",
        example: {
          query: { task: "web-search", max_price_usd: 0.01, n: 5, limit: 10, endpoint: null },
          matched: 1,
          results: [{ id: "example-search", endpoint: "https://example.com/search", price_usd: "0.01", pass_rate: 1, stale: false, receipts: [{ time: "2026-10-02T18:48:42Z", tx: "0x...", charged_usd: "0.01", delivered: true, quality: "pass" }] }],
          facts_only: [],
          access: { tier: "paid", charged_usd: "0.02", tx: "0x..." },
          payment_policy: PAYMENT_POLICY,
        },
      },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["GET"] },
            queryParams: { type: "object", properties: QUERY_PROPS },
            headers: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["type", "method"],
          additionalProperties: false,
        },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}

// The always-paid path: 402 for every unpaid call, with Bazaar discovery metadata so facilitators and x402scan can list it.
export function paidPaymentRequired(c, resourceUrl, error) {
  return {
    x402Version: 2,
    error,
    resource: {
      url: resourceUrl,
      description: `Verified catalog reliability lookup: x402 endpoints for a task at or under a price, with our own paid receipts and known-answer pass/fail. $${c.priceUsd} USDC on Base per call.`,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: SERVICE_TAGS,
    },
    accepts: [paymentRequirements(c, resourceUrl, 2, true)],
    extensions: { bazaar: bazaarExtension() },
    price_usd: c.priceUsd,
    asset: "USDC on Base (eip155:8453)",
    payment_policy: PAYMENT_POLICY,
    free_alternative: "The same lookup is free for 5 calls per client per UTC day at /v1/lookup and via the free MCP server at /mcp. Payment never changes results.",
    how_to_pay:
      "Retry the same request with a PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT is also accepted) holding a signed USDC EIP-3009 authorization for the amount and payTo above. Bad parameters get a 400 before anything is settled.",
  };
}

export function paymentRequired(c, url, error, used) {
  const resource = url.toString();
  return {
    x402Version: 2,
    error,
    resource: {
      url: resource,
      description: `Verified catalog reliability lookup ($${c.priceUsd} USDC on Base per call after ${c.freePerDay} free calls per UTC day)`,
      mimeType: "application/json",
    },
    accepts: [paymentRequirements(c, resource, 2)],
    extensions: {},
    // human-readable notes (ignored by x402 clients)
    price_usd: c.priceUsd,
    asset: "USDC on Base (eip155:8453)",
    free_per_day: c.freePerDay,
    free_used_today: used,
    free_resets: "00:00 UTC",
    payment_policy: PAYMENT_POLICY,
    how_to_pay:
      "Retry the same request with a PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT is also accepted) holding a signed USDC EIP-3009 authorization for the amount and payTo above. Settled through a public x402 facilitator; the settlement tx comes back in the PAYMENT-RESPONSE header and the body's access block.",
  };
}

const b64encode = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export function decodePaymentHeader(value) {
  try {
    const bin = atob(String(value).trim());
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj && typeof obj === "object" && obj.payload ? obj : null;
  } catch (_) {
    return null;
  }
}

function paymentHeader(req) {
  return req.headers.get("payment-signature") || req.headers.get("x-payment") || "";
}

// The payload must be for exactly our price, asset, network and payTo. The facilitator then checks the signature,
// balance, validity window and nonce against the requirements we send (never the client's own copy).
export function checkPayload(payload, c) {
  const v = Number(payload.x402Version || 1);
  if (v === 2) {
    const a = payload.accepted || {};
    if (a.scheme !== "exact" || a.network !== c.network) return "unsupported scheme or network (exact on eip155:8453 only)";
    if (String(a.amount) !== c.priceAtomic) return "amount does not match the price";
    if (String(a.payTo || "").toLowerCase() !== c.payTo.toLowerCase()) return "payTo does not match";
    if (String(a.asset || "").toLowerCase() !== USDC_BASE.toLowerCase()) return "asset is not USDC on Base";
  } else if (v === 1) {
    if (payload.scheme !== "exact" || payload.network !== "base") return "unsupported scheme or network (exact on base only)";
  } else return "unsupported x402Version";
  const auth = (payload.payload && payload.payload.authorization) || {};
  if (auth.to && String(auth.to).toLowerCase() !== c.payTo.toLowerCase()) return "authorization is not to payTo";
  if (auth.value !== undefined && String(auth.value) !== c.priceAtomic) return "authorization value does not match the price";
  return "";
}

async function facilitatorCall(c, path, body) {
  const r = await fetch(c.facilitator + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  let j = null;
  try {
    j = await r.json();
  } catch (_) {
    j = null;
  }
  return { status: r.status, body: j || {} };
}

// verify, then settle. Returns {ok, settle?, reason}.
export async function verifyAndSettle(c, payload, url, paidPath = false) {
  const v = Number(payload.x402Version || 1);
  const body = { x402Version: v, paymentPayload: payload, paymentRequirements: paymentRequirements(c, url.toString(), v, paidPath) };
  let vr;
  try {
    vr = await facilitatorCall(c, "/verify", body);
  } catch (e) {
    return { ok: false, reason: "facilitator unreachable (verify)" };
  }
  if (!vr.body.isValid) return { ok: false, reason: "payment not valid: " + (vr.body.invalidReason || "HTTP " + vr.status) };
  let sr;
  try {
    sr = await facilitatorCall(c, "/settle", body);
    for (let i = 0; i < 3 && sr.body.errorReason === "settlement_pending"; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      sr = await facilitatorCall(c, "/settle", body);
    }
  } catch (e) {
    return { ok: false, reason: "facilitator unreachable (settle)" };
  }
  if (!sr.body.success || !sr.body.transaction)
    return { ok: false, reason: "settlement failed: " + (sr.body.errorReason || "HTTP " + sr.status), settle: sr.body };
  return { ok: true, settle: { success: true, transaction: sr.body.transaction, network: sr.body.network || c.network, payer: sr.body.payer || vr.body.payer || "" } };
}

// ------------------------------------------------------------------ counting
export function refererHost(req) {
  try {
    return new URL(req.headers.get("referer") || "").hostname.slice(0, 100);
  } catch (_) {
    return "";
  }
}

// access: free | paid | exempt | payment-required | payment-failed | "" (request rejected before the quota)
export function dataPoint({ cid, q, excluded, candidates, ua, returnedPayTo, status, referer = "", access = "", amountUsd = 0, tx = "", paidBy = "", freeUsed = null }) {
  const paywalled = access === "payment-required" || access === "payment-failed";
  const qualifying =
    !excluded && !paywalled && q.errors.length === 0 && ((q.task && q.max_price !== null) || !!q.endpoint) && candidates >= 1 ? 1 : 0;
  let reason = excluded;
  if (!reason && q.errors.length) reason = "bad-params";
  if (!reason && paywalled) reason = access;
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
      access || "", // blob13 access: free | paid | exempt | payment-required | payment-failed
      String(tx || "").slice(0, 80), // blob14 settlement tx (paid only)
      String(paidBy || "").toLowerCase().slice(0, 64), // blob15 paying wallet (paid only, from the facilitator)
    ],
    // double1 qualifying, double2 candidates, double3 HTTP status, double4 n, double5 USD charged, double6 free calls used today
    doubles: [qualifying, candidates, status, q.n, Number(amountUsd) || 0, freeUsed === null ? -1 : Number(freeUsed)],
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
export function pricingDoc(c) {
  return {
    free_per_day: c.freePerDay,
    free_scope: "per client per UTC day; client = the client value when sent, otherwise a salted hash of your IP",
    then: `HTTP 402 x402 payment requirement: $${c.priceUsd} USDC on Base (eip155:8453), scheme exact, payTo ${c.payTo}`,
    facilitator: c.facilitator,
    metered: "/v1/lookup after the free quota; /v1/lookup/paid always (same results). /mcp, /v1/tasks, /openapi.json, /health are free (the MCP lookup tool shares the vc-mcp free quota)",
  };
}

export function openapi(origin, env = {}) {
  const c = cfg(env);
  return {
    openapi: "3.1.0",
    info: {
      title: "Verified catalog reliability lookup",
      version: VERSION,
      contact: { url: "https://github.com/withgrokbot/verified-catalog/issues" },
      "x-guidance": `Ask GET /v1/lookup?task=<task>&max_price=<usd> (task names: /v1/tasks). ${c.freePerDay} free calls per client per UTC day, then the same path answers 402; /v1/lookup/paid is the always-paid twin ($${c.priceUsd} USDC on Base via x402) with identical results. Free MCP: POST /mcp.`,
      description:
        `Is an x402 endpoint reliable for task X at price <= Y? Facts from our own paid calls: receipts with settlement tx, delivered yes/no and a known-answer pass/fail. Pricing: ${c.freePerDay} free lookups per client per UTC day, then HTTP 402 with an x402 payment requirement of $${c.priceUsd} USDC on Base per lookup. ${PAYMENT_POLICY} Not investment advice; we hold no customer funds.`,
    },
    servers: [{ url: origin }],
    paths: {
      "/v1/lookup": {
        get: {
          operationId: "lookup",
          security: [],
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
          responses: {
            200: { description: "results (sorted), facts_only (broken on the seller's side, not sorted), access (free, paid or exempt). Identical results whether the call was free or paid. Paid calls carry a PAYMENT-RESPONSE header with the settlement tx." },
            400: { description: "bad parameters (never metered)" },
            402: {
              description: `free lookups used up for today: x402 v2 payment requirement in the PAYMENT-REQUIRED header (base64 JSON) and the body. Pay by retrying with a PAYMENT-SIGNATURE (x402 v2) or X-PAYMENT header. $${c.priceUsd} USDC on Base, payTo ${c.payTo}. ${PAYMENT_POLICY}`,
            },
          },
        },
      },
      "/v1/lookup/paid": {
        get: {
          operationId: "lookupPaid",
          summary: `Same lookup as /v1/lookup, always paid: $${c.priceUsd} USDC on Base per call via x402 (no free quota). Identical results.`,
          parameters: Object.entries(QUERY_PROPS).map(([name, sch]) => ({ name, in: "query", schema: { type: "string" }, description: sch.description })),
          "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: c.priceUsd }, protocols: [{ x402: { scheme: "exact", network: c.network, asset: USDC_BASE, payTo: c.payTo } }] },
          responses: {
            200: { description: "same body as /v1/lookup, access.tier = paid, PAYMENT-RESPONSE header with the settlement tx" },
            400: { description: "bad parameters (checked after the 402, before anything is settled)" },
            402: { description: `x402 v2 payment requirement ($${c.priceUsd} USDC on Base) with Bazaar discovery metadata. ${PAYMENT_POLICY}` },
          },
        },
      },
      "/mcp": {
        post: {
          operationId: "mcp",
          security: [],
          summary: "Free remote MCP server (Streamable HTTP, stateless JSON-RPC 2.0): tools search_catalog, get_service, lookup (lookup shares the vc-mcp free quota)",
          responses: { 200: { description: "JSON-RPC response" }, 202: { description: "notification accepted" } },
        },
      },
      "/v1/tasks": { get: { operationId: "tasks", security: [], summary: "Task names", responses: { 200: { description: "task -> service ids" } } } },
    },
  };
}

// ------------------------------------------------------------------ handler
// The lookup response body. Same for free, paid, exempt and MCP calls: only `access` differs.
function lookupBody(q, data, out, access) {
  return {
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
        " h (or none yet). facts_only services are broken on the seller's side right now: shown, not graded or sorted. Results can be wrong; see methodology.",
      access,
      payment_policy: PAYMENT_POLICY,
      methodology_url: data.catalog.methodology_url,
      catalog_url: data.base + "catalog.json",
      receipts_url: data.base + "receipts.json",
      contest_url: data.catalog.contest_url,
    };
}

async function handleLookup(req, env, ctx, url) {
  const q = parseQuery(url);
  const cid = await clientId(req, q, env);
  const excluded = exclusion(req, q, env);
  const ua = req.headers.get("user-agent") || "";
  const referer = refererHost(req);
  const c = cfg(env);
  if (!q.task && !q.endpoint) q.errors.push("task or endpoint is required (see /v1/tasks)");
  let data;
  try {
    data = await loadData(env, ctx);
  } catch (e) {
    writePoint(env, dataPoint({ cid, q, excluded, candidates: 0, ua, returnedPayTo: [], status: 503, referer }));
    return json({ error: "catalog data unavailable, try again shortly" }, 503);
  }
  if (q.errors.length) {
    writePoint(env, dataPoint({ cid, q, excluded, candidates: 0, ua, returnedPayTo: [], status: 400, referer }));
    return json({ error: q.errors.join("; "), tasks: Object.keys(taskIndex(data.catalog)).sort(), docs: url.origin + "/openapi.json" }, 400);
  }
  // The answer is computed before (and independently of) the access decision: payment never changes it.
  const out = lookup(data, q);
  const candidates = out.results.length + out.facts_only.length;
  const payTo = [...new Set(out.results.concat(out.facts_only).flatMap((r) => r.pay_to))];
  const point = (extra) => writePoint(env, dataPoint({ cid, q, excluded, candidates, ua, returnedPayTo: payTo, referer, ...extra }));

  let access;
  const extraHeaders = {};
  if (isExempt(q, env)) {
    access = { tier: "exempt", note: "our own self-test client: not metered" };
    point({ status: 200, access: "exempt" });
  } else {
    const key = await quotaKey(req, q, env);
    const t = await takeFree(env, key, c.freePerDay);
    if (t.free) {
      access = {
        tier: "free",
        free_per_day: c.freePerDay,
        free_used_today: t.used,
        free_remaining_today: t.used === null ? null : Math.max(0, c.freePerDay - t.used),
        then: `$${c.priceUsd} USDC on Base per lookup via x402 (HTTP 402)`,
      };
      point({ status: 200, access: "free", freeUsed: t.used });
    } else {
      const hdr = req.headers.get("payment-signature") || req.headers.get("x-payment") || "";
      const deny = (error, kind) => {
        const body = paymentRequired(c, url, error, t.used);
        point({ status: 402, access: kind, freeUsed: t.used });
        return json(body, 402, { "payment-required": b64encode(body) });
      };
      if (!hdr) return deny(`Free lookups used up for today (${c.freePerDay} per UTC day). Pay $${c.priceUsd} USDC on Base via x402 to continue.`, "payment-required");
      const payload = decodePaymentHeader(hdr);
      if (!payload) return deny("payment header is not valid base64 JSON x402 payload", "payment-failed");
      const bad = checkPayload(payload, c);
      if (bad) return deny("payment rejected: " + bad, "payment-failed");
      const r = await verifyAndSettle(c, payload, url);
      if (!r.ok) return deny("payment rejected: " + r.reason, "payment-failed");
      const enc = b64encode(r.settle);
      extraHeaders["payment-response"] = enc;
      extraHeaders["x-payment-response"] = enc;
      access = {
        tier: "paid",
        charged_usd: c.priceUsd,
        asset: "USDC on Base",
        tx: r.settle.transaction,
        basescan_url: "https://basescan.org/tx/" + r.settle.transaction,
        payer: r.settle.payer || null,
      };
      point({ status: 200, access: "paid", amountUsd: Number(c.priceUsd), tx: r.settle.transaction, paidBy: r.settle.payer, freeUsed: t.used });
    }
  }
  return json(lookupBody(q, data, out, access), 200, extraHeaders);
}

// Always-paid path: every unpaid call gets a 402 (before any parameter check, so discovery probes see the challenge).
// With a payment header: parameters are checked first (400, nothing settled), then verify + settle, then the same lookup().
async function handlePaidLookup(req, env, ctx, url) {
  const q = parseQuery(url);
  const cid = await clientId(req, q, env);
  const excluded = exclusion(req, q, env);
  const ua = req.headers.get("user-agent") || "";
  const referer = refererHost(req);
  const c = cfg(env);
  const resourceUrl = url.origin + url.pathname;
  let candidates = 0;
  let payTo = [];
  const point = (extra) => writePoint(env, dataPoint({ cid, q, excluded, candidates, ua, returnedPayTo: payTo, referer, ...extra }));
  const deny = (error, kind) => {
    const body = paidPaymentRequired(c, resourceUrl, error);
    point({ status: 402, access: kind });
    return json(body, 402, { "payment-required": b64encode(body) });
  };
  const hdr = paymentHeader(req);
  if (!hdr) return deny(`Payment required: $${c.priceUsd} USDC on Base per lookup via x402.`, "payment-required");
  if (!q.task && !q.endpoint) q.errors.push("task or endpoint is required (see /v1/tasks)");
  let data;
  try {
    data = await loadData(env, ctx);
  } catch (e) {
    point({ status: 503 });
    return json({ error: "catalog data unavailable, try again shortly (nothing was charged)" }, 503);
  }
  if (q.errors.length) {
    point({ status: 400 });
    return json({ error: q.errors.join("; ") + " (nothing was charged)", tasks: Object.keys(taskIndex(data.catalog)).sort(), docs: url.origin + "/openapi.json" }, 400);
  }
  const out = lookup(data, q);
  candidates = out.results.length + out.facts_only.length;
  payTo = [...new Set(out.results.concat(out.facts_only).flatMap((r) => r.pay_to))];
  const payload = decodePaymentHeader(hdr);
  if (!payload) return deny("payment header is not valid base64 JSON x402 payload", "payment-failed");
  const bad = checkPayload(payload, c);
  if (bad) return deny("payment rejected: " + bad, "payment-failed");
  const r = await verifyAndSettle(c, payload, resourceUrl, true);
  if (!r.ok) return deny("payment rejected: " + r.reason, "payment-failed");
  const enc = b64encode(r.settle);
  const access = { tier: "paid", charged_usd: c.priceUsd, asset: "USDC on Base", tx: r.settle.transaction, basescan_url: "https://basescan.org/tx/" + r.settle.transaction, payer: r.settle.payer || null };
  point({ status: 200, access: "paid", amountUsd: Number(c.priceUsd), tx: r.settle.transaction, paidBy: r.settle.payer });
  return json(lookupBody(q, data, out, access), 200, { "payment-response": enc, "x-payment-response": enc });
}

// ------------------------------------------------------------------ remote MCP (Streamable HTTP, stateless JSON-RPC)
// Same 3 tools, same results as mcp/server.py: search_catalog and get_service read the published catalog.json (the
// file mcp/server.py ships with); lookup runs the same /v1/lookup code with client=vc-mcp, so it shares that client's
// free quota (5 per UTC day) and reports, but never pays, the 402 after it.
export const MCP_CLIENT = "vc-mcp";
export const MCP_PROTOCOL = "2025-06-18";
export const MCP_SERVER_INFO = { name: "verified-catalog", version: "0.2.0" };
export const MCP_TOOLS = [
  {
    name: "search_catalog",
    description: "Search pay-per-call (x402) agent services in the verified catalog. Returns factual latest-check results (reachable, latency, advertised vs quoted price). No grades.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "words to match in name, category, description" },
        category: { type: "string" },
        max_price_usd: { type: "number", description: "maximum advertised price per call in USD" },
        reachable_only: { type: "boolean", description: "only services reachable in the latest check" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "get_service",
    description: "Get the full catalog record for one service id, including its latest check and raw log link.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "lookup",
    description:
      "Is an x402 endpoint reliable for a task at a price? Asks the catalog's lookup service for services matching a task " +
      "at or under max_price_usd, sorted by known-answer pass rate over the last n paid calls, then price. Each result has " +
      "its paid receipts (time, tx, Basescan link, charged, delivered, pass/fail), last check time and a stale flag. " +
      "Services broken on the seller's side come back under facts_only, not sorted. Sends client=vc-mcp: 5 free lookups per UTC day " +
      "for that client name, then the service answers HTTP 402 (x402, $0.02 USDC on Base), which this tool reports but does not pay. " +
      "Payment never changes results, sort order or listings.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "task name, e.g. web-search, crypto-news, weather, token-balance" },
        max_price_usd: { type: "number", description: "maximum listed price per call in USD" },
        n: { type: "integer", minimum: 1, maximum: 20, description: "paid receipts per service (default 5)" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "services returned (default 10)" },
        endpoint: { type: "string", description: "a service id or endpoint URL instead of a task" },
        payer: { type: "string", description: "optional: your 0x wallet, so a later payment to a returned vendor can be confirmed on-chain" },
      },
    },
  },
];

class ToolInputError extends Error {}
const pyStr = (v) => (v === null ? "None" : v === true ? "True" : v === false ? "False" : String(v));
const blank = (v) => v === undefined || v === null || v === "";
function pyInt(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new ToolInputError(`invalid literal for int() with base 10: ${JSON.stringify(pyStr(v))}`);
}
function decStr(v) {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(x)) return null;
  if (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(v)) return v.trim();
  const t = String(x);
  return /e/i.test(t) ? x.toFixed(20).replace(/0+$/, "").replace(/\.$/, "") : t;
}

// mcp/server.py brief() and search(), field for field.
export function mcpBrief(s) {
  const latest = s.latest || {};
  const keys = ["checked_at", "reachable", "http_status", "latency_ms", "quoted_price_usd", "price_matches_listing", "charged_price_usd", "delivered_valid", "raw_log_url"];
  return {
    id: s.id,
    name: s.name,
    category: s.category ?? null,
    endpoint: s.endpoint ?? null,
    advertised_price_usd: (s.advertised_price || {}).amount_usd ?? null,
    latest: Object.fromEntries(keys.map((k) => [k, latest[k] ?? null])),
    page_url: s.page_url ?? null,
  };
}

export function mcpSearch(cat, args) {
  const q = String(args.query || "").toLowerCase().trim();
  const category = String(args.category || "").toLowerCase().trim();
  const limit = pyInt(args.limit || 20);
  let maxp = null;
  if (!blank(args.max_price_usd)) {
    if (decStr(args.max_price_usd) === null) throw new ToolInputError("max_price_usd must be a number");
    maxp = Number(args.max_price_usd);
  }
  const field = (s, k) => (s[k] === undefined ? "" : pyStr(s[k]));
  const out = [];
  for (const s of cat.services || []) {
    const hay = ["id", "name", "category", "description", "provider"].map((k) => field(s, k)).join(" ").toLowerCase();
    if (q && !q.split(/\s+/).every((w) => hay.includes(w))) continue;
    if (category && !field(s, "category").toLowerCase().includes(category)) continue;
    if (maxp !== null && Number(s.advertised_price.amount_usd) > maxp) continue;
    if (args.reachable_only && !(s.latest || {}).reachable) continue;
    out.push(mcpBrief(s));
  }
  const res = out.slice(0, limit);
  return { count: res.length, results: res, generated_at: cat.generated_at ?? null, note: "Factual check results only; no grades. See methodology_url.", methodology_url: cat.methodology_url ?? null };
}

// lookup tool: one in-process /v1/lookup call with client=vc-mcp (same code path, counting and quota as the stdio server's GET).
async function mcpLookup(req, env, ctx, origin, args) {
  const qp = new URLSearchParams({ client: MCP_CLIENT });
  if (args.task) qp.set("task", pyStr(args.task));
  if (!blank(args.max_price_usd)) {
    const d = decStr(args.max_price_usd);
    if (d === null) return [null, "max_price_usd must be a number"];
    qp.set("max_price", d);
  }
  for (const k of ["n", "limit"]) if (!blank(args[k])) qp.set(k, String(pyInt(args[k])));
  for (const k of ["endpoint", "payer"]) if (args[k]) qp.set(k, pyStr(args[k]));
  if (!qp.has("task") && !qp.has("endpoint")) return [null, "give a task (e.g. web-search) or an endpoint (service id or URL)"];
  const u = new URL(origin + "/v1/lookup?" + qp.toString());
  const headers = { accept: "application/json", "user-agent": "verified-catalog-mcp/0.2" };
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) headers["cf-connecting-ip"] = ip;
  const r = await handleLookup(new Request(u, { headers }), env, ctx, u);
  let body = null;
  try {
    body = await r.json();
  } catch (_) {
    body = null;
  }
  if (r.status === 200) return [body, null];
  const detail = body && body.error;
  if (r.status === 402)
    return [null, "lookup returned HTTP 402: " + (detail || "free lookups used up for today") + " Call the lookup URL directly with an x402 client to pay $0.02 USDC on Base; payment never changes results."];
  return [null, `lookup returned HTTP ${r.status}` + (detail ? `: ${detail}` : "")];
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function mcpDispatch(msg, req, env, ctx, origin) {
  const method = msg.method;
  const params = msg.params || {};
  if (method === "initialize")
    return { protocolVersion: params.protocolVersion || MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: MCP_TOOLS };
  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    const err = (text) => ({ content: [{ type: "text", text }], isError: true });
    if (!["search_catalog", "get_service", "lookup"].includes(name)) throw new RpcError(-32601, `unknown tool ${name === undefined ? "None" : `'${name}'`}`);
    let data;
    try {
      if (name === "lookup") {
        const [d, e] = await mcpLookup(req, env, ctx, origin, args);
        if (e) return err(e);
        data = d;
      } else {
        let loaded;
        try {
          loaded = await loadData(env, ctx);
        } catch (e) {
          return err("catalog data unavailable, try again shortly");
        }
        const q = parseQuery(new URL(origin + "/"));
        writePoint(env, dataPoint({ cid: await clientId(req, q, env), q, excluded: exclusion(req, q, env), candidates: 0, ua: req.headers.get("user-agent") || "", returnedPayTo: [], status: 200, referer: refererHost(req), access: "mcp-" + name }));
        if (name === "search_catalog") data = mcpSearch(loaded.catalog, args);
        else {
          const m = loaded.catalog.services.filter((s) => s.id === args.id);
          if (!m.length) return err(`no service with id ${args.id === undefined || args.id === null ? "None" : `'${args.id}'`}`);
          data = m[0];
        }
      }
    } catch (e) {
      if (e instanceof ToolInputError) return err(e.message);
      throw e;
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
  }
  throw new RpcError(-32601, `method not found: ${method}`);
}

async function handleMcp(req, env, ctx, url) {
  if (req.method === "GET" || req.method === "HEAD")
    return json({ error: "this MCP endpoint is stateless: POST JSON-RPC 2.0 messages (Streamable HTTP, no SSE stream)" }, 405, { allow: "POST, OPTIONS" });
  if (req.method === "DELETE") return json({ error: "stateless server: no session to delete" }, 405, { allow: "POST, OPTIONS" });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, { allow: "POST, OPTIONS" });
  let msg;
  try {
    msg = JSON.parse(await req.text());
  } catch (_) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  const one = async (m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
    if (!("id" in m)) return null; // notification or response: accepted, no reply
    if (typeof m.method !== "string") return null;
    try {
      return { jsonrpc: "2.0", id: m.id, result: await mcpDispatch(m, req, env, ctx, url.origin) };
    } catch (e) {
      if (e instanceof RpcError) return { jsonrpc: "2.0", id: m.id, error: { code: e.code, message: e.message } };
      return { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "internal error" } };
    }
  };
  if (Array.isArray(msg)) {
    const outs = (await Promise.all(msg.map(one))).filter(Boolean);
    return outs.length ? json(outs) : new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });
  }
  const out = await one(msg);
  return out ? json(out) : new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });
}

export const handler = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
          "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
          "access-control-max-age": "86400",
        },
      });
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/mcp") return handleMcp(req, env, ctx, url);
    // POST is accepted on the paid path so method-probing discovery tools get the same 402.
    if (path === "/v1/lookup/paid" && ["GET", "HEAD", "POST"].includes(req.method)) return handlePaidLookup(req, env, ctx, url);
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405, { allow: "GET, OPTIONS" });
    if (path === "/v1/lookup") return handleLookup(req, env, ctx, url);
    if (path === "/.well-known/x402") return json({ version: 1, resources: [url.origin + "/v1/lookup/paid"] });
    if (path === "/v1/tasks") {
      try {
        const data = await loadData(env, ctx);
        return json({ tasks: taskIndex(data.catalog) });
      } catch (e) {
        return json({ error: "catalog data unavailable, try again shortly" }, 503);
      }
    }
    if (path === "/openapi.json") return json(openapi(url.origin, env));
    if (path === "/health") return json({ ok: true, version: VERSION });
    if (path === "/")
      return json({
        name: "Verified catalog reliability lookup",
        version: VERSION,
        usage: url.origin + "/v1/lookup?task=web-search&max_price=0.01&n=5",
        paid: url.origin + "/v1/lookup/paid?task=web-search&max_price=0.01&n=5",
        mcp: url.origin + "/mcp",
        tasks: url.origin + "/v1/tasks",
        openapi: url.origin + "/openapi.json",
        catalog: (env.DATA_BASE_URL || DEFAULT_DATA).replace(/\/?$/, "/") + "catalog.json",
        pricing: pricingDoc(cfg(env)),
        payment_policy: PAYMENT_POLICY,
        privacy: "Raw IPs are never stored. Lookups are counted by a weekly-salted hash of IP /24 + User-Agent, or by the client value you send. The free quota is counted by the client value, or by a daily-salted hash of the IP.",
      });
    return json({ error: "not found", usage: url.origin + "/v1/lookup?task=web-search&max_price=0.01&n=5" }, 404);
  },
};
