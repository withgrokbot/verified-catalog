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
import {
  PACK_ID, PACK_TITLE, PACK_SERVICE_NAME, PACK_TAGS, PACK_DESCRIPTION,
  PACK_PRICE_USD, PACK_DEFAULT_PRICE_ATOMIC, PACK_GUIDE_FILENAME, PACK_GUIDE_KV_KEY,
  PACK_PROMPTS, PACK_TEMPLATES,
} from "./pack/overnight-cos-data.js";
import {
  SPOT_ID, SPOT_SERVICE_NAME, SPOT_TAGS, BRAND, BRAND_HOSTS, LEGACY_ORIGIN, CANON_ORIGIN, API_ORIGIN, OLD_HOSTNAMES, SPOT_DEFAULT_PRICE_ATOMIC, SPOT_DEFAULT_FREE_PER_DAY,
  SPOT_PAID_PER_HOUR, SPOT_QUOTA_COUNTER, SPOT_RATE_COUNTER,
  spotProbe, priceMatchesClaimed, decideVerdict, utcHour, assertSafeUrl,
  FREE_CHECK_URL,
  FREE_CHECK_EXAMPLE_URL,
  FREE_CHECK_EXAMPLE,
  PRIOR_CHECKS,
} from "./spotcheck.js";

import { handleSkips, handleReceipts, crawlReceiptForUrl, normUrl } from "./skips.js";
import { RECEIPTS } from "./receipts-data.js";
import { landingHtml } from "./landing.js";
export { FREE_CHECK_URL, FREE_CHECK_EXAMPLE_URL, FREE_CHECK_EXAMPLE, PRIOR_CHECKS };
import { BRAND_ASSETS } from "./brand.js";
export { landingHtml };
export const VERSION = "0.20.0";
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

// 0.11.0 bot tags (analytics only; never changes an answer). See ANALYTICS_2026-10-09.md: ~95% of outside traffic
// is one scanner sweep (4 endpoints, same second, no params / example.com) plus named x402 indexers.
export const INDEXER_RE = /(bazaar|indexer|index-bot|probe|verifier|scout|x402watch|collector|doctor|x402lens|lens\b|conformance|discovery|registry|trustindex|agenstry|brickblue|pennywise|allow402|easy402|x402scan|settled|observer|touchstone|catalog-bot|directory)/i;
const EXAMPLE_HOST_RE = /^(?:[^/]*\.)?(?:example\.(?:com|org|net)|[^/]+\.example|[^/]+\.test|[^/]+\.invalid|localhost)$/i;
export function isExampleTarget(u) {
  try {
    return EXAMPLE_HOST_RE.test(new URL(String(u || "")).hostname);
  } catch (_) {
    return false;
  }
}
export function botReason(req, q, url) {
  const ua = req.headers.get("user-agent") || "";
  if (INDEXER_RE.test(ua)) return "indexer";
  if (q.ref || q.client) return ""; // an attributed or named caller is never auto-tagged as a bot
  const paying = req.headers.get("payment-signature") || req.headers.get("x-payment");
  const target = q.url || q.endpoint;
  if (url && !url.search && !q.task && !target && !paying) return "scanner"; // bare call, no params at all
  if (target && isExampleTarget(target)) return "example-param";
  if (!target && q.task === "web-search" && Number(q.max_price) === 0.01) return "example-param"; // the documented example verbatim
  return "";
}
export function exclusion(req, q, env, url = null) {
  const ua = req.headers.get("user-agent") || "";
  if (isExempt(q, env) || SELF_UA_RE.test(ua)) return "self";
  if (UPTIME_RE.test(ua)) return "uptime";
  if (CRAWLER_RE.test(ua)) return "crawler";
  return botReason(req, q, url);
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

// Pack product config: same payTo/network/facilitator as lookups, dedicated PACK_PRICE_ATOMIC ($9).
export function packCfg(env) {
  const c = cfg(env);
  const price = /^[0-9]{1,12}$/.test(String(env.PACK_PRICE_ATOMIC || ""))
    ? String(env.PACK_PRICE_ATOMIC)
    : PACK_DEFAULT_PRICE_ATOMIC;
  return {
    ...c,
    priceAtomic: price,
    priceUsd: (Number(price) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
  };
}

// Spot-check product: $0.25 USDC, 1 free check per client per UTC day (separate DO counter).
export function spotCfg(env) {
  const c = cfg(env);
  const price = /^[0-9]{1,12}$/.test(String(env.SPOT_PRICE_ATOMIC || ""))
    ? String(env.SPOT_PRICE_ATOMIC)
    : SPOT_DEFAULT_PRICE_ATOMIC;
  const free = parseInt(env.SPOT_FREE_PER_DAY ?? "", 10);
  const paidCap = parseInt(env.SPOT_PAID_PER_HOUR ?? "", 10);
  return {
    ...c,
    priceAtomic: price,
    priceUsd: (Number(price) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
    freePerDay: Number.isFinite(free) && free >= 0 ? free : SPOT_DEFAULT_FREE_PER_DAY,
    paidPerHour: Number.isFinite(paidCap) && paidCap > 0 ? paidCap : SPOT_PAID_PER_HOUR,
    dryPerDay: posInt(env.SPOT_DRY_PER_DAY, SPOT_DRY_PER_DAY),
    dryPerIpDay: posInt(env.SPOT_DRY_PER_IP_DAY, SPOT_DRY_PER_IP_DAY),
  };
}
// 0.13.0 dry runs: free, never signed or paid, always stored. Capped per caller (ref, else client, else IP hash) and per IP hash.
export const SPOT_DRY_PER_DAY = 50;
export const SPOT_DRY_PER_IP_DAY = 200;
export const SPOT_DRY_COUNTER = "spot-dry";
const posInt = (v, d) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : d; };


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
    const counter = u.searchParams.get("counter") || "q";
    let rec = (await this.state.storage.get(counter)) || { day, used: 0 };
    if (rec.day !== day) rec = { day, used: 0 };
    if (u.pathname === "/peek") return Response.json({ free: rec.used < limit, used: rec.used, limit });
    if (u.pathname === "/credit" || u.pathname === "/spend" || u.pathname === "/balance") {
      // Prepaid router credits: a balance that never resets (day is ignored).
      const b = (await this.state.storage.get(counter + ":bal")) || { bal: 0 };
      if (u.pathname === "/credit") b.bal += Math.max(0, parseInt(u.searchParams.get("n") || "0", 10) || 0);
      else if (u.pathname === "/spend") { if (b.bal <= 0) return Response.json({ ok: false, balance: b.bal }); b.bal -= 1; }
      if (u.pathname !== "/balance") await this.state.storage.put(counter + ":bal", b);
      return Response.json({ ok: true, balance: b.bal });
    }
    if (rec.used < limit) {
      rec.used += 1;
      await this.state.storage.put(counter, rec);
      return Response.json({ free: true, used: rec.used, limit });
    }
    return Response.json({ free: false, used: rec.used, limit });
  }
}

// Router credits (fail closed: if the counter is down, the router just pays per pack as usual).
export const SPOT_ROUTER_COUNTER = "spot-router";
export async function routerCredits(env, cid, op, n = 0) {
  try {
    if (!env.QUOTA || typeof env.QUOTA.idFromName !== "function") return { ok: false, balance: null };
    const stub = env.QUOTA.get(env.QUOTA.idFromName("router:" + cid));
    const r = await stub.fetch(`https://quota.internal/${op}?counter=${SPOT_ROUTER_COUNTER}&n=${n}`);
    return await r.json();
  } catch (_) {
    return { ok: false, balance: null };
  }
}
// Router tier (0.10.0): allowlisted router client ids pay $0.001/check, billed in packs (default 10 checks = $0.01,
// one settlement). PayAI charges the payee ~2.2 credits ($0.0022) per Base settlement after its free allowance,
// so a single $0.001 settlement would lose money; one settlement per pack keeps the per-check price at $0.001.
// Config: SPOT_ROUTER_CLIENTS = "id,id2" (Worker secret), SPOT_ROUTER_PACK_CHECKS (default 10), SPOT_ROUTER_CHECK_ATOMIC (default 1000).
export function spotRouterCfg(env) {
  const ids = new Set(String(env.SPOT_ROUTER_CLIENTS || "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9._\-]{1,64}$/.test(x)));
  const per = Math.max(1, parseInt(env.SPOT_ROUTER_CHECK_ATOMIC || "1000", 10) || 1000);
  const pack = Math.max(1, Math.min(250, parseInt(env.SPOT_ROUTER_PACK_CHECKS || "10", 10) || 10));
  return { ids, perCheckAtomic: per, packChecks: pack, packAtomic: Math.max(10000, per * pack) };
}

// Returns {free, used, limit, error?}. If the counter is unavailable the call is served free (fail open):
// counting must never break an answer.
export async function takeFree(env, key, limit, now = new Date(), op = "take", counter = "q", period = null) {
  if (limit <= 0) return { free: false, used: 0, limit };
  try {
    if (!env.QUOTA || typeof env.QUOTA.idFromName !== "function") return { free: true, used: null, limit, error: "no-quota-binding" };
    const stub = env.QUOTA.get(env.QUOTA.idFromName(key));
    const day = period != null ? period : utcDay(now);
    const r = await stub.fetch(`https://quota.internal/${op}?day=${encodeURIComponent(day)}&limit=${limit}&counter=${encodeURIComponent(counter)}`);
    const j = await r.json();
    return { free: !!j.free, used: j.used, limit };
  } catch (e) {
    return { free: true, used: null, limit, error: "quota-error" };
  }
}

export function paymentRequirements(c, resourceUrl, version = 2, paidPathOrOpts = false) {
  const opts = typeof paidPathOrOpts === "boolean" ? { paidPath: paidPathOrOpts } : paidPathOrOpts || {};
  const paidPath = !!opts.paidPath;
  const extra = { name: "USD Coin", version: "2" };
  const description = opts.description
    || (paidPath
      ? `Verified catalog reliability lookup, paid per call (no free quota on this path). ${PAYMENT_POLICY}`
      : `Verified catalog reliability lookup, one call after the ${c.freePerDay} free calls per UTC day. ${PAYMENT_POLICY}`);
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

// 0.20.0: the free check is the front door. Its URL and one real free answer lead every surface; the paid 402 is the step after.
export function freeCheckField(target = "") {
  return {
    url: FREE_CHECK_URL,
    ...(target ? { this_endpoint: API_ORIGIN + "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(target) } : {}),
    example: FREE_CHECK_EXAMPLE_URL,
    example_response: FREE_CHECK_EXAMPLE,
    free: "1 check per client per UTC day, plus free dry runs (&mode=dry-run). No payment, no key.",
    then: "the paid check (HTTP 402, $0.01 to $0.25 USDC on Base) only for the full payment terms",
    prior_checks: PRIOR_CHECKS,
  };
}
const FREE_CHECK_LINE = ` Free check first: ${FREE_CHECK_URL}`;

// Additive human/agent-readable hints for 402 and bad-params 400 bodies (do not alter x402 accepts/resource/extensions).
export function hintFields(origin) {
  return {
    try_free_lookup: {
      description: "Same results as paid. 5 free calls per client per UTC day. Copy this URL (set your own client id).",
      url: origin + "/v1/lookup?task=web-search&max_price=0.05&n=3&client=YOUR_CLIENT_ID&ref=via-402-hint",
      ref: "via-402-hint",
      mcp: origin + "/mcp",
    },
    also_available: {
      product: "overnight-cos-pack",
      title: "Overnight Chief of Staff Setup Pack",
      price_usdc: 9,
      url: origin + "/v1/products/overnight-cos-pack",
      note: "Always-paid x402 product: prompts + HTML template + PDF guide after $9 USDC on Base.",
    },
    skips_page: {
      description: "Free: 500 self-checked x402 endpoints, with the ones to skip before paying (claimed vs 402 price, pay-to, network).",
      url: origin + "/v1/skips",
      json: origin + "/v1/skips.json",
    },
    also_available_spot_check: {
      product: SPOT_ID,
      title: SPOT_SERVICE_NAME,
      price_usdc: "0.01-0.25",
      free_per_day: 1,
      url: origin + "/v1/products/endpoint-spot-check?url=https%3A%2F%2Fexample.com&client=YOUR_CLIENT_ID&ref=via-402-hint",
      note: "1 free SSRF-safe x402 challenge probe per client per UTC day, then $0.01 to $0.25 USDC (one tenth of the target's quoted price) on Base. Free result: verdict + plain reason; paid adds quoted/claimed price, pay-to, network.",
    },
  };
}

// The always-paid path: 402 for every unpaid call, with Bazaar discovery metadata so facilitators and x402scan can list it.
export function paidPaymentRequired(c, resourceUrl, error) {
  const origin = new URL(resourceUrl).origin;
  return {
    x402Version: 2,
    error: error + FREE_CHECK_LINE,
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
    free_check: freeCheckField(),
    free_alternative: "The same lookup is free for 5 calls per client per UTC day at /v1/lookup and via the free MCP server at /mcp. Payment never changes results.",
    how_to_pay:
      "Retry the same request with a PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT is also accepted) holding a signed USDC EIP-3009 authorization for the amount and payTo above. Bad parameters get a 400 before anything is settled.",
    ...hintFields(CANON_ORIGIN),
  };
}


// ------------------------------------------------------------------ Overnight CoS Setup Pack ($9, always paid)
export function packBazaarExtension() {
  return {
    info: {
      input: { type: "http", method: "GET" },
      output: {
        type: "json",
        example: {
          product: PACK_ID,
          title: PACK_TITLE,
          price_usdc: PACK_PRICE_USD,
          files: {
            prompts: { "00_overnight_cos_combiner.txt": "..." },
            templates: { "morning_briefing_template.html": "..." },
            guide: { filename: PACK_GUIDE_FILENAME, content_type: "application/pdf", encoding: "base64", data: "..." },
          },
          access: { tier: "paid", charged_usd: "9", tx: "0x..." },
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
            method: { type: "string", enum: ["GET", "POST"] },
            headers: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["type", "method"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: {
              type: "object",
              properties: {
                product: { type: "string" },
                title: { type: "string" },
                price_usdc: { type: "number" },
                files: {
                  type: "object",
                  properties: {
                    prompts: { type: "object", additionalProperties: { type: "string" } },
                    templates: { type: "object", additionalProperties: { type: "string" } },
                    guide: {
                      type: "object",
                      properties: {
                        filename: { type: "string" },
                        content_type: { type: "string" },
                        encoding: { type: "string" },
                        data: { type: "string", description: "base64-encoded PDF" },
                      },
                    },
                  },
                },
                access: { type: "object" },
              },
            },
          },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  };
}

export function packPaymentRequired(c, resourceUrl, error) {
  return {
    x402Version: 2,
    error: error + FREE_CHECK_LINE,
    resource: {
      url: resourceUrl,
      description: PACK_DESCRIPTION,
      mimeType: "application/json",
      serviceName: PACK_SERVICE_NAME,
      tags: PACK_TAGS,
    },
    accepts: [paymentRequirements(c, resourceUrl, 2, {
      paidPath: true,
      description: `${PACK_TITLE}: one-time download of prompts, HTML template, and PDF guide. ${c.priceUsd} USDC on Base.`,
    })],
    extensions: { bazaar: packBazaarExtension() },
    price_usd: c.priceUsd,
    asset: "USDC on Base (eip155:8453)",
    product: PACK_ID,
    free_check: freeCheckField(),
    how_to_pay:
      "Retry the same request with a PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT is also accepted) holding a signed USDC EIP-3009 authorization for the amount and payTo above. Bad or missing payment returns 402; nothing is delivered until settle succeeds.",
  };
}

function bytesToBase64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function loadPackGuide(env) {
  if (env.PACK_BLOBS && typeof env.PACK_BLOBS.get === "function") {
    const raw = await env.PACK_BLOBS.get(PACK_GUIDE_KV_KEY, "arrayBuffer");
    if (raw && raw.byteLength) return bytesToBase64(raw);
  }
  return null;
}

export async function buildPackResponse(env, settlement) {
  const guideB64 = await loadPackGuide(env);
  const guide = guideB64
    ? { filename: PACK_GUIDE_FILENAME, content_type: "application/pdf", encoding: "base64", data: guideB64 }
    : { filename: PACK_GUIDE_FILENAME, content_type: "application/pdf", encoding: "base64", data: "", error: "guide unavailable" };
  return {
    product: PACK_ID,
    title: PACK_TITLE,
    price_usdc: PACK_PRICE_USD,
    files: { prompts: PACK_PROMPTS, templates: PACK_TEMPLATES, guide },
    access: settlement,
  };
}

// Always-paid product. SELF_CLIENTS are NOT exempt (this is a product sale, not lookup quota).
// PACK_PREVIEW=1 returns a stub without payment (local/unit tests only; leave off in production).
async function packFailPoint(req, env, url, payer, error) {
  const q = parseQuery(url);
  const cid = await clientId(req, q, env);
  writePoint(env, dataPoint({ product: "pack", cid, q: { ...q, errors: [], endpoint: url.pathname }, excluded: exclusion(req, q, env, url), candidates: 0, ua: req.headers.get("user-agent") || "", returnedPayTo: [], status: 402, referer: refererHost(req), access: "payment-failed", paidBy: payer, failReason: error }));
}
async function handleOvernightCosPack(req, env, ctx, url) {
  const c = packCfg(env);
  const resourceUrl = url.origin + url.pathname.replace(/\/+$/, "");
  const deny = (error, kind = "payment-required", payer = "") => {
    const body = packPaymentRequired(c, resourceUrl, error);
    // 0.19.0: a signed pack payment that failed is its own analytics row (payer + reason); plain 402s stay view-pack-402 rows.
    if (kind === "payment-failed") packFailPoint(req, env, url, payer, error).catch(() => {});
    return json(body, 402, { "payment-required": b64encode(body) });
  };
  if (String(env.PACK_PREVIEW || "") === "1") {
    const stub = await buildPackResponse(
      { ...env, PACK_BLOBS: { get: async () => new TextEncoder().encode("%PDF-1.4 stub").buffer } },
      { tier: "preview", note: "PACK_PREVIEW=1: no payment settled" }
    );
    return json(stub, 200);
  }
  const hdr = paymentHeader(req);
  if (!hdr) return deny(`Payment required: ${c.priceUsd} USDC on Base for the ${PACK_TITLE} via x402.`);
  const payload = decodePaymentHeader(hdr);
  if (!payload) return deny("payment header is not valid base64 JSON x402 payload", "payment-failed");
  const bad = checkPayload(payload, c);
  if (bad) return deny("payment rejected: " + bad, "payment-failed", signerOf(payload));
  const r = await verifyAndSettle(c, payload, resourceUrl, {
    paidPath: true,
    description: `${PACK_TITLE}: one-time download. ${c.priceUsd} USDC on Base.`,
  });
  if (!r.ok) return deny("payment rejected: " + r.reason, "payment-failed", signerOf(payload));
  const enc = b64encode(r.settle);
  const settlement = {
    tier: "paid",
    charged_usd: c.priceUsd,
    asset: "USDC on Base",
    tx: r.settle.transaction,
    basescan_url: "https://basescan.org/tx/" + r.settle.transaction,
    payer: r.settle.payer || null,
    settlement: r.settle,
  };
  const body = await buildPackResponse(env, settlement);
  if (!body.files.guide.data) {
    // Settle already happened; still return prompts/template and note the missing PDF.
    body.files.guide.note = "PDF guide could not be loaded from storage; prompts and template are included. Contact support with your settlement tx.";
  }
  return json(body, 200, { "payment-response": enc, "x-payment-response": enc });
}


// ------------------------------------------------------------------ Endpoint Spot-Check ($0.25, 1 free/day)
export function spotBazaarExtension() {
  return {
    info: {
      input: {
        type: "http",
        method: "GET",
        queryParams: { url: "https://x402.example.com/api", claimed_price: "0.001", client: "agent" },
      },
      output: {
        type: "json",
        // A Bazaar listing describes the paid call, so the example is the real paid body. The free tier
        // (1/client/UTC day) returns only verdict + a plain-words reason + access: see SPOT_FREE_EXAMPLE.
        example: SPOT_PAID_EXAMPLE,
        free_example: SPOT_FREE_EXAMPLE,
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
            method: { type: "string", enum: ["GET", "POST"] },
            queryParams: {
              type: "object",
              properties: {
                url: { type: "string", description: "public http(s) URL to probe for an x402 challenge" },
                task: { type: "string" },
                claimed_price: { type: "string", description: "optional claimed USD price to compare" },
                method: { type: "string", enum: ["GET", "POST"], description: "probe method for the target (default GET)" },
                pay_to: { type: "string", description: "optional expected pay-to wallet" },
                network: { type: "string", description: "optional expected CAIP-2 network" },
                client: { type: "string" },
                ref: { type: "string", description: "attribution tag; ref=dry-run-<caller> sets mode=dry-run" },
                mode: { type: "string", enum: ["live", "dry-run"], description: "free dry run: one unpaid probe, nothing signed or paid, always stored as a public receipt (check_type dry-run). Returns the free-tier shape with payment_terms_sha256 null (never an approval). 50 per caller (ref, else client, else IP) per UTC day. ref=dry-run-<caller> also sets it" },
              },
            },
            headers: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["type", "method"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: SPOT_PAID_SCHEMA,
            free_example: SPOT_FREE_SCHEMA,
          },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  };
}

// Real response shapes (kept in step with buildResult in handleEndpointSpotCheck; unit-tested).
export const SPOT_PAID_EXAMPLE = {
  verdict: "pay",
  reason: "price_ok",
  quoted_price_usd: 0.05,
  claimed_price_usd: 0.05,
  pay_to: "0x1111111111111111111111111111111111111111",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  expected_pay_to: "0x1111111111111111111111111111111111111111",
  expected_network: "eip155:8453",
  expected_source: "request",
  payment: {
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: { atomic: "50000", usd: 0.05 },
    pay_to: "0x1111111111111111111111111111111111111111",
    deadline: "2026-10-10T17:05:00Z",
    deadline_source: "maxTimeoutSeconds",
    scheme: "exact",
    amount_atomic: "50000",
    amount_usd: 0.05,
    asset_is_usdc: true,
  },
  payment_terms_sha256: "<sha256 of network|asset|amount_atomic|pay_to, lower-case>",
  probe: { probed_at: "2026-10-10T17:00:00Z", cached: false, cache_ttl_s: 300 },
  check_type: "dry-run",
  receipt_id: "sc-0123456789abcdef",
  receipt_url: "https://402xagent.com/v1/receipts/sc-0123456789abcdef",
  access: { tier: "paid", charged_usd: "0.01", asset: "USDC on Base", tx: "0x...", basescan_url: "https://basescan.org/tx/0x...", payer: "0x..." },
};
export const SPOT_FREE_EXAMPLE = {
  verdict: "pay",
  reason: "listed $0.05, payment request matches, details locked",
  payment_terms_sha256: "<sha256 of network|asset|amount_atomic|pay_to, lower-case>",
  receipt_id: "sc-0123456789abcdef",
  receipt_url: "https://402xagent.com/v1/receipts/sc-0123456789abcdef",
  prior_checks: "https://402xagent.com/v1/skips",
  access: { tier: "free", free_per_day: 1, free_used_today: 1, free_remaining_today: 0, then: "$0.01 USDC on Base for the full check of this endpoint via x402 (HTTP 402)" },
};
const SPOT_VERDICT_SCHEMA = { type: "string", enum: ["pay", "skip", "recheck"] };
export const SPOT_PAID_SCHEMA = {
  type: "object",
  description: "paid response: decision plus the facts behind it",
  properties: {
    verdict: SPOT_VERDICT_SCHEMA,
    reason: { type: "string", enum: ["price_ok", "price_mismatch", "network_mismatch", "pay_to_mismatch", "asset_not_usdc", "network_unsupported", "no_paywall", "free_trial_active", "timeout", "unreachable", "server_error", "bad_challenge", "ssrf_blocked"] },
    free_trial_remaining: { type: ["integer", "null"], description: "reason free_trial_active only: the seller's x-free-trial-remaining, when parseable" },
    quoted_price_usd: { type: ["number", "null"], description: "price in the target's live 402 challenge" },
    claimed_price_usd: { type: ["number", "null"], description: "the claimed_price you sent" },
    pay_to: { type: ["string", "null"] },
    network: { type: ["string", "null"] },
    asset: { type: ["string", "null"] },
    expected_pay_to: { type: ["string", "null"], description: "the pay_to you sent, else the listing's (from our crawl), else null" },
    expected_network: { type: ["string", "null"] },
    expected_source: { type: ["string", "null"], enum: ["request", "listing", null] },
    payment: {
      type: ["object", "null"],
      description: "verdict pay only: THE payment a router may sign, from the live 402, checked against the listing: network (supported mainnet, CAIP-2), asset (that network's canonical USDC contract), amount {atomic, usd}, pay_to, deadline (UTC; validBefore, else probed_at + maxTimeoutSeconds, else + 60 s). Sign nothing else. scheme / amount_atomic / amount_usd / asset_is_usdc are kept for older clients.",
      properties: {
        network: { type: "string" }, asset: { type: "string" },
        amount: { type: "object", properties: { atomic: { type: "string" }, usd: { type: ["number", "null"] } }, required: ["atomic", "usd"] },
        pay_to: { type: "string" }, deadline: { type: "string", format: "date-time" }, deadline_source: { type: "string", enum: ["validBefore", "maxTimeoutSeconds", "default_60s"] },
        scheme: { type: "string" }, asset_is_usdc: { type: ["boolean", "null"] }, amount_atomic: { type: "string" }, amount_usd: { type: ["number", "null"] },
      },
      required: ["network", "asset", "amount", "pay_to", "deadline"],
    },
    probe: { type: "object", description: "the live probe this decision used: probed_at, cached (true = reused within cache_ttl_s for the same normalized URL + method, so consecutive calls agree)", properties: { probed_at: { type: "string" }, cached: { type: "boolean" }, cache_ttl_s: { type: "integer" } } },
    check_type: { type: "string", enum: ["dry-run", "self-checked"], description: "receipt label: self-checked for our own self-test client, dry-run for everyone else" },
    payment_terms_sha256: { type: ["string", "null"], description: "sha256 hex of lower-case network|asset|amount_atomic|pay_to (null unless pay)" },
    receipt_id: { type: ["string", "null"], description: "public receipt id for this decision (sc-...)" },
    receipt_url: { type: ["string", "null"], description: "free, public: GET it to show as the reason for paying or aborting" },
    access: { type: "object", properties: { tier: { const: "paid" }, charged_usd: { type: "string" }, tx: { type: "string" } } },
  },
  required: ["verdict", "reason", "quoted_price_usd", "claimed_price_usd", "pay_to", "network", "asset", "expected_pay_to", "expected_network", "expected_source", "payment", "payment_terms_sha256", "probe", "check_type", "receipt_id", "receipt_url", "access"],
};
export const SPOT_FREE_SCHEMA = {
  type: "object",
  description: "free response (1 per client per UTC day): verdict and a plain-words reason only",
  properties: {
    verdict: SPOT_VERDICT_SCHEMA,
    reason: { type: "string", description: "plain words, e.g. 'listed $0.01, no payment request, details locked'" },
    payment_terms_sha256: { type: ["string", "null"], description: "sha256 hex of lower-case network|asset|amount_atomic|pay_to of the approved payment (null unless pay)" },
    receipt_id: { type: ["string", "null"], description: "public receipt id for this decision (sc-...)" },
    receipt_url: { type: ["string", "null"], description: "free, public: GET it to show as the reason for paying or aborting" },
    access: { type: "object", properties: { tier: { const: "free" } } },
  },
  required: ["verdict", "reason", "payment_terms_sha256", "receipt_id", "receipt_url", "access"],
  additionalProperties: false,
};

export function spotPaymentRequired(c, resourceUrl, error, used, target = "") {
  const origin = new URL(resourceUrl).origin;
  const ft = freeCheckField(target);
  return {
    x402Version: 2,
    error: error + ` The free check (${c.freePerDay}/day, resets 00:00 UTC) is ${FREE_CHECK_URL}; a free dry run works now: add &mode=dry-run.`,
    resource: {
      url: resourceUrl,
      description: `${SPOT_SERVICE_NAME}: SSRF-safe probe of a public URL for an x402 PAYMENT-REQUIRED challenge. Never pays the target. $${c.priceUsd} USDC on Base after ${c.freePerDay} free check per UTC day.`,
      mimeType: "application/json",
      serviceName: SPOT_SERVICE_NAME,
      tags: SPOT_TAGS,
    },
    accepts: [paymentRequirements(c, resourceUrl, 2, {
      paidPath: false,
      description: `${SPOT_SERVICE_NAME}: one probe after the ${c.freePerDay} free check per UTC day. $${c.priceUsd} USDC on Base. Never pays the target under test.`,
    })],
    extensions: { bazaar: spotBazaarExtension() },
    price_usd: c.priceUsd,
    asset: "USDC on Base (eip155:8453)",
    product: SPOT_ID,
    free_per_day: c.freePerDay,
    free_used_today: used,
    free_resets: "00:00 UTC",
    free_check: { ...ft, dry_run_now: (ft.this_endpoint || FREE_CHECK_URL) + "&mode=dry-run" },
    paid_fields: ["quoted_price_usd", "claimed_price_usd", "pay_to", "network", "asset", "expected_pay_to", "expected_network", "expected_source", "payment"],
    paid_example: {
      verdict: "skip",
      reason: "no_paywall",
      quoted_price_usd: null,
      claimed_price_usd: 0.35,
      pay_to: null,
      network: null,
      asset: null,
      expected_pay_to: null,
      expected_network: null,
      expected_source: "request",
      payment: null,
      payment_terms_sha256: null,
      probe: { probed_at: "2026-10-10T17:00:00Z", cached: false, cache_ttl_s: 300 },
      check_type: "dry-run",
      receipt_id: "sc-0123456789abcdef",
      receipt_url: "https://402xagent.com/v1/receipts/sc-0123456789abcdef",
      access: { tier: "paid", charged_usd: "0.01", asset: "USDC on Base", tx: "0x...", basescan_url: "https://basescan.org/tx/0x...", payer: "0x..." },
    },
    paid_example_note: "Real case: https://kr-intel-agent-production.up.railway.app/api/briefing is listed as a $0.35 x402 endpoint; the live probe gets HTTP 404 with no 402 challenge, so there is nothing safe to pay. Receipt: " + origin + "/v1/receipts/395e5cd716. (Any response without 402 terms is skip/no_paywall, except recheck/free_trial_active when the seller sends x-free-trial headers; recheck is only for timeouts, 5xx and network errors.)",
    free_example: SPOT_FREE_EXAMPLE,
    skips_page: CANON_ORIGIN + "/v1/skips",
    how_to_pay:
      "Retry the same request with a PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT is also accepted) holding a signed USDC EIP-3009 authorization for the amount and payTo above.",
    ...hintFields(CANON_ORIGIN),
  };
}

const SPOT_URL_ALIASES = ["url", "endpoint", "target", "resource", "endpoint_url", "uri"];
const SPOT_PRICE_ALIASES = ["claimed_price", "claimed_price_usd", "price", "price_usd"];
export const SPOT_EXAMPLE_TARGET = "https://example.com/api/paid";
export function spotExample(origin) {
  return origin + "/v1/products/endpoint-spot-check?url=" + SPOT_EXAMPLE_TARGET;
}
// One-line 400 message: exact field name + a full working sample request (GET URL, and the one-line POST JSON).
export function spotBadRequest(origin, field, problem) {
  const example = spotExample(origin);
  return {
    error: `${problem}. Example: ${example} (or POST JSON {"url":"${SPOT_EXAMPLE_TARGET}"} to ${origin}/v1/products/endpoint-spot-check)`,
    field,
    example,
  };
}
const SPOT_KNOWN_PARAMS = new Set([...SPOT_URL_ALIASES, ...SPOT_PRICE_ALIASES, "task", "client", "ref", "format", "method", "pay_to", "network", "mode"]);

// Listing facts from our self-checked crawl (/v1/receipts), by exact URL. Used as the expected pay_to / network / price
// when the caller does not send its own (0.7.0).
let LISTINGS = null;
export function listingFor(u) {
  if (!LISTINGS) {
    LISTINGS = new Map();
    for (const r of RECEIPTS || []) if (r && r.url) LISTINGS.set(String(r.url), r);
  }
  return LISTINGS.get(String(u || "")) || null;
}
// Full-coverage lookup (0.11.0): bundled page first, then the weekly crawl in CRAWL_KV (normalized URL).
export async function listingForAsync(env, u) {
  return listingFor(u) || (await crawlReceiptForUrl(env, u).catch(() => null));
}
// PAY STEP (0.8.0): the exact payment a router may sign, taken from the target's live 402 and checked against the
// expectation (caller's listing, else our crawl's listing). Only USDC is approved where we know the USDC contract.
// 0.14.0: supported mainnets only, each with its canonical (Circle-issued, native) USDC contract. Testnets and other
// networks are skip/network_unsupported; any other token on a supported network is skip/asset_not_usdc.
export const USDC_BY_NETWORK = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base
  "eip155:1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // Ethereum
  "eip155:10": "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // OP Mainnet
  "eip155:137": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // Polygon PoS
  "eip155:42161": "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // Arbitrum One
  "eip155:43114": "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", // Avalanche C-Chain
  "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp": "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v", // Solana mainnet (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
};
const NETWORK_ALIASES = { base: "eip155:8453", ethereum: "eip155:1", optimism: "eip155:10", polygon: "eip155:137", arbitrum: "eip155:42161", avalanche: "eip155:43114", solana: "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp" };
export const caip = (n) => NETWORK_ALIASES[String(n ?? "").toLowerCase()] || String(n ?? "").toLowerCase();
const lc = (v) => String(v ?? "").toLowerCase();
export function pickPayment(probe, exp = {}) {
  const accepts = (Array.isArray(probe && probe.accepts) ? probe.accepts : []).filter((a) => a && a.network && a.payTo && a.amount != null && /^[0-9]{1,30}$/.test(String(a.amount)) && (!a.scheme || a.scheme === "exact"));
  if (!accepts.length) return null;
  const usdc = (a) => USDC_BY_NETWORK[caip(a.network)] ? USDC_BY_NETWORK[caip(a.network)] === lc(a.asset) : null;
  const score = (a) => (exp.network && lc(a.network) === lc(exp.network) ? 4 : 0) + (exp.pay_to && lc(a.payTo) === lc(exp.pay_to) ? 2 : 0) + (usdc(a) === true ? 1 : 0);
  const a = [...accepts].sort((x, y) => score(y) - score(x))[0];
  const isUsdc = usdc(a);
  return {
    scheme: a.scheme || "exact",
    network: a.network,
    asset: a.asset || null,
    asset_is_usdc: isUsdc,
    amount_atomic: String(a.amount),
    amount_usd: isUsdc ? Number(a.amount) / 1e6 : null,
    pay_to: a.payTo,
    supported_network: !!USDC_BY_NETWORK[caip(a.network)],
    max_timeout_seconds: a.maxTimeoutSeconds ?? null,
    valid_before: a.validBefore ?? null,
  };
}
// 0.14.0: the paid / self-test answer IS the payment object. deadline = validBefore when the 402 states it, else
// probed_at + maxTimeoutSeconds, else probed_at + 60 s (x402 default). Legacy flat fields stay for x402-spotcheck <= 0.2.x.
export function paymentObject(pm, probedAt) {
  if (!pm) return null;
  const t0 = Date.parse(probedAt || "") || Date.now();
  let deadline = null, source = "default_60s";
  const vb = pm.valid_before;
  if (vb != null && /^\d{9,12}$/.test(String(vb))) { deadline = new Date(Number(vb) * 1000); source = "validBefore"; }
  else if (vb != null && !Number.isNaN(Date.parse(String(vb)))) { deadline = new Date(Date.parse(String(vb))); source = "validBefore"; }
  else if (pm.max_timeout_seconds) { deadline = new Date(t0 + pm.max_timeout_seconds * 1000); source = "maxTimeoutSeconds"; }
  else deadline = new Date(t0 + 60000);
  return {
    network: pm.network, // as the 402 states it (x402 v1 names like "base" stay as-is so signed requirements still match)
    asset: USDC_BY_NETWORK[caip(pm.network)] === lc(pm.asset) ? canonicalAsset(pm.network, pm.asset) : pm.asset,
    amount: { atomic: pm.amount_atomic, usd: pm.amount_usd },
    pay_to: pm.pay_to,
    deadline: deadline.toISOString().replace(/\.\d{3}Z$/, "Z"),
    deadline_source: source,
    scheme: pm.scheme,
    amount_atomic: pm.amount_atomic,
    amount_usd: pm.amount_usd,
    asset_is_usdc: pm.asset_is_usdc,
  };
}
const CANONICAL_CASE = { "eip155:8453": USDC_BASE };
const canonicalAsset = (n, a) => CANONICAL_CASE[caip(n)] || a;
// Commitment to the approved terms, so the free tier can enforce them without the terms in the body.
export async function termsSha256(pm) {
  if (!pm) return null;
  return sha256hex([lc(pm.network), lc(pm.asset), String(pm.amount_atomic), lc(pm.pay_to)].join("|"));
}
// After decideVerdict + applyExpected: a "pay" needs one signable USDC payment whose amount matches the claimed price.
export function applyPayment(d, pm, exp) {
  if (!d || d.verdict !== "pay") return d;
  if (!pm) return { verdict: "skip", reason: "bad_challenge" }; // no exact-scheme payment with a readable amount
  if (!pm.supported_network) return { verdict: "skip", reason: "network_unsupported" };
  if (pm.asset_is_usdc !== true) return { verdict: "skip", reason: "asset_not_usdc" };
  if (exp.claimed != null && pm.amount_usd != null && priceMatchesClaimed(pm.amount_usd, exp.claimed) === false) return { verdict: "skip", reason: "price_mismatch" };
  return d;
}

// ---------------------------------------------------------------- public live receipts (0.9.0, D1)
// Every delivered Spot-Check decision is stored as a public receipt: listing URL, live 402 terms, verdict, reason,
// timestamp, id. Reading is free (GET /v1/receipts/<id>, GET /v1/receipts/by-url?url=). No client ids/IPs/payers stored.
export const LIVE_RECEIPT_RE = /^sc-[0-9a-f]{16}$/;
export function newReceiptId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return "sc-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function liveDemand(probe) {
  const accepts = (probe.accepts || []).map((a) => ({ scheme: a.scheme, network: a.network, asset: a.asset, amount_atomic: a.amount, pay_to: a.payTo }));
  if (probe.x402_challenge) return { http_status: probe.http_status ?? null, x402_challenge: true, schemes: [...new Set(accepts.map((a) => a.scheme).filter(Boolean))], terms: accepts };
  return { http_status: probe.http_status ?? null, x402_challenge: false, free_trial: probe.free_trial || null, error: probe.error || null };
}
// 0.14.0: every Spot-Check call that probes (or is SSRF-blocked) is stored. check_type: "self-checked" for our own
// exempt self-test client (crawls are self-checked too), "dry-run" for everyone else; mode says whether the caller
// asked for a dry run. probe_snapshot is the cached live probe that makes the decision repeatable for SPOT_PROBE_CACHE_S.
export function buildLiveReceipt({ id, origin, url, method, probe, d, reasonText, pm, termsHash, exp, now = new Date(), checkType = "dry-run", mode = "live", ref = "", caller = null, probedAt = null, cached = false, normKey = null }) {
  return {
    id,
    url,
    method,
    checked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    check_type: checkType,
    mode,
    dry_run: mode === "dry-run",
    check_note: mode === "dry-run"
      ? "dry run: one unpaid probe of the target; nothing signed or paid, and not an approval to pay"
      : "402xAgent check: unpaid probe of the target (never pays it)",
    ref: ref || null,
    caller: caller || ref || null,
    listing: exp.source ? { claimed_price_usd: exp.claimed, pay_to: exp.pay_to, network: exp.network, source: exp.source } : null,
    live_demand: liveDemand(probe),
    verdict: d.verdict,
    reason: d.reason,
    reason_text: reasonText,
    probe: { probed_at: probedAt, cached: !!cached, cache_ttl_s: SPOT_PROBE_CACHE_S },
    live_402: {
      http_status: probe.http_status ?? null,
      x402_challenge: !!probe.x402_challenge,
      accepts: (probe.accepts || []).map((a) => ({ scheme: a.scheme, network: a.network, asset: a.asset, amount_atomic: a.amount, pay_to: a.payTo })),
      error: probe.error || null,
      free_trial: probe.free_trial || null,
    },
    expected: { claimed_price_usd: exp.claimed, pay_to: exp.pay_to, network: exp.network, source: exp.source },
    approved_payment: pm,
    payment_terms_sha256: termsHash,
    probe_snapshot: probeSnapshot(probe),
    norm_key: normKey,
    worker_version: VERSION,
    permalink: origin + "/v1/receipts/" + id,
  };
}
// Determinism (0.14.0): one live probe per normalized URL + method is reused for SPOT_PROBE_CACHE_S (5 min), so two
// consecutive calls get the same verdict even if the target varies per caller (trials) or flaps. Stored in D1 (global).
export const SPOT_PROBE_CACHE_S = 300;
export function probeKey(u, method) {
  let n = String(u || "");
  try { n = normUrl(u); } catch (_) {}
  return n + " " + String(method || "GET").toUpperCase();
}
export function probeSnapshot(p) {
  if (!p) return null;
  const keep = ["reachable", "http_status", "ssrf_blocked", "error", "x402_challenge", "accepts", "quoted_price_usd", "known_answer", "free_trial", "body_truncated"];
  const o = {};
  for (const k of keep) if (p[k] !== undefined) o[k] = p[k];
  return o;
}
async function getProbe(env, q, probeOpts, now = new Date()) {
  const key = probeKey(q.url, q.method);
  const ttl = env.SPOT_PROBE_CACHE_S != null && /^\d+$/.test(String(env.SPOT_PROBE_CACHE_S)) ? Number(env.SPOT_PROBE_CACHE_S) : SPOT_PROBE_CACHE_S;
  if (env.RECEIPTS_DB && ttl > 0) {
    try {
      const since = new Date(now.getTime() - ttl * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const row = await env.RECEIPTS_DB.prepare("SELECT body FROM spot_receipts WHERE norm_key = ? AND probed_at >= ? ORDER BY probed_at DESC LIMIT 1").bind(key, since).first();
      const b = row ? JSON.parse(row.body) : null;
      if (b && b.probe_snapshot && b.probe && b.probe.probed_at) return { probe: b.probe_snapshot, probedAt: b.probe.probed_at, cached: true, key };
    } catch (_) {
      // cache miss on any store error
    }
  }
  const probe = await spotProbe(q.url, { ...probeOpts, method: q.method });
  return { probe, probedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"), cached: false, key };
}
export async function saveLiveReceipt(env, r) {
  if (!env.RECEIPTS_DB) return false;
  try {
    await env.RECEIPTS_DB.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, norm_key, probed_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(r.id, r.url, r.checked_at, r.verdict, r.reason, r.check_type || "dry-run", r.ref || null, r.norm_key || null, (r.probe && r.probe.probed_at) || null, JSON.stringify(r)).run();
    return true;
  } catch (_) {
    return false; // storing must never break an answer
  }
}
// Receipts stored before 0.13.0 carry the long check_type text; read them as check_type "live" (text kept in check_note).
export function normReceipt(r) {
  if (!r) return r;
  // 0.18.0: copy stored under earlier names reads with the current brand (URLs and route paths untouched).
  try {
    const t = JSON.stringify(r);
    if (/formerly|spot-check: unpaid|Spot-Check|Spot Check/.test(t.replace(/endpoint-spot-check/g, "")))
      r = JSON.parse(t.replace(/ ?\(formerly [^)"]*\)/g, "").replace(/spot-check: unpaid probe/g, "402xAgent check: unpaid probe").replace(/(?<!endpoint-)Spot[- ]Check(?!er)/g, "402xAgent check"));
  } catch (_) {}
  // 0.17.0: rows stored under an earlier brand/host are served with the current service name and canonical permalink.
  if (r.id) r = { ...r, service: SPOT_SERVICE_NAME, permalink: CANON_ORIGIN + "/v1/receipts/" + r.id };
  for (const k of ["ref", "caller"]) if (typeof r[k] === "string" && /payscout/i.test(r[k])) r = { ...r, [k]: r[k].replace(/payscout/gi, "402xagent") }; // old site tag
  if (!["live", "dry-run", "self-checked"].includes(r.check_type)) return { ...r, check_type: "live", check_note: r.check_type || null };
  return r;
}
export async function getLiveReceipt(env, id) {
  if (!env.RECEIPTS_DB || !LIVE_RECEIPT_RE.test(id)) return null;
  const row = await env.RECEIPTS_DB.prepare("SELECT body FROM spot_receipts WHERE id = ?").bind(id).first();
  return row ? normReceipt(JSON.parse(row.body)) : null;
}
export async function latestLiveReceipt(env, url) {
  if (!env.RECEIPTS_DB) return null;
  const row = await env.RECEIPTS_DB.prepare("SELECT body FROM spot_receipts WHERE url = ? ORDER BY created_at DESC LIMIT 1").bind(url).first();
  return row ? normReceipt(JSON.parse(row.body)) : null;
}
// GET /v1/receipts?type=dry-run|live[&ref=][&limit=1..100][&cursor=] : newest first, free to read.
export async function handleReceiptList(env, url) {
  const p = url.searchParams;
  const type = String(p.get("type") || "").toLowerCase();
  if (!["dry-run", "self-checked", "live"].includes(type)) return rj({ error: "type must be dry-run, self-checked, or live (legacy rows stored before 0.14.0)", field: "type", example: CANON_ORIGIN + "/v1/receipts?type=dry-run&limit=20" }, 400);
  const ref = String(p.get("ref") || "").toLowerCase();
  if (ref && !/^[a-z0-9._\-]{1,64}$/.test(ref)) return rj({ error: "invalid ref", field: "ref" }, 400);
  let limit = parseInt(p.get("limit") || "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  limit = Math.min(limit, 100);
  let cur = null;
  const cursor = p.get("cursor");
  if (cursor) {
    try { cur = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))); } catch (_) { cur = null; }
    if (!Array.isArray(cur) || cur.length !== 2 || !LIVE_RECEIPT_RE.test(String(cur[1]))) return rj({ error: "invalid cursor", field: "cursor" }, 400);
  }
  if (!env.RECEIPTS_DB) return rj({ error: "receipt store unavailable, try again shortly" }, 503);
  let sql = "SELECT id, created_at, body FROM spot_receipts WHERE check_type = ?";
  const args = [type];
  if (ref) { sql += " AND ref = ?"; args.push(ref); }
  if (cur) { sql += " AND (created_at < ? OR (created_at = ? AND id < ?))"; args.push(cur[0], cur[0], cur[1]); }
  sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
  args.push(limit + 1);
  let rows;
  try { rows = ((await env.RECEIPTS_DB.prepare(sql).bind(...args).all()) || {}).results || []; } catch (_) { return rj({ error: "receipt store unavailable, try again shortly" }, 503); }
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next = more && last ? btoa(JSON.stringify([last.created_at, last.id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
  const qs = (c) => { const n = new URLSearchParams({ type }); if (ref) n.set("ref", ref); n.set("limit", String(limit)); n.set("cursor", c); return CANON_ORIGIN + "/v1/receipts?" + n.toString(); };
  return rj({ type, ref: ref || null, limit, count: page.length, receipts: page.map((r) => normReceipt(JSON.parse(r.body))), next_cursor: next, next: next ? qs(next) : null });
}
const rj = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": status === 200 ? "public, max-age=60" : "no-store" } });
async function handleLiveReceipts(req, env, url, path) {
  if (path === "/v1/receipts/by-url") {
    const target = String(url.searchParams.get("url") || "").trim().slice(0, 2000);
    if (!target) return rj({ error: 'Missing "url". Example: ' + CANON_ORIGIN + "/v1/receipts/by-url?url=https://api.402rates.com/v1/ping", field: "url" }, 400);
    let live = null;
    try { live = await latestLiveReceipt(env, target); } catch (_) { return rj({ error: "receipt store unavailable, try again shortly" }, 503); }
    const crawl = await listingForAsync(env, target);
    if (!live && !crawl) return rj({ error: "no receipt for this url yet", url: target, check_now: API_ORIGIN + "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(target) }, 404);
    return rj({
      url: target,
      latest_live: live,
      latest_crawl: crawl ? { ...crawl, permalink: CANON_ORIGIN + "/v1/receipts/" + crawl.id } : null,
      note: "Stored receipts are free to read. A fresh live check is a paid 402xAgent check (1 free per client per UTC day).",
      check_now: API_ORIGIN + "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(target),
    });
  }
  const id = path.slice("/v1/receipts/".length);
  let r = null;
  try { r = await getLiveReceipt(env, id); } catch (_) { return rj({ error: "receipt store unavailable, try again shortly" }, 503); }
  return r ? rj({ service: SPOT_SERVICE_NAME, ...r }) : rj({ error: "no live receipt with id " + id.slice(0, 40) }, 404);
}

// 0.12.0: a no-terms recheck (no_terms_seen / free_trial_active) is still a skip when the listing data already shows a
// mismatch: the caller's price/network/pay_to differs from our crawl listing, or the crawl's own 402 differed from it.
export function applyNoTermsListing(d, probe, q, listing) {
  if (!d || d.reason !== "free_trial_active") return d;
  const out = { ...d };
  if (d.reason === "free_trial_active" && probe.free_trial && probe.free_trial.remaining != null) out.free_trial_remaining = probe.free_trial.remaining;
  if (!listing) return out;
  const l = (v) => String(v || "").toLowerCase();
  const skip = (reason) => ({ verdict: "skip", reason });
  if (q.claimed_price != null && listing.claimed_price_usd != null && priceMatchesClaimed(listing.claimed_price_usd, q.claimed_price) === false) return skip("price_mismatch");
  if (q.network && listing.listed_network && l(q.network) !== l(listing.listed_network)) return skip("network_mismatch");
  if (q.pay_to && listing.listed_pay_to && l(q.pay_to) !== l(listing.listed_pay_to)) return skip("pay_to_mismatch");
  if (listing.pay_to && listing.listed_pay_to && l(listing.pay_to) !== l(listing.listed_pay_to)) return skip("pay_to_mismatch");
  if (listing.network && listing.listed_network && l(listing.network) !== l(listing.listed_network)) return skip("network_mismatch");
  if (listing.quoted_price_usd != null && listing.claimed_price_usd != null && priceMatchesClaimed(listing.quoted_price_usd, listing.claimed_price_usd) === false) return skip("price_mismatch");
  return out;
}

// Compare a verdict "pay" against the expected pay_to / network: a 402 that pays a different wallet or runs on a
// different network than expected is a skip.
export function applyExpected(d, probe, exp) {
  if (!d || d.verdict !== "pay") return d;
  const accepts = Array.isArray(probe.accepts) ? probe.accepts : [];
  if (exp.network && accepts.length && !accepts.some((a) => caip(a.network) === caip(exp.network)))
    return { verdict: "skip", reason: "network_mismatch" };
  if (exp.pay_to && accepts.length && !accepts.some((a) => String(a.payTo || "").toLowerCase() === exp.pay_to.toLowerCase()))
    return { verdict: "skip", reason: "pay_to_mismatch" };
  return d;
}

// First-router program (0.7.0): allowlisted client ids get their own one-time pool of free full checks.
// Config: SPOT_PARTNER_CLIENTS = "id:1000,other-id:500" (a Worker secret, so ids never land in the public repo).
export const SPOT_PARTNER_COUNTER = "spot-partner";
export function spotPartners(env) {
  const out = new Map();
  for (const part of String(env.SPOT_PARTNER_CLIENTS || "").split(",")) {
    const [id, n] = part.trim().split(":");
    const lim = parseInt(n ?? "1000", 10);
    if (id && /^[A-Za-z0-9._\-]{1,64}$/.test(id) && Number.isFinite(lim) && lim > 0) out.set(id.toLowerCase(), lim);
  }
  return out;
}

async function parseSpotQuery(req, url) {
  const errors = []; // [{ field, problem }] — first one is reported
  const p = url.searchParams;
  // Aliases (0.6.3): endpoint/endpoint_url/target/resource/uri map to url; claimed_price_usd/price/price_usd map to claimed_price.
  const first = (src, names) => { for (const n of names) { const v = typeof src.get === "function" ? src.get(n) : src[n]; if (v !== null && v !== undefined && v !== "") return v; } return null; };
  let urlParam = first(p, SPOT_URL_ALIASES);
  let task = p.get("task");
  let claimed = first(p, SPOT_PRICE_ALIASES);
  let clientRaw = p.get("client");
  let refRaw = p.get("ref");
  let body = {};
  if (req.method === "POST") {
    let t = "";
    try {
      t = await req.text();
      if (t) body = JSON.parse(t);
    } catch (_) {
      errors.push({ field: "body", problem: 'Invalid JSON body (send {"url":"..."} with content-type application/json)' });
      body = {};
    }
    if (t && (!body || typeof body !== "object" || Array.isArray(body)) && !errors.length)
      errors.push({ field: "body", problem: 'JSON body must be an object like {"url":"..."}' });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  if (!urlParam) urlParam = first(body, SPOT_URL_ALIASES);
  if (!task && body.task) task = body.task;
  if (claimed === null || claimed === "") claimed = first(body, SPOT_PRICE_ALIASES);
  if (!clientRaw && body.client) clientRaw = body.client;
  if (!refRaw && body.ref) refRaw = body.ref;
  const target = urlParam ? String(urlParam).trim().slice(0, 2000) : "";
  if (!target) {
    const unknown = [...new Set([...p.keys(), ...Object.keys(body)])].filter((k) => !SPOT_KNOWN_PARAMS.has(k));
    errors.push({ field: "url", problem: unknown.length ? `Missing "url" (unknown param "${String(unknown[0]).slice(0, 40).replace(/[^\x20-\x7e]/g, "")}"; use "url")` : 'Missing "url"' });
  } else {
    let u = null;
    try { u = new URL(target); } catch (_) { u = null; }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname)
      errors.push({ field: "url", problem: 'Invalid "url": must be a full http(s) URL' });
  }
  let claimed_price = null;
  if (claimed !== null && claimed !== undefined && claimed !== "") {
    claimed_price = Number(claimed);
    if (!Number.isFinite(claimed_price) || claimed_price < 0) errors.push({ field: "claimed_price", problem: 'Invalid "claimed_price": must be a non-negative USD number like 0.01' });
  }
  const client = clientRaw && /^[A-Za-z0-9._\-]{1,64}$/.test(String(clientRaw)) ? String(clientRaw).toLowerCase() : null;
  if (clientRaw && !client) errors.push({ field: "client", problem: 'Invalid "client": 1-64 letters, digits, dot, dash, underscore' });
  const ref = refRaw && /^[A-Za-z0-9._\-]{1,64}$/.test(String(refRaw)) ? String(refRaw).toLowerCase() : "";
  const taskSlug = task ? String(task).toLowerCase().trim().slice(0, 64) : null;
  const payToRaw = p.get("pay_to") || body.pay_to || null;
  const pay_to = payToRaw ? String(payToRaw).trim().slice(0, 100) : null;
  if (pay_to && !/^[A-Za-z0-9]{20,100}$/.test(pay_to)) errors.push({ field: "pay_to", problem: 'Invalid "pay_to": the wallet you expect to pay (0x... or base58)' });
  const netRaw = p.get("network") || body.network || null;
  const network = netRaw ? String(netRaw).trim().slice(0, 80) : null;
  if (network && !/^[A-Za-z0-9:_\-]{2,80}$/.test(network)) errors.push({ field: "network", problem: 'Invalid "network": a CAIP-2 id like eip155:8453' });
  let methodRaw = p.get("method") || body.method || "GET";
  const method = String(methodRaw).toUpperCase();
  if (!["GET", "POST"].includes(method)) errors.push({ field: "method", problem: 'Invalid "method": GET or POST (how to probe the target)' });
  // 0.13.0: mode=dry-run (or ref=dry-run-<caller>) = free dry run: never signed or paid, always stored as a receipt.
  const modeRaw = String(p.get("mode") || body.mode || "").trim().toLowerCase();
  if (modeRaw && !["dry-run", "live"].includes(modeRaw)) errors.push({ field: "mode", problem: 'Invalid "mode": dry-run (free, nothing signed or paid, stored as a receipt) or live (default)' });
  const mode = modeRaw === "dry-run" || /^dry-run-/.test(ref) ? "dry-run" : "live";
  const dry_caller = /^dry-run-./.test(ref) ? ref.slice("dry-run-".length) : null;
  return { url: target, task: taskSlug, claimed_price, client, ref, method, pay_to, network, mode, dry_caller, errors };
}

// Paid spot-check price: one tenth of the target's quoted x402 price, min $0.01, cap $0.25 (no quote -> $0.01).
export function spotDynCfg(c, quotedUsd) {
  const q = Number(quotedUsd);
  let atomic = Number.isFinite(q) && q > 0 ? Math.round((q * 1e6) / 10) : 10000;
  atomic = Math.min(250000, Math.max(10000, atomic));
  return { ...c, priceAtomic: String(atomic), priceUsd: (atomic / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") };
}
// Free-tier reason: names the loss in plain words; quoted price, claimed-vs-quoted detail and pay-to stay behind the 402.
export function spotLossReason(d, claimed) {
  const listed = claimed !== null && claimed !== undefined && claimed !== "" ? `listed $${Number(claimed)}` : "price unlisted";
  const what = {
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
  }[d.reason] || d.reason;
  if (d.reason === "free_trial_active" && d.free_trial_remaining != null) return `${listed}, ${what} (${d.free_trial_remaining} trial calls left), details locked`;
  if (d.reason === "price_ok" && listed === "price unlisted") return "payment request found, pass claimed_price to compare, details locked";
  return `${listed}, ${what}, details locked`;
}

async function handleEndpointSpotCheck(req, env, ctx, url, probeOpts = {}) {
  const c = spotCfg(env);
  const resourceUrl = url.origin + url.pathname.replace(/\/+$/, "");
  const q = await parseSpotQuery(req, url);
  const qLike = { client: q.client, payer: null, errors: q.errors, task: q.task, endpoint: q.url, max_price: q.claimed_price, n: 1, limit: 1, ref: q.ref };
  const cid = await clientId(req, qLike, env);
  const ua = req.headers.get("user-agent") || "";
  const referer = refererHost(req);
  const spotExcluded = exclusion(req, { ...qLike, url: q.url }, env, url); // same self/uptime/crawler/bot filter as /v1/lookup

  if (q.errors.length) {
    writePoint(env, dataPoint({ product: "spot", cid, q: qLike, excluded: spotExcluded, candidates: 0, ua, returnedPayTo: [], status: 400, referer, access: "spot-bad-params" }));
    return json(spotBadRequest(API_ORIGIN, q.errors[0].field, q.errors[0].problem), 400);
  }

  const listing = await listingForAsync(env, q.url);
  const exp = {
    claimed: q.claimed_price !== null ? q.claimed_price : listing && listing.claimed_price_usd != null ? Number(listing.claimed_price_usd) : null,
    pay_to: q.pay_to || (listing && listing.listed_pay_to) || null,
    network: q.network || (listing && listing.listed_network) || null,
    source: q.pay_to || q.network || q.claimed_price !== null ? "request" : listing ? "listing" : null,
  };
  const selfChecked = isExempt(qLike, env);
  const checkType = selfChecked ? "self-checked" : "dry-run";
  const buildResult = async (probe, access) => {
    const pm0 = pickPayment(probe, exp);
    const d = applyNoTermsListing(applyPayment(applyExpected(decideVerdict(probe, exp.claimed), probe, exp), pm0, exp), probe, q, listing);
    const pm = d.verdict === "pay" ? pm0 : null; // only a "pay" verdict approves terms
    const termsHash = await termsSha256(pm);
    const payment = paymentObject(pm, pr.probedAt);
    const rid = env.RECEIPTS_DB ? newReceiptId() : null;
    const receiptFields = { receipt_id: rid, receipt_url: rid ? CANON_ORIGIN + "/v1/receipts/" + rid : null };
    if (rid) {
      const rec = buildLiveReceipt({ id: rid, origin: CANON_ORIGIN, url: q.url, method: q.method, probe, d, reasonText: spotLossReason(d, exp.claimed).replace(/, details locked$/, ""), pm: payment, termsHash, exp, ref: q.ref, caller: selfChecked ? "self-test" : null, checkType, probedAt: pr.probedAt, cached: pr.cached, normKey: pr.key });
      await saveLiveReceipt(env, rec); // awaited: the next call's cache lookup must see it
    }
    // Free tier: verdict + plain reason + a hash of the approved terms (enough for x402-spotcheck to refuse a
    // different payment); the terms themselves, quoted/claimed price and pay-to are behind the paid 402.
    if (access && access.tier === "free") return { verdict: d.verdict, reason: spotLossReason(d, exp.claimed), payment_terms_sha256: termsHash, ...receiptFields, prior_checks: PRIOR_CHECKS, access };
    const acc = Array.isArray(probe.accepts) ? probe.accepts.find((a) => a && a.payTo) : null;
    return {
      verdict: d.verdict,
      reason: d.reason,
      quoted_price_usd: probe.quoted_price_usd == null ? null : probe.quoted_price_usd,
      claimed_price_usd: exp.claimed,
      pay_to: (acc && acc.payTo) || probe.pay_to || null,
      network: (acc && acc.network) || null,
      asset: (acc && acc.asset) || null,
      expected_pay_to: exp.pay_to,
      expected_network: exp.network,
      expected_source: exp.source,
      payment,
      payment_terms_sha256: termsHash,
      probe: { probed_at: pr.probedAt, cached: pr.cached, cache_ttl_s: SPOT_PROBE_CACHE_S },
      check_type: checkType,
      ...(d.reason === "free_trial_active" ? { free_trial_remaining: d.free_trial_remaining ?? null } : {}),
      ...receiptFields,
      access,
    };
  };

  let cd = c; // per-request priced config, set after the probe
  const deny = (error, used, kind = "payment-required", payer = "") => {
    const body = spotPaymentRequired(cd, resourceUrl, error, used, q.url || "");
    body.pricing = typeof isRouter !== "undefined" && isRouter
      ? "router tier: $0.001 per check, billed per pack of checks in one settlement"
      : "one tenth of this endpoint's quoted x402 price, minimum $0.01, cap $0.25";
    writePoint(env, dataPoint({ product: "spot", cid, q: qLike, excluded: spotExcluded, candidates: 0, ua, returnedPayTo: [], status: 402, referer, access: kind, freeUsed: used, paidBy: payer, failReason: kind === "payment-failed" ? error : "" }));
    return json(body, 402, { "payment-required": b64encode(body) });
  };

  // Early SSRF gate (no fetch for blocked literals/hosts): run probe only after access.
  // Import assertSafeUrl inline via spotProbe short-circuit — call with a fake that never fetches? 
  // Use spotProbe only after access; for SSRF-literal hosts spotProbe returns before fetch.
  // To avoid paying then discovering SSRF: pre-check with assertSafeUrl by probing with resolve that we already have.
  // Cheap pre-check: call spotProbe — if ssrf_blocked and no http_status and latency null-ish from immediate block, return 400 without quota.
  // Problem: safe URLs would be fetched twice if we pre-probe. So import assertSafeUrl.
  const safe = await assertSafeUrl(q.url, probeOpts);
  if (!safe.ok) {
    writePoint(env, dataPoint({ product: "spot", cid, q: qLike, excluded: spotExcluded, candidates: 0, ua, returnedPayTo: [], status: 400, referer, access: "spot-ssrf" }));
    return json({
      verdict: "skip",
      reason: "ssrf_blocked",
      quoted_price_usd: null,
      claimed_price_usd: q.claimed_price,
    }, 400);
  }

  if (q.mode === "dry-run") return spotDryRun(req, env, url, q, qLike, exp, listing, probeOpts, { cid, ua, referer, c });

  const pr = await getProbe(env, q, probeOpts);
  const probe = pr.probe;
  cd = spotDynCfg(c, probe.quoted_price_usd);
  let access;
  const extraHeaders = {};
  let freeUsed = null;

  const partnerLimit = q.client ? spotPartners(env).get(q.client) : undefined;
  const rcfg = spotRouterCfg(env);
  const isRouter = !!(q.client && rcfg.ids.has(q.client) && !isExempt(qLike, env));
  let partner = null;
  if (partnerLimit && !isExempt(qLike, env)) {
    partner = await takeFree(env, "partner:" + q.client, partnerLimit, new Date(), "take", SPOT_PARTNER_COUNTER, "all");
    if (!partner.free) partner = null;
  }
  if (isExempt(qLike, env)) {
    access = { tier: "exempt", note: "our own self-test client: not metered for free quota (SSRF rules still apply)" };
  } else if (partner) {
    access = {
      tier: "partner",
      note: "first-router program: full checks free from a one-time pool, then the normal 1 free/day + x402 price",
      partner_free_total: partnerLimit,
      partner_used: partner.used,
      partner_remaining: partner.used === null ? null : Math.max(0, partnerLimit - partner.used),
    };
  } else {
    const key = await quotaKey(req, qLike, env);
    const t = await takeFree(env, key, c.freePerDay, new Date(), "take", SPOT_QUOTA_COUNTER);
    freeUsed = t.used;
    if (t.free) {
      access = {
        tier: "free",
        free_per_day: c.freePerDay,
        free_used_today: t.used,
        free_remaining_today: t.used === null ? null : Math.max(0, c.freePerDay - t.used),
        then: `$${cd.priceUsd} USDC on Base for the full check of this endpoint via x402 (HTTP 402)`,
      };
    } else {
      const hdr = paymentHeader(req);
      if (isRouter && !hdr) {
        const sp = await routerCredits(env, q.client, "spend");
        if (sp.ok) {
          access = { tier: "router-prepaid", price_per_check_usd: rcfg.perCheckAtomic / 1e6, credits_remaining: sp.balance, note: "router tier: prepaid checks from your last pack" };
          writePoint(env, dataPoint({ product: "spot", cid, q: qLike, excluded: spotExcluded, candidates: 1, ua, returnedPayTo: [], status: 200, referer, access: "router-prepaid", freeUsed: t.used }));
          return json(await buildResult(probe, access), 200, extraHeaders);
        }
      }
      if (isRouter) {
        const usd = (rcfg.packAtomic / 1e6).toString();
        cd = { ...cd, priceAtomic: String(rcfg.packAtomic), priceUsd: usd };
        if (!hdr) {
          const res = deny(`Router tier: $${usd} USDC on Base buys ${Math.floor(rcfg.packAtomic / rcfg.perCheckAtomic)} checks ($${rcfg.perCheckAtomic / 1e6}/check): this one now, the rest prepaid for your next calls with client=${q.client}.`, t.used, "payment-required");
          return res;
        }
      }
      if (!hdr) return deny(`Free 402xAgent checks used up for today (${c.freePerDay} per UTC day). Pay $${cd.priceUsd} USDC on Base via x402 to continue.`, t.used, "payment-required");
      const payload = decodePaymentHeader(hdr);
      if (!payload) return deny("payment header is not valid base64 JSON x402 payload", t.used, "payment-failed");
      {
        // Price race guard: if the target's quote moved between our 402 and the retry, accept any signed amount
        // between the current dynamic price and the $0.25 cap instead of rejecting the buyer.
        const amt = String((payload.accepted || {}).amount ?? ((payload.payload || {}).authorization || {}).value ?? "");
        if (!isRouter && /^[0-9]{1,12}$/.test(amt) && Number(amt) >= Number(cd.priceAtomic) && Number(amt) <= 250000) cd = { ...cd, priceAtomic: amt, priceUsd: (Number(amt) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") };
      }
      const bad = checkPayload(payload, cd);
      if (bad) return deny("payment rejected: " + bad, t.used, "payment-failed", signerOf(payload));
      // Rate-limit paid checks by payer (from payment payload) before settle.
      const authFrom = ((payload.payload && payload.payload.authorization) || {}).from || "";
      const payerKey = /^0x[0-9a-fA-F]{40}$/.test(authFrom) ? "p:" + authFrom.toLowerCase() : "c:" + (q.client || cid.id);
      const rl = await takeFree(env, payerKey, c.paidPerHour, new Date(), "take", SPOT_RATE_COUNTER, utcHour());
      if (!rl.free) {
        writePoint(env, dataPoint({ product: "spot", cid, q: qLike, excluded: spotExcluded, candidates: 0, ua, returnedPayTo: [], status: 429, referer, access: "spot-rate-limited", freeUsed: t.used }));
        return json({
          error: `paid 402xAgent check rate limit: ${c.paidPerHour} per hour per payer`,
          product: SPOT_ID,
          retry_after_hint: "wait until the next UTC hour",
        }, 429);
      }
      const r = await verifyAndSettle(cd, payload, resourceUrl, {
        paidPath: false,
        description: `${SPOT_SERVICE_NAME}: one probe. $${cd.priceUsd} USDC on Base.`,
      });
      if (!r.ok) return deny("payment rejected: " + r.reason, t.used, "payment-failed", signerOf(payload));
      const enc = b64encode(r.settle);
      extraHeaders["payment-response"] = enc;
      extraHeaders["x-payment-response"] = enc;
      access = {
        tier: "paid",
        charged_usd: cd.priceUsd,
        asset: "USDC on Base",
        tx: r.settle.transaction,
        basescan_url: "https://basescan.org/tx/" + r.settle.transaction,
        payer: r.settle.payer || null,
      };
      freeUsed = t.used;
      const selfPaid = String(r.settle.payer || authFrom || "").toLowerCase() === c.payTo.toLowerCase();
      if (selfPaid) access.self_test = true;
      if (isRouter) {
        const n = Math.floor(Number(cd.priceAtomic) / rcfg.perCheckAtomic) - 1;
        const cr = await routerCredits(env, q.client, "credit", n);
        access.tier = "router-pack";
        access.price_per_check_usd = rcfg.perCheckAtomic / 1e6;
        access.credits_added = n;
        access.credits_remaining = cr.balance;
      }
      writePoint(env, dataPoint({ product: "spot", cid, q: qLike, excluded: selfPaid ? "self" : spotExcluded, candidates: 1, ua, returnedPayTo: [], status: 200, referer, access: "paid", amountUsd: Number(cd.priceUsd), tx: r.settle.transaction, paidBy: r.settle.payer, freeUsed }));
      return json(await buildResult(probe, access), 200, extraHeaders);
    }
  }

  writePoint(env, dataPoint({ product: "spot", cid, q: qLike, excluded: isExempt(qLike, env) ? "self" : spotExcluded, candidates: 1, ua, returnedPayTo: [], status: 200, referer, access: access.tier === "partner" ? "partner" : access.tier, freeUsed: partner ? partner.used : freeUsed }));
  return json(await buildResult(probe, access), 200, extraHeaders);
}

// 0.13.0 dry run. Abuse guard: (1) capped per caller and per IP hash per UTC day; (2) the answer is the free-tier shape
// (verdict + plain-words reason) with payment_terms_sha256 always null and no payment object, so a dry run can never
// stand in for an approval (x402-spotcheck and the router hooks need the hash / payment terms from a live check).
// The full live terms go only into the public receipt, as for every live check.
async function spotDryRun(req, env, url, q, qLike, exp, listing, probeOpts, { cid, ua, referer, c }) {
  const point = (status, access) => {
    const dp = dataPoint({ product: "spot", cid, q: qLike, excluded: "dry-run", candidates: 0, ua, returnedPayTo: [], status, referer, access });
    dp.doubles[0] = 0;
    writePoint(env, dp);
  };
  const exempt = isExempt(qLike, env);
  const ipKey = await quotaKey(req, { ...qLike, client: null }, env);
  const callerKey = q.ref ? "r:" + q.ref : q.client && q.client !== MCP_CLIENT ? "c:" + q.client : ipKey;
  let cap = { free: true, used: null };
  if (!exempt) {
    cap = await takeFree(env, "dry:" + callerKey, c.dryPerDay, new Date(), "take", SPOT_DRY_COUNTER);
    if (cap.free) {
      const ipCap = await takeFree(env, "dryip:" + ipKey, c.dryPerIpDay, new Date(), "take", SPOT_DRY_COUNTER);
      if (!ipCap.free) cap = { free: false, used: ipCap.used, ip: true };
    }
  }
  if (!cap.free) {
    point(429, "dry-run-capped");
    return json({
      error: cap.ip ? `dry-run limit: ${c.dryPerIpDay} per UTC day from one network` : `dry-run limit: ${c.dryPerDay} per caller per UTC day`,
      product: SPOT_ID,
      mode: "dry-run",
      resets: "00:00 UTC",
      live_check: API_ORIGIN + "/v1/products/endpoint-spot-check?url=" + encodeURIComponent(q.url),
    }, 429, { "cache-control": "no-store" });
  }
  if (!env.RECEIPTS_DB) { point(503, "dry-run-no-store"); return json({ error: "dry runs are always stored as receipts; the receipt store is unavailable, try again shortly", mode: "dry-run" }, 503); }
  const pr = await getProbe(env, q, probeOpts);
  const probe = pr.probe;
  const d = applyNoTermsListing(applyPayment(applyExpected(decideVerdict(probe, exp.claimed), probe, exp), pickPayment(probe, exp), exp), probe, q, listing);
  const rid = newReceiptId();
  const reason = spotLossReason(d, exp.claimed).replace(/, details locked$/, "");
  const rec = buildLiveReceipt({ id: rid, origin: CANON_ORIGIN, url: q.url, method: q.method, probe, d, reasonText: reason, pm: null, termsHash: null, exp, checkType: exempt ? "self-checked" : "dry-run", mode: "dry-run", ref: q.ref, caller: q.dry_caller || (exempt ? "self-test" : null), probedAt: pr.probedAt, cached: pr.cached, normKey: pr.key });
  if (!(await saveLiveReceipt(env, rec))) { point(503, "dry-run-store-failed"); return json({ error: "dry runs are always stored as receipts; storing failed, try again shortly", mode: "dry-run" }, 503); }
  point(200, "dry-run");
  return json({
    mode: "dry-run",
    check_type: exempt ? "self-checked" : "dry-run",
    verdict: d.verdict,
    reason,
    payment_terms_sha256: null,
    receipt_id: rid,
    receipt_url: CANON_ORIGIN + "/v1/receipts/" + rid,
    prior_checks: PRIOR_CHECKS,
    access: {
      tier: exempt ? "dry-run-exempt" : "dry-run",
      dry_runs_per_day: c.dryPerDay,
      dry_runs_used_today: cap.used,
      dry_runs_remaining_today: cap.used === null ? null : Math.max(0, c.dryPerDay - cap.used),
      note: "Free dry run: nothing signed or paid, not an approval to pay (no payment terms hash). Live terms are in the public receipt.",
    },
  }, 200, { "cache-control": "no-store" });
}

export function paymentRequired(c, url, error, used) {
  const resource = url.toString();
  return {
    x402Version: 2,
    error: error + FREE_CHECK_LINE,
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
    free_check: freeCheckField(),
    payment_policy: PAYMENT_POLICY,
    how_to_pay:
      "Retry the same request with a PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT is also accepted) holding a signed USDC EIP-3009 authorization for the amount and payTo above. Settled through a public x402 facilitator; the settlement tx comes back in the PAYMENT-RESPONSE header and the body's access block.",
    ...hintFields(CANON_ORIGIN),
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
export async function verifyAndSettle(c, payload, url, paidPathOrOpts = false) {
  const v = Number(payload.x402Version || 1);
  const body = { x402Version: v, paymentPayload: payload, paymentRequirements: paymentRequirements(c, url.toString(), v, paidPathOrOpts) };
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
// 0.19.0: the wallet that signed an x402 payload (EIP-3009 authorization.from), for payment-failed analytics. "" if none.
export function signerOf(payload) {
  try {
    const f = String(((payload && payload.payload && payload.payload.authorization) || {}).from || "");
    return /^0x[0-9a-fA-F]{40}$/.test(f) ? f.toLowerCase() : "";
  } catch (_) {
    return "";
  }
}
export function refererHost(req) {
  try {
    return new URL(req.headers.get("referer") || "").hostname.slice(0, 100);
  } catch (_) {
    return "";
  }
}

// access: free | paid | exempt | payment-required | payment-failed | "" (request rejected before the quota)
export function dataPoint({ cid, q, excluded, candidates, ua, returnedPayTo, status, referer = "", access = "", amountUsd = 0, tx = "", paidBy = "", freeUsed = null, product = "", failReason = "" }) {
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
      String(paidBy || "").toLowerCase().slice(0, 64), // blob15 paying wallet (paid: from the facilitator; payment-failed: the signer, 0.19.0)
      String(product || "").slice(0, 32), // blob16 product/route (0.19.0): spot | lookup | lookup-paid | pack | mcp | view
      String(failReason || "").slice(0, 160), // blob17 why a signed payment failed (payment-failed only, 0.19.0)
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
    metered: "/v1/lookup after the free quota; /v1/lookup/paid always (same results); /v1/products/overnight-cos-pack always $9 USDC; /v1/products/endpoint-spot-check 1 free/day then $0.01 to $0.25 USDC (one tenth of the target's quoted price). /mcp, /v1/tasks, /openapi.json, /health are free (MCP lookup shares vc-mcp quota; get_overnight_cos_pack paid; endpoint_spot_check shares the 402xAgent check quota)",
  };
}

export function openapi(origin, env = {}) {
  const c = cfg(env);
  return {
    openapi: "3.1.0",
    info: {
      title: "402xAgent: x402 pre-payment checks + verified catalog",
      version: VERSION,
      contact: { url: "https://github.com/withgrokbot/verified-catalog/issues" },
      "x-guidance": `Ask GET /v1/lookup?task=<task>&max_price=<usd> (task names: /v1/tasks). ${c.freePerDay} free calls per client per UTC day, then the same path answers 402; /v1/lookup/paid is the always-paid twin ($${c.priceUsd} USDC on Base via x402) with identical results. Products: GET /v1/products/overnight-cos-pack ($9 USDC); GET /v1/products/endpoint-spot-check (1 free/day then $0.01 to $0.25 USDC (one tenth of the target's quoted price), SSRF-safe x402 probe). Free MCP: POST /mcp.`,
      description:
        `Start free: GET ${FREE_CHECK_URL} (1 free check per client per UTC day; free dry runs with &mode=dry-run). Real example: GET ${FREE_CHECK_EXAMPLE_URL} -> ${JSON.stringify(FREE_CHECK_EXAMPLE)}. Prior checks: ${PRIOR_CHECKS}. Then, only for the full payment terms: the paid check (HTTP 402, $0.01 to $0.25 USDC on Base via x402). ` +
        `Also: is an x402 endpoint reliable for task X at price <= Y? Facts from our own paid calls: receipts with settlement tx, delivered yes/no and a known-answer pass/fail. Pricing: ${c.freePerDay} free lookups per client per UTC day, then HTTP 402 with an x402 payment requirement of $${c.priceUsd} USDC on Base per lookup. ${PAYMENT_POLICY} Not investment advice; we hold no customer funds.`,
    },
    servers: [API_ORIGIN, CANON_ORIGIN, LEGACY_ORIGIN].map((u) => ({ url: u, description: u === API_ORIGIN ? "402xAgent API (canonical)" : u === CANON_ORIGIN ? "402xAgent (same API on the apex)" : "legacy host (same Worker, still supported; older hosts keep answering API calls too)" })),
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
      "/v1/products/overnight-cos-pack": {
        get: {
          operationId: "getOvernightCosPack",
          summary: "Overnight Chief of Staff Setup Pack: prompts, HTML template, and PDF guide ($9 USDC on Base via x402, always paid)",
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: packCfg(env).priceUsd },
            protocols: [{ x402: { scheme: "exact", network: packCfg(env).network, asset: USDC_BASE, payTo: packCfg(env).payTo } }],
          },
          responses: {
            200: { description: "JSON with product, title, price_usdc, files.prompts, files.templates, files.guide (PDF base64), access/settlement" },
            402: { description: "x402 v2 payment requirement ($9 USDC on Base) with Bazaar discovery metadata for the Overnight CoS Setup Pack" },
          },
        },
        post: {
          operationId: "getOvernightCosPackPost",
          summary: "Same as GET /v1/products/overnight-cos-pack (POST accepted for discovery probes)",
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: packCfg(env).priceUsd },
            protocols: [{ x402: { scheme: "exact", network: packCfg(env).network, asset: USDC_BASE, payTo: packCfg(env).payTo } }],
          },
          responses: {
            200: { description: "same as GET" },
            402: { description: "same as GET" },
          },
        },
      },
      "/v1/products/endpoint-spot-check": {
        get: {
          operationId: "endpointSpotCheck",
          summary: "Decision-shaped 402xAgent check: probe a public URL for PAYMENT-REQUIRED (never pays the target). Returns verdict/reason/quoted vs claimed. 1 free/client/UTC day, then $0.01-$0.25 (one tenth of the target quote) USDC on Base",
          parameters: [
            { name: "url", in: "query", required: true, schema: { type: "string" }, description: "public http(s) URL to probe" },
            { name: "task", in: "query", schema: { type: "string" } },
            { name: "claimed_price", in: "query", schema: { type: "number" }, description: "optional claimed USD price to compare against quoted challenge" },
            { name: "method", in: "query", schema: { type: "string", enum: ["GET", "POST"], default: "GET" }, description: "how to probe the target (POST sends an empty JSON body; for POST-only x402 endpoints)" },
            { name: "pay_to", in: "query", schema: { type: "string" }, description: "optional wallet you expect to pay (from your listing); a 402 paying elsewhere is skip/pay_to_mismatch. Defaults to the listing in our crawl when we have one" },
            { name: "network", in: "query", schema: { type: "string" }, description: "optional CAIP-2 network you expect (e.g. eip155:8453); a 402 on another network is skip/network_mismatch" },
            { name: "client", in: "query", schema: { type: "string" } },
            { name: "ref", in: "query", schema: { type: "string" }, description: "attribution tag, stored on the receipt; ref=dry-run-<caller> sets mode=dry-run" },
            { name: "mode", in: "query", schema: { type: "string", enum: ["live", "dry-run"], default: "live" }, description: "free dry run: one unpaid probe, nothing signed or paid, always stored as a public receipt (check_type dry-run). Returns the free-tier shape with payment_terms_sha256 null (never an approval). 50 per caller (ref, else client, else IP) per UTC day. ref=dry-run-<caller> also sets it" },
          ],
          "x-payment-info": {
            price: { mode: "dynamic", currency: "USD", min: "0.01", max: "0.25", rule: "one tenth of the target endpoint's quoted x402 price" },
            protocols: [{ x402: { scheme: "exact", network: spotCfg(env).network, asset: USDC_BASE, payTo: spotCfg(env).payTo } }],
          },
          responses: {
            200: { description: "No 402 terms is skip/no_paywall (recheck/free_trial_active when the target sends x-free-trial headers); recheck only for timeouts, 5xx and network errors; wrong or unsupported network, non-canonical USDC or a pay_to that differs from the listing is skip. The same normalized URL + method reuses one probe for 5 min, so consecutive calls agree. Free tier: verdict (pay|skip|recheck), a plain-words reason, access. Paid tier: verdict, reason code, quoted_price_usd, claimed_price_usd, pay_to, network, asset, payment (the exact signable payment when verdict is pay), payment_terms_sha256, access (with settlement tx). Free tier also carries payment_terms_sha256", content: { "application/json": { schema: { oneOf: [SPOT_PAID_SCHEMA, SPOT_FREE_SCHEMA] }, examples: { paid: { value: SPOT_PAID_EXAMPLE }, free: { value: SPOT_FREE_EXAMPLE } } } } },
            400: { description: "bad params, or SSRF-blocked URL as verdict=skip reason=ssrf_blocked (no fetch)" },
            402: { description: "free quota used: x402 v2 payment requirement ($0.01 to $0.25 USDC (one tenth of the target's quoted price) on Base)" },
            429: { description: "paid rate limit (per payer per UTC hour)" },
          },
        },
        post: {
          operationId: "endpointSpotCheckPost",
          summary: "Same as GET /v1/products/endpoint-spot-check (JSON body may carry url, task, claimed_price, client, ref)",
          responses: {
            200: { description: "same as GET" },
            400: { description: "same as GET" },
            402: { description: "same as GET" },
          },
        },
      },
      "/v1/skips": {
        get: {
          operationId: "skips",
          security: [],
          summary: "Free: public page of self-checked x402 endpoints whose 402 disagrees with their listing (verdict skip). HTML; ?format=json or /v1/skips.json for JSON. Each row has an anchor #<id>.",
          responses: { 200: { description: "HTML or JSON list of skip receipts with totals and crawl time" } },
        },
      },
      "/v1/receipts/by-url": {
        get: {
          operationId: "receiptByUrl",
          security: [],
          summary: "Free: latest public receipt for a URL: latest_live (last live 402xAgent decision: live 402 terms, verdict, reason, timestamp, id) and latest_crawl (weekly self-checked crawl). A fresh live check is a paid 402xAgent check.",
          parameters: [{ name: "url", in: "query", required: true, schema: { type: "string" }, description: "the listing/endpoint URL exactly as checked" }],
          responses: { 200: { description: "receipts" }, 400: { description: "missing url" }, 404: { description: "no receipt for this url yet (check_now link included)" } },
        },
      },
      "/v1/receipts/{id}": {
        get: {
          operationId: "receiptById",
          security: [],
          summary: "Free: one receipt. sc-<16 hex> = a live 402xAgent decision (url, method, checked_at, verdict, reason, live_402 accepts, expected, approved_payment, payment_terms_sha256); 10-hex ids = weekly crawl receipts.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "receipt JSON" }, 404: { description: "unknown id" } },
        },
      },
      "/v1/receipts": {
        get: {
          operationId: "receipts",
          security: [],
          summary: "Free: every self-checked receipt (url, claimed_price_usd, quoted_price_usd, pay_to, verdict, reason, timestamp, source_list). /v1/receipts/{id} returns one receipt. With type=dry-run or type=live: stored 402xAgent decisions, newest first (url, listing, live_demand, verdict, reason, checked_at, check_type, ref), filter by ref, page with limit (1-100, default 20) and cursor (next_cursor).",
          parameters: [
            { name: "type", in: "query", schema: { type: "string", enum: ["dry-run", "live"] }, description: "list stored 402xAgent receipts of this type" },
            { name: "ref", in: "query", schema: { type: "string" }, description: "only receipts with this ref (e.g. dry-run-mybot)" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "cursor", in: "query", schema: { type: "string" }, description: "next_cursor from the previous page" },
          ],
          responses: { 200: { description: "JSON receipts" }, 400: { description: "bad type, ref or cursor" } },
        },
      },
      "/mcp": {
        post: {
          operationId: "mcp",
          security: [],
          summary: "Free remote MCP server (Streamable HTTP, stateless JSON-RPC 2.0): tools search_catalog, get_service, lookup, get_overnight_cos_pack, endpoint_spot_check (lookup shares vc-mcp quota; pack always paid; 402xAgent check 1 free/day then $0.01-$0.25 by target quote)",
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
      ...(access && access.tier === "free" ? { prior_checks: PRIOR_CHECKS } : {}),
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
  const excluded = exclusion(req, q, env, url);
  const ua = req.headers.get("user-agent") || "";
  const referer = refererHost(req);
  const c = cfg(env);
  if (!q.task && !q.endpoint) q.errors.push("task or endpoint is required (see /v1/tasks)");
  let data;
  try {
    data = await loadData(env, ctx);
  } catch (e) {
    writePoint(env, dataPoint({ product: "lookup", cid, q, excluded, candidates: 0, ua, returnedPayTo: [], status: 503, referer }));
    return json({ error: "catalog data unavailable, try again shortly" }, 503);
  }
  if (q.errors.length) {
    writePoint(env, dataPoint({ product: "lookup", cid, q, excluded, candidates: 0, ua, returnedPayTo: [], status: 400, referer }));
    return json({ error: q.errors.join("; "), tasks: Object.keys(taskIndex(data.catalog)).sort(), docs: CANON_ORIGIN + "/openapi.json", ...hintFields(CANON_ORIGIN) }, 400);
  }
  // The answer is computed before (and independently of) the access decision: payment never changes it.
  const out = lookup(data, q);
  const candidates = out.results.length + out.facts_only.length;
  const payTo = [...new Set(out.results.concat(out.facts_only).flatMap((r) => r.pay_to))];
  const point = (extra) => writePoint(env, dataPoint({ product: "lookup", cid, q, excluded, candidates, ua, returnedPayTo: payTo, referer, ...extra }));

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
      const deny = (error, kind, payer = "") => {
        const body = paymentRequired(c, url, error, t.used);
        point({ status: 402, access: kind, freeUsed: t.used, paidBy: payer, failReason: kind === "payment-failed" ? error : "" });
        return json(body, 402, { "payment-required": b64encode(body) });
      };
      if (!hdr) return deny(`Free lookups used up for today (${c.freePerDay} per UTC day). Pay $${c.priceUsd} USDC on Base via x402 to continue.`, "payment-required");
      const payload = decodePaymentHeader(hdr);
      if (!payload) return deny("payment header is not valid base64 JSON x402 payload", "payment-failed");
      const bad = checkPayload(payload, c);
      if (bad) return deny("payment rejected: " + bad, "payment-failed", signerOf(payload));
      const r = await verifyAndSettle(c, payload, url);
      if (!r.ok) return deny("payment rejected: " + r.reason, "payment-failed", signerOf(payload));
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
  const excluded = exclusion(req, q, env, url);
  const ua = req.headers.get("user-agent") || "";
  const referer = refererHost(req);
  const c = cfg(env);
  const resourceUrl = url.origin + url.pathname;
  let candidates = 0;
  let payTo = [];
  const point = (extra) => writePoint(env, dataPoint({ product: "lookup-paid", cid, q, excluded, candidates, ua, returnedPayTo: payTo, referer, ...extra }));
  const deny = (error, kind, payer = "") => {
    const body = paidPaymentRequired(c, resourceUrl, error);
    point({ status: 402, access: kind, paidBy: payer, failReason: kind === "payment-failed" ? error : "" });
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
    return json({ error: q.errors.join("; ") + " (nothing was charged)", tasks: Object.keys(taskIndex(data.catalog)).sort(), docs: CANON_ORIGIN + "/openapi.json", ...hintFields(CANON_ORIGIN) }, 400);
  }
  const out = lookup(data, q);
  candidates = out.results.length + out.facts_only.length;
  payTo = [...new Set(out.results.concat(out.facts_only).flatMap((r) => r.pay_to))];
  const payload = decodePaymentHeader(hdr);
  if (!payload) return deny("payment header is not valid base64 JSON x402 payload", "payment-failed");
  const bad = checkPayload(payload, c);
  if (bad) return deny("payment rejected: " + bad, "payment-failed", signerOf(payload));
  const r = await verifyAndSettle(c, payload, resourceUrl, true);
  if (!r.ok) return deny("payment rejected: " + r.reason, "payment-failed", signerOf(payload));
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
export const MCP_SERVER_INFO = { name: "402xagent", title: "402xAgent + verified x402 catalog", version: VERSION };
export const MCP_TOOLS = [
  {
    name: "search_catalog",
    description:
      "Browse or keyword-search the verified catalog of pay-per-call (x402) agent services. Use it when you don't " +
      "know the task name or want to see what exists; use lookup to rank endpoints for a known task at a max price, " +
      "and get_service for one id's full record. Read-only. No auth or API key; free, no quota or per-client limit: " +
      "it only reads the catalog snapshot (bundled catalog.json in the local server, the published catalog.json on " +
      "remote /mcp). Returns {count, results, generated_at, note, methodology_url}; results are in catalog order, " +
      "ungraded, each with id, name, category, endpoint, advertised_price_usd, page_url and latest (checked_at, " +
      "reachable, http_status, latency_ms, quoted_price_usd, price_matches_listing, charged_price_usd, " +
      "delivered_valid, raw_log_url). No match: count 0, empty results. A non-numeric max_price_usd or limit returns " +
      "an error.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional. Space-separated words; every word must appear (case-insensitive) in the service id, name, category, " +
            "description or provider. Omit to list all. Examples: \"search\", \"crypto news\".",
        },
        category: {
          type: "string",
          description:
            "Optional. Case-insensitive substring of the service category, e.g. \"web search\", \"news\", \"on-chain data\", " +
            "\"weather\", \"public records\", \"utility\".",
        },
        max_price_usd: {
          type: "number",
          minimum: 0,
          description: "Optional. Keep services whose advertised price per call is at or below this many USD, e.g. 0.01.",
        },
        reachable_only: {
          type: "boolean",
          default: false,
          description: "Optional (default false). If true, keep only services that were reachable in the latest check.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Optional. Maximum number of results, 1-100 (default 20).",
        },
      },
    },
    annotations: {
      title: "Search the x402 service catalog",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_service",
    description:
      "Fetch the complete catalog record for one known service id (e.g. from search_catalog or lookup results). Use " +
      "search_catalog to find ids and lookup to rank services for a task; get_service has no per-call receipts, so " +
      "for receipts with tx and Basescan links call lookup with endpoint=<id>. Read-only. No auth or API key; free, " +
      "no quota (reads the same catalog snapshot as search_catalog). Returns the record as published: id, name, " +
      "provider, category, description, endpoint, advertised_price (USD, atomic, asset, network), sample_request, " +
      "tasks, quality_test (known-answer test, facts_only flag and reason), paid_receipts (count), latest (full last " +
      "check incl. x402_challenge, error, raw_log_url), history_summary and page_url. Unknown or missing id: error " +
      "\"no service with id ...\".",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Exact, case-sensitive catalog service id as returned by search_catalog or lookup, e.g. \"exa-search\", " +
            "\"x402tap-weather\", \"onesource-erc20-balance\".",
        },
      },
      required: ["id"],
    },
    annotations: {
      title: "Get one catalog service record",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "lookup",
    description:
      "Rank x402 endpoints for a known task at or under a price: \"which endpoint should I pay for task X at <= $Y?\". " +
      "Prefer it over search_catalog (keyword browsing, unranked) and get_service (one id's raw record). No auth or " +
      "API key. Calls the hosted lookup service as client=vc-mcp; all MCP users share that client's 5 free lookups " +
      "per UTC day (reset 00:00 UTC), after which the tool returns an error reporting the HTTP 402 ($0.02 USDC on " +
      "Base via x402) and never pays. Returns results sorted by known-answer pass_rate over the last n paid calls, " +
      "then price, each with price_usd, pass_rate, last_check_at, last_check, stale and receipts (time, tx, " +
      "basescan_url, charged_usd, delivered, quality); seller-broken services come unsorted under facts_only. No " +
      "match: empty results, matched 0. Needs task or endpoint; invalid params return an error. Payment never " +
      "changes results.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Task name from /v1/tasks, e.g. web-search, crypto-news, news, weather, token-balance, sec-filings, fx-rates, " +
            "url-check. Case-insensitive; a known name matches exactly, an unknown one falls back to matching every word " +
            "in service text. Required unless endpoint is given.",
        },
        max_price_usd: {
          type: "number",
          minimum: 0,
          description:
            "Optional. Only services whose listed price per call is at or below this many USD, e.g. 0.01. Negative values " +
            "are rejected.",
        },
        n: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 5,
          description:
            "Optional. Most recent paid receipts per service used for pass_rate and returned, 1-20 (default 5; " +
            "out-of-range values are clamped).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 10,
          description: "Optional. Maximum ranked services in results, 1-20 (default 10; clamped). facts_only is not limited.",
        },
        endpoint: {
          type: "string",
          description:
            "A catalog service id (e.g. exa-search) or endpoint URL, to get one service's receipts instead of a whole " +
            "task. Required unless task is given; can be combined with task.",
        },
        payer: {
          type: "string",
          description:
            "Optional 0x wallet address (40 hex characters), recorded so a later payment from it to a returned vendor can " +
            "be matched on-chain. Nothing is charged; a malformed address returns an error.",
        },
      },
    },
    annotations: {
      title: "Rank x402 endpoints for a task and price",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "get_overnight_cos_pack",
    description:
      "Buy and download the Overnight Chief of Staff Setup Pack ($9 USDC on Base via x402): 5 ready-to-paste bot prompts, " +
      "an HTML morning-briefing template, and a PDF setup guide. Always paid — no free quota. " +
      "Call without PAYMENT-SIGNATURE to receive payment requirements and the HTTP endpoint URL. " +
      "Agents pay by retrying the HTTP endpoint (or this MCP call) with a PAYMENT-SIGNATURE header holding a signed USDC EIP-3009 authorization.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_receipt",
    description:
      "Free: read a public 402xAgent receipt. Give id (sc-... from endpoint_spot_check's receipt_id, or a 10-hex crawl id) or url " +
      "(latest live + crawl receipt for that URL). Receipts hold the listing URL, the live 402 terms, verdict, reason, timestamp. " +
      "Does not run a fresh check (use endpoint_spot_check for that).",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "receipt id" }, url: { type: "string", description: "endpoint URL exactly as checked" } } },
    annotations: { title: "Read a 402xAgent receipt", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "endpoint_spot_check",
    description:
      "Decision-shaped SSRF-safe 402xAgent check of a public URL for an x402 PAYMENT-REQUIRED / 402 challenge. " +
      "Free: verdict (pay|skip|recheck), a plain-words reason, payment_terms_sha256 (hash of the approved payment), and access. Paid: verdict, reason code, quoted/claimed price, pay_to, network, asset, and payment = the exact {network, asset, amount_atomic, amount_usd, pay_to} a router may sign (verdict pay only), plus access with the settlement tx. " +
      "No 402 terms is skip/no_paywall (recheck/free_trial_active when the target sends x-free-trial headers); recheck only for timeouts, 5xx and network errors; wrong or unsupported network, non-canonical USDC or a pay_to that differs from the listing is skip. The same normalized URL + method reuses one probe for 5 min, so consecutive calls agree. " +
      "mode=dry-run: free dry run (nothing signed or paid, stored as a public receipt, no approval hash, 50/caller/day). " +
      "Never pays the target (probe GET only). 1 free check per client per UTC day (client=vc-mcp), then $0.01 to $0.25 USDC (one tenth of the target's quoted price) on Base via x402. " +
      "Unpaid after free quota: payment instructions. Forward PAYMENT-SIGNATURE for a paid check.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "public http(s) URL to probe" },
        task: { type: "string", description: "optional task label (ignored in decision output)" },
        claimed_price: { type: "number", description: "optional claimed USD price to compare vs quoted" },
        method: { type: "string", enum: ["GET", "POST"], description: "optional: probe the target with POST (empty JSON body) for POST-only endpoints" },
        pay_to: { type: "string", description: "optional: the wallet you expect to pay (from your listing)" },
        network: { type: "string", description: "optional: the CAIP-2 network you expect, e.g. eip155:8453" },
        mode: { type: "string", enum: ["live", "dry-run"], description: "optional: dry-run = free dry run: one unpaid probe, nothing signed or paid, always stored as a public receipt (check_type dry-run). Returns the free-tier shape with payment_terms_sha256 null (never an approval). 50 per caller (ref, else client, else IP) per UTC day. ref=dry-run-<caller> also sets it" },
        ref: { type: "string", description: "optional attribution tag stored on the receipt (dry-run-<caller> sets mode=dry-run)" },
      },
      required: ["url"],
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
    if (!["search_catalog", "get_service", "lookup", "get_overnight_cos_pack", "endpoint_spot_check", "get_receipt"].includes(name)) throw new RpcError(-32601, `unknown tool ${name === undefined ? "None" : `'${name}'`}`);
    let data;
    try {
      if (name === "get_receipt") {
        let path, u;
        if (args.id) { path = "/v1/receipts/" + encodeURIComponent(pyStr(args.id)); u = new URL(origin + path); }
        else if (args.url) { path = "/v1/receipts/by-url"; u = new URL(origin + path + "?url=" + encodeURIComponent(pyStr(args.url))); }
        else return err("give id or url");
        const r = /^\/v1\/receipts\/(by-url|sc-)/.test(path) ? await handleLiveReceipts(req, env, u, decodeURIComponent(path)) : await handleReceipts(u, env);
        const body = await r.json();
        if (r.status !== 200) return err((body && body.error) || "HTTP " + r.status);
        data = body;
      } else if (name === "endpoint_spot_check") {
        if (!args.url) return err("url is required");
        const qp = new URLSearchParams({ client: MCP_CLIENT, url: pyStr(args.url) });
        if (args.task) qp.set("task", pyStr(args.task));
        for (const k of ["method", "pay_to", "network", "mode", "ref"]) if (args[k]) qp.set(k, pyStr(args[k]));
        if (!blank(args.claimed_price)) {
          const d = decStr(args.claimed_price);
          if (d === null) return err("claimed_price must be a number");
          qp.set("claimed_price", d);
        }
        const u = new URL(origin + "/v1/products/endpoint-spot-check?" + qp.toString());
        const headers = { accept: "application/json", "user-agent": "verified-catalog-mcp/0.6" };
        const pay = paymentHeader(req);
        if (pay) headers["payment-signature"] = pay;
        const ip = req.headers.get("cf-connecting-ip");
        if (ip) headers["cf-connecting-ip"] = ip;
        const r = await handleEndpointSpotCheck(new Request(u, { method: "GET", headers }), env, ctx, u);
        let body = null;
        try { body = await r.json(); } catch (_) { body = null; }
        if (r.status === 200) {
          data = body;
        } else if (r.status === 402) {
          const freeLeft = body && body.free_per_day != null ? Math.max(0, (body.free_per_day || 0) - (body.free_used_today || 0)) : 0;
          return err(
            "Payment required: $0.01 to $0.25 USDC (one tenth of the target's quoted price) on Base via x402 for endpoint_spot_check after free quota. " +
            "Free remaining today (approx): " + freeLeft + ". Pay at " + u.toString() +
            " with PAYMENT-SIGNATURE, or retry this MCP call with the same header. Requirements: " + JSON.stringify(body)
          );
        } else if (r.status === 400) {
          return err((body && body.error) || "bad request");
        } else {
          return err("402xAgent check returned HTTP " + r.status + (body && body.error ? ": " + body.error : ""));
        }
      } else if (name === "get_overnight_cos_pack") {
        const u = new URL(origin + "/v1/products/overnight-cos-pack");
        const headers = { accept: "application/json", "user-agent": "verified-catalog-mcp/0.5" };
        const pay = paymentHeader(req);
        if (pay) headers["payment-signature"] = pay;
        const ip = req.headers.get("cf-connecting-ip");
        if (ip) headers["cf-connecting-ip"] = ip;
        const r = await handleOvernightCosPack(new Request(u, { method: "GET", headers }), env, ctx, u);
        let body = null;
        try { body = await r.json(); } catch (_) { body = null; }
        if (r.status === 200) {
          data = body;
        } else if (r.status === 402) {
          return err(
            "Payment required: $9 USDC on Base via x402 for the Overnight Chief of Staff Setup Pack. " +
            "Pay at " + u.toString() + " with a PAYMENT-SIGNATURE header (x402 v2), or retry this MCP call with the same header. " +
            "Requirements: " + JSON.stringify(body)
          );
        } else {
          return err("pack endpoint returned HTTP " + r.status + (body && body.error ? ": " + body.error : ""));
        }
      } else if (name === "lookup") {
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
        writePoint(env, dataPoint({ product: "mcp", cid: await clientId(req, q, env), q, excluded: exclusion(req, q, env), candidates: 0, ua: req.headers.get("user-agent") || "", returnedPayTo: [], status: 200, referer: refererHost(req), access: "mcp-" + name }));
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
    const view = viewName(path);
    if (view) {
      const res = await routeInner(req, env, ctx, url, path);
      ctx && ctx.waitUntil ? ctx.waitUntil(viewPoint(req, env, url, view, res.status)) : await viewPoint(req, env, url, view, res.status);
      return res;
    }
    return routeInner(req, env, ctx, url, path);
  },
};

// 0.11.0: one cheap Analytics Engine point per hit on the routes that had none (pack, skips, receipts, docs).
// access = "view-<name>", blob4 = path (+ ?page / id), double3 = status. Same client id + bot tags as metered routes.
export function viewName(path) {
  if (path === "/v1/products/overnight-cos-pack") return "pack";
  if (path === "/v1/skips" || path === "/v1/skips.json") return "skips";
  if (path === "/v1/receipts" || path.startsWith("/v1/receipts/")) return "receipts";
  if (path === "/openapi.json") return "docs-openapi";
  if (path === "/llms.txt") return "docs-llms";
  if (path === "/.well-known/x402") return "docs-wellknown";
  if (path === "/") return "docs-home";
  return "";
}
async function viewPoint(req, env, url, view, status) {
  try {
    if (view === "pack" && status !== 402 && status !== 200) return; // the pack handler's own errors
    const q = parseQuery(url);
    const cid = await clientId(req, q, env);
    const ua = req.headers.get("user-agent") || "";
    const excluded = exclusion(req, q, env, view === "pack" ? url : null);
    const qv = { ...q, errors: [], endpoint: (url.pathname + (url.searchParams.get("page") ? "?page=" + url.searchParams.get("page") : "")).slice(0, 200) };
    const access = "view-" + view + (view === "pack" ? (status === 402 ? "-402" : "-paid") : "");
    const dp = dataPoint({ product: view === "pack" ? "pack" : "view", cid, q: qv, excluded, candidates: 0, ua, returnedPayTo: [], status, referer: refererHost(req), access });
    dp.blobs[5] = excluded || ""; // views: blob6 = bot tag only ("" = possibly real); never qualifying
    dp.doubles[0] = 0;
    writePoint(env, dp);
  } catch (_) {
    // counting must never break an answer
  }
}

// 0.18.0: x402 discovery manifest. `resources` stays a bare URL list (x402scan / Bazaar crawlers); the service-wide
// `payment.x402` block and the per-resource `resourceCatalog` accepts tell indexes (e.g. Agent402) the payment
// network, asset and payTo without a settled payment or a live 402 probe. Identical on every host.
export function wellKnownX402(env) {
  const c = cfg(env), pk = packCfg(env);
  const acc = (amount, desc) => ({ scheme: "exact", network: c.network, asset: USDC_BASE, payTo: c.payTo, ...(amount ? { amount } : {}), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...(desc ? { description: desc } : {}) });
  const R = (p) => API_ORIGIN + p;
  return {
    version: 1,
    name: BRAND,
    homepage: CANON_ORIGIN,
    // 0.20.0: descriptive only (no URL list, no payment block): the free check comes first, the paid 402 after.
    free_check: { url: FREE_CHECK_URL, example: FREE_CHECK_EXAMPLE_URL, example_response: FREE_CHECK_EXAMPLE, prior_checks: PRIOR_CHECKS, then: "the paid check (HTTP 402) for the full payment terms" },
    resources: [R("/v1/lookup/paid"), R("/v1/products/overnight-cos-pack"), R("/v1/products/endpoint-spot-check")],
    payment: { x402: { version: 2, scheme: "exact", networks: [c.network], primaryNetwork: c.network, currency: "USDC", asset: USDC_BASE, payTo: c.payTo } },
    resourceCatalog: [
      { url: R("/v1/lookup/paid"), method: "GET", description: "Reliability lookup: x402 services for a task at a price, ranked by known-answer pass rate", accepts: [acc(c.priceAtomic)] },
      { url: R("/v1/products/overnight-cos-pack"), methods: ["GET", "POST"], description: "Overnight Chief of Staff Setup Pack (prompts, template, PDF guide)", accepts: [acc(pk.priceAtomic)] },
      { url: R("/v1/products/endpoint-spot-check"), methods: ["GET", "POST"], description: "402xAgent check: pay, skip or recheck for an x402 endpoint before your agent pays. 1 free per day, then one tenth of the target's price ($0.01 to $0.25)", price: { mode: "dynamic", currency: "USD", min: "0.01", max: "0.25" }, accepts: [acc(null)] },
    ],
    openapi: API_ORIGIN + "/openapi.json",
    mcp: API_ORIGIN + "/mcp",
  };
}

export function oldHostPageView(req, url, path) {
  if (!OLD_HOSTNAMES.includes(url.hostname)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!/text\/html/i.test(req.headers.get("accept") || "")) return false;
  if (req.headers.get("payment-signature") || req.headers.get("x-payment")) return false;
  if (path === "/mcp" || path.startsWith("/v1/products/") || path.startsWith("/v1/lookup") || path.startsWith("/.well-known/") || SPOT_ALIASES.has(path)) return false;
  return true;
}

export const SPOT_ALIASES = new Set(["/endpoint-spot-check", "/v1/endpoint-spot-check", "/spot-check", "/v1/spot-check", "/v1/products/spot-check", "/v1/lookup/endpoint-spot-check"]);
const routeInnerHolder = {
  async routeInner(req, env, ctx, url, path) {
    // 0.17.0: browser page views on the older hosts move to 402xagent.com; API, x402, MCP and POST calls keep answering here.
    if (oldHostPageView(req, url, path)) return new Response(null, { status: 301, headers: { location: CANON_ORIGIN + url.pathname + url.search, vary: "accept", "cache-control": "public, max-age=3600" } });
    if (path === "/mcp") return handleMcp(req, env, ctx, url);
    // POST is accepted on the paid path so method-probing discovery tools get the same 402.
    if (path === "/v1/lookup/paid" && ["GET", "HEAD", "POST"].includes(req.method)) return handlePaidLookup(req, env, ctx, url);
    if (path === "/v1/products/overnight-cos-pack" && ["GET", "HEAD", "POST"].includes(req.method)) return handleOvernightCosPack(req, env, ctx, url);
    if (path === "/v1/products/endpoint-spot-check" && ["GET", "HEAD", "POST"].includes(req.method)) return handleEndpointSpotCheck(req, env, ctx, url);
    // 0.12.1: guessed short paths for Spot-Check get a 308 to the canonical route (query kept; method + body kept by 308).
    if (SPOT_ALIASES.has(path)) {
      const to = url.origin + "/v1/products/endpoint-spot-check" + url.search;
      return json({ error: "moved", moved_to: to, note: "the 402xAgent check lives at /v1/products/endpoint-spot-check" }, 308, { location: to, "cache-control": "no-store" });
    }
    if (path === "/v1/products/endpoint-spot-check")
      return json(spotBadRequest(API_ORIGIN, "method", `Unsupported method ${String(req.method).slice(0, 10)}; use GET or POST`), 400);
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405, { allow: "GET, OPTIONS" });
    if (path === "/v1/skips" || path === "/v1/skips.json") return handleSkips(req, url, env);
    if (path === "/v1/receipts/by-url" || /^\/v1\/receipts\/sc-/.test(path)) return handleLiveReceipts(req, env, url, path);
    if (path === "/v1/receipts" && url.searchParams.has("type")) return handleReceiptList(env, url);
    if (path === "/v1/receipts" || path.startsWith("/v1/receipts/")) return handleReceipts(url, env);
    if (path === "/v1/lookup") return handleLookup(req, env, ctx, url);
    if (path === "/.well-known/x402") return json(wellKnownX402(env), 200, { "cache-control": "public, max-age=300" });
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
    if ((req.method === "GET" || req.method === "HEAD") && Object.prototype.hasOwnProperty.call(BRAND_ASSETS, path)) {
      const asset = BRAND_ASSETS[path];
      const bytes = Uint8Array.from(atob(asset.b64), (ch) => ch.charCodeAt(0));
      return new Response(req.method === "HEAD" ? null : bytes, { headers: { "content-type": asset.type, "cache-control": "public, max-age=604800", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" } });
    }
    if (path === "/robots.txt") return new Response(`User-agent: *\nAllow: /\nSitemap: ${CANON_ORIGIN}/sitemap.xml\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (path === "/sitemap.xml") return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/v1/skips", "/v1/skips.json", "/v1/receipts", "/", "/openapi.json", "/llms.txt"].map((u) => `<url><loc>${CANON_ORIGIN}${u}</loc><changefreq>daily</changefreq></url>`).join("")}</urlset>\n`, { headers: { "content-type": "application/xml; charset=utf-8" } });
    if (path === "/llms.txt") return new Response(`# 402xAgent + x402 Verified Catalog\n\nStart with the free check: GET ${FREE_CHECK_URL}\nReal example: GET ${FREE_CHECK_EXAMPLE_URL}\n  -> ${JSON.stringify(FREE_CHECK_EXAMPLE)}\n1 free check per client per UTC day, free dry runs with &mode=dry-run, prior checks at ${PRIOR_CHECKS}. After that, the paid check (HTTP 402, $0.01 to $0.25 USDC on Base via x402) adds the full payment terms.\n\n402xAgent checks an x402 endpoint right before your agent pays: pay | skip | recheck, plus the exact payment to sign. Home: ${CANON_ORIGIN}. API: ${API_ORIGIN} (same routes on every host; the old ${LEGACY_ORIGIN} keeps working).\n\n- Skips page (free): ${CANON_ORIGIN}/v1/skips (JSON: ${CANON_ORIGIN}/v1/skips.json). 500 self-checked x402 endpoints; the skip list shows which ones disagree with their listing.\n- All receipts: ${CANON_ORIGIN}/v1/receipts  (live receipts: ${CANON_ORIGIN}/v1/receipts/sc-<id>; dry runs: ${CANON_ORIGIN}/v1/receipts?type=dry-run; latest for a URL: ${CANON_ORIGIN}/v1/receipts/by-url?url=<endpoint>; free to read)\n- Check before you pay: GET ${API_ORIGIN}/v1/products/endpoint-spot-check?url=https://example.com/api/paid returns pay|skip|recheck (the 402xAgent check; route path kept for compatibility). Free dry run: add &mode=dry-run. 1 free/day, then $0.01 to $0.25 USDC (one tenth of the target's quoted price) on Base via x402.\n- One-line guard for x402 clients (@x402/fetch, @x402/axios): https://github.com/withgrokbot/x402-spotcheck  ->  const pay = wrapFetchWithPayment(spotCheckFetch(fetch), client);  (blocks the payment on skip)\n- OpenAPI: ${API_ORIGIN}/openapi.json  MCP: ${API_ORIGIN}/mcp\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (path === "/" && url.hostname === "402xagent.com" && /text\/html/.test(req.headers.get("accept") || ""))
      return new Response(landingHtml(CANON_ORIGIN), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", vary: "accept", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "access-control-allow-origin": "*" } });
    if (path === "/")
      return json({
        name: "402xAgent + verified x402 catalog",
        version: VERSION,
        hosts: { home: CANON_ORIGIN, api: API_ORIGIN, legacy_host: LEGACY_ORIGIN, note: "Every host serves the same Worker, routes and payments; older hosts keep answering API, x402 and MCP calls." },
        usage: CANON_ORIGIN + "/v1/lookup?task=web-search&max_price=0.01&n=5",
        paid: CANON_ORIGIN + "/v1/lookup/paid?task=web-search&max_price=0.01&n=5",
        products: {
          "overnight-cos-pack": {
            url: CANON_ORIGIN + "/v1/products/overnight-cos-pack",
            title: PACK_TITLE,
            price_usdc: PACK_PRICE_USD,
            note: "Always paid via x402; SELF_CLIENTS are not exempt",
          },
          "endpoint-spot-check": {
            url: CANON_ORIGIN + "/v1/products/endpoint-spot-check",
            title: SPOT_SERVICE_NAME,
            price_usdc: "0.01-0.25",
            free_per_day: 1,
            note: "1 free SSRF-safe x402 challenge probe per client per UTC day, then $0.01 to $0.25 USDC (one tenth of the target's quoted price); never pays the target. SELF_CLIENTS exempt from free quota only.",
          },
        },
        mcp: CANON_ORIGIN + "/mcp",
        guard: { repo: "https://github.com/withgrokbot/x402-spotcheck", one_line: "const pay = wrapFetchWithPayment(spotCheckFetch(fetch), client);", note: "asks 402xAgent right before your x402 client pays; skip blocks the payment" },
        skips: CANON_ORIGIN + "/v1/skips",
        receipts: CANON_ORIGIN + "/v1/receipts",
        tasks: CANON_ORIGIN + "/v1/tasks",
        openapi: CANON_ORIGIN + "/openapi.json",
        catalog: (env.DATA_BASE_URL || DEFAULT_DATA).replace(/\/?$/, "/") + "catalog.json",
        pricing: pricingDoc(cfg(env)),
        payment_policy: PAYMENT_POLICY,
        privacy: "Raw IPs are never stored. Lookups are counted by a weekly-salted hash of IP /24 + User-Agent, or by the client value you send. The free quota is counted by the client value, or by a daily-salted hash of the IP.",
      }, 200, { vary: "accept" });
    return json({ error: "not found", usage: CANON_ORIGIN + "/v1/lookup?task=web-search&max_price=0.01&n=5", spot_check: CANON_ORIGIN + "/v1/products/endpoint-spot-check?url=<endpoint>", docs: CANON_ORIGIN + "/openapi.json" }, 404);
  },
};
const routeInner = (req, env, ctx, url, path) => routeInnerHolder.routeInner(req, env, ctx, url, path);
