// 0.58.9: every 402 answer of the machine snapshot (same requests and env as machine_snapshot.mjs snapshot()), with its
// full normalized body and headers, so a test can show the 0.58.9 Bazaar metadata is the only change in a 402.
// Run: node tests/helpers/bodies402.mjs <path-to-worker/src/index.js>  -> prints JSON {key: {status, headers, body}}.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { snapshot } from "./machine_snapshot.mjs";

export async function bodies402(workerPath) {
  const lib = await import(pathToFileURL(resolve(workerPath, "..", "lib.js")).href);
  const norm = (s) => s.split(lib.VERSION).join("<VERSION>");
  const out = {};
  const snap = await snapshot(workerPath, (key, res, body) => { if (res.status === 402) out[key] = { status: 402, headers: Object.fromEntries([...res.headers.entries()].sort().map(([k, v]) => [k, norm(v)])), body: norm(body) }; });
  return { keys: Object.keys(snap).length, bodies: out };
}

if (process.argv[2]) process.stdout.write(JSON.stringify(await bodies402(process.argv[2]), null, 1) + "\n");
