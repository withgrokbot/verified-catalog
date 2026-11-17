#!/bin/bash
# 0.59.10: regenerate the byte-snapshot fixtures for the crawl bundled in worker/src (receipts-data.js / saves-data.js).
# Delegates to tests/helpers/generate_crawl_fixtures.mjs. Each fixture is re-taken from its ORIGINAL version
# (git archive of the commit it was taken on), with the bundled crawl data dropped in, by the current
# tests/helpers/machine_snapshot.mjs / bodies402.mjs (clock = noon UTC the day after the crawl).
# By default the test suite generates missing fixtures into a temp cache, so a weekly crawl refresh does
# not need a committed crawl-<stamp> directory. Pass --repo to write into tests/fixtures/<dir>/crawl-<stamp>/.
# The 2026-10-27 crawl keeps its original fixtures at tests/fixtures/<dir>/.
# Run from the repo root: scripts/regen_snapshot_fixtures.sh [--repo] [--force]
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
exec node tests/helpers/generate_crawl_fixtures.mjs --repo "$@"
