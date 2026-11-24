// 0.79.0 reliability score after the 7-day shadow review: listed payTo alternatives count as a match, a confirmed pay_to flag
// at low confidence is unknown, the public view shows bands only at medium/high confidence and never avoid, and a band only
// changes when two daily computations agree (hysteresis). Synthetic hosts and wallets only; nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { computeScore, publicAnswer, scoreConfig, listedPayTos, holdBand, netKey, addrKey, SCORE_RULES, SCORE_VERSION, REASON_CODES_SCORE, PUBLIC_MIN_CONFIDENCE, PAY_TO_FLAGS, HOLD_IMMEDIATE_REASONS } from "../worker/src/score.js";
import * as S from "../worker/src/scorestore.js";
import { VERSION } from "../worker/src/lib.js";

const NOW = new Date("2026-11-24T12:00:00Z");
const HOUR = 3600e3, DAY = 86400e3;
const URL1 = "https://sellers.example/v1/data";
const CFG = scoreConfig({});
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const SOL1 = "So1anaSe11erWa11etAAAAAAAAAAAAAAAAAAAAAAAA", SOL2 = "So1anaSe11erWa11etBBBBBBBBBBBBBBBBBBBBBBBB";
const BASE = "eip155:8453", SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
let seq = 0;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const terms = (pay_to, network = BASE) => ({ pay_to, network, asset: USDC, amount: "1000" });
function probe(daysAgo, h = 0, o = {}) {
  return { id: "sc-" + String(++seq).padStart(16, "0"), at: iso(NOW - daysAgo * DAY - h * HOUR), check_type: "self-checked", ref: "score-probe", caller: "self-test", client: "withgrokbot-selftest",
    verdict: "pay", reason_code: "price_ok", http_status: 402, listing_source: "listing", terms: terms(A), ...o };
}
// the 402 pays `pay_to` while the listing expected A: the check said skip/pay_to_mismatch
const mm = (daysAgo, h, pay_to, extra = {}) => probe(daysAgo, h, { verdict: "skip", reason_code: "pay_to_mismatch", terms: terms(pay_to), accepts: [{ network: BASE, pay_to, asset: USDC }], expected_network: BASE, ...extra });
const goodRun = (days, perDay = 2) => Array.from({ length: days * perDay }, (_, i) => probe(Math.floor(i / perDay) + 1, (i % perDay) * 6 + 1));
const score = (observations, listing = null, now = NOW) => computeScore({ url: URL1, observations, listing, now, cfg: CFG });
const LIST_AB = { listed_pay_to: A, listed_network: BASE, listed_pay_tos: [{ network: BASE, pay_to: A, scope: "endpoint" }, { network: BASE, pay_to: B, scope: "site" }] };

test("0.79.0 version and score formula version", () => {
  assert.equal(VERSION, "0.79.0");
  assert.equal(SCORE_VERSION, "score-2026-11-24");
  assert.ok(REASON_CODES_SCORE.includes("band_held"));
  assert.deepEqual([...PAY_TO_FLAGS], ["pay_to_mismatch", "pay_to_changed"]);
  assert.equal(PUBLIC_MIN_CONFIDENCE, "medium");
  for (const k of ["listed_pay_to", "low_confidence_pay_to", "hysteresis", "public_min_confidence"]) assert.ok(SCORE_RULES[k], k);
});

test("listedPayTos: per network, EVM case-insensitive, Solana exact; one wallet only -> null", () => {
  assert.equal(listedPayTos(null), null);
  assert.equal(listedPayTos({ listed_pay_to: A, listed_network: BASE }), null, "a single listed wallet widens nothing");
  assert.equal(listedPayTos({ listed_pay_to: A, listed_network: BASE, listed_pay_tos: [{ network: "base", pay_to: A.toUpperCase().replace("0X", "0x") }] }), null, "same wallet in another spelling");
  const m = listedPayTos({ ...LIST_AB, listed_pay_tos: [...LIST_AB.listed_pay_tos, { network: SOL, pay_to: SOL1 }] });
  assert.ok(m.get(BASE).has(B) && m.get(BASE).has(A));
  assert.ok(m.get(netKey(SOL)).has(SOL1) && !m.get(netKey(SOL)).has(SOL1.toLowerCase()));
  assert.equal(addrKey(B.toUpperCase().replace("0X", "0x"), "base"), B);
  assert.equal(addrKey(SOL1, "solana"), SOL1);
});

test("pay_to_mismatch to a wallet the listing ALSO names on the same network is a match: no flag, no penalty, not avoid", () => {
  const obs = [...goodRun(6), mm(0, 2, B), mm(0, 8, B)];
  const old = score(obs);
  assert.equal(old.band, "avoid", "without the listing alternatives the newest two confirm the flag");
  const r = score(obs, LIST_AB);
  assert.ok(!r.flags.some((f) => f.code === "pay_to_mismatch"), JSON.stringify(r.flags));
  assert.notEqual(r.band, "avoid");
  assert.equal(r.pay_to_alt_listed, 2);
  assert.ok(!r.reasons.includes("pay_to_mismatch"));
});

test("an alternative on ANOTHER network, or an unlisted wallet, is still a mismatch", () => {
  const otherNet = { listed_pay_to: A, listed_network: BASE, listed_pay_tos: [{ network: BASE, pay_to: A }, { network: "eip155:137", pay_to: B }] };
  assert.ok(score([...goodRun(6), mm(0, 2, B), mm(0, 8, B)], otherNet).flags.some((f) => f.code === "pay_to_mismatch"));
  assert.ok(score([...goodRun(6), mm(0, 2, C), mm(0, 8, C)], LIST_AB).flags.some((f) => f.code === "pay_to_mismatch"));
  // a multi-network 402 whose Base entry is unlisted does not pass on a listed Polygon entry when Base was expected
  const multi = (d, h) => mm(d, h, C, { accepts: [{ network: BASE, pay_to: C }, { network: "eip155:137", pay_to: B }] });
  const polyListed = { listed_pay_to: A, listed_network: BASE, listed_pay_tos: [{ network: BASE, pay_to: A }, { network: "eip155:137", pay_to: B }] };
  assert.ok(score([...goodRun(6), multi(0, 2), multi(0, 8)], polyListed).flags.some((f) => f.code === "pay_to_mismatch"));
});

test("Solana alternatives compare exactly (case matters)", () => {
  const solMm = (d, h, p) => mm(d, h, p, { terms: terms(p, SOL), accepts: [{ network: SOL, pay_to: p }], expected_network: SOL });
  const L = { listed_pay_to: SOL1, listed_network: SOL, listed_pay_tos: [{ network: SOL, pay_to: SOL1 }, { network: SOL, pay_to: SOL2 }] };
  assert.ok(!score([...goodRun(6), solMm(0, 2, SOL2), solMm(0, 8, SOL2)], L).flags.some((f) => f.code === "pay_to_mismatch"));
  assert.ok(score([...goodRun(6), solMm(0, 2, SOL2.toLowerCase()), solMm(0, 8, SOL2.toLowerCase())], L).flags.some((f) => f.code === "pay_to_mismatch"));
});

test("moving between two listed wallets is not pay_to_changed; moving to an unlisted one still is", () => {
  const alt = (d, h, p) => probe(d, h, { terms: terms(p) });
  const flip = [...goodRun(5), alt(0, 9, B), alt(0, 3, B)];
  assert.ok(score(flip).flags.some((f) => f.code === "pay_to_changed"), "without alternatives a wallet change is flagged");
  assert.ok(!score(flip, LIST_AB).flags.some((f) => f.code === "pay_to_changed"));
  const toC = [...goodRun(5), alt(0, 9, C), alt(0, 3, C)];
  assert.ok(score(toC, LIST_AB).flags.some((f) => f.code === "pay_to_changed"));
});

test("a confirmed pay_to_mismatch at LOW confidence is unknown (flag kept in reasons); at medium it stays internal avoid", () => {
  const low = score([probe(2, 3), probe(1, 3), mm(1, 1, C), mm(0, 1, C)]);
  assert.equal(low.confidence, "low");
  assert.equal(low.band, "unknown");
  assert.ok(low.reasons.includes("low_data") && low.reasons.includes("pay_to_mismatch"), JSON.stringify(low.reasons));
  assert.equal(publicAnswer(low).band, "unknown");
  const med = score([...goodRun(6), mm(0, 2, C), mm(0, 8, C)]);
  assert.ok(["medium", "high"].includes(med.confidence));
  assert.equal(med.band, "avoid");
  assert.equal(publicAnswer(med).band, "caution", "avoid is never served");
});

test("low confidence with a different confirmed hard flag keeps its internal band but is unknown publicly", () => {
  const nm = (d, h) => probe(d, h, { verdict: "skip", reason_code: "network_mismatch" });
  const r = score([probe(2, 3), probe(1, 3), nm(1, 1), nm(0, 1)]);
  assert.equal(r.confidence, "low");
  assert.equal(r.band, "avoid");
  const pub = publicAnswer(r);
  assert.equal(pub.band, "unknown");
  assert.ok(pub.reasons.includes("low_data") && pub.reasons.includes("network_mismatch"));
});

test("public view: only medium/high confidence bands, never avoid; operator_endpoint and unknown pass through", () => {
  const base = { url: URL1, method: "GET", observations: 3, days_observed: 2, first_seen: null, last_checked: null, reasons: [], flags: [], stale: false, formula_version: SCORE_VERSION, computed_at: iso(NOW) };
  const pub = (band, confidence) => publicAnswer({ ...base, band, confidence }).band;
  assert.equal(pub("good", "high"), "good"); assert.equal(pub("good", "medium"), "good");
  assert.equal(pub("caution", "medium"), "caution"); assert.equal(pub("avoid", "high"), "caution"); assert.equal(pub("avoid", "medium"), "caution");
  for (const b of ["good", "caution", "avoid"]) { assert.equal(pub(b, "low"), "unknown"); assert.equal(pub(b, "none"), "unknown"); }
  assert.equal(pub("operator_endpoint", "none"), "operator_endpoint"); assert.equal(pub("unknown", "high"), "unknown");
  for (const b of ["good", "caution", "avoid", "unknown"]) for (const c of ["none", "low", "medium", "high"]) assert.notEqual(pub(b, c), "avoid");
});

test("public view stays config-gated and default off; shadow serves nothing", () => {
  assert.equal(S.scoreServeOn({}), false);
  assert.equal(S.scoreServeOn({ SCORE_BAND: "shadow" }), false);
  assert.equal(S.scoreRecordOn({ SCORE_BAND: "shadow" }), true);
  assert.equal(S.scoreServeOn({ SCORE_BAND: "on" }), true);
  const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "wrangler.toml"), "utf8");
  assert.match(toml, /^SCORE_BAND = "shadow"/m, "this PR changes no flag");
  assert.ok(!/^SCORE_HOLD\s*=/m.test(toml));
});

test("holdBand: a change needs two consecutive daily computations; failing/stale facts apply at once", () => {
  const t = (band, reasons = []) => ({ band, reasons });
  assert.equal(holdBand(t("good"), null, null).band, "good", "no previous row: no hold");
  assert.equal(holdBand(t("good"), "good", "caution").band, "good", "unchanged");
  const held = holdBand(t("caution", ["price_changed"]), "good", "good");
  assert.equal(held.band, "good"); assert.equal(held.candidate_band, "caution"); assert.ok(held.reasons.includes("band_held"));
  assert.equal(holdBand(t("caution"), "good", "caution").band, "caution", "yesterday's inputs agree: change");
  for (const r of HOLD_IMMEDIATE_REASONS) assert.equal(holdBand(t(r === "operator_endpoint" ? "operator_endpoint" : "avoid", [r]), "good", "good").band, r === "operator_endpoint" ? "operator_endpoint" : "avoid", r);
});

test("receiptObservation carries the 402's accepts (pay_to_mismatch rows) and the expected network; acceptsOf caps at 8", () => {
  const accs = Array.from({ length: 12 }, (_, i) => ({ network: BASE, pay_to: "0x" + String(i).padStart(2, "0").repeat(20), asset: USDC, amount_atomic: "1" }));
  assert.equal(S.acceptsOf(JSON.stringify(accs)).length, 8);
  assert.equal(S.acceptsOf("not json"), null); assert.equal(S.acceptsOf("{}"), null);
  const o = S.receiptObservation({ id: "sc-1", at: iso(NOW), check_type: "self-checked", reason_code: "pay_to_mismatch", pay_to: B, network: BASE, asset: USDC, amount: "1", accepts: JSON.stringify([{ network: BASE, pay_to: B, asset: USDC }]), expected_network: BASE });
  assert.deepEqual(o.accepts, [{ network: BASE, pay_to: B, asset: USDC }]);
  assert.equal(o.expected_network, BASE);
  const plain = S.receiptObservation({ id: "sc-2", at: iso(NOW), check_type: "self-checked", reason_code: "price_ok" });
  assert.ok(!("accepts" in plain) && !("expected_network" in plain));
});

// ---- wiring: real SQLite behind a tiny D1 adapter (same harness as score_076_test.mjs)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(ROOT, "worker", "migrations");
const MIGS = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(MIG_DIR, f), "utf8"));
function d1() {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGS) db.exec(m);
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({ sql, args, bind: (...a) => mk(sql, norm(a)), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }, _run: () => db.prepare(sql).run(...args) });
  return { raw: db, prepare: (sql) => mk(sql), batch: async (st) => { for (const s of st) s._run(); return []; } };
}
const U = "https://alt.seller-fixture.dev/v1/data";
function addReceipt(db, { ageH, reason = "price_ok", verdict = "pay", payTo = A }) {
  const body = { url: U, method: "GET", check_type: "self-checked", client: "withgrokbot-selftest", caller: "self-test", ref: "score-probe", probe_origin: "cron", reason_code: reason,
    live_402: { http_status: 402, x402_challenge: true, accepts: [{ scheme: "exact", network: BASE, asset: USDC, amount_atomic: "1000", pay_to: payTo }] },
    listing: { source: "listing", pay_to: A, network: BASE }, expected: { pay_to: A, network: BASE, source: "listing" } };
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("sc-" + String(++seq).padStart(16, "0"), U, iso(NOW - ageH * HOUR), verdict, reason, "self-checked", "score-probe", JSON.stringify(body));
}
const listingDep = (listing) => ({ listingForAsync: async () => ({ id: "c1", url: U, timestamp: iso(NOW - 3 * DAY), verdict: "skip", ...listing }) });

test("scoreEndpoint: the crawl's listed_pay_tos reach the scorer (a listed alternative is a match end to end)", async () => {
  const db = d1();
  for (let i = 0; i < 14; i++) addReceipt(db, { ageH: 30 + i * 12 });
  addReceipt(db, { ageH: 6, reason: "pay_to_mismatch", verdict: "skip", payTo: B });
  addReceipt(db, { ageH: 2, reason: "pay_to_mismatch", verdict: "skip", payTo: B });
  const env = { RECEIPTS_DB: db, SCORE_BAND: "shadow" };
  const without = await S.scoreEndpoint(env, U, NOW, listingDep({ listed_pay_to: A, listed_network: BASE }));
  assert.ok(without.flags.some((f) => f.code === "pay_to_mismatch"));
  const withAlt = await S.scoreEndpoint(env, U, NOW, listingDep({ listed_pay_to: A, listed_network: BASE, listed_pay_tos: [{ network: BASE, pay_to: A, scope: "endpoint" }, { network: BASE, pay_to: B, scope: "endpoint" }] }));
  assert.ok(!withAlt.flags.some((f) => f.code === "pay_to_mismatch"), JSON.stringify(withAlt.flags));
  assert.equal(withAlt.pay_to_alt_listed, 2);
});

test("scoreEndpoint: hysteresis reads yesterday's recorded band; SCORE_HOLD=0 turns it off", async () => {
  const db = d1();
  for (let i = 0; i < 14; i++) addReceipt(db, { ageH: 30 + i * 12 });
  // today only: a new unlisted wallet twice -> candidate avoid; yesterday's inputs say good
  addReceipt(db, { ageH: 6, reason: "pay_to_mismatch", verdict: "skip", payTo: C });
  addReceipt(db, { ageH: 2, reason: "pay_to_mismatch", verdict: "skip", payTo: C });
  const env = { RECEIPTS_DB: db, SCORE_BAND: "shadow" };
  const dep = listingDep({ listed_pay_to: A, listed_network: BASE });
  const fresh = await S.scoreEndpoint(env, U, NOW, dep);
  assert.equal(fresh.band, "avoid", "no row yesterday: no hold");
  db.raw.prepare("INSERT INTO endpoint_score_daily (day, url, method, band, internal_band, confidence, formula_version, computed_at) VALUES (?, ?, 'GET', 'good', 'good', 'medium', 'x', ?)").run("2026-11-23", U, iso(NOW - DAY));
  const held = await S.scoreEndpoint(env, U, NOW, dep);
  assert.equal(held.band, "good"); assert.equal(held.candidate_band, "avoid"); assert.ok(held.reasons.includes("band_held"));
  const off = await S.scoreEndpoint({ ...env, SCORE_HOLD: "0" }, U, NOW, dep);
  assert.equal(off.band, "avoid");
  // the next day the same fact is still there: the change goes through
  const next = await S.scoreEndpoint(env, U, new Date(NOW.getTime() + DAY), dep);
  db.raw.prepare("INSERT OR REPLACE INTO endpoint_score_daily (day, url, method, band, internal_band, confidence, formula_version, computed_at) VALUES (?, ?, 'GET', 'good', 'good', 'medium', 'x', ?)").run("2026-11-24", U, iso(NOW));
  const day2 = await S.scoreEndpoint(env, U, new Date(NOW.getTime() + DAY), dep);
  assert.equal(day2.band, "avoid", JSON.stringify({ c: day2.candidate_band, r: day2.reasons, n: next.band }));
});

test("annotateDiscover never shows avoid and shows unknown below medium confidence, even for an older stored row", async () => {
  const db = d1();
  const put = (url, band, conf) => db.raw.prepare("INSERT INTO endpoint_score_daily (day, url, method, band, internal_band, confidence, formula_version, computed_at) VALUES (?, ?, 'GET', ?, ?, ?, 'x', ?)").run("2026-11-24", url, band, band, conf, iso(NOW));
  put("https://a.seller-fixture.dev/x", "avoid", "high"); put("https://b.seller-fixture.dev/x", "caution", "low"); put("https://c.seller-fixture.dev/x", "good", "medium");
  const res = await S.annotateDiscover({ RECEIPTS_DB: db }, [{ endpoint: "https://a.seller-fixture.dev/x" }, { endpoint: "https://b.seller-fixture.dev/x" }, { endpoint: "https://c.seller-fixture.dev/x" }, { endpoint: "https://d.seller-fixture.dev/x" }], NOW);
  assert.deepEqual(res.map((r) => r.band), ["caution", "unknown", "good", "unknown"]);
});
