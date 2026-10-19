/**
 * Applies db/migrations/*.sql in order, once each, as the schema owner.
 * Then sets the runtime role's password from APP_DB_PASSWORD.
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
const applied = new Set(rows.map((r) => r.name));

const dir = new URL("../db/migrations/", import.meta.url);
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(new URL(file, dir), "utf8");
  process.stdout.write(`applying ${file} ... `);
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log("ok");
  } catch (err) {
    await client.query("ROLLBACK");
    console.log("FAILED");
    throw err;
  }
}

if (process.env.APP_DB_PASSWORD) {
  await client.query(`ALTER ROLE app_user WITH LOGIN PASSWORD ${client.escapeLiteral(process.env.APP_DB_PASSWORD)}`);
}
await client.end();
console.log("migrations up to date");
