import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "node:path";
import type { InjectionToken } from "tsyringe";
import * as schema from "./schema";

export type Ledger = BunSQLiteDatabase<typeof schema>;
export const LEDGER: InjectionToken<Ledger> = Symbol("ledger");

export function openLedger(path: string): Ledger {
  const client = new Database(path, { create: true });
  client.run("PRAGMA journal_mode = WAL");
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
  return db;
}
