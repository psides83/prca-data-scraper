import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

export function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function cleanText(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).replace(/\s+/g, " ").trim();
  return trimmed.length ? trimmed : null;
}

export function normalizeOptionalInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

export function normalizeBoolean(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "f", "no", "n", "0"].includes(normalized)) return false;
  return fallback;
}

export function normalizePhotoUrl(url) {
  const cleaned = cleanText(url);
  if (!cleaned) return null;

  const imagePathIndex = cleaned.indexOf("/images/");
  if (imagePathIndex >= 0) return cleaned.slice(imagePathIndex);

  try {
    const parsed = new URL(cleaned);
    const parsedImagePathIndex = parsed.pathname.indexOf("/images/");
    if (parsedImagePathIndex >= 0) return `${parsed.pathname.slice(parsedImagePathIndex)}${parsed.search}`;
    return cleaned;
  } catch {
    return cleaned.startsWith("images/") ? `/${cleaned}` : cleaned;
  }
}

export function extractCircuitCode(name) {
  const cleaned = cleanText(name);
  if (!cleaned) return null;
  const match = cleaned.match(/\(([A-Z])\)$/);
  return match ? match[1] : null;
}

export function standingsTypeNumber(standingType) {
  const normalized = cleanText(standingType)?.toLowerCase();
  const typeNumbers = {
    world: 1,
    tour: 2,
    circuit: 3,
    rookie: 4,
    permit: 5,
  };

  if (!typeNumbers[normalized]) {
    throw new Error(`Unsupported standing type for standings key: ${standingType}`);
  }

  return typeNumbers[normalized];
}

export function buildStandingsKey({ standingType, eventTypeId, scopeId, seasonYear, place, tieBreaker = null }) {
  const typeNumber = standingsTypeNumber(standingType);
  if (eventTypeId === null || eventTypeId === undefined) {
    throw new Error(`Missing event type id for standings key: ${standingType}/${seasonYear}/${place}`);
  }
  if ((standingType === "tour" || standingType === "circuit") && (scopeId === null || scopeId === undefined)) {
    throw new Error(`Missing scope id for standings key: ${standingType}/${eventTypeId}/${seasonYear}/${place}`);
  }
  const eventSegment = String(eventTypeId).padStart(2, "0");
  const scopeSegment = standingType === "tour" || standingType === "circuit" ? String(scopeId).padStart(3, "0") : "";
  const baseKey = `${typeNumber}${eventSegment}${scopeSegment}${seasonYear}${place}`;
  return tieBreaker === null || tieBreaker === undefined ? baseKey : `${baseKey}${tieBreaker}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withJitter(baseMs, jitterMs) {
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return baseMs + jitter;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTarget(target) {
  const scope = target.scopeId === null || target.scopeId === undefined ? "none" : target.scopeId;
  return `${target.year ?? target.seasonYear} ${target.eventAbbrev} ${target.standingType} scope=${scope}`;
}

export function printProgress({ label, index, total, target, completed, failed, rowsLoaded, startedAt }) {
  const done = index + 1;
  const percent = total > 0 ? ((done / total) * 100).toFixed(1) : "100.0";
  const elapsedMs = Date.now() - startedAt;
  const avgMs = done > 0 ? elapsedMs / done : 0;
  const remainingMs = avgMs * Math.max(total - done, 0);

  console.log(
    `[${label}] ${done}/${total} (${percent}%) ${formatTarget(target)} | success=${completed} failed=${failed} rows=${rowsLoaded} elapsed=${formatDuration(elapsedMs)} eta=${formatDuration(remainingMs)}`
  );
}

export function buildStandingsUrl({ apiBase, seasonYear, standingType, eventAbbrev, scopeId }) {
  const params = new URLSearchParams({
    year: String(seasonYear),
    type: cleanText(standingType)?.toLowerCase() || "",
    id: scopeId === null || scopeId === undefined ? "" : String(scopeId),
    event: cleanText(eventAbbrev)?.toUpperCase() || "",
  });
  return `${apiBase}/standings?${params.toString()}`;
}

export async function fetchJsonWithMeta(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  const body = await res.json();
  if (body.error) throw new Error(`API error for ${url}: ${JSON.stringify(body.error)}`);
  return {
    data: body.data || [],
    httpStatus: res.status,
  };
}

export async function fetchJson(url) {
  const { data } = await fetchJsonWithMeta(url);
  return data;
}

export function createPool() {
  return new Pool({ connectionString: getRequiredEnv("DATABASE_URL") });
}

export async function createScrapeRun(client, { runType, targetCount = 0, metadata = {} }) {
  const result = await client.query(
    `INSERT INTO prca_scrape_runs (run_type, target_count, metadata)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [runType, targetCount, JSON.stringify(metadata)]
  );
  return result.rows[0].id;
}

export async function finishScrapeRun(client, { runId, status, successCount, failureCount, rowsReceived, rowsLoaded, message }) {
  await client.query(
    `UPDATE prca_scrape_runs
     SET status = $2,
         completed_at = NOW(),
         success_count = $3,
         failure_count = $4,
         rows_received = $5,
         rows_loaded = $6,
         message = $7
     WHERE id = $1`,
    [runId, status, successCount, failureCount, rowsReceived, rowsLoaded, message]
  );
}

async function createScrapeRequest(client, request) {
  const result = await client.query(
    `INSERT INTO prca_scrape_requests (
       scrape_run_id, source_url, season_year, standing_type, event_abbrev,
       tour_id, circuit_id, scope_id, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      request.scrapeRunId ?? null,
      request.sourceUrl,
      request.seasonYear,
      request.standingType,
      request.eventAbbrev,
      request.tourId ?? null,
      request.circuitId ?? null,
      request.scopeId ?? null,
      JSON.stringify(request.metadata ?? {}),
    ]
  );
  return result.rows[0].id;
}

async function finishScrapeRequest(client, request) {
  await client.query(
    `UPDATE prca_scrape_requests
     SET completed_at = NOW(),
         duration_ms = $2,
         status = $3,
         http_status = $4,
         rows_received = $5,
         rows_loaded = $6,
         error_message = $7
     WHERE id = $1`,
    [
      request.requestId,
      request.durationMs,
      request.status,
      request.httpStatus ?? null,
      request.rowsReceived ?? 0,
      request.rowsLoaded ?? 0,
      request.errorMessage ? String(request.errorMessage).slice(0, 1000) : null,
    ]
  );
}

export async function upsertEventTypes(client, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO prca_event_types (
         event_type_id, event_abbrev, event_name, is_standings_event, is_results_event, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (event_type_id)
       DO UPDATE SET
         event_abbrev = EXCLUDED.event_abbrev,
         event_name = EXCLUDED.event_name,
         is_standings_event = EXCLUDED.is_standings_event,
         is_results_event = EXCLUDED.is_results_event,
         updated_at = NOW()`,
      [
        row.EventTypeId,
        cleanText(row.EventAbbrev),
        cleanText(row.EventName),
        normalizeBoolean(row.IsStandingsEvent, true),
        normalizeBoolean(row.IsResultsEvent, true),
      ]
    );
  }
}

export async function upsertCircuits(client, rows) {
  for (const row of rows) {
    const name = cleanText(row.Name);
    await client.query(
      `INSERT INTO prca_circuits (circuit_id, name, code, is_deleted, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (circuit_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         code = EXCLUDED.code,
         is_deleted = EXCLUDED.is_deleted,
         updated_at = NOW()`,
      [row.CircuitId, name, extractCircuitCode(name), Boolean(row.IsDeleted)]
    );
  }
}

export async function upsertTours(client, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO prca_tours (tour_id, name, description, is_active, is_deleted, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (tour_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         is_active = EXCLUDED.is_active,
         is_deleted = EXCLUDED.is_deleted,
         updated_at = NOW()`,
      [
        row.TourId,
        cleanText(row.Name),
        cleanText(row.Description),
        Boolean(row.IsActive),
        Boolean(row.IsDeleted),
      ]
    );
  }
}

export async function upsertStandings(client, rows, mediaBase, scrapeRequestId = null, keyContext = {}) {
  let count = 0;
  const placeCounts = rows.reduce((counts, row) => {
    const key = String(row.Place);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());

  for (const row of rows) {
    const placeIsTied = placeCounts.get(String(row.Place)) > 1;
    await client.query(
      `INSERT INTO prca_contestants (contestant_id, first_name, last_name, nick_name, hometown, sidearm_photo_url, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (contestant_id)
       DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         nick_name = EXCLUDED.nick_name,
         hometown = EXCLUDED.hometown,
         sidearm_photo_url = EXCLUDED.sidearm_photo_url,
         updated_at = NOW()`,
      [
        row.ContestantId,
        cleanText(row.FirstName),
        cleanText(row.LastName),
        cleanText(row.NickName),
        cleanText(row.Hometown),
        normalizePhotoUrl(row.SidearmPhotoUrl, mediaBase),
      ]
    );

    await client.query(
      `INSERT INTO prca_standings (
         id, standing_id, season_year, standing_type, event_abbrev, contestant_id, tour_id, circuit_id,
         place, earnings, points, source_payload, scrape_request_id, synced_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, NOW())
       ON CONFLICT (season_year, standing_type, event_abbrev, contestant_id, tour_id, circuit_id)
       DO UPDATE SET
         id = EXCLUDED.id,
         standing_id = EXCLUDED.standing_id,
         place = EXCLUDED.place,
         earnings = EXCLUDED.earnings,
         points = EXCLUDED.points,
         source_payload = EXCLUDED.source_payload,
         scrape_request_id = EXCLUDED.scrape_request_id,
         synced_at = NOW()`,
      [
        buildStandingsKey({
          standingType: keyContext.standingType,
          eventTypeId: keyContext.eventTypeId,
          scopeId: keyContext.scopeId,
          seasonYear: keyContext.seasonYear,
          place: row.Place,
          tieBreaker: placeIsTied ? row.ContestantId : null,
        }),
        row.StandingId,
        keyContext.seasonYear,
        keyContext.standingType,
        keyContext.eventAbbrev,
        row.ContestantId,
        keyContext.standingType === "tour" ? keyContext.scopeId : null,
        keyContext.standingType === "circuit" ? keyContext.scopeId : null,
        row.Place,
        row.Earnings,
        row.Points,
        JSON.stringify(row),
        scrapeRequestId,
      ]
    );
    count += 1;
  }
  return count;
}

export async function fetchLookups(apiBase) {
  const [eventTypes, circuits, tours] = await Promise.all([
    fetchJson(`${apiBase}/eventtypes`),
    fetchJson(`${apiBase}/circuits`),
    fetchJson(`${apiBase}/tours`),
  ]);

  return {
    eventTypes,
    circuits,
    tours,
    eventAbbrevs: eventTypes.map((x) => cleanText(x.EventAbbrev)).filter(Boolean),
    standingsEventAbbrevs: eventTypes
      .filter((x) => normalizeBoolean(x.IsStandingsEvent, true))
      .map((x) => cleanText(x.EventAbbrev))
      .filter(Boolean),
    resultsEventAbbrevs: eventTypes
      .filter((x) => normalizeBoolean(x.IsResultsEvent, true))
      .map((x) => cleanText(x.EventAbbrev))
      .filter(Boolean),
    eventTypeIdsByAbbrev: Object.fromEntries(
      eventTypes.map((x) => [cleanText(x.EventAbbrev), x.EventTypeId]).filter(([eventAbbrev]) => Boolean(eventAbbrev))
    ),
    activeTourIds: tours.filter((t) => !t.IsDeleted && t.IsActive).map((t) => t.TourId),
    activeCircuitIds: circuits.filter((c) => !c.IsDeleted && cleanText(c.Name) !== "N/A").map((c) => c.CircuitId),
  };
}

export async function upsertLookups(client, lookups) {
  await upsertEventTypes(client, lookups.eventTypes);
  await upsertCircuits(client, lookups.circuits);
  await upsertTours(client, lookups.tours);
}

export async function syncSingleStandings(client, options) {
  const { apiBase, mediaBase, seasonYear, standingType, eventAbbrev, eventTypeId, scopeId, scrapeRunId = null } = options;
  const standingsUrl = buildStandingsUrl({ apiBase, seasonYear, standingType, eventAbbrev, scopeId });
  const started = Date.now();
  const tourId = standingType === "tour" ? scopeId : null;
  const circuitId = standingType === "circuit" ? scopeId : null;
  const requestId = await createScrapeRequest(client, {
    scrapeRunId,
    sourceUrl: standingsUrl,
    seasonYear,
    standingType,
    eventAbbrev,
    tourId,
    circuitId,
    scopeId,
  });

  try {
    const { data: rows, httpStatus } = await fetchJsonWithMeta(standingsUrl);
    const loaded = await upsertStandings(client, rows, mediaBase, requestId, {
      standingType,
      eventTypeId,
      eventAbbrev,
      scopeId,
      seasonYear,
    });
    await finishScrapeRequest(client, {
      requestId,
      durationMs: Date.now() - started,
      status: "success",
      httpStatus,
      rowsReceived: rows.length,
      rowsLoaded: loaded,
    });
    return { requestId, rowsReceived: rows.length, rowsLoaded: loaded };
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
