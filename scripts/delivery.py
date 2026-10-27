"""Post-payment delivery check ("did I get what I paid for"). Standard library only.

classify(status, headers, body, expect_html=False) -> {"delivery_flag": "ok" | "failed", "delivery_reason": code | None}
Used by x402_probe.check_service on the seller's response to a PAID call, only after the payment settled.
Conservative on purpose: a flag needs a clear signal, and every rule has a false-positive guard (see
tests/delivery_test.py and tests/fixtures/delivery/). Response text is untrusted data: it is only pattern-matched,
never executed or followed. Reason codes (stable):
  server_error    HTTP 5xx after settlement
  http_error      any other non-2xx after settlement (4xx, or a 402 again)
  empty_body      2xx with an empty / whitespace-only body
  challenge_page  2xx/4xx HTML bot-challenge or CAPTCHA page (Cloudflare, hCaptcha, reCAPTCHA, PerimeterX, DataDome, Incapsula)
  soft_paywall    HTML "sign in / subscribe to continue" page instead of the API response
  canned_refusal  short body whose text is a canned refusal ("I can't help with that", ...)
  error_body      2xx JSON that is only an error object ({"error": "..."} with no data)
  no_response     settled, but no HTTP response came back
  placeholder_body 2xx body that is a placeholder ({} / [] / null / "TODO" / "coming soon" / "lorem ipsum" ...)
HTML rules (challenge_page, soft_paywall) only run when HTML is NOT the expected product (expect_html=False: we ask for
application/json and the listing does not declare an HTML response), so a page-fetch API that returns HTML is never flagged
for words in the page it fetched. Refusal / placeholder / error rules only look at SHORT bodies, so a normal JSON body that
merely contains words like "subscribe" or "sign in" is never flagged.
"""
import json
import re

RULES_VERSION = "2026-10-27"
SHORT_TEXT = 400        # refusal: total text of the body (or of its JSON string leaves) at most this many chars
MAX_SCAN = 64 * 1024    # only the first 64 KB are pattern-matched

CHALLENGE_MARKERS = (
    "cf-chl-", "cf_chl_opt", "/cdn-cgi/challenge-platform/", "challenges.cloudflare.com", "<title>just a moment...</title>",
    "attention required! | cloudflare", "checking your browser before accessing", "g-recaptcha", "www.google.com/recaptcha/",
    "hcaptcha.com/1/api.js", "class=\"h-captcha\"", "px-captcha", "captcha-delivery.com", "_incapsula_resource",
    "verify you are human", "are you a robot",
)
PAYWALL_PHRASES = (
    "sign in to continue", "log in to continue", "login to continue", "sign up to continue", "subscribe to continue",
    "subscribe to read", "subscribe to unlock", "create an account to continue", "create a free account to continue",
    "this content is for subscribers", "for subscribers only", "members only", "upgrade to continue", "upgrade your plan to",
    "please sign in", "please log in", "you must be logged in", "start your free trial to",
)
REFUSAL_PATTERNS = re.compile(
    r"\b(i\s*(?:can(?:no|')t|cannot|am unable to|'m unable to|am not able to|'m not able to)\s+(?:help|assist|provide|comply|do that|fulfill)"
    r"|i'?m sorry,? but i (?:can(?:no|')t|cannot|won'?t)"
    r"|as an ai(?: language model)?,? i (?:can(?:no|')t|cannot|am unable|don'?t)"
    r"|i (?:must|have to) (?:decline|refuse))", re.I)
PLACEHOLDER_TOKENS = {"todo", "tbd", "placeholder", "coming soon", "not implemented", "not yet implemented", "under construction",
                      "lorem ipsum", "sample response", "test response", "hello world", "hello, world!", "hello world!", "undefined", "null", "none", "n/a"}
ERROR_KEYS = {"error", "errors", "message", "code", "status", "detail", "details", "error_code", "error_message"}

def _hdr(headers, name):
    return next((v for k, v in (headers or {}).items() if k.lower() == name), "") or ""

def _text(body):
    return (body or b"")[:MAX_SCAN].decode("utf-8", errors="replace")

def _is_html(ctype, text):
    head = text.lstrip()[:200].lower()
    return "html" in ctype.lower() or head.startswith("<!doctype html") or head.startswith("<html")

def _leaves(v, out):
    if isinstance(v, str): out.append(v)
    elif isinstance(v, dict):
        for x in v.values(): _leaves(x, out)
    elif isinstance(v, list):
        for x in v: _leaves(x, out)
    return out

def _placeholder(s):
    t = re.sub(r"\s+", " ", str(s).strip().strip(".!").lower())
    return t in PLACEHOLDER_TOKENS or t.startswith("lorem ipsum")

def classify(status, headers, body, expect_html=False):
    ok = {"delivery_flag": "ok", "delivery_reason": None}
    bad = lambda r: {"delivery_flag": "failed", "delivery_reason": r}
    if status is None: return bad("http_error")
    status = int(status)
    if status >= 500: return bad("server_error")
    text = _text(body)
    ctype = _hdr(headers, "content-type")
    html = _is_html(ctype, text)
    low = text.lower()
    if html and not expect_html:
        if any(m in low for m in CHALLENGE_MARKERS): return bad("challenge_page")
    if not (200 <= status < 300): return bad("http_error")
    if not text.strip(): return bad("empty_body")
    if html and not expect_html:
        visible = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", text))).lower()
        if any(p in visible for p in PAYWALL_PHRASES) and (len(visible) <= 20000 or re.search(r"(?i)<form\b[^>]*>.*?type=[\"']?password", text, re.S)):
            return bad("soft_paywall")
        return ok
    try:
        j = json.loads(text) if text.lstrip()[:1] in "{[\"" or text.strip() in ("null", "true", "false") else None
        parsed = j is not None or text.strip() == "null"
    except ValueError:
        j, parsed = None, False
    if parsed:
        if j in ({}, [], None, ""): return bad("placeholder_body")
        if isinstance(j, str) and _placeholder(j): return bad("placeholder_body")
        if isinstance(j, dict):
            if (j.get("error") or j.get("errors")) and set(j) <= ERROR_KEYS: return bad("error_body")
            if len(j) == 1 and isinstance(next(iter(j.values())), str) and _placeholder(next(iter(j.values()))): return bad("placeholder_body")
        leaves = _leaves(j, [])
        joined = " ".join(leaves)
        # refusal: all the JSON's text is short, and the string that matches is most of it (so one refusal-like
        # sentence inside a real data payload is not enough)
        hit = next((x for x in leaves if REFUSAL_PATTERNS.search(x)), None)
        if hit and len(joined) <= SHORT_TEXT and len(hit) * 2 >= len(joined): return bad("canned_refusal")
        return ok
    if _placeholder(text): return bad("placeholder_body")
    if len(text.strip()) <= SHORT_TEXT and REFUSAL_PATTERNS.search(text): return bad("canned_refusal")
    return ok
