import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL. Add it to .env or export it before running db:init.");
}

const schemaSql = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(schemaSql);
  console.log("Database schema initialized.");
} finally {
  await pool.end();
}
