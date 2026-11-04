// 0.61.0: A2A AgentCard at /.well-known/agent.json (+ /.well-known/agent-card.json), 400x400 logo at /logo-400.png,
// root .mcp.json, X handle @402xAgent in page metadata. Schema: tests/fixtures/a2a/a2a-v1.0.json
// (https://a2a-protocol.org/latest/spec/a2a.json, fetched 2026-11-03; generated from a2a.proto v1.0.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker/src/index.js";
import { VERSION } from "../worker/src/lib.js";
import { landingHtml } from "../worker/src/landing.js";

const ROOT = new URL("..", import.meta.url);
const SCHEMA = JSON.parse(readFileSync(new URL("tests/fixtures/a2a/a2a-v1.0.json", ROOT), "utf8"));
const SERVER = JSON.parse(readFileSync(new URL("server.json", ROOT), "utf8"));
const env = { CLIENT_SALT: "t" };
const get = (u, h = {}) => worker.fetch(new Request(u, { headers: h }), env, { waitUntil() {} });

test("0.61.0 version", () => { assert.equal(VERSION, "0.65.0"); assert.equal(SERVER.version, VERSION); });

test("logo-400.png: 200, image/png, 400x400 PNG, long cache, on every host", async () => {
  for (const h of ["https://402xagent.com", "https://api.402xagent.com"]) {
    const r = await get(h + "/logo-400.png");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal(r.headers.get("cache-control"), "public, max-age=604800");
    const b = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([...b.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
    const dv = new DataView(b.buffer, b.byteOffset);
    assert.equal(dv.getUint32(16), 400, "width"); assert.equal(dv.getUint32(20), 400, "height");
    assert.ok(b.length > 5000 && b.length < 100000, "size " + b.length);
    const head = await worker.fetch(new Request(h + "/logo-400.png", { method: "HEAD" }), env, { waitUntil() {} });
    assert.equal(head.status, 200);
  }
});

// minimal JSON Schema check against the A2A AgentCard definition: required fields, no unknown properties
// (additionalProperties false at every level), and types of the nested objects we use.
function checkDef(name, obj, path = name) {
  const d = SCHEMA.$defs[name];
  assert.ok(d, "schema def " + name);
  for (const k of d.required || []) assert.ok(k in obj, `${path}.${k} required`);
  if (d.additionalProperties === false) for (const k of Object.keys(obj)) assert.ok(k in d.properties, `${path}.${k} not in ${name}`);
  for (const [k, v] of Object.entries(obj)) {
    const p = d.properties[k]; const ref = (p.$ref || (p.items && p.items.$ref) || "").split("/").pop();
    if (p.type === "string") assert.equal(typeof v, "string", path + "." + k);
    if (p.type === "boolean") assert.equal(typeof v, "boolean", path + "." + k);
    if (p.type === "array") { assert.ok(Array.isArray(v), path + "." + k); if (ref) v.forEach((x, i) => checkDef(ref, x, `${path}.${k}[${i}]`)); else v.forEach((x) => assert.equal(typeof x, "string")); }
    else if (ref) checkDef(ref, v, path + "." + k);
  }
}

test("agent card: 200 JSON on both well-known paths, A2A v1.0 AgentCard fields", async () => {
  let first;
  for (const u of ["https://402xagent.com/.well-known/agent.json", "https://api.402xagent.com/.well-known/agent.json", "https://api.402xagent.com/.well-known/agent-card.json"]) {
    const r = await get(u);
    assert.equal(r.status, 200, u);
    assert.match(r.headers.get("content-type"), /^application\/json/);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    const txt = await r.text();
    assert.ok(txt.length > 500 && txt.length < 8000, "size " + txt.length);
    const c = JSON.parse(txt);
    if (first) assert.deepEqual(c, first); else first = c;
  }
  const c = first;
  for (const k of ["name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) assert.ok(k in c, k);
  checkDef("AgentCard", c);
  assert.equal(c.name, "402xAgent");
  assert.equal(c.description, SERVER.description);
  assert.equal(c.version, VERSION);
  assert.deepEqual(c.provider, { organization: "402xAgent", url: "https://402xagent.com" });
  assert.equal(c.supportedInterfaces[0].url, "https://api.402xagent.com");
  assert.equal(c.iconUrl, "https://402xagent.com/logo-400.png");
  assert.deepEqual(c.skills.map((s) => s.id), ["free-check", "spot-check"]);
  for (const s of c.skills) assert.ok(s.description.includes("/v1/products/endpoint-spot-check") || s.description.includes("$0.02"));
  assert.match(c.skills[0].description, /5 free checks per client per UTC day/);
  assert.match(c.skills[1].description, /\$0\.02 USDC on Base/);
  const txt = JSON.stringify(c);
  assert.ok(!/@[a-z0-9-]+\.[a-z]/i.test(txt.replace(/buildwithgrok@mail\.grokbot\.com/g, "")), "no email");
  assert.ok(!/withgrokbot|workers\.dev/i.test(txt), "no personal / legacy identifiers");
});

test(".mcp.json: Cursor remote server shape, no type, no auth", () => {
  const m = JSON.parse(readFileSync(new URL(".mcp.json", ROOT), "utf8"));
  assert.deepEqual(m, { mcpServers: { "402xagent": { url: "https://api.402xagent.com/mcp" } } });
});

test("X handle @402xAgent in page metadata and footer", async () => {
  const land = landingHtml("https://402xagent.com");
  assert.match(land, /<meta name="twitter:site" content="@402xAgent">/);
  assert.match(land, /<meta name="twitter:creator" content="@402xAgent">/);
  const home = await (await get("https://402xagent.com/", { accept: "text/html" })).text();
  assert.match(home, /<meta name="twitter:site" content="@402xAgent">/);
  assert.match(home, /href="https:\/\/x\.com\/402xAgent"/);
  for (const p of ["/docs", "/pricing"]) {
    const t = await (await get("https://402xagent.com" + p, { accept: "text/html" })).text();
    assert.match(t, /href="https:\/\/x\.com\/402xAgent"/, p);
  }
});
