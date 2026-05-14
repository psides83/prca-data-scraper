# PRCA Standings -> Neon

Ingest standings data from the ProRodeo API into Neon/Postgres with normalized tables and idempotent upserts.

## Scripts

- `npm run db:init`: create tables
- `npm run standings:sync`: one standings request (manual testing)
- `npm run standings:backfill`: full historical backfill
- `npm run standings:daily`: current season full sync for daily scheduling
- `npm run standings:retry-failed`: retry failed standings requests only

## GitHub Actions

Daily standings scraping is configured in `.github/workflows/prca-standings-daily.yml`.

Required repository secret:

- `DATABASE_URL`: Neon Postgres connection string

The workflow runs every day at `11:00 UTC` and can also be started manually from the GitHub Actions tab. It initializes the schema, runs `standings:daily`, then retries unresolved failed targets.

## Backfill scope

`standings:backfill` runs all combinations for each year from `START_YEAR` to `END_YEAR`:

- every event from `/eventtypes` where `IsStandingsEvent = true`
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

Actual pause = `delay + random(0..jitter)`.

## Database shape

The API returns repeated contestant and standing fields in every standings row. The database splits that into cleaner tables:

- `prca_event_types`: event lookup from `/eventtypes`, keyed by `event_type_id` with unique `event_abbrev`, plus `is_standings_event` and `is_results_event` scrape flags.
- `prca_circuits`: circuit lookup from `/circuits`, keyed by `circuit_id`.
- `prca_tours`: tour lookup from `/tours`, keyed by `tour_id`.
- `prca_contestants`: one row per `ContestantId`, storing name, nickname, hometown, and normalized photo URL.
- `prca_standings`: one row per contestant/ranking context, keyed by season, type, event, contestant, tour, and circuit.
- `prca_scrape_runs`: one row per script execution, such as a full backfill or daily sync.
- `prca_scrape_requests`: one row per standings API request.

`prca_standings.source_payload` keeps the original API object as JSONB for auditing, while the main columns are cleaned and query-ready.

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
- Event abbreviations are uppercased.
- Standings scrapes only target events where `is_standings_event` is true.
- Future results scrapes should only target events where `is_results_event` is true.
- Standing types are lowercased.
- Relative photo paths such as `/images/...` become absolute URLs using `PRCA_MEDIA_BASE`.
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

Each standings URL attempt writes a `prca_scrape_requests` row with:

- URL and target fields (`season_year`, `standing_type`, `event_abbrev`, `tour_id`, `circuit_id`)
- `http_status`
- `duration_ms`
- `rows_received`
- `rows_loaded`
- `status`
- `error_message`

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
