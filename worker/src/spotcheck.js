// Endpoint spot-check: SSRF-safe probe of a public URL for an x402 PAYMENT-REQUIRED challenge.
// NEVER sends PAYMENT-SIGNATURE / X-PAYMENT / settles to the target. Probe only (GET/HEAD).

export const SPOT_ID = "endpoint-spot-check";
export const SPOT_SERVICE_NAME = "x402 Endpoint Spot-Check";
export const SPOT_TAGS = ["x402", "spot-check", "probe", "catalog", "agents"];
export const SPOT_DEFAULT_PRICE_ATOMIC = "250000"; // $0.25 USDC
export const SPOT_DEFAULT_FREE_PER_DAY = 1;
export const SPOT_PAID_PER_HOUR = 30;
export const SPOT_FETCH_TIMEOUT_MS = 8000;
export const SPOT_MAX_BODY = 65536;
export const SPOT_MAX_REDIRECTS = 3;
export const SPOT_MAX_CONCURRENT = 4;
export const SPOT_QUOTA_COUNTER = "spotcheck";
export const SPOT_RATE_COUNTER = "spotcheck-paid-h";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
  "metadata",
]);

let inflight = 0;

export function _resetSpotInflight() {
  inflight = 0;
}

function ipv4Parts(ip) {
  const p = String(ip).split(".").map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return p;
}

export function isBlockedIPv4(ip) {
  const p = ipv4Parts(ip);
  if (!p) return false;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10 (treat as private)
  return false;
}

function expandIPv6(ip) {
  let s = String(ip).toLowerCase().trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  // strip zone id
  s = s.split("%")[0];
  // IPv4-mapped
  const v4map = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4map) return { mapped4: v4map[1], parts: null };
  const halves = s.split("::");
  let head = halves[0] ? halves[0].split(":") : [];
  let tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  if (halves.length > 2) return null;
  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const full = [...head, ...Array(missing).fill("0"), ...tail].map((h) => parseInt(h || "0", 16));
  if (full.length !== 8 || full.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
  return { mapped4: null, parts: full };
}

export function isBlockedIPv6(ip) {
  const ex = expandIPv6(ip);
  if (!ex) return true; // unparseable -> block
  if (ex.mapped4) return isBlockedIPv4(ex.mapped4);
  const p = ex.parts;
  // ::1
  if (p.every((x, i) => (i === 7 ? x === 1 : x === 0))) return true;
  // :: (unspecified)
  if (p.every((x) => x === 0)) return true;
  // fc00::/7 unique local
  if ((p[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((p[0] & 0xffc0) === 0xfe80) return true;
  return false;
}

export function isBlockedIp(ip) {
  if (!ip) return true;
  const s = String(ip).trim();
  if (ipv4Parts(s)) return isBlockedIPv4(s);
  if (s.includes(":")) return isBlockedIPv6(s);
  // Not an IP literal (e.g. leftover hostname) — treat as blocked when used as an address check.
  return true;
}

export function hostnameBlocked(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true;
  // bare IP as hostname
  if (ipv4Parts(h)) return isBlockedIPv4(h);
  if (h.includes(":")) return isBlockedIPv6(h);
  return false;
}

/** Resolve A/AAAA via Cloudflare DoH. Injectable for tests. */
export async function resolveHost(hostname, fetchImpl = fetch) {
  const name = String(hostname).toLowerCase().replace(/\.$/, "");
  if (ipv4Parts(name)) return [name];
  if (name.includes(":")) return [name];
  const out = [];
  for (const type of ["A", "AAAA"]) {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
    const want = type === "A" ? 1 : 28;
    try {
      const r = await fetchImpl(url, { headers: { accept: "application/dns-json" }, cf: { cacheTtl: 30 } });
      if (!r.ok) continue;
      const j = await r.json();
      for (const ans of j.Answer || []) {
        // Only A/AAAA address records — ignore CNAMEs (type 5) so hostnames are never treated as IPs.
        if (!ans || ans.type !== want || typeof ans.data !== "string") continue;
        const data = ans.data.replace(/\.$/, "");
        if (type === "A" && ipv4Parts(data)) out.push(data);
        if (type === "AAAA" && data.includes(":")) out.push(data);
      }
    } catch (_) {
      /* ignore DoH failures; caller may still block on empty */
    }
  }
  return [...new Set(out)];
}

/**
 * Validate URL for outbound probe. Returns { ok, url?, reason?, ssrf_blocked? }.
 * resolveHostFn optional for tests.
 */
export async function assertSafeUrl(raw, { resolveHostFn = resolveHost, fetchImpl = fetch } = {}) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch (_) {
    return { ok: false, ssrf_blocked: true, reason: "invalid url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, ssrf_blocked: true, reason: "only http/https allowed" };
  }
  if (u.username || u.password) {
    return { ok: false, ssrf_blocked: true, reason: "url credentials not allowed" };
  }
  const host = u.hostname;
  if (hostnameBlocked(host)) {
    return { ok: false, ssrf_blocked: true, reason: "blocked host or private address" };
  }
  const addrs = await resolveHostFn(host, fetchImpl);
  if (!addrs.length) {
    // Fail closed when we cannot resolve (avoids blind fetch to unknown)
    return { ok: false, ssrf_blocked: true, reason: "dns resolve failed or empty" };
  }
  for (const a of addrs) {
    if (isBlockedIp(a)) {
      return { ok: false, ssrf_blocked: true, reason: "url resolves to a private or link-local address" };
    }
  }
  return { ok: true, url: u };
}

function atomicToUsd(atomic) {
  const n = Number(atomic);
  if (!Number.isFinite(n)) return null;
  return Number((n / 1e6).toFixed(6));
}

/** Summarize x402 accepts entries (v1 or v2 shapes). */
export function summarizeAccepts(accepts) {
  if (!Array.isArray(accepts)) return [];
  return accepts.slice(0, 8).map((a) => {
    if (!a || typeof a !== "object") return { raw: true };
    const amount = a.amount ?? a.maxAmountRequired ?? null;
    return {
      scheme: a.scheme || null,
      network: a.network || null,
      asset: a.asset || null,
      amount: amount != null ? String(amount) : null,
      payTo: a.payTo || null,
      amount_usd: amount != null ? atomicToUsd(amount) : null,
    };
  });
}

export function parseX402Challenge({ status, headers, bodyText }) {
  let challenge = null;
  const pr = headers.get("payment-required") || headers.get("PAYMENT-REQUIRED") || "";
  if (pr) {
    try {
      const bin = atob(String(pr).trim());
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      challenge = JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
      challenge = null;
    }
  }
  let bodyObj = null;
  if (bodyText) {
    try {
      bodyObj = JSON.parse(bodyText);
    } catch (_) {
      bodyObj = null;
    }
  }
  if (!challenge && bodyObj && (bodyObj.accepts || bodyObj.x402Version || bodyObj.error === "payment_required")) {
    challenge = bodyObj;
  }
  const present = !!(challenge && (Array.isArray(challenge.accepts) || challenge.x402Version || status === 402));
  const accepts = summarizeAccepts((challenge && challenge.accepts) || (bodyObj && bodyObj.accepts) || []);
  let quoted = null;
  if (accepts.length && accepts[0].amount_usd != null) quoted = accepts[0].amount_usd;
  else if (bodyObj && bodyObj.price != null) {
    const m = String(bodyObj.price).replace(/[^0-9.]/g, "");
    const n = Number(m);
    if (Number.isFinite(n)) quoted = n;
  }
  const shapeValid =
    present &&
    accepts.length > 0 &&
    accepts.some((a) => a.scheme && a.network && (a.asset || a.amount != null));
  return {
    x402_challenge: present,
    accepts,
    quoted_price_usd: quoted,
    known_answer: shapeValid ? true : present ? false : null,
    challenge_error: challenge && challenge.error ? String(challenge.error).slice(0, 200) : null,
  };
}

async function readBodyCapped(resp, max = SPOT_MAX_BODY) {
  const reader = resp.body && typeof resp.body.getReader === "function" ? resp.body.getReader() : null;
  if (!reader) {
    const t = await resp.text();
    const truncated = t.length > max;
    return { text: truncated ? t.slice(0, max) : t, truncated, bytes: Math.min(t.length, max) };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.length) continue;
    const remain = max - total;
    if (remain <= 0) {
      truncated = true;
      try {
        await reader.cancel();
      } catch (_) {}
      break;
    }
    if (value.length > remain) {
      chunks.push(value.slice(0, remain));
      total += remain;
      truncated = true;
      try {
        await reader.cancel();
      } catch (_) {}
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return { text: new TextDecoder().decode(merged), truncated, bytes: total };
}

/**
 * Probe a URL for x402 challenge. Never attaches payment headers.
 * opts.fetchImpl / resolveHostFn injectable for tests.
 */
export async function spotProbe(rawUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const resolveHostFn = opts.resolveHostFn || resolveHost;
  const timeoutMs = opts.timeoutMs ?? SPOT_FETCH_TIMEOUT_MS;
  const maxBody = opts.maxBody ?? SPOT_MAX_BODY;

  const safe0 = await assertSafeUrl(rawUrl, { resolveHostFn, fetchImpl });
  if (!safe0.ok) {
    return {
      reachable: false,
      http_status: null,
      latency_ms: null,
      ssrf_blocked: true,
      error: safe0.reason,
      x402_challenge: false,
      accepts: [],
      quoted_price_usd: null,
      known_answer: null,
      body_truncated: false,
    };
  }

  if (inflight >= SPOT_MAX_CONCURRENT) {
    return {
      reachable: false,
      http_status: null,
      latency_ms: null,
      ssrf_blocked: false,
      error: "too many concurrent probes; retry shortly",
      x402_challenge: false,
      accepts: [],
      quoted_price_usd: null,
      known_answer: null,
      body_truncated: false,
    };
  }

  inflight++;
  const started = Date.now();
  let current = safe0.url;
  try {
    for (let hop = 0; hop <= SPOT_MAX_REDIRECTS; hop++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);
      let resp;
      try {
        resp = await fetchImpl(current.toString(), {
          method: "GET",
          redirect: "manual",
          signal: ac.signal,
          headers: {
            accept: "application/json, text/plain, */*",
            "user-agent": "verified-catalog-spotcheck/0.6.3",
            // Explicitly do NOT send payment headers
          },
        });
      } catch (e) {
        clearTimeout(timer);
        const msg = String(e && e.message ? e.message : e);
        const timed = /timeout|aborted|AbortError/i.test(msg) || (e && e.name === "AbortError");
        return {
          reachable: false,
          http_status: null,
          latency_ms: Date.now() - started,
          ssrf_blocked: false,
          error: timed ? "fetch timeout" : "fetch failed",
          x402_challenge: false,
          accepts: [],
          quoted_price_usd: null,
          known_answer: null,
          body_truncated: false,
        };
      } finally {
        clearTimeout(timer);
      }

      // Redirect hop: re-validate Location
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const loc = resp.headers.get("location");
        if (!loc) {
          return {
            reachable: true,
            http_status: resp.status,
            latency_ms: Date.now() - started,
            ssrf_blocked: false,
            error: "redirect without location",
            x402_challenge: false,
            accepts: [],
            quoted_price_usd: null,
            known_answer: null,
            body_truncated: false,
          };
        }
        let next;
        try {
          next = new URL(loc, current);
        } catch (_) {
          return {
            reachable: true,
            http_status: resp.status,
            latency_ms: Date.now() - started,
            ssrf_blocked: true,
            error: "redirect to invalid url",
            x402_challenge: false,
            accepts: [],
            quoted_price_usd: null,
            known_answer: null,
            body_truncated: false,
          };
        }
        const safeHop = await assertSafeUrl(next.toString(), { resolveHostFn, fetchImpl });
        if (!safeHop.ok) {
          return {
            reachable: true,
            http_status: resp.status,
            latency_ms: Date.now() - started,
            ssrf_blocked: true,
            error: "redirect blocked: " + safeHop.reason,
            x402_challenge: false,
            accepts: [],
            quoted_price_usd: null,
            known_answer: null,
            body_truncated: false,
          };
        }
        current = safeHop.url;
        if (hop === SPOT_MAX_REDIRECTS) {
          return {
            reachable: true,
            http_status: resp.status,
            latency_ms: Date.now() - started,
            ssrf_blocked: false,
            error: "too many redirects",
            x402_challenge: false,
            accepts: [],
            quoted_price_usd: null,
            known_answer: null,
            body_truncated: false,
          };
        }
        continue;
      }

      const { text, truncated } = await readBodyCapped(resp, maxBody);
      const parsed = parseX402Challenge({ status: resp.status, headers: resp.headers, bodyText: text });
      return {
        reachable: true,
        http_status: resp.status,
        latency_ms: Date.now() - started,
        ssrf_blocked: false,
        error: truncated ? "response body truncated at cap" : null,
        body_truncated: truncated,
        ...parsed,
      };
    }
  } finally {
    inflight = Math.max(0, inflight - 1);
  }
  return {
    reachable: false,
    http_status: null,
    latency_ms: Date.now() - started,
    ssrf_blocked: false,
    error: "probe exhausted",
    x402_challenge: false,
    accepts: [],
    quoted_price_usd: null,
    known_answer: null,
    body_truncated: false,
  };
}

export function priceMatchesClaimed(quoted, claimed) {
  if (claimed === null || claimed === undefined || claimed === "") return null;
  const c = Number(claimed);
  const q = Number(quoted);
  if (!Number.isFinite(c) || !Number.isFinite(q)) return null;
  return Math.abs(c - q) < 1e-9 + Math.max(c, q) * 1e-6;
}

/**
 * Map probe result → decision-shaped verdict.
 * Deterministic rules (prefer skip over pay when unsure about safety;
 * prefer recheck over pay when data incomplete):
 * - skip + ssrf_blocked if SSRF
 * - skip + unreachable / timeout if fetch fails
 * - skip + no_x402 if reachable but no parseable x402/402 challenge
 * - pay + price_ok if challenge parses and (no claimed_price OR quoted matches claimed within epsilon)
 * - skip + price_mismatch if both prices present and differ
 * - recheck + ambiguous / bad_challenge when challenge present but unparseable or partial
 */
export function decideVerdict(probe, claimedPrice) {
  if (!probe || probe.ssrf_blocked) {
    return { verdict: "skip", reason: "ssrf_blocked" };
  }
  if (!probe.reachable) {
    const err = String(probe.error || "");
    if (/timeout/i.test(err)) return { verdict: "skip", reason: "timeout" };
    return { verdict: "skip", reason: "unreachable" };
  }
  if (!probe.x402_challenge) {
    return { verdict: "skip", reason: "no_x402" };
  }
  // Challenge present but not a fully parseable shape → recheck
  if (probe.known_answer !== true) {
    const accepts = Array.isArray(probe.accepts) ? probe.accepts : [];
    const partial = accepts.length > 0 || probe.quoted_price_usd != null;
    return { verdict: "recheck", reason: partial ? "ambiguous" : "bad_challenge" };
  }
  // Fully parsed challenge
  const claimed = claimedPrice;
  if (claimed === null || claimed === undefined || claimed === "") {
    return { verdict: "pay", reason: "price_ok" };
  }
  const match = priceMatchesClaimed(probe.quoted_price_usd, claimed);
  if (match === true) return { verdict: "pay", reason: "price_ok" };
  if (match === false) return { verdict: "skip", reason: "price_mismatch" };
  // Claimed set but quoted missing/unusable → incomplete
  return { verdict: "recheck", reason: "ambiguous" };
}

export function utcHour(now = new Date()) {
  return now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}
