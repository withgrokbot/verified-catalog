// 0.47.0 Watchtower tests. Real SQLite (node:sqlite) runs migration 0013 behind a tiny D1 adapter; fetch, DNS and the
// facilitator are stubbed. All data is synthetic. Run: npx -y -p node@22 node tests/watch_test.mjs  (Node >= 22.5)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker/src/index.js";
import { watchDeps, paymentPreset } from "../worker/src/lib.js";
import * as S from "../worker/src/sign.js";
import * as W from "../worker/src/watch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG = readFileSync(join(ROOT, "worker", "migrations", "0013_watchtower.sql"), "utf8");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(MIG);
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({
    sql, args,
    bind: (...a) => mk(sql, norm(a)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _run: () => db.prepare(sql).run(...args),
  });
  return { raw: db, prepare: (sql) => mk(sql), batch: async (st) => { db.exec("BEGIN"); try { for (const s of st) s._run(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; } };
}
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "test-watch-key" };
S._addTestKey({ kid: jwk.kid, x: jwk.x }); S._resetSigner();
const KEYS = S.receiptKeysDoc();
const SECRET_STRINGS = ["0xpayer", "0xdeadbeef", "203.0.113."];

// world: endpoint behaviour + webhook receiver
function world() {
  const w = { terms: { amount: "10000", payTo: "0x00000000000000000000000000000000000000aa" }, mode: "402", hookStatus: [200], hooks: [], probes: 0, fetches: [] };
  w.fetchImpl = async (u, init = {}) => {
    const url = new URL(u);
    w.fetches.push({ url: u, redirect: init.redirect });
    if (url.hostname.startsWith("hooks") || url.hostname === "webhook.site" || url.hostname === "hooks.slack.com" || url.hostname === "x.ngrok-free.app") {
      const st = w.hookStatus.length > 1 ? w.hookStatus.shift() : w.hookStatus[0];
      w.hooks.push({ url: u, body: init.body, headers: init.headers, status: st });
      if (st === "throw") throw new Error("network");
      return new Response("ok", { status: st, headers: st === 302 ? { location: "https://hooks.example.com/elsewhere" } : {} });
    }
    w.probes++;
    if (w.mode === "down") return new Response("oops", { status: 503 });
    if (w.mode === "throw") throw new Error("fetch failed");
    if (w.mode === "200") return new Response("{}", { status: 200 });
    const ch = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: w.terms.amount, payTo: w.terms.payTo, maxTimeoutSeconds: 60 + w.probes }] };
    return new Response(JSON.stringify(ch), { status: 402, headers: { "content-type": "application/json" } });
  };
  w.resolveHostFn = async (h) => (h === "rebind.example.com" ? ["10.0.0.7"] : ["93.184.216.34"]);
  return w;
}
let clock = Date.parse("2026-10-21T12:00:00Z");
function setup(extraEnv = {}) {
  const env = { WATCHTOWER: "1", RECEIPTS_DB: d1(), WATCH_PEPPER: "test-pepper", RECEIPT_SIGNING_KEY: JSON.stringify(jwk), ...extraEnv };
  const wd = world();
  const settled = [];
  const deps = () => ({ ...watchDeps(env), fetchImpl: wd.fetchImpl, resolveHostFn: wd.resolveHostFn, now: () => new Date(clock),
    verifyAndSettle: async (c, payload) => { settled.push({ amount: payload.accepted.amount, network: c.network }); return { ok: true, settle: { success: true, transaction: "0xdeadbeef", payer: "0xpayer", network: c.network } }; } });
  const call = async (method, path, body, headers = {}) => {
    const url = new URL("https://api.402xagent.com" + path);
    const req = new Request(url, { method, headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const r = await W.handleWatch(req, env, null, url, deps());
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, j: text ? JSON.parse(text) : null };
  };
  const payHdr = () => {
    const c = W.watchCfgOf(watchDeps(env).cfg);
    return { "payment-signature": btoa(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: c.network, amount: c.priceAtomic, asset: c.asset, payTo: c.payTo }, payload: { signature: "0x00", authorization: { from: "0xpayer", to: c.payTo, value: c.priceAtomic, nonce: "0x01" } } })) };
  };
  const tick = () => W.watchTick(env, new Date(clock), deps());
  const row = (id) => env.RECEIPTS_DB.raw.prepare("SELECT * FROM watches WHERE id = ?").get(id);
  const events = (id, type) => env.RECEIPTS_DB.raw.prepare("SELECT * FROM watch_events WHERE watch_id = ?" + (type ? " AND type = ?" : "") + " ORDER BY created_at").all(...(type ? [id, type] : [id]));
  return { env, wd, call, payHdr, tick, row, events, settled, deps };
}
const EX = { url: "https://api.seller.example.com/v1/data", webhook_url: "https://hooks.buyer.example.com/402x" };
const H = 3600000;
const advance = (ms) => { clock += ms; };

test("create: first watch for a webhook domain is a 7-day trial (201, no payment); secret shown once, stored only hashed; second domain watch needs $1 (402)", async () => {
  const t = setup();
  const r = await t.call("POST", "/v1/watch", EX);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.j.trial, true);
  assert.match(r.j.watch_id, /^wt-[0-9a-f]{16}$/);
  assert.match(r.j.watch_secret, /^wts_[0-9a-f]{48}$/);
  assert.equal(Date.parse(r.j.paid_until) - clock, 7 * 24 * H);
  const row = t.row(r.j.watch_id);
  assert.ok(!JSON.stringify(row).includes(r.j.watch_secret));
  assert.equal(t.settled.length, 0);
  assert.equal(t.wd.hooks.length, 1); // the signed watch.verify ping
  const r2 = await t.call("POST", "/v1/watch", { url: "https://api.seller.example.com/v1/other", webhook_url: "https://hooks.buyer.example.com/other-path" });
  assert.equal(r2.status, 402);
  assert.match(r2.j.error, /trial is used/);
  assert.equal(r2.j.accepts[0].amount, "1000000");
  assert.ok(r2.headers.get("payment-required"));
  // same pair again: existing id, never the secret, nothing charged
  const r3 = await t.call("POST", "/v1/watch", EX);
  assert.equal(r3.status, 200); assert.equal(r3.j.watch_id, r.j.watch_id); assert.equal(r3.j.watch_secret, undefined); assert.equal(r3.j.existing, true);
});

test("(a) trial key: registrable domain (sub.hooks.example.co.uk -> example.co.uk); relay hosts (webhook.site, hooks.slack.com, discord, zapier, pipedream, *.app.n8n.cloud, *.ngrok-free.app, requestbin, hookdeck, make.com) key on host + path", async () => {
  assert.equal(W.trialKey("https://a.b.example.com/x?q=1"), "domain:example.com");
  assert.equal(W.trialKey("https://hooks.example.co.uk/x"), "domain:example.co.uk");
  for (const u of ["https://webhook.site/abc", "https://hooks.slack.com/services/T/B/C", "https://discord.com/api/webhooks/1/x", "https://discordapp.com/api/webhooks/1/x", "https://hooks.zapier.com/hooks/catch/1/x", "https://eo1.m.pipedream.net/", "https://x.pipedream.net/", "https://acme.app.n8n.cloud/webhook/1", "https://ab.ngrok.io/h", "https://ab.ngrok-free.app/h", "https://ab.ngrok.app/h", "https://x.requestbin.com/h", "https://events.hookdeck.com/e/src", "https://hook.eu1.make.com/abc"])
    assert.match(W.trialKey(u), /^relay:/, u);
  assert.notEqual(W.trialKey("https://webhook.site/aaa"), W.trialKey("https://webhook.site/bbb"));
  assert.equal(W.trialKey("https://webhook.site/aaa?x=1"), W.trialKey("https://webhook.site/aaa"));
  const t = setup();
  const a = await t.call("POST", "/v1/watch", { url: EX.url, webhook_url: "https://webhook.site/aaa" });
  const b = await t.call("POST", "/v1/watch", { url: "https://api.seller.example.com/v2", webhook_url: "https://webhook.site/bbb" });
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(b.j.trial, true);
  const c = await t.call("POST", "/v1/watch", { url: "https://api.seller.example.com/v3", webhook_url: "https://webhook.site/aaa/" });
  assert.equal(c.status, 402);
});

test("(c) trial is per webhook domain, never per wallet: no wallet is stored, so a new wallet never resets it; per-URL (90 d) and per-network (3/day) trial caps", async () => {
  const t = setup();
  await t.call("POST", "/v1/watch", EX);
  const cols = t.env.RECEIPTS_DB.raw.prepare("SELECT name FROM pragma_table_info('trial_claims')").all().map((r) => r.name);
  assert.deepEqual(cols.sort(), ["claimed_at", "key_hash", "kind", "n"]);
  const dump = JSON.stringify(t.env.RECEIPTS_DB.raw.prepare("SELECT * FROM trial_claims").all());
  assert.ok(!dump.includes("buyer.example.com") && !dump.includes("203.0.113"));
  // same endpoint, a new webhook domain: URL already trialled within 90 d
  const u = await t.call("POST", "/v1/watch", { url: EX.url, webhook_url: "https://hooks.other.example.org/x" });
  assert.equal(u.status, 402);
  // paid works and does not consume a trial
  const p = await t.call("POST", "/v1/watch", { url: "https://api.seller.example.com/v9", webhook_url: "https://hooks.buyer.example.com/9" }, t.payHdr());
  assert.equal(p.status, 201); assert.equal(p.j.trial, false);
  // per network: 3 trials per IP prefix per day
  const t2 = setup();
  for (let i = 0; i < 3; i++) assert.equal((await t2.call("POST", "/v1/watch", { url: "https://api.s" + i + ".example.com/x", webhook_url: `https://hooks.dom${i}.net/x` })).status, 201);
  assert.equal((await t2.call("POST", "/v1/watch", { url: "https://api.s9.example.com/x", webhook_url: "https://hooks.dom9.net/x" })).status, 402);
});

test("create: unsafe URLs (private IP, DNS rebind, http/port webhook, credentials, our own host as webhook) give 400 and store/charge nothing; (d) our own routes are watchable as endpoints", async () => {
  const t = setup();
  for (const [body, code] of [
    [{ url: "http://10.0.0.1/x", webhook_url: EX.webhook_url }, "unsafe_url"],
    [{ url: "https://rebind.example.com/x", webhook_url: EX.webhook_url }, "unsafe_url"],
    [{ url: EX.url, webhook_url: "http://hooks.buyer.example.com/x" }, "unsafe_webhook_url"],
    [{ url: EX.url, webhook_url: "https://hooks.buyer.example.com:8443/x" }, "unsafe_webhook_url"],
    [{ url: EX.url, webhook_url: "https://u:p@hooks.buyer.example.com/x" }, "unsafe_webhook_url"],
    [{ url: EX.url, webhook_url: "https://rebind.example.com/x" }, "unsafe_webhook_url"],
    [{ url: EX.url, webhook_url: "https://api.402xagent.com/x" }, "unsafe_webhook_url"],
    [{ url: "ftp://x.example.com/", webhook_url: EX.webhook_url }, "bad_url"],
  ]) {
    const r = await t.call("POST", "/v1/watch", body, t.payHdr());
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.j.code, code); assert.match(r.j.error, /Nothing was charged/);
  }
  assert.equal(t.settled.length, 0);
  assert.equal(t.env.RECEIPTS_DB.raw.prepare("SELECT COUNT(*) n FROM watches").get().n, 0);
  const ns = setup({ RECEIPT_SIGNING_KEY: "" }); // no signing key: nothing created, nothing charged (webhooks must be verifiable)
  const nr = await ns.call("POST", "/v1/watch", EX, ns.payHdr());
  assert.equal(nr.status, 503); assert.equal(nr.j.code, "signing_unavailable"); assert.equal(ns.settled.length, 0); assert.equal(ns.wd.hooks.length, 0);
  const own = await t.call("POST", "/v1/watch", { url: "https://api.402xagent.com/v1/products/endpoint-report", method: "POST", webhook_url: EX.webhook_url });
  assert.equal(own.status, 201, own.text);
});

test("create: webhook must answer the signed watch.verify with 2xx (500, 302 and network errors refuse; redirects not followed); baseline probe failure refuses; nothing charged", async () => {
  for (const st of [500, 302, "throw"]) {
    const t = setup();
    t.wd.hookStatus = [st];
    const r = await t.call("POST", "/v1/watch", EX, t.payHdr());
    assert.equal(r.status, 400); assert.equal(r.j.code, "webhook_verify_failed");
    assert.equal(t.settled.length, 0);
    assert.ok(t.wd.fetches.every((f) => f.redirect === "manual"));
    assert.equal(t.wd.fetches.filter((f) => f.url.includes("elsewhere")).length, 0);
  }
  const t = setup(); t.wd.mode = "down";
  const r = await t.call("POST", "/v1/watch", EX, t.payHdr());
  assert.equal(r.j.code, "baseline_failed"); assert.equal(t.settled.length, 0);
});

test("paid create + renew: $1 accepts under default (Base) and base-sepolia presets; renew adds 30 d to max(now, paid_until), no auth; signed wr- receipts carry no payer/tx", async () => {
  for (const preset of [undefined, "base-sepolia"]) {
    const t = setup(preset ? { PAYMENT_PRESET: preset } : {});
    const bare = await t.call("POST", "/v1/watch", {});
    assert.equal(bare.status, 402);
    const pr = paymentPreset(t.env);
    assert.equal(bare.j.accepts[0].network, pr.network); assert.equal(bare.j.accepts[0].asset, pr.asset); assert.equal(bare.j.accepts[0].amount, "1000000");
    assert.match(bare.j.resource.description, new RegExp("USDC on " + pr.label + " "));
    const c = await t.call("POST", "/v1/watch", EX, t.payHdr());
    assert.equal(c.status, 201); assert.equal(c.j.trial, false); assert.match(c.j.receipt_id, /^wr-/);
    assert.ok(c.headers.get("payment-response"));
    assert.equal(Date.parse(c.j.paid_until) - clock, 30 * 24 * H);
    const id = c.j.watch_id;
    assert.equal((await t.call("POST", `/v1/watch/${id}/renew`, {})).status, 402);
    const rn = await t.call("POST", `/v1/watch/${id}/renew`, {}, t.payHdr());
    assert.equal(rn.status, 200);
    assert.equal(Date.parse(rn.j.paid_until) - clock, 60 * 24 * H);
    assert.equal(t.settled.length, 2); assert.equal(t.settled[0].amount, "1000000"); assert.equal(t.settled[0].network, pr.network);
    for (const rc of [c.j.receipt, rn.j.receipt]) {
      assert.equal(rc.kid, jwk.kid);
      const { signature, ...rest } = rc;
      assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "=="), (x) => x.charCodeAt(0)), new TextEncoder().encode(S.canonicalize(rest))));
      for (const s of SECRET_STRINGS) assert.ok(!JSON.stringify(rc).includes(s), s);
    }
  }
});

test("GET / DELETE / verify need the Bearer secret (401 otherwise); counters increment; DELETE is soft and purged after 30 d", async () => {
  const t = setup();
  const c = await t.call("POST", "/v1/watch", EX);
  const id = c.j.watch_id, auth = { authorization: "Bearer " + c.j.watch_secret };
  assert.equal((await t.call("GET", `/v1/watch/${id}`)).status, 401);
  assert.equal((await t.call("GET", `/v1/watch/${id}`, undefined, { authorization: "Bearer wts_" + "0".repeat(48) })).status, 401);
  advance(H); await t.tick(); advance(H); await t.tick();
  const g = await t.call("GET", `/v1/watch/${id}`, undefined, auth);
  assert.equal(g.status, 200); assert.equal(g.j.probes_total, 2); assert.equal(g.j.probes_this_period, 2); assert.equal(g.j.state, "up");
  assert.equal(g.j.webhook.host, "hooks.buyer.example.com"); assert.equal(g.j.webhook_url, undefined);
  const d = await t.call("DELETE", `/v1/watch/${id}`, undefined, auth);
  assert.equal(d.j.status, "deleted");
  assert.equal((await t.call("GET", `/v1/watch/${id}`, undefined, auth)).status, 401);
  advance(31 * 24 * H); await t.tick();
  assert.equal(t.row(id), undefined);
});

test("cron: each active watch is probed once per hour; batch cap holds; one shared probe per URL per tick; paused / expired watches are not probed; expiry pauses (never deletes) with a signed paused event", async () => {
  const t = setup({ WATCH_BATCH: "2" });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await t.call("POST", "/v1/watch", { url: EX.url, webhook_url: `https://hooks.b${i}.example.com/x` }, t.payHdr())).j.watch_id);
  t.wd.probes = 0;
  let r = await t.tick();
  assert.equal(r.probed, 0); // baseline just captured; next probe in an hour
  advance(H);
  r = await t.tick();
  assert.equal(r.probed, 2); assert.equal(r.probes_fetched, 1); assert.equal(t.wd.probes, 1);
  r = await t.tick(); assert.equal(r.probed, 1);
  r = await t.tick(); assert.equal(r.probed, 0);
  for (const id of ids) assert.equal(t.row(id).probes_total, 1);
  advance(30 * 24 * H);
  r = await t.tick();
  assert.equal(r.expired, 3);
  for (const id of ids) { assert.equal(t.row(id).status, "paused"); assert.equal(t.row(id).paused_reason, "expired"); assert.equal(t.events(id, "paused").length, 1); }
  advance(H); r = await t.tick(); assert.equal(r.probed, 0);
});

test("drift: a material change (payTo, price > 1 %) fires exactly once after 2 consecutive probes and becomes the new baseline; non-material (maxTimeoutSeconds, 0.5 % price) fires nothing; supersedes chains", async () => {
  const t = setup();
  const id = (await t.call("POST", "/v1/watch", EX, t.payHdr())).j.watch_id;
  const step = async () => { advance(H); return t.tick(); };
  t.wd.terms.amount = "10050"; // +0.5 %
  await step(); await step();
  assert.equal(t.events(id, "drift").length, 0);
  t.wd.terms.payTo = "0x00000000000000000000000000000000000000bb"; t.wd.terms.amount = "20000";
  await step(); assert.equal(t.events(id, "drift").length, 0);
  await step(); assert.equal(t.events(id, "drift").length, 1);
  await step(); await step(); assert.equal(t.events(id, "drift").length, 1);
  const ev = JSON.parse(t.events(id, "drift")[0].payload);
  assert.deepEqual(ev.changes.map((c) => c.field).sort(), ["payTo", "price"]);
  assert.equal(ev.changes.find((c) => c.field === "price").to, "20000");
  assert.equal(ev.endpoint, EX.url); assert.ok(ev.supersedes);
  assert.equal(JSON.parse(t.row(id).baseline_json).terms.payTo, "0x00000000000000000000000000000000000000bb");
  // a one-probe blip is not drift
  t.wd.terms.amount = "90000"; await step(); t.wd.terms.amount = "20000"; await step();
  assert.equal(t.events(id, "drift").length, 1);
});

test("drift while paused: the first probe after renew fires drift with changed_while_paused: true", async () => {
  const t = setup();
  const id = (await t.call("POST", "/v1/watch", EX, t.payHdr())).j.watch_id;
  advance(31 * 24 * H); await t.tick();
  assert.equal(t.row(id).status, "paused");
  t.wd.terms.payTo = "0x00000000000000000000000000000000000000cc";
  const rn = await t.call("POST", `/v1/watch/${id}/renew`, {}, t.payHdr());
  assert.equal(rn.j.resumed, true); assert.equal(t.events(id, "resumed").length, 1);
  await t.tick();
  const d = t.events(id, "drift");
  assert.equal(d.length, 1); assert.equal(JSON.parse(d[0].payload).changed_while_paused, true);
});

test("down / recovery need 2 consecutive probes; a 5xx, a timeout and a lost paywall count as down; flapping: the 3rd down in 6 h fires one flapping event, then quiet", async () => {
  const t = setup({ WATCH_PROBE_INTERVAL_S: "0" });
  const id = (await t.call("POST", "/v1/watch", EX, t.payHdr())).j.watch_id;
  const step = async (mode) => { t.wd.mode = mode; advance(60000); await t.tick(); };
  await step("down"); assert.equal(t.events(id, "down").length, 0);
  await step("throw"); assert.equal(t.events(id, "down").length, 1); assert.equal(t.row(id).state, "down");
  await step("402"); assert.equal(t.events(id, "recovery").length, 0);
  await step("402"); assert.equal(t.events(id, "recovery").length, 1);
  await step("200"); await step("200"); assert.equal(t.events(id, "down").length, 2); // paywall lost = down
  await step("402"); await step("402");
  await step("down"); await step("down");
  assert.equal(t.events(id, "down").length, 2); assert.equal(t.events(id, "flapping").length, 1);
  await step("402"); await step("402"); await step("down"); await step("down");
  assert.equal(t.events(id, "flapping").length, 1); assert.equal(t.events(id, "recovery").length, 2);
});

test("webhook: Ed25519 signature over timestamp.body verifies against the keys doc; tampered body/timestamp, unknown kid and >5 min skew fail; retries 1m/5m/30m/2h/6h keep the same event_id; DNS rebind at delivery time is blocked", async () => {
  const t = setup();
  const id = (await t.call("POST", "/v1/watch", EX, t.payHdr())).j.watch_id;
  const h0 = t.wd.hooks[0];
  const v = { body: h0.body, timestamp: h0.headers["x-402x-timestamp"], signature: h0.headers["x-402x-signature"], kid: h0.headers["x-402x-kid"] };
  const nowS = Math.floor(clock / 1000);
  assert.equal(await W.verifyWebhook(v, KEYS, nowS), true);
  assert.equal(await W.verifyWebhook({ ...v, body: v.body.replace("watch.verify", "drift") }, KEYS, nowS), false);
  assert.equal(await W.verifyWebhook({ ...v, timestamp: String(Number(v.timestamp) + 1) }, KEYS, nowS + 1), false);
  assert.equal(await W.verifyWebhook({ ...v, kid: "nope" }, KEYS, nowS), false);
  assert.equal(await W.verifyWebhook(v, KEYS, nowS + 301), false);
  assert.equal(JSON.parse(h0.body).event_id, h0.headers["x-402x-event-id"]);
  // force a down event, receiver failing
  t.wd.hookStatus = [500]; t.wd.mode = "down";
  advance(H); await t.tick(); advance(H); await t.tick();
  const evId = t.events(id, "down")[0].id;
  const del = () => t.env.RECEIPTS_DB.raw.prepare("SELECT * FROM watch_deliveries WHERE event_id = ?").get(evId);
  assert.equal(del().attempt, 1);
  const gaps = [60, 300, 1800, 7200];
  for (let i = 0; i < 4; i++) {
    assert.equal(Date.parse(del().next_attempt_at) - clock, gaps[i] * 1000);
    advance(gaps[i] * 1000 - 1000); await W.deliverDue(t.env, new Date(clock), t.deps()); assert.equal(del().attempt, i + 1); // not yet due
    advance(1000); await W.deliverDue(t.env, new Date(clock), t.deps()); assert.equal(del().attempt, i + 2);
  }
  assert.equal(del().status, "failed");
  assert.equal(t.row(id).deliveries_failed, 1);
  const ids = t.wd.hooks.filter((h) => JSON.parse(h.body).type === "down").map((h) => h.headers["x-402x-event-id"]);
  assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 1);
  // rebind: webhook host now resolves privately -> no request leaves
  const t2 = setup();
  const c2 = await t2.call("POST", "/v1/watch", EX, t2.payHdr());
  const n = t2.wd.hooks.length;
  const r = await W.postWebhook(t2.env, "https://rebind.example.com/x", { event_id: "evt-0000000000000000", type: "down" }, new Date(clock), t2.deps());
  assert.equal(r.ok, false); assert.match(r.error, /blocked/); assert.equal(t2.wd.hooks.length, n);
  assert.ok(c2.j.watch_id);
});

test("(e) auto-pause after 3 consecutive UTC days on which every delivery failed (paused event written); a day with one success resets; verify ping (2xx) or renew resumes", async () => {
  clock = Date.parse("2026-10-21T01:00:00Z");
  const t = setup({ WATCH_PROBE_INTERVAL_S: "0" });
  const c = await t.call("POST", "/v1/watch", EX, t.payHdr());
  const id = c.j.watch_id, auth = { authorization: "Bearer " + c.j.watch_secret };
  t.wd.hookStatus = [500];
  const failDay = async () => { t.wd.mode = t.wd.mode === "down" ? "402" : "down"; for (let i = 0; i < 2; i++) { advance(60000); await t.tick(); } advance(24 * H - 120000); };
  await failDay(); await failDay();
  // day 3: one success resets
  t.wd.hookStatus = [200]; await t.call("POST", `/v1/watch/${id}/verify`, {}, auth); t.wd.hookStatus = [500];
  assert.equal(t.row(id).fail_days, 0);
  advance(24 * H);
  await failDay(); await failDay(); await failDay();
  await t.tick();
  assert.equal(t.row(id).status, "paused"); assert.equal(t.row(id).paused_reason, "webhook_failing");
  const p = t.events(id, "paused"); assert.equal(p.length, 1);
  const pe = JSON.parse(p[0].payload); assert.equal(pe.reason, "webhook_failing"); assert.ok(pe.signature);
  // failing verify does not resume; a 2xx verify does
  assert.equal((await t.call("POST", `/v1/watch/${id}/verify`, {}, auth)).status, 502);
  assert.equal(t.row(id).status, "paused");
  t.wd.hookStatus = [200];
  const ok = await t.call("POST", `/v1/watch/${id}/verify`, {}, auth);
  assert.equal(ok.j.resumed, true); assert.equal(t.row(id).status, "active"); assert.equal(t.events(id, "resumed").length, 1);
  clock = Date.parse("2026-10-21T12:00:00Z");
});

test("abuse limits: WATCH_MAX (503), 20 active per webhook domain, 10 creates per network per day", async () => {
  const t = setup({ WATCH_MAX: "2" });
  for (let i = 0; i < 2; i++) assert.equal((await t.call("POST", "/v1/watch", { url: `https://api.s${i}.example.com/`, webhook_url: `https://hooks.d${i}.example.com/` }, t.payHdr())).status, 201);
  const r = await t.call("POST", "/v1/watch", { url: "https://api.s9.example.com/", webhook_url: "https://hooks.d9.example.com/" }, t.payHdr());
  assert.equal(r.status, 503); assert.equal(r.j.code, "capacity"); assert.equal(t.settled.length, 2);
  const t2 = setup();
  for (let i = 0; i < 10; i++) await t2.call("POST", "/v1/watch", { url: `https://api.s${i}.example.com/`, webhook_url: `https://hooks.d${i % 3}.example.com/${i}` }, t2.payHdr());
  const r2 = await t2.call("POST", "/v1/watch", { url: "https://api.s99.example.com/", webhook_url: "https://hooks.dz.example.com/" }, t2.payHdr());
  assert.equal(r2.status, 429); assert.equal(r2.j.code, "rate_limited");
  const t3 = setup();
  for (let i = 0; i < 20; i++) {
    t3.env.RECEIPTS_DB.raw.prepare("INSERT INTO watches (id, secret_hash, url, hkey, webhook_url, webhook_hash, webhook_domain_hash, status, created_at, paid_until, period_start, next_probe_at, baseline_json, baseline_sig, baseline_at) VALUES (?, 'x', 'u', ?, 'w', 'h', ?, 'active', 'a', '2099', 'a', '2099', '{}', 's', 'a')")
      .run("wt-" + String(i).padStart(16, "0"), "k" + i, await (async () => { const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-pepper"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("trial|domain:example.com")))].map((b) => b.toString(16).padStart(2, "0")).join(""); })());
  }
  const r3 = await t3.call("POST", "/v1/watch", EX, t3.payHdr());
  assert.equal(r3.status, 429); assert.equal(r3.j.code, "domain_limit");
});

test("(b)+(f) internal stats (Bearer WATCH_STATS_TOKEN, else 404): queues trigger at 300 active, pricing review due at 60 days or 50 paid watches", async () => {
  const t = setup({ WATCH_STATS_TOKEN: "stat-token" });
  assert.equal((await t.call("GET", "/v1/watch/stats")).status, 404);
  await t.call("POST", "/v1/watch", EX, t.payHdr());
  const s = await t.call("GET", "/v1/watch/stats", undefined, { authorization: "Bearer stat-token" });
  assert.equal(s.j.active, 1); assert.equal(s.j.queues.threshold, 300); assert.equal(s.j.queues.move_to_queues, false);
  assert.equal(s.j.pricing_review.paid_watches, 1); assert.equal(s.j.pricing_review.due, false);
  advance(60 * 24 * H);
  const s2 = await W.stats(t.env, new Date(clock));
  assert.equal(s2.pricing_review.due, true);
  assert.equal(W.QUEUE_THRESHOLD, 300); assert.equal(W.PRICING_REVIEW.paid_watches, 50);
  clock = Date.parse("2026-10-21T12:00:00Z");
});

test("privacy sweep: no payer wallet, tx hash, payment payload or client IP in any watch response, event, wr- receipt, delivery body or D1 row", async () => {
  const t = setup({ WATCH_PROBE_INTERVAL_S: "0" });
  const bodies = [];
  const c = await t.call("POST", "/v1/watch", EX, t.payHdr()); bodies.push(c.text);
  bodies.push((await t.call("POST", `/v1/watch/${c.j.watch_id}/renew`, {}, t.payHdr())).text);
  bodies.push((await t.call("GET", `/v1/watch/${c.j.watch_id}`, undefined, { authorization: "Bearer " + c.j.watch_secret })).text);
  t.wd.mode = "down"; for (let i = 0; i < 2; i++) { advance(60000); await t.tick(); }
  for (const h of t.wd.hooks) bodies.push(h.body);
  const raw = t.env.RECEIPTS_DB.raw;
  for (const tb of ["watches", "watch_events", "watch_deliveries", "watch_usage", "trial_claims"]) bodies.push(JSON.stringify(raw.prepare("SELECT * FROM " + tb).all()));
  const all = bodies.join("\n");
  for (const s of SECRET_STRINGS.concat(["payment-signature", "authorization\":{", "0x01\""])) assert.ok(!all.includes(s), s);
  assert.ok(!all.replace(c.text, "").includes(c.j.watch_secret)); // the secret appears only in the create answer
});

test("flag + listings: WATCHTOWER off (wrangler.toml default) -> /v1/watch 404 and not listed; on -> .well-known, OpenAPI (path params with examples), llms.txt, docs, pricing list it with concrete examples, no bare templates", async () => {
  const toml = readFileSync(join(ROOT, "worker", "wrangler.toml"), "utf8");
  assert.match(toml, /^WATCHTOWER = "off"/m);
  assert.ok(!/WATCH_DEV_LOCAL/.test(toml.replace(/#.*$/gm, "")));
  assert.equal(existsMig(), true);
  const get = async (env, p, init) => worker.fetch(new Request("https://api.402xagent.com" + p, init), env, { waitUntil() {} });
  const off = { WATCHTOWER: "off" };
  assert.equal((await get(off, "/v1/watch", { method: "POST", body: "{}" })).status, 404);
  for (const p of ["/.well-known/x402", "/openapi.json", "/llms.txt"]) assert.ok(!(await (await get(off, p)).text()).includes("/v1/watch"), p);
  const on = { WATCHTOWER: "1" };
  const wk = await (await get(on, "/.well-known/x402")).json();
  const ent = wk.resourceCatalog.find((r) => r.url.endsWith("/v1/watch"));
  assert.equal(ent.accepts[0].amount || ent.accepts[0].maxAmountRequired, "1000000");
  const oa = await (await get(on, "/openapi.json")).json();
  for (const p of ["/v1/watch", "/v1/watch/{watch_id}", "/v1/watch/{watch_id}/renew", "/v1/watch/{watch_id}/verify"]) assert.ok(oa.paths[p], p);
  assert.equal(oa.paths["/v1/watch/{watch_id}"].parameters[0].example, "wt-0123456789abcdef");
  const { paths, ...rest } = oa;
  const opText = JSON.stringify(rest) + JSON.stringify(Object.values(paths));
  for (const p of ["/llms.txt", "/docs", "/pricing"]) {
    const txt = await (await get(on, p)).text();
    assert.ok(/watch/i.test(txt), p);
    assert.ok(!/\{(watch_id|id|host)\}/.test(txt), p + " bare template");
  }
  assert.ok(!/\{watch_id\}/.test(opText));
  const llms = await (await get(on, "/llms.txt")).text();
  assert.ok(llms.includes("/v1/watch/wt-0123456789abcdef/renew"));
});
import { existsSync } from "node:fs";
const existsMig = () => existsSync(join(ROOT, "worker", "migrations", "0013_watchtower.sql"));

let pass = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log("PASS " + t.name); }
  catch (e) { console.log("FAIL " + t.name + "\n  " + String(e.stack || e).split("\n").slice(0, 8).join("\n  ")); }
}
console.log(`${pass}/${tests.length} watch tests passed`);
if (pass !== tests.length) process.exit(1);
