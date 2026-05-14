import {
  createScrapeRun,
  createPool,
  fetchLookups,
  finishScrapeRun,
  getRequiredEnv,
  printProgress,
  sleep,
  syncSingleStandings,
  upsertLookups,
  withJitter,
} from "./lib.js";

function getCurrentYear() {
  return new Date().getUTCFullYear();
}

function buildTargets({ years, eventAbbrevs, eventTypeIdsByAbbrev, tourIds, circuitIds }) {
  const targets = [];
  for (const year of years) {
    for (const eventAbbrev of eventAbbrevs) {
      const eventTypeId = eventTypeIdsByAbbrev[eventAbbrev];
      targets.push({ year, eventAbbrev, eventTypeId, standingType: "world", scopeId: null });
      targets.push({ year, eventAbbrev, eventTypeId, standingType: "rookie", scopeId: null });
      targets.push({ year, eventAbbrev, eventTypeId, standingType: "permit", scopeId: null });
      for (const tourId of tourIds) {
        targets.push({ year, eventAbbrev, eventTypeId, standingType: "tour", scopeId: tourId });
      }
      for (const circuitId of circuitIds) {
        targets.push({ year, eventAbbrev, eventTypeId, standingType: "circuit", scopeId: circuitId });
      }
    }
  }
  return targets;
}

async function main() {
  const apiBase = getRequiredEnv("PRCA_API_BASE");
  const mediaBase = process.env.PRCA_MEDIA_BASE || "https://www.prorodeo.com";
  const startYear = Number(process.env.START_YEAR || 2009);
  const endYear = Number(process.env.END_YEAR || getCurrentYear());
  const basePauseMs = Number(process.env.REQUEST_DELAY_MS || 700);
  const jitterMs = Number(process.env.REQUEST_JITTER_MS || 400);

  const years = [];
  for (let y = startYear; y <= endYear; y += 1) years.push(y);

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

    const targets = buildTargets({
      years,
      eventAbbrevs: lookups.standingsEventAbbrevs,
      eventTypeIdsByAbbrev: lookups.eventTypeIdsByAbbrev,
      tourIds: lookups.activeTourIds,
      circuitIds: lookups.activeCircuitIds,
    });

    console.log(`Backfill targets: ${targets.length}`);
    startedAt = Date.now();
    scrapeRunId = await createScrapeRun(client, {
      runType: "standings_backfill",
      targetCount: targets.length,
      metadata: {
        startYear,
        endYear,
        eventCount: lookups.standingsEventAbbrevs.length,
        tourCount: lookups.activeTourIds.length,
        circuitCount: lookups.activeCircuitIds.length,
        requestDelayMs: basePauseMs,
        requestJitterMs: jitterMs,
      },
    });

    for (const [index, target] of targets.entries()) {
      console.log(`[backfill] starting ${index + 1}/${targets.length}: ${target.year} ${target.eventAbbrev} ${target.standingType} scope=${target.scopeId ?? "none"}`);
      try {
        const result = await syncSingleStandings(client, {
          apiBase,
          mediaBase,
          seasonYear: target.year,
          standingType: target.standingType,
          eventAbbrev: target.eventAbbrev,
          eventTypeId: target.eventTypeId,
          scopeId: target.scopeId,
          scrapeRunId,
        });
        completed += 1;
        rowsReceived += result.rowsReceived;
        rowsLoaded += result.rowsLoaded;
        printProgress({ label: "backfill", index, total: targets.length, target, completed, failed, rowsLoaded, startedAt });
      } catch (err) {
        failed += 1;
        console.error(
          `Failed target ${index + 1}/${targets.length}: ${target.year} ${target.eventAbbrev} ${target.standingType} ${target.scopeId ?? "none"}`
        );
        console.error(err.message || err);
        printProgress({ label: "backfill", index, total: targets.length, target, completed, failed, rowsLoaded, startedAt });
      }

      const delay = withJitter(basePauseMs, jitterMs);
      await sleep(delay);
    }

    await finishScrapeRun(client, {
      runId: scrapeRunId,
      status: failed > 0 ? "completed_with_errors" : "success",
      successCount: completed,
      failureCount: failed,
      rowsReceived,
      rowsLoaded,
      message: `Backfill completed. success=${completed} failed=${failed}`,
    });
    console.log(`Backfill completed. success=${completed} failed=${failed}`);
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
