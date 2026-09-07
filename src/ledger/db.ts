import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sql } from "drizzle-orm";
import type { InjectionToken } from "tsyringe";
import * as schema from "./schema";

export type Ledger = BunSQLiteDatabase<typeof schema>;
export const LEDGER: InjectionToken<Ledger> = Symbol("ledger");

export function openLedger(path: string): Ledger {
  const db = drizzle(path, { schema });
  db.run(sql`PRAGMA journal_mode = WAL`);
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}
