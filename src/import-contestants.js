import { readFile } from "node:fs/promises";
import { createPool, upsertContestantProfiles } from "./lib.js";

function extractRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.Data)) return parsed.Data;
  throw new Error("Contestants JSON must be an array or an object with a data array.");
}

async function main() {
  const filePath = process.env.CONTESTANTS_FILE || "data/prca_contestants.json";
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  const rows = extractRows(parsed);
  const pool = createPool();
  const client = await pool.connect();

  try {
    const loaded = await upsertContestantProfiles(client, rows);
    console.log(`Contestant import completed. file=${filePath} rows=${rows.length} upserted=${loaded}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
