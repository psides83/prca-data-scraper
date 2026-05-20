import { neon } from "@neondatabase/serverless";

const DEFAULT_PAGE_SIZE = 2000;
const MAX_PAGE_SIZE = 2000;

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "public, max-age=300",
      ...headers,
    },
  });
}

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseScheduleDate(value) {
  if (!value) return null;
  const cleaned = String(value).trim();
  const match = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, month, day, year] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const isoMatch = cleaned.match(/^(\d{4})-\d{2}-\d{2}/);
  return isoMatch ? cleaned.slice(0, 10) : null;
}

function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10) + "T00:00:00";
  const text = String(value);
  return text.length >= 10 ? `${text.slice(0, 10)}T00:00:00` : text;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRodeoApiRow(row) {
  return {
    RodeoId: row.rodeo_id,
    RodeoNumber: row.rodeo_number,
    SeasonYear: row.season_year,
    Name: row.name,
    City: row.city,
    StateAbbrv: row.state_abbrv,
    StartDate: formatDate(row.start_date),
    EndDate: formatDate(row.end_date),
    Payout: toNumber(row.payout),
    WebsiteUrl: row.website_url,
    InProgress: row.in_progress,
    IsActive: row.is_active,
    VenueName: row.venue_name,
    VenueLatitude: toNumber(row.venue_latitude),
    VenueLongitude: toNumber(row.venue_longitude),
    VenueFormattedAddress: row.venue_formatted_address,
    VenuePlaceId: row.venue_place_id,
    VenueGeocodeProvider: row.venue_geocode_provider,
    VenueGeocodeStatus: row.venue_geocode_status,
    VenueGeocodedAt: row.venue_geocoded_at,
    CircuitId: row.circuit_id,
    CircuitIds: row.circuit_ids || [],
    TourIds: row.tour_ids || [],
    Daysheets: row.daysheets,
    HasDaysheets: row.has_daysheets,
  };
}

function buildScheduleQuery(url) {
  const params = url.searchParams;
  const pageSize = parsePositiveInt(params.get("page_size"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const pageIndex = parsePositiveInt(params.get("index"), 1);
  const offset = (pageIndex - 1) * pageSize;
  const startDate = parseScheduleDate(params.get("start"));
  const endDate = parseScheduleDate(params.get("end"));
  const active = params.get("active");
  const circuitId = parsePositiveInt(params.get("circuitId"), null);
  const tourId = parsePositiveInt(params.get("tourId"), null);
  const searchTerm = params.get("search_term")?.trim();

  const where = [];
  const values = [];

  if (startDate) {
    values.push(startDate);
    where.push(`end_date >= $${values.length}::date`);
  }

  if (endDate) {
    values.push(endDate);
    where.push(`start_date <= $${values.length}::date`);
  }

  if (active === "true" || active === "false") {
    values.push(active === "true");
    where.push(`is_active IS NOT DISTINCT FROM $${values.length}`);
  }

  if (circuitId) {
    values.push(circuitId);
    where.push(`(circuit_id = $${values.length} OR $${values.length} = ANY(circuit_ids))`);
  }

  if (tourId) {
    values.push(tourId);
    where.push(`$${values.length} = ANY(tour_ids)`);
  }

  if (searchTerm) {
    values.push(`%${searchTerm}%`);
    where.push(`(name ILIKE $${values.length} OR city ILIKE $${values.length} OR venue_name ILIKE $${values.length})`);
  }

  values.push(pageSize);
  const limitPlaceholder = `$${values.length}`;
  values.push(offset);
  const offsetPlaceholder = `$${values.length}`;

  return {
    text: `
      SELECT
        rodeo_id,
        rodeo_number,
        season_year,
        name,
        city,
        state_abbrv,
        start_date,
        end_date,
        payout,
        website_url,
        in_progress,
        is_active,
        venue_name,
        venue_latitude,
        venue_longitude,
        venue_formatted_address,
        venue_place_id,
        venue_geocode_provider,
        venue_geocode_status,
        venue_geocoded_at,
        circuit_id,
        circuit_ids,
        tour_ids,
        daysheets,
        has_daysheets
      FROM prca_rodeos
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY start_date NULLS LAST, end_date NULLS LAST, name NULLS LAST, rodeo_id
      LIMIT ${limitPlaceholder}
      OFFSET ${offsetPlaceholder}
    `,
    values,
  };
}

async function handleSchedule(request, env) {
  if (!env.DATABASE_URL) {
    return jsonResponse({ error: "DATABASE_URL is not configured", data: [] }, { status: 500 });
  }

  const url = new URL(request.url);
  const query = buildScheduleQuery(url);
  const sql = neon(env.DATABASE_URL);
  const rows = await sql.query(query.text, query.values);

  return jsonResponse({
    error: null,
    data: rows.map(toRodeoApiRow),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return jsonResponse(null);
    if (request.method !== "GET") return jsonResponse({ error: "Method not allowed", data: [] }, { status: 405 });

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({ error: null, data: { status: "ok" } });
    }

    if (url.pathname.endsWith("/schedule")) {
      try {
        return await handleSchedule(request, env);
      } catch (err) {
        return jsonResponse({ error: err.message || String(err), data: [] }, { status: 500 });
      }
    }

    return jsonResponse({ error: "Not found", data: [] }, { status: 404 });
  },
};
