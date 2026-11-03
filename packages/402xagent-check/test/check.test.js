import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { check, checkUrl, CheckError, DEFAULT_BASE } from "../index.js";

const fake = (status, body, seen = []) => async (u, init) => { seen.push([u, init]); return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }; };

test("checkUrl targets the free spot-check endpoint and encodes the url", () => {
  assert.equal(checkUrl(" https://a.io/x?y=1&z=2 "), DEFAULT_BASE + "/v1/products/endpoint-spot-check?url=https%3A%2F%2Fa.io%2Fx%3Fy%3D1%26z%3D2");
  assert.throws(() => checkUrl(""), TypeError);
});

test("check resolves to the verdict JSON", async () => {
  const seen = [];
  const r = await check("https://api.402rates.com/v1/ping", { fetch: fake(200, { verdict: "pay", reason: "terms match" }, seen) });
  assert.deepEqual(r, { verdict: "pay", reason: "terms match" });
  assert.match(seen[0][0], /endpoint-spot-check\?url=https%3A%2F%2Fapi\.402rates\.com/);
  assert.equal(seen[0][1].headers.accept, "application/json");
});

test("400, 402 and 429 reject with CheckError carrying status and body", async () => {
  await assert.rejects(check("x", { fetch: fake(400, { error: "Invalid url" }) }), (e) => e instanceof CheckError && e.status === 400 && e.message === "Invalid url");
  await assert.rejects(check("https://a.io", { fetch: fake(402, {}) }), (e) => e.status === 402 && /5 a day/.test(e.message));
  await assert.rejects(check("https://a.io", { fetch: fake(429, {}) }), (e) => e.status === 429);
});

test("zero dependencies, MIT under withgrokbot, bin wired", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.license, "MIT"); assert.equal(pkg.bin["402xagent-check"], "cli.js");
  assert.match(readFileSync(new URL("../LICENSE", import.meta.url), "utf8"), /Copyright \(c\) 2026 withgrokbot/);
  assert.match(readFileSync(new URL("../README.md", import.meta.url), "utf8"), /https:\/\/402xagent\.com\/docs/);
});

test("CLI: usage without a url exits 3", () => {
  const r = spawnSync(process.execPath, [new URL("../cli.js", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(r.status, 3); assert.match(r.stdout, /Usage: npx 402xagent-check/);
});
