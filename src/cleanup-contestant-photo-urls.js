import { createPool, normalizePhotoUrl } from "./lib.js";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  let updated = 0;

  try {
    const result = await client.query(
      `SELECT contestant_id, sidearm_photo_url
       FROM prca_contestants
       WHERE sidearm_photo_url IS NOT NULL`
    );

    for (const row of result.rows) {
      const normalized = normalizePhotoUrl(row.sidearm_photo_url);
      if (normalized === row.sidearm_photo_url) continue;

      await client.query(
        `UPDATE prca_contestants
         SET sidearm_photo_url = $2,
             updated_at = NOW()
         WHERE contestant_id = $1`,
        [row.contestant_id, normalized]
      );
      updated += 1;
    }

    console.log(`Contestant photo URL cleanup completed. scanned=${result.rowCount} updated=${updated}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
