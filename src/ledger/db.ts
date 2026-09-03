import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type Ledger = BunSQLiteDatabase<typeof schema>;

const orms = new WeakMap<Database, Ledger>();

export function orm(db: Database): Ledger {
  let cached = orms.get(db);
  if (!cached) {
    cached = drizzle(db, { schema });
    orms.set(db, cached);
  }
  return cached;
}

const SCHEMA_VERSION = 23;

export function openLedger(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version").get();
  if (row !== null && row.version !== SCHEMA_VERSION) {
    throw new Error(
      `ledger schema version ${row.version} does not match this build (${SCHEMA_VERSION}); migrations were removed at 17`,
    );
  }
  db.run(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  if (row === null) db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  return db;
}
