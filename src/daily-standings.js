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

async function main() {
  const apiBase = getRequiredEnv("PRCA_API_BASE");
  const mediaBase = process.env.PRCA_MEDIA_BASE || "https://www.prorodeo.com";
  const year = Number(process.env.SEASON_YEAR || getCurrentYear());
  const basePauseMs = Number(process.env.REQUEST_DELAY_MS || 700);
  const jitterMs = Number(process.env.REQUEST_JITTER_MS || 400);

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

    const targets = [];
    for (const eventAbbrev of lookups.standingsEventAbbrevs) {
      const eventTypeId = lookups.eventTypeIdsByAbbrev[eventAbbrev];
      targets.push({ standingType: "world", eventAbbrev, eventTypeId, scopeId: null });
      targets.push({ standingType: "rookie", eventAbbrev, eventTypeId, scopeId: null });
      targets.push({ standingType: "permit", eventAbbrev, eventTypeId, scopeId: null });
      for (const tourId of lookups.activeTourIds) targets.push({ standingType: "tour", eventAbbrev, eventTypeId, scopeId: tourId });
      for (const circuitId of lookups.activeCircuitIds)
        targets.push({ standingType: "circuit", eventAbbrev, eventTypeId, scopeId: circuitId });
    }

    console.log(`Daily targets for ${year}: ${targets.length}`);
    startedAt = Date.now();
    scrapeRunId = await createScrapeRun(client, {
      runType: "standings_daily",
      targetCount: targets.length,
      metadata: {
        seasonYear: year,
        eventCount: lookups.standingsEventAbbrevs.length,
        tourCount: lookups.activeTourIds.length,
        circuitCount: lookups.activeCircuitIds.length,
        requestDelayMs: basePauseMs,
        requestJitterMs: jitterMs,
      },
    });

    for (const [index, target] of targets.entries()) {
      const progressTarget = { year, ...target };
      console.log(`[daily] starting ${index + 1}/${targets.length}: ${year} ${target.eventAbbrev} ${target.standingType} scope=${target.scopeId ?? "none"}`);
      try {
        const result = await syncSingleStandings(client, {
          apiBase,
          mediaBase,
          seasonYear: year,
          standingType: target.standingType,
          eventAbbrev: target.eventAbbrev,
          eventTypeId: target.eventTypeId,
          scopeId: target.scopeId,
          scrapeRunId,
        });
        completed += 1;
        rowsReceived += result.rowsReceived;
        rowsLoaded += result.rowsLoaded;
        printProgress({ label: "daily", index, total: targets.length, target: progressTarget, completed, failed, rowsLoaded, startedAt });
      } catch (err) {
        failed += 1;
        console.error(`Failed target ${index + 1}/${targets.length}: ${year} ${target.eventAbbrev} ${target.standingType}`);
        console.error(err.message || err);
        printProgress({ label: "daily", index, total: targets.length, target: progressTarget, completed, failed, rowsLoaded, startedAt });
      }
      await sleep(withJitter(basePauseMs, jitterMs));
    }

    await finishScrapeRun(client, {
      runId: scrapeRunId,
      status: failed > 0 ? "completed_with_errors" : "success",
      successCount: completed,
      failureCount: failed,
      rowsReceived,
      rowsLoaded,
      message: `Daily sync completed. success=${completed} failed=${failed}`,
    });
    console.log(`Daily sync completed. success=${completed} failed=${failed}`);
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
