import { signingInput } from "../../worker/src/sign.js";
// 0.45.2 production checks for /v1/discover (read-only GETs + one MCP call). Usage: node scripts/deploy/discover-prod-check.mjs [N=120]
const A = process.env.API || "https://api.402xagent.com", N = +(process.argv[2] || 120);
const keys = (await (await fetch(A + "/.well-known/402xagent-keys.json")).json()).keys;
const pub = {}; for (const k of keys) pub[k.kid] = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: k.x }, { name: "Ed25519" }, false, ["verify"]);
const verify = async (r) => { if (!r.signature || !pub[r.kid]) return false; const sig = Uint8Array.from(atob(r.signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)); return crypto.subtle.verify({ name: "Ed25519" }, pub[r.kid], sig, signingInput(r)); };
let ver = 0, tot = 0;
const get = async (q, ua) => { const t0 = performance.now(); const r = await fetch(A + "/v1/discover?" + q, { headers: { "user-agent": ua } }); const j = await r.json(); return { s: r.status, j, ms: performance.now() - t0 }; };
console.log("health", await (await fetch(A + "/health")).text().then((t) => t.replace(/\s+/g, "")));
for (const q of ["q=crypto%20price&verdict=pay&limit=5", "q=weather&limit=6"]) {
  const { s, j, ms } = await get(q, "prod-check-" + q);
  console.log(`\nGET /v1/discover?${q} -> ${s} (${ms.toFixed(0)} ms) count=${j.count} crawled=${j.index_last_crawled} stale=${j.index_stale} partial=${j.index_partial ?? false}`);
  for (const r of j.results) { const ok = await verify(r.receipt); tot++; ver += ok; console.log(`  ${r.verdict.padEnd(7)} ${String(r.verified_price_usd).padEnd(5)} ${r.endpoint.slice(0, 70)} | ${r.reason.slice(0, 60)} | sig ${ok ? "ok" : "FAIL"} ${r.receipt.crawl_run}`); }
}
for (const q of ["q=x", "verdict=maybe", "limit=abc", "foo=1"]) { const { s, j } = await get(q, "prod-bad"); console.log(`bad ${q} -> ${s} ${j.error}`); }
const m = await (await fetch(A + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "prod-mcp" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "discover", arguments: { q: "news", verdict: "skip", limit: 2 } } }) })).json();
const sc = m.result.structuredContent; console.log(`\nMCP discover -> isError=${m.result.isError ?? false} count=${sc.count}`);
for (const r of sc.results) { const ok = await verify(r.receipt); tot++; ver += ok; console.log(`  ${r.verdict} ${r.endpoint} | ${r.reason} | sig ${ok ? "ok" : "FAIL"}`); }
console.log(`\nreceipts verified: ${ver}/${tot}`);
// latency: N realistic queries, distinct UA each (stays light; first is likely cold on that colo/isolate)
const Q = ["q=crypto%20price&verdict=pay", "q=weather", "q=news&verdict=skip", "q=ai&limit=20", "verdict=pay&limit=20", "q=solana", "q=image%20generation", "q=defi%20tvl&verdict=recheck", "q=translate&verdict=pay", ""];
const t = [], st = {};
for (let i = 0; i < N; i++) { const { s, ms } = await get(Q[i % Q.length], "prod-lat-" + Date.now() + "-" + i); st[s] = (st[s] || 0) + 1; if (s === 200) t.push(ms); }
const raw = [...t]; t.sort((a, b) => a - b); const p = (x) => (t.length ? t[Math.min(t.length - 1, Math.floor(x * t.length))].toFixed(0) : "n/a");
console.log(`latency n=${N} statuses=${JSON.stringify(st)} p50=${p(0.5)} ms p95=${p(0.95)} ms max=${t.length ? t.at(-1).toFixed(0) : "n/a"} first=${raw.length ? raw[0].toFixed(0) : "n/a"} ms (client-side, from the box)`);
console.log(`receipts verified: ${ver}/${tot}`);
process.exit(ver === tot && !Object.keys(st).some((k) => k !== "200") ? 0 : 1);
