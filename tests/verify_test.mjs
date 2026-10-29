// 0.59.0: public offline receipt verifier (worker/src/verify.js + verify-core.js).
// Fixtures: tests/fixtures/verify/ holds two real public receipt views fetched Oct 29, 2026 (?format=json):
// sc-7cf5080faccbc6ee (signed dry run, the acceptance receipt) and 44e3732d23 (a crawl receipt, unsigned).
// tests/fixtures/machine_0.58.9/ is the machine + receipt snapshot of main 4e53549 (0.58.9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import { receiptKeysDoc, RECEIPT_PUBLIC_KEYS } from "../worker/src/sign.js";
import { verifierCore } from "../worker/src/verify-core.js";
import { pinnedKeys, verifyPageJs, verifyStandaloneHtml, verifyNodeScript, VERIFY_EXAMPLE_ID } from "../worker/src/verify.js";
import { VERIFY_HREF } from "../worker/src/receipts-html.js";
import { DOCS_CSP } from "../worker/src/tryit.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = (f) => readFileSync(join(HERE, "fixtures", "verify", f), "utf8");
const SC = FX("sc-7cf5080faccbc6ee.json"), CRAWL = FX("crawl-44e3732d23.json");
const V = verifierCore(pinnedKeys());
const env = { DATA_BASE_URL: "https://data.fixture/vc/" };
const get = async (p, headers = {}) => { const r = await worker.fetch(new Request("https://402xagent.com" + p, { headers }), env, { waitUntil() {}, passThroughOnException() {} }); return { r, text: await r.text() }; };
const keysIn = (src) => JSON.parse(/\}\)\((\[\{"kid".*?\}\])\);/.exec(src)[1]);

test("0.59.0 version (now 0.59.1)", () => assert.equal(VERSION, "0.59.1"));

test("0.59.0 pinned keys = the published keys doc (kid + x), in the page script, the standalone file and the Node script", () => {
  const published = receiptKeysDoc().keys.map((k) => ({ kid: k.kid, x: k.x }));
  assert.ok(published.length >= 1);
  assert.deepEqual(pinnedKeys(), published);
  assert.deepEqual(pinnedKeys(), RECEIPT_PUBLIC_KEYS.map((k) => ({ kid: k.kid, x: k.x })));
  for (const src of [verifyPageJs(), verifyStandaloneHtml(), verifyNodeScript()]) assert.deepEqual(keysIn(src), published);
  assert.ok(pinnedKeys().some((k) => k.kid === JSON.parse(SC).kid), "the acceptance receipt's kid is pinned");
});

test("0.59.0 acceptance receipt sc-7cf5080faccbc6ee verifies VALID with no network (WebCrypto and the JS fallback)", async () => {
  const realFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error("network used in the verification path"); };
  try {
    const a = await V.verifyText(SC), b = await V.verifyText(SC, { forceFallback: true });
    assert.equal(a.status, "valid"); assert.equal(a.id, VERIFY_EXAMPLE_ID); assert.equal(a.engine, "WebCrypto Ed25519");
    assert.equal(b.status, "valid"); assert.equal(b.engine, "built-in JavaScript Ed25519");
    assert.equal(a.signed_sha256, b.signed_sha256);
  } finally { globalThis.fetch = realFetch; }
});

test("0.59.0 tampered -> INVALID; crawl -> unsigned (crawl record); unknown kid; old unsigned sc-; junk", async () => {
  const r = JSON.parse(SC);
  for (const mut of [(x) => { x.verdict = "skip"; }, (x) => { x.url += "x"; }, (x) => { x.kid = x.kid; x.extra = 1; }, (x) => { x.signature = x.signature.slice(0, -2) + (x.signature.endsWith("AA") ? "BA" : "AA"); }, (x) => { delete x.signature; }]) {
    const t = structuredClone(r); mut(t);
    for (const o of [{}, { forceFallback: true }]) assert.equal((await V.verifyReceipt(t, o)).status, "invalid");
  }
  const c = await V.verifyText(CRAWL); assert.equal(c.status, "unsigned-crawl"); assert.equal(c.title, "Unsigned (crawl record)"); assert.doesNotMatch(c.detail, /\bis (valid|invalid)\b/);
  const u = await V.verifyReceipt({ ...r, kid: "402xagent-29990101-00000000" }); assert.equal(u.status, "unknown-key"); assert.match(u.detail, /not one of the keys pinned/); assert.match(u.detail, /does not mean the receipt is invalid/);
  const { kid, signature, ...old } = r; void kid; void signature;
  assert.equal((await V.verifyReceipt(old)).status, "unsigned-live");
  assert.equal((await V.verifyText("not json")).status, "not-a-receipt");
  assert.equal((await V.verifyText("[1,2]")).status, "not-a-receipt");
});

test("0.59.0 JS Ed25519 + SHA-512 fallback agrees with WebCrypto on fresh keys, messages and bit flips", async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  for (let i = 0; i < 12; i++) {
    const msg = crypto.getRandomValues(new Uint8Array(i * 97));
    assert.equal(Buffer.from(V._sha512js(msg)).toString("hex"), createHash("sha512").update(msg).digest("hex"));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, msg));
    assert.equal(V._ed25519VerifyJs(pub, sig, msg), true);
    const bad = Uint8Array.from(sig); bad[i % 64] ^= 1 << (i % 8);
    assert.equal(V._ed25519VerifyJs(pub, bad, msg), false);
    if (msg.length) { const m2 = Uint8Array.from(msg); m2[0] ^= 1; assert.equal(V._ed25519VerifyJs(pub, sig, m2), false); }
  }
});

test("0.59.0 JCS in the verifier = sign.js canonicalize (what the Worker signs)", async () => {
  const { canonicalize } = await import("../worker/src/sign.js");
  const r = JSON.parse(SC); assert.equal(V.jcs(r), canonicalize(r));
  const odd = { b: [1, 2.5, -0, 1e21, "é\u2028"], a: { z: null, y: true }, c: "\"q\"" }; assert.equal(V.jcs(odd), canonicalize(odd));
});

test("0.59.0 /verify page: strict CSP, no inline script, external /verify.js, download links; nothing fetched by the check", async () => {
  const { r, text } = await get("/verify", { accept: "text/html" });
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-security-policy"), DOCS_CSP);
  assert.match(DOCS_CSP, /script-src 'self' https:\/\/static\.cloudflareinsights\.com;/);
  const scripts = text.match(/<script\b[^>]*>/g) || [];
  assert.deepEqual(scripts, ['<script src="/verify.js" defer>']);
  assert.ok(!/<script>[\s\S]*?<\/script>/.test(text) && !/ on[a-z]+="/.test(text), "no inline script or handler");
  assert.match(text, /href="\/verify\/402xagent-verifier\.html" download/); assert.match(text, /href="\/verify\/verify-receipt\.mjs" download/);
  for (const k of pinnedKeys()) assert.ok(text.includes(k.kid) && text.includes(k.x));
  const js = await get("/verify.js"); assert.equal(js.r.status, 200); assert.match(js.r.headers.get("content-type"), /javascript/); assert.equal(js.text, verifyPageJs());
  assert.doesNotMatch(js.text, /innerHTML/);
  // the only fetch in the page script is the optional same-origin fill-in; the verifier core has none
  assert.equal((js.text.match(/\bfetch\(/g) || []).length, 1); assert.match(js.text, /fetch\("\/v1\/receipts\/" \+ id \+ "\?format=json"/);
  assert.doesNotMatch(verifierCore.toString(), /\bfetch\(|XMLHttpRequest|importScripts|https?:\/\//);
  assert.equal((await get("/verify/")).r.status, 200);
});

test("0.59.0 standalone file: self-contained (no src/href to anywhere), CSP connect-src 'none', served as an attachment with a hash CSP", async () => {
  const html = verifyStandaloneHtml();
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|<img\b|\bfetch\(|XMLHttpRequest/);
  assert.match(html, /connect-src 'none'/);
  const { r, text } = await get("/verify/402xagent-verifier.html");
  assert.equal(text, html); assert.match(r.headers.get("content-disposition"), /attachment; filename="402xagent-verifier\.html"/);
  const inline = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1];
  assert.match(r.headers.get("content-security-policy"), new RegExp("script-src 'sha256-" + createHash("sha256").update(inline).digest("base64").replace(/[+/]/g, "\\$&") + "'"));
});

test("0.59.0 Node script: VALID exit 0, tampered exit 1, crawl exit 2 (no network)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-")), s = join(dir, "verify-receipt.mjs");
  writeFileSync(s, verifyNodeScript());
  const run = (txt) => { const f = join(dir, "r.json"); writeFileSync(f, txt); return spawnSync(process.execPath, [s, f], { encoding: "utf8" }); };
  const ok = run(SC); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /^VALID sc-7cf5080faccbc6ee/);
  const t = JSON.parse(SC); t.verdict = "skip"; const bad = run(JSON.stringify(t)); assert.equal(bad.status, 1); assert.match(bad.stdout, /^INVALID/);
  const cr = run(CRAWL); assert.equal(cr.status, 2); assert.match(cr.stdout, /^Unsigned \(crawl record\)/);
  assert.equal((await get("/verify/verify-receipt.mjs")).text, verifyNodeScript());
});

test("0.59.0 receipt pages: Verify offline -> /verify?id=<id>; sitemap lists /verify", async () => {
  assert.equal(VERIFY_HREF, "/verify");
  const sm = (await get("/sitemap.xml")).text; assert.match(sm, /<loc>https:\/\/402xagent\.com\/verify<\/loc>/);
});

// Machine surfaces against main 4e53549 (0.58.9): with the 0.59.0 additions kept, exactly llms.txt (one added line) and
// the keys doc (one added field) differ; with them removed (the helper's as0589), nothing differs. Receipt pages: only the
// signed sc- pages for browsers differ, and only by the Verify offline link target.
const snap = (flag, keep) => {
  const args = [join(HERE, "helpers", "machine_snapshot.mjs"), ...(flag ? [flag] : []), join(HERE, "..", "worker", "src", "index.js")];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, SNAP_KEEP_0590: keep ? "1" : "" } });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
};
const diffKeys = (a, b) => Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
test("0.59.0 machine surfaces vs 0.58.9: only the llms.txt line and the keys-doc field are added", () => {
  const want = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.9", "snapshot.json"), "utf8"));
  const kept = snap(null, true), stripped = snap(null, false);
  assert.deepEqual(Object.keys(kept).sort(), Object.keys(want).sort());
  assert.deepEqual(diffKeys(want, stripped), [], "nothing else changed");
  const changed = diffKeys(want, kept);
  assert.ok(changed.length > 0);
  assert.deepEqual(changed.filter((k) => !/ https:\/\/[^/ ]+\/(llms\.txt|\.well-known\/402xagent-(keys|receipt-key)\.json) \[/.test(k)), []);
  for (const k of changed) assert.deepEqual({ ...kept[k], sha256: "" }, { ...want[k], sha256: "" }, k + ": status and headers unchanged");
});
test("0.59.0 the two additions themselves (exact text)", async () => {
  const llms = (await get("/llms.txt")).text.split("\n");
  const add = llms.filter((l) => l.startsWith("- Offline receipt verifier"));
  assert.deepEqual(add, ["- Offline receipt verifier (0.59.0; public keys pinned, the check makes no call to our servers): https://402xagent.com/verify (standalone HTML file: https://402xagent.com/verify/402xagent-verifier.html; Node 18+ script: https://402xagent.com/verify/verify-receipt.mjs)"]);
  const kd = JSON.parse((await get("/.well-known/402xagent-keys.json")).text);
  assert.equal(kd.offline_verifier, "https://402xagent.com/verify (0.59.0: keys pinned in the page; standalone file /verify/402xagent-verifier.html, Node script /verify/verify-receipt.mjs)");
  assert.equal(Object.keys(kd).at(-2), "offline_verifier"); assert.equal(Object.keys(kd).at(-1), "keys");
});
test("0.59.0 receipt routes vs 0.58.9: JSON byte-identical; HTML differs only in the Verify offline link", () => {
  const want = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.9", "receipts.json"), "utf8"));
  const kept = snap("--receipts", true), stripped = snap("--receipts", false);
  assert.deepEqual(diffKeys(want, stripped), [], "after restoring the old link target nothing differs");
  const changed = diffKeys(want, kept);
  assert.ok(changed.length > 0);
  assert.deepEqual(changed.filter((k) => !/^GET https:\/\/(402xagent\.com|api\.402xagent\.com)\/v1\/receipts\/sc-[0-9a-f]{16} \[(html|htmljson)\]$/.test(k)), [], "only browser sc- receipt pages");
});
