# PRCA Standings -> Neon

Ingest standings data from the ProRodeo API into Neon/Postgres with normalized tables and idempotent upserts.

## Scripts

- `npm run db:init`: create tables
- `npm run standings:sync`: one standings request (manual testing)
- `npm run standings:backfill`: full historical backfill
- `npm run standings:daily`: current season full sync for daily scheduling
- `npm run standings:retry-failed`: retry failed standings requests only
- `npm run contestants:cleanup-photo-urls`: normalize existing contestant photo URLs
- `npm run contestants:import`: import contestants from `data/prca_contestants.json`
- `npm run contestants:sync`: sync latest contestants from the PRCA athletes endpoint
- `npm run contestants:sync-images`: download contestant images and upload original/315px versions to Cloudflare R2
- `npm run athletes:sync-bios`: sync athlete bio/details for distinct contestants found in `prca_standings`
- `npm run athletes:generate-derived`: regenerate app-facing athlete totals, career, earnings, and rankings from standings
- `npm run results:daily`: discover recent result rodeos, store rodeo result rows, and queue affected athletes for bio refresh

## GitHub Actions

Daily standings scraping is configured in `.github/workflows/prca-standings-daily.yml`.
Weekly contestant profile syncing is configured in `.github/workflows/prca-contestants-weekly.yml`.
Daily recent-results discovery and queued athlete bio refresh is configured in `.github/workflows/prca-results-bios-daily.yml`.

Required repository secret:

- `DATABASE_URL`: Neon Postgres connection string
- `R2_ACCOUNT_ID`: Cloudflare account id
- `R2_ACCESS_KEY_ID`: R2 access key id
- `R2_SECRET_ACCESS_KEY`: R2 secret access key
- `R2_BUCKET`: R2 bucket name
- `R2_PUBLIC_BASE_URL`: public bucket/custom-domain base URL

The standings workflow runs every day at `11:00 UTC` and can also be started manually from the GitHub Actions tab. It initializes the schema, runs `standings:daily`, retries unresolved failed targets, then regenerates standings-derived athlete fields.

The contestants workflow runs every Monday at `12:00 UTC` and can also be started manually. It initializes the schema, runs `contestants:sync`, then runs `contestants:sync-images`.

The recent-results workflow runs every day at `11:30 UTC` and can also be started manually. It initializes the schema, runs `results:daily`, then runs `athletes:sync-bios` with `ATHLETE_BIO_SCOPE=active_or_queued`.

## Backfill scope

`standings:backfill` runs all combinations for each year from `START_YEAR` to `END_YEAR`:

- every event from `/eventtypes` where `IsStandingsEvent = true`, except `TR`
- `world`
- `rookie`
- `permit`
- each active `tour` with its `tour_id`
- each active `circuit` with its `circuit_id`

## Daily scope

`standings:daily` runs the same scope, but only for current season (`SEASON_YEAR` if set, otherwise current UTC year).

## Retry failures

`standings:retry-failed` finds failed rows in `prca_scrape_requests` and reruns only those targets. It creates a new `prca_scrape_runs` row with `run_type = standings_retry_failed`.

Optional filters:

- `RETRY_SCRAPE_RUN_ID`: retry failures from one prior scrape run
- `RETRY_RUN_TYPE`: retry failures from one run type, such as `standings_backfill`
- `RETRY_LIMIT`: cap the number of failed targets retried

Examples:

```bash
npm run standings:retry-failed
RETRY_RUN_TYPE=standings_backfill npm run standings:retry-failed
RETRY_LIMIT=25 npm run standings:retry-failed
```

## Rate limiting

Use both for API pacing:

- `REQUEST_DELAY_MS` (base pause after each standings request)
- `REQUEST_JITTER_MS` (random extra delay)
- `IMAGE_SYNC_DELAY_MS` (base pause after each contestant image sync)
- `IMAGE_SYNC_JITTER_MS` (random extra image-sync delay)
- `ATHLETE_BIO_DELAY_MS` (base pause after each athlete bio request)
- `ATHLETE_BIO_JITTER_MS` (random extra athlete-bio delay)
- `RESULTS_DETAIL_DELAY_MS` (base pause after each rodeo detail request)
- `RESULTS_DETAIL_JITTER_MS` (random extra rodeo-detail delay)

Actual pause = `delay + random(0..jitter)`.

## Database shape

The API returns repeated contestant and standing fields in every standings row. The database splits that into cleaner tables:

- `prca_event_types`: event lookup from `/eventtypes`, keyed by `event_type_id` with unique `event_abbrev`, plus `is_standings_event` and `is_results_event` scrape flags.
- `prca_circuits`: circuit lookup from `/circuits`, keyed by `circuit_id`.
- `prca_tours`: tour lookup from `/tours`, keyed by `tour_id`.
- `prca_contestants`: one row per `ContestantId`, including static profile/bio fields, generated totals, latest bio sync status, normalized relative photo path, and the latest profile/bio source JSONB payload.
- `prca_standings`: one row per contestant/ranking context, keyed by season, type, event, contestant, tour, and circuit.
- `prca_app_athlete_rankings`: current-season world-standings view for app rankings.
- `prca_rodeos`: one row per rodeo discovered from schedule/results.
- `prca_rodeo_results`: one row per contestant result discovered from rodeo details.
- `prca_athlete_bio_refresh_queue`: contestants discovered in recent results who should have bios refreshed.
- `prca_athlete_career`: generated per-season/per-event career data from standings.
- `prca_athlete_rankings`: generated world-ranking rows from world standings.
- `prca_athlete_earnings`: generated annual/event earnings rows from standings.
- `prca_scrape_runs`: one row per script execution, such as a full backfill or daily sync.
- `prca_scrape_requests`: one row per API request, including standings and athlete bio calls.

`prca_standings.source_payload` keeps the original API object as JSONB for auditing, while the main columns are cleaned and query-ready.

`athletes:sync-bios` supports these target scopes:

- `ATHLETE_BIO_SCOPE=all`: distinct `contestant_id` values from `prca_standings`.
- `ATHLETE_BIO_SCOPE=recent`: contestants in standings from the current year through three years back.
- `ATHLETE_BIO_SCOPE=active`: contestants in current/prior-year standings plus contestants marked `derived_is_active`.
- `ATHLETE_BIO_SCOPE=queued`: contestants in `prca_athlete_bio_refresh_queue` with `pending` or `failed` status.
- `ATHLETE_BIO_SCOPE=active_or_queued`: active scope plus queued contestants.

By default it skips athletes whose latest `prca_contestants.bio_sync_status` is `success`; set `ATHLETE_BIO_FORCE=true` to refresh existing successful rows, or set `ATHLETE_BIO_RESYNC_HOURS=24` to refresh successful rows once they are older than that threshold. Use `ATHLETE_BIO_LIMIT=25` for testing smaller batches.

`athletes:generate-derived` uses `prca_standings` and excludes `AA`.

Generated fields:

- `prca_contestants.generated_total_earnings`: sum of one non-AA earnings row per contestant/season/event. It uses `world` standings when present and falls back to `circuit` only when that contestant/season/event has no world standings row.
- `prca_contestants.generated_nfr_qualifications`: count of non-AA world standings finishes at place `15` or better, only after the season NFR cutoff.
- `prca_contestants.generated_world_titles`: count of non-AA world standings finishes at place `1`, only after the season world-title cutoff.
- `prca_contestants.total_earnings`, `world_titles`, and `nfr_qualifications` are also updated from those generated values for compatibility.

Cutoffs:

- NFR qualifications count for a season only when `DERIVED_AS_OF_DATE` is on or after October 1 of that season.
- World titles count for a season only when `DERIVED_AS_OF_DATE` is on or after December 20 of that season.
- If `DERIVED_AS_OF_DATE` is not set, the script uses today.

The generator rebuilds these tables from standings each time it runs:

- `prca_athlete_career`: generated directly from `prca_standings`.
- `prca_athlete_earnings`: generated from `prca_athlete_career`.
- `prca_athlete_rankings`: generated from `prca_standings` where `standing_type = 'world'`.

The bio endpoint does not write those three tables. Bio scrape data for the source endpoint's `Career`, `Rankings`, and `Earnings` arrays remains available only in `prca_contestants.source_payload`.

`prca_standings.id` is the deterministic primary key for a ranking row. It uses:

```text
standing type number + event type id + optional padded tour/circuit id + year + place
```

Standing type numbers:

- `world`: `1`
- `tour`: `2`
- `circuit`: `3`
- `rookie`: `4`
- `permit`: `5`

Examples:

- `11220261`: world, All-Around event type `12`, year `2026`, place `1`
- `21200420261`: tour, All-Around event type `12`, tour id `4`, year `2026`, place `1`

If the API returns tied places within the same standings response, the contestant id is appended as a tie breaker. The normal format is preserved for untied places.

## Cleaning rules

- Names and labels are whitespace-normalized and trimmed.
- Blank strings become `null`.
- Contestant profile imports upsert by `contestant_id`, so duplicates are updated rather than inserted twice.
- Contestant profile sync uses `/athletes?event_type=&letter=&page_size=15000&index=1&search_term=&search_type=&exact_search=null`.
- Event abbreviations are uppercased.
- Standings scrapes only target events where `is_standings_event` is true.
- `TR` is hard-excluded from standings scrapes because `TRHD` and `TRHL` are the standing events; keeping `TR` would duplicate team roping standings.
- Future results scrapes should only target events where `is_results_event` is true.
- Standing types are lowercased.
- ProRodeo photo URLs are stored as relative paths like `/images/...`.
- Existing absolute ProRodeo photo URLs can be cleaned with `npm run contestants:cleanup-photo-urls`.
- Contestant images are stored in R2 at `contestants/{contestant_id}/original.{ext}` and `contestants/{contestant_id}/315.{ext}`.
- The source image URLs are `https://d1kfpvgfupbmyo.cloudfront.net${sidearm_photo_url}` and `https://d1kfpvgfupbmyo.cloudfront.net${sidearm_photo_url}?width=315&height=315`.
- Image sync fetches original and 315px versions together for one contestant, then waits according to `IMAGE_SYNC_DELAY_MS` and `IMAGE_SYNC_JITTER_MS` before moving to the next contestant.
- Athlete bio sync stores only static profile/bio fields on `prca_contestants` and stores source bio JSON in `prca_contestants.source_payload`; it does not store the bio endpoint's large historical `Results` or `Averages` arrays in separate tables.
- Results discovery calls `/schedule?type=results` over a configurable date window, then calls `/rodeo?id={RodeoId}` for each returned rodeo.
- Results discovery queues every contestant found in detailed rodeo result data for a bio refresh and marks that contestant `derived_is_active = true` with reason `recent_result`.
- The rodeo parser handles both detailed `Events` result maps and lighter `Winners` arrays.
- Circuit codes are extracted from names like `Texas (L)` into `prca_circuits.code`.
- Deleted circuits and inactive/deleted tours are stored in lookup tables but skipped for backfill/daily target generation.

## Scrape metadata

Each backfill or daily job writes a `prca_scrape_runs` row with:

- `run_type`
- `status`
- `target_count`
- `success_count`
- `failure_count`
- `rows_received`
- `rows_loaded`
- `started_at` / `completed_at`
- config details in `metadata`

Each standings or athlete bio URL attempt writes a `prca_scrape_requests` row with:

- URL and target fields (`season_year`, `standing_type`, `event_abbrev`, `tour_id`, `circuit_id`) when applicable
- `http_status`
- `duration_ms`
- `rows_received`
- `rows_loaded`
- `status`
- `error_message`
- metadata such as `scrapeType = athlete_bio` and `contestantId` for athlete bio requests

Each `prca_standings` row stores `scrape_request_id`, so you can trace a ranking row back to the exact API request that produced it.

## Setup

1. Install dependencies

```bash
npm install
```

2. Configure env

```bash
cp .env.example .env
```

3. Initialize schema

```bash
npm run db:init
```

4. Run backfill

```bash
npm run standings:backfill
```

5. After backfill, schedule daily run

```bash
npm run standings:daily
```
