// 0.37.1: small static HTML pages for /pricing and /docs, built from the real price constants (no KV, no I/O).
import { docsTryItHtml } from "./tryit.js"; // 0.57.1: the free Try-it box on /docs (one new section; the rest of /docs is unchanged)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (atomic) => "$" + (Number(atomic) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "").replace(/(\.\d)$/, "$10"); // $0.20, $9, $0.001
const page = (title, desc, origin, path, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(origin + path)}">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left;vertical-align:top}code{background:#f3f3f3;padding:0 .2rem}</style>
</head><body><p><a href="/">402xAgent</a> · <a href="/pricing">Pricing</a> · <a href="/docs">Docs</a> · <a href="/blog">Blog</a></p>
${body}
</body></html>
`;

// 0.58.3: /pricing is the pricing table in pricing.js (homepage look, strict CSP); re-exported here for existing imports.
export { pricingHtml } from "./pricing.js";

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
export function docsHtml(origin, apiOrigin, opts = {}) {
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
<p>Checks read target terms on Base and Solana; paying 402xAgent itself is USDC on Base only.</p>
<ul>${links.map(([h, t, d]) => `<li><a href="${h}">${t}</a>: ${esc(d)}</li>`).join("")}
<li>MCP: <code>POST ${esc(apiOrigin)}/mcp</code> (JSON-RPC, tools listed by <code>tools/list</code>)</li>
<li>Client guard for @x402/fetch and @x402/axios: <a href="https://github.com/withgrokbot/x402-spotcheck">github.com/withgrokbot/x402-spotcheck</a></li></ul>
${opts.tryIt === false ? "" : docsTryItHtml(opts.tryIt || {})}<h2 id="quick-start">Quick start</h2>
<p>Free check, no signup: <code>GET ${esc(apiOrigin)}/v1/products/endpoint-spot-check?url=&lt;endpoint&gt;&amp;mode=dry-run</code></p>
<h2 id="endpoint-report">Endpoint report ($0.05): what the locked teasers hide</h2>
<p>${opts.endpointReport ? "Live." : "Rolling out: the route answers 404 until it is switched on; the free teasers and commitments below are already live."} Every free check answer carries a <code>locked</code> block with two teasers: <b>drift</b> (for example "2 changes in 30d": a count only, never which terms or when) and <b>hygiene</b> (a grade: A = quality_ok, C = bad content type, D = schema mismatch, F = bad status or unreachable, "–" plus a reason when there is nothing to validate). Next to it, <code>locked_commitments</code> holds one <code>sha256:</code> digest per locked item (<code>drift_history</code>, <code>hygiene_detail</code>) and a <code>ref</code> (cm-…), valid for 30 days.</p>
<p>Buy the report: <code>POST ${esc(apiOrigin)}/v1/products/endpoint-report</code> with JSON <code>{"url":"https://api.402rates.com/v1/ping","commitment_ref":"cm-0123456789abcdef"}</code> and an x402 payment of $0.05 USDC on Base (no free tier; the same price for everyone). The signed <code>er-</code> receipt reveals exactly the committed snapshots (which terms changed, when, from what to what; the full hygiene checks) with their nonces. Add <code>"include_current": true</code> to also get today's stored data under <code>current</code>, which the commitment does not cover. Without a <code>commitment_ref</code> the report commits and reveals in one step.</p>
<h3 id="endpoint-report-verify">Verify a report</h3>
<ol><li>Keep <code>locked_commitments</code> from your free check.</li>
<li>For each key k: compute <code>"sha256:" + hex(sha256(JCS({snapshot: revealed[k].snapshot, nonce: revealed[k].nonce})))</code> (RFC 8785 canonical JSON; the nonce is 32 bytes hex).</li>
<li>It must equal <code>locked_commitments[k]</code>. A changed snapshot, a different nonce or newer data gives a different digest.</li>
<li>Verify the receipt's ed25519 signature with the kid in <a href="/.well-known/402xagent-keys.json">/.well-known/402xagent-keys.json</a> (see receipt signatures below).</li></ol>
<p>Public views of every receipt (sc-, ps-, er-) never show buyer wallets, payment payloads, nonces of your payment, settle transactions or client IPs.</p>
${opts.watchtower ? `<h2 id="watchtower">Watchtower ($1 per 30 days)</h2>
<p>Watch one x402 endpoint: <code>POST ${esc(apiOrigin)}/v1/watch</code> with JSON <code>{"url":"https://api.402rates.com/v1/ping","method":"GET","webhook_url":"https://hooks.example.com/402x"}</code>. The first watch per webhook domain gets a 7-day free trial (shared relay hosts such as webhook.site or hooks.slack.com count per full URL); otherwise pay $1 USDC via x402. We probe the endpoint once for a baseline and send a signed <code>watch.verify</code> event that must get a 2xx within 5 s; nothing is charged if either fails. The answer carries <code>watch_secret</code> once.</p>
<p>Every hour we re-probe. Events: <code>drift</code> (payTo, network, asset, price &gt; 1 %, x402 version, schemes or paywall changed, seen on 2 probes in a row), <code>down</code> and <code>recovery</code> (2 probes in a row), <code>flapping</code>, <code>paused</code>, <code>resumed</code>. Each webhook POST carries <code>X-402x-Signature</code> (Ed25519, base64url) over <code>timestamp + "." + body</code>, <code>X-402x-Kid</code>, <code>X-402x-Timestamp</code> and <code>X-402x-Event-Id</code>; verify with <a href="${esc(apiOrigin)}/.well-known/402xagent-keys.json">the keys doc</a> and reject a skew over 5 minutes. Retries: 1 m, 5 m, 30 m, 2 h, 6 h with the same event id. After 3 days on which every delivery failed, the watch pauses; a 2xx <code>POST /v1/watch/wt-0123456789abcdef/verify</code> (Bearer) or a renew resumes it.</p>
<p>Renew: <code>POST ${esc(apiOrigin)}/v1/watch/wt-0123456789abcdef/renew</code> with $1 adds 30 days. Status: <code>GET ${esc(apiOrigin)}/v1/watch/wt-0123456789abcdef</code> with <code>Authorization: Bearer wts_...</code>. On expiry a watch pauses, it is never deleted. We never store payer wallets or transaction hashes.</p>` : ""}
<h2 id="payment-status">After you pay: payment status</h2>
<p>Your paid call timed out, or came back 5xx or an empty 402. Did the money move? <code>POST https://api.402xagent.com/v1/products/payment-status</code> with JSON <code>{"payment_payload":"&lt;base64 PAYMENT-SIGNATURE you sent&gt;","seller_url":"&lt;url you paid&gt;"}</code> (or <code>tx_hash</code>, or <code>from</code> + <code>nonce</code> + <code>valid_before</code>). Base USDC (EIP-3009 exact) only for now.</p>
<ul><li><b>status</b>: landed (on-chain, 10+ confirmations), not_landed, pending (could still land, or too few confirmations), canceled, unknown.</li>
<li><b>safe_to_retry_same_payload</b>: always true. An EIP-3009 nonce is single-use, so resending the same signed payment can never charge twice.</li>
<li><b>safe_to_resign</b>: true only when two independent RPC sources agree the nonce is unused <i>and</i> the chain is past validBefore + 120 s. Any doubt, disagreement, single source or error means false: don't sign a new payment yet (see <code>wait_until</code>).</li>
<li>Also: the tx (amount, payTo, block, confirmations), a match against the seller's 402 terms, who to claim from and with what evidence, and what we can't know (delivery, seller state, facilitator internals, reorgs).</li>
<li>Every answer carries a signed copy in <code>receipt</code> (same keys as below). Same price as the check, $0.02, and the same 5 free per day. A bare request returns the x402 402. In x402-spotcheck 1.2.0: <code>afterPay()</code> or <code>spotCheckFetch(fetch, { afterPay: true })</code>.</li></ul>
<h3 id="payment-status-example">Worked example: a paid call that timed out but settled (402rates-ping, Oct 16, 2026)</h3>
<p>A real case from our own client. Facts only; times are Pacific (UTC-7).</p>
<ul><li><b>10:49:28</b>: the seller's 402 asked $0.001 (amount <code>1000</code>, USDC on Base) to payTo <code>0xf567…cb98</code>, <code>maxTimeoutSeconds</code> 300. The client signed and sent the paid retry.</li>
<li><b>~10:49:48</b>: the client gave up after 20,359 ms. No response body was delivered.</li>
<li><b>10:51:19</b>: the authorization settled on-chain in block 52691866 (tx <code>0x2b4cc694…13ee</code>, from <code>0x37cf…8674</code> (our payTo; <a href="https://agenteconomy.report/api/claim/api.402xagent.com" rel="noopener">Verified owner</a>), relayer <code>0xa32c…d101</code>).</li>
<li><b>11:12:28</b>: one free payment-status check with <code>tx_hash</code>, <code>from</code>, <code>nonce</code> and <code>seller_url</code> (no payload needed when you have these).</li></ul>
<p>Answer: <b>status</b> <code>landed</code> (reason <code>settled_onchain</code>, 634 confirmations), amount and payTo match the seller's 402 terms, two RPC sources (Alchemy and Infura) agreed, <b>safe_to_resign</b> <code>false</code>. So: don't sign a new payment; the money moved, and the next step is to ask the seller for the response or a refund, using the tx as evidence. Signed receipt: <a href="https://402xagent.com/v1/receipts/ps-65a4fdffae01d2b6">https://402xagent.com/v1/receipts/ps-65a4fdffae01d2b6</a>.</p>
<h2 id="facilitator-check">Facilitator pre-settle check (free)</h2>
<p>For a facilitator's <code>onBeforeSettle</code> hook: <code>POST ${esc(apiOrigin)}/v1/facilitator/check</code> with JSON <code>{"paymentRequirements":{"scheme":"exact","network":"eip155:8453","amount":"1000","asset":"0x8335…2913","payTo":"0x…"},"url":"https://seller.example/api"}</code> (the url may also come from <code>resource</code> or <code>paymentRequirements.resource</code>). We re-read the seller's live 402 terms for that resource with the same unpaid probe as the check (private, loopback and link-local addresses blocked on every redirect, 8 s timeout, 64 KB cap; never pays) and compare scheme, network (CAIP-2), amount, asset and payTo (EVM addresses case-insensitive).</p>
<p>Answer: <code>{match, mismatches:[{field, expected, live}], live_terms_sha256, checked_at, recommendation}</code>. <code>recommendation</code> is <code>settle</code> only when one live accepts entry matches every field; anything else is <code>hold</code>, including 400 (bad input or blocked url), 429 (60 per minute per caller IP, or 30 probes per minute per seller host across all callers; nothing is probed then), 502 (seller unreachable), 503 (busy, or our rate limiter is unavailable; we then probe nothing) and 504 (seller timed out). <code>live_terms_sha256</code> = sha256 of <code>network|asset|amount|payTo</code>, the same formula as <code>payment_terms_sha256</code>. Free for now; it does not use the check's 5 free per day. Send only the requirements: a payment payload is ignored, never stored and never echoed, and nothing about the payer is logged.</p>
<h2 id="expiry-check">Expiry check (opt-in)</h2>
<p>Add <code>&amp;check_expiry=1</code> to <code>endpoint-spot-check</code> (optional <code>&amp;skew_s=</code> 0 to 300, default 30). If the check would say <code>pay</code> but every Base USDC option in the live 402 is already expired, or expires within <code>skew_s</code> (<code>extra.validBefore</code>, <code>expiresAt</code>, <code>expiry</code> or <code>deadline</code>; or <code>maxTimeoutSeconds</code> of 5 or less), the verdict is <code>skip</code> with reason <code>challenge_expired</code>, and the answer and receipt carry an <code>expiry_check</code> block. Without the parameter nothing changes. In x402-spotcheck 1.4.0: <code>{ checkExpiry: true }</code>.</p>
<h2 id="hosted">Hosted mode (integrator keys)</h2>
<p>For routers and wallets that run checks for many agents. Opt in by asking us for a key, then send <code>Authorization: Bearer 402x_live_&lt;id&gt;_&lt;secret&gt;</code> (or <code>x-402xagent-key</code>) on the check or on payment status. Optionally add <code>x-402xagent-end-user: &lt;your opaque agent id&gt;</code>; we store only a salted hash of it.</p>
<ul><li>Price: 1,000 free hosted checks per integrator (lifetime), then $0.02 per check; each billable check after the first 1,000 in a UTC calendar month is $0.01. Cached answers count. Billed on a monthly USDC invoice on Base, not per call.</li>
<li>With a key there is no daily free counter and no x402 per call; a payment header is ignored. Credit limit $20 until the first invoice is paid, then $100; over it, calls fall back to the normal free tier + x402 (response header <code>x-402xagent-hosted: fallback: credit_limit</code>).</li>
<li>Answers are the full (paid-shape) answer. Receipts are signed and show <code>tier</code>/<code>access_tier</code> <code>hosted</code> with a <code>hosted</code> block: integrator id, end-user hash, <code>price_atomic</code>, <code>band</code> (free_allowance, standard, volume), month and <code>billed_on: invoice</code>.</li>
<li>Your meter: <code>GET /v1/integrators/me</code> with the same key. A bad, suspended or revoked key gets 401 (never a silent free check); 120 checks per minute per key.</li>
<li>Requests without a key are unchanged. In x402-spotcheck 1.3.0: <code>spotCheckFetch(fetch, { mode: "service", apiKey })</code>.</li></ul>
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
