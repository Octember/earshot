import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { ddl } from "./ddl";

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

const SCHEMA_VERSION = 29;

export async function openLedger(path: string): Promise<Database> {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version").get();
  if (row === null) {
    db.run(await ddl());
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (row.version !== SCHEMA_VERSION) {
    throw new Error(
      `ledger schema version ${row.version} does not match this build (${SCHEMA_VERSION}); migrations were removed at 17`,
    );
  }
  return db;
}
