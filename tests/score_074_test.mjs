// 0.74.0 pure scorer (worker/src/score.js). No wiring: these tests call computeScore() / publicAnswer() directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScore, classifyObservation, publicAnswer, inputsDigest, scoreConfig, isOperatorHost, confidenceLevel, SCORE_RULES, SCORE_VERSION,
  OBS_WEIGHTS, CRAWL_WEIGHT_CAP, LIVE_PER_DAY_CAP, PUBLIC_BANDS, OPERATOR_HOSTS_DEFAULT, REASON_CODES_SCORE, BAND_MEANING } from "../worker/src/score.js";
import { OWN_HOSTS, VERSION } from "../worker/src/lib.js";

const NOW = new Date("2026-11-17T12:00:00Z");
const HOUR = 3600e3, DAY = 86400e3;
const URL1 = "https://sellers.example/v1/data";
const CFG = scoreConfig({ PAY_TO: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", DRILL_WALLETS: "0xa880153A381Fc8d9AF0933a4c8a69fA32De6Ef22", SELF_CLIENTS: "withgrokbot,withgrokbot-selftest,sam-selftest,discovery-seed" });
const TERMS = { pay_to: "0xSeller", network: "eip155:8453", asset: "0xusdc", amount: "1000" };
let seq = 0;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
// a cron probe `daysAgo` days and `h` hours before NOW
function probe(daysAgo, h = 0, o = {}) {
  return { id: "sc-" + String(++seq).padStart(16, "0"), at: iso(NOW - daysAgo * DAY - h * HOUR), check_type: "self-checked", ref: "daily-recheck", caller: "self-test", client: "withgrokbot-selftest",
    verdict: "pay", reason_code: "price_ok", http_status: 402, listing_source: "listing", terms: { ...TERMS }, ...o };
}
function live(daysAgo, h = 0, o = {}) { return { ...probe(daysAgo, h), check_type: "live", ref: null, caller: null, client: null, ...o }; }
function crawl(daysAgo, o = {}) { return { id: "c-" + ++seq, at: iso(NOW - daysAgo * DAY), source: "crawl", verdict: "pay", reason_code: "price_ok", http_status: 402, terms: { ...TERMS }, ...o }; }
const many = (n, days, mk = probe) => Array.from({ length: n }, (_, i) => mk(Math.floor((i * days) / n), (i * 7) % 20));
const score = (observations, extra = {}) => computeScore({ url: URL1, observations, now: NOW, cfg: CFG, ...extra });

test("version is 0.74.0 and the module is not wired to any route", async () => {
  assert.equal(VERSION, "0.75.0");
  const fs = await import("node:fs");
  const lib = fs.readFileSync(new URL("../worker/src/lib.js", import.meta.url), "utf8");
  assert.ok(!/from "\.\/score\.js"/.test(lib), "score.js must not be imported by lib.js in PR 1");
});

test("classify: cron probes and outside live checks count, with live weighing more", () => {
  assert.deepEqual(classifyObservation(probe(1), CFG), { kind: "probe", weight: OBS_WEIGHTS.probe });
  assert.deepEqual(classifyObservation(live(1), CFG), { kind: "live", weight: OBS_WEIGHTS.live });
  assert.ok(OBS_WEIGHTS.live > OBS_WEIGHTS.probe && OBS_WEIGHTS.probe > OBS_WEIGHTS.crawl);
  assert.deepEqual(classifyObservation(crawl(1), CFG), { kind: "crawl", weight: OBS_WEIGHTS.crawl });
  for (const ref of ["daily-recheck", "bazaar-daily", "stale-recheck", "score-probe"]) assert.equal(classifyObservation(probe(1, 0, { ref }), CFG).kind, "probe");
});

test("classify: dry runs, heartbeats, deploy checks, audits, drill wallet and other self-checks are excluded", () => {
  const ex = (o) => classifyObservation(o, CFG).excluded;
  assert.equal(ex(probe(1, 0, { check_type: "dry-run", ref: null, caller: null, client: null })), "dry_run");
  assert.equal(ex(live(1, 0, { dry_run: true })), "dry_run");
  assert.equal(ex(live(1, 0, { client: "catalog-heartbeat-20261117" })), "test_client");
  assert.equal(ex(probe(1, 0, { ref: null, client: "catalog-heartbeat-20261117" })), "test_client");
  assert.equal(ex(live(1, 0, { client: "deploy-verify-0570" })), "test_client");
  assert.equal(ex(live(1, 0, { client: "imperium-audit" })), "test_client");
  assert.equal(ex(live(1, 0, { client: "selftest-cdp" })), "test_client");
  assert.equal(ex(live(1, 0, { client: "withgrokbot-selftest" })), "test_client");
  assert.equal(ex(probe(1, 0, { ref: "rollout-0.53.3" })), "test_client");
  assert.equal(ex(probe(1, 0, { ref: null })), "test_client");
  assert.equal(ex(probe(1, 0, { caller: "someone" })), "test_client");
  assert.equal(ex(live(1, 0, { payer: "0xa880153A381Fc8d9AF0933a4c8a69fA32De6Ef22" })), "self_settle");
  assert.equal(ex(live(1, 0, { payer: "0xA880153A381FC8D9AF0933A4C8A69FA32DE6EF22" })), "self_settle");
  // an outside caller with an unrelated client name or the site's own try-it ref still counts
  assert.equal(classifyObservation(live(1, 0, { client: "acme-agent" }), CFG).kind, "live");
  assert.equal(classifyObservation(live(1, 0, { ref: "via-402xagent-site", caller: "via-402xagent-site" }), CFG).kind, "live");
});

test("exclusions are reported by category and count only, never by identity", () => {
  const obs = [...many(10, 10), live(2, 3, { client: "catalog-heartbeat-20261117" }), live(3, 3, { client: "deploy-verify-0570" }), live(4, 3, { check_type: "dry-run" }), live(5, 3, { payer: "0xa880153A381Fc8d9AF0933a4c8a69fA32De6Ef22" })];
  const r = score(obs);
  assert.equal(r.excluded.test_client, 2);
  assert.equal(r.excluded.dry_run, 1);
  assert.equal(r.excluded.self_settle, 1);
  const txt = JSON.stringify(publicAnswer(r)) + JSON.stringify(r);
  for (const bad of ["heartbeat", "deploy-verify", "0xa880", "0x37cf", "selftest"]) assert.ok(!txt.toLowerCase().includes(bad), "leaked " + bad);
  assert.equal(r.observations, 10);
});

test("excluded observations cannot change the score (heartbeat, dry run and drill payments are ignored)", () => {
  const clean = many(12, 12);
  const noisy = [...clean, live(1, 1, { client: "catalog-heartbeat-20261117", reason_code: "server_error", verdict: "recheck" }), live(2, 1, { check_type: "dry-run", reason_code: "pay_to_mismatch", verdict: "skip" }), live(3, 1, { payer: "0xa880153A381Fc8d9AF0933a4c8a69fA32De6Ef22", reason_code: "timeout", verdict: "recheck" })];
  const a = score(clean), b = score(noisy);
  assert.equal(a.score, b.score); assert.equal(a.band, b.band); assert.equal(a.n_eff, b.n_eff); assert.deepEqual(a.flags, b.flags); assert.equal(a.input_ids.join(), b.input_ids.join());
});

test("operator_endpoint: our own hosts and payTo are never scored, ranked or counted", () => {
  for (const host of OPERATOR_HOSTS_DEFAULT) {
    const r = computeScore({ url: `https://${host}/v1/ping`, observations: many(30, 20), now: NOW, cfg: CFG });
    assert.equal(r.band, "operator_endpoint"); assert.equal(r.score, null); assert.equal(r.ranked, false); assert.equal(r.n_eff, 0);
    const pub = publicAnswer(r);
    assert.equal(pub.band, "operator_endpoint"); assert.equal(pub.ranked, false); assert.deepEqual(pub.reasons, ["operator_endpoint"]); assert.equal(pub.meaning, BAND_MEANING.operator_endpoint);
  }
  assert.equal(computeScore({ url: "https://verified-catalog-lookup.someone.workers.dev/x", observations: [], now: NOW, cfg: CFG }).band, "operator_endpoint");
  // a third-party URL whose 402 pays our payTo is ours too
  const r = score(many(10, 10, (d, h) => probe(d, h, { terms: { ...TERMS, pay_to: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674" } })));
  assert.equal(r.band, "operator_endpoint");
  assert.ok(isOperatorHost("API.402xagent.com", CFG) && !isOperatorHost("sellers.example", CFG));
  assert.ok(scoreConfig({ SCORE_OPERATOR_HOSTS: "mine.example, other.example" }).operatorHosts.has("other.example"));
  for (const h of OWN_HOSTS) assert.ok(OPERATOR_HOSTS_DEFAULT.includes(h), h + " is in OWN_HOSTS but not an operator host");
});

test("a steady endpoint is good with high confidence, a number from the formula, and no flags", () => {
  const r = score(many(40, 25, (d, h) => probe(d, h)).map((o, i) => ({ ...o, at: iso(NOW - (i % 25) * DAY - (Math.floor(i / 25) * 5 + 1) * HOUR) })));
  assert.equal(r.band, "good"); assert.equal(r.confidence, "high"); assert.ok(r.score >= 90, String(r.score));
  assert.deepEqual(r.flags, []); assert.ok(r.reasons.includes("probes_ok") && r.reasons.includes("terms_stable"));
  assert.ok(r.days_observed >= 14 && r.n_eff >= 20);
  const pub = publicAnswer(r);
  assert.equal(pub.band, "good"); assert.ok(!("score" in pub) && !("raw" in pub) && !("breakdown" in pub) && !("input_ids" in pub), "free answer shows no number");
  assert.equal(pub.valid_until, iso(NOW.getTime() + HOUR));
});

test("a new endpoint is never penalised for being new: few observations are unknown with low_data", () => {
  for (const obs of [[], [probe(0, 2)], [probe(0, 5), probe(0, 3)], [probe(1, 2), probe(0, 2)]]) {
    const r = score(obs);
    assert.equal(r.band, "unknown", JSON.stringify(r.band)); assert.ok(r.reasons.includes("low_data"));
  }
  // even two failures in a row are unknown, not caution/avoid
  assert.equal(score([probe(1, 0, { reason_code: "timeout", verdict: "recheck", terms: null }), probe(0, 3, { reason_code: "timeout", verdict: "recheck", terms: null })]).band, "unknown");
});

test("shrinkage toward 60 and confidence thresholds", () => {
  assert.equal(confidenceLevel(20, 14, 47 * HOUR), "high");
  assert.equal(confidenceLevel(20, 14, 49 * HOUR), "medium");
  assert.equal(confidenceLevel(8, 5, 0), "medium"); assert.equal(confidenceLevel(7.9, 5, 0), "low"); assert.equal(confidenceLevel(3, 2, 0), "low");
  assert.equal(confidenceLevel(2.9, 9, 0), "none"); assert.equal(confidenceLevel(30, 1, 0), "low".replace("low", "none"));
  const r = score(many(10, 10));
  assert.equal(r.raw, 100);
  assert.equal(r.score, Math.round((r.n_eff * 100 + 5 * 60) / (r.n_eff + 5)));
  assert.ok(r.score < r.raw, "a small sample is pulled toward 60");
  assert.equal(r.breakdown.availability.weight, 35); assert.equal(r.breakdown.terms.weight, 35);
});

test("an endpoint that keeps failing becomes internal avoid (failing_now), and is served as caution + the flag", () => {
  const obs = many(14, 14, (d, h) => probe(d, h, { reason_code: "server_error", verdict: "recheck", http_status: 500, terms: null }));
  const r = score(obs);
  assert.equal(r.band, "avoid");
  assert.ok(r.flags.some((f) => f.code === "failing_now" && f.confirmed));
  const pub = publicAnswer(r);
  assert.equal(pub.band, "caution", "no public avoid label before the appeal path");
  assert.ok(pub.flags.some((f) => f.code === "failing_now")); assert.ok(pub.reasons.includes("failing_now"));
  assert.equal(pub.valid_until, iso(NOW.getTime() + 15 * 60e3), "an internal avoid keeps the short validity");
  assert.ok(!JSON.stringify(pub).includes("avoid"), "the word avoid never appears in a served answer");
});

test("429, WAF challenges and no_paywall are not availability failures", () => {
  const good = many(12, 12);
  const noisy = [...good, probe(0, 9, { reason_code: "rate_limited", verdict: "recheck", http_status: 429, terms: null }), probe(1, 9, { reason_code: "waf_challenge", verdict: "recheck", http_status: 403, terms: null }), probe(2, 9, { reason_code: "dns_error", verdict: "recheck", terms: null })];
  const r = score(noisy);
  // two of the three noisy rows are neutral; only the DNS error counts against availability
  assert.ok(r.breakdown.availability.value < 1 && r.breakdown.availability.value > 0.9);
});

test("pay_to_mismatch: one sighting is only caution; the same fact on two days confirms (internal avoid, public caution + flag)", () => {
  const base = many(12, 12);
  const one = score([...base, probe(0, 1, { reason_code: "pay_to_mismatch", verdict: "skip" })]);
  assert.equal(one.band, "caution"); assert.ok(one.flags.some((f) => f.code === "pay_to_mismatch" && !f.confirmed));
  const two = score([...base, probe(1, 1, { reason_code: "pay_to_mismatch", verdict: "skip" }), probe(0, 1, { reason_code: "pay_to_mismatch", verdict: "skip" })]);
  assert.equal(two.band, "avoid"); assert.ok(two.reasons.includes("pay_to_mismatch"));
  const pub = publicAnswer(two);
  assert.equal(pub.band, "caution"); assert.ok(pub.flags.some((f) => f.code === "pay_to_mismatch" && f.confirmed));
});

test("a flag clears after 3 clean observations over 2 days, and expires after 14 days", () => {
  const early = many(14, 14, (d, h) => probe(d + 10, h)); // 10..23 days ago
  const mm = (d, h) => probe(d, h, { reason_code: "pay_to_mismatch", verdict: "skip" });
  const stillBad = score([...early, mm(9, 1), mm(8, 1), probe(6, 1)]);
  assert.equal(stillBad.band, "avoid");
  const cleared = score([...early, mm(9, 1), mm(8, 1), probe(6, 1), probe(5, 2), probe(4, 3)]);
  assert.ok(!cleared.flags.some((f) => f.code === "pay_to_mismatch"), JSON.stringify(cleared.flags));
  assert.notEqual(cleared.band, "avoid");
  // confirmed 16 days ago and never repeated: expired (the 14-day expiry) even with fewer than 3 clean observations since
  const expired = score([...early.filter((o) => NOW - Date.parse(o.at) > 17 * DAY), mm(17, 1), mm(16, 1), probe(15, 1), probe(0, 1)]);
  assert.ok(!expired.flags.some((f) => f.code === "pay_to_mismatch"), JSON.stringify(expired.flags));
});

test("terms integrity: an unannounced pay_to change is a hard flag; a price-only change is soft and never good", () => {
  const before = many(10, 20, (d, h) => probe(d + 5, h));
  const swapped = { ...TERMS, pay_to: "0xSomeoneElse" };
  const after = [probe(3, 1, { terms: swapped }), probe(2, 1, { terms: swapped }), probe(1, 1, { terms: swapped })];
  const r = score([...before, ...after]);
  assert.ok(r.flags.some((f) => f.code === "pay_to_changed"));
  assert.ok(r.breakdown.terms.value < 1);
  const pricey = score([...before, probe(2, 1, { terms: { ...TERMS, amount: "5000" } }), probe(1, 1, { terms: { ...TERMS, amount: "5000" } })]);
  assert.ok(pricey.flags.some((f) => f.code === "price_changed" && f.severity === "soft"));
  assert.equal(pricey.band, "caution");
});

test("claims: a listing claim counts for outside live checks, a caller's own claimed_price never does", () => {
  const base = many(10, 12);
  const callerClaim = live(0, 2, { reason_code: "price_mismatch", verdict: "skip", listing_source: "request" });
  const r1 = score([...base, callerClaim]);
  assert.ok(!r1.flags.some((f) => f.code === "price_above_listing"));
  assert.equal(r1.breakdown.terms.value, 1);
  const listingClaim = live(0, 2, { reason_code: "price_mismatch", verdict: "skip", listing_source: "listing" });
  const r2 = score([...base, listingClaim]);
  assert.ok(r2.flags.some((f) => f.code === "price_above_listing" && f.severity === "soft"));
  assert.ok(r2.breakdown.terms.value < 1);
  // a pay_to_mismatch claimed by an outside caller is not a hard flag either
  const r3 = score([...base, live(1, 2, { reason_code: "pay_to_mismatch", verdict: "skip", listing_source: "request" }), live(0, 2, { reason_code: "pay_to_mismatch", verdict: "skip", listing_source: "request" })]);
  assert.ok(!r3.flags.some((f) => f.code === "pay_to_mismatch"));
});

test("crawl-only data: unknown with crawl_only and a crawl_hint, never avoid, never good", () => {
  const goodCrawl = Array.from({ length: 4 }, (_, i) => crawl(i * 7));
  const r = score(goodCrawl);
  assert.equal(r.band, "unknown"); assert.deepEqual(r.reasons, ["crawl_only"]);
  assert.equal(r.crawl_hint.observations, 4); assert.equal(r.crawl_hint.last_verdict, "pay");
  const badCrawl = Array.from({ length: 4 }, (_, i) => crawl(i * 7, { reason_code: "server_error", verdict: "recheck", terms: null }));
  assert.equal(score(badCrawl).band, "unknown");
  assert.equal(publicAnswer(score(badCrawl)).band, "unknown");
});

test("crawl weight is low and capped: 100 crawl rows add at most the cap to the sample", () => {
  const lots = Array.from({ length: 25 }, (_, i) => crawl(i, { at: iso(NOW - i * DAY - 2 * HOUR) }));
  const r = score(lots);
  assert.ok(r.n_eff <= CRAWL_WEIGHT_CAP + 1e-9, String(r.n_eff));
  const withProbes = score([...many(10, 10), ...lots]);
  const probesOnly = score(many(10, 10));
  assert.ok(withProbes.n_eff - probesOnly.n_eff <= CRAWL_WEIGHT_CAP + 1e-9);
  // crawl failures cannot sink an otherwise healthy, probed endpoint
  const crawlBad = Array.from({ length: 12 }, (_, i) => crawl(i, { at: iso(NOW - i * DAY - 9 * HOUR), reason_code: "timeout", verdict: "recheck", terms: null }));
  assert.equal(score([...many(25, 25), ...crawlBad]).band, "good");
});

test("one counted observation per UTC hour and kind; a live check cannot hide our failing probe in the same hour", () => {
  const a = score([probe(1, 0), { ...probe(1, 0), at: iso(NOW - DAY + 20 * 60e3), id: "sc-dupe" }, probe(2, 0)]);
  assert.equal(a.observations, 2); assert.equal(a.excluded.duplicate_hour, 1);
  const t = iso(NOW - 3 * HOUR);
  const mixed = score([{ ...probe(0, 3), at: t, id: "p1", reason_code: "server_error", verdict: "recheck", terms: null }, { ...live(0, 3), at: t, id: "l1" }]);
  assert.deepEqual(mixed.input_ids, ["l1", "p1"]);
  assert.equal(mixed.n_eff, OBS_WEIGHTS.live + OBS_WEIGHTS.probe);
  assert.equal(mixed.breakdown.availability.value, 0.6); // probe fail (1.0) + live ok (1.5): both count
});

test("probe origin: once the Worker stamps cron probes, an unstamped self-test row no longer counts (public client/ref cannot be spoofed in)", () => {
  const cfg = scoreConfig({ SCORE_ORIGIN_FROM: "2026-11-10T00:00:00Z" });
  const spoof = probe(1, 0); // after the cutoff, no origin stamp
  assert.equal(classifyObservation(spoof, cfg).excluded, "unstamped_probe");
  assert.equal(classifyObservation({ ...spoof, origin: "cron" }, cfg).kind, "probe");
  assert.equal(classifyObservation({ ...spoof, origin: "cron", ref: "not-a-cron-ref" }, cfg).excluded, "test_client");
  assert.equal(classifyObservation(probe(20, 0), cfg).kind, "probe", "rows from before the cutoff are still accepted by ref");
  assert.equal(classifyObservation(probe(1, 0), scoreConfig({})).kind, "probe", "no cutoff configured: legacy behaviour");
});

test("a flood of outside live checks is capped per UTC day", () => {
  const flood = Array.from({ length: 20 }, (_, i) => live(0, i % 12 + 0.1 * 0, { id: "l" + i, at: iso(NOW - (i + 1) * HOUR) })).filter((o) => o.at.slice(0, 10) === "2026-11-17" || true);
  const r = score(flood);
  const byDay = {};
  for (const id of r.input_ids) { const o = flood.find((x) => x.id === id); byDay[o.at.slice(0, 10)] = (byDay[o.at.slice(0, 10)] || 0) + 1; }
  for (const n of Object.values(byDay)) assert.ok(n <= LIVE_PER_DAY_CAP, JSON.stringify(byDay));
  assert.ok(r.excluded.live_daily_cap >= 1);
});

test("live check that fails while our probe passes raises live_probe_disagree (caution, never good)", () => {
  const r = score([...many(25, 25), live(0, 1, { reason_code: "server_error", verdict: "recheck", terms: null })]);
  assert.ok(r.flags.some((f) => f.code === "live_probe_disagree"));
  assert.equal(r.band, "caution");
});

test("stale data (newest real observation older than 7 days) is unknown/stale_data", () => {
  const r = score(many(20, 20, (d, h) => probe(d + 9, h)));
  assert.equal(r.band, "unknown"); assert.ok(r.reasons.includes("stale_data")); assert.equal(r.stale, true);
  assert.equal(publicAnswer(r).stale, true);
  // a fresh crawl row does not make a stale probed endpoint fresh
  assert.equal(score([...many(20, 20, (d, h) => probe(d + 9, h)), crawl(1)]).band, "unknown");
});

test("not_x402: an endpoint that only ever answers without a paywall is unknown/not_x402", () => {
  const r = score(many(12, 12, (d, h) => probe(d, h, { reason_code: "no_paywall", verdict: "skip", http_status: 200, terms: null })));
  assert.equal(r.band, "unknown"); assert.ok(r.reasons.includes("not_x402"));
  // but an endpoint that is simply down is not "not x402"
  const down = score(many(12, 12, (d, h) => probe(d, h, { reason_code: "timeout", verdict: "recheck", terms: null })));
  assert.ok(!down.reasons.includes("not_x402"));
});

test("delivery component only counts with >= 3 checks; our drill wallet and payTo are ignored; a recent failure is a hard flag", () => {
  const obs = many(25, 25);
  const ok = (d, o = {}) => ({ at: iso(NOW - d * DAY), flag: "ok", ...o });
  assert.equal(score(obs, { delivery: [ok(1), ok(2)] }).breakdown.delivery, undefined);
  const three = score(obs, { delivery: [ok(1), ok(2), ok(3)] });
  assert.equal(three.breakdown.delivery.value, 1); assert.equal(three.breakdown.delivery.weight, 20);
  const self = score(obs, { delivery: [ok(1, { payer: "0xa880153A381Fc8d9AF0933a4c8a69fA32De6Ef22" }), ok(2, { pay_to: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674" }), ok(3)] });
  assert.equal(self.breakdown.delivery, undefined);
  const failed = score(obs, { delivery: [{ at: iso(NOW - 2 * DAY), flag: "failed", reason: "empty_body" }, ok(5), ok(6), ok(7)] });
  assert.ok(failed.flags.some((f) => f.code === "delivery_failed_recent"));
  assert.equal(failed.band, "avoid"); assert.equal(publicAnswer(failed).band, "caution");
  const old = score(obs, { delivery: [{ at: iso(NOW - 20 * DAY), flag: "failed" }, ok(21), ok(22), ok(23)] });
  assert.ok(!old.flags.some((f) => f.code === "delivery_failed_recent"));
});

test("quality: the latest quality code is a small component; a bad one is a soft flag", () => {
  const obs = many(25, 25);
  assert.equal(score(obs, { quality: { code: "quality_ok" } }).breakdown.quality.value, 1);
  const bad = score(obs, { quality: { code: "quality_schema_mismatch" } });
  assert.ok(bad.flags.some((f) => f.code === "quality_issue")); assert.notEqual(bad.band, "good");
});

test("observations outside the 30-day window and future-dated rows are ignored", () => {
  const r = score([...many(10, 10), probe(40, 0), probe(31, 0), { ...probe(0, 0), at: iso(NOW.getTime() + DAY) }]);
  assert.equal(r.observations, 10);
});

test("deterministic: input order does not matter; inputs_digest is stable and order independent", async () => {
  const obs = [...many(15, 15), live(1, 2), live(3, 2)];
  const a = score(obs), b = score([...obs].reverse());
  assert.deepEqual(a, b);
  assert.equal(await inputsDigest(a.input_ids), await inputsDigest([...a.input_ids].reverse()));
  assert.match(await inputsDigest(a.input_ids), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(await inputsDigest(["a"]), await inputsDigest(["b"]));
});

test("published answers only ever carry a public band; internal avoid is never served (randomised sweep)", () => {
  let s = 7;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const codes = ["price_ok", "price_ok", "price_ok", "server_error", "timeout", "pay_to_mismatch", "price_mismatch", "rate_limited", "no_paywall", "dns_error", "network_mismatch"];
  const kinds = [probe, live, (d, h, o) => crawl(d, o)];
  let sawAvoid = false;
  for (let i = 0; i < 300; i++) {
    const n = Math.floor(rnd() * 40);
    const obs = Array.from({ length: n }, () => kinds[Math.floor(rnd() * 3)](Math.floor(rnd() * 32), rnd() * 23, { reason_code: codes[Math.floor(rnd() * codes.length)], verdict: "skip" }));
    const r = score(obs);
    sawAvoid ||= r.band === "avoid";
    const pub = publicAnswer(r);
    assert.ok(PUBLIC_BANDS.includes(pub.band), pub.band);
    assert.ok(!JSON.stringify(pub).includes('"avoid"'));
    for (const rc of pub.reasons) assert.ok(REASON_CODES_SCORE.includes(rc), rc);
    if (!r.observations || !obs.some((o) => o.source !== "crawl")) assert.notEqual(r.band, "avoid");
  }
  assert.ok(sawAvoid, "the sweep should exercise the internal avoid path");
});

test("SCORE_RULES is a frozen, self-describing document", () => {
  assert.equal(SCORE_RULES.version, SCORE_VERSION);
  assert.ok(Object.isFrozen(SCORE_RULES));
  assert.match(SCORE_RULES.public_avoid, /no public avoid label/);
  assert.equal(SCORE_RULES.observation_weights.crawl, 0.25);
  assert.equal(SCORE_RULES.components.availability + SCORE_RULES.components.terms + SCORE_RULES.components.delivery + SCORE_RULES.components.quality, 100);
});
