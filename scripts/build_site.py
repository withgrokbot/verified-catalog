#!/usr/bin/env python3
"""Build the static catalog site from data/services.json and results/.

Writes: index.html, methodology.html, services/<id>.html and .json, catalog.json, llms.txt,
.well-known/agent-card.json, .nojekyll. Pages load only local files (style.css); there is no
JavaScript and no request to any other host. Only factual results are published: no grades.
"""
import html
import json
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import x402_probe as xp  # noqa: E402

e = html.escape


def _load(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _history(site):
    hist = defaultdict(list)
    p = os.path.join(site, "results", "history.jsonl")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    hist[r.get("service_id")].append(r)
    return hist


def yn(v, none="n/a"):
    return none if v is None else ("yes" if v else "no")


def fmt_ts(ts):
    return ts.replace("T", " ").replace("Z", " UTC") if ts else "not checked yet"


def money(v):
    return f"${v}" if v not in (None, "") else "n/a"


def delivered_text(r):
    if not r or not r.get("paid"):
        return "not tested (no payment made)"
    return yn(r.get("delivered_valid"))


def charged_text(r):
    if not r or not r.get("paid"):
        return "not tested (no payment made)"
    return money(r.get("charged_price_usd")) if r.get("charged_price_usd") else "unknown"


def page(title, body, cfg, depth=0):
    up = "../" * depth
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<link rel="stylesheet" href="{up}style.css">
<link rel="alternate" type="application/json" href="{up}catalog.json" title="catalog.json">
</head>
<body>
<header>
  <p class="brand"><a href="{up}index.html">{e(cfg['title'])}</a> <span>by {e(cfg['brand'])}</span></p>
  <nav><a href="{up}index.html">Catalog</a> <a href="{up}methodology.html">Methodology</a> <a href="{up}methodology.html#contest">Contest a result</a> <a href="{up}catalog.json">catalog.json</a> <a href="{up}llms.txt">llms.txt</a> <a href="{up}.well-known/agent-card.json">agent card</a></nav>
</header>
<main>
{body}
</main>
<footer>
  <p>Information service only. We are not a party to any transaction and we never hold or move anyone's funds. Buyers pay sellers directly. Not investment advice.</p>
  <p>Results are automated checks at one moment in time and can be wrong. <a href="{up}methodology.html#contest">Contest a result</a>. Machine-readable: <a href="{up}catalog.json">catalog.json</a>.</p>
</footer>
</body>
</html>
"""


def result_rows(r, svc):
    rows = [
        ("Checked at", fmt_ts(r.get("checked_at")) if r else "not checked yet"),
        ("Check mode", (r or {}).get("mode", "n/a")),
        ("Reachable", yn((r or {}).get("reachable"))),
        ("HTTP status", str((r or {}).get("http_status") if (r or {}).get("http_status") is not None else "none")),
        ("Latency", f"{r['latency_ms']} ms" if r and r.get("latency_ms") is not None else "n/a"),
        ("Valid x402 challenge (HTTP 402 with payment terms)", yn((r or {}).get("x402_challenge"))),
        ("Advertised price (listing)", money(svc["advertised_price"]["amount_usd"]) + " USDC"),
        ("Price in the 402 challenge (Base USDC)", money((r or {}).get("quoted_price_usd"))),
        ("Challenge price matches listing", yn((r or {}).get("price_matches_listing"))),
        ("Charged price (paid check)", charged_text(r)),
        ("Delivered a valid response (paid check)", delivered_text(r)),
    ]
    if r and r.get("error"):
        rows.append(("Error", r["error"]))
    if r and r.get("payment_refused_reason"):
        rows.append(("Payment not made because", r["payment_refused_reason"]))
    return "\n".join(f"<tr><th scope=\"row\">{e(k)}</th><td>{e(str(v))}</td></tr>" for k, v in rows)


def build(site):
    site = os.path.abspath(site)
    cfg = _load(os.path.join(site, "data", "site.json"), {})
    data = _load(os.path.join(site, "data", "services.json"), {"services": [], "own_bots": []})
    latest = _load(os.path.join(site, "results", "latest.json"), {"results": []})
    by_id = {r["service_id"]: r for r in latest.get("results", [])}
    hist = _history(site)
    base = cfg["base_url"]
    contest = cfg["issues_url"] + "/new?template=contest-a-result.md"
    os.makedirs(os.path.join(site, "services"), exist_ok=True)
    os.makedirs(os.path.join(site, ".well-known"), exist_ok=True)

    # ---------------- catalog.json
    services_out = []
    for s in data["services"]:
        r = by_id.get(s["id"])
        h = hist.get(s["id"], [])
        latest_block = None
        if r:
            latest_block = {k: r.get(k) for k in (
                "checked_at", "mode", "reachable", "http_status", "latency_ms", "x402_challenge", "x402_version",
                "advertised_price_usd", "quoted_price_usd", "price_matches_listing", "paid", "charged_price_usd",
                "delivered_valid", "payment_refused_reason", "error")}
            latest_block["raw_log"] = r.get("raw_log")
            latest_block["raw_log_url"] = base + r["raw_log"] if r.get("raw_log") else None
        rec = dict(s)
        rec["page_url"] = base + f"services/{s['id']}.html"
        rec["latest"] = latest_block
        rec["history_summary"] = {
            "checks": len(h), "reachable": sum(1 for x in h if x.get("reachable")),
            "x402_challenge_ok": sum(1 for x in h if x.get("x402_challenge")),
            "paid_checks": sum(1 for x in h if x.get("paid")),
            "first_checked": h[0]["checked_at"] if h else None, "last_checked": h[-1]["checked_at"] if h else None}
        services_out.append(rec)
        with open(os.path.join(site, "services", f"{s['id']}.json"), "w", encoding="utf-8") as fh:
            json.dump(rec, fh, indent=2)
    catalog = {
        "schema": 1,
        "name": cfg["title"],
        "publisher": cfg["brand"],
        "url": base,
        "generated_at": latest.get("generated_at"),
        "last_run_id": latest.get("run_id"),
        "last_run_mode": latest.get("mode"),
        "methodology_url": base + "methodology.html",
        "contest_url": contest,
        "notes": "Factual check results only. No grades, scores or rankings. Each result is one automated check at one moment. "
                 "We hold no funds and are not a party to any transaction; buyers pay sellers directly.",
        "fields": {
            "latest.reachable": "an HTTP response arrived within the timeout",
            "latest.x402_challenge": "the unpaid request returned HTTP 402 with machine-readable payment terms",
            "latest.quoted_price_usd": "price of the Base USDC 'exact' option in that 402 challenge",
            "latest.price_matches_listing": "quoted price equals the advertised (listing) price",
            "latest.charged_price_usd": "amount we paid in a paid check; null when no payment was made",
            "latest.delivered_valid": "paid check returned 2xx with a non-empty, parseable body; null when no payment was made",
        },
        "services": services_out,
        "own_bots": data.get("own_bots", []),
    }
    with open(os.path.join(site, "catalog.json"), "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, indent=2)

    # ---------------- index.html
    summ = latest.get("summary") or {}
    rows = []
    for s in data["services"]:
        r = by_id.get(s["id"]) or {}
        rows.append(
            "<tr>"
            f"<td><a href=\"services/{e(s['id'])}.html\">{e(s['name'])}</a></td>"
            f"<td>{e(s['category'])}</td>"
            f"<td>{e(money(s['advertised_price']['amount_usd']))}</td>"
            f"<td>{e(money(r.get('quoted_price_usd')))}</td>"
            f"<td>{e(yn(r.get('price_matches_listing')))}</td>"
            f"<td>{e(yn(r.get('reachable')))}</td>"
            f"<td>{e(str(r.get('http_status') if r.get('http_status') is not None else 'none'))}</td>"
            f"<td>{e(str(r['latency_ms']) + ' ms' if r.get('latency_ms') is not None else 'n/a')}</td>"
            f"<td>{e(delivered_text(r))}</td>"
            f"<td>{e(fmt_ts(r.get('checked_at')))}</td>"
            + (f"<td><a href=\"{e(r['raw_log'])}\">raw log</a></td>" if r.get("raw_log") else "<td>none</td>")
            + "</tr>")
    own = "\n".join(f"<li><strong>{e(b['name'])}</strong>: {e(b['status'])}. {e(b.get('note', ''))}</li>" for b in data.get("own_bots", []))
    body = f"""
<h1>{e(cfg['title'])}</h1>
<p class="lede">A machine-readable list of pay-per-call services for AI agents (x402 endpoints), with the latest result of our own automated check for each one. We publish facts only: reachable or not, latency, advertised price versus the price the endpoint actually asks for, and, for paid checks, what we were charged and whether a valid response came back. No grades, no rankings.</p>
<p class="notice">Last run: {e(fmt_ts(latest.get('generated_at')))} ({e(latest.get('mode') or 'none')}). {e(str(summ.get('services_checked', 0)))} services checked, {e(str(summ.get('reachable', 0)))} reachable, {e(str(summ.get('x402_challenge_ok', 0)))} returned a valid x402 payment challenge, {e(str(summ.get('price_matches_listing', 0)))} asked the listed price. Paid checks made so far: {e(str(summ.get('paid_calls', 0)))}. See the <a href="methodology.html">methodology</a> for exactly what each column means.</p>
<div class="tablewrap">
<table id="catalog">
<caption>Third-party services and their latest check (times in UTC)</caption>
<thead><tr><th scope="col">Service</th><th scope="col">Category</th><th scope="col">Advertised price</th><th scope="col">Price in 402 challenge</th><th scope="col">Matches listing</th><th scope="col">Reachable</th><th scope="col">HTTP status</th><th scope="col">Latency</th><th scope="col">Valid paid response</th><th scope="col">Checked</th><th scope="col">Raw log</th></tr></thead>
<tbody>
{chr(10).join(rows)}
</tbody>
</table>
</div>
<h2 id="own-bots">Our own bots: coming soon</h2>
<p>These are the first sellers we plan to list from our own lab. None is live yet, so there are no links or prices.</p>
<ul>
{own}
</ul>
<h2>For agents</h2>
<p>Read <a href="catalog.json">catalog.json</a> (all services with their latest result), <a href="llms.txt">llms.txt</a>, or the <a href=".well-known/agent-card.json">agent card</a>. Each service also has its own JSON at <code>services/&lt;id&gt;.json</code>.</p>
<h2>Sellers</h2>
<p>Think a result is wrong? <a href="methodology.html#contest">Contest it</a> with a GitHub issue. We re-check and publish the raw log either way.</p>
"""
    with open(os.path.join(site, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(page(cfg["title"], body, cfg))

    # ---------------- per-service pages
    for s in data["services"]:
        r = by_id.get(s["id"])
        h = hist.get(s["id"], [])[-10:][::-1]
        hrows = "\n".join(
            f"<tr><td>{e(fmt_ts(x.get('checked_at')))}</td><td>{e(x.get('mode', ''))}</td><td>{e(yn(x.get('reachable')))}</td>"
            f"<td>{e(str(x.get('http_status')))}</td><td>{e(str(x.get('latency_ms')))} ms</td><td>{e(money(x.get('quoted_price_usd')))}</td>"
            f"<td>{e(delivered_text(x))}</td>"
            + (f"<td><a href=\"../{e(x['raw_log'])}\">raw log</a></td>" if x.get("raw_log") else "<td>none</td>") + "</tr>"
            for x in h) or "<tr><td colspan=\"8\">No checks yet.</td></tr>"
        opts = ", ".join(f"{o.get('scheme')} on {o.get('network')}: {money(o.get('amount_usd')) if o.get('amount_usd') else (o.get('amount_atomic') or '?') + ' units of ' + str(o.get('asset'))}"
                         for o in (r or {}).get("payment_options", [])) or "none seen"
        raw_link = f"<a href=\"../{e(r['raw_log'])}\">raw log for this check</a>" if r and r.get("raw_log") else "no raw log yet"
        body = f"""
<p><a href="../index.html">&larr; All services</a></p>
<h1>{e(s['name'])}</h1>
<p class="meta">Provider domain: {e(s['provider'])}. Category: {e(s['category'])}. Protocol: {e(s['protocol'])} (version {e(str(s.get('x402_version')))}).</p>
<p>Endpoint: <code>{e(s['endpoint'])}</code></p>
<p>Seller's description (as listed, not verified by us): <q>{e(s.get('description', ''))}</q></p>
<p>Listing source: <a href="{e(s['source']['url'])}">{e(s['source']['name'])}</a>, retrieved {e(s['source']['retrieved'])} (listing last updated {e(fmt_ts(s['source'].get('listing_last_updated')))}).</p>
<h2>Latest check</h2>
<table class="kv">
{result_rows(r, s)}
</table>
<p>Payment options seen in the 402 challenge: {e(opts)}.</p>
<p>Evidence: {raw_link}. Machine-readable: <a href="{e(s['id'])}.json">{e(s['id'])}.json</a>.</p>
<h2>Recent checks</h2>
<div class="tablewrap"><table>
<thead><tr><th scope="col">Checked</th><th scope="col">Mode</th><th scope="col">Reachable</th><th scope="col">HTTP status</th><th scope="col">Latency</th><th scope="col">402 price</th><th scope="col">Valid paid response</th><th scope="col">Log</th></tr></thead>
<tbody>
{hrows}
</tbody></table></div>
<h2>Is this wrong?</h2>
<p>If you run this service and think a result is wrong, <a href="{e(contest)}">open a GitHub issue</a> (see <a href="../methodology.html#contest">how contests work</a>).</p>
"""
        with open(os.path.join(site, "services", f"{s['id']}.html"), "w", encoding="utf-8") as fh:
            fh.write(page(f"{s['name']} | {cfg['title']}", body, cfg, depth=1))

    # ---------------- methodology.html
    caps = {"per_call": xp.usd_str(xp.HARD_PER_CALL_USD), "per_day": xp.usd_str(xp.HARD_PER_DAY_USD),
            "lifetime": xp.usd_str(xp.HARD_LIFETIME_USD)}
    body = f"""
<h1>Methodology</h1>
<p>This page explains exactly what we check, what we publish, and how to contest a result. Checker version {e(xp.CHECKER_VERSION)}. Schedule: {e(cfg.get('check_schedule_utc', 'daily'))}.</p>
<h2 id="what">What we publish</h2>
<p>For each service, only factual results of our own checks, each with a timestamp (UTC) and a link to the raw log:</p>
<ul>
<li><strong>Reachable</strong>: an HTTP response arrived within 20 seconds (any status code).</li>
<li><strong>HTTP status</strong> and <strong>latency</strong>: the status code and the time from sending the request to receiving the full response (up to 256 KB), measured once from a GitHub-hosted runner or our own machine.</li>
<li><strong>Valid x402 challenge</strong>: the unpaid request returned HTTP 402 with payment terms we could read, either from the <code>PAYMENT-REQUIRED</code> header (x402 v2) or from the JSON body (x402 v1).</li>
<li><strong>Advertised price</strong>: the price in the public listing where we found the service (the source is linked on each service page).</li>
<li><strong>Price in the 402 challenge</strong>: the amount the endpoint itself asks for, using the USDC "exact" option on Base. <strong>Matches listing</strong> compares the two.</li>
<li><strong>Charged price</strong> and <strong>delivered a valid response</strong>: only for paid checks. Charged price is the amount we signed and the endpoint accepted. A valid response means HTTP 2xx with a non-empty body that parses as JSON when it says it is JSON. When the latest check made no payment, these read "not tested (no payment made)".</li>
</ul>
<p>We do not publish grades, scores, rankings, or labels such as "good" or "bad". A single failed check can be a temporary network problem on either side, so read results over time (each service page shows recent history).</p>
<h2 id="free">The free check</h2>
<p>One request per service, using the sample request from the public listing (method, query or body). No payment is made. We record the response and parse the payment challenge. Requests identify themselves with the user agent <code>{e(xp.USER_AGENT)}</code>, and redirects are not followed.</p>
<h2 id="paid">The paid check</h2>
<p>Paid checks are off by default and never run in the daily job. We start them by hand, on our own machine, from time to time. When run, the checker pays like any other customer: it signs a USDC transfer authorization (EIP-3009) for the price in the 402 challenge (only if it equals the listed price), sends it, and records the response and the settlement transaction if the endpoint returns one. It signs only for USDC on Base, only with the "exact" scheme, and never for other tokens or networks.</p>
<p>Hard spend caps, checked before anything is signed: at most ${e(caps['per_call'])} per call, ${e(caps['per_day'])} per UTC day, and ${e(caps['lifetime'])} in total, ever. Every attempt counts toward the caps, even if the endpoint fails. The spend ledger is public at <a href="results/spend_ledger.json">results/spend_ledger.json</a>.</p>
<h2 id="money">Money</h2>
<p>We never hold, receive, split or forward anyone else's funds. Buyers pay sellers directly. The only money we spend is our own, on our own checks, under the caps above.</p>
<h2 id="raw">Raw logs</h2>
<p>Every check writes a raw log (JSON) with the request, the status, selected headers (the payment challenge decoded), a hash of the body, and the first 4 KB of the body. Response text from services is untrusted: we store it as data, never render it as a web page, and redact email addresses and a few local-path-like strings (the body hash covers the full, unredacted body).</p>
<h2 id="sources">Where the listings come from</h2>
<p>Services are taken from public directories of x402 endpoints (currently the public CDP x402 Bazaar discovery API). We record the source and the date we read it. We did not invent any listing. Listing text (names, descriptions) is the seller's own, not verified by us.</p>
<h2 id="contest">Contest a result</h2>
<p>If you run a listed service and think a result is wrong, or you want your service removed or added:</p>
<ol>
<li><a href="{e(contest)}">Open a GitHub issue</a> on our public repository (<a href="{e(cfg['issues_url'])}">all issues</a>). Include the service id (from the URL of its page), the check time you disagree with, and what you expected.</li>
<li>We re-run the check, publish the new raw log, and reply on the issue with what we found.</li>
<li>If our check was wrong (for example, a bug in the checker or a bad sample request), we correct the record and say so on the issue. We do not remove accurate results, but you can always add context on the issue.</li>
</ol>
<h2 id="limits">Limits</h2>
<ul>
<li>One request per service per run, from one location. Latency depends on where we check from.</li>
<li>"Reachable" does not mean the service works. A free check only shows that the endpoint answers and what it asks to be paid; only a paid check shows whether it delivers.</li>
<li>The sample request comes from the listing. If it is out of date, the endpoint may answer with an error that a real customer would not see.</li>
</ul>
"""
    with open(os.path.join(site, "methodology.html"), "w", encoding="utf-8") as fh:
        fh.write(page(f"Methodology | {cfg['title']}", body, cfg))

    # ---------------- llms.txt
    lines = [f"# {cfg['title']}", "",
             f"> Machine-readable catalog of pay-per-call (x402) services for AI agents, with factual results of our own automated checks. Published by {cfg['brand']}. No grades or rankings. We hold no funds; buyers pay sellers directly.",
             "", "## Data", "",
             f"- [catalog.json]({base}catalog.json): every service with endpoint, advertised price, source, and the latest check (reachable, latency, 402 price, charged price, delivered_valid, checked_at, raw log)",
             f"- [agent card]({base}.well-known/agent-card.json): what this catalog offers to agents",
             f"- [methodology]({base}methodology.html): what each field means and how to contest a result",
             f"- Per service: {base}services/<id>.json", "", "## Services", ""]
    for s in data["services"]:
        r = by_id.get(s["id"]) or {}
        lines.append(f"- [{s['name']}]({base}services/{s['id']}.json): {s['category']}; advertised ${s['advertised_price']['amount_usd']} USDC; "
                     f"last check {fmt_ts(r.get('checked_at'))}: reachable {yn(r.get('reachable'))}, 402 price {money(r.get('quoted_price_usd'))}")
    lines += ["", "## Our own bots", ""] + [f"- {b['name']}: {b['status']}" for b in data.get("own_bots", [])]
    lines += ["", "## Contest a result", "", f"- Open a GitHub issue: {cfg['issues_url']}", ""]
    with open(os.path.join(site, "llms.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    # ---------------- agent card
    card = {
        "name": cfg["title"],
        "description": "Static, machine-readable catalog of pay-per-call (x402) agent services with factual results of automated checks "
                       "(reachability, latency, advertised vs quoted vs charged price, valid response). No grades. No funds held.",
        "url": base,
        "version": "0.1.0",
        "provider": {"organization": cfg["brand"], "url": cfg["repo_url"]},
        "documentationUrl": base + "methodology.html",
        "catalog": base + "catalog.json",
        "llms_txt": base + "llms.txt",
        "capabilities": {"streaming": False, "pushNotifications": False},
        "defaultInputModes": ["application/json"],
        "defaultOutputModes": ["application/json"],
        "skills": [
            {"id": "search_catalog", "name": "Search the catalog",
             "description": "Filter services by text, category, maximum advertised price, or reachable in the last check. Read catalog.json (static) or use the MCP server in the repository.",
             "tags": ["x402", "catalog", "discovery"], "examples": ["web search under $0.01 that was reachable today"]},
            {"id": "get_service", "name": "Get one service",
             "description": "Full record for one service id, including the latest check and a raw log link.",
             "tags": ["x402", "catalog"], "examples": ["otto-crypto-news"]},
        ],
        "contest": cfg["issues_url"],
    }
    with open(os.path.join(site, ".well-known", "agent-card.json"), "w", encoding="utf-8") as fh:
        json.dump(card, fh, indent=2)
    open(os.path.join(site, ".nojekyll"), "w").close()
    return catalog


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(HERE))
    print("built")
