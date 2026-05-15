import {
  cleanText,
  createPool,
  createScrapeRequest,
  createScrapeRun,
  fetchJsonWithMeta,
  finishScrapeRequest,
  finishScrapeRun,
  formatDuration,
  normalizeOptionalInt,
  sleep,
  upsertContestantProfiles,
  withJitter,
} from "./lib.js";

const DEFAULT_API_BASE = "https://d1kfpvgfupbmyo.cloudfront.net/services/pro_rodeo.ashx";

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).trim().toLowerCase());
}

function buildAthleteUrl(apiBase, contestantId) {
  return `${apiBase}/athlete?id=${contestantId}`;
}

function printBioProgress({ index, total, contestantId, successCount, failureCount, rowsLoaded, startedAt }) {
  const done = index + 1;
  const percent = total > 0 ? ((done / total) * 100).toFixed(1) : "100.0";
  const elapsedMs = Date.now() - startedAt;
  const avgMs = done > 0 ? elapsedMs / done : 0;
  const remainingMs = avgMs * Math.max(total - done, 0);

  console.log(
    `[athlete-bios] ${done}/${total} (${percent}%) contestant=${contestantId} | success=${successCount} failed=${failureCount} rows=${rowsLoaded} elapsed=${formatDuration(elapsedMs)} eta=${formatDuration(remainingMs)}`
  );
}

async function loadTargets(client, { limit, force, scope, currentYear, resyncHours }) {
  const params = [];
  const targetQueries = [];

  if (scope === "all") {
    targetQueries.push("SELECT DISTINCT contestant_id FROM prca_standings WHERE contestant_id IS NOT NULL");
  }

  if (scope === "recent") {
    params.push(currentYear - 3);
    targetQueries.push(`SELECT DISTINCT contestant_id FROM prca_standings WHERE contestant_id IS NOT NULL AND season_year >= $${params.length}`);
  }

  if (scope === "active" || scope === "active_or_queued") {
    params.push(currentYear - 1);
    targetQueries.push(`SELECT DISTINCT contestant_id FROM prca_standings WHERE contestant_id IS NOT NULL AND season_year >= $${params.length}`);
    targetQueries.push("SELECT contestant_id FROM prca_contestants WHERE derived_is_active = TRUE");
  }

  if (scope === "queued" || scope === "active_or_queued") {
    targetQueries.push("SELECT contestant_id FROM prca_athlete_bio_refresh_queue WHERE status IN ('pending', 'failed')");
  }

  if (targetQueries.length === 0) {
    throw new Error(`Unsupported ATHLETE_BIO_SCOPE: ${scope}`);
  }

  const filters = ["target.contestant_id IS NOT NULL"];

  if (!force) {
    if (scope === "queued" || scope === "active_or_queued") {
      filters.push(
        `(q.status IN ('pending', 'failed') OR c.bio_sync_status IS DISTINCT FROM 'success' OR c.bio_synced_at IS NULL${
          resyncHours ? ` OR c.bio_synced_at < NOW() - ($${params.length + 1} * INTERVAL '1 hour')` : ""
        })`
      );
      if (resyncHours) params.push(resyncHours);
    } else {
      filters.push(
        `(c.bio_sync_status IS DISTINCT FROM 'success' OR c.bio_synced_at IS NULL${
          resyncHours ? ` OR c.bio_synced_at < NOW() - ($${params.length + 1} * INTERVAL '1 hour')` : ""
        })`
      );
      if (resyncHours) params.push(resyncHours);
    }
  }

  let limitSql = "";
  if (limit) {
    params.push(limit);
    limitSql = `LIMIT $${params.length}`;
  }

  const result = await client.query(
    `WITH target AS (
       ${targetQueries.join("\nUNION\n")}
     )
     SELECT DISTINCT target.contestant_id
     FROM target
     LEFT JOIN prca_contestants c
       ON c.contestant_id = target.contestant_id
     LEFT JOIN prca_athlete_bio_refresh_queue q
       ON q.contestant_id = target.contestant_id
     WHERE ${filters.join(" AND ")}
     ORDER BY target.contestant_id
     ${limitSql}`,
    params
  );

  return result.rows.map((row) => row.contestant_id);
}

async function updateContestantBioSuccess(client, bio) {
  await client.query(
    `UPDATE prca_contestants
     SET biography_text = $2,
         video_highlights = $3,
         source_payload = $4::jsonb,
         bio_synced_at = NOW(),
         bio_sync_status = 'success',
         bio_sync_error = NULL,
         updated_at = NOW()
     WHERE contestant_id = $1`,
    [
      bio.ContestantId,
      cleanText(bio.BiographyText),
      cleanText(bio.VideoHighlights),
      JSON.stringify(bio),
    ]
  );
}

async function markAthleteBioFailed(client, contestantId, err) {
  await client.query(
    `UPDATE prca_contestants
     SET bio_sync_status = 'failed',
         bio_sync_error = $2,
         updated_at = NOW()
     WHERE contestant_id = $1`,
    [contestantId, String(err.message || err).slice(0, 1000)]
  );
}

async function markBioQueueProcessed(client, contestantId) {
  await client.query(
    `UPDATE prca_athlete_bio_refresh_queue
     SET status = 'processed',
         processed_at = NOW(),
         error_message = NULL
     WHERE contestant_id = $1
       AND status IN ('pending', 'failed')`,
    [contestantId]
  );
}

async function markBioQueueFailed(client, contestantId, err) {
  await client.query(
    `UPDATE prca_athlete_bio_refresh_queue
     SET status = 'failed',
         error_message = $2
     WHERE contestant_id = $1
       AND status IN ('pending', 'failed')`,
    [contestantId, String(err.message || err).slice(0, 1000)]
  );
}

async function upsertAthleteDetails(client, bio) {
  const contestantId = normalizeOptionalInt(bio.ContestantId);
  if (contestantId === null) throw new Error("Athlete bio response is missing ContestantId");

  await upsertContestantProfiles(client, [bio]);
  await updateContestantBioSuccess(client, bio);

  return {
    profileCount: 1,
    totalRows: 1,
  };
}

async function syncAthleteBio(client, { apiBase, scrapeRunId, contestantId }) {
  const url = buildAthleteUrl(apiBase, contestantId);
  const started = Date.now();
  const requestId = await createScrapeRequest(client, {
    scrapeRunId,
    sourceUrl: url,
    metadata: { scrapeType: "athlete_bio", contestantId },
  });

  try {
    const { data: bio, httpStatus } = await fetchJsonWithMeta(url);
    if (!bio || typeof bio !== "object" || Array.isArray(bio)) {
      throw new Error(`Invalid athlete bio response for contestant ${contestantId}`);
    }

    let loaded;
    await client.query("BEGIN");
    try {
      loaded = await upsertAthleteDetails(client, bio);
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
      rowsLoaded: loaded.totalRows,
    });
    await markBioQueueProcessed(client, contestantId);

    return { requestId, rowsReceived: 1, rowsLoaded: loaded.totalRows, loaded };
  } catch (err) {
    await markAthleteBioFailed(client, contestantId, err);
    await markBioQueueFailed(client, contestantId, err);
    await finishScrapeRequest(client, {
      requestId,
      durationMs: Date.now() - started,
      status: "failed",
      rowsReceived: 0,
      rowsLoaded: 0,
      errorMessage: err.message || err,
    });
    throw err;
  }
}

async function main() {
  const apiBase = process.env.PRCA_API_BASE || DEFAULT_API_BASE;
  const limit = normalizeOptionalInt(process.env.ATHLETE_BIO_LIMIT);
  const force = parseBool(process.env.ATHLETE_BIO_FORCE, false);
  const scope = cleanText(process.env.ATHLETE_BIO_SCOPE)?.toLowerCase() ?? "all";
  const currentYear = normalizeOptionalInt(process.env.ACTIVITY_CURRENT_YEAR) ?? new Date().getFullYear();
  const resyncHours = normalizeOptionalInt(process.env.ATHLETE_BIO_RESYNC_HOURS);
  const delayMs = normalizeOptionalInt(process.env.ATHLETE_BIO_DELAY_MS) ?? 700;
  const jitterMs = normalizeOptionalInt(process.env.ATHLETE_BIO_JITTER_MS) ?? 400;
  const pool = createPool();
  const client = await pool.connect();
  const startedAt = Date.now();
  let runId;
  let successCount = 0;
  let failureCount = 0;
  let rowsReceived = 0;
  let rowsLoaded = 0;

  try {
    const targets = await loadTargets(client, { limit, force, scope, currentYear, resyncHours });
    runId = await createScrapeRun(client, {
      runType: "athlete_bio_sync",
      targetCount: targets.length,
      metadata: { apiBase, limit, force, scope, currentYear, resyncHours, delayMs, jitterMs },
    });

    console.log(`Athlete bio targets: ${targets.length}`);
    for (let i = 0; i < targets.length; i += 1) {
      const contestantId = targets[i];
      console.log(`[athlete-bios] starting ${i + 1}/${targets.length}: contestant=${contestantId}`);

      try {
        const result = await syncAthleteBio(client, { apiBase, scrapeRunId: runId, contestantId });
        successCount += 1;
        rowsReceived += result.rowsReceived;
        rowsLoaded += result.rowsLoaded;
      } catch (err) {
        failureCount += 1;
        console.error(`Failed athlete bio ${i + 1}/${targets.length}: contestant=${contestantId}`);
        console.error(err.message || err);
      }

      printBioProgress({ index: i, total: targets.length, contestantId, successCount, failureCount, rowsLoaded, startedAt });
      if (i < targets.length - 1) await sleep(withJitter(delayMs, jitterMs));
    }

    await finishScrapeRun(client, {
      runId,
      status: failureCount > 0 ? "completed_with_errors" : "success",
      successCount,
      failureCount,
      rowsReceived,
      rowsLoaded,
      message: `Athlete bio sync completed. success=${successCount} failed=${failureCount}`,
    });

    console.log(`Athlete bio sync completed. success=${successCount} failed=${failureCount}`);
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
