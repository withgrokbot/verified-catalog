// Email validation v1 (0.68.0, UNRELEASED, OFF by default: EMAIL must be "1", else every route 404s). Not priced and not launched.
//   POST /v1/email/validate  {email}            one address
//   POST /v1/email/batch     {emails:[...]}     up to 100 addresses
// Same API keys as the render API (x-api-key or Authorization: Bearer rk_...). Quota and usage are separate
// (email_plan, email_monthly_quota, api_key_usage.emails on the pdf usage row). A hard cap: at quota the call is 429,
// nothing is billed extra. Email counts are not part of SUM(renders), so a card, PDF or screenshot does not spend them.
// Checks: RFC 5322 syntax + IDNA, MX over DNS-over-HTTPS (A record if there is no MX), disposable domains (bundled list
// plus the weekly refresh), role addresses, typo suggestions. No SMTP in v1: checks.smtp is always "not_checked".
// Status is never "deliverable" without an SMTP pass, so v1's best status is risky or unknown (undeliverable only when
// syntax or DNS shows the address cannot accept mail).
// A future SMTP probe host is configured by EMAIL_SMTP_URL + EMAIL_SMTP_SECRET and called with a signed body. Both unset
// means off. v1 builds that request and does not send it.
import { disposableDomains } from "./disposable-domains.js";

export const EMAIL_VALIDATE_PATH = "/v1/email/validate";
export const EMAIL_BATCH_PATH = "/v1/email/batch";
export const EMAIL_DOCS_PATH = "/v1/email/docs";
export const EMAIL_BATCH_MAX = 100;
export const EMAIL_CACHE_TTL_S = 24 * 3600;
export const EMAIL_DISPOSABLE_CRON = "23 6 * * 1"; // Monday 06:23 UTC
export const DISPOSABLE_LIST_URL = "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf";
export const emailOn = (env) => String((env && env.EMAIL) || "") === "1";

export const EMAIL_PLANS = {
  free: { quota: 100, priceUsd: null },
  starter: { quota: 5000, priceUsd: null },
  pro: { quota: 25000, priceUsd: null },
};

export const ROLE_LOCALS = new Set([
  "admin", "administrator", "info", "information", "support", "sales", "contact", "hello", "help", "office", "team",
  "billing", "abuse", "postmaster", "hostmaster", "webmaster", "noreply", "no-reply", "security", "marketing", "press",
  "media", "jobs", "careers", "hr", "legal", "privacy", "compliance", "newsletter", "notifications", "notify", "mailer-daemon",
  "root", "sysadmin", "unsubscribe", "bounce", "bounces",
]);

export const POPULAR_DOMAINS = [
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "outlook.com", "hotmail.com", "live.com", "icloud.com",
  "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com",
  "yandex.com", "fastmail.com", "hey.com", "msn.com", "pm.me",
];

const J = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-expose-headers": "X-QUOTA-LIMIT, X-QUOTA-REMAINING", "cache-control": "no-store", ...extra } });
const monthOf = (now) => now.toISOString().slice(0, 7);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------- syntax (RFC 5322 addr-spec subset) + IDNA ----------
const ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;

function validQuoted(local) {
  if (local.length < 2 || !local.endsWith('"') || local.length > 64) return false;
  const inner = local.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (inner[i] === "\\") {
      const n = inner.charCodeAt(i + 1);
      if (!Number.isFinite(n) || n < 0x20 || n > 0x7e) return false;
      i++;
      continue;
    }
    if (inner[i] === '"' || c < 0x20 || c > 0x7e) return false;
  }
  return true;
}
function validLocal(local) {
  if (local.startsWith('"')) return validQuoted(local);
  if (!local || local.length > 64) return false;
  return local.split(".").every((p) => ATOM.test(p));
}
/** Split addr-spec on the @ that separates local and domain. A quoted local may contain @. */
export function splitAddr(s) {
  if (s.startsWith('"')) {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\") { i++; continue; }
      if (s[i] === '"') {
        if (s[i + 1] !== "@" || i + 2 >= s.length) return null;
        return { local: s.slice(0, i + 1), domain: s.slice(i + 2) };
      }
    }
    return null;
  }
  const i = s.indexOf("@");
  if (i <= 0 || i !== s.lastIndexOf("@") || i === s.length - 1) return null;
  return { local: s.slice(0, i), domain: s.slice(i + 1) };
}
function domainLiteral(domain) {
  if (!domain.startsWith("[") || !domain.endsWith("]")) return null;
  const inner = domain.slice(1, -1);
  const octet = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
  if (new RegExp("^(?:" + octet + "\\.){3}" + octet + "$").test(inner)) return "[" + inner + "]";
  if (inner.includes(":") && /^[0-9a-f:.]+$/i.test(inner) && !inner.includes(":::") && inner.split(":").length <= 8) return "[" + inner.toLowerCase() + "]";
  return null;
}
/** {unicode, ascii, literal} or null. DNS uses the ASCII (punycode) form. */
export function normalizeDomain(domain) {
  const lit = domainLiteral(domain);
  if (lit) return { unicode: lit, ascii: lit, literal: true };
  if (domain.startsWith("[")) return null;
  const d = domain.normalize("NFC").replace(/\.$/, "").toLowerCase();
  if (!d || d.length > 253 || d.startsWith(".") || d.endsWith(".") || d.includes("..") || /\s/.test(d)) return null;
  let ascii, u;
  try { u = new URL("http://" + d); ascii = u.hostname; } catch (_) { return null; }
  if (u.username || u.password || u.port || u.pathname !== "/" || u.search || u.hash) return null;
  if (!ascii || ascii.endsWith(".") || ascii.includes("..")) return null;
  if (ascii !== d && !/[^\x00-\x7f]/.test(d)) return null;
  const labels = ascii.split(".");
  if (labels.length < 1 || labels.some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-") || !/^[a-z0-9-]+$/.test(l))) return null;
  if (d.includes("%") || ascii.includes("%")) return null;
  return { unicode: d, ascii, literal: false };
}
/** {ok:true, email, local, domain, asciiDomain, literal} or {ok:false, reason:"invalid_syntax"}. */
export function parseEmail(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "invalid_syntax" };
  const s = raw.trim();
  if (!s || s.length > 254 || /[\u0000-\u001f\u007f]/.test(s)) return { ok: false, reason: "invalid_syntax" };
  if (!s.startsWith('"') && /\s/.test(s)) return { ok: false, reason: "invalid_syntax" };
  const parts = splitAddr(s);
  if (!parts || !validLocal(parts.local)) return { ok: false, reason: "invalid_syntax" };
  const dom = normalizeDomain(parts.domain);
  if (!dom) return { ok: false, reason: "invalid_syntax" };
  const local = parts.local.startsWith('"') ? parts.local : parts.local.toLowerCase();
  const email = local + "@" + dom.unicode;
  if (email.length > 254 || dom.ascii.length > 253) return { ok: false, reason: "invalid_syntax" };
  return { ok: true, email, local, domain: dom.unicode, asciiDomain: dom.ascii, literal: dom.literal };
}
export function localBase(local) {
  const bare = local.startsWith('"') ? local.slice(1, -1) : local;
  return bare.split("+")[0].toLowerCase();
}
export const isRoleLocal = (local) => ROLE_LOCALS.has(localBase(local));

// ---------- typo suggestions (Damerau-Levenshtein, unique match only) ----------
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
/** A popular domain within one edit (or a unique two-edit with the same first two letters), else null. */
export function suggestDomain(domain) {
  const d = String(domain || "").toLowerCase();
  if (!d || d.includes("xn--") || /[^\x00-\x7f]/.test(d) || POPULAR_DOMAINS.includes(d)) return null;
  let best = null, bestD = 3, tie = false;
  for (const p of POPULAR_DOMAINS) {
    const dist = editDistance(d, p);
    if (dist === 0 || dist > 2) continue;
    if (dist === 2 && (d.slice(0, 2) !== p.slice(0, 2) || Math.abs(d.length - p.length) > 1)) continue;
    if (dist < bestD) { best = p; bestD = dist; tie = false; }
    else if (dist === bestD && p !== best) tie = true;
  }
  return tie ? null : best;
}
export function suggestEmail(local, domain) {
  const fix = suggestDomain(domain);
  return fix ? local + "@" + fix : null;
}

// ---------- status ----------
/**
 * Map checks to a status. deliverable is returned only when smtp is "pass" and nothing else is wrong.
 * Any other smtp value (including "not_checked") cannot be deliverable.
 */
export function classify(input) {
  const checks = {
    syntax: input.syntax === "valid" ? "valid" : "invalid",
    mx: ["present", "missing", "a_fallback", "error", "literal"].includes(input.mx) ? input.mx : "missing",
    disposable: input.disposable === true,
    role: input.role === true,
    catch_all: input.catch_all == null || input.catch_all === "not_checked" ? "not_checked" : input.catch_all,
    smtp: input.smtp === "pass" || input.smtp === "fail" ? input.smtp : "not_checked",
  };
  const reasons = [];
  let status, confidence;
  if (checks.syntax !== "valid") { status = "undeliverable"; confidence = 0.99; reasons.push("invalid_syntax"); }
  else if (checks.mx === "error") { status = "unknown"; confidence = 0.2; reasons.push("dns_error"); }
  else if (checks.mx === "literal") { status = "unknown"; confidence = 0.3; reasons.push("domain_literal"); }
  else if (checks.mx === "missing") { status = "undeliverable"; confidence = input.nullMx ? 0.99 : 0.95; reasons.push(input.nullMx ? "null_mx" : "no_mx"); }
  else if (checks.smtp === "fail") { status = "undeliverable"; confidence = 0.9; reasons.push("smtp_reject"); }
  else {
    if (checks.disposable) reasons.push("disposable_domain");
    if (checks.role) reasons.push("role_address");
    if (checks.mx === "a_fallback") reasons.push("no_mx_a_fallback");
    if (checks.catch_all === true || checks.catch_all === "yes") reasons.push("catch_all");
    const risky = reasons.length > 0;
    if (checks.smtp === "pass" && !risky) { status = "deliverable"; confidence = 0.97; }
    else {
      if (checks.smtp !== "pass") reasons.push("smtp_not_checked");
      if (risky) {
        status = "risky";
        confidence = checks.disposable ? 0.8 : checks.role ? 0.65 : checks.mx === "a_fallback" ? 0.55 : 0.6;
      } else { status = "unknown"; confidence = 0.4; }
    }
  }
  // Hard rule: no SMTP pass, no deliverable. v1 never sets smtp to "pass".
  if (status === "deliverable" && checks.smtp !== "pass") {
    status = "unknown"; confidence = 0.4;
    if (!reasons.includes("smtp_not_checked")) reasons.push("smtp_not_checked");
  }
  return { status, confidence: Math.max(0, Math.min(1, confidence)), reasons, checks };
}

// ---------- DNS-over-HTTPS ----------
async function doh(name, type, fetchImpl) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  let r;
  try { r = await fetchImpl(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) }); }
  catch (_) { return { error: true }; }
  if (!r || !r.ok) return { error: true };
  let j; try { j = await r.json(); } catch (_) { return { error: true }; }
  if (j.Status !== 0 && j.Status !== 3) return { error: true };
  return { answers: Array.isArray(j.Answer) ? j.Answer : [] };
}
function mxFromAnswers(answers) {
  const hosts = [];
  for (const a of answers) {
    if (!a || a.type !== 15 || typeof a.data !== "string") continue;
    const m = /^(\d+)\s+(\S+)$/.exec(a.data.trim());
    if (!m) continue;
    hosts.push({ pref: Number(m[1]), exchange: m[2].replace(/\.$/, "").toLowerCase() });
  }
  return hosts;
}
/** {mx:"present"|"missing"|"a_fallback"|"error", nullMx?:boolean}. Does not throw. */
export async function lookupMx(asciiDomain, fetchImpl = fetch) {
  const mx = await doh(asciiDomain, "MX", fetchImpl);
  if (mx.error) return { mx: "error" };
  const hosts = mxFromAnswers(mx.answers);
  if (hosts.some((h) => h.exchange === "" || h.exchange === ".")) return { mx: "missing", nullMx: true };
  if (hosts.length) return { mx: "present" };
  const a = await doh(asciiDomain, "A", fetchImpl);
  if (a.error) return { mx: "error" };
  const hasA = a.answers.some((x) => x && x.type === 1 && typeof x.data === "string" && /^(\d{1,3}\.){3}\d{1,3}$/.test(x.data));
  return hasA ? { mx: "a_fallback" } : { mx: "missing" };
}

// ---------- disposable (bundled list, plus domains refreshed into D1) ----------
export function domainCandidates(domain) {
  const parts = String(domain || "").toLowerCase().split(".").filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}
export async function isDisposableDomain(env, domain) {
  const set = disposableDomains();
  const candidates = domainCandidates(domain);
  if (candidates.some((d) => set.has(d))) return true;
  if (!env || !env.RECEIPTS_DB || !candidates.length) return false;
  const row = await env.RECEIPTS_DB.prepare(`SELECT 1 AS x FROM email_disposable_domains WHERE domain IN (${candidates.map(() => "?").join(",")}) LIMIT 1`).bind(...candidates).first();
  return !!row;
}

export function parseDisposableList(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    let s = line.trim().toLowerCase();
    if (!s || s.startsWith("#") || s.startsWith("//")) continue;
    if (s.startsWith("*.")) s = s.slice(2);
    if (!/^[a-z0-9.-]+$/.test(s) || s.length > 253 || s.includes("..") || s.startsWith(".") || s.endsWith(".")) continue;
    out.push(s);
  }
  return [...new Set(out)];
}
/** Replace the D1 disposable table from the upstream list. Refuses a short body so a bad fetch cannot wipe the table. */
export async function refreshDisposableDomains(env, opts = {}) {
  if (!env || !env.RECEIPTS_DB) return { ok: false, reason: "no_db" };
  const fetchImpl = opts.fetchImpl || fetch;
  const min = opts.min == null ? 100 : opts.min;
  let r;
  try { r = await fetchImpl(opts.url || DISPOSABLE_LIST_URL, { headers: { accept: "text/plain" }, signal: AbortSignal.timeout(20000) }); }
  catch (_) { return { ok: false, reason: "fetch_failed" }; }
  if (!r || !r.ok) return { ok: false, reason: "http_" + ((r && r.status) || 0) };
  const text = await r.text();
  if (text.length > 5_000_000) return { ok: false, reason: "too_large" };
  const domains = parseDisposableList(text);
  if (domains.length < min) return { ok: false, reason: "list_too_small", count: domains.length };
  const t = Math.floor(((opts.now || new Date()).getTime()) / 1000);
  await env.RECEIPTS_DB.prepare("DELETE FROM email_disposable_domains").run();
  for (let i = 0; i < domains.length; i += 40) {
    const slice = domains.slice(i, i + 40);
    await env.RECEIPTS_DB.prepare(`INSERT INTO email_disposable_domains (domain, refreshed_at) VALUES ${slice.map(() => "(?, ?)").join(",")}`).bind(...slice.flatMap((d) => [d, t])).run();
  }
  return { ok: true, count: domains.length };
}

// ---------- domain cache (24 h) ----------
async function mxForDomain(env, ascii, fetchImpl, now) {
  const t = Math.floor(now.getTime() / 1000);
  const db = env && env.RECEIPTS_DB;
  if (db) {
    const row = await db.prepare("SELECT mx, catch_all, checked_at FROM email_domain_cache WHERE domain = ?").bind(ascii).first();
    if (row && row.mx !== "error" && t - Number(row.checked_at) < EMAIL_CACHE_TTL_S) return { mx: row.mx, catch_all: row.catch_all || "not_checked", cached: true };
  }
  const looked = await lookupMx(ascii, fetchImpl);
  if (db && looked.mx !== "error") {
    await db.prepare("INSERT INTO email_domain_cache (domain, mx, catch_all, checked_at) VALUES (?, ?, 'not_checked', ?) ON CONFLICT(domain) DO UPDATE SET mx = excluded.mx, catch_all = excluded.catch_all, checked_at = excluded.checked_at").bind(ascii, looked.mx, t).run();
  }
  return { ...looked, catch_all: "not_checked", cached: false };
}

// ---------- SMTP probe interface (off unless both env vars are set; v1 does not send) ----------
export function smtpProbeEnabled(env) {
  const url = String((env && env.EMAIL_SMTP_URL) || "").trim();
  const secret = String((env && env.EMAIL_SMTP_SECRET) || "").trim();
  return !!(url && secret && /^https:\/\//.test(url));
}
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
/** The request a future probe host would receive, or null when the probe is off. v1 does not send it. */
export async function buildSmtpProbeRequest(env, email) {
  if (!smtpProbeEnabled(env)) return null;
  const body = JSON.stringify({ v: 1, email });
  const sig = await hmacHex(String(env.EMAIL_SMTP_SECRET), body);
  return { url: String(env.EMAIL_SMTP_URL).trim(), method: "POST", headers: { "content-type": "application/json", "x-email-probe-signature": "v1=" + sig }, body };
}

// ---------- one address ----------
export async function validateAddress(raw, env, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || new Date();
  const parsed = parseEmail(raw);
  if (!parsed.ok) {
    const c = classify({ syntax: "invalid", mx: "missing", disposable: false, role: false, catch_all: "not_checked", smtp: "not_checked" });
    return { email: typeof raw === "string" ? raw.trim().slice(0, 320) : "", ...c, suggestion: null };
  }
  const suggestion = suggestEmail(parsed.local, parsed.domain);
  const role = isRoleLocal(parsed.local);
  if (parsed.literal) {
    const c = classify({ syntax: "valid", mx: "literal", disposable: false, role, catch_all: "not_checked", smtp: "not_checked" });
    return { email: parsed.email, ...c, suggestion };
  }
  // v1 never calls the SMTP probe. checks.smtp stays "not_checked" even when EMAIL_SMTP_URL is set.
  const [mx, disposable] = await Promise.all([
    mxForDomain(env, parsed.asciiDomain, fetchImpl, now),
    isDisposableDomain(env, parsed.asciiDomain),
  ]);
  const c = classify({ syntax: "valid", mx: mx.mx, nullMx: mx.nullMx, disposable, role, catch_all: "not_checked", smtp: "not_checked" });
  if (c.status === "deliverable") {
    c.status = "unknown"; c.confidence = 0.4;
    if (!c.reasons.includes("smtp_not_checked")) c.reasons.push("smtp_not_checked");
  }
  return { email: parsed.email, ...c, suggestion };
}

// ---------- quota ----------
// Email counts sit on the pdf usage row (migration 0029 keys usage by kind). renders on that row is the PDF
// counter only; emails is not included in the render hard cap (SUM of pdf + shot + card).
const EMAIL_USAGE_KIND = "pdf";
export async function reserveEmailQuota(env, keyId, n, quota, now) {
  const db = env.RECEIPTS_DB;
  const mo = monthOf(now);
  const t = Math.floor(now.getTime() / 1000);
  await db.prepare("INSERT OR IGNORE INTO api_key_usage (key_id, month, kind, renders, emails, updated_at) VALUES (?, ?, ?, 0, 0, ?)").bind(keyId, mo, EMAIL_USAGE_KIND, t).run();
  const r = await db.prepare("UPDATE api_key_usage SET emails = emails + ?, updated_at = ? WHERE key_id = ? AND month = ? AND kind = ? AND emails + ? <= ?").bind(n, t, keyId, mo, EMAIL_USAGE_KIND, n, quota).run();
  const row = await db.prepare("SELECT emails, renders FROM api_key_usage WHERE key_id = ? AND month = ? AND kind = ?").bind(keyId, mo, EMAIL_USAGE_KIND).first();
  const used = row ? row.emails : 0;
  return { ok: !!(r.meta && r.meta.changes), used, remaining: Math.max(0, quota - used), limit: quota, renders: row ? row.renders : 0 };
}
async function releaseEmailQuota(env, keyId, n, now) {
  await env.RECEIPTS_DB.prepare("UPDATE api_key_usage SET emails = emails - ? WHERE key_id = ? AND month = ? AND kind = ? AND emails >= ?").bind(n, keyId, monthOf(now), EMAIL_USAGE_KIND, n).run();
}

async function authorize(req, env, n, now) {
  const { keyFromReq, loadKey } = await import("./render.js");
  const raw = keyFromReq(req);
  if (!raw) return { error: J({ error: "send your API key as x-api-key" }, 401) };
  if (!env.RECEIPTS_DB) return { error: J({ error: "email validation is not configured on this deployment" }, 503) };
  const key = await loadKey(env, raw, now);
  if (!key || key.status === "revoked") return { error: J({ error: "unknown api key" }, 401) };
  if (key.status !== "active") return { error: J({ error: "api key suspended", reason: "suspended" }, 403) };
  const row = await env.RECEIPTS_DB.prepare("SELECT email_plan, email_monthly_quota FROM api_keys WHERE id = ?").bind(key.id).first();
  const quota = row && row.email_monthly_quota != null ? Number(row.email_monthly_quota) : EMAIL_PLANS.free.quota;
  const plan = (row && row.email_plan) || "free";
  const q = await reserveEmailQuota(env, key.id, n, quota, now);
  const headers = { "x-quota-limit": String(q.limit), "x-quota-remaining": String(q.remaining) };
  if (!q.ok) return { error: J({ error: "email quota exceeded", reason: "quota_exceeded", plan, monthly_quota: quota, used: q.used, note: "Email quota is separate from render quota and is a hard cap. Nothing is billed as overage. Email plans are not priced yet." }, 429, headers) };
  return { key, plan, quota: q, headers };
}

async function readJson(req, max) {
  if (Number(req.headers.get("content-length") || 0) > max) return { error: "too_large" };
  let text = "";
  try { text = await req.text(); } catch (_) { return { error: "bad_body" }; }
  if (text.length > max) return { error: "too_large" };
  if (!text) return { body: {} };
  try { const b = JSON.parse(text); return b && typeof b === "object" ? { body: b } : { error: "bad_json" }; }
  catch (_) { return { error: "bad_json" }; }
}

function resultOf(v) {
  return { email: v.email, status: v.status, confidence: v.confidence, reasons: v.reasons, checks: v.checks, suggestion: v.suggestion };
}

export async function handleEmailValidate(req, env, ctx, url, opts = {}) {
  if (!emailOn(env)) return J({ error: "not found" }, 404);
  if (req.method !== "POST") return J({ error: "use POST with a JSON body {email}" }, 405, { allow: "POST" });
  const now = opts.now || new Date();
  const raw = await readJson(req, 8192);
  if (raw.error) return J({ error: raw.error === "too_large" ? "request body too large" : "body must be a JSON object" }, raw.error === "too_large" ? 413 : 400);
  if (!raw.body || typeof raw.body.email !== "string") return J({ error: "email must be a string", reason: "invalid_body" }, 400);
  const auth = await authorize(req, env, 1, now);
  if (auth.error) return auth.error;
  try {
    const v = await validateAddress(raw.body.email, env, { ...opts, now });
    return J(resultOf(v), 200, auth.headers);
  } catch (_) {
    await releaseEmailQuota(env, auth.key.id, 1, now);
    return J({ error: "could not validate", reason: "internal" }, 500);
  }
}

export async function handleEmailBatch(req, env, ctx, url, opts = {}) {
  if (!emailOn(env)) return J({ error: "not found" }, 404);
  if (req.method !== "POST") return J({ error: "use POST with a JSON body {emails}" }, 405, { allow: "POST" });
  const now = opts.now || new Date();
  const raw = await readJson(req, 64 * 1024);
  if (raw.error) return J({ error: raw.error === "too_large" ? "request body too large" : "body must be a JSON object" }, raw.error === "too_large" ? 413 : 400);
  const emails = raw.body && raw.body.emails;
  if (!Array.isArray(emails) || emails.some((e) => typeof e !== "string")) return J({ error: "emails must be an array of strings", reason: "invalid_body" }, 400);
  if (!emails.length) return J({ error: "emails must include at least one address", reason: "empty" }, 400);
  if (emails.length > EMAIL_BATCH_MAX) return J({ error: `at most ${EMAIL_BATCH_MAX} addresses`, reason: "too_many" }, 400);
  const auth = await authorize(req, env, emails.length, now);
  if (auth.error) return auth.error;
  try {
    const results = [];
    for (const e of emails) results.push(resultOf(await validateAddress(e, env, { ...opts, now })));
    return J({ results }, 200, auth.headers);
  } catch (_) {
    await releaseEmailQuota(env, auth.key.id, emails.length, now);
    return J({ error: "could not validate", reason: "internal" }, 500);
  }
}

export function emailDocs() {
  return {
    product: "email_validation", version: "1", released: false, priced: false, flag: "EMAIL",
    note: "Unreleased. Not priced and not launched. v1 does not probe SMTP, so a result is never deliverable.",
    routes: {
      validate: { method: "POST", url: EMAIL_VALIDATE_PATH, auth: "x-api-key (same keys as the render API)", body: { email: "user@example.com" } },
      batch: { method: "POST", url: EMAIL_BATCH_PATH, auth: "x-api-key", body: { emails: ["user@example.com"] }, max: EMAIL_BATCH_MAX },
    },
    result: ["email", "status", "confidence", "reasons", "checks", "suggestion"],
    status: ["deliverable", "undeliverable", "risky", "unknown"],
    status_rule: "deliverable only after checks.smtp is pass. v1 always returns checks.smtp = not_checked, so the best status is risky or unknown. undeliverable is used when syntax is invalid or the domain has no MX and no A record.",
    checks: { syntax: "valid|invalid", mx: "present|missing|a_fallback|error|literal", disposable: "boolean", role: "boolean", catch_all: "not_checked", smtp: "not_checked" },
    plans: EMAIL_PLANS,
    quota: "Separate from render quota (api_key_usage.emails). Hard cap, 429 at the cap, never billed as overage.",
    smtp_probe: { env: ["EMAIL_SMTP_URL", "EMAIL_SMTP_SECRET"], default: "off", v1: "the signed request is defined and not sent" },
    disposable: "Bundled list, plus a weekly refresh from the disposable-email-domains GitHub list (cron " + EMAIL_DISPOSABLE_CRON + ").",
  };
}

export function emailOpenApiPaths() {
  const resultSchema = {
    type: "object", required: ["email", "status", "confidence", "reasons", "checks", "suggestion"],
    properties: {
      email: { type: "string" },
      status: { type: "string", enum: ["deliverable", "undeliverable", "risky", "unknown"], description: "Never deliverable in v1: SMTP is not checked." },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reasons: { type: "array", items: { type: "string" } },
      checks: { type: "object", properties: { syntax: { type: "string" }, mx: { type: "string" }, disposable: { type: "boolean" }, role: { type: "boolean" }, catch_all: { type: "string", enum: ["not_checked"] }, smtp: { type: "string", enum: ["not_checked"] } } },
      suggestion: { type: ["string", "null"] },
    },
  };
  const shared = { parameters: [{ name: "x-api-key", in: "header", required: true, schema: { type: "string" }, description: "Render API key (rk_...). Email quota is separate from render quota." }], responses: { 200: { description: "Validation result. Unreleased, not priced. status is never deliverable in v1.", content: { "application/json": { schema: resultSchema } } }, 400: { description: "body is not the expected JSON" }, 401: { description: "missing or unknown api key" }, 429: { description: "email monthly quota reached (hard cap)" }, 404: { description: "EMAIL is not 1" } } };
  return {
    [EMAIL_VALIDATE_PATH]: { post: { operationId: "emailValidate", "x-unreleased": true, summary: "UNRELEASED email validation (not priced). One address. Never deliverable without an SMTP pass; v1 does not check SMTP.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", example: "user@gmial.com" } } } } } }, ...shared } },
    [EMAIL_BATCH_PATH]: { post: { operationId: "emailValidateBatch", "x-unreleased": true, summary: `UNRELEASED email validation (not priced). Up to ${EMAIL_BATCH_MAX} addresses. Never deliverable without an SMTP pass; v1 does not check SMTP.`, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["emails"], properties: { emails: { type: "array", maxItems: EMAIL_BATCH_MAX, items: { type: "string" } } } } } } }, ...shared, responses: { ...shared.responses, 200: { description: "{results:[...]} same shape as /v1/email/validate. Unreleased.", content: { "application/json": { schema: { type: "object", required: ["results"], properties: { results: { type: "array", items: resultSchema } } } } } } } } },
    [EMAIL_DOCS_PATH]: { get: { operationId: "emailDocs", "x-unreleased": true, summary: "UNRELEASED email validation docs (flag EMAIL=1, not priced, not launched)", responses: { 200: { description: "JSON docs, released:false" } } } },
  };
}

export function emailLlmsLine(origin) {
  return `- Email validation (UNRELEASED, not priced, not launched; flag EMAIL=1): POST ${origin}${EMAIL_VALIDATE_PATH} JSON {"email":"user@example.com"} and POST ${origin}${EMAIL_BATCH_PATH} JSON {"emails":[...]} (max ${EMAIL_BATCH_MAX}). Same API key as render (x-api-key); email quota and usage are separate. Checks RFC 5322 + IDNA, MX (DNS-over-HTTPS, else an A record), disposable domains, role addresses, and typo suggestions. No SMTP in this version: checks.smtp is "not_checked" and the status is never deliverable. Docs: ${origin}${EMAIL_DOCS_PATH}\n`;
}
