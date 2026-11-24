// 0.77.1: every nightly receipt-anchor run writes one vc_lookups point (blob16='anchor'),
// including success. Also allowlists the upstream calendar hosts the default pools attest.
// Calendar HTTP is mocked; tests never touch the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import { sqliteD1 } from "./helpers/sqlite_d1.mjs";
import { pendingCalendarBody } from "../worker/src/ots.js";
import {
  ANCHOR_CRON, ANCHOR_AE_PRODUCT, ANCHOR_RUN_REASONS, anchorTick, anchorRunPoint,
  writeAnchorRunPoint, calendarAttemptsJson,
} from "../worker/src/anchors.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const utf8 = (s) => new TextEncoder().encode(s);
const ctx = { waitUntil() {}, passThroughOnException() {} };
const realFetch = globalThis.fetch;

function db() { return sqliteD1(); }
const id = (ch) => "sc-" + ch.repeat(16);
function put(d, receipt, at) {
  const body = receipt.signature ? { id: receipt.id, client: "not-hashed", signed_view: receipt } : receipt;
  return d.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, body) VALUES (?, ?, ?, ?, 'price_ok', 'live', ?)")
    .bind(receipt.id, "https://seller.example/" + receipt.id, at, receipt.verdict, JSON.stringify(body)).run();
}
function calendars({ upgrade = false, fail = new Set(), attestationUri, attestationUris = {}, body, throwOn } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", len: init.body ? init.body.length : 0 });
    const u = String(url);
    const host = new URL(u).host;
    if (throwOn && throwOn.has(host)) {
      const e = new Error("calendar timeout");
      e.name = "TimeoutError";
      throw e;
    }
    if (fail.has(host)) return new Response("down", { status: 503 });
    if (u.endsWith("/digest")) {
      if (!init.body || init.body.length !== 32) throw new Error("digest was not 32 bytes");
      const base = u.slice(0, -"/digest".length);
      if (body !== undefined) return new Response(body, { status: 200 });
      const uri = attestationUris[host] || attestationUri || base;
      return new Response(pendingCalendarBody(new Uint8Array(init.body), uri, utf8(host)));
    }
    if (u.includes("/timestamp/")) {
      if (!upgrade) return new Response("not yet", { status: 404 });
      throw new Error("upgrade not used in these tests");
    }
    throw new Error("unexpected " + u);
  };
  return { calls, fetchImpl };
}
const envOf = (d, extra = {}) => ({ ANCHORS: "1", RECEIPTS_DB: d, BAZAAR_PAGE: "off", DAILY_RECHECK: "off", STALE_RECHECK: "off", ...extra });
async function withNoNet(fn) {
  globalThis.fetch = () => { throw new Error("network used"); };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}
function rec(env) {
  const points = [];
  env.LOOKUPS = { writeDataPoint: (p) => points.push(p) };
  return points;
}
function pointOf(points) {
  assert.equal(points.length, 1, "one AE point per run");
  return points[0];
}
function reasonOf(p) { return p.blobs[5]; }
function versionOf(p) { return p.blobs[9]; }
function productOf(p) { return p.blobs[15]; }
function idOf(p) { return p.blobs[16]; }
function calsOf(p) { return JSON.parse(p.blobs[17] || "[]"); }
function errOf(p) { return p.blobs[18]; }

test("0.77.1 version, no new migration, ANCHORS still on, AE reason list", () => {
  assert.equal(VERSION, "0.78.1");
  const files = readdirSync(join(ROOT, "..", "worker", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes("0032_receipt_anchors.sql"));
  // 0.78.0 adds 0035 for settlement matching only; the 0.77.1 run log still added no migration (nothing touches anchors)
  assert.deepEqual(files.filter((f) => f.startsWith("0035")), ["0035_settlement_observed.sql"]);
  assert.doesNotMatch(readFileSync(join(ROOT, "..", "worker", "migrations", "0035_settlement_observed.sql"), "utf8"), /receipt_anchors/, "no migration added for the run log");
  const p = anchorRunPoint({ reason: "created", version: VERSION });
  assert.equal(p.indexes[0], ANCHOR_AE_PRODUCT);
  assert.equal(p.blobs.length, 20);
  assert.equal(p.doubles.length, 6);
  assert.equal(p.blobs[0], "anchor");
  assert.equal(p.blobs[15], "anchor");
  assert.equal(p.doubles[2], 0);
  assert.equal(p.doubles[5], -1);
  assert.deepEqual(ANCHOR_RUN_REASONS, ["created", "calendar_failed", "write_error", "read_error", "tick_error", "nothing_to_anchor"]);
});

test("a successful tick writes one created point with id, count, version and both calendar results", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-01T00:00:01Z");
  await put(d, { id: id("b"), verdict: "skip" }, "2026-11-01T00:00:02Z");
  const env = envOf(d);
  const points = rec(env);
  const mock = calendars();
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: mock.fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "created");
  assert.equal(out.created.count, 2);
  const p = pointOf(points);
  assert.equal(reasonOf(p), "created");
  assert.equal(productOf(p), "anchor");
  assert.equal(versionOf(p), "0.78.1");
  assert.equal(idOf(p), out.created.id);
  assert.match(idOf(p), /^an-[0-9a-f]{16}$/);
  assert.equal(p.doubles[0], 2);
  assert.ok(p.doubles[1] >= 0);
  assert.equal(p.doubles[2], 0);
  assert.equal(p.doubles[3], 2);
  assert.equal(errOf(p), "");
  const cals = calsOf(p);
  assert.deepEqual(cals.map((c) => c.host).sort(), ["a.pool.opentimestamps.org", "b.pool.opentimestamps.org"]);
  assert.ok(cals.every((c) => c.status === 200 && c.bytes > 0 && c.error === ""));
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 1);
});

test("calendar HTTP 503 on both pools is calendar_failed, records status and bytes, writes no row", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const env = envOf(d);
  const points = rec(env);
  const mock = calendars({ fail: new Set(["a.pool.opentimestamps.org", "b.pool.opentimestamps.org"]) });
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: mock.fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "calendar_failed");
  assert.equal(out.created.count, 1);
  const p = pointOf(points);
  assert.equal(reasonOf(p), "calendar_failed");
  assert.equal(idOf(p), "");
  assert.equal(p.doubles[0], 1);
  assert.equal(p.doubles[3], 2);
  const cals = calsOf(p);
  assert.equal(cals.length, 2);
  assert.ok(cals.every((c) => c.status === 503 && c.bytes === 4 && c.error === "http 503"));
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 0);
});

test("one calendar down still creates an anchor and records both attempts", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const env = envOf(d);
  const points = rec(env);
  const mock = calendars({ fail: new Set(["b.pool.opentimestamps.org"]) });
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: mock.fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "created");
  const p = pointOf(points);
  assert.equal(reasonOf(p), "created");
  assert.equal(idOf(p), out.created.id);
  const byHost = Object.fromEntries(calsOf(p).map((c) => [c.host, c]));
  assert.equal(byHost["a.pool.opentimestamps.org"].status, 200);
  assert.equal(byHost["a.pool.opentimestamps.org"].error, "");
  assert.equal(byHost["b.pool.opentimestamps.org"].status, 503);
  assert.equal(byHost["b.pool.opentimestamps.org"].error, "http 503");
});

test("idle tick is nothing_to_anchor with count 0 and no calendar attempts", async () => {
  const d = db();
  const env = envOf(d);
  const points = rec(env);
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: calendars().fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "idle");
  const p = pointOf(points);
  assert.equal(reasonOf(p), "nothing_to_anchor");
  assert.equal(p.doubles[0], 0);
  assert.equal(p.doubles[3], 0);
  assert.deepEqual(calsOf(p), []);
  assert.equal(idOf(p), "");
});

test("a read failure is read_error and still writes a point", async () => {
  const d = db();
  const broken = {
    prepare() { throw new Error("d1 read failed"); },
  };
  const env = envOf(broken);
  const points = rec(env);
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: calendars().fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "read_error");
  const p = pointOf(points);
  assert.equal(reasonOf(p), "read_error");
  assert.match(errOf(p), /d1 read failed/);
  assert.equal(p.doubles[0], 0);
});

test("a write failure is write_error, records the attempted count, and leaves no row", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const wrapped = {
    prepare(...args) {
      const sql = String(args[0] || "");
      if (sql.startsWith("INSERT INTO receipt_anchors")) {
        return { bind: () => ({ run: async () => { throw new Error("d1 write failed"); } }) };
      }
      return d.prepare(...args);
    },
    batch: (...a) => d.batch(...a),
  };
  const env = envOf(wrapped);
  const points = rec(env);
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: calendars().fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "write_error");
  assert.equal(out.created.count, 1);
  const p = pointOf(points);
  assert.equal(reasonOf(p), "write_error");
  assert.equal(p.doubles[0], 1);
  assert.match(errOf(p), /d1 write failed/);
  assert.equal(calsOf(p).length, 2);
  assert.ok(calsOf(p).every((c) => c.status === 200 && c.error === ""));
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 0);
});

test("tick_error is recorded and rethrown", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const env = envOf(d);
  const points = rec(env);
  await assert.rejects(
    () => withNoNet(() => anchorTick(env, new Date("bogus"), { fetchImpl: calendars().fetchImpl, version: VERSION })),
    /Invalid/,
  );
  const p = pointOf(points);
  assert.equal(reasonOf(p), "tick_error");
  assert.match(errOf(p), /Invalid/);
  assert.equal(p.doubles[3], 2, "calendars were already contacted");
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 0);
});

test("a calendar timeout is recorded as timeout text and does not throw", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const env = envOf(d);
  const points = rec(env);
  const mock = calendars({ throwOn: new Set(["a.pool.opentimestamps.org", "b.pool.opentimestamps.org"]) });
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: mock.fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "calendar_failed");
  const cals = calsOf(pointOf(points));
  assert.equal(cals.length, 2);
  assert.ok(cals.every((c) => c.status === 0 && c.bytes === 0 && /^timeout/.test(c.error)));
});

test("an accepted upstream https attestation URI produces a created anchor", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const env = envOf(d);
  const points = rec(env);
  // Live pool responses attest these exact upstream hosts (confirmed 2026-11-18).
  const mock = calendars({
    attestationUris: {
      "a.pool.opentimestamps.org": "https://alice.btc.calendar.opentimestamps.org",
      "b.pool.opentimestamps.org": "https://bob.btc.calendar.opentimestamps.org",
    },
  });
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: mock.fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "created");
  assert.equal(out.created.count, 1);
  const p = pointOf(points);
  assert.equal(reasonOf(p), "created");
  assert.equal(idOf(p), out.created.id);
  assert.ok(calsOf(p).every((c) => c.status === 200 && c.error === ""));
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 1);
});

test("a look-alike attestation host is rejected and no row is written", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const env = envOf(d);
  const points = rec(env);
  const mock = calendars({ attestationUri: "https://alice.btc.calendar.opentimestamps.org.evil.com" });
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: mock.fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "calendar_failed");
  const p = pointOf(points);
  assert.equal(reasonOf(p), "calendar_failed");
  assert.ok(calsOf(p).every((c) => c.status === 200 && c.bytes > 0 && c.error === "no allowed pending attestation"));
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 0);
});

test("an http URI for an allowed calendar host is rejected", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const env = envOf(d);
  const points = rec(env);
  const mock = calendars({
    attestationUris: {
      "a.pool.opentimestamps.org": "http://alice.btc.calendar.opentimestamps.org",
      "b.pool.opentimestamps.org": "http://bob.btc.calendar.opentimestamps.org",
    },
  });
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: mock.fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "calendar_failed");
  const p = pointOf(points);
  assert.equal(reasonOf(p), "calendar_failed");
  assert.ok(calsOf(p).every((c) => c.status === 200 && c.error === "no allowed pending attestation"));
  assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 0);
});

test("an unreadable calendar body is recorded as a parse error", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const env = envOf(d);
  const points = rec(env);
  const mock = calendars({ body: "not an ots proof" });
  const out = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: mock.fetchImpl, version: VERSION }));
  assert.equal(out.created.did, "calendar_failed");
  const cals = calsOf(pointOf(points));
  assert.ok(cals.every((c) => c.status === 200 && c.bytes === 16 && c.error));
  assert.ok(cals.every((c) => c.error !== "http 200"));
});

test("LOOKUPS missing or throwing does not change the anchor result", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const ok = await withNoNet(() => anchorTick(envOf(d), new Date("2026-11-18T03:41:00Z"), { fetchImpl: calendars().fetchImpl, version: VERSION }));
  assert.equal(ok.created.did, "created");
  const d2 = db();
  await put(d2, { id: id("a"), verdict: "pay" }, "2026-11-02T00:00:00Z");
  const env = envOf(d2, { LOOKUPS: { writeDataPoint() { throw new Error("AE down"); } } });
  const still = await withNoNet(() => anchorTick(env, new Date("2026-11-18T03:41:00Z"), { fetchImpl: calendars().fetchImpl, version: VERSION }));
  assert.equal(still.created.did, "created");
  assert.equal(await d2.prepare("SELECT COUNT(*) AS n FROM receipt_anchors").first().then((r) => r.n), 1);
});

test("the nightly cron writes the point through the Worker scheduled handler", async () => {
  const d = db();
  await put(d, { id: id("a"), verdict: "pay" }, "2026-11-03T00:00:00Z");
  const points = [];
  const env = envOf(d, { LOOKUPS: { writeDataPoint: (p) => points.push(p) } });
  const mock = calendars();
  globalThis.fetch = mock.fetchImpl;
  try {
    await worker.scheduled({ cron: ANCHOR_CRON, scheduledTime: Date.parse("2026-11-18T03:41:00Z") }, env, ctx);
  } finally { globalThis.fetch = realFetch; }
  const p = pointOf(points);
  assert.equal(reasonOf(p), "created");
  assert.equal(versionOf(p), "0.78.1");
  assert.equal(p.doubles[0], 1);
  assert.equal(mock.calls.filter((c) => c.method === "POST").length, 2);

  const offPoints = [];
  globalThis.fetch = () => { throw new Error("network used while off"); };
  try {
    await worker.scheduled({ cron: ANCHOR_CRON, scheduledTime: Date.parse("2026-11-18T03:41:00Z") }, { RECEIPTS_DB: d, LOOKUPS: { writeDataPoint: (p) => offPoints.push(p) } }, ctx);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(offPoints.length, 0);
});

test("writeAnchorRunPoint and calendarAttemptsJson truncate and never throw", () => {
  const long = "x".repeat(500);
  const json = calendarAttemptsJson([{ host: "h", status: 200, bytes: 3, error: long }]);
  assert.ok(json.length <= 1000);
  const parsed = JSON.parse(json);
  assert.equal(parsed[0].error.length, 160);
  const p = anchorRunPoint({ reason: "x".repeat(80), error: "e".repeat(400), version: "v".repeat(40), id: "i".repeat(40) });
  assert.equal(p.blobs[5].length, 32);
  assert.equal(p.blobs[9].length, 32);
  assert.equal(p.blobs[16].length, 32);
  assert.equal(p.blobs[18].length, 160);
  assert.doesNotThrow(() => writeAnchorRunPoint({}, { reason: "created" }));
  assert.doesNotThrow(() => writeAnchorRunPoint({ LOOKUPS: { writeDataPoint() { throw new Error("nope"); } } }, { reason: "created" }));
});
