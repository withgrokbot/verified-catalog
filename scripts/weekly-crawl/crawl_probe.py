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
LANE_BUDGET_S = int(os.environ.get("CRAWL_LANE_BUDGET_S", "2400"))  # per host lane; the rest is "not probed this run"
CRAWL = os.environ.get("CRAWL_DIR", CRAWL)
USDC = {"eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".lower()}
NET_ALIAS = {"base": "eip155:8453", "base-sepolia": "eip155:84532", "solana": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"}
SANE_MAX_USD = 10.0

def net(n): return NET_ALIAS.get(str(n or "").lower(), str(n or ""))
def amt(a): return a.get("amount", a.get("maxAmountRequired"))
def atomic(a):
    """0.52.x term history: the quoted amount in the asset's smallest unit, as a decimal string (None if not an integer)."""
    try: return str(int(str(amt(a)).strip()))
    except Exception: return None
def usd(a):
    """USD for a USDC accept (6 decimals); None for other assets. 0.27.0: every supported mainnet's canonical USDC
    counts (before, only Base/Base Sepolia/Solana did, so valid Polygon/Arbitrum/... prices read as unparseable)."""
    n, asset = net(a.get("network")), str(a.get("asset") or "").lower()
    try: v = int(str(amt(a)))
    except Exception: return None
    return round(v / 1e6, 6) if (USDC.get(n) == asset or USDC_MAINNET.get(n.lower()) == asset) else None
# 0.55.0 skip-reason tuning (same rules as the Worker's worker/src/transient.js). New receipts carry reason_code for these.
PERSISTENT_OF = {"rate_limited": "rate_limited_persistent", "waf_challenge": "waf_blocked_persistent", "dns_error": "dns_error_persistent"}
STREAK_CODES = set(PERSISTENT_OF) | set(PERSISTENT_OF.values())
PERSISTENT_TEXT = {"rate_limited_persistent": "endpoint has only answered HTTP 429 (rate limited) for longer than our retry window",
                   "waf_blocked_persistent": "a firewall or bot challenge (HTTP 403) has blocked every probe for longer than our retry window",
                   "dns_error_persistent": "the endpoint's domain has not resolved (DNS) for longer than our retry window"}
def transient_skip_after_hours(env=os.environ):
    try:
        n = float(str(env.get("TRANSIENT_SKIP_AFTER_HOURS", "")).strip())
        return n if 0 < n <= 24 * 365 else 24.0
    except ValueError:
        return 24.0
_CF_PAGE_RE = re.compile(r"challenge-platform|cf_chl_opt|cf-chl-|<title>\s*Just a moment\.\.\.\s*</title>|Attention Required! \| Cloudflare|Sorry, you have been blocked[\s\S]{0,4000}Cloudflare Ray ID|Cloudflare Ray ID[\s\S]{0,4000}Sorry, you have been blocked", re.I)
_AKAMAI_PAGE_RE = re.compile(r"Access Denied[\s\S]{0,2000}Reference(?:&#32;|\s)#\d+\.[0-9a-f]+", re.I)
def waf_signature(status, headers, body_text):
    """Conservative: only a 403 with a cf-mitigated / x-amzn-waf-action header, a Cloudflare-served challenge/block page,
    or an AkamaiGHost Access Denied page with its Reference #. A plain 403 is None (stays skip, no x402 payment request)."""
    if status != 403: return None
    h = {k.lower(): v for k, v in (headers or {}).items()}
    if "cf-mitigated" in h: return {"vendor": "cloudflare", "signal": "cf-mitigated"}
    if "x-amzn-waf-action" in h: return {"vendor": "aws", "signal": "x-amzn-waf-action"}
    server, body = str(h.get("server") or "").lower(), str(body_text or "")[:65536]
    if server == "cloudflare" and _CF_PAGE_RE.search(body): return {"vendor": "cloudflare", "signal": "challenge_page"}
    if server.startswith("akamaighost") and _AKAMAI_PAGE_RE.search(body): return {"vendor": "akamai", "signal": "access_denied_page"}
    return None
def _ts(s):
    try: return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception: return None
def transient_guard(rec, prev, max_h=None, now=None):
    """rec: a finished record. prev: the same id's record from the previous run (or None). A rate_limited / waf_challenge /
    dns_error recheck carries transient_since (oldest observation of the unbroken streak across runs); once that is at
    least max_h hours old the record becomes skip/<code>_persistent. Other records are returned unchanged."""
    code = rec.get("reason_code")
    if rec.get("verdict") != "recheck" or code not in PERSISTENT_OF: return rec
    max_h = transient_skip_after_hours() if max_h is None else max_h
    now = now or _ts(rec.get("timestamp")) or datetime.datetime.now(datetime.timezone.utc)
    since = None
    if prev and prev.get("reason_code") in STREAK_CODES:
        since = prev.get("transient_since") or prev.get("timestamp")
    t0 = _ts(since) if since else None
    rec["transient_since"] = since if t0 else rec.get("timestamp")
    if t0 and (now - t0).total_seconds() >= max_h * 3600:
        p = PERSISTENT_OF[code]
        rec.update(verdict="skip", reason_code=p, transient_code=code, reason=PERSISTENT_TEXT[p] + f" (since {since})")
    return rec

PRICE_TOLERANCE = 0.01  # 0.27.0: same as the Worker: within 1% of the listed price is a match (dynamic-pricing drift)

def blocked_ip(ip):
    ip = ipaddress.ip_address(ip)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped: ip = ip.ipv4_mapped
    return (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified
            or ip in ipaddress.ip_network("100.64.0.0/10"))

_DNS, _DNS_LOCK = {}, threading.Lock()
DNS_RETRY_DELAY_S = float(os.environ.get("DNS_RETRY_DELAY_S", "0.3"))
def doh(h):
    with _DNS_LOCK:
        if h in _DNS: return _DNS[h]
    v = _doh(h)
    if v is None:  # 0.55.0: a DNS failure gets exactly one retry before it counts (then cached per host for the run)
        time.sleep(DNS_RETRY_DELAY_S)
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
    if any(seg.startswith(":") or "{" in seg or "%7b" in seg.lower() for seg in urlparse(url).path.split("/")):  # path templates like /wiki/:title or /{id} (0.27.0: "app:x" is not one)
        # 0.27.0: not a disagreement with the listing, so not a skip
        return done("recheck", "listing URL is a template (like /:id), check a filled-in URL")
    r = fetch(url, c, done)  # probe exactly as listed first
    if isinstance(r, dict): return r
    if r.status_code == 405 and c["method"] in ("GET", "POST"):
        # 0.27.0 fix (false skip): POST-only (or GET-only) routes answer 405 to the other method; try it once
        other = dict(c, method="POST" if c["method"] == "GET" else "GET", body=c["body"] if c["method"] == "GET" else None)
        r2 = fetch(url, other, done)
        if not isinstance(r2, dict):  # a failed retry keeps the original 405 answer
            if r2.status_code != 405: r.close(); r = r2; rec["method"] = other["method"]
            else: r2.close()
    if 400 <= r.status_code < 500 and r.status_code != 402 and c["query"] and "?" not in url:
        # some sellers validate params before the 402: retry once with the listing's own example params
        r2 = fetch(url + "?" + urlencode({k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in c["query"].items()}), c, done)
        r.close()
        if isinstance(r2, dict): return r2
        r = r2
    try:
        return judge(r, rec, lead, claimed, done)
    finally:
        r.close()

def fetch(url, c, done):
    hdrs = {"accept": "application/json", "user-agent": "verified-catalog-spotcheck/0.11 (weekly self-checked crawl; never pays)"}
    kw = dict(json=c["body"] if c["body"] is not None else {}) if c["method"] == "POST" else {}
    try:
        for hop in range(4):
            bad = ssrf_check(url)
            if bad == "dns_failed" and hop == 0:  # 0.55.0: the listed host (already retried once in doh) -> recheck/dns_error
                rec = done("recheck", "domain did not resolve (DNS, retried once), try again later"); rec["reason_code"] = "dns_error"; return rec
            if bad == "dns_failed": return done("skip", "domain does not resolve (DNS)")  # a redirect target, as before (Worker: ssrf_blocked)
            if bad: return done("skip", "private or local address, not checked (" + bad + ")")
            r = requests.request(c["method"] if c["method"] in ("GET", "POST") else "GET", url, headers=hdrs, timeout=TIMEOUT,
                                 allow_redirects=False, stream=True, **kw)
            if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                url = urljoin(url, r.headers["location"]); r.close(); continue
            break
        else:
            return done("skip", "too many redirects")
        return r
    except requests.exceptions.Timeout:
        return done("recheck", "endpoint did not answer in 5 s, try again later")
    except requests.exceptions.RequestException as e:
        return done("recheck", "could not connect (" + type(e).__name__ + "), try again later")

# 0.14.0 policy (same table as the Worker's USDC_BY_NETWORK): pay only on a supported mainnet with its canonical USDC.
USDC_MAINNET = {
    "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "eip155:1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "eip155:10": "0x0b2c639c533813f4aa9d7837caf62653d097ff85", "eip155:137": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    "eip155:42161": "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "eip155:43114": "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
    "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp": "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v",
}

def mainnet_policy(r):
    """A 'pay' on a testnet / unknown network or a non-canonical USDC token becomes a skip. Returns r (mutated)."""
    if r.get("verdict") != "pay": return r
    n, a = str(r.get("network") or "").lower(), str(r.get("asset") or "").lower()
    if n not in USDC_MAINNET:
        r["verdict"], r["reason"] = "skip", f"wants payment on a testnet or a network we don't support ({r.get('network')})"
    elif a != USDC_MAINNET[n]:
        r["verdict"], r["reason"] = "skip", f"asks for a token other than USDC on {r.get('network')} ({r.get('asset')})"
    return r

def judge(r, rec, lead, claimed, done):
    try:
        rec["http_status"] = r.status_code
        if r.status_code >= 500: return done("recheck", f"server error (HTTP {r.status_code}), try again later")
        if r.status_code != 402:  # 0.14.0: no terms = skip (no paywall), except a seller's own free-trial signal = recheck
            ft, rem = r.headers.get("x-free-trial"), r.headers.get("x-free-trial-remaining")
            if (ft is not None and ft.strip().lower() not in ("false", "0", "no")) or (ft is None and rem is not None):
                n = int(rem) if rem is not None and rem.strip().isdigit() else None
                rec["free_trial_remaining"] = n
                return done("recheck", f"seller says a free trial is active, no price to check yet (HTTP {r.status_code}" + (f", {n} trial calls left)" if n is not None else ")"))
            if r.status_code == 429:  # 0.55.0: rate limited is "not now", not "no paywall"
                rec = done("recheck", "rate limited (HTTP 429), try again later"); rec["reason_code"] = "rate_limited"; return rec
            if r.status_code == 403:  # 0.55.0: only a WAF/bot-challenge 403 is a recheck; a plain 403 stays the skip below
                buf, t_end = b"", time.monotonic() + 8
                while len(buf) < 65536 and time.monotonic() < t_end:
                    chunk = r.raw.read(4096, decode_content=True)
                    if not chunk: break
                    buf += chunk
                w = waf_signature(403, r.headers, buf.decode("utf-8", "replace"))
                if w:
                    rec = done("recheck", f"firewall or bot challenge (HTTP 403, {w['vendor']}), try again later"); rec["reason_code"] = "waf_challenge"; rec["waf"] = w; return rec
            return done("skip", f"no x402 payment request (HTTP {r.status_code})")
        buf, t_end = b"", time.monotonic() + 8  # hard wall-clock cap: a trickling server can't hold a lane
        while len(buf) < 65536 and time.monotonic() < t_end:
            chunk = r.raw.read(4096, decode_content=True)
            if not chunk: break
            buf += chunk
        r._content = buf
        accs = decode_402(r)
        if not accs: return done("skip", "payment request has no readable payment options")
        want_net = net(lead.get("network")) if "network" in lead else None
        same_net = [a for a in accs if net(a.get("network")) == want_net] if want_net else accs
        # 0.27.0 fix (false skip): the listing names only a testnet but the same seller's 402 also offers a supported
        # mainnet's canonical USDC -> judge the mainnet offer (same rule as the Worker's pickPayment).
        if want_net and want_net.lower() not in USDC_MAINNET and same_net:
            sellers = {str(lead.get("payTo") or "").lower()} if lead.get("payTo") else {str(x.get("payTo") or "").lower() for x in same_net}
            main = [a for a in accs if net(a.get("network")).lower() in USDC_MAINNET and str(a.get("asset") or "").lower() == USDC_MAINNET[net(a.get("network")).lower()] and str(a.get("payTo") or "").lower() in sellers]
            if main: same_net, lead = main, {k: v for k, v in lead.items() if k not in ("network", "asset")}
        elif not want_net:
            # no listed network: prefer supported-mainnet USDC offers when the 402 has several
            main = [a for a in accs if net(a.get("network")).lower() in USDC_MAINNET and str(a.get("asset") or "").lower() == USDC_MAINNET[net(a.get("network")).lower()]]
            if main: same_net = main + [a for a in accs if a not in main]
        if not same_net:
            a = accs[0]; rec.update(network=net(a.get("network")), asset=a.get("asset"), pay_to=a.get("payTo"), quoted_price_usd=usd(a), amount_atomic=atomic(a))
            return done("skip", f"asks for payment on a different network than listed (listed {want_net}, offers {', '.join(sorted({net(x.get('network')) for x in accs}))})")
        same_asset = [a for a in same_net if str(a.get("asset") or "").lower() == str(lead.get("asset") or "").lower()] if lead.get("asset") else same_net
        a = (same_asset or same_net)[0]
        q = usd(a)
        rec.update(network=net(a.get("network")), asset=a.get("asset"), pay_to=a.get("payTo"), quoted_price_usd=q, amount_atomic=atomic(a))
        if not same_asset: return done("skip", f"asks for a different token than listed (listed {lead.get('asset')}, asks {a.get('asset')})")
        if lead.get("payTo") and str(a.get("payTo") or "").lower() != str(lead["payTo"]).lower():
            return done("skip", f"pays a different wallet than listed ({lead['payTo']} listed, {a.get('payTo')} asked)")
        if q is None: return done("skip", f"asks for a token or network we can't price in USDC ({a.get('network')})")
        below = False
        if claimed is not None and abs(q - claimed) > 1e-9 + claimed * PRICE_TOLERANCE:
            if q > claimed: return done("skip", f"asks a different price than listed (listed ${claimed:g}, asks ${q:g})")
            below = True  # 0.28.0: cheaper than listed is pay (price_below_listing), after the sanity/network checks
        if not (0 < q <= SANE_MAX_USD): return done("skip", f"price looks wrong (${q:g})")
        n_, a_ = str(rec.get("network") or "").lower(), str(rec.get("asset") or "").lower()
        if n_ not in USDC_MAINNET: return done("skip", f"wants payment on a testnet or a network we don't support ({rec.get('network')})")
        if a_ != USDC_MAINNET[n_]: return done("skip", f"asks for a token other than USDC on {rec.get('network')} ({rec.get('asset')})")
        if below: return done("pay", f"live price lower than listed (listed ${claimed:g}, asks ${q:g})")
        return done("pay", "payment request matches the listing (price, token, network, wallet)" if claimed is not None else "valid payment request, no listed price to compare")
    except requests.exceptions.Timeout:
        return done("recheck", "endpoint did not answer in 5 s, try again later")
    except requests.exceptions.RequestException as e:
        return done("recheck", "could not connect (" + type(e).__name__ + "), try again later")

PREV = {}  # 0.55.0: id -> previous run's record (only the fields transient_guard reads), loaded in __main__
def load_prev(path):
    out = {}
    if not path or not os.path.exists(path): return out
    with open(path) as f:
        for line in f:
            try: x = json.loads(line)
            except Exception: continue
            if isinstance(x, dict) and x.get("id"): out[x["id"]] = {k: x.get(k) for k in ("verdict", "reason_code", "transient_since", "timestamp")}
    return out

def run_lane(cands):
    out, t_lane = [], time.monotonic() + LANE_BUDGET_S
    for c in cands:
        t0 = time.monotonic()
        if t0 > t_lane:
            out.append(dict(id=rid(c["norm"]), url=c["url"], norm_url=c["norm"], also_listed_in=c["also"], verdict="recheck",
                            reason="not probed this run (per-host time budget; next run)", source_list=c["source_list"], check_type="self-checked",
                            method=c["method"], timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")))
            continue
        try: out.append(transient_guard(probe(c), PREV.get(rid(c["norm"]))))
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
    stamp = started.strftime("%Y%m%dT%H%M%SZ")
    prev = open(os.path.join(ROOT, "latest.txt")).read().strip() if os.path.exists(os.path.join(ROOT, "latest.txt")) else ""
    PREV.update(load_prev(os.path.join(ROOT, prev) if prev else ""))  # 0.55.0 transient guard reads the previous run
    path = os.path.join(ROOT, f"receipts-{stamp}.jsonl")
    recs, next_report = [], 5000
    from concurrent.futures import as_completed
    with ThreadPoolExecutor(WORKERS) as ex, open(path + ".tmp", "w") as f:  # written as lanes finish (progress survives)
        for fut in as_completed([ex.submit(run_lane, l) for l in lanes]):
            for r in fut.result():
                f.write(json.dumps(r) + "\n")
                recs.append(r)
            f.flush()
            if len(recs) >= next_report:
                print(f"progress {len(recs)}/{len(cands)} {datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%SZ')}", flush=True); next_report += 5000
    os.replace(path + ".tmp", path)
    if prev and prev != os.path.basename(path):
        with open(os.path.join(ROOT, "previous.txt"), "w") as f: f.write(prev + "\n")
    with open(os.path.join(ROOT, "latest.txt"), "w") as f: f.write(os.path.basename(path) + "\n")
    took = (datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()
    print(path, len(recs), f"{took:.0f}s", collections.Counter(r["verdict"] for r in recs), collections.Counter(r["source_list"] for r in recs))
