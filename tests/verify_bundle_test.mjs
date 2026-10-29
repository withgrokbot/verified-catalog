// 0.59.0 fix: bundle-level test. 0.59.0 failed live because verify.js shipped verifierCore.toString(); in the
// wrangler/esbuild bundle that text contains injected __name(...) helpers, undefined in browsers/Node scripts.
// The core now ships as a static string (src/verify-core-src.js). This test builds the REAL deploy bundle with
// `wrangler deploy --dry-run --outdir` (or uses VC_BUNDLE_DIR if set), imports it, and asserts the served page,
// /verify.js, the standalone HTML and verify-receipt.mjs contain no `__name`. Set VC_SKIP_BUNDLE=1 to skip offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { render } from "../worker/scripts/gen-verify-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = join(here, "..", "worker");

test("verify-core-src.js is up to date with verify-core.js", () => {
  assert.equal(readFileSync(join(workerDir, "src", "verify-core-src.js"), "utf8"), render(),
    "stale: run node worker/scripts/gen-verify-core.mjs");
});

test("verify.js does not use Function.prototype.toString for the core", () => {
  const src = readFileSync(join(workerDir, "src", "verify.js"), "utf8");
  assert.ok(!/verifierCore\.toString|\.toString\(\)/.test(src));
});

test("deploy bundle: verifier surfaces contain no __name", { skip: process.env.VC_SKIP_BUNDLE === "1" }, async () => {
  let dir = process.env.VC_BUNDLE_DIR;
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), "vc-bundle-"));
    const env = { ...process.env, WRANGLER_CACHE_DIR: process.env.WRANGLER_CACHE_DIR || "/tmp/wrangler-cache" };
    delete env.CF_API_TOKEN; delete env.CLOUDFLARE_API_TOKEN;
    const r = spawnSync("npx", ["-y", "-p", "node@22", "-p", "wrangler@4.154.0", "wrangler", "deploy", "--dry-run", "--outdir", dir],
      { cwd: workerDir, env, encoding: "utf8", timeout: 300000 });
    assert.equal(r.status, 0, "wrangler dry-run failed: " + (r.stderr || "").slice(-2000));
  }
  const bundle = join(dir, "index.js");
  assert.ok(existsSync(bundle));
  const mod = await import(pathToFileURL(bundle).href);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  for (const p of ["/verify", "/verify.js", "/verify/402xagent-verifier.html", "/verify/verify-receipt.mjs"]) {
    const res = await mod.default.fetch(new Request("https://402xagent.com" + p, { headers: { accept: "text/html" } }), {}, ctx);
    assert.equal(res.status, 200, p);
    const body = await res.text();
    if (p !== "/verify") assert.ok(body.includes("verifierCore"), p + " should embed the verifier core");
    assert.ok(!body.includes("__name"), p + " contains bundler __name helper");
  }
});
