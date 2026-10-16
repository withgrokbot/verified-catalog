// 0.37.1: small static HTML pages for /pricing and /docs, built from the real price constants (no KV, no I/O).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (atomic) => "$" + (Number(atomic) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "").replace(/(\.\d)$/, "$10"); // $0.20, $9, $0.001
const page = (title, desc, origin, path, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(origin + path)}">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left;vertical-align:top}code{background:#f3f3f3;padding:0 .2rem}</style>
</head><body><p><a href="/">402xAgent</a></p>
${body}
</body></html>
`;

// p: { freePerDay, freePerIpDay, paidAtomic, routerPackAtomic, routerPackChecks, routerCheckAtomic, lookupFreePerDay, lookupAtomic, packAtomic, apiOrigin }
export function pricingHtml(origin, p) {
  const rows = [
    ["Free check", `$0: ${p.freePerDay} live checks per client per UTC day, at most ${p.freePerIpDay} per network (IP) per day across client names. Dry runs (<code>&amp;mode=dry-run</code>) are free.`],
    ["Paid check", `${usd(p.paidAtomic)} per check, flat, whatever the target endpoint charges. Adds full payment terms and the payment object to sign.`],
    ["Router pack", `${usd(p.routerPackAtomic)} for ${p.routerPackChecks} checks (${usd(p.routerCheckAtomic)} each), paid as one x402 payment; for registered router clients.`],
    ["Catalog lookup (<code>/v1/lookup</code>)", `${p.lookupFreePerDay} free per client per UTC day, then ${usd(p.lookupAtomic)} per call; <code>/v1/lookup/paid</code> is always ${usd(p.lookupAtomic)}.`],
    ["Overnight chief-of-staff pack", `${usd(p.packAtomic)} (<code>/v1/products/overnight-cos-pack</code>).`],
    ["Free to read", `Skips, receipts, Bazaar check, badges, rules, OpenAPI, MCP.`],
  ];
  return page("Pricing · 402xAgent", "402xAgent prices: free checks, paid checks $0.02, USDC on Base via x402.", origin, "/pricing", `<h1>Pricing</h1>
<p>All payments are USDC on Base via x402. No account, no key. Payment buys access only; it never changes a verdict.</p>
<table><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("")}</tbody></table>
<p>Check endpoint: <code>${esc(p.apiOrigin)}/v1/products/endpoint-spot-check?url=&lt;endpoint&gt;</code></p>
<p>Details: <a href="/rules">rules</a> · <a href="/openapi.json">OpenAPI spec</a> · <a href="/docs">docs</a></p>`);
}

export const VERIFY_SNIPPET = `import { createPublicKey, verify } from "node:crypto";
const jcs = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? "[" + v.map(jcs).join(",") + "]"
  : "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}";
const receipt = await (await fetch("https://402xagent.com/v1/receipts/sc-...")).json();
const { keys } = await (await fetch("https://api.402xagent.com/.well-known/402xagent-keys.json")).json(); // or a saved copy
const jwk = keys.find((k) => k.kid === receipt.kid);
const { signature, ...signed } = receipt;
const ok = verify(null, Buffer.from(jcs(signed)), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }), Buffer.from(signature, "base64url"));
console.log(ok ? "valid" : "INVALID");`;
export function docsHtml(origin, apiOrigin) {
  const links = [
    ["/openapi.json", "OpenAPI spec", "every route, parameter and price"],
    ["/rules", "Rules", "verdicts, reason codes and confidence (JSON: /rules.json)"],
    ["/llms.txt", "llms.txt", "plain-text overview for agents"],
    ["/pricing", "Pricing", "free and paid tiers"],
    ["/v1/receipts", "Receipts", "public check receipts"],
    ["/v1/skips", "Skips", "endpoints that disagree with their listing"],
  ];
  return page("Docs · 402xAgent", "402xAgent API docs: OpenAPI, rules, llms.txt, MCP and the x402-spotcheck client guard.", origin, "/docs", `<h1>Docs</h1>
<p>402xAgent checks an x402 endpoint right before your agent pays: pay, skip or recheck.</p>
<ul>${links.map(([h, t, d]) => `<li><a href="${h}">${t}</a>: ${esc(d)}</li>`).join("")}
<li>MCP: <code>POST ${esc(apiOrigin)}/mcp</code> (JSON-RPC, tools listed by <code>tools/list</code>)</li>
<li>Client guard for @x402/fetch and @x402/axios: <a href="https://github.com/withgrokbot/x402-spotcheck">github.com/withgrokbot/x402-spotcheck</a></li></ul>
<h2 id="quick-start">Quick start</h2>
<p>Free check, no signup: <code>GET ${esc(apiOrigin)}/v1/products/endpoint-spot-check?url=&lt;endpoint&gt;&amp;mode=dry-run</code></p>
<h2 id="receipt-signatures">Receipt signatures</h2>
<p>New receipts (<code>/v1/receipts/&lt;id&gt;</code>) carry <code>kid</code> and <code>signature</code>: ed25519 (base64url, 64 bytes) over the RFC 8785 (JCS) canonical JSON of the receipt with only <code>signature</code> removed. Public keys: <a href="/.well-known/402xagent-keys.json">/.well-known/402xagent-keys.json</a> (match <code>kid</code>). Older receipts are unsigned. A signature proves 402xAgent issued the receipt; it does not change the verdict.</p>
<p>Offline, with <code>x402-spotcheck</code> 1.1.0+: <code>await verifyReceipt(receipt, { publicKey })</code>. Or with Node 20+ and no dependencies:</p>
<pre><code>${esc(VERIFY_SNIPPET)}</code></pre>`);
}

// 0.39.0: /blog (list) and /blog/<slug>, rendered at build time from content/blog (scripts/build_blog.mjs).
const BLOG_CSS = `<style>article{margin-top:1rem}article h1{font-size:1.7rem;line-height:1.25}pre{background:#f3f3f3;padding:.6rem;overflow:auto}pre code{background:none;padding:0}td.r,th.r{text-align:right}blockquote{border-left:3px solid #ddd;margin:0;padding-left:1rem;color:#444}.meta{color:#555;font-size:.9rem}</style>`;
const fmtDate = (d) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
export function blogListHtml(origin, posts) {
  return page("Blog · 402xAgent", "Notes from 402xAgent: what x402 agents almost paid for, and how the pre-payment check works.", origin, "/blog", `${BLOG_CSS}<h1>Blog</h1>
<ul>${posts.map((p) => `<li><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a> <span class="meta">· ${esc(fmtDate(p.date))}</span><br><span class="meta">${esc(p.description)}</span></li>`).join("")}</ul>
<p><a href="/docs#quick-start">Quick start</a> · <a href="/pricing">Pricing</a></p>`);
}
export function blogPostHtml(origin, p) {
  return page(p.title + " · 402xAgent", p.description, origin, "/blog/" + p.slug, `${BLOG_CSS}<p class="meta"><a href="/blog">Blog</a> · ${esc(fmtDate(p.date))}</p>
<article>
${p.html}
</article>
<p><a href="/blog">← All posts</a> · <a href="/docs#quick-start">Run a free check</a></p>`);
}
