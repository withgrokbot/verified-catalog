#!/usr/bin/env python3
"""Minimal MCP server (stdio, newline-delimited JSON-RPC 2.0) for the verified catalog.

Tools:
  search_catalog(query?, category?, max_price_usd?, reachable_only?, limit?)
  get_service(id)

It only reads a local catalog.json (default: the one next to this folder). No network, no deps.
Run:  python3 mcp/server.py [--catalog path/to/catalog.json]
Not published to any registry.
"""
import json
import os
import sys
from decimal import Decimal, InvalidOperation

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
]


def handle(msg, cat):
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion") or PROTOCOL,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "verified-catalog", "version": "0.1.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        try:
            if name == "search_catalog":
                data = search(cat, args)
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
            out = {"jsonrpc": "2.0", "id": msg["id"], "result": handle(msg, cat)}
        except LookupError as ex:
            out = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": str(ex)}}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
