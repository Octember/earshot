import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { ddl } from "./ddl";

export type Ledger = BunSQLiteDatabase<typeof schema>;

const SCHEMA_VERSION = 29;

export async function openLedger(path: string): Promise<Ledger> {
  const client = new Database(path, { create: true });
  client.run("PRAGMA journal_mode = WAL");
  client.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = client.query<{ version: number }, []>("SELECT version FROM schema_version").get();
  if (row === null) {
    client.run(await ddl());
    client.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (row.version !== SCHEMA_VERSION) {
    throw new Error(
      `ledger schema version ${row.version} does not match this build (${SCHEMA_VERSION})`,
    );
  }
  return drizzle(client, { schema });
}
