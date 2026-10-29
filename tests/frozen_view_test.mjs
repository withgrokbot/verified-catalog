// 0.59.1: frozen public view. Signed rows already freeze their public view at write time (signed_view, 0.38.0) and reads
// serve it verbatim. What was missing: a NEW receipt stored without a signature (no RECEIPT_SIGNING_KEY, or signing
// failed) was rebuilt on every read by the current view code. 0.59.1 stores it as frozen_view inside the same body.
// No migration, no new table, no KV; rows stored before 0.59.1 are read exactly as before.
// The "view-code change" is simulated by loading a patched copy of worker/src (redaction text, brand rewrite and a new
// read-time field changed) against the same D1 rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "worker", "src");
const MIGS = readdirSync(join(ROOT, "worker", "migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(ROOT, "worker", "migrations", f), "utf8"));
function d1() {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGS) db.exec(m);
  const norm = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));
  const mk = (sql, args = []) => ({ sql, args, bind: (...a) => mk(sql, norm(a)), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; } });
  return { raw: db, prepare: (sql) => mk(sql) };
}
const SAMPLE = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "receipts_sample_2026-10-28.json"), "utf8")).rows;
const load = async (dir) => ({ lib: await import(pathToFileURL(join(dir, "lib.js")).href), sign: await import(pathToFileURL(join(dir, "sign.js")).href), worker: (await import(pathToFileURL(join(dir, "index.js")).href)).default });
function patchedCopy() { // the simulated later view-code change
  const dir = mkdtempSync(join(tmpdir(), "fv-src-")); cpSync(SRC, dir, { recursive: true });
  const p = join(dir, "lib.js"); let s = readFileSync(p, "utf8");
  const a = 'o.redacted = "free check: the 402 terms and the approved payment are in the paid check";';
  assert.ok(s.includes(a)); s = s.replace(a, 'o.redacted = "CHANGED VIEW CODE"; o.view_code_v2 = true;');
  const b = "export function normReceipt(r) {\n  if (!r) return r;";
  assert.ok(s.includes(b)); s = s.replace(b, b + "\n  r = { ...r, read_time_note: \"added by newer view code\" };");
  writeFileSync(p, s); return dir;
}
const cur = await load(SRC), nxt = await load(patchedCopy());
const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", privateKey)), kid: "test-frozen-key" };
for (const m of [cur, nxt]) { m.sign._addTestKey({ kid: jwk.kid, x: jwk.x }); m.sign._resetSigner(); }
const { verifierCore } = await import(pathToFileURL(join(SRC, "verify-core.js")).href);
const V = verifierCore([{ kid: jwk.kid, x: jwk.x }]);
const get = async (m, env, p) => { const r = await m.worker.fetch(new Request("https://402xagent.com" + p, { headers: { accept: "application/json" } }), env, { waitUntil() {}, passThroughOnException() {} }); return r.text(); };
const fresh = (row, id) => { const b = JSON.parse(row.body); delete b.signed_view; delete b.kid; delete b.signature; return { ...b, id, checked_at: "2026-10-29T18:00:00Z" }; };
const raw = (db, id) => JSON.parse(db.raw.prepare("SELECT body FROM spot_receipts WHERE id = ?").get(id).body);

test("0.59.1 version", () => assert.equal(cur.lib.VERSION, "0.59.1"));

test("0.59.1 no migration, no new table: the frozen view lives in the existing body column", () => {
  const files = readdirSync(join(ROOT, "worker", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.equal(files.at(-1), "0021_breaker_events.sql");
});

test("0.59.1 NEW unsigned receipt: frozen_view stored; served bytes identical after a simulated view-code change", async () => {
  const db = d1(), env = { RECEIPTS_DB: db };
  for (const [i, row] of SAMPLE.entries()) {
    const id = "sc-" + "a".repeat(15) + i;
    assert.equal(await cur.lib.saveLiveReceipt(env, fresh(row, id)), true);
    const b = raw(db, id); assert.ok(b.frozen_view && !b.signed_view, id + " frozen, unsigned");
    const before = await get(cur, env, "/v1/receipts/" + id);
    assert.deepEqual(JSON.parse(before), b.frozen_view, "served = frozen");
    assert.equal(await get(nxt, env, "/v1/receipts/" + id), before, id + ": newer view code serves the same bytes");
  }
  // the lists too
  for (const t of ["dry-run", "live", "self-checked"]) assert.equal(await get(nxt, env, "/v1/receipts?type=" + t), await get(cur, env, "/v1/receipts?type=" + t), t);
});

test("0.59.1 NEW signed receipt: signed bytes identical after the change, signature VALID under both (signed_view, 0.38.0)", async () => {
  const db = d1(), env = { RECEIPTS_DB: db, RECEIPT_SIGNING_KEY: JSON.stringify(jwk) };
  for (const [i, row] of SAMPLE.entries()) {
    const id = "sc-" + "b".repeat(15) + i;
    await cur.lib.saveLiveReceipt(env, fresh(row, id));
    const b = raw(db, id); assert.ok(b.signed_view && !b.frozen_view);
    const before = await get(cur, env, "/v1/receipts/" + id), after = await get(nxt, env, "/v1/receipts/" + id);
    assert.equal(after, before);
    assert.equal((await V.verifyText(after)).status, "valid");
  }
});

test("0.59.1 control: an OLD row (no signed_view, no frozen_view) is still rebuilt by view code (the test can see a change)", async () => {
  const db = d1(), env = { RECEIPTS_DB: db };
  const row = SAMPLE.find((r) => r.check_type === "dry-run"), b = JSON.parse(row.body); delete b.signed_view;
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, body) VALUES (?, ?, ?, ?, ?, ?, ?)").run(b.id, b.url, b.checked_at, b.verdict, b.reason, b.check_type, JSON.stringify(b));
  const a = await get(cur, env, "/v1/receipts/" + b.id), c = await get(nxt, env, "/v1/receipts/" + b.id);
  assert.notEqual(a, c); assert.match(c, /read_time_note/);
});

test("0.59.1 OLD rows byte-identical to 0.59.0: sample rows (signed and unsigned) read the same through the 0.59.1 code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fv-0590-")); cpSync(SRC, dir, { recursive: true });
  const p = join(dir, "lib.js"); let s = readFileSync(p, "utf8");
  // the 0.59.0 read path = this code minus the one frozen_view line (and the version)
  const line = s.split("\n").find((l) => l.includes("// 0.59.1: unsigned, frozen at write")); assert.ok(line);
  s = s.replace(line + "\n", "").replace('export const VERSION = "0.59.1";', 'export const VERSION = "0.59.0";'); writeFileSync(p, s);
  const old = await load(dir);
  const db = d1(), env = { RECEIPTS_DB: db };
  for (const r of SAMPLE) { const b = JSON.parse(r.body); db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, ref, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(r.id, r.url, r.created_at, b.verdict, b.reason, r.check_type, r.ref, r.body); }
  const unsigned = SAMPLE[0]; const ub = JSON.parse(unsigned.body); delete ub.signed_view; ub.id = "sc-cccccccccccccccc";
  db.raw.prepare("INSERT INTO spot_receipts (id, url, created_at, verdict, reason, check_type, body) VALUES (?, ?, ?, ?, ?, ?, ?)").run(ub.id, ub.url, ub.checked_at, ub.verdict, ub.reason, ub.check_type, JSON.stringify(ub));
  const norm = (t) => t.split("0.59.0").join("<V>").split("0.59.1").join("<V>");
  for (const id of [...SAMPLE.map((r) => r.id), ub.id]) assert.equal(norm(await get(cur, env, "/v1/receipts/" + id)), norm(await get(old, env, "/v1/receipts/" + id)), id);
  for (const t of ["dry-run", "live", "self-checked"]) assert.equal(norm(await get(cur, env, "/v1/receipts?type=" + t)), norm(await get(old, env, "/v1/receipts?type=" + t)), t);
});

test("0.59.1 frozen_view holds only the public view: no buyer data, no client", async () => {
  const db = d1(), env = { RECEIPTS_DB: db };
  const b = fresh(SAMPLE[1], "sc-dddddddddddddddd");
  b.client = "203.0.113.77"; b.payment_received = { payer: "0x" + "ab".repeat(20), settle_tx: "0x" + "cd".repeat(32) };
  await cur.lib.saveLiveReceipt(env, b);
  const fv = JSON.stringify(raw(db, b.id).frozen_view);
  for (const secret of ["203.0.113.77", "ab".repeat(20), "cd".repeat(32)]) assert.ok(!fv.includes(secret));
  assert.ok(!(await get(cur, env, "/v1/receipts/" + b.id)).includes("ab".repeat(20)));
});
