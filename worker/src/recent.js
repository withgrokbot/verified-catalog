import { isPlaceholderUrl } from "./ops.js";
import { freshnessFor, termsMaxAgeHours } from "./freshness.js"; // 0.54.0
// Shared short reason texts (no prices). 0.24.0: used by redacted receipts and the free answer's plain reason.
export const REASON_TEXT = {
  // 0.27.0: plain words, one line; codes unchanged. Rechecks say "try again", skips say what we saw.
  no_x402: "no x402 payment request at this URL",
  no_paywall: "no x402 payment request at this URL",
  server_error: "endpoint returned a server error, try again shortly",
  network_unsupported: "wants payment on a testnet or a network we don't support",
  free_trial_active: "seller says a free trial is active, so there is no price to check yet, try again later",
  price_mismatch: "asks a different price than listed",
  timeout: "endpoint did not answer in time, try again shortly",
  unreachable: "could not reach the endpoint, try again shortly",
  ambiguous: "payment request is unclear",
  bad_challenge: "payment request has no readable USDC price",
  challenge_expired: "payment terms are expired or expire within seconds (opt-in check)",
  price_ok: "payment request matches the listed price",
  price_below_listing: "live price lower than listed",
  network_mismatch: "asks for payment on a different network than listed",
  pay_to_mismatch: "pays a different wallet than listed",
  asset_not_usdc: "asks for a token other than USDC",
  ssrf_blocked: "private or local address, not checked",
  delivery_failed: "our latest paid call to this endpoint was charged but did not deliver a usable response, try again later",
  // 0.54.0 terms freshness (freshness.js)
  terms_changed_since_quote: "live payment terms differ from the quote you were given, check again without quote to approve the new terms",
  terms_stale: "payment terms are older than our freshness limit, run the live check right before paying",
  // 0.55.0 skip-reason tuning (transient.js)
  rate_limited: "endpoint is rate limiting us (HTTP 429), try again later",
  waf_challenge: "a firewall or bot challenge (HTTP 403) blocked our unpaid probe, try again later",
  dns_error: "the endpoint's domain did not resolve (DNS, retried once), try again later",
  rate_limited_persistent: "endpoint has only answered HTTP 429 (rate limited) for longer than our retry window (default 24 h)",
  waf_blocked_persistent: "a firewall or bot challenge (HTTP 403) has blocked every probe for longer than our retry window (default 24 h)",
  dns_error_persistent: "the endpoint's domain has not resolved (DNS) for longer than our retry window (default 24 h)",
  // 0.56.0 per-host circuit breaker (breaker.js)
  host_unstable: "recent probes of this endpoint's host failed (server errors, timeouts or connection errors), so we paused probing it for a few minutes, try again later",
};
export const shortReason = (code) => REASON_TEXT[code] || "see receipt";

// 0.25.0: the public recent_checks list (/v1/skips.json). Only what the free answer already says: endpoint (scheme +
// host + path), verdict, a short reason without any price, UTC time, receipt link, caller tag. Stored as a flag on the
// existing D1 receipt (no KV writes). Outside free checks only; tests, bots, junk and secret-looking URLs never land.
export const RECENT_MAX = 500; // entries shown
export const RECENT_PER_DAY = 200; // published per UTC day
export const RECENT_PER_HOST_PER_DAY = 5; // one host cannot flood the list


// Own test clients / refs (mirrors app/scripts/demand_weekly.py OUR_CLIENT / OUR_REF) and our site's try-it box.
const OWN_CLIENT_RE = /^(outside-verify-|wgb-|withgrokbot|router-selftest|mx|maxverify|hermes-probe|discovery-seed|sam-selftest|agent$|hint-|ship-|beacon|daily-review|selftest|test|e2e)/i;
const OWN_REF_RE = /^(selftest|e2e-test|discovery-seed|ship-|dry-run|via-402xagent-site|x402-spotcheck$)/i;
const JUNK_HOST_RE = /(^|\.)(example\.(com|org|net)|httpbin\.org|localhost|invalid|test|local|internal|example)$|^httpbin\./i;
const SECRET_WORD_RE = /^(token|tokens|key|keys|apikey|api-key|api_key|secret|secrets|auth|session|sig|signature|password|pass|jwt|bearer|access[-_]?token)$/i;

function entropy(s) {
  const f = {};
  for (const ch of s) f[ch] = (f[ch] || 0) + 1;
  return Object.values(f).reduce((e, n) => e - (n / s.length) * Math.log2(n / s.length), 0);
}
// A path segment that could be a credential: JWT, known key prefixes, long hex, or a long high-entropy mixed string.
export function secretLike(seg) {
  const s = decodeURIComponentSafe(seg);
  if (!s) return false;
  if (/^eyJ[A-Za-z0-9_-]{10,}/.test(s)) return true;
  if (/^(sk|pk|rk|ak|ghp|gho|xox[abpr]|AKIA|AIza)[-_A-Za-z0-9]{8,}/.test(s)) return true;
  if (/^[0-9a-f]{32,}$/i.test(s)) return true;
  if (s.length >= 20 && /[0-9]/.test(s) && /[A-Za-z]/.test(s) && entropy(s) >= 3.5) return true;
  return s.length >= 40;
}
function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}
// scheme://host[:port]/path, or null when the URL must not be published.
export function publicUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch (_) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || JUNK_HOST_RE.test(h)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return null; // IP literals: never published
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.some((s, i) => secretLike(s) || (SECRET_WORD_RE.test(decodeURIComponentSafe(s)) && i < segs.length - 1))) return null;
  const path = u.pathname === "/" ? "/" : u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${path}`.slice(0, 300);
}
export function publishable({ tier, verdict, botTag, client, ref, url }) {
  if (tier !== "free") return null;
  if (!["pay", "skip", "recheck"].includes(verdict)) return null;
  if (botTag) return null; // scanner / crawler / indexer / uptime / self / example-param
  if (client && OWN_CLIENT_RE.test(client)) return null;
  if (ref && OWN_REF_RE.test(ref)) return null;
  if (isPlaceholderUrl(url)) return null; // 0.49.2: docs placeholder hosts never land in public counts/lists
  return publicUrl(url);
}
// Marks the receipt as published (one per URL per UTC day; caps per day and per host). Never throws.
export async function publishRecent(env, receiptId, pubUrl, now = new Date()) {
  if (!env.RECEIPTS_DB || !receiptId || !pubUrl) return false;
  const day = now.toISOString().slice(0, 10);
  try {
    const db = env.RECEIPTS_DB;
    const host = new URL(pubUrl).host;
    const c = await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN pub_url = ? THEN 1 ELSE 0 END) AS same, SUM(CASE WHEN pub_url LIKE ? THEN 1 ELSE 0 END) AS host FROM spot_receipts WHERE pub_day = ? AND pub_url IS NOT NULL")
      .bind(pubUrl, pubUrl.split("//")[0] + "//" + host + "/%", day).first();
    if (c && (Number(c.same) > 0 || Number(c.n) >= RECENT_PER_DAY || Number(c.host) >= RECENT_PER_HOST_PER_DAY)) return false;
    await db.prepare("UPDATE spot_receipts SET pub_url = ?, pub_day = ? WHERE id = ? AND pub_url IS NULL").bind(pubUrl, day, receiptId).run();
    return true;
  } catch (_) {
    return false; // unique (day, url) race or store error: not published, answer unaffected
  }
}
export async function recentChecks(env, origin) {
  if (!env.RECEIPTS_DB) return [];
  try {
    const { results } = await env.RECEIPTS_DB.prepare("SELECT id, pub_url, verdict, reason, created_at, check_type FROM spot_receipts WHERE pub_url IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT ?").bind(RECENT_MAX).all();
    // caller: "self-checked" for our own rows (e.g. a retagged verification call), else "outside"
    // 0.55.0: + reason_code (the stored code, e.g. rate_limited_persistent), so persistent skips list under their own code
    // 0.54.0: a pay entry carries the age of its terms and terms_stale past TERMS_MAX_AGE_HOURS (the listed verdict is history, unchanged)
    const maxH = termsMaxAgeHours(env), now = Date.now();
    return (results || []).map((r) => {
      const e = { url: r.pub_url, verdict: r.verdict, reason: shortReason(r.reason), checked_at: r.created_at, receipt_url: origin + "/v1/receipts/" + r.id, caller: r.check_type === "self-checked" ? "self-checked" : "outside" , reason_code: r.reason};
      if (r.verdict !== "pay") return e;
      const f = freshnessFor("pay", r.created_at, maxH, now);
      return { ...e, terms_age_hours: f.terms_age_hours, terms_stale: f.terms_stale };
    });
  } catch (_) {
    return [];
  }
}
