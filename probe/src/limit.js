// Per-MX: at most 2 connections at once, and a few probes per minute (default 4, never more than 6).
// A 4xx starts a backoff that doubles from 60s up to 15 minutes. One process-wide counter caps the UTC day.
const CEIL_CONCURRENCY = 2;
const CEIL_PER_MIN = 6;
const DEFAULT_PER_MIN = 4;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

export function readDailyCap(env) {
  if (!env || env.PROBE_DAILY_CAP == null || env.PROBE_DAILY_CAP === "") return 300;
  const n = Number(env.PROBE_DAILY_CAP);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return 300;
  return Math.floor(n);
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function createLimiter(opts = {}) {
  const dailyCap = clampInt(opts.dailyCap, 0, 1_000_000, 300);
  const perMinute = clampInt(opts.perMinute, 1, CEIL_PER_MIN, DEFAULT_PER_MIN);
  const maxConcurrent = clampInt(opts.maxConcurrent, 1, CEIL_CONCURRENCY, CEIL_CONCURRENCY);
  const now = opts.now || (() => Date.now());
  const hosts = new Map();
  let daily = (opts.loadDaily && opts.loadDaily()) || { day: "", count: 0 };
  if (!daily || typeof daily.day !== "string" || !Number.isInteger(daily.count) || daily.count < 0) daily = { day: "", count: 0 };
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const state = (host) => {
    let s = hosts.get(host);
    if (!s) { s = { inFlight: 0, stamps: [], backoffUntil: 0, backoffMs: BACKOFF_START_MS }; hosts.set(host, s); }
    return s;
  };
  const persist = () => { if (opts.saveDaily) opts.saveDaily({ day: daily.day, count: daily.count }); };
  return {
    dailyCap, perMinute, maxConcurrent,
    tryAcquire(host, t = now()) {
      const day = dayOf(t);
      if (daily.day !== day) { daily = { day, count: 0 }; persist(); }
      if (daily.count >= dailyCap) return { ok: false, reason: "daily_cap" };
      const s = state(host);
      if (t < s.backoffUntil) return { ok: false, reason: "mx_backoff" };
      if (s.inFlight >= maxConcurrent) return { ok: false, reason: "mx_busy" };
      const start = t - 60_000;
      s.stamps = s.stamps.filter((x) => x > start);
      if (s.stamps.length >= perMinute) return { ok: false, reason: "mx_rate" };
      s.inFlight += 1;
      s.stamps.push(t);
      daily.count += 1;
      persist();
      let released = false;
      return { ok: true, release() { if (!released) { released = true; s.inFlight -= 1; } } };
    },
    note4xx(host, t = now()) {
      const s = state(host);
      s.backoffUntil = t + s.backoffMs;
      s.backoffMs = Math.min(BACKOFF_MAX_MS, s.backoffMs * 2);
    },
    noteClear(host) {
      const s = state(host);
      s.backoffMs = BACKOFF_START_MS;
      s.backoffUntil = 0;
    },
  };
}
