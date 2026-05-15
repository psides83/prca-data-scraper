import {
  createPool,
  createScrapeRun,
  fetchJson,
  finishScrapeRun,
  getRequiredEnv,
  upsertContestantProfiles,
} from "./lib.js";

function buildAthletesUrl(apiBase) {
  const params = new URLSearchParams({
    event_type: "",
    letter: "",
    page_size: process.env.ATHLETES_PAGE_SIZE || "15000",
    index: process.env.ATHLETES_PAGE_INDEX || "1",
    search_term: "",
    search_type: "",
    exact_search: "null",
  });
  return `${apiBase}/athletes?${params.toString()}`;
}

async function main() {
  const apiBase = getRequiredEnv("PRCA_API_BASE");
  const athletesUrl = process.env.PRCA_ATHLETES_URL || buildAthletesUrl(apiBase);
  const pool = createPool();
  const client = await pool.connect();
  let scrapeRunId = null;
  let rowsReceived = 0;
  let rowsLoaded = 0;

  try {
    scrapeRunId = await createScrapeRun(client, {
      runType: "contestants_sync",
      targetCount: 1,
      metadata: { sourceUrl: athletesUrl },
    });

    console.log(`[contestants] fetching ${athletesUrl}`);
    const rows = await fetchJson(athletesUrl);
    rowsReceived = rows.length;
    rowsLoaded = await upsertContestantProfiles(client, rows);

    await finishScrapeRun(client, {
      runId: scrapeRunId,
      status: "success",
      successCount: 1,
      failureCount: 0,
      rowsReceived,
      rowsLoaded,
      message: `Contestants sync completed. rows=${rowsLoaded}`,
    });

    console.log(`[contestants] completed rows_received=${rowsReceived} rows_loaded=${rowsLoaded}`);
  } catch (err) {
    if (scrapeRunId) {
      await finishScrapeRun(client, {
        runId: scrapeRunId,
        status: "failed",
        successCount: 0,
        failureCount: 1,
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
