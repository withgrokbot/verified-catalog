// 0.56.0 hardening (b): per-target probe timeout + per-host circuit breaker (new checks only; stored receipts and
// verdicts are never rewritten; no KV writes, no D1 writes for breaker state).
//
// Timeout: PROBE_TIMEOUT_MS (env, default 8000) is ONE budget for the whole probe of a target (every redirect hop plus
// reading the body). Before 0.56.0 the 8000 ms applied per fetch hop (up to 4 hops) and the body read had no limit.
// A probe that runs out of time is recheck/timeout, never pay.
//
// Breaker: BREAKER_FAILS (default 3) failed probes of one host (HTTP 5xx, timeout, connection error) within
// BREAKER_WINDOW_MIN (default 10) with no successful probe in between open the breaker for BREAKER_COOLDOWN_MIN
// (default 15). While open, a new check of any URL on that host answers recheck/host_unstable straight away: the target
// is not fetched, no free check is used, nothing is charged or settled. After the cooldown exactly one check (per
// isolate/colo, see below) is let through as the half-open probe: success closes the breaker, another failure re-opens
// it for a full cooldown. BREAKER_FAILS=0 turns the breaker off.
// Not failures (never counted): SSRF blocks, DNS errors (own 0.55.0 path), 429, 403/WAF, any other 2xx-4xx answer
// (those count as a success), and our own concurrency cap.
//
// State store: per-isolate memory (Map) written through to the Cloudflare Cache API (caches.default, local to one
// data center, shared by every isolate there). Not D1 and no KV: the state is short-lived (<= window/cooldown),
// losing it only means a few more probes, and it must not add a database write to every failing probe. A Cache API
// miss/error falls back to memory; any store error fails open (the probe runs as before). The cache key is a synthetic
// URL under our own API origin that is only ever used as a cache key (never fetched); the Worker answers 404 to any
// /__breaker path on every host and method (isBreakerPath, checked first in lib.js), and never serves Cache API
// entries to clients.
//
// Audit (review): ONE D1 row per transition in breaker_events (migration 0021): opened, half_open_failed, closed. An
// answer while the breaker is open writes nothing (no receipt either). Dedupe: the transition is decided on the shared
// per-colo Cache API state (a second isolate sees "already open" and records nothing), and the row id is a
// deterministic key written with INSERT OR IGNORE (opened: host + cooldown-sized time bucket; the others: host + the
// episode's opened_at), so racing isolates collapse to one row. Residual: two colos (separate caches) can each record
// their own transitions, and two isolates racing an "opened" across a bucket boundary can write 2 rows. The write is
// awaited inside try/catch and never fails or changes the answer.
//
// 0.55.0 transient fallback: host_unstable is NEUTRAL. It is not one of the TRANSIENT codes, so it never starts or
// extends a *_persistent streak and is never turned into a skip; and STREAK_SQL ignores it, so it does not break a
// running 429/WAF/DNS streak either (see transient.js). The breaker's own cooldown bounds how long it can last.

export const PROBE_TIMEOUT_MS_DEFAULT = 8000;
export const PROBE_TIMEOUT_MS_MIN = 1000;
export const PROBE_TIMEOUT_MS_MAX = 30000;
export const BREAKER_FAILS_DEFAULT = 3;
export const BREAKER_WINDOW_MIN_DEFAULT = 10;
export const BREAKER_COOLDOWN_MIN_DEFAULT = 15;
export const BREAKER_MEM_MAX = 5000; // hosts kept in one isolate's memory (oldest dropped first)
export const BREAKER_KEY_ORIGIN = "https://api.402xagent.com/__breaker/v1/"; // cache key namespace only, never fetched

const num = (raw) => (raw === undefined || raw === null || String(raw).trim() === "" ? NaN : Number(String(raw).trim()));

/** PROBE_TIMEOUT_MS from env: whole milliseconds in [1000, 30000]; anything else -> 8000. */
export function probeTimeoutMs(env) {
  const n = num(env && env.PROBE_TIMEOUT_MS);
  return Number.isInteger(n) && n >= PROBE_TIMEOUT_MS_MIN && n <= PROBE_TIMEOUT_MS_MAX ? n : PROBE_TIMEOUT_MS_DEFAULT;
}

/** Breaker knobs from env. BREAKER_FAILS integer 0..100 (0 = off); window/cooldown minutes in (0, 1440]. */
export function breakerCfg(env) {
  const f = num(env && env.BREAKER_FAILS);
  const w = num(env && env.BREAKER_WINDOW_MIN);
  const c = num(env && env.BREAKER_COOLDOWN_MIN);
  const fails = Number.isInteger(f) && f >= 0 && f <= 100 ? f : BREAKER_FAILS_DEFAULT;
  const windowMin = Number.isFinite(w) && w > 0 && w <= 1440 ? w : BREAKER_WINDOW_MIN_DEFAULT;
  const cooldownMin = Number.isFinite(c) && c > 0 && c <= 1440 ? c : BREAKER_COOLDOWN_MIN_DEFAULT;
  const timeoutMs = probeTimeoutMs(env);
  return { enabled: fails > 0, fails, windowMin, cooldownMin, windowMs: windowMin * 60000, cooldownMs: cooldownMin * 60000, leaseMs: 2 * timeoutMs + 5000 };
}

/** What one live probe says about its host: "fail" (5xx, timeout, connection error), "ok" (any other HTTP answer), or null (not about the host). */
export function breakerOutcome(probe) {
  if (!probe || probe.ssrf_blocked || probe.dns_error || probe.host_unstable) return null;
  if (probe.reachable) return Number(probe.http_status) >= 500 ? "fail" : "ok";
  const err = String(probe.error || "");
  if (/^fetch (timeout|failed)/.test(err)) return "fail";
  return null; // our own concurrency cap, redirect bookkeeping, ...
}

/** Kind of a failed probe for the audit row: server_error | timeout | connection_error (null when not a failure). */
export function breakerFailKind(probe) {
  if (breakerOutcome(probe) !== "fail") return null;
  if (probe.reachable) return "server_error";
  return /timeout/.test(String(probe.error || "")) ? "timeout" : "connection_error";
}

/** 0.56.0 review: /__breaker (any case, percent-encoded, doubled slashes, any segment) is never a client route. */
export function isBreakerPath(pathname) {
  let p = String(pathname || "");
  for (let i = 0; i < 4; i++) { let d; try { d = decodeURIComponent(p); } catch (_) { break; } if (d === p) break; p = d; }
  p = p.replace(/\\/g, "/").toLowerCase();
  return p.split("/").some((seg) => seg.trim() === "__breaker");
}

export const BREAKER_AUDIT_VERSION = "0.56.0";
export const BREAKER_EVENT_SQL =
  "INSERT OR IGNORE INTO breaker_events (id, host, event, at, opened_at, open_until, fail_count, last_fail_kind, last_status, trips, worker_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** One audit row per transition. Never throws; no store = no row. */
async function audit(env, host, event, episode, row) {
  const db = env && env.RECEIPTS_DB;
  if (!db) return false;
  try {
    const id = "be:" + (await sha(host + "|" + event + "|" + episode));
    await db.prepare(BREAKER_EVENT_SQL).bind(id, host, event, isoS(row.at), row.opened_at ? isoS(row.opened_at) : null, row.open_until ? isoS(row.open_until) : null,
      row.fail_count || 0, row.last_fail_kind || null, row.last_status == null ? null : Number(row.last_status), row.trips || 0, BREAKER_AUDIT_VERSION).run();
    return true;
  } catch (_) {
    return false; // never fails the request
  }
}

/** Lower-case hostname of a URL, or null. */
export function breakerHost(u) {
  try { return new URL(String(u)).hostname.toLowerCase() || null; } catch (_) { return null; }
}

const mem = new Map();
export function _resetBreakers() { mem.clear(); }

function cacheOf(env) {
  if (env && env.BREAKER_CACHE !== undefined) return env.BREAKER_CACHE; // tests (null = no Cache API)
  try { return (globalThis.caches && globalThis.caches.default) || null; } catch (_) { return null; }
}
async function cacheKey(host) {
  return BREAKER_KEY_ORIGIN + (await sha(host));
}
async function load(env, host) {
  const m = mem.get(host) || null;
  const cache = cacheOf(env);
  let c = null;
  if (cache) {
    try { const r = await cache.match(await cacheKey(host)); c = r ? await r.json() : null; } catch (_) { c = null; }
  }
  if (!m) return c;
  if (!c) return m;
  return (c.v || 0) >= (m.v || 0) ? c : m; // newest write wins
}
async function save(env, host, st, cfg) {
  if (mem.has(host)) mem.delete(host);
  mem.set(host, st);
  while (mem.size > BREAKER_MEM_MAX) mem.delete(mem.keys().next().value);
  const cache = cacheOf(env);
  if (!cache) return;
  const ttl = Math.ceil((Math.max(cfg.windowMs, cfg.cooldownMs) + cfg.leaseMs) / 1000) + 60;
  try {
    await cache.put(await cacheKey(host), new Response(JSON.stringify(st), { headers: { "content-type": "application/json", "cache-control": "max-age=" + ttl } }));
  } catch (_) { /* memory still has it */ }
}
async function clear(env, host) {
  mem.delete(host);
  const cache = cacheOf(env);
  if (cache) { try { await cache.delete(await cacheKey(host)); } catch (_) {} }
}

const isoS = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
function info(st, cfg, now, state) {
  return {
    state,
    opened_at: st.opened_at ? isoS(st.opened_at) : null,
    retry_after_s: Math.max(1, Math.ceil(((state === "open" ? st.open_until : st.probe_until) - now) / 1000)),
    fails_to_open: cfg.fails,
    window_min: cfg.windowMin,
    cooldown_min: cfg.cooldownMin,
  };
}

/**
 * Before a live probe of host. Returns { allow, half_open, breaker }: allow=false -> answer recheck/host_unstable without
 * fetching (breaker = public info). half_open=true -> this probe decides whether the breaker closes. Fails open.
 */
export async function breakerGate(env, host, now = Date.now()) {
  const cfg = breakerCfg(env);
  if (!cfg.enabled || !host) return { allow: true, half_open: false, breaker: null };
  let st;
  try { st = await load(env, host); } catch (_) { st = null; }
  if (!st || !st.open_until) return { allow: true, half_open: false, breaker: null };
  if (now < st.open_until) return { allow: false, half_open: false, breaker: info(st, cfg, now, "open") };
  if (st.probe_until && now < st.probe_until) return { allow: false, half_open: false, breaker: info(st, cfg, now, "half_open") };
  try { await save(env, host, { ...st, v: now, probe_until: now + cfg.leaseMs }, cfg); } catch (_) {}
  return { allow: true, half_open: true, breaker: null };
}

/**
 * After a live probe of host. outcome = breakerOutcome(probe); kind/status = breakerFailKind(probe) / probe.http_status.
 * Returns the new state: "closed" | "counting" | "open". Writes one breaker_events row per transition. Never throws.
 */
export async function breakerRecord(env, host, outcome, { halfOpen = false, kind = null, status = null } = {}, now = Date.now()) {
  const cfg = breakerCfg(env);
  if (!cfg.enabled || !host) return "closed";
  try {
    const st = await load(env, host);
    if (outcome === "ok") {
      if (!st) return "closed";
      await clear(env, host);
      if (st.open_until) await audit(env, host, "closed", String(st.opened_at || 0), { at: now, opened_at: st.opened_at, fail_count: 0, trips: st.trips || 0 });
      return "closed";
    }
    if (outcome === "fail") {
      const last_status = Number(status) >= 500 ? Number(status) : null;
      if (st && st.open_until && now < st.open_until && !halfOpen) return "open"; // already open (a probe that started before it opened)
      if (halfOpen || (st && st.open_until)) { // the half-open probe failed: a full new cooldown
        const next = { v: now, fails: [], open_until: now + cfg.cooldownMs, opened_at: now, probe_until: 0, trips: ((st && st.trips) || 0) + 1, last_kind: kind, last_status };
        await save(env, host, next, cfg);
        await audit(env, host, "half_open_failed", String((st && st.opened_at) || 0), { at: now, opened_at: now, open_until: next.open_until, fail_count: 1, last_fail_kind: kind, last_status, trips: next.trips });
        return "open";
      }
      const fails = ((st && st.fails) || []).filter((t) => t > now - cfg.windowMs).concat(now);
      if (fails.length >= cfg.fails) {
        const next = { v: now, fails: [], open_until: now + cfg.cooldownMs, opened_at: now, probe_until: 0, trips: ((st && st.trips) || 0) + 1, last_kind: kind, last_status };
        await save(env, host, next, cfg);
        await audit(env, host, "opened", String(Math.floor(now / cfg.cooldownMs)), { at: now, opened_at: now, open_until: next.open_until, fail_count: fails.length, last_fail_kind: kind, last_status, trips: next.trips });
        return "open";
      }
      await save(env, host, { v: now, fails, open_until: 0, opened_at: 0, probe_until: 0, trips: (st && st.trips) || 0, last_kind: kind, last_status }, cfg);
      return "counting";
    }
    // outcome null: says nothing about the host. A half-open probe that ended this way hands the lease back.
    if (halfOpen && st) await save(env, host, { ...st, v: now, probe_until: 0 }, cfg);
    return st && st.open_until ? "open" : st && st.fails && st.fails.length ? "counting" : "closed";
  } catch (_) {
    return "closed";
  }
}

/** The probe-shaped answer used while the breaker is open (never fetched). */
export function hostUnstableProbe(breaker) {
  return {
    reachable: false, http_status: null, latency_ms: 0, ssrf_blocked: false, host_unstable: true, breaker,
    error: "host circuit breaker open: recent probes of this host failed (5xx, timeout or connection error); not fetched",
    x402_challenge: false, accepts: [], quoted_price_usd: null, known_answer: null, body_truncated: false,
  };
}
