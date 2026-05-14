import {
  createPool,
  createScrapeRun,
  fetchLookups,
  finishScrapeRun,
  getRequiredEnv,
  printProgress,
  sleep,
  syncSingleStandings,
  upsertLookups,
  withJitter,
} from "./lib.js";

function optionalInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

async function findFailedTargets(client, { sourceRunId, runType, limit }) {
  const params = [];
  const filters = ["latest.status = 'failed'"];

  if (sourceRunId !== null) {
    params.push(sourceRunId);
    filters.push(`latest.scrape_run_id = $${params.length}`);
  }

  if (runType) {
    params.push(runType);
    filters.push(`sr.run_type = $${params.length}`);
  }

  const limitSql = limit === null ? "" : `LIMIT ${limit}`;

  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (season_year, standing_type, event_abbrev, scope_id)
        id,
        scrape_run_id,
        season_year,
        standing_type,
        event_abbrev,
        scope_id,
        tour_id,
        circuit_id,
        status,
        error_message,
        completed_at
      FROM prca_scrape_requests
      ORDER BY season_year, standing_type, event_abbrev, scope_id, id DESC
    )
    SELECT
      latest.id AS failed_request_id,
      latest.scrape_run_id AS failed_scrape_run_id,
      latest.season_year,
      latest.standing_type,
      latest.event_abbrev,
      latest.scope_id,
      latest.tour_id,
      latest.circuit_id,
      latest.error_message,
      latest.completed_at
    FROM latest
    LEFT JOIN prca_scrape_runs sr ON sr.id = latest.scrape_run_id
    WHERE ${filters.join(" AND ")}
    ORDER BY latest.season_year, latest.standing_type, latest.event_abbrev, latest.scope_id
    ${limitSql}
  `;

  const result = await client.query(sql, params);
  return result.rows.map((row) => ({
    failedRequestId: row.failed_request_id,
    failedScrapeRunId: row.failed_scrape_run_id,
    year: row.season_year,
    seasonYear: row.season_year,
    standingType: row.standing_type,
    eventAbbrev: row.event_abbrev,
    scopeId: row.scope_id,
    tourId: row.tour_id,
    circuitId: row.circuit_id,
    errorMessage: row.error_message,
  }));
}

async function main() {
  const apiBase = getRequiredEnv("PRCA_API_BASE");
  const mediaBase = process.env.PRCA_MEDIA_BASE || "https://www.prorodeo.com";
  const basePauseMs = Number(process.env.REQUEST_DELAY_MS || 700);
  const jitterMs = Number(process.env.REQUEST_JITTER_MS || 400);
  const sourceRunId = optionalInt(process.env.RETRY_SCRAPE_RUN_ID);
  const limit = optionalInt(process.env.RETRY_LIMIT);
  const runType = process.env.RETRY_RUN_TYPE || null;

  const pool = createPool();
  const client = await pool.connect();

  let completed = 0;
  let failed = 0;
  let rowsReceived = 0;
  let rowsLoaded = 0;
  let scrapeRunId = null;
  let startedAt = null;

  try {
    const lookups = await fetchLookups(apiBase);
    await upsertLookups(client, lookups);

    const targets = await findFailedTargets(client, { sourceRunId, runType, limit });
    console.log(`Retry targets: ${targets.length}`);

    if (targets.length === 0) return;

    scrapeRunId = await createScrapeRun(client, {
      runType: "standings_retry_failed",
      targetCount: targets.length,
      metadata: {
        sourceRunId,
        runType,
        limit,
        requestDelayMs: basePauseMs,
        requestJitterMs: jitterMs,
      },
    });
    startedAt = Date.now();

    for (const [index, target] of targets.entries()) {
      const eventTypeId = lookups.eventTypeIdsByAbbrev[target.eventAbbrev];
      if (!eventTypeId) {
        failed += 1;
        console.error(`Skipping target ${index + 1}/${targets.length}: unknown event ${target.eventAbbrev}`);
        printProgress({ label: "retry", index, total: targets.length, target, completed, failed, rowsLoaded, startedAt });
        continue;
      }
      if (!lookups.standingsEventAbbrevs.includes(target.eventAbbrev)) {
        failed += 1;
        console.error(`Skipping target ${index + 1}/${targets.length}: event is not marked as standings event ${target.eventAbbrev}`);
        printProgress({ label: "retry", index, total: targets.length, target, completed, failed, rowsLoaded, startedAt });
        continue;
      }

      console.log(
        `[retry] starting ${index + 1}/${targets.length}: ${target.year} ${target.eventAbbrev} ${target.standingType} scope=${target.scopeId ?? "none"}`
      );

      try {
        const result = await syncSingleStandings(client, {
          apiBase,
          mediaBase,
          seasonYear: target.year,
          standingType: target.standingType,
          eventAbbrev: target.eventAbbrev,
          eventTypeId,
          scopeId: target.scopeId,
          scrapeRunId,
        });
        completed += 1;
        rowsReceived += result.rowsReceived;
        rowsLoaded += result.rowsLoaded;
      } catch (err) {
        failed += 1;
        console.error(
          `Failed retry ${index + 1}/${targets.length}: ${target.year} ${target.eventAbbrev} ${target.standingType} ${target.scopeId ?? "none"}`
        );
        console.error(err.message || err);
      }

      printProgress({ label: "retry", index, total: targets.length, target, completed, failed, rowsLoaded, startedAt });
      await sleep(withJitter(basePauseMs, jitterMs));
    }

    await finishScrapeRun(client, {
      runId: scrapeRunId,
      status: failed > 0 ? "completed_with_errors" : "success",
      successCount: completed,
      failureCount: failed,
      rowsReceived,
      rowsLoaded,
      message: `Retry completed. success=${completed} failed=${failed}`,
    });
    console.log(`Retry completed. success=${completed} failed=${failed}`);
  } catch (err) {
    if (scrapeRunId) {
      await finishScrapeRun(client, {
        runId: scrapeRunId,
        status: "failed",
        successCount: completed,
        failureCount: failed,
        rowsReceived,
        rowsLoaded,
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
  process.exit(1);
});
