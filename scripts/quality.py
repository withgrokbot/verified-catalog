"""Known-answer task-quality tests for paid checks (see data/quality_tests.json).

grade(service_id, body_bytes, window, tests, refs) -> dict with:
  result:  "pass" | "fail" | "not_graded"
  reason:  one plain sentence
  observed / expected: small facts behind the result (stored in the raw log)

`window` is (sent_at, received_at) as UTC datetimes around the paid request.
`refs` supplies the free reference answers (public RPC, Open-Meteo, SEC, our own TLS handshake, BCB PTAX).
Tests inject a fake refs object; nothing here spends money. If a reference cannot be fetched the result is
not_graded (not the seller's fault). Facts-only services are never graded.
Responses are untrusted data: parsed as JSON only, never executed.
"""
import datetime as dt
import json
import re
import socket
import ssl
import urllib.parse
from decimal import Decimal, InvalidOperation

import x402_probe as xp

SEARCH_HOSTS = ("x402.org",)
SEARCH_PREFIXES = ("https://github.com/coinbase/x402", "http://github.com/coinbase/x402")


class RefUnavailable(Exception):
    pass


def _utc(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return dt.datetime.fromtimestamp(ts, dt.timezone.utc)
    s = str(ts).strip().replace("Z", "+00:00")
    if " " in s and "T" not in s:
        s = s.replace(" ", "T", 1)
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def _walk(o, key=None):
    """Yield (key, value) pairs for every value in a JSON tree."""
    if isinstance(o, dict):
        for k, v in o.items():
            yield k, v
            yield from _walk(v, k)
    elif isinstance(o, list):
        for v in o:
            yield key, v
            yield from _walk(v, key)


def _res(result, reason, observed=None, expected=None):
    return {"result": result, "reason": reason, "observed": observed or {}, "expected": expected or {}}


# ------------------------------------------------------------------ free references
class References:
    """Live, free reference answers. Every method raises RefUnavailable on failure."""

    def __init__(self, timeout=15):
        self.timeout = timeout

    def _get_json(self, url, data=None, headers=None):
        r = xp.http_call("POST" if data is not None else "GET", url, data, headers, timeout=self.timeout)
        if not r.get("ok") or r["status"] != 200:
            raise RefUnavailable(f"{urllib.parse.urlsplit(url).netloc}: {r.get('error') or 'HTTP ' + str(r.get('status'))}")
        try:
            return json.loads(r["body"].decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise RefUnavailable(f"{urllib.parse.urlsplit(url).netloc}: not JSON")

    def _rpc(self, urls, method, params):
        last = None
        for u in urls:
            try:
                body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
                out = self._get_json(u, body)
                if "result" in out:
                    return out["result"]
                last = f"{u}: {out.get('error')}"
            except RefUnavailable as e:
                last = str(e)
        raise RefUnavailable(f"public RPC failed ({last})")

    def erc20_balances(self, rpc_urls, token, account, window):
        head = int(self._rpc(rpc_urls, "eth_blockNumber", []), 16)
        data = "0x70a08231" + account.lower().removeprefix("0x").rjust(64, "0")
        out = []
        for b in range(head, head - int(window), -1):
            res = self._rpc(rpc_urls, "eth_call", [{"to": token, "data": data}, hex(b)])
            out.append((b, int(res, 16)))
        return out

    def current_temp_c(self, lat, lon, nws_station=None):
        """Open-Meteo current temperature; falls back to the US National Weather Service station, if given."""
        try:
            j = self._get_json(f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m")
            return float(j["current"]["temperature_2m"]), j["current"].get("time"), "open-meteo.com"
        except (RefUnavailable, KeyError, TypeError, ValueError) as e:
            if not nws_station:
                raise RefUnavailable(f"Open-Meteo: {e}")
            first = e
        try:
            j = self._get_json(f"https://api.weather.gov/stations/{nws_station}/observations/latest",
                               headers={"User-Agent": xp.USER_AGENT + " (github.com/withgrokbot/verified-catalog)",
                                        "Accept": "application/geo+json"})
            p = j["properties"]
            return float(p["temperature"]["value"]), p.get("timestamp"), f"weather.gov station {nws_station}"
        except (RefUnavailable, KeyError, TypeError, ValueError) as e:
            raise RefUnavailable(f"Open-Meteo ({first}) and weather.gov ({e})")

    def sec_latest_10k(self, cik):
        j = self._get_json(f"https://data.sec.gov/submissions/CIK{cik}.json",
                           headers={"User-Agent": xp.USER_AGENT + " (github.com/withgrokbot/verified-catalog)"})
        rec = j.get("filings", {}).get("recent", {})
        dates = [d for f, d in zip(rec.get("form", []), rec.get("filingDate", [])) if f == "10-K"]
        if not dates:
            raise RefUnavailable("SEC: no 10-K in recent filings")
        return str(j.get("cik", cik)).rjust(10, "0"), max(dates)

    def tls_not_after(self, host, port=443):
        try:
            ctx = ssl.create_default_context()
            with socket.create_connection((host, port), timeout=self.timeout) as sock:
                with ctx.wrap_socket(sock, server_hostname=host) as s:
                    na = s.getpeercert()["notAfter"]
        except (OSError, ssl.SSLError, KeyError) as e:
            raise RefUnavailable(f"TLS handshake with {host}: {e}")
        return dt.datetime.strptime(na, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=dt.timezone.utc)

    def ptax_usd(self, day):
        start = (day - dt.timedelta(days=7)).strftime("%m-%d-%Y")
        end = day.strftime("%m-%d-%Y")
        u = ("https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo("
             "dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?"
             f"@dataInicial='{start}'&@dataFinalCotacao='{end}'&$format=json")
        vals = self._get_json(u).get("value") or []
        if not vals:
            raise RefUnavailable("BCB PTAX: no quote in the last 7 days")
        v = vals[-1]
        return {"buy": v.get("cotacaoCompra"), "sell": v.get("cotacaoVenda"), "at": v.get("dataHoraCotacao")}


# ------------------------------------------------------------------ graders
def g_erc20_balance(j, t, window, refs):
    d = j.get("data") if isinstance(j.get("data"), dict) else j
    try:
        bal = int(str(d.get("balance")))
    except (TypeError, ValueError):
        return _res("fail", "response has no integer balance")
    refs_list = refs.erc20_balances(t["rpc_urls"], t["token"], t["account"], t.get("block_window", 6))
    match = [b for b, v in refs_list if v == bal]
    obs = {"balance": str(bal)}
    exp = {"public_rpc": [{"block": b, "balance": str(v)} for b, v in refs_list]}
    if match:
        return _res("pass", f"balance equals public-RPC balanceOf at block {match[0]}", obs, exp)
    return _res("fail", "balance differs from public-RPC balanceOf at each of the newest blocks", obs, exp)


def _urls(j):
    out = []
    for k, v in _walk(j):
        if isinstance(v, str) and str(k).lower() in ("url", "link", "href", "id") and v.startswith("http"):
            out.append(v)
    return out


def g_web_search(j, t, window, refs):
    urls = _urls(j)
    hits = []
    for u in urls:
        host = (urllib.parse.urlsplit(u).hostname or "").lower()
        if host in SEARCH_HOSTS or host.endswith(".x402.org") or u.startswith(SEARCH_PREFIXES):
            hits.append(u)
    obs = {"result_urls": len(set(urls)), "matching_urls": sorted(set(hits))[:5]}
    if hits:
        return _res("pass", f"{len(set(hits))} result URL(s) on x402.org or github.com/coinbase/x402", obs)
    return _res("fail", f"none of {len(set(urls))} result URLs is on x402.org or github.com/coinbase/x402", obs)


def g_crypto_news(j, t, window, refs):
    data = j.get("data") if isinstance(j.get("data"), dict) else j
    items = data.get("headlines") or data.get("items") or data.get("articles") or []
    if not isinstance(items, list):
        items = []
    with_url = [i for i in items if isinstance(i, dict) and str(i.get("url") or i.get("link") or "").startswith("http")]
    times = [_utc(i.get("publishedAt") or i.get("published_at") or i.get("time")) for i in items if isinstance(i, dict)]
    times = [x for x in times if x]
    newest = max(times) if times else None
    age_h = (window[1] - newest).total_seconds() / 3600 if newest else None
    obs = {"items": len(items), "items_with_url": len(with_url), "newest": xp.iso_z(newest) if newest else None,
           "newest_age_hours": round(age_h, 2) if age_h is not None else None}
    if len(items) < t["min_items"]:
        return _res("fail", f"{len(items)} items, need at least {t['min_items']}", obs)
    if len(with_url) != len(items):
        return _res("fail", f"{len(items) - len(with_url)} item(s) without a source URL", obs)
    if age_h is None or age_h >= t["max_age_hours"]:
        return _res("fail", f"newest item is not under {t['max_age_hours']} h old", obs)
    return _res("pass", f"{len(items)} items with source URLs; newest {age_h:.1f} h old", obs)


def g_name_prefix(j, t, window, refs):
    names = [v for k, v in _walk(j) if k == "name" and isinstance(v, str)]
    hit = [n for n in names if n.lower().startswith(t["prefix"].lower())]
    obs = {"names": names[:5]}
    if hit:
        return _res("pass", f"result named {hit[0]!r}", obs)
    return _res("fail", f"no result name starts with {t['prefix']!r}", obs)


def g_edgar_10k(j, t, window, refs):
    ciks = {str(v).rjust(10, "0") for k, v in _walk(j) if str(k).lower() in ("cik", "cik_str", "cik_number") and str(v).isdigit()}
    dates = []
    for k, v in _walk(j):
        if isinstance(v, dict) and str(v.get("form") or v.get("formType") or v.get("form_type") or "").upper() == "10-K":
            d = v.get("filingDate") or v.get("filing_date") or v.get("filed") or v.get("date")
            if d:
                dates.append(str(d)[:10])
    obs = {"cik": sorted(ciks), "latest_10k": max(dates) if dates else None}
    ref_cik, ref_date = refs.sec_latest_10k(t["cik"])
    exp = {"cik": ref_cik, "latest_10k": ref_date}
    if ref_cik not in ciks:
        return _res("fail", "CIK does not match SEC", obs, exp)
    if not dates or max(dates) != ref_date:
        return _res("fail", "latest 10-K date does not match SEC", obs, exp)
    return _res("pass", "CIK and latest 10-K date match SEC", obs, exp)


def g_paid_time(j, t, window, refs):
    try:
        epoch = float(j["epoch"])
    except (KeyError, TypeError, ValueError):
        return _res("fail", "no epoch in response")
    if epoch > 1e11:  # milliseconds
        epoch /= 1000.0
    iso = _utc(j.get("timestamp") or j.get("iso"))
    tol = float(t.get("tolerance_s", 5))
    lo, hi = window[0].timestamp() - tol, window[1].timestamp() + tol
    obs = {"epoch_s": epoch, "iso": j.get("timestamp") or j.get("iso"),
           "our_clock": [xp.iso_z(window[0]), xp.iso_z(window[1])]}
    if not (lo <= epoch <= hi):
        return _res("fail", f"epoch is more than {tol:g} s from our clock", obs)
    if iso is None or abs(iso.timestamp() - epoch) >= 1:
        return _res("fail", "ISO time and epoch disagree", obs)
    return _res("pass", f"epoch within {tol:g} s of our clock; ISO and epoch agree", obs)


def g_pool_base_token(j, t, window, refs):
    want = t["base_token"].lower()
    pools = j.get("data") if isinstance(j.get("data"), list) else []
    hit = None
    for p in pools:
        bid = str((((p.get("relationships") or {}).get("base_token") or {}).get("data") or {}).get("id") or "").lower()
        if bid.endswith(want):
            hit = p.get("id")
            break
    obs = {"pools": len(pools), "match": hit}
    if hit:
        return _res("pass", f"pool {hit} has WETH as base token", obs)
    return _res("fail", "no pool has WETH as base token", obs)


def g_series_sanity(j, t, window, refs):
    pts = j if isinstance(j, list) else (j.get("data") if isinstance(j.get("data"), list) else [])
    pts = [p for p in pts if isinstance(p, dict) and "t" in p and "v" in p]
    if not pts:
        return _res("fail", "no data points")
    last = max(pts, key=lambda p: p["t"])
    age_h = (window[1].timestamp() - float(last["t"])) / 3600
    try:
        v = float(last["v"])
    except (TypeError, ValueError):
        return _res("fail", "newest value is not a number")
    obs = {"points": len(pts), "newest_t": xp.iso_z(_utc(float(last["t"]))), "newest_age_hours": round(age_h, 2), "newest_value": v}
    if age_h > t["max_age_hours"]:
        return _res("fail", f"newest point is {age_h:.1f} h old (limit {t['max_age_hours']} h)", obs)
    if not (t["min"] <= v <= t["max"]):
        return _res("fail", f"newest value {v:.3f} outside {t['min']}-{t['max']}", obs)
    return _res("pass", f"newest point {age_h:.1f} h old, value {v:.3f}", obs)


def g_url_allowed(j, t, window, refs):
    vals = [v for k, v in _walk(j) if k == "allowed"]
    obs = {"allowed": vals[:3]}
    if vals and vals[0] is True:
        return _res("pass", "allowed = true", obs)
    return _res("fail", "allowed is not true", obs)


def g_weather(j, t, window, refs):
    rep = j.get("report") if isinstance(j.get("report"), dict) else j
    temp = rep.get("temperature") if isinstance(rep, dict) else None
    try:
        temp = float(temp)
    except (TypeError, ValueError):
        return _res("fail", "no numeric temperature")
    unit = str(rep.get("temperatureUnit") or rep.get("unit") or "").upper()
    fahrenheit = unit.startswith("F") or (not unit.startswith("C") and any(k.lower().endswith("mph") for k in rep))
    temp_c = (temp - 32) * 5 / 9 if fahrenheit else temp
    ref_c, ref_time, ref_src = refs.current_temp_c(t["latitude"], t["longitude"], t.get("nws_station"))
    diff = abs(temp_c - ref_c)
    obs = {"temperature": temp, "unit": "F" if fahrenheit else "C", "temperature_c": round(temp_c, 2)}
    exp = {"reference_c": ref_c, "reference_time": ref_time, "reference_source": ref_src}
    if diff <= t["tolerance_c"]:
        return _res("pass", f"within {diff:.1f} C of {ref_src}", obs, exp)
    return _res("fail", f"{diff:.1f} C from {ref_src} (limit {t['tolerance_c']} C)", obs, exp)


def g_ticker_news(j, t, window, refs):
    items = j.get("results") if isinstance(j.get("results"), list) else []
    tk = t["ticker"].upper()
    untagged = [i.get("id") for i in items if tk not in [str(x).upper() for x in (i.get("tickers") or [])]]
    times = [x for x in (_utc(i.get("published_utc")) for i in items) if x]
    newest = max(times) if times else None
    age_d = (window[1] - newest).total_seconds() / 86400 if newest else None
    obs = {"items": len(items), "items_without_ticker": len(untagged), "newest": xp.iso_z(newest) if newest else None,
           "newest_age_days": round(age_d, 2) if age_d is not None else None}
    if not items:
        return _res("fail", "no items", obs)
    if untagged:
        return _res("fail", f"{len(untagged)} of {len(items)} items do not tag {tk}", obs)
    if age_d is None or age_d > t["max_age_days"]:
        return _res("fail", f"newest item is older than {t['max_age_days']} days", obs)
    return _res("pass", f"all {len(items)} items tag {tk}; newest {age_d:.1f} days old", obs)


def g_merchants(j, t, window, refs):
    rows = j.get("data") if isinstance(j.get("data"), list) else (j if isinstance(j, list) else [])
    if not rows:
        return _res("fail", "empty list")
    vols, missing = [], 0
    for r in rows:
        if not isinstance(r, dict) or not (r.get("recipient") or r.get("address")):
            missing += 1
        try:
            vols.append(Decimal(str(r.get("total_amount", r.get("volume")))))
        except (InvalidOperation, AttributeError):
            vols.append(None)
    obs = {"entries": len(rows), "entries_without_address": missing}
    if missing:
        return _res("fail", f"{missing} entries without an address", obs)
    if None in vols or any(a < b for a, b in zip(vols, vols[1:])):
        return _res("fail", "not sorted by volume (largest first)", obs)
    return _res("pass", f"{len(rows)} entries, sorted by volume, each with an address", obs)


def g_wiki(j, t, window, refs):
    d = j.get("data") if isinstance(j.get("data"), dict) else j
    item = d.get("wikibaseItem") or d.get("wikidata")
    url = d.get("pageUrl") or d.get("url") or ((d.get("content_urls") or {}).get("desktop") or {}).get("page")
    obs = {"wikidata": item, "page_url": url}
    exp = {"wikidata": t["wikidata"], "page_url": t["page_url"]}
    if item == t["wikidata"] and url == t["page_url"]:
        return _res("pass", "Wikidata id and canonical page URL match", obs, exp)
    return _res("fail", "Wikidata id or canonical page URL does not match", obs, exp)


def g_ssl(j, t, window, refs):
    chain = j.get("chain") or {}
    cert = j.get("certificate") or {}
    na = _utc(cert.get("not_after"))
    ours = refs.tls_not_after(t["host"], t.get("port", 443))
    obs = {"hostname_matches": chain.get("hostname_matches"), "not_after": cert.get("not_after")}
    exp = {"hostname_matches": True, "not_after": xp.iso_z(ours)}
    if chain.get("hostname_matches") is not True:
        return _res("fail", "hostname match is not true", obs, exp)
    if na is None or abs((na - ours).total_seconds()) >= 1:
        return _res("fail", "expiry differs from our own TLS handshake", obs, exp)
    return _res("pass", "hostname matches; expiry equals our own TLS handshake", obs, exp)


def g_ptax(j, t, window, refs):
    ref = refs.ptax_usd(window[1])
    nums = []
    for k, v in _walk(j):
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            nums.append(float(v))
        elif isinstance(v, str) and re.fullmatch(r"\d+[.,]\d+", v):
            nums.append(float(v.replace(",", ".")))
    want = [float(x) for x in (ref.get("buy"), ref.get("sell")) if x is not None]
    hit = any(abs(n - w) < 0.00005 for n in nums for w in want)
    exp = {"ptax": ref}
    if hit:
        return _res("pass", "USD/BRL equals BCB PTAX", {"values_found": len(nums)}, exp)
    return _res("fail", "no USD/BRL value equal to BCB PTAX", {"values_found": len(nums)}, exp)


GRADERS = {"erc20_balance": g_erc20_balance, "web_search": g_web_search, "crypto_news": g_crypto_news,
           "name_prefix": g_name_prefix, "edgar_10k": g_edgar_10k, "paid_time": g_paid_time,
           "pool_base_token": g_pool_base_token, "series_sanity": g_series_sanity, "url_allowed": g_url_allowed,
           "weather": g_weather, "ticker_news": g_ticker_news, "merchants": g_merchants, "wiki": g_wiki,
           "ssl": g_ssl, "ptax": g_ptax}


def load_tests(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["tests"]


def test_info(t):
    return {"input": t.get("input"), "pass_if": t.get("pass_if")}


def grade(service_id, body, window, tests, refs=None, delivered=True, settled=False):
    """Grade one paid response. body is bytes (the full response, not the stored excerpt)."""
    t = (tests or {}).get(service_id)
    if not t:
        return dict(_res("not_graded", "no known-answer test for this service"), test=None)
    info = test_info(t)
    if t.get("facts_only"):
        return dict(_res("not_graded", "facts only: " + t.get("facts_only_reason", "broken on the seller's side")), test=info, facts_only=True)
    if not delivered:
        if settled:
            return dict(_res("fail", "payment settled but no valid response was delivered"), test=info)
        return dict(_res("not_graded", "nothing was delivered and no settlement was reported"), test=info)
    try:
        j = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, AttributeError):
        return dict(_res("fail", "response is not JSON"), test=info)
    fn = GRADERS.get(t.get("kind"))
    if not fn:
        return dict(_res("not_graded", f"unknown test kind {t.get('kind')!r}"), test=info)
    if not isinstance(j, (dict, list)):
        return dict(_res("fail", "response JSON is not an object or list"), test=info)
    if isinstance(j, list) and t.get("kind") not in ("series_sanity", "merchants"):
        j = {"data": j}
    try:
        out = fn(j, t, window, refs or References())
    except RefUnavailable as e:
        out = _res("not_graded", f"reference unavailable: {e}")
    except Exception as e:  # noqa: BLE001  a grader bug must never break a paid run
        out = _res("not_graded", f"grader error: {type(e).__name__}: {e}"[:200])
    out["test"] = info
    return out
