"""0.44.0: upload changed crawl keys to D1 (crawl_store, migration 0011) instead of Workers KV.

Same input as kv_upload.py (receipts/kv/changed.json = [{key, value}], built by build_worker_data.py). For each key,
the value is split into parts of <= PART_BYTES (a D1 SQL statement is capped at 100 KB): DELETE the key's old parts,
INSERT the new ones. Keys are grouped into SQL files of <= FILE_BYTES; D1 runs each file as one transaction, so a key's
parts always land together (and the Worker also checks the sha256 of the joined parts before serving). Only keys whose sha256 differs from what D1 holds are written
(D1 is asked first, read-only), so an unchanged week costs one SELECT. meta goes last.

Usage: python3 d1_upload.py [--local|--remote] [--persist-to DIR] [--dry-run] [--changed FILE]
  --local (default)  write the wrangler dev local D1 (nothing leaves the box)
  --remote           write production D1 (only after approval; the weekly script passes it with CRAWL_STORE=d1)
Exit 0 = all written (or nothing changed), 1 = error.
"""
import argparse, datetime as dt, hashlib, json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
KV = os.environ.get("CRAWL_KV_DIR", os.path.join(HERE, "..", "kv"))
WORKER = os.environ.get("CRAWL_WORKER_DIR", os.path.join(HERE, "..", "..", "app", "worker"))
PART_BYTES = 90_000
FILE_BYTES = 8_000_000
DB = "RECEIPTS_DB"

def sha(v): return hashlib.sha256(v.encode()).hexdigest()
def q(s): return "'" + s.replace("'", "''") + "'"

def split_parts(v, limit=PART_BYTES):
    """Split on character boundaries so every part's UTF-8 size is <= limit."""
    out, cur, size = [], [], 0
    for ch in v:
        b = len(ch.encode())
        if size + b > limit: out.append("".join(cur)); cur, size = [], 0
        cur.append(ch); size += b
    out.append("".join(cur))
    return out

def statements(key, value, now, source="crawl"):
    parts, h = split_parts(value), sha(value)
    sql = [f"DELETE FROM crawl_store WHERE key = {q(key)};"]
    for i, p in enumerate(parts):
        sql.append(f"INSERT INTO crawl_store (key, part, parts, sha256, value, source, updated_at) VALUES ({q(key)}, {i}, {len(parts)}, {q(h)}, {q(p)}, {q(source)}, {q(now)});")
    return sql, len(parts)

def wrangler(args, where):
    env = {k: v for k, v in os.environ.items() if k not in ("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN")}
    cmd = ["npx", "-y", "-p", "node@22", "-p", "wrangler@latest", "wrangler", "d1", "execute", DB, *where, *args]
    return subprocess.run(cmd, cwd=WORKER, env=env, check=True, capture_output=True, text=True).stdout

def current_hashes(where):
    out = wrangler(["--json", "--command", "SELECT key, sha256, COUNT(*) AS n, MAX(parts) AS parts FROM crawl_store GROUP BY key"], where)
    rows = json.loads(out)[0].get("results", [])
    return {r["key"]: r["sha256"] for r in rows if r["n"] == r["parts"]}  # incomplete keys count as changed

def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(); g.add_argument("--local", action="store_true"); g.add_argument("--remote", action="store_true")
    ap.add_argument("--persist-to"); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--changed", default=os.path.join(KV, "changed.json"))
    ap.add_argument("--source", default="crawl", choices=["crawl", "discover"])  # 0.45.0: discovery blobs (d: keys) share crawl_store
    a = ap.parse_args()
    where = ["--remote"] if a.remote else ["--local"] + (["--persist-to", a.persist_to] if a.persist_to else [])
    changed = json.load(open(a.changed))
    have = current_hashes(where)
    todo = [c for c in changed if have.get(c["key"]) != sha(c["value"])]
    todo.sort(key=lambda c: c["key"] in ("meta", "d:meta"))  # meta last, as with KV
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    files, cur, cur_b, rows = [], [], 0, 0
    for c in todo:
        st, n = statements(c["key"], c["value"], now, a.source); rows += n
        b = sum(len(x.encode()) for x in st)
        if cur and cur_b + b > FILE_BYTES: files.append(cur); cur, cur_b = [], 0
        cur += st; cur_b += b
    if cur: files.append(cur)
    print(f"d1: {len(changed)} keys in changed.json, {len(have)} already in D1, {len(todo)} to write ({rows} rows, {sum(len(c['value'].encode()) for c in todo)} bytes, {len(files)} files) [{' '.join(where)}]")
    if not todo or a.dry_run: return 0
    for sql in files:
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f: f.write("\n".join(sql) + "\n")
        try: wrangler(["--yes", "--file", f.name], where)
        finally: os.unlink(f.name)
    after = current_hashes(where)
    left = [c["key"] for c in todo if after.get(c["key"]) != sha(c["value"])]
    if left: print(f"d1: {len(left)} keys did not verify after the write"); return 1
    print(f"d1: all {len(todo)} changed keys written and verified"); return 0

if __name__ == "__main__":
    try: sys.exit(main())
    except subprocess.CalledProcessError as e: print(f"d1_upload failed: wrangler exit {e.returncode}: {(e.stderr or '')[-300:]}", file=sys.stderr); sys.exit(1)
    except Exception as e: print(f"d1_upload failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr); sys.exit(1)
