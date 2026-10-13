#!/usr/bin/env python3
"""Validate 402xAgent discovery surfaces for consistency (read-only, unpaid GETs only).
Checks: valid JSON / OpenAPI 3.1, one version everywhere (/health, OpenAPI, server.json optional), canonical hosts,
every link we list resolves (2xx, or 402 for paid routes), the new endpoints listed, receipt URLs resolve.
Usage: python3 scripts/validate_discovery.py [--base https://402xagent.com] [--api https://api.402xagent.com] [--server-json server.json]
Exit 1 on any failure. OpenAPI structure check needs openapi-spec-validator (skipped with a note if missing)."""
import argparse, json, re, subprocess, sys, random

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="https://402xagent.com")
ap.add_argument("--api", default="https://api.402xagent.com")
ap.add_argument("--server-json", default=None)
a = ap.parse_args()
fails, notes = [], []
CB = str(random.randint(1, 10**9))

def get(url, accept="application/json", method="GET"):
    sep = "&" if "?" in url else "?"
    out = subprocess.run(["curl", "-s", "-m", "20", "-X", method, "-H", "accept: " + accept, "-o", "/tmp/vd.body", "-w", "%{http_code} %{content_type}", url + sep + "cb=" + CB], capture_output=True, text=True).stdout.split(" ", 1)
    body = open("/tmp/vd.body", "rb").read().decode("utf-8", "replace")
    return int(out[0] or 0), (out[1] if len(out) > 1 else ""), body

def js(url):
    st, ct, b = get(url)
    if st != 200: fails.append(f"{url}: HTTP {st}"); return None
    try: return json.loads(b)
    except Exception as e: fails.append(f"{url}: invalid JSON ({e})"); return None

def check(cond, msg):
    (notes if cond else fails).append(("ok   " if cond else "") + msg)

health = js(a.api + "/health") or {}
ver = health.get("version")
check(bool(ver), f"/health version {ver}")
oa = js(a.api + "/openapi.json") or {}
check(oa.get("info", {}).get("version") == ver, f"OpenAPI info.version {oa.get('info', {}).get('version')} == {ver}")
check(str(oa.get("openapi", "")).startswith("3.1"), f"OpenAPI {oa.get('openapi')}")
try:
    from openapi_spec_validator import validate
    validate(oa); notes.append("ok   OpenAPI document validates (openapi-spec-validator)")
except ImportError:
    notes.append("note OpenAPI structure check skipped (pip install openapi-spec-validator)")
except Exception as e:
    fails.append("OpenAPI invalid: " + str(e).split("\n")[0][:300])
servers = [s.get("url") for s in oa.get("servers", [])]
check(servers[:2] == [a.api, a.base], f"OpenAPI servers start with canonical hosts {servers[:2]}")
for p in ["/v1/products/endpoint-spot-check", "/v1/skips", "/v1/receipts", "/v1/receipts/by-url", "/bazaar", "/bazaar.json", "/mcp"]:
    check(p in oa.get("paths", {}), f"OpenAPI lists {p}")

wk = js(a.api + "/.well-known/x402") or {}
check(wk.get("homepage") == a.base, f".well-known/x402 homepage {wk.get('homepage')}")
links = set()
def walk(o):
    if isinstance(o, dict):
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
    elif isinstance(o, str) and re.match(r"^https://(api\.)?402xagent\.com/[^\s<>]*$", o):
        links.add(o)
walk(wk)
for k in ("free_pages",):
    check(k in wk, f".well-known/x402 has {k}")
sk = js(a.base + "/v1/skips.json") or {}
for k in ("endpoints_covered", "crawled_at", "skips"):
    check(k in sk, f"skips.json has {k}")
for r in (sk.get("skips") or [])[:3] + (sk.get("recent_checks") or [])[:3]:
    for f in ("receipt_url", "permalink"):
        if r.get(f): links.add(r[f])
bz = js(a.base + "/bazaar.json") or {}
check(isinstance(bz.get("rows"), list) and bz.get("counts") is not None, f"bazaar.json rows={len(bz.get('rows') or [])} counts={bz.get('counts')}")
check(not any("?" in (r.get("endpoint") or "") for r in bz.get("rows") or []), "bazaar.json endpoints carry no query strings")
check(sum((bz.get("counts") or {}).values()) == len(bz.get("rows") or []), "bazaar.json counts add up to rows")
for r in (bz.get("rows") or [])[:3]:
    if r.get("receipt_url"): links.add(r["receipt_url"])
st, ct, llms = get(a.base + "/llms.txt", accept="text/plain")
check(st == 200 and ct.startswith("text/plain"), f"llms.txt HTTP {st} {ct}")
for p in ("/bazaar", "/v1/skips", "/openapi.json", "/mcp"):
    check(p in llms, f"llms.txt mentions {p}")
check(" 500 self-checked" not in llms, "llms.txt has no stale '500 self-checked' count")
n = sk.get("endpoints_covered")
if n: check(f"{n:,}" in llms, f"llms.txt quotes the live count {n:,}")
for m in re.findall(r"https://(?:api\.)?402xagent\.com/[^\s)<>\"']*", llms):
    m = m.rstrip(".,;")
    if not m.endswith(("=", "/sc-")): links.add(m)  # templates like by-url?url=<endpoint>, sc-<id>
PAID = ("/v1/lookup/paid", "/v1/products/overnight-cos-pack", "/v1/products/endpoint-spot-check")
for u in sorted(links):
    if u.endswith("/mcp"): st, _, _ = get(u, method="GET"); check(st in (200, 405, 406), f"link {u} -> {st}"); continue
    st, _, _ = get(u)
    ok = 200 <= st < 300 or (st == 402 and any(p in u for p in PAID))
    check(ok, f"link {u} -> {st}")
if a.server_json:
    sj = json.load(open(a.server_json))
    check(any(r.get("url") == a.api + "/mcp" for r in sj.get("remotes", [])), "server.json remote is the canonical /mcp")
    check(sj.get("websiteUrl", "").rstrip("/") == a.base, f"server.json websiteUrl {sj.get('websiteUrl')}")
    notes.append(f"note server.json version {sj.get('version')} (Worker {ver})")
for x in notes: print(x)
for x in fails: print("FAIL " + x)
print(f"{len(notes)} ok/notes, {len(fails)} failures")
sys.exit(1 if fails else 0)
