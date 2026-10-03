#!/usr/bin/env python3
"""Minimal MCP server (stdio, newline-delimited JSON-RPC 2.0) for the verified catalog.

Tools:
  search_catalog(query?, category?, max_price_usd?, reachable_only?, limit?)   local catalog.json, no network
  get_service(id)                                                              local catalog.json, no network
  lookup(task?, max_price_usd?, n?, endpoint?, payer?, limit?)                 calls the reliability lookup Worker

`lookup` is the only tool that uses the network: one GET to the lookup Worker with client=vc-mcp (so MCP users are
counted as one client name, never by IP). The Worker URL comes from --lookup-url, env VC_LOOKUP_URL, the
catalog's lookup_url, or DEFAULT_LOOKUP_URL (in that order); VC_LOOKUP_URL=off turns the tool off. No deps.
Run:  python3 mcp/server.py [--catalog path/to/catalog.json] [--lookup-url https://.../]
Not published to any registry.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, InvalidOperation

MCP_CLIENT = "vc-mcp"
DEFAULT_LOOKUP_URL = "https://verified-catalog-lookup.withgrokbot.workers.dev/"
LOOKUP_TIMEOUT_S = 15

PROTOCOL = "2025-06-18"
HERE = os.path.dirname(os.path.abspath(__file__))


def load_catalog(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def brief(s):
    latest = s.get("latest") or {}
    return {"id": s["id"], "name": s["name"], "category": s.get("category"), "endpoint": s.get("endpoint"),
            "advertised_price_usd": (s.get("advertised_price") or {}).get("amount_usd"),
            "latest": {k: latest.get(k) for k in ("checked_at", "reachable", "http_status", "latency_ms",
                                                   "quoted_price_usd", "price_matches_listing", "charged_price_usd",
                                                   "delivered_valid", "raw_log_url")},
            "page_url": s.get("page_url")}


def search(cat, args):
    q = str(args.get("query") or "").lower().strip()
    category = str(args.get("category") or "").lower().strip()
    limit = int(args.get("limit") or 20)
    maxp = None
    if args.get("max_price_usd") not in (None, ""):
        try:
            maxp = Decimal(str(args["max_price_usd"]))
        except InvalidOperation:
            raise ValueError("max_price_usd must be a number")
    out = []
    for s in cat.get("services", []):
        hay = " ".join(str(s.get(k, "")) for k in ("id", "name", "category", "description", "provider")).lower()
        if q and not all(w in hay for w in q.split()):
            continue
        if category and category not in str(s.get("category", "")).lower():
            continue
        if maxp is not None and Decimal(s["advertised_price"]["amount_usd"]) > maxp:
            continue
        if args.get("reachable_only") and not (s.get("latest") or {}).get("reachable"):
            continue
        out.append(brief(s))
    return {"count": len(out[:limit]), "results": out[:limit], "generated_at": cat.get("generated_at"),
            "note": "Factual check results only; no grades. See methodology_url.", "methodology_url": cat.get("methodology_url")}


def lookup(cat, args, lookup_url):
    if not lookup_url:
        return None, "The lookup endpoint is not configured (VC_LOOKUP_URL=off, or no --lookup-url, VC_LOOKUP_URL, catalog lookup_url or default)."
    q = {"client": MCP_CLIENT}
    if args.get("task"):
        q["task"] = str(args["task"])
    if args.get("max_price_usd") not in (None, ""):
        try:
            q["max_price"] = format(Decimal(str(args["max_price_usd"])), "f")
        except InvalidOperation:
            return None, "max_price_usd must be a number"
    for k in ("n", "limit"):
        if args.get(k) not in (None, ""):
            q[k] = str(int(args[k]))
    for k in ("endpoint", "payer"):
        if args.get(k):
            q[k] = str(args[k])
    if "task" not in q and "endpoint" not in q:
        return None, "give a task (e.g. web-search) or an endpoint (service id or URL)"
    url = lookup_url.rstrip("/") + "/v1/lookup?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "verified-catalog-mcp/0.2"})
    try:
        with urllib.request.urlopen(req, timeout=LOOKUP_TIMEOUT_S) as resp:
            return json.loads(resp.read(2_000_000).decode("utf-8")), None
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read(100_000).decode("utf-8")).get("error")
        except (ValueError, UnicodeDecodeError, AttributeError):
            detail = None
        if e.code == 402:
            return None, ("lookup returned HTTP 402: " + (detail or "free lookups used up for today") +
                          " Call the lookup URL directly with an x402 client to pay $0.02 USDC on Base; payment never changes results.")
        return None, f"lookup returned HTTP {e.code}" + (f": {detail}" if detail else "")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        return None, f"lookup request failed: {getattr(e, 'reason', e)}"


TOOLS = [
    {"name": "search_catalog",
     "description": "Search pay-per-call (x402) agent services in the verified catalog. Returns factual latest-check results (reachable, latency, advertised vs quoted price). No grades.",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "words to match in name, category, description"},
         "category": {"type": "string"},
         "max_price_usd": {"type": "number", "description": "maximum advertised price per call in USD"},
         "reachable_only": {"type": "boolean", "description": "only services reachable in the latest check"},
         "limit": {"type": "integer", "minimum": 1, "maximum": 100}}}},
    {"name": "get_service",
     "description": "Get the full catalog record for one service id, including its latest check and raw log link.",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "lookup",
     "description": "Is an x402 endpoint reliable for a task at a price? Asks the catalog's lookup service for services matching a task "
                    "at or under max_price_usd, sorted by known-answer pass rate over the last n paid calls, then price. Each result has "
                    "its paid receipts (time, tx, Basescan link, charged, delivered, pass/fail), last check time and a stale flag. "
                    "Services broken on the seller's side come back under facts_only, not sorted. Sends client=vc-mcp: 5 free lookups per UTC day "
                    "for that client name, then the service answers HTTP 402 (x402, $0.02 USDC on Base), which this tool reports but does not pay. "
                    "Payment never changes results, sort order or listings.",
     "inputSchema": {"type": "object", "properties": {
         "task": {"type": "string", "description": "task name, e.g. web-search, crypto-news, weather, token-balance"},
         "max_price_usd": {"type": "number", "description": "maximum listed price per call in USD"},
         "n": {"type": "integer", "minimum": 1, "maximum": 20, "description": "paid receipts per service (default 5)"},
         "limit": {"type": "integer", "minimum": 1, "maximum": 20, "description": "services returned (default 10)"},
         "endpoint": {"type": "string", "description": "a service id or endpoint URL instead of a task"},
         "payer": {"type": "string", "description": "optional: your 0x wallet, so a later payment to a returned vendor can be confirmed on-chain"}}}},
]


def handle(msg, cat, lookup_url=None):
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion") or PROTOCOL,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "verified-catalog", "version": "0.2.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        try:
            if name == "search_catalog":
                data = search(cat, args)
            elif name == "lookup":
                data, err = lookup(cat, args, lookup_url)
                if err:
                    return {"content": [{"type": "text", "text": err}], "isError": True}
            elif name == "get_service":
                match = [s for s in cat.get("services", []) if s["id"] == args.get("id")]
                if not match:
                    return {"content": [{"type": "text", "text": f"no service with id {args.get('id')!r}"}], "isError": True}
                data = match[0]
            else:
                raise KeyError(name)
        except KeyError:
            raise LookupError(f"unknown tool {name!r}")
        except ValueError as ex:
            return {"content": [{"type": "text", "text": str(ex)}], "isError": True}
        return {"content": [{"type": "text", "text": json.dumps(data, indent=2)}], "structuredContent": data}
    raise LookupError(f"method not found: {method}")


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    path = os.path.join(os.path.dirname(HERE), "catalog.json")
    if "--catalog" in argv:
        path = argv[argv.index("--catalog") + 1]
    cat = load_catalog(path)
    lookup_url = None
    if "--lookup-url" in argv:
        lookup_url = argv[argv.index("--lookup-url") + 1]
    lookup_url = lookup_url or os.environ.get("VC_LOOKUP_URL") or cat.get("lookup_url") or DEFAULT_LOOKUP_URL
    if lookup_url.strip().lower() == "off":
        lookup_url = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}) + "\n")
            sys.stdout.flush()
            continue
        if "id" not in msg:  # notification (e.g. notifications/initialized)
            continue
        try:
            out = {"jsonrpc": "2.0", "id": msg["id"], "result": handle(msg, cat, lookup_url)}
        except LookupError as ex:
            out = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": str(ex)}}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
