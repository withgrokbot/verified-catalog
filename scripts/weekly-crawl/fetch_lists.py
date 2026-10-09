"""Download every public x402 list we can read without a login, payment or terms breach, into OUT_DIR.
Writes OUT_DIR/sources.json = per-source status. Polite: one request at a time per source, small sleeps.
Never sends payment headers. Usage: python3 fetch_lists.py OUT_DIR"""
import json, os, sys, time, re
import requests
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from crawl_probe import ssrf_check  # same SSRF gate as the crawl

OUT = sys.argv[1]
UA = {"user-agent": "verified-catalog-spotcheck (weekly x402 list refresh; never pays; github.com/withgrokbot/verified-catalog)",
      "accept": "application/json, text/plain, */*"}
S = requests.Session(); S.headers.update(UA)
status = {}

def get(url, **kw):
    for t in range(4):
        try:
            r = S.get(url, timeout=90, **kw)
            if r.status_code == 200: return r
            if r.status_code in (401, 402, 403): return r  # login / paid / forbidden: do not retry, do not pay
        except requests.RequestException:
            pass
        time.sleep(3 * (t + 1))
    return None

def save(name, obj): json.dump(obj, open(os.path.join(OUT, name), "w"))

def bazaar(name, base):
    off, total, n = 0, None, 0
    while total is None or off < total:
        r = get(base, params={"limit": 1000, "offset": off})
        if r is None or r.status_code != 200: raise RuntimeError(f"HTTP {getattr(r, 'status_code', 'error')} at offset {off}")
        j = r.json(); total = j["pagination"]["total"]; items = j.get("items", [])
        save(f"{name}_{off}.json", j); n += len(items)
        if not items: break
        off += 1000; time.sleep(1)
    return {"items": n, "listed_total": total}

def source(name, fn, note):
    try:
        status[name] = {"ok": True, "note": note, **fn()}
    except Exception as e:
        status[name] = {"ok": False, "note": note, "error": str(e)[:200]}
    print(name, json.dumps(status[name]), flush=True)

source("payai-bazaar", lambda: bazaar("payai", "https://facilitator.payai.network/discovery/resources"), "PayAI facilitator Bazaar discovery API (public JSON)")
source("cdp-bazaar", lambda: bazaar("cdp", "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"), "Coinbase CDP Bazaar discovery API (public JSON)")

def awesome():
    r = get("https://raw.githubusercontent.com/xpaysh/awesome-x402/main/README.md")
    open(os.path.join(OUT, "awesome.md"), "w").write(r.text); return {"bytes": len(r.text)}
source("awesome-x402", awesome, "xpaysh/awesome-x402 README (public GitHub)")

def agent402():
    j = get("https://agent402.tools/.well-known/x402").json(); save("agent402.json", j)
    return {"items": len(j.get("resources") or [])}
source("agent402", agent402, "agent402.tools /.well-known/x402 (public discovery doc)")

def payapi():
    j = get("https://payapi.market/agent/list", params={"verified_only": "false", "limit": 1000}).json(); save("payapi.json", j)
    return {"items": len(j.get("results") or [])}
source("payapi-market", payapi, "payapi.market /agent/list (public agent discovery API; robots welcomes agents)")

def agenttools():
    # The search API caps offset at 1000, so page each category with two sort orders (default, newest); dedupe by id.
    cats = [c["category"] for c in (get("https://agent-tools.cloud/api/v1/categories").json().get("categories") or []) if c.get("category")]
    seen = {}
    for params in [{}] + [{"category": c, "sort": srt} for c in cats for srt in ("default", "newest")]:
        off = 0
        while off <= 1000:
            r = get("https://agent-tools.cloud/api/v1/search", params={"limit": 100, "offset": off, **params})
            s = (r.json().get("services") if r is not None and r.status_code == 200 else None) or []
            for x in s: seen.setdefault(x.get("id"), x)
            time.sleep(0.4)
            if len(s) < 100: break
            off += 100
    out = list(seen.values())
    save("agenttools.json", out)
    return {"items": len(out), "categories": len(cats), "resource_urls": sum(1 + len(x.get("resource_samples") or []) for x in out)}
source("agent-tools-cloud", agenttools, "agent-tools.cloud /api/v1/search (public JSON; robots allows all but /auth/)")

def x402org():
    # x402.org/ecosystem is built from coinbase/x402 typescript/site/app/ecosystem/partners-data/*/metadata.json.
    # Partners list websites, not endpoints, so we read each website's own /.well-known/x402 discovery doc.
    tree = get("https://api.github.com/repos/coinbase/x402/git/trees/main?recursive=1").json()["tree"]
    metas = [t["path"] for t in tree if re.match(r"typescript/site/app/ecosystem/partners-data/[^/]+/metadata\.json$", t["path"])]
    sites, found = [], []
    for p in metas:
        r = get("https://raw.githubusercontent.com/coinbase/x402/main/" + p)
        try: m = r.json()
        except Exception: continue
        w = str(m.get("websiteUrl") or "").strip().rstrip("/")
        if w.startswith("http"): sites.append(w)
        time.sleep(0.1)
    for w in sorted(set(sites)):
        u = w + "/.well-known/x402"
        if ssrf_check(u): continue
        try:
            r = S.get(u, timeout=8, allow_redirects=False)
            j = r.json() if r.status_code == 200 and "json" in r.headers.get("content-type", "") else None
        except Exception: j = None
        if isinstance(j, dict) and isinstance(j.get("resources"), list):
            found.append({"site": w, "resources": [x for x in j["resources"] if isinstance(x, (str, dict))][:500]})
        time.sleep(0.2)
    save("x402org.json", found)
    return {"partners": len(metas), "websites": len(set(sites)), "with_well_known": len(found), "items": sum(len(f["resources"]) for f in found)}
source("x402org-ecosystem", x402org, "x402.org ecosystem partners (coinbase/x402 repo) -> each site's /.well-known/x402")

status["x402scan"] = {"ok": False, "skipped": True, "note": "x402scan's machine-readable lists (/api/x402/resources, /api/x402/merchants) are paid x402 endpoints ($0.01/page); we never pay. Its HTML server pages are ~1 MB each x 1000 (impolite to scrape weekly), and it indexes the same CDP/PayAI Bazaar lists we already read."}
status["mcp-directories"] = {"ok": False, "skipped": True, "note": "MCP x402 tools charge inside JSON-RPC tools/call, not as an HTTP 402 at a URL, so an unpaid HTTP probe cannot check them. agent-tools.cloud (above) already lists the HTTP x402 services MCP directories point to."}
save("sources.json", status)
need = sum(status[k].get("items", 0) for k in ("payai-bazaar", "cdp-bazaar") if status[k]["ok"])
print("bazaar items:", need)
assert need >= 5000, "Bazaar lists too small; keeping last week's lists"
