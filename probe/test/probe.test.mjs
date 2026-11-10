import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLimiter, readDailyCap } from "../src/limit.js";
import { dailyFileStore } from "../src/state.js";
import { hmacHex, verifySignedBody, createReplayCache } from "../src/sign.js";
import { isProviderMx, smtpDialogue, EHLO_HOST, MAIL_FROM } from "../src/smtp.js";
import { isPublicIp } from "../src/public-ip.js";
import { probeEmail } from "../src/probe.js";
import { handleProbe, startServer } from "../src/server.js";
import { connectSmtp } from "../src/net.js";
import { buildSmtpProbeRequest } from "../../worker/src/email.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const SECRET = "0123456789abcdef";
const NOW = new Date("2026-11-05T12:00:00Z");

function scripted(replies) {
  let i = 0;
  return {
    async readReply() {
      const lines = replies[i++];
      if (!lines) throw new Error("no_reply");
      return lines;
    },
    async write() {},
    close() {},
  };
}
const banner = [
  ["220 mx.example.test ESMTP"],
  ["250-mx.example.test", "250-PIPELINING", "250 OK"],
  ["250 2.1.0 OK"],
];
function dnsPublic() {
  return {
    async resolveMx() { return [{ priority: 10, exchange: "mx.example.test" }]; },
    async resolve4() { return ["93.184.216.34"]; },
    async resolve6() { return []; },
  };
}
function deps(over = {}) {
  return {
    secret: SECRET,
    now: () => NOW,
    replay: createReplayCache(),
    limiter: createLimiter({ dailyCap: 300, perMinute: 4, maxConcurrent: 2, now: () => NOW.getTime() }),
    dns: dnsPublic(),
    connect: async (ip, port) => {
      assert.equal(ip, "93.184.216.34");
      assert.equal(port, 25);
      return scripted([...banner, ["250 2.1.5 OK"], ["550 5.1.1 no such user"]]);
    },
    ehlo: EHLO_HOST,
    mailFrom: MAIL_FROM,
    randomLocal: () => "no-such-aaaaaaaaaaaaaaaa",
    timeoutMs: 1000,
    ...over,
  };
}

test("public addresses exclude loopback, private, link-local and documentation ranges", () => {
  assert.equal(isPublicIp("93.184.216.34"), true);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});

test("provider MX names are recognized and ordinary hosts are not", () => {
  for (const host of ["gmail-smtp-in.l.google.com", "aspmx.l.google.com", "alt1.aspmx.l.google.com", "example.mail.protection.outlook.com", "mta7.am0.yahoodns.net", "mx1.mail.yahoo.com"]) {
    assert.equal(isProviderMx(host), true, host);
  }
  assert.equal(isProviderMx("mx.example.test"), false);
  assert.equal(isProviderMx("notgoogle.com"), false);
  assert.equal(isProviderMx("google.com.evil.test"), false);
});

test("dialogue sends EHLO, MAIL FROM, RCPT, a random RCPT, and QUIT, and never a body", async () => {
  const session = scripted([...banner, ["250 2.1.5 OK"], ["550 5.1.1 no such user"]]);
  const sent = [];
  session.write = async (line) => { sent.push(line.replace(/\r\n$/, "")); };
  const r = await smtpDialogue({ local: "user", domain: "example.test" }, session, deps());
  assert.deepEqual(sent, [
    "EHLO " + EHLO_HOST,
    "MAIL FROM:<" + MAIL_FROM + ">",
    "RCPT TO:<user@example.test>",
    "RCPT TO:<no-such-aaaaaaaaaaaaaaaa@example.test>",
    "QUIT",
  ]);
  assert.equal(r.smtp, "pass");
  assert.equal(r.code, 250);
  assert.equal(r.catch_all, false);
  assert.ok(sent.every((line) => !/^DATA\b/i.test(line)));
});

test("a 250 on the random recipient is a catch-all and is not a pass", async () => {
  const r = await probeEmail("user@example.test", deps({
    connect: async () => scripted([...banner, ["250 2.1.5 OK"], ["250 2.1.5 OK"]]),
  }));
  assert.equal(r.reason, "catch_all");
  assert.equal(r.catch_all, true);
  assert.equal(r.smtp, "unknown");
  assert.notEqual(r.smtp, "pass");
  assert.ok(r.transcript.every((line) => !/^DATA\b/i.test(line)));
});

test("a 4xx is unknown and the next probe to that MX does not connect", async () => {
  let connects = 0;
  const d = deps({
    connect: async () => {
      connects += 1;
      return scripted([...banner, ["450 4.2.0 greylisted"]]);
    },
  });
  const a = await probeEmail("user@example.test", d);
  assert.equal(a.smtp, "unknown");
  assert.equal(a.reason, "greylist");
  assert.equal(a.code, 450);
  const b = await probeEmail("other@example.test", d);
  assert.equal(b.reason, "mx_backoff");
  assert.equal(connects, 1);
  assert.ok(!a.transcript.some((line) => line.startsWith("RCPT TO:<no-such-")));
});

test("a 5xx on RCPT is a fail, and a 5xx on MAIL FROM does not call the recipient undeliverable", async () => {
  const rejected = await probeEmail("user@example.test", deps({
    connect: async () => scripted([...banner, ["550 5.1.1 no such user"]]),
  }));
  assert.equal(rejected.smtp, "fail");
  assert.equal(rejected.code, 550);
  const sender = await probeEmail("user@example.test", deps({
    connect: async () => scripted([banner[0], banner[1], ["550 5.7.1 bad sender"]]),
  }));
  assert.equal(sender.smtp, "unknown");
  assert.equal(sender.reason, "sender_rejected");
});

test("Gmail, Outlook and Yahoo MX return unknown without a connection", async () => {
  for (const [domain, exchange] of [
    ["gmail.com", "gmail-smtp-in.l.google.com"],
    ["outlook.com", "example.mail.protection.outlook.com"],
    ["yahoo.com", "mta7.am0.yahoodns.net"],
  ]) {
    let looked = false;
    let connected = false;
    const r = await probeEmail("user@" + domain, deps({
      dns: {
        async resolveMx() { return [{ priority: 1, exchange }]; },
        async resolve4() { looked = true; return ["93.184.216.34"]; },
        async resolve6() { return []; },
      },
      connect: async () => { connected = true; throw new Error("connected"); },
    }));
    assert.equal(r.reason, "provider_skip", domain);
    assert.equal(r.smtp, "unknown");
    assert.equal(looked, false, domain);
    assert.equal(connected, false, domain);
  }
});

test("private and missing MX do not connect", async () => {
  let connects = 0;
  const connect = async () => { connects += 1; throw new Error("connected"); };
  const priv = await probeEmail("user@example.test", deps({
    dns: { async resolveMx() { return [{ priority: 1, exchange: "mx.example.test" }]; }, async resolve4() { return ["127.0.0.1", "10.1.2.3"]; }, async resolve6() { return ["::1"]; } },
    connect,
  }));
  assert.equal(priv.reason, "non_public_mx");
  const none = await probeEmail("user@example.test", deps({
    dns: { async resolveMx() { const e = new Error("no"); e.code = "ENOTFOUND"; throw e; }, async resolve4() { return []; }, async resolve6() { return []; } },
    connect,
  }));
  assert.equal(none.reason, "no_mx");
  assert.equal(connects, 0);
});

test("per-MX concurrency stays at 2, the minute window stays small, and 4xx backs off", async () => {
  const lim = createLimiter({ dailyCap: 100, perMinute: 100, maxConcurrent: 9, now: () => 0 });
  assert.equal(lim.maxConcurrent, 2);
  assert.equal(lim.perMinute, 6);
  const held = [lim.tryAcquire("mx", 0), lim.tryAcquire("mx", 1)];
  assert.equal(lim.tryAcquire("mx", 2).reason, "mx_busy");
  held.forEach((s) => s.release());
  const rate = createLimiter({ dailyCap: 100, perMinute: 2, now: () => 0 });
  rate.tryAcquire("mx", 0).release();
  rate.tryAcquire("mx", 1).release();
  assert.equal(rate.tryAcquire("mx", 2).reason, "mx_rate");
  assert.equal(rate.tryAcquire("mx", 60_002).ok, true);
  const back = createLimiter({ dailyCap: 10, perMinute: 6, now: () => 0 });
  back.tryAcquire("mx", 0).release();
  back.note4xx("mx", 0);
  assert.equal(back.tryAcquire("mx", 59_000).reason, "mx_backoff");
  const again = back.tryAcquire("mx", 60_001);
  assert.equal(again.ok, true);
  again.release();
  back.note4xx("mx", 60_001);
  assert.equal(back.tryAcquire("mx", 60_001 + 119_000).reason, "mx_backoff");
  assert.equal(back.tryAcquire("mx", 60_001 + 120_001).ok, true);
});

test("the daily cap defaults to 300, persists, and resets the next UTC day", () => {
  assert.equal(readDailyCap({}), 300);
  assert.equal(readDailyCap({ PROBE_DAILY_CAP: "300" }), 300);
  assert.equal(readDailyCap({ PROBE_DAILY_CAP: "0" }), 0);
  assert.equal(readDailyCap({ PROBE_DAILY_CAP: "nope" }), 300);
  assert.equal(readDailyCap({ PROBE_DAILY_CAP: "-1" }), 300);
  const dir = mkdtempSync(join(tmpdir(), "probe-daily-"));
  try {
    const store = dailyFileStore(dir);
    const t = Date.parse("2026-11-05T00:00:00Z");
    const lim = createLimiter({ dailyCap: 2, loadDaily: () => store.load(), saveDaily: (d) => store.save(d), now: () => t });
    assert.equal(lim.tryAcquire("a", t).ok, true);
    assert.equal(lim.tryAcquire("b", t).ok, true);
    assert.equal(lim.tryAcquire("c", t).reason, "daily_cap");
    const again = createLimiter({ dailyCap: 2, loadDaily: () => store.load(), saveDaily: (d) => store.save(d), now: () => t });
    assert.equal(again.tryAcquire("d", t).reason, "daily_cap");
    assert.equal(again.tryAcquire("d", Date.parse("2026-11-06T00:00:00Z")).ok, true);
    const raw = readFileSync(join(dir, "daily.json"), "utf8");
    assert.match(raw, /"count":/);
    assert.ok(!raw.includes("@"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a third concurrent probe and a second probe past the daily cap do not open a socket", async () => {
  let connects = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const d = deps({
    connect: () => {
      connects += 1;
      return gate.then(() => scripted([...banner, ["250 2.1.5 OK"], ["550 5.1.1 no"]]));
    },
  });
  const p1 = probeEmail("a@example.test", d);
  const p2 = probeEmail("b@example.test", d);
  await new Promise((r) => setImmediate(r));
  const third = await probeEmail("c@example.test", d);
  assert.equal(third.reason, "mx_busy");
  release();
  await Promise.all([p1, p2]);
  assert.equal(connects, 2);
  const capped = deps({
    limiter: createLimiter({ dailyCap: 1, perMinute: 4, maxConcurrent: 2, now: () => NOW.getTime() }),
    connect: async () => { connects += 1; return scripted([...banner, ["250 2.1.5 OK"], ["550 5.1.1 no"]]); },
  });
  const before = connects;
  assert.equal((await probeEmail("a@example.test", capped)).smtp, "pass");
  assert.equal((await probeEmail("b@example.test", capped)).reason, "daily_cap");
  assert.equal(connects, before + 1);
});

test("HMAC, timestamp and replay match the worker request, and a bad signature does no DNS", async () => {
  let mx = 0;
  const d = deps({
    dns: { async resolveMx() { mx += 1; return [{ priority: 1, exchange: "gmail-smtp-in.l.google.com" }]; }, async resolve4() { throw new Error("resolved"); }, async resolve6() { return []; } },
  });
  const probeUrl = "https://probe.example.com/v1";
  const built = await buildSmtpProbeRequest({ EMAIL_SMTP_URL: probeUrl, EMAIL_SMTP_SECRET: SECRET }, "user@example.com", NOW);
  assert.equal(JSON.parse(built.body).ts, Math.floor(NOW.getTime() / 1000));
  assert.equal(built.headers["x-email-probe-signature"], "v1=" + hmacHex(SECRET, built.body));
  const call = (body, sig, when = NOW) => handleProbe(new Request(probeUrl, {
    method: "POST", headers: { "content-type": "application/json", "x-email-probe-signature": sig || ("v1=" + hmacHex(SECRET, body)) }, body,
  }), { ...d, now: () => when, replay: d.replay });
  const ok = await call(built.body, built.headers["x-email-probe-signature"]);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.reason, "provider_skip");
  assert.equal(body.transcript, undefined);
  assert.equal(mx, 1);
  const replay = await call(built.body, built.headers["x-email-probe-signature"]);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).reason, "replay");
  assert.equal(mx, 1);
  const staleBody = JSON.stringify({ v: 1, ts: Math.floor(NOW.getTime() / 1000) - 400, email: "user@example.com" });
  const stale = await call(staleBody);
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).reason, "stale");
  const futureBody = JSON.stringify({ v: 1, ts: Math.floor(NOW.getTime() / 1000) + 400, email: "user@example.com" });
  assert.equal((await call(futureBody)).status, 401);
  const bad = await call(built.body, "v1=" + "ab".repeat(32));
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).reason, "bad_signature");
  const noTs = JSON.stringify({ v: 1, email: "user@example.com" });
  assert.equal((await call(noTs)).status, 401);
  assert.equal(mx, 1, "rejected requests did not look up MX");
});

test("health check and a refused start when the secret is missing or short", async () => {
  const d = deps();
  const health = await handleProbe(new Request("http://127.0.0.1/healthz"), d);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const bare = await handleProbe(new Request("http://127.0.0.1/v1", { method: "POST", body: "{}" }), deps({ secret: "short" }));
  assert.equal(bare.status, 503);
  assert.throws(() => startServer({}), /PROBE_SECRET/);
  const server = startServer({ PROBE_SECRET: SECRET, PROBE_PORT: "0", PROBE_BIND: "127.0.0.1" });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  try {
    const port = server.address().port;
    const res = await fetch("http://127.0.0.1:" + port + "/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("install files keep the warm-up and the firewall, record no deployed host, and hold no secret", async () => {
  const dnsDoc = readFileSync(join(REPO, "docs", "probe-dns.md"), "utf8");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const unit = readFileSync(join(ROOT, "probe.service"), "utf8");
  const caddy = readFileSync(join(ROOT, "Caddyfile"), "utf8");
  const ufw = readFileSync(join(ROOT, "ufw-probe.sh"), "utf8");
  const example = readFileSync(join(ROOT, "probe.env.example"), "utf8");
  const strayIp = (text) => (text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []).filter((ip) => ip !== "127.0.0.1");
  assert.match(dnsDoc, /retired/i);
  assert.match(dnsDoc, /no IP/i);
  assert.match(dnsDoc, /outbound TCP port 25/);
  assert.deepEqual(strayIp(dnsDoc), []);
  assert.match(readme, /Retired/);
  assert.match(readme, /No host is deployed/);
  assert.match(readme, /outbound TCP port 25/);
  assert.match(readme, /probe\.example\.com/);
  assert.match(readme, /<probe-ipv4>/);
  assert.match(readme, /<reversed-ipv4>\.zen\.spamhaus\.org/);
  assert.deepEqual(strayIp(readme), []);
  assert.match(readme, /300/);
  assert.match(readme, /1000/);
  assert.match(readme, /3000/);
  assert.match(readme, /Days \| `PROBE_DAILY_CAP`/);
  assert.match(readme, /1–7/);
  assert.match(readme, /15–21/);
  assert.match(readme, /zen\.spamhaus\.org/);
  assert.match(readme, /barracudacentral/);
  assert.match(unit, /EnvironmentFile=\/etc\/probe\/probe\.env/);
  assert.match(caddy, /probe\.example\.com/);
  assert.match(caddy, /127\.0\.0\.1:8787/);
  assert.deepEqual(strayIp(caddy), []);
  for (const text of [dnsDoc, readme, caddy]) assert.doesNotMatch(text, /402xagent/);
  assert.match(ufw, /allow out 25\/tcp/);
  assert.match(ufw, /deny in 25\/tcp/);
  assert.match(example, /^PROBE_SECRET=$/m);
  assert.match(example, /^PROBE_DAILY_CAP=300$/m);
  for (const text of [dnsDoc, readme, unit, caddy, ufw, example]) {
    assert.ok(!/PROBE_SECRET=\S/.test(text), "a filled secret does not belong in the tree");
  }
  await assert.rejects(() => connectSmtp("93.184.216.34", 2525, 1000), /bad_port/);
});
