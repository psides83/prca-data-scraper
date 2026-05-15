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
  featured BOOLEAN,
  birth_date DATE,
  age INTEGER,
  total_earnings NUMERIC(14,2),
  year_earnings NUMERIC(14,2),
  world_titles TEXT,
  nfr_qualifications TEXT,
  date_joined DATE,
  event_types TEXT[],
  biography_text TEXT,
  video_highlights TEXT,
  is_active BOOLEAN,
  show_inactive_bio_override BOOLEAN,
  hide_active_bio_override BOOLEAN,
  source_payload JSONB,
  image_original_key TEXT,
  image_original_url TEXT,
  image_315_key TEXT,
  image_315_url TEXT,
  image_synced_at TIMESTAMPTZ,
  image_sync_status TEXT,
  image_sync_error TEXT,
  generated_total_earnings NUMERIC(14,2),
  generated_world_titles INTEGER,
  generated_nfr_qualifications INTEGER,
  generated_fields_updated_at TIMESTAMPTZ,
  bio_synced_at TIMESTAMPTZ,
  bio_sync_status TEXT,
  bio_sync_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE prca_contestants
  ADD COLUMN IF NOT EXISTS featured BOOLEAN,
  ADD COLUMN IF NOT EXISTS birth_date DATE,
  ADD COLUMN IF NOT EXISTS age INTEGER,
  ADD COLUMN IF NOT EXISTS total_earnings NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS year_earnings NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS world_titles TEXT,
  ADD COLUMN IF NOT EXISTS nfr_qualifications TEXT,
  ADD COLUMN IF NOT EXISTS date_joined DATE,
  ADD COLUMN IF NOT EXISTS event_types TEXT[],
  ADD COLUMN IF NOT EXISTS biography_text TEXT,
  ADD COLUMN IF NOT EXISTS video_highlights TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN,
  ADD COLUMN IF NOT EXISTS show_inactive_bio_override BOOLEAN,
  ADD COLUMN IF NOT EXISTS hide_active_bio_override BOOLEAN,
  ADD COLUMN IF NOT EXISTS source_payload JSONB,
  ADD COLUMN IF NOT EXISTS image_original_key TEXT,
  ADD COLUMN IF NOT EXISTS image_original_url TEXT,
  ADD COLUMN IF NOT EXISTS image_315_key TEXT,
  ADD COLUMN IF NOT EXISTS image_315_url TEXT,
  ADD COLUMN IF NOT EXISTS image_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS image_sync_status TEXT,
  ADD COLUMN IF NOT EXISTS image_sync_error TEXT,
  ADD COLUMN IF NOT EXISTS derived_is_active BOOLEAN,
  ADD COLUMN IF NOT EXISTS derived_activity_reason TEXT,
  ADD COLUMN IF NOT EXISTS derived_activity_year INTEGER,
  ADD COLUMN IF NOT EXISTS derived_activity_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS generated_total_earnings NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS generated_world_titles INTEGER,
  ADD COLUMN IF NOT EXISTS generated_nfr_qualifications INTEGER,
  ADD COLUMN IF NOT EXISTS generated_fields_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bio_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bio_sync_status TEXT,
  ADD COLUMN IF NOT EXISTS bio_sync_error TEXT;

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

DROP TABLE IF EXISTS prca_athlete_career_summary;

CREATE OR REPLACE VIEW prca_app_athlete_rankings AS
SELECT
  s.contestant_id,
  s.season_year,
  s.event_abbrev,
  et.event_name,
  s.place AS world_rank,
  s.earnings,
  s.points,
  s.synced_at
FROM prca_standings s
JOIN prca_event_types et
  ON et.event_abbrev = s.event_abbrev
WHERE s.standing_type = 'world'
  AND s.season_year = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;

CREATE TABLE IF NOT EXISTS prca_rodeos (
  rodeo_id INTEGER PRIMARY KEY,
  rodeo_number INTEGER,
  season_year INTEGER,
  name TEXT,
  city TEXT,
  state_abbrv TEXT,
  start_date DATE,
  end_date DATE,
  payout NUMERIC(14,2),
  venue_name TEXT,
  circuit_id INTEGER,
  circuit_ids INTEGER[],
  tour_ids INTEGER[],
  in_progress BOOLEAN,
  is_active BOOLEAN,
  ap_results TEXT,
  source_payload JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prca_rodeos_dates
  ON prca_rodeos (start_date, end_date, season_year);

CREATE TABLE IF NOT EXISTS prca_rodeo_results (
  result_key TEXT PRIMARY KEY,
  rodeo_id INTEGER NOT NULL REFERENCES prca_rodeos(rodeo_id),
  contestant_id INTEGER NOT NULL REFERENCES prca_contestants(contestant_id),
  event_type TEXT,
  go_round INTEGER,
  go_round_label TEXT,
  place INTEGER,
  payoff NUMERIC(14,2),
  score NUMERIC(12,4),
  time NUMERIC(12,4),
  team_id INTEGER,
  stock_id INTEGER,
  stock_name TEXT,
  contractor_name TEXT,
  number_scores INTEGER,
  left_stock_score NUMERIC(12,4),
  right_stock_score NUMERIC(12,4),
  ride_timestamp TIMESTAMPTZ,
  source_payload JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prca_rodeo_results_contestant
  ON prca_rodeo_results (contestant_id, ride_timestamp, rodeo_id);

CREATE INDEX IF NOT EXISTS idx_prca_rodeo_results_rodeo
  ON prca_rodeo_results (rodeo_id, event_type, go_round);

CREATE TABLE IF NOT EXISTS prca_athlete_bio_refresh_queue (
  contestant_id INTEGER PRIMARY KEY REFERENCES prca_contestants(contestant_id),
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  source_rodeo_id INTEGER,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_prca_athlete_bio_refresh_queue_status
  ON prca_athlete_bio_refresh_queue (status, last_seen_at);

DO $$
BEGIN
  IF to_regclass('public.prca_athlete_bios') IS NOT NULL THEN
    UPDATE prca_contestants c
    SET biography_text = COALESCE(c.biography_text, b.biography_text),
        video_highlights = COALESCE(c.video_highlights, b.video_highlights),
        source_payload = COALESCE(c.source_payload, b.source_payload),
        bio_synced_at = COALESCE(c.bio_synced_at, b.synced_at),
        bio_sync_status = COALESCE(c.bio_sync_status, b.sync_status),
        bio_sync_error = COALESCE(c.bio_sync_error, b.sync_error),
        updated_at = NOW()
    FROM prca_athlete_bios b
    WHERE c.contestant_id = b.contestant_id;
  END IF;
END $$;

DROP TABLE IF EXISTS prca_athlete_bios;

DROP TABLE IF EXISTS prca_athlete_results;
DROP TABLE IF EXISTS prca_athlete_averages;

CREATE TABLE IF NOT EXISTS prca_athlete_career (
  contestant_id INTEGER NOT NULL REFERENCES prca_contestants(contestant_id),
  season_year INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  earnings NUMERIC(14,2),
  world_titles INTEGER,
  nfr_qualified BOOLEAN,
  riding_statistics JSONB,
  timed_statistics JSONB,
  source_payload JSONB,
  source_standing_type TEXT,
  circuit_id INTEGER,
  world_rank INTEGER,
  won_world_title BOOLEAN NOT NULL DEFAULT FALSE,
  source_standings_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contestant_id, season_year, event_type)
);

ALTER TABLE prca_athlete_career
  ADD COLUMN IF NOT EXISTS source_standing_type TEXT,
  ADD COLUMN IF NOT EXISTS circuit_id INTEGER,
  ADD COLUMN IF NOT EXISTS world_rank INTEGER,
  ADD COLUMN IF NOT EXISTS won_world_title BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source_standings_id TEXT;

CREATE INDEX IF NOT EXISTS idx_prca_athlete_career_lookup
  ON prca_athlete_career (contestant_id, season_year);

CREATE TABLE IF NOT EXISTS prca_athlete_rankings (
  contestant_id INTEGER NOT NULL REFERENCES prca_contestants(contestant_id),
  season_year INTEGER NOT NULL,
  rank_type TEXT NOT NULL,
  event_name TEXT NOT NULL,
  rank_label TEXT,
  rank_number INTEGER,
  tour_id INTEGER,
  circuit_id INTEGER,
  source_payload JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (contestant_id, season_year, rank_type, event_name, tour_id, circuit_id)
);

CREATE INDEX IF NOT EXISTS idx_prca_athlete_rankings_lookup
  ON prca_athlete_rankings (contestant_id, season_year, rank_type);

CREATE TABLE IF NOT EXISTS prca_athlete_earnings (
  contestant_id INTEGER NOT NULL REFERENCES prca_contestants(contestant_id),
  season_year INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  earning_index INTEGER NOT NULL,
  earnings NUMERIC(14,2),
  source_payload JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contestant_id, season_year, event_type, earning_index)
);

CREATE INDEX IF NOT EXISTS idx_prca_athlete_earnings_lookup
  ON prca_athlete_earnings (contestant_id, season_year);

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
