// 0.68.1 email validation (unreleased, EMAIL=1). Syntax, mocked DoH, disposable, role, status rules
// (deliverable only on a non-catch-all 250), probe mapping, quota, scale price, email grace, 404 when the flag is off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { openapi, VERSION } from "../worker/src/lib.js";
import { hashKey, loadKey, reserveQuota } from "../worker/src/render.js";
import { sqliteD1 as d1 } from "./helpers/sqlite_d1.mjs";
import { priceToPlan, emailPlanForPrice, planForPrice, configuredPriceId, hmacHex, BILLING_WEBHOOK_PATH } from "../worker/src/billing.js";
import * as E from "../worker/src/email.js";

const API = "https://api.402xagent.com";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = "rk_" + "B".repeat(32);
const records = {
  "gmail.com": { mx: [{ type: 15, data: "10 gmail-smtp-in.l.google.com." }] },
  "gmial.com": { mx: [{ type: 15, data: "10 mx.gmial.com." }] },
  "mailinator.com": { mx: [{ type: 15, data: "10 mail.mailinator.com." }] },
  "a.mailinator.com": { mx: [{ type: 15, data: "10 mail.mailinator.com." }] },
  "nomx.fixture": { mx: [], a: [] },
  "afallback.fixture": { mx: [], a: [{ type: 1, data: "93.184.216.34" }] },
  "dnserr.fixture": { error: true },
  "nullmx.fixture": { mx: [{ type: 15, data: "0 ." }] },
  "xn--bcher-kva.example": { mx: [{ type: 15, data: "10 mx.example." }] },
  "fresh-disposable.test": { mx: [{ type: 15, data: "10 mx.fresh-disposable.test." }] },
  "a.fresh-disposable.test": { mx: [{ type: 15, data: "10 mx.fresh-disposable.test." }] },
  "example.test": { mx: [{ type: 15, data: "10 mx.example.test." }] },
};
let fetches = [];
let fetchCalls = [];
let listBody = "fresh-disposable.test\n";
let listStatus = 200;
let allowProbe = false;
let probeBody = null;
globalThis.fetch = async (u, init) => {
  const s = String(u && u.url ? u.url : u);
  fetches.push(s);
  fetchCalls.push({ url: s, init });
  if (s.includes("disposable_email_blocklist.conf")) return new Response(listBody, { status: listStatus });
  if (s.startsWith("https://cloudflare-dns.com/dns-query")) {
    const q = new URL(s);
    const rec = records[q.searchParams.get("name")] || { mx: [], a: [] };
    if (rec.error) return new Response("dns", { status: 500 });
    const type = q.searchParams.get("type");
    const answers = type === "MX" ? rec.mx || [] : type === "A" ? rec.a || [] : [];
    return Response.json({ Status: 0, Answer: answers });
  }
  if (s.includes("probe.example")) {
    if (!allowProbe) throw new Error("smtp probe must not be called");
    return Response.json(probeBody || { smtp: "unknown", catch_all: "unknown", code: null, reason: "probe_unreachable" });
  }
  return new Response("nope", { status: 404 });
};

const env = (x = {}) => ({ EMAIL: "1", CLIENT_SALT: "t", RECEIPTS_DB: d1(), ...x });
async function addKey(e, id = "key-1", raw = RAW) {
  await e.RECEIPTS_DB.prepare("INSERT INTO api_keys (id, key_hash, email_hash, plan, monthly_quota, status, created_at, updated_at) VALUES (?, ?, 'eh', 'free', 500, 'active', 0, 0)").bind(id, await hashKey(e, raw)).run();
}
const post = (e, path, body, headers = {}) => worker.fetch(new Request(API + path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": RAW, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), e, { waitUntil() {} });
const keyRow = (e) => e.RECEIPTS_DB.prepare("SELECT plan, monthly_quota, email_plan, email_monthly_quota FROM api_keys WHERE id = 'key-1'").first();

test("version is 0.68.1 and the flag stays off in wrangler.toml", () => {
  assert.equal(VERSION, "0.68.1");
  const toml = readFileSync(join(ROOT, "worker", "wrangler.toml"), "utf8");
  assert.doesNotMatch(toml, /^EMAIL\s*=/m);
  assert.doesNotMatch(toml, /^STRIPE_PRICE_EMAIL_(STARTER|PRO|SCALE)\s*=/m);
  assert.doesNotMatch(toml, /^EMAIL_SMTP_(URL|SECRET)\s*=/m);
  assert.match(toml, /# EMAIL = "1"/);
  assert.match(toml, /# STRIPE_PRICE_EMAIL_STARTER = ""/);
  assert.match(toml, /# STRIPE_PRICE_EMAIL_SCALE = ""/);
  assert.match(toml, /crons = \["\*\/20 \* \* \* \*", "17 10 \* \* \*", "23 6 \* \* 1"\]/);
  const sql = readFileSync(join(ROOT, "worker", "migrations", "0030_email.sql"), "utf8");
  assert.match(sql, /email_plan/); assert.match(sql, /email_monthly_quota/); assert.match(sql, /emails/);
  assert.match(sql, /email_domain_cache/); assert.match(sql, /email_disposable_domains/);
  const grace = readFileSync(join(ROOT, "worker", "migrations", "0031_email_grace.sql"), "utf8");
  assert.match(grace, /email_stripe_subscription_id/); assert.match(grace, /email_grace_ends_at/);
});

test("404 when EMAIL is not 1: routes, and nothing in OpenAPI or llms.txt", async () => {
  for (const flag of [undefined, "", "0", "off"]) {
    const e = env({ EMAIL: flag });
    for (const p of [E.EMAIL_VALIDATE_PATH, E.EMAIL_BATCH_PATH, E.EMAIL_DOCS_PATH]) {
      const r = await post(e, p, { email: "a@gmail.com" });
      assert.equal(r.status, 404, flag + " " + p);
      const b = await r.json();
      assert.equal(b.checks, undefined);
      assert.notEqual(b.status, "unknown");
    }
  }
  assert.equal(openapi(API, {}).paths[E.EMAIL_VALIDATE_PATH], undefined);
  assert.equal(openapi(API, { EMAIL: "0" }).paths[E.EMAIL_BATCH_PATH], undefined);
  const llmsOff = await (await worker.fetch(new Request(API + "/llms.txt"), env({ EMAIL: undefined }), { waitUntil() {} })).text();
  assert.ok(!llmsOff.includes("/v1/email/validate"));
});

test("syntax edge cases, including IDNA and domain literals", () => {
  const ok = (s, email, ascii) => {
    const p = E.parseEmail(s);
    assert.equal(p.ok, true, s);
    assert.equal(p.email, email, s);
    if (ascii) assert.equal(p.asciiDomain, ascii, s);
  };
  const bad = (s) => assert.equal(E.parseEmail(s).ok, false, JSON.stringify(s));
  ok("User@Example.com", "user@example.com", "example.com");
  ok("user.name+tag@gmail.com", "user.name+tag@gmail.com", "gmail.com");
  ok('"foo bar"@example.com', '"foo bar"@example.com', "example.com");
  ok("user@gmail.com.", "user@gmail.com", "gmail.com");
  ok("User@Bücher.example", "user@bücher.example", "xn--bcher-kva.example");
  ok("user@[192.0.2.1]", "user@[192.0.2.1]", "[192.0.2.1]");
  ok("user@[2001:db8::1]", "user@[2001:db8::1]", "[2001:db8::1]");
  for (const s of ["", "   ", "nouser", "@gmail.com", "user@", "user@@gmail.com", ".user@gmail.com", "user.@gmail.com", "us..er@gmail.com", "user@.gmail.com", "user@gmail..com", "user@-gmail.com", "user@gmail-.com", "user name@gmail.com", "üser@gmail.com", "a".repeat(65) + "@gmail.com", "user@" + "a".repeat(64) + ".com", "user@gmail.c\\om", "<user@gmail.com>"]) bad(s);
  assert.equal(E.parseEmail(123).ok, false);
});

test("MX present, missing, A fallback, DNS error and null MX (mocked DoH)", async () => {
  const e = env(); await addKey(e);
  const one = async (email) => { const r = await post(e, E.EMAIL_VALIDATE_PATH, { email }); assert.equal(r.status, 200, email); return r.json(); };
  const g = await one("a@gmail.com");
  assert.equal(g.checks.mx, "present"); assert.equal(g.checks.syntax, "valid"); assert.equal(g.checks.smtp, "not_checked"); assert.equal(g.checks.catch_all, "not_checked");
  assert.equal(g.status, "unknown"); assert.equal(g.confidence, 0.4); assert.deepEqual(g.reasons, ["smtp_not_checked"]); assert.equal(g.suggestion, null);
  assert.notEqual(g.status, "deliverable");
  const miss = await one("a@nomx.fixture");
  assert.equal(miss.checks.mx, "missing"); assert.equal(miss.status, "undeliverable"); assert.deepEqual(miss.reasons, ["no_mx"]); assert.equal(miss.confidence, 0.95);
  const fb = await one("a@afallback.fixture");
  assert.equal(fb.checks.mx, "a_fallback"); assert.equal(fb.status, "risky"); assert.ok(fb.reasons.includes("no_mx_a_fallback")); assert.equal(fb.confidence, 0.55);
  const err = await one("a@dnserr.fixture");
  assert.equal(err.checks.mx, "error"); assert.equal(err.status, "unknown"); assert.deepEqual(err.reasons, ["dns_error"]); assert.equal(err.confidence, 0.2);
  const nul = await one("a@nullmx.fixture");
  assert.equal(nul.status, "undeliverable"); assert.deepEqual(nul.reasons, ["null_mx"]); assert.equal(nul.confidence, 0.99);
  const lit = await one("a@[192.0.2.1]");
  assert.equal(lit.checks.mx, "literal"); assert.equal(lit.status, "unknown"); assert.ok(lit.reasons.includes("domain_literal"));
  const idn = await one("User@Bücher.example");
  assert.equal(idn.email, "user@bücher.example"); assert.equal(idn.checks.mx, "present"); assert.notEqual(idn.status, "deliverable");
});

test("disposable domains (bundled list and subdomains) and role addresses", async () => {
  const e = env(); await addKey(e);
  const one = async (email) => (await post(e, E.EMAIL_VALIDATE_PATH, { email })).json();
  for (const email of ["throw@mailinator.com", "x@a.mailinator.com"]) {
    const b = await one(email);
    assert.equal(b.checks.disposable, true, email); assert.equal(b.status, "risky", email); assert.ok(b.reasons.includes("disposable_domain")); assert.notEqual(b.status, "deliverable");
  }
  for (const email of ["admin@gmail.com", "INFO@gmail.com", "support@gmail.com", "support+tickets@gmail.com", "postmaster@gmail.com"]) {
    const b = await one(email);
    assert.equal(b.checks.role, true, email); assert.equal(b.status, "risky", email); assert.ok(b.reasons.includes("role_address"));
  }
  const person = await one("ada@gmail.com");
  assert.equal(person.checks.role, false); assert.equal(person.checks.disposable, false); assert.equal(person.status, "unknown");
  const both = await one("admin@mailinator.com");
  assert.equal(both.checks.role, true); assert.equal(both.checks.disposable, true); assert.equal(both.confidence, 0.8);
});

test("typo suggestion gmial.com -> gmail.com, and status is still not deliverable", async () => {
  assert.equal(E.suggestDomain("gmial.com"), "gmail.com");
  assert.equal(E.suggestDomain("gmail.co"), "gmail.com");
  assert.equal(E.suggestDomain("gmail.com"), null);
  assert.equal(E.suggestDomain("zznotpopular.test"), null);
  const e = env(); await addKey(e);
  const b = await (await post(e, E.EMAIL_VALIDATE_PATH, { email: "User@Gmial.COM" })).json();
  assert.equal(b.email, "user@gmial.com"); assert.equal(b.suggestion, "user@gmail.com");
  assert.equal(b.checks.mx, "present"); assert.notEqual(b.status, "deliverable");
  assert.equal(b.status, b.checks.disposable ? "risky" : "unknown");
  const bad = await (await post(e, E.EMAIL_VALIDATE_PATH, { email: "not an email" })).json();
  assert.equal(bad.status, "undeliverable"); assert.equal(bad.confidence, 0.99); assert.deepEqual(bad.reasons, ["invalid_syntax"]); assert.equal(bad.suggestion, null);
});

test("status and confidence: deliverable only on a non-catch-all SMTP pass", () => {
  const clean = { syntax: "valid", mx: "present", disposable: false, role: false, catch_all: "not_checked" };
  const pass = E.classify({ ...clean, catch_all: false, smtp: "pass" });
  assert.equal(pass.status, "deliverable"); assert.equal(pass.confidence, 0.97); assert.equal(pass.checks.catch_all, "no"); assert.deepEqual(pass.reasons, []);
  const unchecked = E.classify({ ...clean, smtp: "pass" });
  assert.notEqual(unchecked.status, "deliverable"); assert.ok(unchecked.reasons.includes("catch_all_unconfirmed"));
  const caught = E.classify({ ...clean, catch_all: true, smtp: "unknown" });
  assert.equal(caught.status, "risky"); assert.ok(caught.reasons.includes("catch_all")); assert.notEqual(caught.status, "deliverable");
  const grey = E.classify({ ...clean, catch_all: "unknown", smtp: "unknown" });
  assert.equal(grey.status, "unknown"); assert.equal(grey.confidence, 0.35); assert.ok(grey.reasons.includes("smtp_unknown"));
  for (const smtp of ["not_checked", "fail", undefined, "error", ""]) {
    const c = E.classify({ ...clean, smtp });
    assert.notEqual(c.status, "deliverable", String(smtp));
    assert.ok(c.confidence >= 0 && c.confidence <= 1);
  }
  assert.equal(E.classify({ ...clean, catch_all: "no", smtp: "pass", role: true }).status, "risky");
  assert.equal(E.classify({ ...clean, catch_all: "no", smtp: "pass", disposable: true }).status, "risky");
  assert.equal(E.classify({ ...clean, smtp: "fail" }).status, "undeliverable");
  assert.equal(E.classify({ syntax: "invalid", smtp: "pass", mx: "present", catch_all: "no" }).status, "undeliverable");
  assert.deepEqual(E.interpretProbe({ code: 250, catch_all: false, smtp: "pass" }), { smtp: "pass", catch_all: "no", code: 250, reason: null });
  assert.equal(E.interpretProbe({ code: 250, catch_all: true, smtp: "pass" }).smtp, "unknown");
  assert.equal(E.interpretProbe({ code: 250, catch_all: true, smtp: "pass" }).catch_all, "yes");
  assert.notEqual(E.classify({ ...clean, ...E.interpretProbe({ code: 250, catch_all: true, smtp: "pass" }) }).status, "deliverable");
  assert.equal(E.interpretProbe({ code: 550, smtp: "fail" }).smtp, "fail");
  assert.equal(E.interpretProbe({ code: 450, smtp: "pass", catch_all: false }).smtp, "unknown");
  assert.equal(E.interpretProbe({ smtp: "pass", catch_all: false }).smtp, "unknown");
  const samples = [
    E.classify({ syntax: "invalid" }),
    E.classify({ ...clean, mx: "missing", smtp: "not_checked" }),
    E.classify({ ...clean, mx: "a_fallback", smtp: "not_checked" }),
    E.classify({ ...clean, mx: "error", smtp: "not_checked" }),
    E.classify({ ...clean, disposable: true, role: true, smtp: "not_checked" }),
  ];
  for (const c of samples) {
    assert.ok(c.confidence >= 0 && c.confidence <= 1, JSON.stringify(c));
    assert.notEqual(c.status, "deliverable");
    assert.equal(c.checks.smtp === "pass", false);
  }
});

test("quota is separate from render usage; batch caps at 100 and is all-or-nothing", async () => {
  const e = env(); await addKey(e);
  let row = await keyRow(e);
  assert.deepEqual([row.email_plan, row.email_monthly_quota, row.plan, row.monthly_quota], ["free", 1000, "free", 500]);
  assert.equal((await post(e, E.EMAIL_VALIDATE_PATH, { email: "a@gmail.com" }, { "x-api-key": "" })).status, 401);
  await e.RECEIPTS_DB.prepare("UPDATE api_keys SET email_monthly_quota = 2 WHERE id = 'key-1'").run();
  const a = await post(e, E.EMAIL_VALIDATE_PATH, { email: "a@gmail.com" });
  assert.equal(a.status, 200); assert.equal(a.headers.get("x-quota-limit"), "2"); assert.equal(a.headers.get("x-quota-remaining"), "1");
  assert.equal((await post(e, E.EMAIL_VALIDATE_PATH, { email: "b@gmail.com" })).status, 200);
  const over = await post(e, E.EMAIL_VALIDATE_PATH, { email: "c@gmail.com" });
  assert.equal(over.status, 429); assert.equal((await over.json()).reason, "quota_exceeded");
  const usage = await e.RECEIPTS_DB.prepare("SELECT kind, renders, emails FROM api_key_usage WHERE key_id = 'key-1'").first();
  assert.deepEqual([usage.kind, usage.renders, usage.emails], ["email", 0, 2], "email usage is kind=email and does not increment renders");
  const e2 = env(); await addKey(e2);
  await e2.RECEIPTS_DB.prepare("UPDATE api_keys SET email_monthly_quota = 2 WHERE id = 'key-1'").run();
  const too = await post(e2, E.EMAIL_BATCH_PATH, { emails: ["a@gmail.com", "b@gmail.com", "c@gmail.com"] });
  assert.equal(too.status, 429);
  assert.equal((await e2.RECEIPTS_DB.prepare("SELECT COUNT(*) AS n FROM api_key_usage").first()).n, 1);
  const held = await e2.RECEIPTS_DB.prepare("SELECT kind, emails, renders FROM api_key_usage").first();
  assert.deepEqual([held.kind, held.emails, held.renders], ["email", 0, 0], "rejected batch did not consume quota");
  const ok = await post(e2, E.EMAIL_BATCH_PATH, { emails: ["a@gmail.com", "admin@nomx.fixture"] });
  assert.equal(ok.status, 200);
  const results = (await ok.json()).results;
  assert.equal(results.length, 2);
  assert.equal(results[0].status, "unknown"); assert.equal(results[1].status, "undeliverable");
  assert.ok(results.every((r) => r.status !== "deliverable" && r.checks.smtp === "not_checked"));
  assert.equal((await post(e2, E.EMAIL_BATCH_PATH, { emails: Array.from({ length: 101 }, (_, i) => `u${i}@gmail.com`) })).status, 400);
  const bad = await (await post(e2, E.EMAIL_BATCH_PATH, { emails: "a@gmail.com" })).json();
  assert.equal(bad.reason, "invalid_body");
  assert.equal((await post(e, E.EMAIL_VALIDATE_PATH, {})).status, 400);
  const suspended = env(); await addKey(suspended);
  await suspended.RECEIPTS_DB.prepare("UPDATE api_keys SET status = 'suspended'").run();
  assert.equal((await post(suspended, E.EMAIL_VALIDATE_PATH, { email: "a@gmail.com" })).status, 403);
  assert.equal((await worker.fetch(new Request(API + E.EMAIL_VALIDATE_PATH), e, { waitUntil() {} })).status, 405);
});

test("email validate and batch do not change render usage, and render calls do not change email usage", async () => {
  const e = env({ RENDER: "1" }); await addKey(e);
  const renderUsed = () => e.RECEIPTS_DB.prepare("SELECT COALESCE(SUM(renders), 0) AS n FROM api_key_usage WHERE key_id = 'key-1' AND kind IN ('pdf', 'shot', 'card')").first();
  const emailRow = () => e.RECEIPTS_DB.prepare("SELECT kind, renders, emails FROM api_key_usage WHERE key_id = 'key-1' AND kind = 'email'").first();
  assert.equal((await renderUsed()).n, 0);
  assert.equal(await emailRow(), null);
  assert.equal((await post(e, E.EMAIL_VALIDATE_PATH, { email: "a@gmail.com" })).status, 200);
  assert.equal((await post(e, E.EMAIL_BATCH_PATH, { emails: ["b@gmail.com", "c@nomx.fixture"] })).status, 200);
  let em = await emailRow();
  assert.equal(em.kind, "email"); assert.equal(em.renders, 0); assert.equal(em.emails, 3);
  assert.equal((await renderUsed()).n, 0, "validate and batch did not spend pdf, shot or card");
  assert.equal((await e.RECEIPTS_DB.prepare("SELECT COUNT(*) AS n FROM api_key_usage WHERE key_id = 'key-1' AND kind != 'email'").first()).n, 0);
  const key = await loadKey(e, RAW);
  assert.equal((await reserveQuota(e, key, new Date(), "pdf")).ok, true);
  assert.equal((await reserveQuota(e, key, new Date(), "card")).ok, true);
  assert.equal((await reserveQuota(e, key, new Date(), "screenshot")).ok, true);
  em = await emailRow();
  assert.equal(em.emails, 3); assert.equal(em.renders, 0, "render calls left the email counter alone");
  assert.equal((await renderUsed()).n, 3);
  assert.equal((await post(e, E.EMAIL_VALIDATE_PATH, { email: "d@gmail.com" })).status, 200);
  assert.equal((await emailRow()).emails, 4);
  assert.equal((await e.RECEIPTS_DB.prepare("SELECT renders FROM api_key_usage WHERE key_id = 'key-1' AND kind = 'pdf'").first()).renders, 1);
  assert.equal((await e.RECEIPTS_DB.prepare("SELECT renders FROM api_key_usage WHERE key_id = 'key-1' AND kind = 'card'").first()).renders, 1);
  assert.equal((await e.RECEIPTS_DB.prepare("SELECT renders FROM api_key_usage WHERE key_id = 'key-1' AND kind = 'shot'").first()).renders, 1);
});

test("domain cache keeps an MX result for 24 hours", async () => {
  const e = env(); await addKey(e);
  const call = (now) => E.handleEmailValidate(new Request(API + E.EMAIL_VALIDATE_PATH, { method: "POST", headers: { "content-type": "application/json", "x-api-key": RAW }, body: JSON.stringify({ email: "cache@gmail.com" }) }), e, {}, new URL(API + E.EMAIL_VALIDATE_PATH), { now });
  fetches = [];
  assert.equal((await call(new Date("2026-11-05T00:00:00Z"))).status, 200);
  assert.equal((await call(new Date("2026-11-05T12:00:00Z"))).status, 200);
  const mid = fetches.filter((u) => u.includes("name=gmail.com") && u.includes("type=MX")).length;
  assert.equal(mid, 1, "second call used the cache");
  assert.equal((await call(new Date("2026-11-06T00:01:00Z"))).status, 200);
  assert.equal(fetches.filter((u) => u.includes("name=gmail.com") && u.includes("type=MX")).length, 2, "after 24h it looks up again");
  const cached = await e.RECEIPTS_DB.prepare("SELECT mx, catch_all FROM email_domain_cache WHERE domain = 'gmail.com'").first();
  assert.equal(cached.mx, "present"); assert.equal(cached.catch_all, "not_checked");
});

test("weekly cron refreshes disposable domains; the flag off does not fetch", async () => {
  listBody = ["# comment", "", "fresh-disposable.test", ...Array.from({ length: 100 }, (_, i) => `d${i}.refresh.test`)].join("\n");
  const off = env({ EMAIL: undefined });
  fetches = [];
  await worker.scheduled({ cron: E.EMAIL_DISPOSABLE_CRON, scheduledTime: Date.now() }, off, { waitUntil() {} });
  assert.ok(!fetches.some((u) => u.includes("disposable_email_blocklist")));
  const e = env(); await addKey(e);
  fetches = [];
  await worker.scheduled({ cron: E.EMAIL_DISPOSABLE_CRON, scheduledTime: Date.now() }, e, { waitUntil() {} });
  assert.ok(fetches.some((u) => u.includes("disposable_email_blocklist.conf")));
  const n = await e.RECEIPTS_DB.prepare("SELECT COUNT(*) AS n FROM email_disposable_domains").first();
  assert.ok(n.n >= 100);
  const b = await (await post(e, E.EMAIL_VALIDATE_PATH, { email: "a@a.fresh-disposable.test" })).json();
  assert.equal(b.checks.disposable, true); assert.equal(b.status, "risky");
  const tiny = await E.refreshDisposableDomains(e, { min: 100, fetchImpl: async () => new Response("only.example\n", { status: 200 }) });
  assert.equal(tiny.ok, false); assert.equal(tiny.reason, "list_too_small");
  assert.equal((await e.RECEIPTS_DB.prepare("SELECT COUNT(*) AS n FROM email_disposable_domains").first()).n, n.n, "a short list does not wipe the table");
  const parsed = E.parseDisposableList("# c\n\n*.Foo.example\nnot a domain\nbar.example\n");
  assert.deepEqual(parsed, ["foo.example", "bar.example"]);
});

test("SMTP probe is off by default, and a signed call maps 250, catch-all, 5xx, 4xx and provider skip", async () => {
  assert.equal(E.smtpProbeEnabled({}), false);
  assert.equal(await E.buildSmtpProbeRequest({}, "a@gmail.com"), null);
  assert.equal(await E.buildSmtpProbeRequest({ EMAIL_SMTP_URL: "http://probe.example/v1", EMAIL_SMTP_SECRET: "s" }, "a@gmail.com"), null);
  const now = new Date("2026-11-05T12:00:00Z");
  const built = await E.buildSmtpProbeRequest({ EMAIL_SMTP_URL: "https://probe.example/v1", EMAIL_SMTP_SECRET: "secret" }, "a@example.test", now);
  assert.equal(built.method, "POST"); assert.equal(built.url, "https://probe.example/v1");
  assert.match(built.headers["x-email-probe-signature"], /^v1=[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(built.body), { v: 1, ts: Math.floor(now.getTime() / 1000), email: "a@example.test" });
  assert.equal(built.headers["x-email-probe-signature"], "v1=" + await hmacHex("secret", built.body));
  const off = env(); await addKey(off);
  fetches = [];
  const quiet = await (await post(off, E.EMAIL_VALIDATE_PATH, { email: "a@example.test" })).json();
  assert.equal(quiet.checks.smtp, "not_checked"); assert.notEqual(quiet.status, "deliverable");
  assert.ok(!fetches.some((u) => u.includes("probe.example")));
  const e = env({ EMAIL_SMTP_URL: "https://probe.example/v1", EMAIL_SMTP_SECRET: "secret" }); await addKey(e);
  const one = async (body) => {
    allowProbe = true; probeBody = body; fetchCalls = [];
    const res = await post(e, E.EMAIL_VALIDATE_PATH, { email: "User@Example.TEST" });
    assert.equal(res.status, 200);
    const call = fetchCalls.find((c) => c.url.includes("probe.example"));
    assert.ok(call, "probe was called");
    const sent = JSON.parse(call.init.body);
    assert.equal(sent.v, 1); assert.equal(sent.email, "user@example.test"); assert.equal(typeof sent.ts, "number");
    assert.equal(call.init.headers["x-email-probe-signature"], "v1=" + await hmacHex("secret", call.init.body));
    return res.json();
  };
  const pass = await one({ v: 1, email: "user@example.test", smtp: "pass", code: 250, catch_all: false, reason: "rcpt_accepted" });
  assert.equal(pass.status, "deliverable"); assert.equal(pass.confidence, 0.97); assert.equal(pass.checks.smtp, "pass"); assert.equal(pass.checks.catch_all, "no");
  const cached = await e.RECEIPTS_DB.prepare("SELECT catch_all FROM email_domain_cache WHERE domain = 'example.test'").first();
  assert.equal(cached.catch_all, "no");
  const all = await one({ v: 1, email: "user@example.test", smtp: "pass", code: 250, catch_all: true, reason: "catch_all" });
  assert.equal(all.status, "risky"); assert.ok(all.reasons.includes("catch_all")); assert.notEqual(all.status, "deliverable");
  const reject = await one({ v: 1, email: "user@example.test", smtp: "fail", code: 550, catch_all: false, reason: "rcpt_reject" });
  assert.equal(reject.status, "undeliverable"); assert.equal(reject.checks.smtp, "fail"); assert.ok(reject.reasons.includes("smtp_reject"));
  const grey = await one({ v: 1, email: "user@example.test", smtp: "unknown", code: 450, catch_all: "unknown", reason: "greylist" });
  assert.equal(grey.status, "unknown"); assert.ok(grey.reasons.includes("greylist")); assert.notEqual(grey.status, "deliverable");
  allowProbe = true; probeBody = { v: 1, email: "a@gmail.com", smtp: "unknown", code: null, catch_all: "unknown", reason: "provider_skip" };
  const gmail = await (await post(e, E.EMAIL_VALIDATE_PATH, { email: "a@gmail.com" })).json();
  assert.equal(gmail.status, "unknown"); assert.ok(gmail.reasons.includes("provider_skip")); assert.notEqual(gmail.status, "deliverable");
  const lied = await one({ v: 1, email: "user@example.test", smtp: "pass", catch_all: false });
  assert.notEqual(lied.status, "deliverable", "a pass without code 250 is not deliverable");
  allowProbe = false;
});

test("webhook maps email price ids onto the email plan and leaves the render plan alone; blank ids match nothing", async () => {
  assert.equal(emailPlanForPrice({ STRIPE_PRICE_EMAIL_STARTER: "", STRIPE_PRICE_EMAIL_PRO: "", STRIPE_PRICE_EMAIL_SCALE: "" }, "price_email_starter"), null);
  assert.equal(emailPlanForPrice({}, "price_email_starter"), null);
  assert.equal(emailPlanForPrice({ STRIPE_PRICE_EMAIL_SCALE: "price_email_scale" }, "price_email_free"), null, "the free tier has no price id");
  assert.deepEqual([E.EMAIL_PLANS.free.quota, E.EMAIL_PLANS.starter.quota, E.EMAIL_PLANS.pro.quota, E.EMAIL_PLANS.scale.quota], [1000, 10000, 50000, 200000]);
  assert.equal(E.EMAIL_PLANS.free.priceUsd, 0);
  assert.deepEqual(priceToPlan({ STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_EMAIL_STARTER: "price_email_starter" }, "price_pro"), { product: "render", plan: "pro" });
  assert.deepEqual(priceToPlan({ STRIPE_PRICE_EMAIL_STARTER: "price_email_starter", STRIPE_PRICE_EMAIL_PRO: "price_email_pro" }, "price_email_pro"), { product: "email", plan: "pro" });
  assert.deepEqual(priceToPlan({ STRIPE_PRICE_PRO: "price_pro", STRIPE_PRICE_EMAIL_SCALE: "price_email_scale" }, "price_email_scale"), { product: "email", plan: "scale" });
  assert.equal(emailPlanForPrice({ STRIPE_PRICE_PRO: "price_email_scale", STRIPE_PRICE_EMAIL_SCALE: "price_email_scale" }, "price_email_scale"), null);
  assert.equal(emailPlanForPrice({ STRIPE_PRICE_EMAIL_STARTER: "price_email_starter", STRIPE_PRICE_EMAIL_PRO: "price_email_pro", STRIPE_PRICE_EMAIL_SCALE: "" }, "price_email_scale"), null, "a blank scale price id matches nothing");
  assert.equal(emailPlanForPrice({ STRIPE_PRICE_EMAIL_SCALE: "   " }, "price_email_scale"), null);
  assert.equal(emailPlanForPrice({ STRIPE_PRICE_EMAIL_SCALE: "price_email_scale" }, "price_email_scale"), "scale");
  assert.equal(priceToPlan({ STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_EMAIL_STARTER: "price_starter" }, "price_starter").product, "render");
  const e = env({
    RENDER: "1", BILLING: "1", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_test_fixture",
    STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_PRO: "price_pro",
    STRIPE_PRICE_EMAIL_STARTER: "price_email_starter", STRIPE_PRICE_EMAIL_PRO: "price_email_pro", STRIPE_PRICE_EMAIL_SCALE: "price_email_scale",
  });
  await addKey(e);
  const send = async (ev) => {
    const raw = JSON.stringify(ev); const t = Math.floor(Date.now() / 1000);
    return worker.fetch(new Request(API + BILLING_WEBHOOK_PATH, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${await hmacHex("whsec_test_fixture", t + "." + raw)}`, "content-type": "application/json" }, body: raw }), e, { waitUntil() {} });
  };
  const sub = (id, price, product) => ({ id, type: "customer.subscription.updated", data: { object: { id: "sub_" + id, status: "active", metadata: { key_id: "key-1", ...(product ? { product } : {}) }, items: { data: [{ price: { id: price } }] } } } });
  let r = await send(sub("evt_email", "price_email_starter", "email"));
  assert.equal(r.status, 200); assert.equal((await r.json()).outcome, "email_plan_starter");
  let k = await keyRow(e);
  assert.deepEqual([k.email_plan, k.email_monthly_quota, k.plan, k.monthly_quota], ["starter", E.EMAIL_PLANS.starter.quota, "free", 500]);
  r = await send({ id: "evt_co", type: "checkout.session.completed", data: { object: { mode: "subscription", payment_status: "paid", client_reference_id: "key-1", metadata: { plan: "pro", product: "email", price: "price_email_pro" }, items: { data: [{ price: { id: "price_email_pro" } }] } } } });
  assert.equal((await r.json()).outcome, "email_plan_pro");
  k = await keyRow(e); assert.deepEqual([k.email_plan, k.email_monthly_quota, k.plan], ["pro", E.EMAIL_PLANS.pro.quota, "free"]);
  r = await send(sub("evt_render", "price_pro"));
  assert.equal((await r.json()).outcome, "plan_pro");
  k = await keyRow(e); assert.equal(k.plan, "pro"); assert.equal(k.monthly_quota, 25000); assert.equal(k.email_plan, "pro", "render price did not clear the email plan");
  r = await send({ id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_email", status: "canceled", metadata: { key_id: "key-1", product: "email" }, items: { data: [{ price: { id: "price_email_pro" } }] } } } });
  assert.equal((await r.json()).outcome, "email_free");
  k = await keyRow(e); assert.equal(k.email_plan, "free"); assert.equal(k.email_monthly_quota, E.EMAIL_PLANS.free.quota); assert.equal(k.plan, "pro");
  r = await send(sub("evt_scale", "price_email_scale", "email"));
  assert.equal((await r.json()).outcome, "email_plan_scale");
  k = await keyRow(e); assert.deepEqual([k.email_plan, k.email_monthly_quota, k.plan], ["scale", E.EMAIL_PLANS.scale.quota, "pro"]);
  const subId = await e.RECEIPTS_DB.prepare("SELECT email_stripe_subscription_id FROM api_keys WHERE id = 'key-1'").first();
  assert.equal(subId.email_stripe_subscription_id, "sub_evt_scale");
  const created = Math.floor(Date.now() / 1000) - 3600;
  r = await send({ id: "evt_efail", type: "invoice.payment_failed", created, data: { object: { subscription: "sub_evt_scale" } } });
  assert.equal((await r.json()).outcome, "email_grace_until_later");
  let grace = await e.RECEIPTS_DB.prepare("SELECT plan, email_plan, email_monthly_quota, grace_ends_at, email_grace_ends_at FROM api_keys WHERE id = 'key-1'").first();
  assert.equal(grace.plan, "pro", "render plan is untouched");
  assert.equal(grace.email_plan, "scale"); assert.equal(grace.email_monthly_quota, E.EMAIL_PLANS.scale.quota);
  assert.equal(grace.grace_ends_at, null); assert.equal(grace.email_grace_ends_at, created + 3 * 86400);
  r = await send({ id: "evt_efail2", type: "invoice.payment_failed", created: created + 86400, data: { object: { subscription: "sub_evt_scale" } } });
  assert.equal((await e.RECEIPTS_DB.prepare("SELECT email_grace_ends_at FROM api_keys WHERE id = 'key-1'").first()).email_grace_ends_at, created + 3 * 86400, "a later failure does not extend grace");
  const inside = await post(e, E.EMAIL_VALIDATE_PATH, { email: "a@gmail.com" });
  assert.equal(inside.headers.get("x-quota-limit"), String(E.EMAIL_PLANS.scale.quota));
  r = await send({ id: "evt_epaid", type: "invoice.paid", data: { object: { subscription: "sub_evt_scale" } } });
  assert.equal((await r.json()).outcome, "email_grace_cleared");
  assert.equal((await e.RECEIPTS_DB.prepare("SELECT email_plan, email_grace_ends_at FROM api_keys WHERE id = 'key-1'").first()).email_grace_ends_at, null);
  r = await send({ id: "evt_efail3", type: "invoice.payment_failed", created, data: { object: { subscription: "sub_evt_scale" } } });
  assert.equal((await r.json()).outcome, "email_grace_until_later");
  const expired = new Date((created + 3 * 86400 + 5) * 1000);
  const dropped = await worker.fetch(new Request(API + E.EMAIL_VALIDATE_PATH, { method: "POST", headers: { "content-type": "application/json", "x-api-key": RAW }, body: JSON.stringify({ email: "a@gmail.com" }) }), e, { waitUntil() {} });
  // the handler uses the current clock unless opts.now is passed; call the handler directly for the grace boundary
  assert.equal(dropped.status, 200);
  const atGrace = await E.handleEmailValidate(new Request(API + E.EMAIL_VALIDATE_PATH, { method: "POST", headers: { "content-type": "application/json", "x-api-key": RAW }, body: JSON.stringify({ email: "a@gmail.com" }) }), e, {}, new URL(API + E.EMAIL_VALIDATE_PATH), { now: expired });
  assert.equal(atGrace.headers.get("x-quota-limit"), String(E.EMAIL_PLANS.free.quota));
  const after = await e.RECEIPTS_DB.prepare("SELECT email_plan, email_monthly_quota, email_grace_ends_at, plan FROM api_keys WHERE id = 'key-1'").first();
  assert.deepEqual([after.email_plan, after.email_monthly_quota, after.email_grace_ends_at, after.plan], ["free", E.EMAIL_PLANS.free.quota, null, "pro"]);
  const blank = env({ RENDER: "1", BILLING: "1", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_test_fixture", STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_PRO: "price_pro" });
  await addKey(blank);
  const raw = JSON.stringify(sub("evt_blank", "price_email_starter", "email")); const t = Math.floor(Date.now() / 1000);
  const br = await worker.fetch(new Request(API + BILLING_WEBHOOK_PATH, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${await hmacHex("whsec_test_fixture", t + "." + raw)}` }, body: raw }), blank, { waitUntil() {} });
  assert.equal((await br.json()).outcome, "ignored_no_price");
  assert.deepEqual([(await keyRow(blank)).email_plan, (await keyRow(blank)).plan], ["free", "free"], "an unmapped email-tagged price changes neither plan");
});

test("a blank or missing email price id never grants the email plan and never matches another plan", async () => {
  const probes = ["", "   ", "price_starter", "price_pro", "price_email_starter", "price_email_scale", "price_1real"];
  for (const [label, emailEnv] of [
    ["missing", {}],
    ["blank", { STRIPE_PRICE_EMAIL_STARTER: "", STRIPE_PRICE_EMAIL_PRO: "", STRIPE_PRICE_EMAIL_SCALE: "" }],
    ["whitespace", { STRIPE_PRICE_EMAIL_STARTER: "   ", STRIPE_PRICE_EMAIL_PRO: " \t", STRIPE_PRICE_EMAIL_SCALE: "  " }],
  ]) {
    const base = { STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_PRO: "price_pro", ...emailEnv };
    assert.equal(configuredPriceId(emailEnv.STRIPE_PRICE_EMAIL_STARTER), null, label);
    assert.equal(configuredPriceId(emailEnv.STRIPE_PRICE_EMAIL_PRO), null, label);
    assert.equal(configuredPriceId(emailEnv.STRIPE_PRICE_EMAIL_SCALE), null, label);
    for (const price of probes) {
      assert.equal(emailPlanForPrice(base, price), null, label + " " + JSON.stringify(price));
      const mapped = priceToPlan(base, price);
      assert.notEqual(mapped && mapped.product, "email", label + " " + JSON.stringify(price));
    }
    assert.equal(priceToPlan(base, ""), null, label);
    assert.equal(priceToPlan(base, "   "), null, label);
    assert.deepEqual(priceToPlan(base, "price_starter"), { product: "render", plan: "starter" }, label);
    assert.equal(planForPrice({ STRIPE_PRICE_STARTER: "", STRIPE_PRICE_PRO: "   ", ...emailEnv }, ""), null, label);
    assert.equal(planForPrice({ STRIPE_PRICE_STARTER: "", STRIPE_PRICE_PRO: "", ...emailEnv }, "price_starter"), null, label);
    assert.equal(emailPlanForPrice({ STRIPE_PRICE_EMAIL_STARTER: "", STRIPE_PRICE_EMAIL_PRO: "" }, ""), null, label);
    const e = env({ RENDER: "1", BILLING: "1", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_test_fixture", STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_PRO: "price_pro", ...emailEnv });
    await addKey(e, "key-" + label);
    const send = async (ev) => {
      const raw = JSON.stringify(ev); const t = Math.floor(Date.now() / 1000);
      return worker.fetch(new Request(API + BILLING_WEBHOOK_PATH, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${await hmacHex("whsec_test_fixture", t + "." + raw)}`, "content-type": "application/json" }, body: raw }), e, { waitUntil() {} });
    };
    const updated = await send({ id: "evt_u_" + label, type: "customer.subscription.updated", data: { object: { id: "sub_u", status: "active", metadata: { key_id: "key-" + label, product: "email" }, items: { data: [{ price: { id: "price_pro" } }] } } } });
    assert.equal((await updated.json()).outcome, "ignored_no_price", label);
    const checkout = await send({ id: "evt_c_" + label, type: "checkout.session.completed", data: { object: { mode: "subscription", payment_status: "paid", client_reference_id: "key-" + label, metadata: { plan: "pro", product: "email", price: "" } } } });
    assert.equal((await checkout.json()).outcome, "ignored_no_price", label);
    const row = await e.RECEIPTS_DB.prepare("SELECT plan, monthly_quota, email_plan, email_monthly_quota FROM api_keys WHERE id = ?").bind("key-" + label).first();
    assert.deepEqual([row.plan, row.monthly_quota, row.email_plan, row.email_monthly_quota], ["free", 500, "free", 1000], label);
  }
});

test("docs and OpenAPI mark the feature unreleased and only when EMAIL=1", async () => {
  const e = env();
  const docs = await (await worker.fetch(new Request(API + E.EMAIL_DOCS_PATH), e, { waitUntil() {} })).json();
  assert.equal(docs.released, false); assert.equal(docs.priced, false); assert.match(docs.status_rule, /not_checked/); assert.match(docs.status_rule, /250/);
  assert.match(docs.checks.smtp, /not_checked/); assert.match(docs.checks.smtp, /pass/);
  assert.match(docs.free_tier, /1,000/); assert.equal(docs.plans.free.quota, 1000); assert.equal(docs.plans.free.priceUsd, 0);
  assert.deepEqual([docs.plans.starter.quota, docs.plans.pro.quota, docs.plans.scale.quota], [10000, 50000, 200000]);
  const oa = openapi(API, { EMAIL: "1" });
  assert.equal(oa.paths[E.EMAIL_VALIDATE_PATH].post["x-unreleased"], true);
  assert.match(oa.paths[E.EMAIL_VALIDATE_PATH].post.summary, /UNRELEASED/);
  assert.match(oa.paths[E.EMAIL_BATCH_PATH].post.summary, /UNRELEASED/);
  assert.equal(oa.paths[E.EMAIL_DOCS_PATH].get["x-unreleased"], true);
  const llms = await (await worker.fetch(new Request(API + "/llms.txt"), e, { waitUntil() {} })).text();
  assert.ok(llms.includes("UNRELEASED") && llms.includes("/v1/email/validate") && llms.includes("/v1/email/batch"));
});
