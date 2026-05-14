DO $$
BEGIN
  DROP INDEX IF EXISTS idx_standings_key_unique;
  DROP INDEX IF EXISTS idx_standings_lookup;
  DROP INDEX IF EXISTS idx_prca_standings_key_unique;
  DROP INDEX IF EXISTS idx_prca_standings_id_unique;

  IF to_regclass('public.scrape_runs') IS NOT NULL AND to_regclass('public.prca_scrape_runs') IS NULL THEN
    ALTER TABLE scrape_runs RENAME TO prca_scrape_runs;
  END IF;
  IF to_regclass('public.scrape_requests') IS NOT NULL AND to_regclass('public.prca_scrape_requests') IS NULL THEN
    ALTER TABLE scrape_requests RENAME TO prca_scrape_requests;
  END IF;
  IF to_regclass('public.event_types') IS NOT NULL AND to_regclass('public.prca_event_types') IS NULL THEN
    ALTER TABLE event_types RENAME TO prca_event_types;
  END IF;
  IF to_regclass('public.circuits') IS NOT NULL AND to_regclass('public.prca_circuits') IS NULL THEN
    ALTER TABLE circuits RENAME TO prca_circuits;
  END IF;
  IF to_regclass('public.tours') IS NOT NULL AND to_regclass('public.prca_tours') IS NULL THEN
    ALTER TABLE tours RENAME TO prca_tours;
  END IF;
  IF to_regclass('public.contestants') IS NOT NULL AND to_regclass('public.prca_contestants') IS NULL THEN
    ALTER TABLE contestants RENAME TO prca_contestants;
  END IF;
  IF to_regclass('public.standings') IS NOT NULL AND to_regclass('public.prca_standings') IS NULL THEN
    ALTER TABLE standings RENAME TO prca_standings;
  END IF;
  IF to_regclass('public.prca_standings') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'prca_standings'
         AND column_name = 'id'
         AND data_type = 'bigint'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'prca_standings'
         AND column_name = 'db_id'
     ) THEN
    ALTER TABLE prca_standings RENAME COLUMN id TO db_id;
  END IF;
  IF to_regclass('public.prca_standings') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'prca_standings'
         AND column_name = 'standings_key'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'prca_standings'
         AND column_name = 'id'
     ) THEN
    ALTER TABLE prca_standings RENAME COLUMN standings_key TO id;
  END IF;
  IF to_regclass('public.prca_standings') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.prca_standings'::regclass
        AND contype = 'p'
    ) THEN
      EXECUTE (
        SELECT 'ALTER TABLE prca_standings DROP CONSTRAINT ' || quote_ident(conname)
        FROM pg_constraint
        WHERE conrelid = 'public.prca_standings'::regclass
          AND contype = 'p'
        LIMIT 1
      );
    END IF;
  END IF;
  IF to_regclass('public.prca_standings') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'prca_standings'
         AND column_name = 'id'
     ) THEN
    ALTER TABLE prca_standings ADD COLUMN id TEXT;
  END IF;
  IF to_regclass('public.prca_standings') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'prca_standings'
         AND column_name = 'db_id'
     ) THEN
    ALTER TABLE prca_standings DROP COLUMN db_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS prca_scrape_runs (
  id BIGSERIAL PRIMARY KEY,
  run_type TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  target_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  rows_received INTEGER NOT NULL DEFAULT 0,
  rows_loaded INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS prca_scrape_requests (
  id BIGSERIAL PRIMARY KEY,
  scrape_run_id BIGINT REFERENCES prca_scrape_runs(id),
  source_url TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  http_status INTEGER,
  season_year INTEGER,
  standing_type TEXT,
  event_abbrev TEXT,
  tour_id INTEGER,
  circuit_id INTEGER,
  scope_id INTEGER,
  rows_received INTEGER NOT NULL DEFAULT 0,
  rows_loaded INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS prca_event_types (
  event_type_id INTEGER PRIMARY KEY,
  event_abbrev TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  is_standings_event BOOLEAN NOT NULL DEFAULT TRUE,
  is_results_event BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE prca_event_types
  ADD COLUMN IF NOT EXISTS is_standings_event BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE prca_event_types
  ADD COLUMN IF NOT EXISTS is_results_event BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS prca_circuits (
  circuit_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prca_tours (
  tour_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prca_contestants (
  contestant_id INTEGER PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  nick_name TEXT,
  hometown TEXT,
  sidearm_photo_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prca_standings (
  id TEXT PRIMARY KEY,
  standing_id INTEGER,
  season_year INTEGER NOT NULL,
  standing_type TEXT NOT NULL,
  event_abbrev TEXT NOT NULL REFERENCES prca_event_types(event_abbrev),
  contestant_id INTEGER NOT NULL REFERENCES prca_contestants(contestant_id),
  tour_id INTEGER REFERENCES prca_tours(tour_id),
  circuit_id INTEGER REFERENCES prca_circuits(circuit_id),
  place INTEGER,
  earnings NUMERIC(12,2),
  points NUMERIC(12,2),
  source_payload JSONB,
  scrape_request_id BIGINT REFERENCES prca_scrape_requests(id),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (season_year, standing_type, event_abbrev, contestant_id, tour_id, circuit_id)
);

CREATE INDEX IF NOT EXISTS idx_prca_standings_lookup
  ON prca_standings (season_year, standing_type, event_abbrev, place);

ALTER TABLE prca_standings
  ADD COLUMN IF NOT EXISTS id TEXT;

ALTER TABLE prca_standings
  ALTER COLUMN id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.prca_standings'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE prca_standings ADD CONSTRAINT prca_standings_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_prca_scrape_requests_run
  ON prca_scrape_requests (scrape_run_id, status);

CREATE INDEX IF NOT EXISTS idx_prca_scrape_requests_target
  ON prca_scrape_requests (season_year, standing_type, event_abbrev, scope_id);
