// well-known aliases + host-tagged paywall counts (migration 0024). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker/src/index.js";
import { hostTag, writeFunnel } from "../worker/src/ops.js";
import { sqliteD1 as d1 } from "./helpers/sqlite_d1.mjs";

globalThis.fetch = async () => new Response("{}", { status: 404 });
const env = (x = {}) => ({ CLIENT_SALT: "t", OPS_COUNTERS: "off", ...x });
const get = (u) => worker.fetch(new Request(u, { headers: { accept: "application/json" } }), env(), { waitUntil() {} });

test("mcp.json = repo-root .mcp.json", async () => {
  const r = await get("https://api.402xagent.com/.well-known/mcp.json");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8")));
});
test("x402.json = /.well-known/x402", async () => {
  const a = await (await get("https://api.402xagent.com/.well-known/x402.json")).json();
  const b = await (await get("https://api.402xagent.com/.well-known/x402")).json();
  assert.deepEqual(a, b);
});
test("agent.json and agent-card.json still serve the A2A card", async () => {
  for (const p of ["agent.json", "agent-card.json"]) { const r = await get("https://api.402xagent.com/.well-known/" + p); assert.equal(r.status, 200); assert.ok((await r.json()).name); }
});
test("oauth-protected-resource: clean 404 JSON (no OAuth), also the /mcp suffix form", async () => {
  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const r = await get("https://api.402xagent.com" + p);
    assert.equal(r.status, 404); assert.match(r.headers.get("content-type"), /json/); assert.equal((await r.json()).reason, "no_oauth");
  }
});
test("workers.dev host: new aliases unchanged (not served)", async () => {
  for (const p of ["mcp.json", "x402.json", "oauth-protected-resource"]) {
    const r = await get("https://verified-catalog-lookup.withgrokbot.workers.dev/.well-known/" + p);
    assert.equal(r.status, 404); const b = await r.json().catch(() => ({})); assert.notEqual(b.reason, "no_oauth"); assert.equal(b.mcpServers, undefined);
  }
});
test("hostTag + writeFunnel tags paywall_daily_host and still writes paywall_daily", async () => {
  assert.equal(hostTag("api.402xagent.com"), "api.402xagent.com"); assert.equal(hostTag("x.withgrokbot.workers.dev"), "workers.dev"); assert.equal(hostTag("api.payscout.dev"), "payscout"); assert.equal(hostTag("evil.example"), "other");
  const db = d1();
  await writeFunnel(db, [["/v1/lookup/paid", "outside", "402", ""]], new Date("2026-11-04T00:00:00Z"), "api.402xagent.com");
  await writeFunnel(db, [["/v1/lookup/paid", "outside", "402", ""]], new Date("2026-11-04T00:00:00Z"), "verified-catalog-lookup.withgrokbot.workers.dev");
  await writeFunnel(db, [["/v1/lookup/paid", "outside", "402", ""]], new Date("2026-11-04T00:00:00Z"));
  assert.equal((await db.prepare("SELECT n FROM paywall_daily").first()).n, 3);
  const rows = (await db.prepare("SELECT host, n FROM paywall_daily_host ORDER BY host").all()).results;
  assert.deepEqual(rows.map((r) => [r.host, r.n]), [["api.402xagent.com", 1], ["workers.dev", 1]]);
});
