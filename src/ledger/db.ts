import { Database } from "bun:sqlite";

const SCHEMA_VERSION = 3;

// Each entry migrates a fresh install from version N-1 to N. schema.sql always reflects the
// current shape (for fresh databases); this ladder steps an existing on-disk database forward.
const MIGRATIONS: Record<number, string> = {
  2: "ALTER TABLE tasks ADD COLUMN consecutive_interruptions INTEGER NOT NULL DEFAULT 0",
  3: `CREATE TABLE IF NOT EXISTS thread_participation (
    venue_id       TEXT NOT NULL,
    thread_root_id TEXT NOT NULL,
    identity_id    TEXT NOT NULL,
    first_at       TEXT NOT NULL,
    PRIMARY KEY (venue_id, thread_root_id)
  )`,
};

export function openLedger(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schemaSql());

  const row = db.query("SELECT version FROM schema_version").get() as { version: number } | null;
  if (row === null) {
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (row.version > SCHEMA_VERSION) {
    throw new Error(`ledger schema version ${row.version} is newer than this build supports (${SCHEMA_VERSION})`);
  } else if (row.version < SCHEMA_VERSION) {
    for (let v = row.version + 1; v <= SCHEMA_VERSION; v++) {
      const migration = MIGRATIONS[v];
      if (!migration) throw new Error(`no migration defined to reach schema version ${v}`);
      db.exec(migration);
    }
    db.query("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  }
  return db;
}

function schemaSql(): string {
  const url = new URL("./schema.sql", import.meta.url);
  return require("fs").readFileSync(url, "utf8");
}

// M9: a database under WAL for weeks accumulates a growing -wal file if it's never checkpointed
// (the service is a long-lived single writer, so auto-checkpoint on connection close never fires).
// TRUNCATE folds the WAL back into the main db and shrinks the -wal file. Safe to call
// periodically on a low-frequency timer; a no-op on :memory: databases.
export function checkpointWal(db: Database): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
