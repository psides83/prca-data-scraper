import {
  cleanText,
  createScrapeRun,
  createPool,
  fetchLookups,
  finishScrapeRun,
  getRequiredEnv,
  normalizeOptionalInt,
  syncSingleStandings,
  upsertLookups,
} from "./lib.js";

function resolveScopeId(standingType, tourId, circuitId) {
  if (standingType === "tour") {
    if (tourId === null) throw new Error("TOUR_ID is required when STANDING_TYPE=tour");
    return tourId;
  }
  if (standingType === "circuit") {
    if (circuitId === null) throw new Error("CIRCUIT_ID is required when STANDING_TYPE=circuit");
    return circuitId;
  }
  return null;
}

async function main() {
  const apiBase = getRequiredEnv("PRCA_API_BASE");
  const mediaBase = process.env.PRCA_MEDIA_BASE || "https://www.prorodeo.com";
  const seasonYear = Number(getRequiredEnv("SEASON_YEAR"));
  const standingType = cleanText(getRequiredEnv("STANDING_TYPE")).toLowerCase();
  const eventAbbrev = cleanText(getRequiredEnv("EVENT_ABBREV")).toUpperCase();
  const tourId = normalizeOptionalInt(process.env.TOUR_ID);
  const circuitId = normalizeOptionalInt(process.env.CIRCUIT_ID);
  const scopeId = resolveScopeId(standingType, tourId, circuitId);

  const pool = createPool();
  const client = await pool.connect();
  let scrapeRunId = null;

  try {
    const lookups = await fetchLookups(apiBase);
    await upsertLookups(client, lookups);
    const eventTypeId = lookups.eventTypeIdsByAbbrev[eventAbbrev];
    if (!eventTypeId) throw new Error(`Unknown event abbreviation: ${eventAbbrev}`);
    if (!lookups.standingsEventAbbrevs.includes(eventAbbrev)) {
      throw new Error(`Event is not marked as a standings event: ${eventAbbrev}`);
    }
    scrapeRunId = await createScrapeRun(client, {
      runType: "standings_single",
      targetCount: 1,
      metadata: { seasonYear, standingType, eventAbbrev, eventTypeId, scopeId },
    });
    console.log(`[single] starting: ${seasonYear} ${eventAbbrev} ${standingType} scope=${scopeId ?? "none"}`);
    const result = await syncSingleStandings(client, {
      apiBase,
      mediaBase,
      seasonYear,
      standingType,
      eventAbbrev,
      eventTypeId,
      scopeId,
      scrapeRunId,
    });
    await finishScrapeRun(client, {
      runId: scrapeRunId,
      status: "success",
      successCount: 1,
      failureCount: 0,
      rowsReceived: result.rowsReceived,
      rowsLoaded: result.rowsLoaded,
      message: "Single standings sync completed.",
    });
    console.log(`[single] completed: rows_received=${result.rowsReceived} rows_loaded=${result.rowsLoaded}`);
  } catch (err) {
    if (scrapeRunId) {
      await finishScrapeRun(client, {
        runId: scrapeRunId,
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
  process.exit(1);
});
