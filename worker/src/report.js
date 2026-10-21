// 0.46.0 locked teasers + commitments + endpoint report (Part A; Max-approved plan docs/plan-locked-teasers.md).
// Free answers get `locked` (drift count + hygiene grade, nothing else) and `locked_commitments`: per locked item a
// sha256 over the RFC 8785 JCS of {snapshot, nonce} (32-byte nonce). The paid endpoint report reveals EXACTLY the committed
// snapshot + nonce (stored in D1 `commitments`, 30-day TTL); newer data only ever goes under `current`.
// No RPC anywhere here. The free path costs at most one D1 write (INSERT OR IGNORE; dedupe by a keyed hash, no read).
import { canonicalize } from "./sign.js";

export const ER_ID = "endpoint-report";
export const ER_ROUTE_PATH = "/v1/products/endpoint-report";
export const ER_PAID_ATOMIC = "50000"; // $0.05, everyone (Max 2026-10-21)
export const ER_PRICE_USD = "0.05";
export const ER_RECEIPT_RE = /^er-[0-9a-f]{16}$/;
export const COMMIT_TTL_DAYS = 30;
export const COMMIT_PERIOD_DAYS = 15; // dedupe window: a ref is reused inside one period, so every served ref has >= 15 days left
export const DRIFT_WINDOW_DAYS = 30;
export const COMMIT_KEYS = Object.freeze(["drift_history", "hygiene_detail"]);
const DAY = 86400000;

// Grades (Max 2026-10-21). quality_unverified is not a letter: "–" plus a reason.
export const GRADES = Object.freeze({
  quality_ok: { grade: "A" },
  quality_unverified: { grade: "–", reason: "nothing to validate: no output schema (or no sample) declared" },
  quality_bad_content_type: { grade: "C" },
  quality_schema_mismatch: { grade: "D" },
  quality_bad_status: { grade: "F" },
  quality_unreachable: { grade: "F" },
});
export const gradeFor = (code) => GRADES[code] || null;

const enc = (s) => new TextEncoder().encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(s) { return hex(await crypto.subtle.digest("SHA-256", enc(s))); }
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc(msg)));
}
const randHex = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return hex(b); };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// ---- drift: term-bearing observations (newest first, as endpoint_history returns them)
const TERM_FIELDS = [["price", "amount_atomic"], ["pay_to", "pay_to"], ["network", "network"], ["asset", "asset"]];
const hasTerms = (o) => o && o.amount_atomic != null && o.network && o.pay_to;
const norm = (f, v) => (v == null ? null : f === "amount_atomic" ? String(v) : String(v).toLowerCase());
function changedFields(newer, older) {
  return TERM_FIELDS.filter(([, f]) => norm(f, newer[f]) !== norm(f, older[f])).map(([name]) => name);
}
const termsView = (o) => ({ price_usd: o.price_usd ?? null, amount_atomic: o.amount_atomic != null ? String(o.amount_atomic) : null, pay_to: o.pay_to || null, network: o.network || null, asset: o.asset || null });
// Full change list inside the window (paid only). capped = the stored history (30 rows) may not reach back 30 days.
export function driftSnapshot(list, now = new Date(), keep = 30) {
  const rows = (list || []).filter(Boolean);
  const since = now.getTime() - DRIFT_WINDOW_DAYS * DAY;
  const terms = rows.filter(hasTerms);
  const changes = [];
  for (let i = 0; i + 1 < terms.length; i++) {
    const t = Date.parse(terms[i].observed_at);
    if (!(t >= since)) break;
    const fields = changedFields(terms[i], terms[i + 1]);
    if (fields.length) changes.push({ observed_at: terms[i].observed_at, fields, from: termsView(terms[i + 1]), to: termsView(terms[i]) });
  }
  const inWindow = rows.filter((o) => Date.parse(o.observed_at) >= since).length;
  const oldest = rows.length ? Date.parse(rows[rows.length - 1].observed_at) : null;
  return { window_days: DRIFT_WINDOW_DAYS, observations: inWindow, capped: rows.length >= keep && oldest != null && oldest >= since, changes };
}
// Teaser: a count only. Never which fields or when.
export function driftTeaser(list, now = new Date()) {
  const rows = (list || []).filter(Boolean);
  if (rows.filter(hasTerms).length < 2) return { teaser: "no data yet", count_30d: null };
  const s = driftSnapshot(rows, now);
  const n = s.changes.length;
  return { teaser: `${s.capped ? "≥" : ""}${n} change${n === 1 ? "" : "s"} in ${DRIFT_WINDOW_DAYS}d`, count_30d: n };
}

// ---- hygiene: one shape for a live probe (qualityFor) and a stored endpoint_quality row
export function hygieneSnapshot(src, observedAt = null) {
  if (!src || !src.code) return null;
  const c = src.checks || src;
  const g = gradeFor(src.code) || { grade: null };
  return {
    grade: g.grade, ...(g.reason ? { reason: g.reason } : {}), code: src.code,
    checks: { http_status: c.http_status ?? null, content_type: c.content_type ?? null, body_bytes: c.body_bytes ?? null, schema_declared: c.schema_declared == null ? null : !!c.schema_declared, schema_match: c.schema_match == null ? null : !!c.schema_match },
    observed_at: src.observed_at || observedAt || null,
  };
}
export function hygieneTeaser(snap) {
  if (!snap || !snap.grade) return { grade: null, reason: "no data yet" };
  return snap.reason ? { grade: snap.grade, reason: snap.reason } : { grade: snap.grade };
}

// ---- commitments
export async function digestOf(snapshot, nonce) {
  return "sha256:" + (await sha256Hex(canonicalize({ snapshot, nonce })));
}
// Verify procedure (also published in /docs#endpoint-report): recompute each digest from the revealed {snapshot, nonce}.
export async function verifyReveal(commitments, revealed) {
  const out = {};
  for (const k of COMMIT_KEYS) {
    if (!commitments || !commitments[k]) continue;
    const r = revealed && revealed[k];
    out[k] = !!(r && typeof r.nonce === "string" && /^[0-9a-f]{64}$/.test(r.nonce) && (await digestOf(r.snapshot, r.nonce)) === commitments[k]);
  }
  return out;
}
// One INSERT OR IGNORE (no read). With COMMIT_SECRET (or CLIENT_SALT) the ref and nonces are a keyed hash of
// (endpoint, snapshot, period), so identical snapshots in one 15-day period share a ref; without a secret: random, no dedupe.
export async function commitSnapshots(env, { hk, url, snapshots, now = new Date() }) {
  const db = env && env.RECEIPTS_DB;
  if (!db || !hk) return null;
  try {
    const secret = env.COMMIT_SECRET || env.CLIENT_SALT || "";
    const canon = canonicalize(snapshots);
    let ref, nonces = {}, createdMs;
    if (secret) {
      const period = Math.floor(now.getTime() / (COMMIT_PERIOD_DAYS * DAY));
      createdMs = period * COMMIT_PERIOD_DAYS * DAY;
      const base = await hmacHex(secret, `commit|${hk}|${await sha256Hex(canon)}|${period}`);
      ref = "cm-" + base.slice(0, 16);
      for (const k of COMMIT_KEYS) nonces[k] = await hmacHex(secret, `nonce|${base}|${k}`);
    } else {
      createdMs = now.getTime();
      ref = "cm-" + randHex(8);
      for (const k of COMMIT_KEYS) nonces[k] = randHex(32);
    }
    const expiresAt = iso(createdMs + COMMIT_TTL_DAYS * DAY);
    const digests = {};
    for (const k of COMMIT_KEYS) digests[k] = await digestOf(snapshots[k] ?? null, nonces[k]);
    await db.prepare("INSERT OR IGNORE INTO commitments (ref, hkey, url, created_at, expires_at, digests, snapshots, nonces) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(ref, hk, url, iso(createdMs), expiresAt, JSON.stringify(digests), canon, JSON.stringify(nonces)).run();
    return { ref, expires_at: expiresAt, alg: "sha256(JCS({snapshot, nonce})), nonce = 32 bytes hex", ...digests };
  } catch (_) {
    return null; // never publish a commitment we could not store
  }
}
export async function loadCommitment(env, ref, now = new Date()) {
  const db = env && env.RECEIPTS_DB;
  if (!db || !/^cm-[0-9a-f]{16}$/.test(String(ref || ""))) return null;
  const row = await db.prepare("SELECT ref, hkey, url, created_at, expires_at, digests, snapshots, nonces FROM commitments WHERE ref = ?").bind(ref).first();
  if (!row || !(Date.parse(row.expires_at) > now.getTime())) return null;
  return { ref: row.ref, hkey: row.hkey, url: row.url, created_at: row.created_at, expires_at: row.expires_at, digests: JSON.parse(row.digests), snapshots: JSON.parse(row.snapshots), nonces: JSON.parse(row.nonces) };
}
export async function pruneCommitments(env, now = new Date()) {
  try { await env.RECEIPTS_DB.prepare("DELETE FROM commitments WHERE expires_at < ?").bind(iso(now.getTime())).run(); } catch (_) {}
}

// ---- free-answer block (whitelisted keys only; values are integers, enums or fixed strings)
export function lockedBlock({ history, quality, url, commitments, enabled, apiOrigin, canonOrigin, now = new Date() }) {
  const d = driftTeaser(history && history.list, now);
  const h = hygieneTeaser(hygieneSnapshot(quality));
  return {
    drift: { teaser: d.teaser, count_30d: d.count_30d },
    hygiene: h,
    unlock: {
      available: !!enabled,
      method: "POST",
      url: apiOrigin + ER_ROUTE_PATH,
      price_usd: ER_PRICE_USD,
      body: { url, ...(commitments ? { commitment_ref: commitments.ref } : {}) },
      what: "the exact committed snapshots behind these teasers (which terms changed, when, from what to what; the full hygiene checks)",
      docs: canonOrigin + "/docs#endpoint-report",
    },
  };
}

// ---- receipt v2 compact block (additive, signed with the receipt)
export function diffOf(exp, probe, pm0) {
  const out = [];
  const acc = pm0 || null;
  if (exp && exp.claimed != null && probe && probe.quoted_price_usd != null && Math.abs(Number(probe.quoted_price_usd) - Number(exp.claimed)) > Math.max(1e-9, Number(exp.claimed) * 0.01))
    out.push({ field: "price", listed: String(exp.claimed), observed: String(probe.quoted_price_usd) });
  const a = acc || ((probe && probe.accepts) || []).find((x) => x && x.payTo) || null;
  const payTo = a ? a.pay_to || a.payTo : null;
  if (exp && exp.pay_to && payTo && String(exp.pay_to).toLowerCase() !== String(payTo).toLowerCase()) out.push({ field: "pay_to", listed: exp.pay_to, observed: payTo });
  const net = a ? a.network : null;
  if (exp && exp.network && net && String(exp.network) !== String(net) && !(exp.network === "base" && net === "eip155:8453")) out.push({ field: "network", listed: exp.network, observed: net });
  return out;
}
export async function receiptV2({ probe, exp, pm0, listing, history, quality, ptc, method, url, normalized, crawlMeta }) {
  const g = quality ? gradeFor(quality.code) : null;
  const uncertain = [];
  if (!history || (history.observations || 0) < 2) uncertain.push({ what: "drift", why: "insufficient_history" });
  if (quality && quality.code === "quality_unverified") uncertain.push({ what: "hygiene", why: "nothing_to_validate" });
  if (probe && probe.error) uncertain.push({ what: "terms", why: String(probe.error).slice(0, 60) });
  const src = exp && exp.source === "listing" && listing
    ? { list: listing.source_list || null, crawl_id: listing.id || null, crawl_date: listing.timestamp ? String(listing.timestamp).slice(0, 10) : crawlMeta || null }
    : { list: exp && exp.source ? exp.source : null, crawl_id: null, crawl_date: null };
  return {
    x402_version: probe && probe.x402_version != null ? probe.x402_version : null,
    valid_before: ((probe && probe.accepts) || []).map((a) => (a && a.validBefore != null ? a.validBefore : null)),
    diff: diffOf(exp, probe, pm0),
    latency_ms: probe && Number.isFinite(probe.latency_ms) ? probe.latency_ms : null,
    request_sha256: await sha256Hex(canonicalize({ method: String(method || "GET").toUpperCase(), url: normalized || url, claimed_price: exp ? exp.claimed ?? null : null, pay_to: exp ? exp.pay_to ?? null : null, network: exp ? exp.network ?? null : null })),
    supersedes: (ptc && ptc.supersedes) || null,
    uncertain,
    source_vintage: src,
    hygiene_grade: g ? g.grade : null,
  };
}
