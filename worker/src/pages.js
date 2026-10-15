// 0.37.1: small static HTML pages for /pricing and /docs, built from the real price constants (no KV, no I/O).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (atomic) => "$" + (Number(atomic) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
const page = (title, desc, origin, path, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(origin + path)}">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left;vertical-align:top}code{background:#f3f3f3;padding:0 .2rem}</style>
</head><body><p><a href="/">402xAgent</a></p>
${body}
</body></html>
`;

// p: { freePerDay, freePerIpDay, paidMinAtomic, paidMaxAtomic, routerPackAtomic, routerPackChecks, routerCheckAtomic, lookupFreePerDay, lookupAtomic, packAtomic, apiOrigin }
export function pricingHtml(origin, p) {
  const rows = [
    ["Free check", `$0: ${p.freePerDay} live checks per client per UTC day, at most ${p.freePerIpDay} per network (IP) per day across client names. Dry runs (<code>&amp;mode=dry-run</code>) are free.`],
    ["Paid check", `One tenth of the target endpoint's quoted x402 price, minimum ${usd(p.paidMinAtomic)}, maximum ${usd(p.paidMaxAtomic)} (no quote: ${usd(p.paidMinAtomic)}). Adds full payment terms and the payment object to sign.`],
    ["Router pack", `${usd(p.routerPackAtomic)} for ${p.routerPackChecks} checks (${usd(p.routerCheckAtomic)} each), paid as one x402 payment; for registered router clients.`],
    ["Catalog lookup (<code>/v1/lookup</code>)", `${p.lookupFreePerDay} free per client per UTC day, then ${usd(p.lookupAtomic)} per call; <code>/v1/lookup/paid</code> is always ${usd(p.lookupAtomic)}.`],
    ["Overnight chief-of-staff pack", `${usd(p.packAtomic)} (<code>/v1/products/overnight-cos-pack</code>).`],
    ["Free to read", `Skips, receipts, Bazaar check, badges, rules, OpenAPI, MCP.`],
  ];
  return page("Pricing · 402xAgent", "402xAgent prices: free checks, paid checks from $0.01, USDC on Base via x402.", origin, "/pricing", `<h1>Pricing</h1>
<p>All payments are USDC on Base via x402. No account, no key. Payment buys access only; it never changes a verdict.</p>
<table><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("")}</tbody></table>
<p>Check endpoint: <code>${esc(p.apiOrigin)}/v1/products/endpoint-spot-check?url=&lt;endpoint&gt;</code></p>
<p>Details: <a href="/rules">rules</a> · <a href="/openapi.json">OpenAPI spec</a> · <a href="/docs">docs</a></p>`);
}

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
<p>Quick start: <code>GET ${esc(apiOrigin)}/v1/products/endpoint-spot-check?url=&lt;endpoint&gt;&amp;mode=dry-run</code></p>`);
}
