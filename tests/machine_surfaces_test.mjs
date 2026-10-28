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

// 0.58.3: /pricing is rebuilt (HTML for every Accept, as before; it never had a machine form). Everything around it stays
// byte-identical to main 714e418 (0.58.2): the /pricing machine-looking paths (404 JSON) on every host and Accept, and the
// browser homepage, /home.js, /docs and /docs/try-it.js on 402xagent.com. The 0.57.1 snapshot above still covers root JSON,
// llms.txt, skill.md, openapi.json, /mcp and every /v1 route (llms.txt and openapi.json mention /pricing; both unchanged).
test("0.58.3 /pricing rebuild: pricing machine paths and the homepage are byte-identical to 0.58.2", () => {
  const want2 = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.2", "extra.json"), "utf8"));
  const r = spawnSync(process.execPath, [join(HERE, "helpers", "machine_snapshot.mjs"), "--extra", join(HERE, "..", "worker", "src", "index.js")], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.ok(Object.keys(want2).length >= 180, "extra snapshot covers the pricing paths on every host");
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want2).sort(), "same request set");
  const HOME = "GET https://402xagent.com/ [html]";
  assert.deepEqual(Object.keys(want2).filter((k) => k !== HOME && JSON.stringify(got[k]) !== JSON.stringify(want2[k])), [], "changed responses");
  // the homepage: same status and headers; the body differs from 0.58.2 only by the two review strings (Watchtower and Hosted cards)
  assert.equal(got[HOME].status, want2[HOME].status); assert.deepEqual(got[HOME].headers, want2[HOME].headers);
  assert.notEqual(got[HOME].sha256, want2[HOME].sha256, "the two card strings did change");
  for (const k of ["GET https://402xagent.com/ [html]", "GET https://402xagent.com/home.js [html]", "GET https://402xagent.com/docs [html]"]) assert.equal(want2[k].status, 200, k);
  for (const k of ["GET https://402xagent.com/pricing.json [json]", "GET https://api.402xagent.com/pricing.json [none]", "GET https://402xagent.com/v1/pricing [curl]"]) assert.equal(want2[k].status, 404, k);
});

test("0.58.3 review: the homepage body equals 0.58.2 once the two card strings are swapped back", async () => {
  const want2 = JSON.parse(readFileSync(join(HERE, "fixtures", "machine_0.58.2", "extra.json"), "utf8"));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { snapshotHomeBody } = await import(${JSON.stringify(join(HERE, "helpers", "machine_snapshot.mjs"))});
    process.stdout.write(await snapshotHomeBody(${JSON.stringify(join(HERE, "..", "worker", "src", "index.js"))}));`], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const body = r.stdout;
  const SWAPS = [["Regular re-probes of an endpoint you depend on", "Hourly re-probes of an endpoint you depend on"],
    ["by arrangement: usage tracked; billed monthly by arrangement.", "by arrangement: hosted checks billed on a monthly USDC invoice instead of per call."]];
  for (const [now] of SWAPS) assert.equal(body.split(now).length, 2, now);
  let old = body; for (const [now, was] of SWAPS) old = old.replace(now, was);
  assert.equal(createHash("sha256").update(old).digest("hex"), want2["GET https://402xagent.com/ [html]"].sha256, "nothing else on the homepage changed");
});
