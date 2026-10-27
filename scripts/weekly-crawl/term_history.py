"""Crawl term history: after each weekly crawl, record per-endpoint payment terms in D1 table term_history (migration 0019),
appending a row ONLY when an endpoint's terms change (amount, pay_to, network, asset); an unchanged endpoint just moves
its open row's last_seen forward. Change-only rows keep storage small (see --estimate).

Input: the crawl receipts JSONL (crawl_probe.py). Only records whose 402 was parsed (network + pay_to present) count;
unreachable / no-402 / not-probed records are not terms observations and change nothing.
Key: endpoint_key = "h:" + sha256(norm_url), same as the Worker's historyKey / endpoint_history.hkey.

Usage:
  python3 term_history.py [--local|--remote] [--persist-to DIR] [--dry-run] [--out DIR] RECEIPTS.jsonl [MORE.jsonl ...]
      Reads the open rows from that D1 (read-only SELECT), diffs, writes SQL files, applies them (skipped with --dry-run).
      --remote checks the D1 size first (wrangler d1 info --json) and writes nothing over D1_SIZE_MAX_MB / --max-mb (400); unknown size = write + warn.
      Several files = backfill, applied oldest first. --local is the default (nothing leaves the box); --remote only
      with the owner's OK (weekly_refresh_skips.sh passes it when TERM_HISTORY=1).
  python3 term_history.py --estimate RECEIPTS.jsonl [MORE.jsonl ...]
      Replays the files on a scratch in-memory SQLite with migration 0019 and prints rows and bytes. Reads nothing remote.
Exit 0 = ok, 1 = error.
"""
import argparse, hashlib, json, os, sqlite3, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.environ.get("CRAWL_WORKER_DIR", os.path.join(HERE, "..", "..", "app", "worker"))
MIGRATION = "0019_term_history.sql"
DB = "RECEIPTS_DB"
FILE_BYTES = 8_000_000
FIELDS = ("amount", "pay_to", "network", "asset")

def q(v): return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"
def endpoint_key(norm_url): return "h:" + hashlib.sha256(str(norm_url).encode()).hexdigest()

def _addr(v):
    """EVM hex addresses compare case-insensitively (stored lower-case); anything else (e.g. Solana base58) as-is."""
    if v is None: return None
    s = str(v).strip()
    return s.lower() if s[:2].lower() == "0x" else s

def _amount(r):
    """Atomic amount: the crawl's amount_atomic (0.52.x crawls). Older crawls only kept quoted_price_usd, which is set
    only for canonical USDC (6 decimals), so round(usd * 1e6) is exact there; otherwise unknown (None)."""
    a = r.get("amount_atomic")
    if a is not None:
        try: return str(int(str(a)))
        except Exception: return None
    u = r.get("quoted_price_usd")
    return str(round(float(u) * 1_000_000)) if isinstance(u, (int, float)) else None

def terms_of(r):
    """(key, ts, terms) for a record with observed terms, else None."""
    if not r.get("network") or not r.get("pay_to") or not r.get("timestamp"): return None
    norm = r.get("norm_url") or r.get("url")
    if not norm: return None
    return endpoint_key(norm), r["timestamp"], {"amount": _amount(r), "pay_to": _addr(r["pay_to"]), "network": str(r["network"]), "asset": _addr(r.get("asset"))}

def observations(path):
    """Latest observation per endpoint in one crawl file (a URL listed twice counts once)."""
    out = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            t = terms_of(json.loads(line))
            if t and (t[0] not in out or t[1] > out[t[0]][0]): out[t[0]] = (t[1], t[2])
    return out

def diff(open_rows, obs):
    """open_rows: {key: {first_seen, last_seen, amount, pay_to, network, asset}} (the latest row per key).
    obs: {key: (ts, terms)}. Returns (inserts, bumps); open_rows is updated in place so several crawls can be chained.
    inserts: new rows (terms changed or first sighting). bumps: (key, first_seen, ts) to move last_seen forward.
    An observation not newer than the open row's last_seen is ignored (re-running the same crawl is a no-op)."""
    inserts, bumps = [], []
    for k in sorted(obs):
        ts, t = obs[k]
        cur = open_rows.get(k)
        if cur and ts <= cur["last_seen"]: continue
        if cur and all(cur.get(f) == t[f] for f in FIELDS):
            bumps.append((k, cur["first_seen"], ts)); cur["last_seen"] = ts
        else:
            row = {"endpoint_key": k, "first_seen": ts, "last_seen": ts, **t}
            inserts.append(row); open_rows[k] = dict(row)
    return inserts, bumps

def sql_statements(inserts, bumps):
    out = [f"INSERT OR IGNORE INTO term_history (endpoint_key, first_seen, last_seen, amount, pay_to, network, asset) VALUES ({q(r['endpoint_key'])}, {q(r['first_seen'])}, {q(r['last_seen'])}, {q(r['amount'])}, {q(r['pay_to'])}, {q(r['network'])}, {q(r['asset'])});" for r in inserts]
    out += [f"UPDATE term_history SET last_seen = {q(ts)} WHERE endpoint_key = {q(k)} AND first_seen = {q(fs)} AND last_seen < {q(ts)};" for k, fs, ts in bumps]
    return out

OPEN_SQL = ("SELECT endpoint_key, first_seen, last_seen, amount, pay_to, network, asset FROM term_history t "
            "WHERE first_seen = (SELECT MAX(first_seen) FROM term_history WHERE endpoint_key = t.endpoint_key)")
def open_from_rows(rows): return {r["endpoint_key"]: dict(r) for r in rows}

def chunk(stmts, limit=FILE_BYTES):
    files, cur, size = [], [], 0
    for s in stmts:
        b = len(s.encode()) + 1
        if cur and size + b > limit: files.append(cur); cur, size = [], 0
        cur.append(s); size += b
    if cur: files.append(cur)
    return files

def _wrangler(args):
    env = {k: v for k, v in os.environ.items() if k not in ("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN")}
    base = os.environ.get("TERM_HISTORY_WRANGLER", "").split() or ["npx", "-y", "-p", "node@22", "-p", os.environ.get("WRANGLER_PKG", "wrangler@4.154.0"), "wrangler"]  # override: local tests
    return subprocess.run([*base, *args], cwd=WORKER, env=env, check=True, capture_output=True, text=True).stdout

def wrangler(args, where): return _wrangler(["d1", "execute", DB, *where, *args])

# D1 size guard (same rule as worker/src/d1size.js): over D1_SIZE_MAX_MB (default 400) this writer stops and warns.
# Size comes from `wrangler d1 info <db> --json` (database_size, bytes). If it cannot be read, writes go ahead with a warning (as in the Worker).
D1_SIZE_MAX_MB_DEFAULT = 400
def d1_max_mb(cli=None):
    for v in (cli, os.environ.get("D1_SIZE_MAX_MB")):
        try:
            if v is not None and float(v) > 0: return float(v)
        except ValueError: pass
    return D1_SIZE_MAX_MB_DEFAULT

def d1_size_bytes():
    try:
        j = json.loads(_wrangler(["d1", "info", DB, "--json"]))
        v = j.get("database_size", j.get("file_size"))
        return int(v) if v is not None else None
    except Exception: return None

def d1_write_allowed(max_mb, writer="term_history"):
    size = d1_size_bytes()
    if size is None:  # same as the Worker: unknown size does not block writes, but say so
        print(json.dumps({"d1_size_guard": "unknown", "writer": writer, "size_mb": None, "max_mb": max_mb, "skipped": False}), file=sys.stderr)
        return True
    if size <= max_mb * 1e6: return True
    print(json.dumps({"d1_size_guard": "over", "writer": writer, "size_mb": round(size / 1e6, 1), "max_mb": max_mb, "skipped": True}), file=sys.stderr)
    return False

def migration_sql():
    """0019 from the repo checkout (scripts/weekly-crawl/../../worker) or the factory app (CRAWL_WORKER_DIR)."""
    for d in (os.path.join(HERE, "..", "..", "worker"), WORKER):
        p = os.path.join(d, "migrations", MIGRATION)
        if os.path.exists(p): return open(p).read()
    raise FileNotFoundError(MIGRATION)

def estimate(paths):
    db = sqlite3.connect(":memory:"); db.row_factory = sqlite3.Row
    db.executescript(migration_sql())
    opened, report = {}, []
    for p in paths:
        obs = observations(p)
        ins, bumps = diff(opened, obs)
        db.executescript("\n".join(sql_statements(ins, bumps)))
        report.append({"file": os.path.basename(p), "observed": len(obs), "new_rows": len(ins), "last_seen_updates": len(bumps)})
    db.commit()
    n = db.execute("SELECT COUNT(*) FROM term_history").fetchone()[0]
    payload = db.execute("SELECT SUM(LENGTH(endpoint_key)+LENGTH(first_seen)+LENGTH(last_seen)+IFNULL(LENGTH(amount),0)+IFNULL(LENGTH(pay_to),0)+IFNULL(LENGTH(network),0)+IFNULL(LENGTH(asset),0)) FROM term_history").fetchone()[0] or 0
    tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False).name
    disk = sqlite3.connect(tmp); db.backup(disk); disk.execute("VACUUM"); disk.close()
    size = os.path.getsize(tmp)
    os.unlink(tmp)
    return {"runs": report, "rows": n, "payload_bytes": payload, "sqlite_file_bytes": size, "bytes_per_row_on_disk": round(size / n, 1) if n else None}

def main(argv=None):
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(); g.add_argument("--local", action="store_true"); g.add_argument("--remote", action="store_true"); g.add_argument("--estimate", action="store_true")
    ap.add_argument("--persist-to"); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--out")
    ap.add_argument("--max-mb", help="D1 size guard ceiling in MB (default D1_SIZE_MAX_MB or 400); --remote only")
    ap.add_argument("files", nargs="+")
    a = ap.parse_args(argv)
    files = sorted(a.files, key=os.path.basename)  # receipts-YYYYMMDDTHHMMSSZ.jsonl: name order = time order
    if a.estimate: print(json.dumps(estimate(files), indent=2)); return 0
    where = ["--remote"] if a.remote else ["--local"] + (["--persist-to", a.persist_to] if a.persist_to else [])
    opened = open_from_rows(json.loads(wrangler(["--json", "--command", OPEN_SQL], where))[0].get("results", []))
    ins_all, bump_all = [], []
    for p in files:
        ins, bumps = diff(opened, observations(p)); ins_all += ins; bump_all += bumps
    stmts = sql_statements(ins_all, bump_all)
    out = a.out or tempfile.mkdtemp(prefix="term-history-")
    os.makedirs(out, exist_ok=True)
    paths = []
    for i, c in enumerate(chunk(stmts)):
        fp = os.path.join(out, f"term_history_{i:03d}.sql"); open(fp, "w").write("\n".join(c) + "\n"); paths.append(fp)
    apply = not a.dry_run and (not a.remote or d1_write_allowed(d1_max_mb(a.max_mb)))
    print(json.dumps({"new_rows": len(ins_all), "last_seen_updates": len(bump_all), "sql_files": len(paths), "out": out, "applied": apply}))
    if apply:
        for fp in paths: wrangler(["--file", fp], where)
    return 0

if __name__ == "__main__":
    try: sys.exit(main())
    except subprocess.CalledProcessError as e:  # 0.53.4: full wrangler stderr in the run log
        print(f"term_history failed: wrangler exit {e.returncode}\n--- wrangler stderr ---\n{e.stderr or ''}\n--- wrangler stdout ---\n{e.stdout or ''}", file=sys.stderr); sys.exit(1)
