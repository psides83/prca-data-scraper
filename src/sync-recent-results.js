import { createHash } from "node:crypto";
import {
  cleanText,
  createPool,
  createScrapeRequest,
  createScrapeRun,
  fetchJsonWithMeta,
  finishScrapeRequest,
  finishScrapeRun,
  formatDuration,
  normalizeBoolean,
  normalizeDate,
  normalizeOptionalInt,
  normalizeOptionalNumber,
  sleep,
  upsertContestantProfiles,
  withJitter,
} from "./lib.js";

const DEFAULT_API_BASE = "https://d1kfpvgfupbmyo.cloudfront.net/services/pro_rodeo.ashx";

function formatScheduleDate(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function buildDateWindow() {
  if (process.env.RESULTS_START_DATE && process.env.RESULTS_END_DATE) {
    return { start: process.env.RESULTS_START_DATE, end: process.env.RESULTS_END_DATE };
  }

  const lookbackDays = normalizeOptionalInt(process.env.RESULTS_LOOKBACK_DAYS) ?? 3;
  const end = new Date();
  const start = addDays(end, -lookbackDays);
  return { start: formatScheduleDate(start), end: formatScheduleDate(end) };
}

function buildScheduleUrl({ apiBase, start, end, pageSize, index }) {
  const params = new URLSearchParams({
    type: "results",
    page_size: String(pageSize),
    index: String(index),
    active: "true",
    search_term: "",
    search_type: "",
    tourId: "",
    circuitId: "",
    combine_results: "true",
    start,
    end,
  });
  return `${apiBase}/schedule?${params.toString()}`;
}

function buildRodeoUrl(apiBase, rodeoId) {
  return `${apiBase}/rodeo?id=${rodeoId}`;
}

function resultKey({ rodeoId, result, contestantId }) {
  const stableParts = [
    rodeoId,
    result.EventType,
    result.GoRound,
    result.GoRoundLabel,
    result.TeamId,
    result.Place,
    result.Payoff,
    result.Score,
    result.Time,
    result.StockId,
    result.RideTimestamp,
    contestantId,
  ];
  return createHash("sha1").update(JSON.stringify(stableParts)).digest("hex");
}

function printResultsProgress({ index, total, rodeoId, successCount, failureCount, rowsLoaded, queuedCount, startedAt }) {
  const done = index + 1;
  const percent = total > 0 ? ((done / total) * 100).toFixed(1) : "100.0";
  const elapsedMs = Date.now() - startedAt;
  const avgMs = done > 0 ? elapsedMs / done : 0;
  const remainingMs = avgMs * Math.max(total - done, 0);

  console.log(
    `[results] ${done}/${total} (${percent}%) rodeo=${rodeoId} | success=${successCount} failed=${failureCount} rows=${rowsLoaded} queued=${queuedCount} elapsed=${formatDuration(elapsedMs)} eta=${formatDuration(remainingMs)}`
  );
}

function normalizeIntArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeOptionalInt(item)).filter((item) => item !== null);
}

function extractRodeo(raw) {
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

function extractResultRows(rodeo) {
  const rows = [];
  const events = rodeo?.Events && !Array.isArray(rodeo.Events) && typeof rodeo.Events === "object" ? rodeo.Events : {};

  for (const [eventType, rounds] of Object.entries(events)) {
    if (!rounds || typeof rounds !== "object") continue;

    for (const [roundKey, roundRows] of Object.entries(rounds)) {
      if (!Array.isArray(roundRows)) continue;
      for (const row of roundRows) {
        rows.push({ ...row, EventType: cleanText(row.EventType) ?? cleanText(eventType), RoundKey: roundKey });
      }
    }
  }

  if (Array.isArray(rodeo?.Winners)) {
    for (const winner of rodeo.Winners) {
      rows.push({
        ...winner,
        Contestant: winner.Contestant ? [winner.Contestant] : [],
        GoRoundLabel: "Winner",
        RideTimestamp: winner.StartDate ?? rodeo.StartDate,
      });
    }
  }

  return rows;
}

async function fetchScheduleTargets(client, { apiBase, scrapeRunId, start, end, pageSize }) {
  const rodeos = [];
  let rowsReceived = 0;

  for (let index = 1; ; index += 1) {
    const url = buildScheduleUrl({ apiBase, start, end, pageSize, index });
    const started = Date.now();
    const requestId = await createScrapeRequest(client, {
      scrapeRunId,
      sourceUrl: url,
      metadata: { scrapeType: "results_schedule", start, end, index },
    });

    try {
      const { data, httpStatus } = await fetchJsonWithMeta(url);
      const pageRows = Array.isArray(data) ? data : [];
      rowsReceived += pageRows.length;
      rodeos.push(...pageRows);
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
  for (const rodeo of rodeos) {
    const rodeoId = normalizeOptionalInt(rodeo.RodeoId);
    if (rodeoId !== null) uniqueById.set(rodeoId, rodeo);
  }

  return { targets: [...uniqueById.values()], rowsReceived };
}

async function upsertRodeo(client, rodeo) {
  await client.query(
    `INSERT INTO prca_rodeos (
       rodeo_id, rodeo_number, season_year, name, city, state_abbrv, start_date, end_date,
       payout, venue_name, circuit_id, circuit_ids, tour_ids, in_progress, is_active,
       ap_results, source_payload, synced_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, NOW(), NOW())
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
       venue_name = EXCLUDED.venue_name,
       circuit_id = EXCLUDED.circuit_id,
       circuit_ids = EXCLUDED.circuit_ids,
       tour_ids = EXCLUDED.tour_ids,
       in_progress = EXCLUDED.in_progress,
       is_active = EXCLUDED.is_active,
       ap_results = EXCLUDED.ap_results,
       source_payload = EXCLUDED.source_payload,
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
      cleanText(rodeo.VenueName),
      normalizeOptionalInt(rodeo.CircuitId),
      normalizeIntArray(rodeo.CircuitIds),
      normalizeIntArray(rodeo.TourIds),
      normalizeBoolean(rodeo.InProgress, false),
      normalizeBoolean(rodeo.IsActive, true),
      cleanText(rodeo.ApResults),
      JSON.stringify(rodeo),
    ]
  );
}

async function upsertRodeoResult(client, { rodeoId, result, contestant }) {
  const contestantId = normalizeOptionalInt(contestant.ContestantId);
  if (contestantId === null) return 0;

  await client.query(
    `INSERT INTO prca_rodeo_results (
       result_key, rodeo_id, contestant_id, event_type, go_round, go_round_label,
       place, payoff, score, time, team_id, stock_id, stock_name, contractor_name,
       number_scores, left_stock_score, right_stock_score, ride_timestamp,
       source_payload, synced_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19::jsonb, NOW(), NOW()
     )
     ON CONFLICT (result_key)
     DO UPDATE SET
       place = EXCLUDED.place,
       payoff = EXCLUDED.payoff,
       score = EXCLUDED.score,
       time = EXCLUDED.time,
       stock_name = EXCLUDED.stock_name,
       contractor_name = EXCLUDED.contractor_name,
       number_scores = EXCLUDED.number_scores,
       left_stock_score = EXCLUDED.left_stock_score,
       right_stock_score = EXCLUDED.right_stock_score,
       source_payload = EXCLUDED.source_payload,
       synced_at = NOW(),
       updated_at = NOW()`,
    [
      resultKey({ rodeoId, result, contestantId }),
      rodeoId,
      contestantId,
      cleanText(result.EventType),
      normalizeOptionalInt(result.GoRound),
      cleanText(result.GoRoundLabel ?? result.RoundKey),
      normalizeOptionalInt(result.Place),
      normalizeOptionalNumber(result.Payoff),
      normalizeOptionalNumber(result.Score),
      normalizeOptionalNumber(result.Time),
      normalizeOptionalInt(result.TeamId),
      normalizeOptionalInt(result.StockId),
      cleanText(result.StockName ?? result.Stock),
      cleanText(result.ContractorName),
      normalizeOptionalInt(result.NumberScores),
      normalizeOptionalNumber(result.LeftStockScore),
      normalizeOptionalNumber(result.RightStockScore),
      result.RideTimestamp || null,
      JSON.stringify({ ...result, Contestant: contestant }),
    ]
  );

  return 1;
}

async function queueBioRefresh(client, { contestantId, rodeoId, seasonYear, eventType }) {
  await client.query(
    `INSERT INTO prca_athlete_bio_refresh_queue (
       contestant_id, reason, source, source_rodeo_id, status, metadata, first_seen_at, last_seen_at
     )
     VALUES ($1, 'recent_result', 'results_daily', $2, 'pending', $3::jsonb, NOW(), NOW())
     ON CONFLICT (contestant_id)
     DO UPDATE SET
       reason = EXCLUDED.reason,
       source = EXCLUDED.source,
       source_rodeo_id = EXCLUDED.source_rodeo_id,
       last_seen_at = NOW(),
       processed_at = NULL,
       status = 'pending',
       error_message = NULL,
       metadata = EXCLUDED.metadata`,
    [contestantId, rodeoId, JSON.stringify({ seasonYear, eventType })]
  );

  await client.query(
    `UPDATE prca_contestants
     SET derived_is_active = TRUE,
         derived_activity_reason = 'recent_result',
         derived_activity_year = $2,
         derived_activity_updated_at = NOW(),
         updated_at = NOW()
     WHERE contestant_id = $1`,
    [contestantId, seasonYear]
  );
}

async function upsertRodeoDetails(client, rodeo) {
  const rodeoId = normalizeOptionalInt(rodeo.RodeoId);
  if (rodeoId === null) throw new Error("Rodeo response is missing RodeoId");

  await upsertRodeo(client, rodeo);
  const resultRows = extractResultRows(rodeo);
  const contestantsById = new Map();
  let loadedResults = 0;
  let queuedCount = 0;

  for (const result of resultRows) {
    const contestants = Array.isArray(result.Contestant) ? result.Contestant : [];
    for (const contestant of contestants) {
      const contestantId = normalizeOptionalInt(contestant.ContestantId);
      if (contestantId === null) continue;
      contestantsById.set(contestantId, contestant);
    }
  }

  await upsertContestantProfiles(client, [...contestantsById.values()]);

  for (const result of resultRows) {
    const contestants = Array.isArray(result.Contestant) ? result.Contestant : [];
    for (const contestant of contestants) {
      const contestantId = normalizeOptionalInt(contestant.ContestantId);
      if (contestantId === null) continue;
      loadedResults += await upsertRodeoResult(client, { rodeoId, result, contestant });
      await queueBioRefresh(client, {
        contestantId,
        rodeoId,
        seasonYear: normalizeOptionalInt(rodeo.SeasonYear),
        eventType: cleanText(result.EventType),
      });
      queuedCount += 1;
    }
  }

  return { loadedRows: 1 + contestantsById.size + loadedResults, loadedResults, queuedCount };
}

async function syncRodeo(client, { apiBase, scrapeRunId, rodeoId }) {
  const url = buildRodeoUrl(apiBase, rodeoId);
  const started = Date.now();
  const requestId = await createScrapeRequest(client, {
    scrapeRunId,
    sourceUrl: url,
    metadata: { scrapeType: "rodeo_results", rodeoId },
  });

  try {
    const { data, httpStatus } = await fetchJsonWithMeta(url);
    const rodeo = extractRodeo(data);
    if (!rodeo || typeof rodeo !== "object") throw new Error(`Invalid rodeo response for rodeo ${rodeoId}`);

    let loaded;
    await client.query("BEGIN");
    try {
      loaded = await upsertRodeoDetails(client, rodeo);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    await finishScrapeRequest(client, {
      requestId,
      durationMs: Date.now() - started,
      status: "success",
      httpStatus,
      rowsReceived: 1,
      rowsLoaded: loaded.loadedRows,
    });

    return { rowsReceived: 1, ...loaded };
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

async function main() {
  const apiBase = process.env.PRCA_API_BASE || DEFAULT_API_BASE;
  const pageSize = normalizeOptionalInt(process.env.RESULTS_PAGE_SIZE) ?? 100;
  const detailDelayMs = normalizeOptionalInt(process.env.RESULTS_DETAIL_DELAY_MS) ?? 700;
  const detailJitterMs = normalizeOptionalInt(process.env.RESULTS_DETAIL_JITTER_MS) ?? 400;
  const { start, end } = buildDateWindow();
  const pool = createPool();
  const client = await pool.connect();
  const startedAt = Date.now();
  let runId;
  let successCount = 0;
  let failureCount = 0;
  let rowsReceived = 0;
  let rowsLoaded = 0;
  let queuedCount = 0;

  try {
    runId = await createScrapeRun(client, {
      runType: "results_daily",
      targetCount: 0,
      metadata: { apiBase, start, end, pageSize, detailDelayMs, detailJitterMs },
    });

    const schedule = await fetchScheduleTargets(client, { apiBase, scrapeRunId: runId, start, end, pageSize });
    rowsReceived += schedule.rowsReceived;
    console.log(`Recent rodeo targets: ${schedule.targets.length} (${start} to ${end})`);

    await client.query("UPDATE prca_scrape_runs SET target_count = $2 WHERE id = $1", [runId, schedule.targets.length]);

    for (let i = 0; i < schedule.targets.length; i += 1) {
      const rodeoId = normalizeOptionalInt(schedule.targets[i].RodeoId);
      if (rodeoId === null) continue;
      console.log(`[results] starting ${i + 1}/${schedule.targets.length}: rodeo=${rodeoId}`);

      try {
        const result = await syncRodeo(client, { apiBase, scrapeRunId: runId, rodeoId });
        successCount += 1;
        rowsReceived += result.rowsReceived;
        rowsLoaded += result.loadedRows;
        queuedCount += result.queuedCount;
      } catch (err) {
        failureCount += 1;
        console.error(`Failed rodeo results ${i + 1}/${schedule.targets.length}: rodeo=${rodeoId}`);
        console.error(err.message || err);
      }

      printResultsProgress({
        index: i,
        total: schedule.targets.length,
        rodeoId,
        successCount,
        failureCount,
        rowsLoaded,
        queuedCount,
        startedAt,
      });

      if (i < schedule.targets.length - 1) await sleep(withJitter(detailDelayMs, detailJitterMs));
    }

    await finishScrapeRun(client, {
      runId,
      status: failureCount > 0 ? "completed_with_errors" : "success",
      successCount,
      failureCount,
      rowsReceived,
      rowsLoaded,
      message: `Results sync completed. success=${successCount} failed=${failureCount} queued=${queuedCount}`,
    });

    console.log(`Results sync completed. success=${successCount} failed=${failureCount} queued=${queuedCount}`);
  } catch (err) {
    if (runId) {
      await finishScrapeRun(client, {
        runId,
        status: "failed",
        successCount,
        failureCount: failureCount || 1,
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
