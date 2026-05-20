import {
  cleanText,
  createPool,
  createScrapeRequest,
  createScrapeRun,
  fetchJsonWithMeta,
  finishScrapeRequest,
  finishScrapeRun,
  normalizeBoolean,
  normalizeDate,
  normalizeOptionalInt,
  normalizeOptionalNumber,
} from "./lib.js";

const DEFAULT_API_BASE = "https://d1kfpvgfupbmyo.cloudfront.net/services/pro_rodeo.ashx";

function buildDefaultDateWindow() {
  const year = normalizeOptionalInt(process.env.SCHEDULE_YEAR) ?? new Date().getUTCFullYear();
  return {
    start: `1/1/${year}`,
    end: `9/30/${year}`,
  };
}

function buildDateWindow() {
  if (process.env.SCHEDULE_START_DATE && process.env.SCHEDULE_END_DATE) {
    return {
      start: process.env.SCHEDULE_START_DATE,
      end: process.env.SCHEDULE_END_DATE,
    };
  }

  const defaults = buildDefaultDateWindow();
  const start = process.env.SCHEDULE_START_DATE || defaults.start;
  const end = process.env.SCHEDULE_END_DATE || defaults.end;
  return { start, end };
}

function buildScheduleUrl({ apiBase, start, end, pageSize, index }) {
  const params = new URLSearchParams({
    type: "schedule",
    page_size: String(pageSize),
    index: String(index),
    active: "true",
    search_term: "",
    search_type: "",
    tourId: "",
    circuitId: "",
    start,
    end,
  });
  return `${apiBase}/schedule?${params.toString()}`;
}

function normalizeIntArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeOptionalInt(item)).filter((item) => item !== null);
}

async function fetchScheduleRows(client, { apiBase, scrapeRunId, start, end, pageSize }) {
  const rows = [];

  for (let index = 1; ; index += 1) {
    const url = buildScheduleUrl({ apiBase, start, end, pageSize, index });
    const started = Date.now();
    const requestId = await createScrapeRequest(client, {
      scrapeRunId,
      sourceUrl: url,
      metadata: { scrapeType: "schedule", start, end, index },
    });

    try {
      const { data, httpStatus } = await fetchJsonWithMeta(url);
      const pageRows = Array.isArray(data) ? data : [];
      rows.push(...pageRows);
      await finishScrapeRequest(client, {
        requestId,
        durationMs: Date.now() - started,
        status: "success",
        httpStatus,
        rowsReceived: pageRows.length,
        rowsLoaded: pageRows.length,
      });
      if (pageRows.length < pageSize) break;
    } catch (err) {
      await finishScrapeRequest(client, {
        requestId,
        durationMs: Date.now() - started,
        status: "failed",
        errorMessage: err.message || err,
      });
      throw err;
    }
  }

  const uniqueById = new Map();
  for (const row of rows) {
    const rodeoId = normalizeOptionalInt(row.RodeoId);
    if (rodeoId !== null) uniqueById.set(rodeoId, row);
  }

  return [...uniqueById.values()];
}

async function upsertScheduleRow(client, rodeo) {
  await client.query(
    `INSERT INTO prca_rodeos (
       rodeo_id, rodeo_number, season_year, name, city, state_abbrv, start_date, end_date,
       payout, website_url, venue_name, circuit_id, circuit_ids, tour_ids, daysheets,
       has_daysheets, in_progress, is_active, ap_results, synced_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, NULL, NOW(), NOW()
     )
     ON CONFLICT (rodeo_id)
     DO UPDATE SET
       rodeo_number = EXCLUDED.rodeo_number,
       season_year = EXCLUDED.season_year,
       name = EXCLUDED.name,
       city = EXCLUDED.city,
       state_abbrv = EXCLUDED.state_abbrv,
       start_date = EXCLUDED.start_date,
       end_date = EXCLUDED.end_date,
       payout = EXCLUDED.payout,
       website_url = EXCLUDED.website_url,
       venue_name = EXCLUDED.venue_name,
       circuit_id = EXCLUDED.circuit_id,
       circuit_ids = EXCLUDED.circuit_ids,
       tour_ids = EXCLUDED.tour_ids,
       daysheets = EXCLUDED.daysheets,
       has_daysheets = EXCLUDED.has_daysheets,
       in_progress = EXCLUDED.in_progress,
       is_active = EXCLUDED.is_active,
       synced_at = NOW(),
       updated_at = NOW()`,
    [
      normalizeOptionalInt(rodeo.RodeoId),
      normalizeOptionalInt(rodeo.RodeoNumber),
      normalizeOptionalInt(rodeo.SeasonYear),
      cleanText(rodeo.Name ?? rodeo.RodeoName),
      cleanText(rodeo.City),
      cleanText(rodeo.StateAbbrv ?? rodeo.State),
      normalizeDate(rodeo.StartDate),
      normalizeDate(rodeo.EndDate),
      normalizeOptionalNumber(rodeo.Payout),
      cleanText(rodeo.WebsiteUrl),
      cleanText(rodeo.VenueName),
      normalizeOptionalInt(rodeo.CircuitId),
      normalizeIntArray(rodeo.CircuitIds),
      normalizeIntArray(rodeo.TourIds),
      normalizeOptionalInt(rodeo.Daysheets),
      normalizeBoolean(rodeo.HasDaysheets, false),
      normalizeBoolean(rodeo.InProgress, false),
      normalizeBoolean(rodeo.IsActive, true),
    ]
  );
}

async function upsertScheduleRows(client, rows) {
  let loaded = 0;
  await client.query("BEGIN");
  try {
    for (const row of rows) {
      await upsertScheduleRow(client, row);
      loaded += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return loaded;
}

async function main() {
  const apiBase = process.env.PRCA_API_BASE || DEFAULT_API_BASE;
  const pageSize = normalizeOptionalInt(process.env.SCHEDULE_PAGE_SIZE) ?? 2000;
  const { start, end } = buildDateWindow();
  const pool = createPool();
  const client = await pool.connect();
  let runId;
  let rowsReceived = 0;
  let rowsLoaded = 0;

  try {
    runId = await createScrapeRun(client, {
      runType: "schedule_sync",
      targetCount: 1,
      metadata: { apiBase, start, end, pageSize },
    });

    const rows = await fetchScheduleRows(client, { apiBase, scrapeRunId: runId, start, end, pageSize });
    rowsReceived = rows.length;
    rowsLoaded = await upsertScheduleRows(client, rows);

    await finishScrapeRun(client, {
      runId,
      status: "success",
      successCount: 1,
      failureCount: 0,
      rowsReceived,
      rowsLoaded,
      message: `Schedule sync completed for ${start} to ${end}. rows=${rowsLoaded}`,
    });

    console.log(`Schedule sync completed for ${start} to ${end}. rows=${rowsLoaded}`);
  } catch (err) {
    if (runId) {
      await finishScrapeRun(client, {
        runId,
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
  process.exitCode = 1;
});
