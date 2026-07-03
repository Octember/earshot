import { Database } from "bun:sqlite";

const SCHEMA_VERSION = 1;

export function openLedger(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schemaSql());

  const row = db.query("SELECT version FROM schema_version").get() as { version: number } | null;
  if (row === null) {
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (row.version !== SCHEMA_VERSION) {
    throw new Error(
      `ledger schema version ${row.version} needs migration to ${SCHEMA_VERSION} — no migration path exists yet`,
    );
  }
  return db;
}

function schemaSql(): string {
  const url = new URL("./schema.sql", import.meta.url);
  return require("fs").readFileSync(url, "utf8");
}
