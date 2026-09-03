import { readFileSync } from "node:fs";
import { Database, type SQLQueryBindings } from "bun:sqlite";
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

/* oxlint-disable typescript/no-unnecessary-type-parameters */
export function one<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T | null {
  const stmt = db.query<T, SQLQueryBindings[]>(sql);
  return stmt.get(...params);
}

export function many<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T[] {
  const stmt = db.query<T, SQLQueryBindings[]>(sql);
  return stmt.all(...params);
}
/* oxlint-enable typescript/no-unnecessary-type-parameters */

const SCHEMA_VERSION = 17;

export function openLedger(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = one<{ version: number }>(db, "SELECT version FROM schema_version");
  if (row !== null && row.version !== SCHEMA_VERSION) {
    throw new Error(
      `ledger schema version ${row.version} does not match this build (${SCHEMA_VERSION}); migrations were removed at 17`,
    );
  }
  db.run(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  if (row === null) db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  return db;
}
