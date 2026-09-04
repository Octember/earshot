import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { ddl } from "./ddl";

export type Ledger = BunSQLiteDatabase<typeof schema>;

const SCHEMA_VERSION = 29;

export async function openLedger(path: string): Promise<Ledger> {
  const db = drizzle(new Database(path, { create: true }), { schema });
  db.run(sql`PRAGMA journal_mode = WAL`);
  db.run(sql`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = db.get<{ version: number }>(sql`SELECT version FROM schema_version`);
  if (!row) {
    for (const statement of (await ddl()).split(";\n").filter((s) => s.trim()))
      db.run(sql.raw(statement));
    db.run(sql`INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION})`);
  } else if (row.version !== SCHEMA_VERSION) {
    throw new Error(
      `ledger schema version ${row.version} does not match this build (${SCHEMA_VERSION})`,
    );
  }
  return db;
}
