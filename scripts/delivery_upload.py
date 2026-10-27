"""0.53.3: copy post-payment delivery checks from our paid check rounds into D1 delivery_checks (migration 0020).

Reads results/history.jsonl (written by run_checks.py; a paid, settled call carries delivery_flag/delivery_reason) and
writes one INSERT OR IGNORE per row: hkey, host, checked_at, flag, reason, http_status. Nothing else is copied (no body,
no tx hash, no wallet). Re-running is a no-op (PK hkey + checked_at).

Usage: python3 scripts/delivery_upload.py [--local|--remote] [--persist-to DIR] [--dry-run] [--history FILE] [--since ISO]
  --local (default) writes the wrangler dev local D1; --remote writes production D1 (owner OK only).
  --remote checks the D1 size first (wrangler d1 info --json) and writes nothing over D1_SIZE_MAX_MB / --max-mb (400).
"""
import argparse, hashlib, json, os, re, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB = "RECEIPTS_DB"
REASONS = {"server_error", "http_error", "empty_body", "challenge_page", "soft_paywall", "canned_refusal", "error_body", "placeholder_body", "no_response"}
_URL_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?")

def norm_url(u):
    """Same as normUrl() in worker/src/skips.js and crawl_probe.norm_url."""
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

def hkey(u): return "h:" + hashlib.sha256(norm_url(u).encode()).hexdigest()
def host_of(u):
    m = _URL_RE.match(norm_url(u)); return m.group(2) if m else None
def q(v): return "NULL" if v is None else str(int(v)) if isinstance(v, int) and not isinstance(v, bool) else "'" + str(v).replace("'", "''") + "'"

def rows_from(lines, since=None):
    out = []
    for line in lines:
        line = line.strip()
        if not line: continue
        r = json.loads(line)
        flag = r.get("delivery_flag")
        if flag not in ("ok", "failed") or not r.get("paid") or r.get("charged_price_usd") is None: continue
        url = (r.get("request") or {}).get("url")
        ts = r.get("checked_at")
        if not url or not ts or (since and ts < since): continue
        reason = r.get("delivery_reason") if flag == "failed" else None
        if flag == "failed" and reason not in REASONS: reason = "other"
        out.append({"hkey": hkey(url), "host": host_of(url), "checked_at": ts, "flag": flag, "reason": reason,
                    "http_status": r.get("delivered_status") if isinstance(r.get("delivered_status"), int) else None})
    return out

def sql(rows):
    return [f"INSERT OR IGNORE INTO delivery_checks (hkey, host, checked_at, flag, reason, http_status) VALUES ({q(r['hkey'])}, {q(r['host'])}, {q(r['checked_at'])}, {q(r['flag'])}, {q(r['reason'])}, {q(r['http_status'])});" for r in rows]

def _wrangler(args, check=True, capture=False):
    env = {k: v for k, v in os.environ.items() if k not in ("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN")}
    base = os.environ.get("DELIVERY_WRANGLER", "").split() or ["npx", "-y", "-p", "node@22", "-p", "wrangler@latest", "wrangler"]
    return subprocess.run([*base, *args], cwd=os.path.join(ROOT, "worker"), env=env, check=check, capture_output=capture, text=True)

# D1 size guard (same rule as worker/src/d1size.js): over D1_SIZE_MAX_MB (default 400) this writer stops and warns.
# Size comes from `wrangler d1 info <db> --json` (database_size, bytes). If it cannot be read, writes are skipped too.
D1_SIZE_MAX_MB_DEFAULT = 400
def d1_max_mb(cli=None):
    for v in (cli, os.environ.get("D1_SIZE_MAX_MB")):
        try:
            if v is not None and float(v) > 0: return float(v)
        except ValueError: pass
    return D1_SIZE_MAX_MB_DEFAULT

def d1_size_bytes():
    try:
        j = json.loads(_wrangler(["d1", "info", DB, "--json"], capture=True).stdout)
        v = j.get("database_size", j.get("file_size"))
        return int(v) if v is not None else None
    except Exception: return None

def d1_write_allowed(max_mb, writer="delivery_checks"):
    size = d1_size_bytes()
    if size is not None and size <= max_mb * 1e6: return True
    print(json.dumps({"d1_size_guard": "over" if size is not None else "unknown", "writer": writer,
                      "size_mb": round(size / 1e6, 1) if size is not None else None, "max_mb": max_mb, "skipped": True}), file=sys.stderr)
    return False

def main(argv=None):
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(); g.add_argument("--local", action="store_true"); g.add_argument("--remote", action="store_true")
    ap.add_argument("--persist-to"); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--since")
    ap.add_argument("--history", default=os.path.join(ROOT, "results", "history.jsonl"))
    ap.add_argument("--max-mb", help="D1 size guard ceiling in MB (default D1_SIZE_MAX_MB or 400); --remote only")
    a = ap.parse_args(argv)
    rows = rows_from(open(a.history, encoding="utf-8"), a.since)
    stmts = sql(rows)
    apply = bool(stmts) and not a.dry_run and (not a.remote or d1_write_allowed(d1_max_mb(a.max_mb)))
    print(json.dumps({"rows": len(rows), "failed": sum(1 for r in rows if r["flag"] == "failed"), "applied": apply}))
    if not apply: return 0
    where = ["--remote"] if a.remote else ["--local"] + (["--persist-to", a.persist_to] if a.persist_to else [])
    fp = os.path.join(tempfile.mkdtemp(prefix="delivery-"), "delivery.sql")
    open(fp, "w").write("\n".join(stmts) + "\n")
    _wrangler(["d1", "execute", DB, *where, "--file", fp])
    return 0

if __name__ == "__main__":
    sys.exit(main())
