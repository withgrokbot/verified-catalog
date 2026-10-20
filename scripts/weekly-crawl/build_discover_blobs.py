#!/usr/bin/env python3
"""0.45.0: build the discovery index as compressed, sharded blobs for D1 crawl_store (no per-row table, no KV).
Usage: build_discover_blobs.py <receipts-*.jsonl> <out.json>
Writes [{key, value}] for d:<verdict>:<hex> (48 shards, always all of them, so an emptied shard is overwritten) and
d:meta (last). value = base64(gzip(JSON, mtime=0)), deterministic: an unchanged shard keeps its sha256, so
d1_upload.py --source discover writes only the keys that changed."""
import base64, gzip, json, os, sys
VERDICTS, HEX = ("pay", "skip", "recheck"), "0123456789abcdef"

def build(path):
    run = os.path.basename(path).rsplit(".", 1)[0]
    shards = {(v, h): [] for v in VERDICTS for h in HEX}
    for line in open(path, encoding="utf-8"):
        if not line.strip(): continue
        r = json.loads(line)
        rid = r.get("id") or ""
        if len(rid) != 10 or any(c not in HEX for c in rid) or r.get("verdict") not in VERDICTS or not r.get("timestamp"): continue
        shards[(r["verdict"], rid[0])].append(r)
    out, counts, newest = [], {v: 0 for v in VERDICTS}, ""
    for (v, h), rows in shards.items():
        rows.sort(key=lambda r: r["id"])
        dicts = {k: [] for k in "rnas"}; idx = {k: {} for k in "rnas"}
        def ix(k, val):
            if val in (None, ""): val = None
            if val not in idx[k]: idx[k][val] = len(dicts[k]); dicts[k].append(val)
            return idx[k][val]
        packed = []
        for r in rows:
            price = r.get("quoted_price_usd")
            packed.append([r["id"], r.get("url") or r.get("norm_url"), r.get("also_listed_in") or [], ix("r", r.get("reason") or ""),
                           price if isinstance(price, (int, float)) and not isinstance(price, bool) else None,
                           ix("n", r.get("network")), ix("a", r.get("asset")), r.get("method") or None, ix("s", r.get("source_list")), r["timestamp"]])
            newest = max(newest, r["timestamp"])
        counts[v] += len(rows)
        blob = json.dumps({"v": 1, "dict": dicts, "rows": packed}, separators=(",", ":"), ensure_ascii=False).encode()
        out.append({"key": f"d:{v}:{h}", "value": base64.b64encode(gzip.compress(blob, 9, mtime=0)).decode()})
    meta = {"v": 1, "crawl_run": run, "newest_checked": newest, "rows": sum(counts.values()), "counts": counts, "shards": len(out)}
    out.append({"key": "d:meta", "value": json.dumps(meta, separators=(",", ":"))})
    return out, meta

if __name__ == "__main__":
    if len(sys.argv) != 3: print(__doc__); sys.exit(2)
    out, meta = build(sys.argv[1])
    json.dump(out, open(sys.argv[2], "w"))
    print(f"discover blobs: {meta['rows']} rows -> {meta['shards']} shards + d:meta, {sum(len(x['value']) for x in out)} bytes ({meta['counts']})")
