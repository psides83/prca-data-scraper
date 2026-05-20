import {
  cleanText,
  createPool,
  createScrapeRun,
  finishScrapeRun,
  normalizeBoolean,
  normalizeOptionalInt,
  sleep,
  withJitter,
} from "./lib.js";

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

function getGeocodeApiKey() {
  const key = process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.GEOCODING_API_KEY;
  if (!key) {
    throw new Error("Missing geocoding API key. Set GOOGLE_GEOCODING_API_KEY, GOOGLE_MAPS_API_KEY, or GEOCODING_API_KEY.");
  }
  return key;
}

function buildVenueQuery(row) {
  return [row.venue_name, row.city, row.state_abbrv, "USA"].map((part) => cleanText(part)).filter(Boolean).join(", ");
}

function normalizeGeocodeStatus(status) {
  const cleaned = cleanText(status)?.toLowerCase();
  if (!cleaned) return "failed";
  if (cleaned === "ok") return "success";
  if (cleaned === "zero_results") return "no_results";
  return "failed";
}

async function fetchGoogleGeocode({ query, apiKey }) {
  const params = new URLSearchParams({
    address: query,
    components: "country:US",
    key: apiKey,
  });
  const res = await fetch(`${GOOGLE_GEOCODE_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`Geocode request failed with HTTP ${res.status}`);

  const body = await res.json();
  const status = cleanText(body.status);
  if (["OVER_DAILY_LIMIT", "OVER_QUERY_LIMIT", "REQUEST_DENIED"].includes(status)) {
    const err = new Error(cleanText(body.error_message) || status);
    err.fatal = true;
    throw err;
  }

  if (status === "OK") {
    const result = body.results?.[0];
    const location = result?.geometry?.location;
    if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
      throw new Error("Geocode response was OK but missing geometry location");
    }

    return {
      status: "success",
      latitude: location.lat,
      longitude: location.lng,
      formattedAddress: cleanText(result.formatted_address),
      placeId: cleanText(result.place_id),
      errorMessage: null,
    };
  }

  return {
    status: normalizeGeocodeStatus(status),
    latitude: null,
    longitude: null,
    formattedAddress: null,
    placeId: null,
    errorMessage: cleanText(body.error_message) || status || "Unknown geocode failure",
  };
}

async function fetchVenueTargets(client, { limit, force, retryFailed }) {
  const params = [];
  const filters = ["venue_name IS NOT NULL", "city IS NOT NULL", "state_abbrv IS NOT NULL"];

  if (!force) {
    if (retryFailed) {
      filters.push("(venue_latitude IS NULL OR venue_longitude IS NULL OR venue_geocode_status = 'failed')");
    } else {
      filters.push("(venue_latitude IS NULL OR venue_longitude IS NULL)");
      filters.push("(venue_geocode_status IS NULL OR venue_geocode_status <> 'no_results')");
    }
  }

  const limitSql = limit ? `LIMIT $${params.push(limit)}` : "";
  const result = await client.query(
    `SELECT
       MIN(rodeo_id) AS sample_rodeo_id,
       venue_name,
       city,
       state_abbrv,
       COUNT(*)::INTEGER AS rodeo_count
     FROM prca_rodeos
     WHERE ${filters.join(" AND ")}
     GROUP BY venue_name, city, state_abbrv
     ORDER BY MIN(start_date) NULLS LAST, venue_name, city, state_abbrv
     ${limitSql}`,
    params
  );
  return result.rows;
}

async function updateVenueRows(client, { target, query, result }) {
  const updated = await client.query(
    `UPDATE prca_rodeos
     SET venue_latitude = $4,
         venue_longitude = $5,
         venue_formatted_address = $6,
         venue_place_id = $7,
         venue_geocode_provider = 'google_geocoding',
         venue_geocode_query = $8,
         venue_geocode_status = $9,
         venue_geocode_error = $10,
         venue_geocoded_at = NOW(),
         updated_at = NOW()
     WHERE LOWER(venue_name) = LOWER($1)
       AND LOWER(city) = LOWER($2)
       AND LOWER(state_abbrv) = LOWER($3)`,
    [
      target.venue_name,
      target.city,
      target.state_abbrv,
      result.latitude,
      result.longitude,
      result.formattedAddress,
      result.placeId,
      query,
      result.status,
      result.errorMessage,
    ]
  );
  return updated.rowCount;
}

async function main() {
  const apiKey = getGeocodeApiKey();
  const limit = normalizeOptionalInt(process.env.GEOCODE_LIMIT);
  const delayMs = normalizeOptionalInt(process.env.GEOCODE_DELAY_MS) ?? 200;
  const jitterMs = normalizeOptionalInt(process.env.GEOCODE_JITTER_MS) ?? 200;
  const force = normalizeBoolean(process.env.GEOCODE_FORCE, false);
  const retryFailed = normalizeBoolean(process.env.GEOCODE_RETRY_FAILED, true);
  const pool = createPool();
  const client = await pool.connect();
  let runId;
  let successCount = 0;
  let failureCount = 0;
  let rowsLoaded = 0;

  try {
    const targets = await fetchVenueTargets(client, { limit, force, retryFailed });
    runId = await createScrapeRun(client, {
      runType: "venue_geocode",
      targetCount: targets.length,
      metadata: {
        provider: "google_geocoding",
        limit,
        force,
        retryFailed,
        delayMs,
        jitterMs,
      },
    });

    console.log(`Venue geocode targets: ${targets.length}`);

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const query = buildVenueQuery(target);
      console.log(`[venues] ${i + 1}/${targets.length}: ${query}`);

      try {
        const result = await fetchGoogleGeocode({ query, apiKey });
        const updatedRows = await updateVenueRows(client, { target, query, result });
        rowsLoaded += updatedRows;
        if (result.status === "success") {
          successCount += 1;
        } else {
          failureCount += 1;
          console.warn(`[venues] ${result.status}: ${query} (${result.errorMessage})`);
        }
      } catch (err) {
        if (err.fatal) throw err;
        failureCount += 1;
        const errorMessage = err.message || String(err);
        await updateVenueRows(client, {
          target,
          query,
          result: {
            status: "failed",
            latitude: null,
            longitude: null,
            formattedAddress: null,
            placeId: null,
            errorMessage,
          },
        });
        console.error(`[venues] failed: ${query}`);
        console.error(errorMessage);
      }

      if (i < targets.length - 1) await sleep(withJitter(delayMs, jitterMs));
    }

    await finishScrapeRun(client, {
      runId,
      status: failureCount > 0 ? "completed_with_errors" : "success",
      successCount,
      failureCount,
      rowsReceived: targets.length,
      rowsLoaded,
      message: `Venue geocode completed. success=${successCount} failed=${failureCount} rowsUpdated=${rowsLoaded}`,
    });

    console.log(`Venue geocode completed. success=${successCount} failed=${failureCount} rowsUpdated=${rowsLoaded}`);
  } catch (err) {
    if (runId) {
      await finishScrapeRun(client, {
        runId,
        status: "failed",
        successCount,
        failureCount: failureCount || 1,
        rowsReceived: 0,
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
