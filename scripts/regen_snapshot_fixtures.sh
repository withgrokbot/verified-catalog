#!/bin/bash
# 0.59.10: regenerate the byte-snapshot fixtures for the crawl bundled in worker/src (receipts-data.js / saves-data.js).
# Each fixture is re-taken from its ORIGINAL version (git archive of the commit it was taken on), with the bundled crawl
# data dropped in, by the current tests/helpers/machine_snapshot.mjs / bodies402.mjs (clock = noon UTC the day after the
# crawl). So a regenerated fixture differs from the old one only by what the crawl data changes. Output goes to
# tests/fixtures/<dir>/crawl-<stamp>/<file>; the 2026-10-27 crawl keeps its original fixtures (reproduced byte-for-byte by
# this script). Run from the repo root: scripts/regen_snapshot_fixtures.sh   (needs worker/node_modules, git history)
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
STAMP=$(node -e 'import("./tests/helpers/crawl_fixtures.mjs").then(m=>console.log(m.CRAWLED_AT===m.LEGACY_CRAWL?"":"crawl-"+m.CRAWL_STAMP))')
OUTSUB=${STAMP:+$STAMP/}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# fixture  commit-it-was-taken-on  helper-mode
MAP="machine_0.57.1/snapshot.json 5efdf33 snap
machine_0.58.2/extra.json 714e418 --extra
machine_0.58.3/snapshot.json 139fed1 --0583
machine_0.58.4/snapshot.json 1d5868d --0583
machine_0.58.4/receipts.json 1d5868d --receipts
machine_0.58.6/snapshot.json 17342a1 --0583
machine_0.58.6/receipts.json 17342a1 --receipts
machine_0.58.6/skips.json 17342a1 --skips
machine_0.58.7/snapshot.json 89da67f snap
machine_0.58.7/bodies402.json 89da67f bodies
machine_0.58.9/snapshot.json 8344dd7^ snap
machine_0.58.9/receipts.json 8344dd7^ --receipts"
while read -r f c m; do
  t="$TMP/$(echo "$c" | tr -d '^')"
  if [ ! -d "$t" ]; then mkdir -p "$t" && git archive "$c" worker | tar -x -C "$t" && ln -s "$ROOT/worker/node_modules" "$t/worker/node_modules"; fi
  cp worker/src/receipts-data.js worker/src/saves-data.js "$t/worker/src/"
  out="tests/fixtures/$(dirname "$f")/${OUTSUB}$(basename "$f")"; mkdir -p "$(dirname "$out")"
  case "$m" in
    snap) node tests/helpers/machine_snapshot.mjs "$t/worker/src/index.js" ;;
    bodies) node tests/helpers/bodies402.mjs "$t/worker/src/index.js" ;;
    *) node tests/helpers/machine_snapshot.mjs "$m" "$t/worker/src/index.js" ;;
  esac > "$out.tmp" || { echo "FAILED: $f (from $c $m)"; rm -f "$out.tmp"; exit 1; }
  mv "$out.tmp" "$out"
  echo "wrote $out (from $c $m)"
done <<< "$MAP"
