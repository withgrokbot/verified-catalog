"""Self-checked crawl: read public x402 lists, probe each endpoint once WITHOUT payment, write receipts JSONL.
Never sends PAYMENT-SIGNATURE / X-PAYMENT. SSRF-gated (private/loopback/link-local/CGNAT/metadata blocked).
5s timeout. Every listed endpoint (no cap), deduped by normalized URL. Polite: at most LANES requests in flight per host,
each lane spaced by SPACING seconds; DNS answers cached per host."""
import json, glob, re, os, sys, socket, ipaddress, hashlib, base64, datetime, collections, threading, time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, urlencode, urljoin
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CRAWL = os.path.join(ROOT, "crawl")
TIMEOUT, WORKERS, LANES, SPACING = 5, 48, 3, 0.34
CRAWL = os.environ.get("CRAWL_DIR", CRAWL)
USDC = {"eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".lower()}
NET_ALIAS = {"base": "eip155:8453", "base-sepolia": "eip155:84532", "solana": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"}
SANE_MAX_USD = 10.0

def net(n): return NET_ALIAS.get(str(n or "").lower(), str(n or ""))
def amt(a): return a.get("amount", a.get("maxAmountRequired"))
def usd(a):
    """USD for a USDC accept (6 decimals); None for other assets."""
    n, asset = net(a.get("network")), str(a.get("asset") or "").lower()
    try: v = int(str(amt(a)))
    except Exception: return None
    return round(v / 1e6, 6) if USDC.get(n) == asset else None

def blocked_ip(ip):
    ip = ipaddress.ip_address(ip)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped: ip = ip.ipv4_mapped
    return (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified
            or ip in ipaddress.ip_network("100.64.0.0/10"))

_DNS, _DNS_LOCK = {}, threading.Lock()
def doh(h):
    with _DNS_LOCK:
        if h in _DNS: return _DNS[h]
    v = _doh(h)
    with _DNS_LOCK: _DNS[h] = v
    return v

def _doh(h):
    """Resolve A/AAAA via Cloudflare DoH (same resolver as the Worker; the box's local resolver returns proxy fake-IPs)."""
    out = set()
    for t, want in (("A", 1), ("AAAA", 28)):
        try:
            j = requests.get("https://cloudflare-dns.com/dns-query", params={"name": h, "type": t},
                             headers={"accept": "application/dns-json"}, timeout=TIMEOUT).json()
        except Exception: continue
        out |= {a["data"] for a in j.get("Answer", []) if a.get("type") == want}
    return out or None

def ssrf_check(url):
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password: return "only public http(s) urls"
    h = u.hostname.lower().rstrip(".")
    if h in ("localhost", "metadata", "metadata.google.internal") or h.endswith((".localhost", ".local", ".internal")): return "blocked host"
    try: ipaddress.ip_address(h); addrs = {h}
    except ValueError: addrs = doh(h)
    if addrs is None: return "dns_failed"
    if not addrs or any(blocked_ip(a) for a in addrs): return "resolves to private/link-local address"
    return None

_URL_RE = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$")
def norm_url(u):
    """Same as normUrl() in the Worker (lib.js): lower-case scheme+host, drop default port, userinfo and fragment,
    drop a trailing slash (except the root), sort the raw query parts. No percent-decoding."""
    u = str(u or "").strip()
    m = _URL_RE.match(u)
    if not m: return u
    scheme, host, path, query = m.group(1).lower(), m.group(2), m.group(3), m.group(4) or ""
    host = host.rsplit("@", 1)[-1].lower()
    if (scheme == "http" and host.endswith(":80")) or (scheme == "https" and host.endswith(":443")): host = host.rsplit(":", 1)[0]
    host = host.rstrip(".")
    path = path or "/"
    if len(path) > 1: path = path.rstrip("/") or "/"
    parts = sorted(x for x in query[1:].split("&") if x) if query else []
    return f"{scheme}://{host}{path}" + ("?" + "&".join(parts) if parts else "")

def rid(norm): return hashlib.sha1(norm.encode()).hexdigest()[:10]

def _f(name): return os.path.join(CRAWL, name)
def _json(name, default):
    try: return json.load(open(_f(name)))
    except Exception: return default

def load_candidates():
    out = []
    for src, pat in (("payai-bazaar", "payai_*.json"), ("cdp-bazaar", "cdp_*.json")):
        for f in sorted(glob.glob(_f(pat)), key=lambda p: int(re.findall(r"_(\d+)", p)[-1])):
            for it in json.load(open(f)).get("items", []):
                if it.get("type") not in (None, "http") or not it.get("accepts") or not it.get("resource"): continue
                accs = it["accepts"]
                lead = next((a for a in accs if net(a.get("network")) == "eip155:8453"), accs[0])
                info = ((it.get("extensions") or {}).get("bazaar") or {}).get("info") or {}
                inp = info.get("input") or (lead.get("outputSchema") or {}).get("input") or {}
                out.append(dict(url=it["resource"], source_list=src, listing=lead,
                                method=str(inp.get("method") or "GET").upper(),
                                query=inp.get("queryParams") if isinstance(inp.get("queryParams"), dict) else None,
                                body=inp.get("body") if isinstance(inp.get("body"), (dict, list)) else None))
    def simple(url, src, claimed=None, network=None, method="GET"):
        lead = {}
        if claimed is not None: lead["_claimed_usd"] = claimed
        if network: lead["network"] = network
        out.append(dict(url=url, source_list=src, listing=lead, method=(method or "GET").upper(), query=None, body=None))
    for x in (_json("payapi.json", {}).get("results") or []):
        if x.get("base_url"):
            p = x.get("price_min") if x.get("price_min") is not None and x.get("price_min") == x.get("price_max") else None
            simple(x["base_url"], "payapi-market", p, "eip155:8453" if str(x.get("network") or "").lower() in ("base", "eip155:8453") else None)
    for u in (_json("agent402.json", {}).get("resources") or []):
        if isinstance(u, str): simple(u, "agent402")
    for site in _json("x402org.json", []):
        for r in site.get("resources") or []:
            u = r if isinstance(r, str) else (r.get("url") or r.get("resource"))
            if isinstance(u, str) and u.startswith("http"): simple(u, "x402org-ecosystem")
    for x in _json("agenttools.json", []):
        if not x.get("chains"): continue  # not an x402 service (plain MCP/A2A directory entry)
        p = x.get("price_min") if x.get("price_min") is not None and x.get("price_min") == x.get("price_max") else None
        urls = [(x.get("url"), "GET")] + [(r.get("url"), r.get("method") or "GET") for r in (x.get("resource_samples") or []) if isinstance(r, dict) and r.get("kind") in ("x402-resource", "http")]
        for u, m in urls:
            if isinstance(u, str) and u.startswith("http"): simple(u, "agent-tools-cloud", p, None, m)
    # awesome-x402: only lines naming exactly one endpoint-like URL and exactly one $ price
    if os.path.exists(_f("awesome.md")):
        for line in open(_f("awesome.md"), encoding="utf-8"):
            prices = set(re.findall(r"\$(\d+(?:\.\d+)?)(?!\s*[–-]\s*\$)", line))
            if re.search(r"\$\d+(?:\.\d+)?\s*[–-]\s*\$", line) or len(prices) != 1: continue
            urls = [x for x in re.findall(r"https?://[^\s)\]>\"'`]+", line)
                    if not re.search(r"github|npmjs|x402scan|smithery|twitter|x\.com|openapi|llms\.txt|\.well-known|/docs|/mcp|modelcontextprotocol|/(info|directory|schema|pricing|nodes|health|servers)/?$", x)
                    and re.search(r"/api/|/v\d/", x)]
            if len(urls) == 1: simple(urls[0].rstrip(".,"), "awesome-x402", float(prices.pop()))
    # Dedupe by normalized URL. The richest listing wins (Bazaar entries carry full payment terms); others -> also_listed_in.
    rank = {"payai-bazaar": 0, "cdp-bazaar": 1, "payapi-market": 2, "agent402": 3, "x402org-ecosystem": 4, "agent-tools-cloud": 5, "awesome-x402": 6}
    out.sort(key=lambda c: rank[c["source_list"]])
    best = {}
    for c in out:
        n = norm_url(c["url"])
        if not n.startswith(("http://", "https://")): continue
        if n in best:
            if c["source_list"] != best[n]["source_list"] and c["source_list"] not in best[n]["also"]: best[n]["also"].append(c["source_list"])
            continue
        c["norm"] = n; c["also"] = []; best[n] = c
    return list(best.values())

def decode_402(r):
    ch = None
    hdr = r.headers.get("payment-required")
    if hdr:
        try: ch = json.loads(base64.b64decode(hdr.strip() + "=" * (-len(hdr.strip()) % 4)))
        except Exception: ch = None
    if ch is None:
        try: ch = json.loads(r.content[:65536])
        except Exception: ch = None
    accs = ch.get("accepts") if isinstance(ch, dict) else None
    if not isinstance(accs, list): return None
    return [a for a in accs if isinstance(a, dict)]

def probe(c):
    lead = c["listing"]
    claimed = lead.get("_claimed_usd") if "_claimed_usd" in lead else usd(lead)
    rec = dict(id=rid(c["norm"]), url=c["url"], norm_url=c["norm"], also_listed_in=c["also"], claimed_price_usd=claimed, quoted_price_usd=None,
               pay_to=None, verdict=None, reason=None, timestamp=None, source_list=c["source_list"], check_type="self-checked",
               method=c["method"], http_status=None, network=None, asset=None, listed_pay_to=lead.get("payTo"),
               listed_network=net(lead.get("network")) or None)
    def done(v, why):
        rec.update(verdict=v, reason=why, timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"))
        return rec
    url = c["url"]
    if ":" in urlparse(url).path or "{" in url:  # path templates like /wiki/:title
        return done("skip", "listing url is a path template, not a callable endpoint")
    r = fetch(url, c, done)  # probe exactly as listed first
    if isinstance(r, dict): return r
    if 400 <= r.status_code < 500 and r.status_code != 402 and c["query"] and "?" not in url:
        # some sellers validate params before the 402: retry once with the listing's own example params
        r2 = fetch(url + "?" + urlencode({k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in c["query"].items()}), c, done)
        if isinstance(r2, dict): return r2
        r = r2
    return judge(r, rec, lead, claimed, done)

def fetch(url, c, done):
    hdrs = {"accept": "application/json", "user-agent": "verified-catalog-spotcheck/0.11 (weekly self-checked crawl; never pays)"}
    kw = dict(json=c["body"] if c["body"] is not None else {}) if c["method"] == "POST" else {}
    try:
        for _ in range(4):
            bad = ssrf_check(url)
            if bad == "dns_failed": return done("skip", "dns lookup failed (host does not resolve)")
            if bad: return done("skip", "ssrf_blocked: " + bad)
            r = requests.request(c["method"] if c["method"] in ("GET", "POST") else "GET", url, headers=hdrs, timeout=TIMEOUT,
                                 allow_redirects=False, stream=True, **kw)
            if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                url = urljoin(url, r.headers["location"]); r.close(); continue
            break
        else:
            return done("skip", "too many redirects")
        return r
    except requests.exceptions.Timeout:
        return done("recheck", "timeout (5s)")
    except requests.exceptions.RequestException as e:
        return done("recheck", "connection error: " + type(e).__name__)

def judge(r, rec, lead, claimed, done):
    try:
        rec["http_status"] = r.status_code
        if r.status_code >= 500: return done("recheck", f"HTTP {r.status_code} (server error)")
        if r.status_code != 402: return done("skip", f"no 402 challenge (HTTP {r.status_code})")
        r._content = r.raw.read(65536, decode_content=True)
        accs = decode_402(r)
        if not accs: return done("skip", "malformed 402 (no parseable accepts)")
        want_net = net(lead.get("network")) if "network" in lead else None
        same_net = [a for a in accs if net(a.get("network")) == want_net] if want_net else accs
        if not same_net:
            a = accs[0]; rec.update(network=net(a.get("network")), asset=a.get("asset"), pay_to=a.get("payTo"), quoted_price_usd=usd(a))
            return done("skip", f"network mismatch: listed {want_net}, 402 offers {sorted({net(x.get('network')) for x in accs})}")
        same_asset = [a for a in same_net if str(a.get("asset") or "").lower() == str(lead.get("asset") or "").lower()] if lead.get("asset") else same_net
        a = (same_asset or same_net)[0]
        q = usd(a)
        rec.update(network=net(a.get("network")), asset=a.get("asset"), pay_to=a.get("payTo"), quoted_price_usd=q)
        if not same_asset: return done("skip", f"asset mismatch: listed {lead.get('asset')}, 402 asks {a.get('asset')}")
        if lead.get("payTo") and str(a.get("payTo") or "").lower() != str(lead["payTo"]).lower():
            return done("skip", f"payTo differs from listing ({lead['payTo']} listed, {a.get('payTo')} in 402)")
        if q is None: return done("skip", "402 price not parseable as USDC amount")
        if claimed is not None and abs(q - claimed) > 1e-9 + max(q, claimed) * 1e-6:
            return done("skip", f"price mismatch: listed ${claimed:g}, 402 asks ${q:g}")
        if not (0 < q <= SANE_MAX_USD): return done("skip", f"price not sane (${q:g})")
        return done("pay", "402 matches listing (price, asset, network, payTo)" if claimed is not None else "valid 402, no listed price to compare")
    except requests.exceptions.Timeout:
        return done("recheck", "timeout (5s)")
    except requests.exceptions.RequestException as e:
        return done("recheck", "connection error: " + type(e).__name__)

def run_lane(cands):
    out = []
    for c in cands:
        t0 = time.monotonic()
        try: out.append(probe(c))
        except Exception as e:  # never lose a candidate
            out.append(dict(id=rid(c["norm"]), url=c["url"], norm_url=c["norm"], also_listed_in=c["also"], verdict="recheck",
                            reason="probe error: " + type(e).__name__, source_list=c["source_list"], check_type="self-checked",
                            method=c["method"], timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")))
        time.sleep(max(0.0, SPACING - (time.monotonic() - t0)))
    return out

if __name__ == "__main__":
    cands = load_candidates()
    limit = int(os.environ.get("CRAWL_LIMIT", "0") or 0)  # tests only
    if limit: cands = cands[:limit]
    by_host = collections.defaultdict(list)
    for c in cands: by_host[(urlparse(c["url"]).hostname or "").lower()].append(c)
    lanes = []
    for h, cs in by_host.items():
        k = min(LANES, len(cs))
        lanes += [cs[i::k] for i in range(k)]
    lanes.sort(key=len, reverse=True)  # biggest hosts start first
    print(f"candidates {len(cands)} hosts {len(by_host)} lanes {len(lanes)} biggest {len(lanes[0]) if lanes else 0}", flush=True)
    started = datetime.datetime.now(datetime.timezone.utc)
    recs = []
    with ThreadPoolExecutor(WORKERS) as ex:
        for i, r in enumerate(ex.map(run_lane, lanes)): recs += r
    stamp = started.strftime("%Y%m%dT%H%M%SZ")
    prev = open(os.path.join(ROOT, "latest.txt")).read().strip() if os.path.exists(os.path.join(ROOT, "latest.txt")) else ""
    path = os.path.join(ROOT, f"receipts-{stamp}.jsonl")
    with open(path + ".tmp", "w") as f:
        for r in recs: f.write(json.dumps(r) + "\n")
    os.replace(path + ".tmp", path)
    if prev and prev != os.path.basename(path):
        with open(os.path.join(ROOT, "previous.txt"), "w") as f: f.write(prev + "\n")
    with open(os.path.join(ROOT, "latest.txt"), "w") as f: f.write(os.path.basename(path) + "\n")
    took = (datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()
    print(path, len(recs), f"{took:.0f}s", collections.Counter(r["verdict"] for r in recs), collections.Counter(r["source_list"] for r in recs))
