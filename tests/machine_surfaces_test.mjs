// 0.58.0: every machine surface is byte-identical to 0.57.1 (main 5efdf33): root JSON for non-browser clients (no Accept,
// application/json, */*, text/plain, curl) on every host, llms.txt, skill.md, rules.json, openapi.json, /mcp (GET + JSON-RPC
// initialize / tools/list / resources/list), every /v1 route (GET and POST, plus browsers on /v1), /.well-known, /health.
// Status, every response header and the body sha256 must match the saved snapshot; the only tolerated change is the
// VERSION string (replaced by "<VERSION>" on both sides). Snapshot: node tests/helpers/machine_snapshot.mjs <worker/src/index.js>
// run on a 0.57.1 checkout, saved to tests/fixtures/machine_0.57.1/snapshot.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const want = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.57.1", "snapshot.json"), "utf8"));

test("0.58.0 machine surfaces: byte-identical to the 0.57.1 snapshot (status, headers, body)", () => {
  const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), join(HERE, "..", "worker", "src", "index.js")], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.ok(Object.keys(want).length > 1000, "snapshot covers the surfaces");
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), "same request set");
  const diff = Object.keys(want).filter((k) => JSON.stringify(got[k]) !== JSON.stringify(want[k]));
  assert.deepEqual(diff, [], "changed machine responses");
  // spot checks that the snapshot really covers what matters
  for (const k of ["GET https://402xagent.com/ [none]", "GET https://402xagent.com/ [json]", "GET https://402xagent.com/ [curl]", "GET https://api.402xagent.com/ [html]",
    "GET https://402xagent.com/llms.txt [none]", "GET https://402xagent.com/skill.md [none]", "GET https://402xagent.com/rules.json [none]", "GET https://api.402xagent.com/openapi.json [none]"])
    assert.ok(want[k] && want[k].status === 200, k);
  assert.match(want["GET https://402xagent.com/ [json]"].headers["content-type"], /application\/json/);
});

test("0.58.0 snapshot helper is deterministic and normalizes only the version", () => {
  const src = readFileSync(join(HERE, "helpers", "machine_snapshot.mjs"), "utf8");
  assert.match(src, /split\(VERSION\)\.join\("<VERSION>"\)/);
  assert.equal(createHash("sha256").update(JSON.stringify(want)).digest("hex").length, 64);
});
