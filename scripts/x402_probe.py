"""Probe library for the verified pay-per-call catalog.

- parse_challenge(): read an HTTP 402 x402 challenge (v2 PAYMENT-REQUIRED header or v1/v2 JSON body)
- SpendGuard: hard spend caps ($0.10 per call, $1.00 per UTC day, $20.00 lifetime), ledger on disk
- EvmSigner: EIP-3009 TransferWithAuthorization signatures for USDC (needs eth-account, paid mode only)
- check_service(): one free (unpaid) check, or one paid check when a signer and guard are given

Standard library only, except eth-account, which is imported lazily and only for paid mode.
Responses from services are untrusted data: they are never executed or rendered as HTML.
"""
import base64
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, ROUND_HALF_UP

CHECKER_VERSION = "0.1.0"
USER_AGENT = "WithGrokBot-catalog-checker/" + CHECKER_VERSION

# Hard limits. Command-line caps may lower these, never raise them.
HARD_PER_CALL_USD = Decimal("0.10")
HARD_PER_DAY_USD = Decimal("1.00")
HARD_LIFETIME_USD = Decimal("20.00")

# The only payment rails the prober will ever sign for.
NETWORKS = {
    "base": {"ids": {"eip155:8453", "base"}, "chain_id": 8453,
             "usdc": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"},
    "base-sepolia": {"ids": {"eip155:84532", "base-sepolia"}, "chain_id": 84532,
                     "usdc": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"},
}
USDC_DECIMALS = 6
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
KEEP_HEADERS = ("content-type", "content-length", "payment-required", "payment-response", "x-payment-response",
                "www-authenticate", "x-payment-amount", "date", "server", "retry-after")
BODY_EXCERPT_CHARS = 4096
MAX_BODY_BYTES = 256 * 1024


class SpendRefused(Exception):
    pass


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def iso_z(ts=None):
    return (ts or utc_now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def usd(atomic):
    return (Decimal(int(atomic)) / (Decimal(10) ** USDC_DECIMALS)).normalize()


def usd_str(d):
    if d is None:
        return None
    s = format(Decimal(d).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP), "f").rstrip("0").rstrip(".")
    return s or "0"


def redact(text):
    return EMAIL_RE.sub("[email redacted]", text)


def _b64json(value):
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4))
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


# ------------------------------------------------------------------ challenge
def parse_challenge(status, headers, body_bytes):
    """Return a dict describing the x402 challenge, or None if this is not one."""
    if status != 402:
        return None
    hdr = {k.lower(): v for k, v in headers.items()}
    obj, where = None, None
    if hdr.get("payment-required"):
        obj, where = _b64json(hdr["payment-required"].strip()), "PAYMENT-REQUIRED header"
    if not (isinstance(obj, dict) and obj.get("accepts")):
        try:
            b = json.loads(body_bytes.decode("utf-8", errors="replace"))
            if isinstance(b, dict) and b.get("accepts"):
                obj, where = b, "JSON body"
        except ValueError:
            pass
    if not (isinstance(obj, dict) and isinstance(obj.get("accepts"), list) and obj["accepts"]):
        return {"valid": False, "where": where, "x402_version": None, "accepts": [], "resource": None,
                "other_methods": ["www-authenticate"] if hdr.get("www-authenticate") else []}
    accepts = [a for a in obj["accepts"] if isinstance(a, dict)]
    return {"valid": True, "where": where, "x402_version": obj.get("x402Version"), "accepts": accepts,
            "resource": obj.get("resource"), "error": obj.get("error"),
            "other_methods": ["www-authenticate"] if hdr.get("www-authenticate") else []}


def option_amount(opt):
    v = opt.get("amount", opt.get("maxAmountRequired"))
    try:
        return int(str(v))
    except (TypeError, ValueError):
        return None


def pick_option(challenge, network="base"):
    """Pick the USDC 'exact' option on the allowed network that uses EIP-3009 (not permit2)."""
    net = NETWORKS[network]
    for opt in challenge.get("accepts") or []:
        if (opt.get("scheme") == "exact" and str(opt.get("network")) in net["ids"]
                and str(opt.get("asset", "")).lower() == net["usdc"].lower()
                and (opt.get("extra") or {}).get("assetTransferMethod") in (None, "eip3009")
                and option_amount(opt) is not None):
            return opt
    return None


def summarize_options(challenge, limit=8):
    out = []
    for opt in (challenge or {}).get("accepts", [])[:limit]:
        amt = option_amount(opt)
        known = any(str(opt.get("asset", "")).lower() == n["usdc"].lower() for n in NETWORKS.values())
        out.append({"scheme": opt.get("scheme"), "network": opt.get("network"),
                    "asset": "USDC" if known else str(opt.get("asset", ""))[:12],
                    "amount_atomic": str(amt) if amt is not None else None,
                    "amount_usd": usd_str(usd(amt)) if (amt is not None and known) else None})
    return out


# ------------------------------------------------------------------ spend guard
class SpendGuard:
    def __init__(self, ledger_path, per_call=None, per_day=None, lifetime=None, clock=utc_now):
        self.ledger_path = ledger_path
        self.clock = clock
        lower = lambda hard, v: hard if v is None else min(hard, Decimal(str(v)))
        self.per_call = lower(HARD_PER_CALL_USD, per_call)
        self.per_day = lower(HARD_PER_DAY_USD, per_day)
        self.lifetime = lower(HARD_LIFETIME_USD, lifetime)
        self.entries = []
        if os.path.exists(ledger_path):
            with open(ledger_path, encoding="utf-8") as fh:
                self.entries = json.load(fh).get("entries", [])

    def total(self):
        return sum((Decimal(e["amount_usd"]) for e in self.entries), Decimal("0"))

    def today_total(self):
        day = self.clock().strftime("%Y-%m-%d")
        return sum((Decimal(e["amount_usd"]) for e in self.entries if e.get("day") == day), Decimal("0"))

    def authorize(self, amount_usd):
        a = Decimal(str(amount_usd))
        if a <= 0:
            raise SpendRefused("price is zero or negative")
        if a > self.per_call:
            raise SpendRefused(f"price ${usd_str(a)} is above the per-call cap ${usd_str(self.per_call)}")
        if self.today_total() + a > self.per_day:
            raise SpendRefused(f"would pass the per-day cap ${usd_str(self.per_day)} (spent today ${usd_str(self.today_total())})")
        if self.total() + a > self.lifetime:
            raise SpendRefused(f"would pass the lifetime cap ${usd_str(self.lifetime)} (spent ${usd_str(self.total())})")
        return a

    def record(self, amount_usd, service_id, status, tx=None):
        """Attempts count as spent (conservative): the entry is written before the paid request goes out."""
        now = self.clock()
        e = {"ts": iso_z(now), "day": now.strftime("%Y-%m-%d"), "service_id": service_id,
             "amount_usd": usd_str(amount_usd), "status": status, "tx": tx}
        self.entries.append(e)
        self._save()
        return e

    def update_last(self, **kw):
        self.entries[-1].update(kw)
        self._save()

    def _save(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.ledger_path)), exist_ok=True)
        tmp = self.ledger_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"note": "Spend ledger for paid checks. Amounts in USD (USDC). Attempts count as spent.",
                       "caps_usd": {"per_call": usd_str(self.per_call), "per_day": usd_str(self.per_day),
                                    "lifetime": usd_str(self.lifetime)},
                       "entries": self.entries}, fh, indent=2)
        os.replace(tmp, self.ledger_path)

    def summary(self):
        return {"total_usd": usd_str(self.total()), "today_usd": usd_str(self.today_total()),
                "caps_usd": {"per_call": usd_str(self.per_call), "per_day": usd_str(self.per_day),
                             "lifetime": usd_str(self.lifetime)}}


# ------------------------------------------------------------------ signer
class EvmSigner:
    """Holds a key in memory only. Never logs or serializes it."""

    def __init__(self, private_key):
        from eth_account import Account  # paid mode only
        self._acct = Account.from_key(private_key)
        self.address = self._acct.address

    def __repr__(self):
        return f"EvmSigner({self.address})"

    @classmethod
    def from_wallet_file(cls, path):
        with open(path, encoding="utf-8") as fh:
            return cls(json.load(fh)["private_key"])

    def sign_authorization(self, to, value, asset, chain_id, name, version, valid_for_s=300, now=None):
        from eth_account.messages import encode_typed_data
        now = int(now if now is not None else time.time())
        auth = {"from": self.address, "to": to, "value": int(value), "validAfter": now - 600,
                "validBefore": now + int(valid_for_s), "nonce": "0x" + secrets.token_hex(32)}
        typed = {
            "types": {
                "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                                 {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
                "TransferWithAuthorization": [{"name": "from", "type": "address"}, {"name": "to", "type": "address"},
                                              {"name": "value", "type": "uint256"}, {"name": "validAfter", "type": "uint256"},
                                              {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"}],
            },
            "primaryType": "TransferWithAuthorization",
            "domain": {"name": name, "version": version, "chainId": chain_id, "verifyingContract": asset},
            "message": dict(auth, nonce=bytes.fromhex(auth["nonce"][2:])),
        }
        sig = self._acct.sign_message(encode_typed_data(full_message=typed)).signature.hex()
        if not sig.startswith("0x"):
            sig = "0x" + sig
        return sig, {k: (str(v) if isinstance(v, int) else v) for k, v in auth.items()}


def build_payment_header(challenge, option, signer, network="base"):
    net = NETWORKS[network]
    extra = option.get("extra") or {}
    sig, auth = signer.sign_authorization(option["payTo"], option_amount(option), option["asset"], net["chain_id"],
                                          extra.get("name", "USD Coin"), extra.get("version", "2"),
                                          valid_for_s=min(int(option.get("maxTimeoutSeconds") or 300), 3600))
    inner = {"signature": sig, "authorization": auth}
    if (challenge.get("x402_version") or 1) >= 2:
        payload = {"x402Version": 2, "resource": challenge.get("resource"), "accepted": option, "payload": inner}
        name = "PAYMENT-SIGNATURE"
    else:
        payload = {"x402Version": 1, "scheme": "exact", "network": option.get("network"), "payload": inner}
        name = "X-PAYMENT"
    return name, base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()


# ------------------------------------------------------------------ http
def build_request(svc):
    req = svc.get("sample_request") or {}
    url = svc["endpoint"]
    for k, v in (req.get("path_params") or {}).items():
        url = url.replace(":" + k, urllib.parse.quote(str(v), safe=""))
    if req.get("query"):
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode({k: str(v) for k, v in req["query"].items()})
    method = (req.get("method") or "GET").upper()
    data = json.dumps(req["json_body"]).encode() if req.get("json_body") is not None else None
    return method, url, data


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def http_call(method, url, data=None, extra_headers=None, timeout=20):
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    headers.update(extra_headers or {})
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    t0 = time.monotonic()
    try:
        resp = _OPENER.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        resp = e
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
        reason = getattr(e, "reason", e)
        return {"ok": False, "error": f"{type(e).__name__}: {reason}"[:300],
                "latency_ms": round((time.monotonic() - t0) * 1000)}
    try:
        body = resp.read(MAX_BODY_BYTES + 1) or b""
    except (socket.timeout, TimeoutError, OSError):
        body = b""
    latency = round((time.monotonic() - t0) * 1000)
    hdrs = {k: v for k, v in resp.headers.items()} if resp.headers else {}
    return {"ok": True, "status": resp.status if hasattr(resp, "status") else resp.code, "headers": hdrs,
            "body": body[:MAX_BODY_BYTES], "latency_ms": latency}


def _raw_response(r):
    if not r.get("ok"):
        return {"error": r.get("error"), "latency_ms": r.get("latency_ms")}
    keep = {}
    for k, v in r["headers"].items():
        kl = k.lower()
        if kl in KEEP_HEADERS:
            if kl in ("payment-required", "payment-response", "x-payment-response"):
                dec = _b64json(v.strip())
                if isinstance(dec, dict):
                    dec = {x: dec[x] for x in ("x402Version", "error", "resource", "accepts", "success",
                                               "transaction", "network", "payer") if x in dec}
                keep[kl] = {"decoded": dec} if dec is not None else {"raw_prefix": redact(v[:200])}
            else:
                keep[kl] = redact(v[:500])
    body = r["body"]
    return {"status": r["status"], "latency_ms": r["latency_ms"], "headers": keep, "body_bytes": len(body),
            "body_sha256": hashlib.sha256(body).hexdigest(),
            "body_excerpt": redact(body.decode("utf-8", errors="replace")[:BODY_EXCERPT_CHARS])}


def _valid_delivery(r):
    if not r.get("ok") or not (200 <= r["status"] < 300) or not r["body"]:
        return False
    ctype = next((v for k, v in r["headers"].items() if k.lower() == "content-type"), "")
    if "json" in ctype.lower():
        try:
            json.loads(r["body"].decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return False
    return True


# ------------------------------------------------------------------ one check
def check_service(svc, timeout=20, signer=None, guard=None, network="base", now=None):
    """Return (result, raw_log). Free check unless both signer and guard are given."""
    paid_mode = signer is not None and guard is not None
    method, url, data = build_request(svc)
    r = http_call(method, url, data, timeout=timeout)
    adv = Decimal(svc["advertised_price"]["amount_usd"]) if svc.get("advertised_price") else None
    res = {"service_id": svc["id"], "checked_at": iso_z(now), "mode": "paid" if paid_mode else "dry-run",
           "checker_version": CHECKER_VERSION, "request": {"method": method, "url": url},
           "reachable": bool(r.get("ok")), "http_status": r.get("status"), "latency_ms": r.get("latency_ms"),
           "error": r.get("error"), "x402_challenge": False, "x402_version": None,
           "advertised_price_usd": usd_str(adv), "quoted_price_usd": None, "price_matches_listing": None,
           "payment_options": [], "paid": False, "charged_price_usd": None, "delivered_valid": None,
           "delivered_status": None, "payment_refused_reason": None, "settlement_tx": None}
    raw = {"service_id": svc["id"], "note": "Raw check log. Third-party response text is untrusted data; emails are redacted and the body is truncated.",
           "request": {"method": method, "url": url, "json_body": svc.get("sample_request", {}).get("json_body"),
                       "payment_header_sent": False},
           "response": _raw_response(r)}
    ch = parse_challenge(r.get("status"), r.get("headers", {}), r.get("body", b"")) if r.get("ok") else None
    if ch:
        res["x402_challenge"] = ch["valid"]
        res["x402_version"] = ch["x402_version"]
        res["payment_options"] = summarize_options(ch)
        opt = pick_option(ch, "base") or (pick_option(ch, network) if network != "base" else None)
        if opt:
            q = usd(option_amount(opt))
            res["quoted_price_usd"] = usd_str(q)
            res["price_matches_listing"] = (adv is not None and q == adv)
    if not paid_mode:
        return res, raw

    # ---- paid path (only with --pay, a wallet and a guard)
    if not ch or not ch["valid"]:
        res["payment_refused_reason"] = "no valid x402 challenge"
        return res, raw
    opt = pick_option(ch, network)
    if not opt:
        res["payment_refused_reason"] = f"no USDC 'exact' (EIP-3009) option on {network}; will not sign for other tokens or networks"
        return res, raw
    amount = usd(option_amount(opt))
    try:
        guard.authorize(amount)
    except SpendRefused as e:
        res["payment_refused_reason"] = str(e)
        return res, raw
    name, value = build_payment_header(ch, opt, signer, network)
    guard.record(amount, svc["id"], "attempted")
    raw["request"]["payment_header_sent"] = True
    raw["request"]["payment_header_name"] = name
    r2 = http_call(method, url, data, extra_headers={name: value}, timeout=timeout)
    raw["paid_response"] = _raw_response(r2)
    res["paid"] = True
    res["delivered_status"] = r2.get("status")
    res["delivered_valid"] = _valid_delivery(r2)
    settle = None
    if r2.get("ok"):
        for k, v in r2["headers"].items():
            if k.lower() in ("payment-response", "x-payment-response"):
                settle = _b64json(v.strip())
    tx = settle.get("transaction") if isinstance(settle, dict) else None
    res["settlement_tx"] = tx
    if r2.get("ok") and 200 <= r2["status"] < 300:
        res["charged_price_usd"] = usd_str(amount)
        guard.update_last(status="settled" if tx else "delivered", tx=tx)
    else:
        guard.update_last(status=f"not delivered (HTTP {r2.get('status')})" if r2.get("ok") else "request failed")
    return res, raw
