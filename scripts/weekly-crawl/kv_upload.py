"""Upload changed CRAWL_KV keys under a daily write budget (free plan: 1,000 writes/deletes/lists per UTC day).

Budget = min(KV_DAILY_BUDGET (600), 1000 - reserve (100, for the Worker's own cron writes) - writes already used today).
"Used today" = max(local ledger, Cloudflare GraphQL kvOperationsAdaptiveGroups when CF_API_TOKEN is set, read-only).
Keys go in order (shards/pages first, meta last); uploaded hashes are merged into uploaded.json, so a rerun on a later
day resumes with what is left. Exit 0 = all uploaded, 3 = some deferred (do not deploy the new bundle yet), 1 = error.
"""
import datetime as dt, hashlib, json, os, subprocess, sys, tempfile, urllib.request
KV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kv")
LIMIT, RESERVE, BUDGET = 1000, 100, int(os.environ.get("KV_DAILY_BUDGET", "600"))
ACCT = os.environ.get("CF_ACCOUNT_ID", "aa4453a0042a949537d2fcae99590a5f")
WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "app", "worker")
today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")

def gql_writes():
    tok = os.environ.get("CF_API_TOKEN")
    if not tok: return 0
    q = 'query($a:String!,$s:Time!){viewer{accounts(filter:{accountTag:$a}){kvOperationsAdaptiveGroups(limit:100,filter:{datetime_geq:$s,actionType_in:["write","delete","list"]}){sum{requests}}}}}'
    try:
        r = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql", json.dumps({"query": q, "variables": {"a": ACCT, "s": today + "T00:00:00Z"}}).encode(), {"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
        j = json.load(urllib.request.urlopen(r, timeout=30))
        return sum(g["sum"]["requests"] for g in j["data"]["viewer"]["accounts"][0]["kvOperationsAdaptiveGroups"])
    except Exception as e:
        print("graphql check failed (" + type(e).__name__ + "); using local ledger", file=sys.stderr); return 0

def main():
    changed = json.load(open(os.path.join(KV, "changed.json")))
    mp0 = os.path.join(KV, "uploaded.json")
    up0 = json.load(open(mp0)) if os.path.exists(mp0) else {}
    changed = [c for c in changed if up0.get(c["key"]) != hashlib.sha256(c["value"].encode()).hexdigest()]  # skip already-uploaded (unchanged) values
    if not changed: print("kv: nothing changed"); return 0
    lp, mp = os.path.join(KV, "ledger.json"), os.path.join(KV, "uploaded.json")
    ledger = json.load(open(lp)) if os.path.exists(lp) else {}
    used = max(ledger.get(today, 0), gql_writes())
    room = max(0, min(BUDGET, LIMIT - RESERVE - used))
    changed.sort(key=lambda b: b["key"] == "meta")  # meta last
    todo = changed[:room]
    print(f"kv: {len(changed)} changed, {used} writes used today (UTC {today}), budget {room}, uploading {len(todo)}")
    if todo:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f: json.dump(todo, f)
        env = {k: v for k, v in os.environ.items() if k not in ("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN")}
        subprocess.run(["npx", "-y", "-p", "node@22", "-p", "wrangler@latest", "wrangler", "kv", "bulk", "put", f.name, "--binding", "CRAWL_KV", "--remote"], cwd=WORKER, env=env, check=True)
        os.unlink(f.name)
        ledger[today] = ledger.get(today, 0) + len(todo)
        json.dump({d: n for d, n in ledger.items() if d >= (dt.date.fromisoformat(today) - dt.timedelta(days=14)).isoformat()}, open(lp, "w"))
        up = json.load(open(mp)) if os.path.exists(mp) else {}
        h = lambda v: hashlib.sha256(v.encode()).hexdigest()
        up.update({b["key"]: h(b["value"]) for b in todo}); json.dump(up, open(mp, "w"))
        rest = changed[len(todo):]; json.dump(rest, open(os.path.join(KV, "changed.json"), "w"))
    else:
        rest = changed
    if rest: print(f"kv: {len(rest)} keys deferred to a later UTC day; rerun to resume"); return 3
    print("kv: all changed keys uploaded"); return 0

if __name__ == "__main__":
    try: sys.exit(main())
    except Exception as e: print(f"kv_upload failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr); sys.exit(1)
