import { createPool, createScrapeRun, finishScrapeRun, normalizeDate } from "./lib.js";

function asOfDate() {
  const configured = normalizeDate(process.env.DERIVED_AS_OF_DATE);
  return configured ?? new Date().toISOString().slice(0, 10);
}

async function rebuildGeneratedTables(client, asOf) {
  await client.query("TRUNCATE prca_athlete_earnings");
  await client.query("TRUNCATE prca_athlete_career");
  await client.query("TRUNCATE prca_athlete_rankings");

  const career = await client.query(
    `WITH candidate_rows AS (
       SELECT DISTINCT ON (contestant_id, season_year, event_abbrev)
         contestant_id,
         season_year,
         event_abbrev,
         standing_type AS source_standing_type,
         circuit_id,
         CASE WHEN standing_type = 'world' THEN place ELSE NULL END AS world_rank,
         earnings,
         CASE
           WHEN standing_type = 'world'
            AND place <= 15
            AND $1::date >= make_date(season_year, 10, 1)
           THEN TRUE
           ELSE FALSE
         END AS nfr_qualified,
         CASE
           WHEN standing_type = 'world'
            AND place = 1
            AND $1::date >= make_date(season_year, 12, 20)
           THEN TRUE
           ELSE FALSE
         END AS won_world_title,
         id AS source_standings_id
       FROM prca_standings
       WHERE standing_type IN ('world', 'circuit')
         AND event_abbrev <> 'AA'
       ORDER BY
         contestant_id,
         season_year,
         event_abbrev,
         CASE standing_type WHEN 'world' THEN 0 ELSE 1 END,
         earnings DESC NULLS LAST,
         place NULLS LAST,
         synced_at DESC
     )
     INSERT INTO prca_athlete_career (
       contestant_id, season_year, event_type, earnings, world_titles, nfr_qualified,
       riding_statistics, timed_statistics, source_payload, source_standing_type,
       circuit_id, world_rank, won_world_title, source_standings_id, updated_at
     )
     SELECT
       contestant_id,
       season_year,
       event_abbrev,
       earnings,
       CASE WHEN won_world_title THEN 1 ELSE 0 END,
       nfr_qualified,
       NULL::jsonb,
       NULL::jsonb,
       jsonb_build_object(
         'generated', true,
         'source', 'prca_standings',
         'sourceStandingType', source_standing_type,
         'sourceStandingsId', source_standings_id,
         'circuitId', circuit_id,
         'worldRank', world_rank,
         'wonWorldTitle', won_world_title
       ),
       source_standing_type,
       circuit_id,
       world_rank,
       won_world_title,
       source_standings_id,
       NOW()
     FROM candidate_rows`
  , [asOf]);

  const earnings = await client.query(
    `INSERT INTO prca_athlete_earnings (
       contestant_id, season_year, event_type, earning_index, earnings, source_payload, updated_at
     )
     SELECT
       contestant_id,
       season_year,
       event_type,
       0,
       earnings,
       jsonb_build_object(
         'generated', true,
         'source', 'prca_athlete_career',
         'sourceStandingType', source_standing_type,
         'sourceStandingsId', source_standings_id,
         'circuitId', circuit_id
       ),
       NOW()
     FROM prca_athlete_career`
  );

  const rankings = await client.query(
    `INSERT INTO prca_athlete_rankings (
       contestant_id, season_year, rank_type, event_name, rank_label, rank_number,
       tour_id, circuit_id, source_payload, updated_at
     )
     SELECT
       s.contestant_id,
       s.season_year,
       'World',
       et.event_name,
       CASE WHEN s.place IS NULL THEN NULL ELSE '#' || s.place::TEXT END,
       s.place,
       NULL,
       NULL,
       jsonb_build_object(
         'generated', true,
         'source', 'prca_standings',
         'sourceStandingType', 'world',
         'sourceStandingsId', s.id,
         'eventAbbrev', s.event_abbrev,
         'earnings', s.earnings,
         'points', s.points
       ),
       NOW()
     FROM prca_standings s
     JOIN prca_event_types et
       ON et.event_abbrev = s.event_abbrev
     WHERE s.standing_type = 'world'`
  );

  return {
    careerRows: career.rowCount,
    earningsRows: earnings.rowCount,
    rankingRows: rankings.rowCount,
  };
}

async function updateContestantGeneratedFields(client) {
  const result = await client.query(
    `WITH generated AS (
       SELECT
         contestant_id,
         COALESCE(SUM(earnings), 0)::NUMERIC(14,2) AS total_earnings,
         COUNT(*) FILTER (WHERE won_world_title)::INTEGER AS world_titles,
         COUNT(*) FILTER (WHERE nfr_qualified)::INTEGER AS nfr_qualifications
       FROM prca_athlete_career
       GROUP BY contestant_id
     )
     UPDATE prca_contestants c
     SET generated_total_earnings = generated.total_earnings,
         generated_world_titles = generated.world_titles,
         generated_nfr_qualifications = generated.nfr_qualifications,
         total_earnings = generated.total_earnings,
         world_titles = generated.world_titles::TEXT,
         nfr_qualifications = generated.nfr_qualifications::TEXT,
         generated_fields_updated_at = NOW(),
         updated_at = NOW()
     FROM generated
     WHERE c.contestant_id = generated.contestant_id`
  );

  await client.query(
    `UPDATE prca_contestants c
     SET generated_total_earnings = 0,
         generated_world_titles = 0,
         generated_nfr_qualifications = 0,
         total_earnings = 0,
         world_titles = '0',
         nfr_qualifications = '0',
         generated_fields_updated_at = NOW(),
         updated_at = NOW()
     WHERE EXISTS (
       SELECT 1
       FROM prca_standings s
       WHERE s.contestant_id = c.contestant_id
     )
       AND NOT EXISTS (
         SELECT 1
         FROM prca_athlete_career ac
         WHERE ac.contestant_id = c.contestant_id
       )`
  );

  return result.rowCount;
}

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  const asOf = asOfDate();
  let runId;

  try {
    runId = await createScrapeRun(client, {
      runType: "athlete_derived_fields",
      targetCount: 1,
      metadata: {
        asOf,
        rules: {
          source: "prca_standings",
          earningsStandingTypes: ["world", "circuit"],
          earningsRule: "Use world for contestant/season/event when present; otherwise use circuit.",
          accomplishmentStandingType: "world",
          excludedEvents: ["AA"],
          nfrCutoff: "Oct 1 of season year",
          worldTitleCutoff: "Dec 20 of season year",
        },
      },
    });

    await client.query("BEGIN");
    let generatedTables;
    let contestantRows;
    try {
      generatedTables = await rebuildGeneratedTables(client, asOf);
      contestantRows = await updateContestantGeneratedFields(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    await finishScrapeRun(client, {
      runId,
      status: "success",
      successCount: 1,
      failureCount: 0,
      rowsReceived: generatedTables.careerRows,
      rowsLoaded: contestantRows + generatedTables.earningsRows + generatedTables.careerRows + generatedTables.rankingRows,
      message: `Generated athlete fields as of ${asOf}. contestantRows=${contestantRows} earningsRows=${generatedTables.earningsRows} careerRows=${generatedTables.careerRows} rankingRows=${generatedTables.rankingRows}`,
    });

    console.log(
      `Generated athlete fields as of ${asOf}. contestantRows=${contestantRows} earningsRows=${generatedTables.earningsRows} careerRows=${generatedTables.careerRows} rankingRows=${generatedTables.rankingRows}`
    );
  } catch (err) {
    if (runId) {
      await finishScrapeRun(client, {
        runId,
        status: "failed",
        successCount: 0,
        failureCount: 1,
        rowsReceived: 0,
        rowsLoaded: 0,
        message: err.message || String(err),
      });
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
