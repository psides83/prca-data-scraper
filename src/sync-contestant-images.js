import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPool, createScrapeRun, finishScrapeRun, formatDuration, sleep, withJitter } from "./lib.js";

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing required env var: ${name}`);
  return process.env[name];
}

function cleanBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function getImageExtension(path) {
  const cleanPath = String(path).split("?")[0];
  const match = cleanPath.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

function contentTypeForExtension(ext) {
  const types = {
    jpg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return types[ext] || "application/octet-stream";
}

function buildSourceUrls(baseUrl, sidearmPhotoUrl) {
  return {
    original: `${baseUrl}${sidearmPhotoUrl}`,
    size315: `${baseUrl}${sidearmPhotoUrl}?width=315&height=315`,
  };
}

async function fetchImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image request failed (${response.status}): ${url}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    contentType: response.headers.get("content-type") || null,
  };
}

async function uploadImage(s3, { bucket, key, bytes, contentType }) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
}

async function loadContestants(client, { limit, force }) {
  const params = [];
  const filters = ["sidearm_photo_url IS NOT NULL", "sidearm_photo_url <> ''"];

  if (!force) {
    filters.push("(image_sync_status IS DISTINCT FROM 'success' OR image_original_key IS NULL OR image_315_key IS NULL)");
  }

  const limitSql = limit ? `LIMIT ${Number(limit)}` : "";
  const result = await client.query(
    `SELECT contestant_id, sidearm_photo_url
     FROM prca_contestants
     WHERE ${filters.join(" AND ")}
     ORDER BY contestant_id
     ${limitSql}`,
    params
  );
  return result.rows;
}

async function markImageSyncSuccess(client, contestantId, values) {
  await client.query(
    `UPDATE prca_contestants
     SET image_original_key = $2,
         image_original_url = $3,
         image_315_key = $4,
         image_315_url = $5,
         image_synced_at = NOW(),
         image_sync_status = 'success',
         image_sync_error = NULL,
         updated_at = NOW()
     WHERE contestant_id = $1`,
    [contestantId, values.originalKey, values.originalUrl, values.size315Key, values.size315Url]
  );
}

async function markImageSyncFailure(client, contestantId, error) {
  await client.query(
    `UPDATE prca_contestants
     SET image_synced_at = NOW(),
         image_sync_status = 'failed',
         image_sync_error = $2,
         updated_at = NOW()
     WHERE contestant_id = $1`,
    [contestantId, String(error.message || error).slice(0, 1000)]
  );
}

async function main() {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const bucket = requireEnv("R2_BUCKET");
  const publicBaseUrl = cleanBaseUrl(requireEnv("R2_PUBLIC_BASE_URL"));
  const sourceBaseUrl = cleanBaseUrl(process.env.PRCA_IMAGE_BASE_URL || "https://d1kfpvgfupbmyo.cloudfront.net");
  const limit = process.env.IMAGE_SYNC_LIMIT ? Number(process.env.IMAGE_SYNC_LIMIT) : null;
  const force = process.env.IMAGE_SYNC_FORCE === "true";
  const baseDelayMs = Number(process.env.IMAGE_SYNC_DELAY_MS || 300);
  const jitterMs = Number(process.env.IMAGE_SYNC_JITTER_MS || 300);

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const pool = createPool();
  const client = await pool.connect();
  let scrapeRunId = null;
  let completed = 0;
  let failed = 0;
  const startedAt = Date.now();

  try {
    const contestants = await loadContestants(client, { limit, force });
    console.log(`Image sync targets: ${contestants.length}`);

    scrapeRunId = await createScrapeRun(client, {
      runType: "contestant_images_sync",
      targetCount: contestants.length,
      metadata: {
        bucket,
        publicBaseUrl,
        sourceBaseUrl,
        limit,
        force,
        imageSyncDelayMs: baseDelayMs,
        imageSyncJitterMs: jitterMs,
      },
    });

    for (const [index, contestant] of contestants.entries()) {
      const ext = getImageExtension(contestant.sidearm_photo_url);
      const contentType = contentTypeForExtension(ext);
      const originalKey = `contestants/${contestant.contestant_id}/original.${ext}`;
      const size315Key = `contestants/${contestant.contestant_id}/315.${ext}`;
      const sourceUrls = buildSourceUrls(sourceBaseUrl, contestant.sidearm_photo_url);

      try {
        console.log(`[images] starting ${index + 1}/${contestants.length}: contestant=${contestant.contestant_id}`);
        const [original, size315] = await Promise.all([fetchImage(sourceUrls.original), fetchImage(sourceUrls.size315)]);

        await uploadImage(s3, {
          bucket,
          key: originalKey,
          bytes: original.bytes,
          contentType: original.contentType || contentType,
        });
        await uploadImage(s3, {
          bucket,
          key: size315Key,
          bytes: size315.bytes,
          contentType: size315.contentType || contentType,
        });

        await markImageSyncSuccess(client, contestant.contestant_id, {
          originalKey,
          originalUrl: `${publicBaseUrl}/${originalKey}`,
          size315Key,
          size315Url: `${publicBaseUrl}/${size315Key}`,
        });
        completed += 1;
      } catch (err) {
        failed += 1;
        await markImageSyncFailure(client, contestant.contestant_id, err);
        console.error(`[images] failed contestant=${contestant.contestant_id}: ${err.message || err}`);
      }

      const done = index + 1;
      const percent = contestants.length ? ((done / contestants.length) * 100).toFixed(1) : "100.0";
      console.log(
        `[images] ${done}/${contestants.length} (${percent}%) success=${completed} failed=${failed} elapsed=${formatDuration(Date.now() - startedAt)}`
      );

      if (done < contestants.length) {
        const delay = withJitter(baseDelayMs, jitterMs);
        console.log(`[images] waiting ${delay}ms before next contestant`);
        await sleep(delay);
      }
    }

    await finishScrapeRun(client, {
      runId: scrapeRunId,
      status: failed > 0 ? "completed_with_errors" : "success",
      successCount: completed,
      failureCount: failed,
      rowsReceived: contestants.length,
      rowsLoaded: completed,
      message: `Contestant image sync completed. success=${completed} failed=${failed}`,
    });
    console.log(`Contestant image sync completed. success=${completed} failed=${failed}`);
  } catch (err) {
    if (scrapeRunId) {
      await finishScrapeRun(client, {
        runId: scrapeRunId,
        status: "failed",
        successCount: completed,
        failureCount: failed,
        rowsReceived: completed + failed,
        rowsLoaded: completed,
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
