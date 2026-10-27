-- 0.56.0 per-host circuit breaker audit (worker/src/breaker.js). ONE row per breaker transition, never per request:
--   opened           closed -> open after BREAKER_FAILS failed probes in BREAKER_WINDOW_MIN
--   half_open_failed the single half-open probe after the cooldown failed -> open again for a full cooldown
--   closed           a successful probe closed an open/half-open breaker (normally the half-open probe)
-- A host_unstable answer (breaker open) writes nothing. id is a deterministic dedupe key (sha256 of host, event and the
-- episode), written with INSERT OR IGNORE, so racing isolates collapse to one row per transition.
-- Stored: the seller host (lower-case hostname only; never a path, query, client, IP or wallet), times, counts, kinds.
-- Additive and idempotent: CREATE ... IF NOT EXISTS only; no existing table is altered.
CREATE TABLE IF NOT EXISTS breaker_events (
  id TEXT PRIMARY KEY,              -- "be:" + sha256(host | event | episode key)
  host TEXT NOT NULL,               -- lower-case hostname
  event TEXT NOT NULL,              -- opened | half_open_failed | closed
  at TEXT NOT NULL,                 -- ISO 8601 UTC of the transition
  opened_at TEXT,                   -- ISO 8601 UTC: start of the open episode this row belongs to
  open_until TEXT,                  -- ISO 8601 UTC: end of the cooldown (opened / half_open_failed); NULL for closed
  fail_count INTEGER NOT NULL DEFAULT 0, -- failures that led here (opened: in the window; half_open_failed: 1; closed: 0)
  last_fail_kind TEXT,              -- server_error | timeout | connection_error (NULL for closed)
  last_status INTEGER,              -- HTTP status of the last failure (5xx), NULL otherwise
  trips INTEGER NOT NULL DEFAULT 0, -- times this host's breaker opened in the kept state (opened + half_open_failed)
  worker_version TEXT
);
CREATE INDEX IF NOT EXISTS breaker_events_host_at ON breaker_events (host, at);
CREATE INDEX IF NOT EXISTS breaker_events_at ON breaker_events (at);
