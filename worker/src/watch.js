// 0.47.0 Watchtower: watch one x402 endpoint for $1 / 30 days (prepaid via x402), hourly re-probe against a captured
// baseline, Ed25519-signed webhooks on drift / down / recovery (plus flapping, paused, resumed). API only. Flag WATCHTOWER.
// Privacy (0.45.6): no payer wallet, tx hash, payment payload or client IP is stored or returned. The watch secret and
// all trial / rate-limit keys are stored only as hashes. Plan: docs/plan-watchtower.md.
import { assertSafeUrl, resolveHost, parseX402Challenge, readBodyCapped, bazaarServiceMeta } from "./spotcheck.js";
import { canonicalize, signObject, signBytes } from "./sign.js";
import { noteD1Size } from "./d1size.js";
import { feedObserveOn, feedStatementsForWatch, feedOptOut, optInAllowed, optInMax, isOptedIn, setOptIn } from "./feed.js";
import { methodNotAllowed, inputError, INPUT_ERROR_HEADER, isPlaceholderUrl, placeholderInputError, placeholder400, PLACEHOLDER_MESSAGE, PLACEHOLDER_HEADER } from "./ops.js";

export const WATCH_PRICE_ATOMIC = "1000000";
export const WATCH_PRICE_USD = "1.00";
export const WATCH_PERIOD_DAYS = 30;
export const TRIAL_DAYS = 7;
export const WATCH_MAX_DEFAULT = 500;
export const QUEUE_THRESHOLD = 300; // (b) move the fan-out to Cloudflare Queues at 300 active watches
export const PER_DOMAIN_MAX = 20;
export const PER_IP_DAY_MAX = 10;
export const TRIAL_PER_IP_DAY = 3;
export const URL_TRIAL_DAYS = 90;
export const WATCH_BATCH_DEFAULT = 100;
export const PROBE_CONCURRENCY = 6;
export const RETRY_SCHEDULE_S = [60, 300, 1800, 7200, 21600]; // after attempts 1..5; attempt 6 never happens
export const MAX_ATTEMPTS = 5;
export const PAUSE_FAIL_DAYS = 3;
export const PRICING_REVIEW = { days: 60, paid_watches: 50 };
export const FLAP_WINDOW_H = 6;
export const SKEW_S = 300;
export const WATCH_ID_RE = /^wt-[0-9a-f]{16}$/;
export const EVENT_ID_RE = /^(evt|wr)-[0-9a-f]{16}$/;
export const EXAMPLE_WATCH_ID = "wt-0123456789abcdef";
export const EXAMPLE_CREATE = { url: "https://api.402rates.com/v1/ping", method: "GET", webhook_url: "https://hooks.example.com/402x" };
const UA = "402xagent-watchtower/0.47.0";
const DAY = 86400000;
const OWN_HOSTS = ["402xagent.com", "api.402xagent.com", "payscout.dev", "api.payscout.dev", "verified-catalog-lookup.withgrokbot.workers.dev"];

// (a) shared relay hosts: the trial keys on full host + path there, not on the registrable domain.
export const RELAY_HOSTS = [
  "webhook.site", "hooks.slack.com", "discord.com", "discordapp.com", "hooks.zapier.com", "pipedream.net", "m.pipedream.net",
  "app.n8n.cloud", "ngrok.io", "ngrok-free.app", "ngrok.app", "requestbin.com", "requestbin.net", "requestcatcher.com",
  "hookdeck.com", "hookdeck.io", "hook.make.com", "hook.eu1.make.com", "hook.us1.make.com", "hook.eu2.make.com", "hook.us2.make.com",
  "make.com", "integromat.com", "beeceptor.com", "requestinspector.com", "webhookrelay.com", "smee.io", "svix.com",
  "trycloudflare.com", "loca.lt", "localtunnel.me", "serveo.net", "pagekite.me", "ifttt.com", "maker.ifttt.com",
];
const MULTI_TLD = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "com.br", "co.in", "co.kr", "com.cn", "com.mx", "co.za", "com.tr", "com.sg", "com.hk", "com.tw", "github.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com", "fly.dev", "onrender.com", "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfunctions.net", "run.app", "lambda-url.us-east-1.on.aws", "deno.dev", "repl.co", "glitch.me"]);
export function registrableDomain(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  const parts = h.split(".");
  if (parts.length <= 2 || /^[0-9.]+$/.test(h) || h.includes(":")) return h;
  const last2 = parts.slice(-2).join(".");
  return MULTI_TLD.has(last2) ? parts.slice(-3).join(".") : last2;
}
export const isRelayHost = (host) => { const h = String(host || "").toLowerCase().replace(/\.$/, ""); return RELAY_HOSTS.some((r) => h === r || h.endsWith("." + r)); };
/** The trial key: registrable domain, or host + path for shared relay hosts (query and fragment never included). */
export function trialKey(webhookUrl) {
  const u = new URL(webhookUrl);
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  return isRelayHost(h) ? "relay:" + h + u.pathname.replace(/\/+$/, "") : "domain:" + registrableDomain(h);
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(String(msg))));
}
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const dayOf = (d) => iso(d).slice(0, 10);
const pepper = (env) => String(env.WATCH_PEPPER || env.HOSTED_KEY_PEPPER || "");
export const watchOn = (env) => ["1", "on", "true"].includes(String((env && env.WATCHTOWER) || "off").toLowerCase());
export const devLocal = (env) => String((env && env.WATCH_DEV_LOCAL) || "") === "1"; // local wrangler dev only; never in wrangler.toml
const isLoopback = (h) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(String(h).toLowerCase());
const intEnv = (v, d) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n >= 0 ? n : d; };
export const watchMax = (env) => intEnv(env.WATCH_MAX, WATCH_MAX_DEFAULT);
const retrySchedule = (env) => { const s = String(env.WATCH_RETRY_SCHEDULE_S || "").split(",").map((x) => parseInt(x, 10)); return s.length === 5 && s.every((n) => Number.isFinite(n) && n >= 0) ? s : RETRY_SCHEDULE_S; };
const probeInterval = (env) => intEnv(env.WATCH_PROBE_INTERVAL_S, 3600) * 1000;

function jsonResp(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE", "cache-control": "no-store", ...extra } });
}

// ------------------------------------------------------------------ URL safety (SSRF)
/** Endpoint: http(s), safe address. Webhook: https on 443 only, no credentials, not our own hosts. Checked at create AND before every delivery. */
export async function safeTarget(raw, env, deps = {}, { webhook = false } = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (_) { return { ok: false, reason: "invalid url" }; }
  if (u.username || u.password) return { ok: false, reason: "url credentials not allowed" };
  if (devLocal(env) && isLoopback(u.hostname) && /^https?:$/.test(u.protocol)) return { ok: true, url: u, dev: true };
  if (webhook) {
    if (u.protocol !== "https:") return { ok: false, reason: "webhook_url must be https" };
    if (u.port && u.port !== "443") return { ok: false, reason: "webhook_url must use port 443" };
    const h = u.hostname.toLowerCase();
    if (OWN_HOSTS.some((o) => h === o || h.endsWith("." + o))) return { ok: false, reason: "webhook_url cannot be a 402xAgent host" };
  }
  const r = await assertSafeUrl(u.toString(), { resolveHostFn: deps.resolveHostFn || resolveHost, fetchImpl: deps.fetchImpl || fetch });
  return r.ok ? { ok: true, url: u } : { ok: false, reason: r.reason };
}

// ------------------------------------------------------------------ probe + baseline
/** One unpaid probe (never sends payment headers, never follows redirects). Returns the material observation. */
export async function probe(url, method, env, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const safe = await safeTarget(url, env, deps);
  if (!safe.ok) return { healthy: false, reachable: false, error: "blocked: " + safe.reason, http_status: null };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), intEnv(env.WATCH_PROBE_TIMEOUT_MS, 8000));
  const started = Date.now();
  try {
    const init = { method: method === "POST" ? "POST" : "GET", redirect: "manual", signal: ac.signal, headers: { accept: "application/json, */*", "user-agent": UA } };
    if (init.method === "POST") { init.headers["content-type"] = "application/json"; init.body = "{}"; }
    const resp = await fetchImpl(safe.url.toString(), init);
    let text = "";
    try { text = (await readBodyCapped(resp, 65536)).text; } catch (_) {} // 0.51.1: stream-capped; the old text() read the whole body first
    const p = parseX402Challenge({ status: resp.status, headers: resp.headers, bodyText: text });
    const exact = (p.accepts || []).find((a) => a && a.scheme === "exact") || (p.accepts || [])[0] || null;
    const schemes = [...new Set((p.accepts || []).map((a) => a && a.scheme).filter(Boolean))].sort();
    return {
      reachable: true, http_status: resp.status, latency_ms: Date.now() - started, paywall: !!p.x402_challenge,
      x402_version: p.x402_version, schemes,
      terms: exact ? { network: exact.network || null, asset: exact.asset ? String(exact.asset).toLowerCase() : null, payTo: exact.payTo ? String(exact.payTo).toLowerCase() : null, amount: exact.amount ?? null } : null,
    };
  } catch (e) {
    return { reachable: false, http_status: null, error: /timeout|abort/i.test(String(e && (e.message || e))) ? "timeout" : "fetch failed" };
  } finally { clearTimeout(timer); }
}
/** Baseline = the material fields only (latency, validBefore, maxTimeoutSeconds, headers and bodies are ignored). */
export function baselineOf(o) {
  return { paywall: !!o.paywall, x402_version: o.x402_version ?? null, schemes: o.schemes || [], terms: o.terms || null, http_class: o.http_status ? Math.floor(o.http_status / 100) + "xx" : null };
}
export const sigOf = async (b) => "sha256:" + (await sha256Hex(canonicalize(b)));
/** healthy = reachable, not 5xx, and (if the baseline had a paywall) still answering with a 402 challenge. */
export function healthyFor(o, base) {
  if (!o || !o.reachable || !o.http_status || o.http_status >= 500) return false;
  if (base && base.paywall && !o.paywall) return false;
  return true;
}
/** Material changes only: payTo, network, asset, price > 1 %, x402 version, scheme set, paywall gained/lost. */
export function materialChanges(base, now) {
  const ch = [];
  const add = (field, from, to) => ch.push({ field, from: from ?? null, to: to ?? null });
  if (!!base.paywall !== !!now.paywall) add("paywall", !!base.paywall, !!now.paywall);
  const bt = base.terms || {}, nt = now.terms || {};
  if ((bt.payTo || null) !== (nt.payTo || null)) add("payTo", bt.payTo, nt.payTo);
  if ((bt.network || null) !== (nt.network || null)) add("network", bt.network, nt.network);
  if ((bt.asset || null) !== (nt.asset || null)) add("asset", bt.asset, nt.asset);
  const a = Number(bt.amount), b = Number(nt.amount);
  if (bt.amount != null || nt.amount != null) {
    if (!(Number.isFinite(a) && Number.isFinite(b))) { if (String(bt.amount) !== String(nt.amount)) add("price", bt.amount, nt.amount); }
    else if (a === 0 ? b !== 0 : Math.abs(b - a) / a > 0.01) add("price", bt.amount, nt.amount);
  }
  if ((base.x402_version ?? null) !== (now.x402_version ?? null)) add("x402_version", base.x402_version, now.x402_version);
  if ((base.schemes || []).join(",") !== (now.schemes || []).join(",")) add("schemes", base.schemes || [], now.schemes || []);
  return ch;
}

// ------------------------------------------------------------------ events + webhook delivery
const publicWatch = (w) => ({ watch_id: w.id, endpoint: w.url, method: w.method });
export async function writeEvent(env, w, type, data, now, deps = {}, { deliver = true } = {}) {
  const db = env.RECEIPTS_DB;
  const id = "evt-" + randHex(8);
  const body = { event_id: id, type, occurred_at: iso(now), ...publicWatch(w), ...data, ...(w.last_event_id ? { supersedes: w.last_event_id } : {}), issuer: "402xAgent Watchtower", verify: "/.well-known/402xagent-keys.json (Ed25519 over JCS minus signature; webhook bytes: timestamp + '.' + body)" };
  const signed = (await signObject(env, body)) || body;
  const stmts = [
    db.prepare("INSERT INTO watch_events (id, watch_id, type, created_at, payload) VALUES (?, ?, ?, ?, ?)").bind(id, w.id, type, iso(now), JSON.stringify(signed)),
    db.prepare("UPDATE watches SET last_event_id = ?, events_total = events_total + 1 WHERE id = ?").bind(id, w.id),
    db.prepare("INSERT INTO watch_usage (watch_id, day, events) VALUES (?, ?, 1) ON CONFLICT(watch_id, day) DO UPDATE SET events = events + 1").bind(w.id, dayOf(now)),
  ];
  if (deliver) stmts.push(db.prepare("INSERT INTO watch_deliveries (event_id, watch_id, attempt, next_attempt_at, status, updated_at) VALUES (?, ?, 0, ?, 'pending', ?)").bind(id, w.id, iso(now), iso(now)));
  await db.batch(stmts);
  w.last_event_id = id;
  return signed;
}
/** POST one signed delivery. Headers: X-402x-Signature (base64url Ed25519 over `${timestamp}.${body}`), X-402x-Kid, X-402x-Timestamp, X-402x-Event-Id. */
export async function postWebhook(env, webhookUrl, event, now, deps = {}) {
  const safe = await safeTarget(webhookUrl, env, deps, { webhook: true }); // re-checked every time (DNS rebinding)
  if (!safe.ok) return { ok: false, status: null, error: "blocked: " + safe.reason };
  const body = JSON.stringify(event);
  const ts = String(Math.floor(new Date(now).getTime() / 1000));
  const sig = await signBytes(env, ts + "." + body);
  const headers = { "content-type": "application/json", "user-agent": UA, "x-402x-timestamp": ts, "x-402x-event-id": event.event_id, "x-402x-event-type": event.type };
  if (sig) { headers["x-402x-signature"] = sig.signature; headers["x-402x-kid"] = sig.kid; }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), 5000);
  try {
    const r = await (deps.fetchImpl || fetch)(safe.url.toString(), { method: "POST", body, headers, redirect: "manual", signal: ac.signal });
    try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (_) {} // response body ignored
    return { ok: r.status >= 200 && r.status < 300, status: r.status }; // 3xx = failure (redirects never followed)
  } catch (e) { return { ok: false, status: null, error: "network" }; } finally { clearTimeout(timer); }
}
/** Verify a delivery the way a receiver should: keys doc + timestamp skew. */
export async function verifyWebhook({ body, timestamp, signature, kid }, keysDoc, nowS = Math.floor(Date.now() / 1000)) {
  if (!body || !timestamp || !signature) return false;
  if (Math.abs(nowS - Number(timestamp)) > SKEW_S) return false;
  const k = (keysDoc.keys || []).find((x) => x.kid === kid);
  if (!k) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: k.x }, { name: "Ed25519" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((signature.length + 3) % 4)), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(timestamp + "." + body));
  } catch (_) { return false; }
}
async function noteDelivery(env, w, ok, now) {
  const d = dayOf(now);
  const db = env.RECEIPTS_DB;
  const usage = db.prepare(`INSERT INTO watch_usage (watch_id, day, ${ok ? "deliveries_ok" : "deliveries_failed"}) VALUES (?, ?, 1) ON CONFLICT(watch_id, day) DO UPDATE SET ${ok ? "deliveries_ok = deliveries_ok + 1" : "deliveries_failed = deliveries_failed + 1"}`).bind(w.id, d);
  // (e) consecutive UTC days on which every delivery failed. A success on a day clears the streak.
  if (ok) {
    await db.batch([usage, db.prepare("UPDATE watches SET ok_day = ?, fail_days = 0, consecutive_failed = 0 WHERE id = ?").bind(d, w.id)]);
    w.fail_days = 0; w.ok_day = d; w.consecutive_failed = 0;
  } else {
    const newDay = w.fail_day !== d && w.ok_day !== d;
    const fd = newDay ? (w.fail_days || 0) + 1 : w.fail_days || 0;
    await db.batch([usage, db.prepare("UPDATE watches SET fail_days = ?, fail_day = ?, consecutive_failed = consecutive_failed + 1 WHERE id = ?").bind(fd, w.ok_day === d ? w.fail_day : d, w.id)]);
    w.fail_days = fd; if (w.ok_day !== d) w.fail_day = d; w.consecutive_failed = (w.consecutive_failed || 0) + 1;
  }
}
/** Attempt every due delivery (attempt n+1); on failure schedule the next retry; after 5 attempts mark failed. */
export async function deliverDue(env, now, deps = {}, limit = 50) {
  const db = env.RECEIPTS_DB;
  const rows = (await db.prepare("SELECT d.event_id, d.attempt, e.payload, w.* FROM watch_deliveries d JOIN watch_events e ON e.id = d.event_id JOIN watches w ON w.id = d.watch_id WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at LIMIT ?").bind(iso(now), limit).all()).results || [];
  const sched = retrySchedule(env);
  const out = [];
  for (const row of rows) {
    const w = { ...row };
    const ev = JSON.parse(row.payload);
    const r = await postWebhook(env, row.webhook_url, ev, now, deps);
    const attempt = row.attempt + 1;
    if (r.ok) {
      await db.prepare("UPDATE watch_deliveries SET attempt = ?, status = 'delivered', http_status = ?, next_attempt_at = NULL, updated_at = ? WHERE event_id = ?").bind(attempt, r.status, iso(now), row.event_id).run();
    } else if (attempt >= MAX_ATTEMPTS) {
      await db.batch([
        db.prepare("UPDATE watch_deliveries SET attempt = ?, status = 'failed', http_status = ?, next_attempt_at = NULL, updated_at = ? WHERE event_id = ?").bind(attempt, r.status, iso(now), row.event_id),
        db.prepare("UPDATE watches SET deliveries_failed = deliveries_failed + 1 WHERE id = ?").bind(w.id),
      ]);
    } else {
      const next = new Date(new Date(now).getTime() + sched[attempt - 1] * 1000);
      await db.prepare("UPDATE watch_deliveries SET attempt = ?, http_status = ?, next_attempt_at = ?, updated_at = ? WHERE event_id = ?").bind(attempt, r.status, iso(next), iso(now), row.event_id).run();
    }
    await noteDelivery(env, w, r.ok, now);
    out.push({ event_id: row.event_id, attempt, ok: r.ok, status: r.status });
  }
  return out;
}

// ------------------------------------------------------------------ one probe step for one watch
const W_COLS = "id, url, method, webhook_url, status, paused_reason, state, fail_streak, ok_streak, pending_sig, pending_count, was_paused, quiet_until, baseline_json, baseline_sig, last_event_id, fail_days, fail_day, ok_day, consecutive_failed, paid_until";
// 0.52.0/0.53.1: feed_opt_in (table feed_opt_ins, migration 0018) is selected only when FEED_OBSERVE / FEED=observe is
// on, so ticks keep working before 0018 is applied and the watches table itself is never altered.
const wCols = (env) => (feedObserveOn(env) ? W_COLS + ", EXISTS (SELECT 1 FROM feed_opt_ins f WHERE f.watch_id = watches.id) AS feed_opt_in" : W_COLS);
export async function stepWatch(env, w, o, now, deps = {}) {
  const db = env.RECEIPTS_DB;
  const base = JSON.parse(w.baseline_json);
  const fired = [];
  const nowMs = new Date(now).getTime();
  const quiet = w.quiet_until && w.quiet_until > iso(now);
  const transition = async (type, data) => {
    // flapping: a 3rd down within 6 h fires one `flapping`, then down/recovery stay quiet until 6 h without a transition.
    const since = iso(nowMs - FLAP_WINDOW_H * 3600000);
    if (quiet) { w.quiet_until = iso(nowMs + FLAP_WINDOW_H * 3600000); return; }
    if (type === "down") {
      const n = ((await db.prepare("SELECT COUNT(*) AS n FROM watch_events WHERE watch_id = ? AND type = 'down' AND created_at >= ?").bind(w.id, since).first()) || {}).n || 0;
      if (n >= 2) { w.quiet_until = iso(nowMs + FLAP_WINDOW_H * 3600000); fired.push(await writeEvent(env, w, "flapping", { state: "down", window_hours: FLAP_WINDOW_H, note: "down/recovery suppressed until the endpoint is stable for 6 h" }, now, deps)); return; }
    }
    fired.push(await writeEvent(env, w, type, data, now, deps));
  };
  const healthy = healthyFor(o, base);
  if (!healthy) {
    w.fail_streak++; w.ok_streak = 0;
    if (w.state === "up" && w.fail_streak >= 2) { w.state = "down"; await transition("down", { state: "down", reason: o.error || (o.http_status ? "http " + o.http_status : "no 402 challenge"), http_status: o.http_status ?? null }); }
  } else {
    w.ok_streak++; w.fail_streak = 0;
    if (w.state === "down" && w.ok_streak >= 2) { w.state = "up"; await transition("recovery", { state: "up", http_status: o.http_status }); }
    const nb = baselineOf(o);
    const changes = materialChanges(base, nb);
    if (!changes.length) { w.pending_sig = null; w.pending_count = 0; }
    else {
      const s = await sigOf(nb);
      w.pending_count = w.pending_sig === s ? w.pending_count + 1 : 1;
      w.pending_sig = s;
      if (w.pending_count >= 2 || w.was_paused) {
        fired.push(await writeEvent(env, w, "drift", { changes, baseline_before: w.baseline_sig, baseline_after: s, ...(w.was_paused ? { changed_while_paused: true } : {}) }, now, deps));
        w.baseline_json = JSON.stringify(nb); w.baseline_sig = s; w.pending_sig = null; w.pending_count = 0;
      }
    }
    w.was_paused = 0;
  }
  if (w.quiet_until && !quiet && w.quiet_until <= iso(now)) w.quiet_until = null;
  noteD1Size(await db.batch([ // 0.53.1: the batch's meta.size_after refreshes the D1 size guard for free
    db.prepare("UPDATE watches SET state = ?, fail_streak = ?, ok_streak = ?, pending_sig = ?, pending_count = ?, was_paused = ?, quiet_until = ?, baseline_json = ?, baseline_sig = ?, baseline_at = CASE WHEN baseline_sig = ? THEN baseline_at ELSE ? END, last_probe_at = ?, next_probe_at = ?, probes_total = probes_total + 1, probes_period = probes_period + 1 WHERE id = ?")
      .bind(w.state, w.fail_streak, w.ok_streak, w.pending_sig, w.pending_count, w.was_paused ? 1 : 0, w.quiet_until, w.baseline_json, w.baseline_sig, w.baseline_sig, iso(now), iso(now), iso(nowMs + probeInterval(env)), w.id),
    db.prepare("INSERT INTO watch_usage (watch_id, day, probes) VALUES (?, ?, 1) ON CONFLICT(watch_id, day) DO UPDATE SET probes = probes + 1").bind(w.id, dayOf(now)),
    // 0.52.0: public feed observation in the same batch, only for watches that opted in (and FEED_OBSERVE on)
    ...(await feedStatementsForWatch(env, db, w, o, fired, now)),
  ]));
  return fired;
}

// ------------------------------------------------------------------ cron tick (rides the existing */20 trigger)
export async function watchTick(env, now = new Date(), deps = {}) {
  if (!watchOn(env) || !env.RECEIPTS_DB) return { did: "off" };
  const db = env.RECEIPTS_DB;
  const t = iso(now);
  // expiry: pause (never delete); purge soft-deleted rows after 30 days
  const expired = (await db.prepare(`SELECT ${W_COLS} FROM watches WHERE status = 'active' AND paid_until <= ?`).bind(t).all()).results || [];
  for (const w of expired) {
    await db.prepare("UPDATE watches SET status = 'paused', paused_reason = 'expired' WHERE id = ?").bind(w.id).run();
    await writeEvent(env, w, "paused", { reason: "expired", paid_until: w.paid_until, resume: "POST /v1/watch/" + w.id + "/renew ($1, x402)" }, now, deps);
  }
  await db.prepare("DELETE FROM watches WHERE status = 'deleted' AND deleted_at <= ?").bind(iso(new Date(now).getTime() - 30 * DAY)).run();
  // (e) auto-pause: 3 consecutive completed UTC days where every delivery failed
  const today = dayOf(now);
  const failing = (await db.prepare(`SELECT ${W_COLS} FROM watches WHERE status = 'active' AND fail_days >= ? AND fail_day < ?`).bind(PAUSE_FAIL_DAYS, today).all()).results || [];
  for (const w of failing) {
    await db.prepare("UPDATE watches SET status = 'paused', paused_reason = 'webhook_failing' WHERE id = ?").bind(w.id).run();
    await writeEvent(env, w, "paused", { reason: "webhook_failing", failed_days: w.fail_days, resume: "POST /v1/watch/" + w.id + "/verify (Bearer) after fixing the webhook, or renew" }, now, deps);
  }
  const batch = intEnv(env.WATCH_BATCH, WATCH_BATCH_DEFAULT);
  const due = (await db.prepare(`SELECT ${wCols(env)} FROM watches WHERE status = 'active' AND next_probe_at <= ? ORDER BY next_probe_at LIMIT ?`).bind(t, batch).all()).results || [];
  const cache = new Map(); // one probe per (url, method) per tick, shared by every watch on it
  const probeShared = (w) => { const k = w.method + " " + w.url; if (!cache.has(k)) cache.set(k, probe(w.url, w.method, env, deps)); return cache.get(k); };
  const events = [];
  for (let i = 0; i < due.length; i += PROBE_CONCURRENCY) {
    const chunk = due.slice(i, i + PROBE_CONCURRENCY);
    const rs = await Promise.allSettled(chunk.map(async (w) => stepWatch(env, w, await probeShared(w), now, deps)));
    for (const r of rs) if (r.status === "fulfilled") events.push(...r.value);
  }
  const deliveries = await deliverDue(env, now, deps);
  const active = ((await db.prepare("SELECT COUNT(*) AS n FROM watches WHERE status = 'active'").first()) || {}).n || 0;
  // (b) Queues trigger: a log line (and /v1/watch/stats) once active watches reach 300 of WATCH_MAX.
  if (active >= QUEUE_THRESHOLD) console.log(JSON.stringify({ watchtower: "move_to_queues", active, threshold: QUEUE_THRESHOLD, watch_max: watchMax(env) }));
  return { did: "tick", expired: expired.length, auto_paused: failing.length, probed: due.length, probes_fetched: cache.size, events: events.length, deliveries: deliveries.length, active };
}

// ------------------------------------------------------------------ HTTP API
// 0.51.0: Bazaar discovery metadata for POST /v1/watch (small; docs link for the rest).
export function watchBazaarExtension() {
  return {
    info: { input: { type: "http", method: "POST", bodyType: "json", body: EXAMPLE_CREATE }, output: { type: "json", example: { id: "wt-0123456789abcdef", secret: "returned once", status: "active", paid_until: "2026-11-21T00:00:00Z" }, docs: "https://402xagent.com/docs#watchtower" } },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", const: "POST" }, bodyType: { type: "string", const: "json" }, body: { type: "object", properties: { url: { type: "string", description: "x402 endpoint to watch" }, method: { type: "string", enum: ["GET", "POST"] }, webhook_url: { type: "string", description: "https URL for signed drift/down/recovery webhooks" } }, required: ["url", "webhook_url"] } }, required: ["type", "method", "bodyType", "body"] },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" }, docs: { type: "string" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}
export const watchCfgOf = (base) => ({ ...base, priceAtomic: WATCH_PRICE_ATOMIC, priceUsd: WATCH_PRICE_USD });
function paymentRequired(cd, deps, resourceUrl, error, extra = {}) {
  const net = cd.label || "Base";
  const desc = `402xAgent Watchtower: $1 USDC on ${net} per watch per 30 days (hourly re-probe, signed webhooks).`;
  const body = {
    x402Version: 2, error,
    resource: { url: resourceUrl, description: desc, mimeType: "application/json", ...bazaarServiceMeta("watch") }, // 0.58.9
    accepts: [deps.paymentRequirements(cd, resourceUrl, 2, { paidPath: true, description: desc })],
    extensions: { bazaar: watchBazaarExtension() },
    price_usd: WATCH_PRICE_USD, period_days: WATCH_PERIOD_DAYS, asset: `USDC on ${net} (${cd.network})`, product: "watchtower",
    example_request: { method: "POST", url: "https://api.402xagent.com/v1/watch", body: EXAMPLE_CREATE },
    how_to_pay: "Retry the same request with a PAYMENT-SIGNATURE header (x402 v2; X-PAYMENT also accepted) for the amount and payTo above.",
    docs: "https://402xagent.com/docs#watchtower", ...extra,
  };
  return jsonResp(body, 402, { "payment-required": deps.b64encode(body), ...(extra.input_error ? { [INPUT_ERROR_HEADER]: extra.input_error.field } : {}) });
}
async function readBody(req) { try { const t = await req.text(); if (!t) return {}; const b = JSON.parse(t); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch (_) { return null; } }
async function settle(req, cd, deps, resourceUrl) {
  const hdr = deps.paymentHeader(req);
  if (!hdr) return { none: true };
  const payload = deps.decodePaymentHeader(hdr);
  if (!payload) return { error: "payment header is not valid base64 JSON x402 payload" };
  const bad = deps.checkPayload(payload, cd);
  if (bad) return { error: "payment rejected: " + bad };
  return { payload, go: async () => {
    const r = await deps.verifyAndSettle(cd, payload, resourceUrl, { paidPath: true, description: `402xAgent Watchtower: $1 USDC on ${cd.label || "Base"} per watch per 30 days.` });
    if (!r.ok) return { error: "payment rejected: " + r.reason };
    const enc = deps.b64encode(r.settle);
    return { headers: { "payment-response": enc, "x-payment-response": enc }, facilitator: r.facilitator || null, replayed: !!r.replayed };
  } };
}
/** Signed `wr-` payment receipt: amount, network, asset, seller pay_to and the period only (never payer or tx). */
async function paymentReceipt(env, w, kind, cd, paidUntil, now, facilitator = null) {
  const id = "wr-" + randHex(8);
  const body = { id, type: "watchtower-payment", kind, watch_id: w.id, endpoint: w.url, paid_until: paidUntil, period_days: WATCH_PERIOD_DAYS, issued_at: iso(now),
    payment_received: { amount_usd: WATCH_PRICE_USD, amount_atomic: WATCH_PRICE_ATOMIC, network: cd.network, asset: cd.asset, pay_to: cd.payTo, ...(facilitator ? { facilitator } : {}) }, issuer: "402xAgent Watchtower" };
  const signed = (await signObject(env, body)) || body;
  await env.RECEIPTS_DB.prepare("INSERT INTO watch_events (id, watch_id, type, created_at, payload) VALUES (?, ?, 'receipt', ?, ?)").bind(id, w.id, iso(now), JSON.stringify(signed)).run();
  return signed;
}
async function auth(req, env, id) {
  const m = /^Bearer\s+(wts_[0-9a-f]{48})$/.exec(req.headers.get("authorization") || "");
  if (!m) return null;
  const w = await env.RECEIPTS_DB.prepare("SELECT * FROM watches WHERE id = ? AND status != 'deleted'").bind(id).first();
  if (!w) return null;
  return w.secret_hash === (await sha256Hex(pepper(env) + ":" + m[1])) ? w : null;
}
function view(w) {
  return {
    watch_id: w.id, endpoint: w.url, method: w.method, status: w.status, ...(w.paused_reason && w.status === "paused" ? { paused_reason: w.paused_reason } : {}),
    trial: !!w.trial, created_at: w.created_at, paid_until: w.paid_until, state: w.state, baseline: { ...JSON.parse(w.baseline_json), sig: w.baseline_sig, captured_at: w.baseline_at },
    last_probe_at: w.last_probe_at, last_event_id: w.last_event_id, probes_total: w.probes_total, probes_this_period: w.probes_period, events_total: w.events_total,
    webhook: { host: new URL(w.webhook_url).hostname, deliveries_failed: w.deliveries_failed, webhook_failing: w.consecutive_failed >= 10 },
  };
}
const ipOf = (req) => req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "";

export async function handleWatch(req, env, ctx, url, deps) {
  if (!watchOn(env)) return jsonResp({ error: "Watchtower is not enabled yet", code: "not_enabled", docs: "https://402xagent.com/docs#watchtower" }, 404);
  if (!env.RECEIPTS_DB || !pepper(env)) return jsonResp({ error: "watch store unavailable; nothing was charged", code: "store_unavailable" }, 503);
  // webhooks must be verifiable: without a working published signing key nothing is created or charged
  if (!(await signBytes(env, "watchtower-self-test"))) return jsonResp({ error: "signing key unavailable; nothing was charged", code: "signing_unavailable" }, 503);
  const db = env.RECEIPTS_DB;
  const now = deps.now ? deps.now() : new Date();
  const cd = watchCfgOf(deps.cfg);
  const path = url.pathname.replace(/\/+$/, "");
  const bad = (code, field, msg, status = 400) => jsonResp({ error: msg + ". Nothing was charged.", code, field, example: { method: "POST", url: "https://api.402xagent.com/v1/watch", body: EXAMPLE_CREATE }, docs: "https://402xagent.com/docs#watchtower" }, status);
  if (path === "/v1/watch/stats") {
    const tok = env.WATCH_STATS_TOKEN;
    if (!tok || (req.headers.get("authorization") || "") !== "Bearer " + tok) return jsonResp({ error: "not found" }, 404);
    return jsonResp(await stats(env, now));
  }
  if (path === "/v1/watch") {
    if (req.method !== "POST") return paymentRequired(cd, deps, url.origin + "/v1/watch", "POST JSON {url, method?, webhook_url} to create a watch.", { discovery: true });
    const b = await readBody(req);
    // 0.49.1: no payment header + bad input -> the normal 402 + input_error (price/accepts unchanged); with a header: strict 400
    const soft = (code, field, msg, received) => deps.paymentHeader(req) ? bad(code, field, msg)
      : paymentRequired(cd, deps, url.origin + "/v1/watch", msg + ". Nothing was charged.", inputError({ code, field, expected: msg, received }));
    if (!b) return soft("bad_body", "body", "the body must be a JSON object", "[not a JSON object]");
    if (!b.url && !b.webhook_url && !deps.paymentHeader(req)) return paymentRequired(cd, deps, url.origin + "/v1/watch", "Missing url and webhook_url.", { discovery: true });
    const method = String(b.method || "GET").toUpperCase();
    if (!["GET", "POST"].includes(method)) return soft("bad_method", "method", '"method" is GET or POST', b.method);
    // 0.49.2: placeholder endpoint host (example.com, localhost, *.test, ...): no probe; 402 + input_error unpaid, 400 with a header
    if (isPlaceholderUrl(b.url)) {
      if (deps.paymentHeader(req)) return jsonResp(placeholder400("url", b.url), 400, { [PLACEHOLDER_HEADER]: "1" });
      const r = paymentRequired(cd, deps, url.origin + "/v1/watch", PLACEHOLDER_MESSAGE, placeholderInputError("url", b.url));
      r.headers.set(PLACEHOLDER_HEADER, "1");
      return r;
    }
    let t;
    try { t = new URL(String(b.url || "")); } catch (_) {}
    if (!t || !/^https?:$/.test(t.protocol)) return soft("bad_url", "url", '"url" must be a full http(s) URL', b.url);
    t.search = ""; t.hash = "";
    let wh;
    try { wh = new URL(String(b.webhook_url || "")); } catch (_) {}
    if (!wh) return soft("bad_webhook_url", "webhook_url", '"webhook_url" must be a full https URL', b.webhook_url);
    const hkey = await sha256Hex(method + " " + t.toString());
    const whHash = await sha256Hex(wh.toString());
    const existing = await db.prepare("SELECT id, status, paid_until FROM watches WHERE hkey = ? AND webhook_hash = ? AND status != 'deleted'").bind(hkey, whHash).first();
    if (existing) return jsonResp({ watch_id: existing.id, status: existing.status, paid_until: existing.paid_until, existing: true, note: "this endpoint + webhook pair is already watched; the secret is never shown again. Extend it with POST /v1/watch/" + existing.id + "/renew. Nothing was charged." }, 200);
    const s1 = await safeTarget(t.toString(), env, deps);
    if (!s1.ok) return soft("unsafe_url", "url", "url refused: " + s1.reason, b.url);
    const s2 = await safeTarget(wh.toString(), env, deps, { webhook: true });
    if (!s2.ok) return bad("unsafe_webhook_url", "webhook_url", "webhook_url refused: " + s2.reason);
    // abuse limits
    const active = ((await db.prepare("SELECT COUNT(*) AS n FROM watches WHERE status = 'active'").first()) || {}).n || 0;
    if (active >= watchMax(env)) return bad("capacity", "url", "Watchtower is at capacity (WATCH_MAX); try again later", 503);
    const tk = trialKey(wh.toString());
    const domHash = await hmacHex(pepper(env), "trial|" + tk);
    const perDom = ((await db.prepare("SELECT COUNT(*) AS n FROM watches WHERE webhook_domain_hash = ? AND status = 'active'").bind(domHash).first()) || {}).n || 0;
    if (perDom >= PER_DOMAIN_MAX) return bad("domain_limit", "webhook_url", `at most ${PER_DOMAIN_MAX} active watches per webhook domain`, 429);
    const ipHash = await hmacHex(pepper(env), "ip|" + deps.ipPrefix(ipOf(req)) + "|" + dayOf(now));
    const perIp = ((await db.prepare("SELECT COUNT(*) AS n FROM watches WHERE ip_hash = ?").bind(ipHash).first()) || {}).n || 0;
    if (perIp >= PER_IP_DAY_MAX) return bad("rate_limited", "url", `at most ${PER_IP_DAY_MAX} watch creates per network per day`, 429);
    // payment or trial
    const pay = await settle(req, cd, deps, url.origin + "/v1/watch");
    if (pay.error) return paymentRequired(cd, deps, url.origin + "/v1/watch", pay.error);
    let trial = false;
    const urlKey = await hmacHex(pepper(env), "trialurl|" + hkey);
    const ipTrialKey = await hmacHex(pepper(env), "trialip|" + deps.ipPrefix(ipOf(req)) + "|" + dayOf(now));
    if (pay.none) {
      const dom = await db.prepare("SELECT 1 AS x FROM trial_claims WHERE key_hash = ?").bind(domHash).first();
      const u = await db.prepare("SELECT claimed_at FROM trial_claims WHERE key_hash = ?").bind(urlKey).first();
      const ipc = await db.prepare("SELECT n FROM trial_claims WHERE key_hash = ?").bind(ipTrialKey).first();
      const urlFresh = u && u.claimed_at > iso(new Date(now).getTime() - URL_TRIAL_DAYS * DAY);
      if (dom || urlFresh || (ipc && ipc.n >= TRIAL_PER_IP_DAY)) return paymentRequired(cd, deps, url.origin + "/v1/watch", "The 7-day free trial is used for this webhook " + (tk.startsWith("relay:") ? "URL" : "domain") + " (one per webhook domain; a new wallet never resets it). Payment required: $1 USDC per 30 days.");
      trial = true;
    }
    // baseline probe + synchronous signed verify ping, both before any charge or write
    const o = await probe(t.toString(), method, env, deps);
    if (!o.reachable || !o.http_status || o.http_status >= 500) return bad("baseline_failed", "url", "the endpoint did not answer the baseline probe (" + (o.error || "http " + o.http_status) + ")");
    const base = baselineOf(o);
    const bsig = await sigOf(base);
    const id = "wt-" + randHex(8);
    const w = { id, url: t.toString(), method, last_event_id: null };
    const verifyEv = { event_id: "evt-" + randHex(8), type: "watch.verify", occurred_at: iso(now), ...publicWatch(w), baseline_sig: bsig, issuer: "402xAgent Watchtower" };
    const signedVerify = (await signObject(env, verifyEv)) || verifyEv;
    const vr = await postWebhook(env, wh.toString(), signedVerify, now, deps);
    if (!vr.ok) return bad("webhook_verify_failed", "webhook_url", "the webhook did not answer the signed watch.verify event with a 2xx within 5 s (got " + (vr.status ?? vr.error) + ")");
    let payHeaders = {}, payFacilitator = null;
    if (!pay.none) { const r = await pay.go(); if (r.error) return paymentRequired(cd, deps, url.origin + "/v1/watch", r.error); payHeaders = r.headers; payFacilitator = r.facilitator; }
    else {
      // claim the trial atomically: the domain row is the gate (a concurrent second create loses here)
      const ins = await db.prepare("INSERT OR IGNORE INTO trial_claims (key_hash, kind, n, claimed_at) VALUES (?, 'domain', 1, ?)").bind(domHash, iso(now)).run();
      if (!ins.meta || !ins.meta.changes) return paymentRequired(cd, deps, url.origin + "/v1/watch", "The 7-day free trial is used for this webhook domain. Payment required: $1 USDC per 30 days.");
      await db.batch([
        db.prepare("INSERT INTO trial_claims (key_hash, kind, n, claimed_at) VALUES (?, 'url', 1, ?) ON CONFLICT(key_hash) DO UPDATE SET claimed_at = excluded.claimed_at, n = n + 1").bind(urlKey, iso(now)),
        db.prepare("INSERT INTO trial_claims (key_hash, kind, n, claimed_at) VALUES (?, 'ip', 1, ?) ON CONFLICT(key_hash) DO UPDATE SET n = n + 1").bind(ipTrialKey, iso(now)),
      ]);
    }
    const secret = "wts_" + randHex(24);
    const paidUntil = iso(new Date(now).getTime() + (trial ? TRIAL_DAYS : WATCH_PERIOD_DAYS) * DAY);
    const slot = parseInt(id.slice(3, 5), 16) % 3;
    await db.prepare("INSERT INTO watches (id, secret_hash, url, method, hkey, webhook_url, webhook_hash, webhook_domain_hash, ip_hash, status, trial, paid, created_at, paid_until, period_start, slot, next_probe_at, baseline_json, baseline_sig, baseline_at, state, last_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'up', ?)")
      .bind(id, await sha256Hex(pepper(env) + ":" + secret), t.toString(), method, hkey, wh.toString(), whHash, domHash, ipHash, trial ? 1 : 0, trial ? 0 : 1, iso(now), paidUntil, iso(now), slot, iso(new Date(now).getTime() + probeInterval(env)), JSON.stringify(base), bsig, iso(now), signedVerify.event_id).run();
    await db.prepare("INSERT INTO watch_events (id, watch_id, type, created_at, payload) VALUES (?, ?, 'watch.verify', ?, ?)").bind(signedVerify.event_id, id, iso(now), JSON.stringify(signedVerify)).run();
    // 0.52.0: opt in to the public Watchtower data feed (default off: a watched URL never appears unless its owner says so)
    let feedOptIn = false;
    let feedCap = false;
    if (b.feed_opt_in === true && feedObserveOn(env)) { try { if (await optInAllowed(env, db)) { await setOptIn(db, id, true, now); feedOptIn = true; } else feedCap = true; } catch (_) {} }
    const rc = trial ? null : await paymentReceipt(env, w, "create", cd, paidUntil, now, payFacilitator);
    return jsonResp({ watch_id: id, ...(feedOptIn ? { feed_opt_in: true } : {}), ...(feedCap ? { feed_opt_in: false, feed_opt_in_note: `the Watchtower data feed is at its opt-in cap (${optInMax(env)}); the watch works normally` } : {}), watch_secret: secret, secret_note: "shown once; send as Authorization: Bearer <watch_secret> to GET, verify or DELETE this watch", status: "active", trial, paid_until: paidUntil,
      baseline: { ...base, sig: bsig }, verify_event_id: signedVerify.event_id, ...(rc ? { receipt_id: rc.id, receipt: rc } : {}), manage: { get: "/v1/watch/" + id, renew: "/v1/watch/" + id + "/renew", verify: "/v1/watch/" + id + "/verify" } }, 201, payHeaders);
  }
  const m = /^\/v1\/watch\/(wt-[0-9a-f]{16})(\/renew|\/verify|\/feed)?$/.exec(path);
  if (!m) return jsonResp({ error: "not found", docs: "https://402xagent.com/docs#watchtower" }, 404);
  const id = m[1];
  if (m[2] === "/renew") {
    const ru = url.origin + "/v1/watch/" + id + "/renew";
    const w = await db.prepare("SELECT * FROM watches WHERE id = ? AND status != 'deleted'").bind(id).first();
    if (!w) return jsonResp({ error: "no such watch. Nothing was charged.", code: "not_found" }, 404);
    if (req.method !== "POST") return paymentRequired(cd, deps, ru, "POST with x402 payment to add 30 days.");
    const pay = await settle(req, cd, deps, ru);
    if (pay.none) return paymentRequired(cd, deps, ru, `Payment required: $1 USDC on ${cd.label || "Base"} adds 30 days to max(now, paid_until).`);
    if (pay.error) return paymentRequired(cd, deps, ru, pay.error);
    const r = await pay.go();
    if (r.error) return paymentRequired(cd, deps, ru, r.error);
    // 0.51.1: a replayed settlement (retry of a renew whose response was lost) answers with the current state, no extra days
    if (r.replayed) return jsonResp({ watch_id: id, status: w.status, resumed: false, paid_until: w.paid_until, replayed: true, note: "this payment was already applied; nothing was charged again" }, 200, r.headers);
    const from = Math.max(new Date(now).getTime(), new Date(w.paid_until).getTime());
    const paidUntil = iso(from + WATCH_PERIOD_DAYS * DAY);
    const resumed = w.status === "paused";
    await db.prepare("UPDATE watches SET paid_until = ?, status = 'active', paused_reason = NULL, paid = paid + 1, period_start = ?, probes_period = 0, fail_days = 0, was_paused = CASE WHEN status = 'paused' THEN 1 ELSE was_paused END, next_probe_at = CASE WHEN status = 'paused' THEN ? ELSE next_probe_at END WHERE id = ?").bind(paidUntil, iso(now), iso(now), id).run();
    if (resumed) await writeEvent(env, w, "resumed", { reason: "renewed", paid_until: paidUntil }, now, deps);
    const rc = await paymentReceipt(env, w, "renew", cd, paidUntil, now, r.facilitator);
    return jsonResp({ watch_id: id, status: "active", resumed, paid_until: paidUntil, receipt_id: rc.id, receipt: rc }, 200, r.headers);
  }
  const w = await auth(req, env, id);
  if (!w) return jsonResp({ error: "send Authorization: Bearer <watch_secret> (returned once at create)", code: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  if (m[2] === "/feed") { // 0.52.0: {opt_in: true|false} (Bearer). Opting out removes watch-sourced feed rows for this URL.
    if (req.method !== "POST") return methodNotAllowed(req.method, "POST, OPTIONS", url.pathname, { docs: "https://402xagent.com/docs#watchtower" });
    if (!feedObserveOn(env)) return jsonResp({ error: "the Watchtower data feed is not enabled yet", code: "not_enabled" }, 404);
    const fb = await readBody(req);
    if (!fb || typeof fb.opt_in !== "boolean") return jsonResp({ error: 'send JSON {"opt_in": true|false}', code: "bad_body", field: "opt_in" }, 400);
    const was = await isOptedIn(db, w.id);
    if (fb.opt_in && !was && !(await optInAllowed(env, db))) return jsonResp({ error: `the Watchtower data feed is at its opt-in cap (${optInMax(env)}); try again later`, code: "opt_in_cap", watch_id: w.id, feed_opt_in: false }, 409);
    await setOptIn(db, w.id, fb.opt_in, now);
    if (!fb.opt_in) {
      const others = ((await db.prepare("SELECT COUNT(*) AS n FROM watches w JOIN feed_opt_ins f ON f.watch_id = w.id WHERE w.url = ? AND w.status != 'deleted' AND w.id != ?").bind(w.url, w.id).first()) || {}).n || 0;
      if (!others) await feedOptOut(db, w.url);
    }
    return jsonResp({ watch_id: w.id, feed_opt_in: fb.opt_in });
  }
  if (m[2] === "/verify") {
    if (req.method !== "POST") return methodNotAllowed(req.method, "POST, OPTIONS", url.pathname, { docs: "https://402xagent.com/docs#watchtower" });
    const ev = { event_id: "evt-" + randHex(8), type: "watch.verify", occurred_at: iso(now), ...publicWatch(w), issuer: "402xAgent Watchtower" };
    const signed = (await signObject(env, ev)) || ev;
    const r = await postWebhook(env, w.webhook_url, signed, now, deps);
    await db.prepare("INSERT INTO watch_events (id, watch_id, type, created_at, payload) VALUES (?, ?, 'watch.verify', ?, ?)").bind(signed.event_id, w.id, iso(now), JSON.stringify(signed)).run();
    await noteDelivery(env, w, r.ok, now);
    let resumed = false;
    if (r.ok && w.status === "paused" && w.paused_reason === "webhook_failing" && w.paid_until > iso(now)) {
      await db.prepare("UPDATE watches SET status = 'active', paused_reason = NULL, was_paused = 1, next_probe_at = ? WHERE id = ?").bind(iso(now), w.id).run();
      await writeEvent(env, w, "resumed", { reason: "verify_ok" }, now, deps);
      resumed = true;
    }
    return jsonResp({ watch_id: w.id, delivered: r.ok, http_status: r.status ?? null, resumed, event_id: signed.event_id }, r.ok ? 200 : 502);
  }
  if (req.method === "DELETE") {
    await db.prepare("UPDATE watches SET status = 'deleted', deleted_at = ? WHERE id = ?").bind(iso(now), w.id).run();
    return jsonResp({ watch_id: w.id, status: "deleted", purge_after: iso(new Date(now).getTime() + 30 * DAY) });
  }
  if (req.method === "GET" || req.method === "HEAD") return jsonResp(view(w));
  return methodNotAllowed(req.method, "GET, HEAD, DELETE, OPTIONS", url.pathname, { docs: "https://402xagent.com/docs#watchtower" });
}

/** Internal stat (Bearer WATCH_STATS_TOKEN): Queues trigger and (f) pricing review at 60 days or 50 paid watches. */
export async function stats(env, now = new Date()) {
  const db = env.RECEIPTS_DB;
  const r = (await db.prepare("SELECT SUM(status = 'active') AS active, SUM(status = 'paused') AS paused, SUM(paid > 0) AS paid_watches, MIN(CASE WHEN paid > 0 THEN created_at END) AS first_paid_at, SUM(probes_total) AS probes FROM watches WHERE status != 'deleted'").first()) || {};
  const days = r.first_paid_at ? Math.floor((new Date(now).getTime() - new Date(r.first_paid_at).getTime()) / DAY) : 0;
  const active = r.active || 0;
  return {
    active, paused: r.paused || 0, watch_max: watchMax(env), probes_total: r.probes || 0,
    queues: { threshold: QUEUE_THRESHOLD, move_to_queues: active >= QUEUE_THRESHOLD },
    pricing_review: { paid_watches: r.paid_watches || 0, first_paid_at: r.first_paid_at || null, days_since_first_paid: days, due: days >= PRICING_REVIEW.days || (r.paid_watches || 0) >= PRICING_REVIEW.paid_watches, rule: "review at 60 days or 50 paid watches, from watch_usage" },
  };
}
