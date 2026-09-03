import { SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect, type SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

const dialect = new SQLiteSyncDialect();

function literal(value: unknown): string {
  if (value instanceof SQL) return bare(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replaceAll("'", "''")}'`;
}

function bare(fragment: SQL): string {
  return dialect.sqlToQuery(fragment).sql.replaceAll(/"[a-z_]+"\."([a-z_]+)"/g, "$1");
}

function tableDdl(table: SQLiteTable): string[] {
  const t = getTableConfig(table);
  const lines: string[] = [];
  for (const column of t.columns) {
    if (column.generated) continue;
    const parts = [column.name, column.getSQLType()];
    if (column.primary) parts.push("PRIMARY KEY");
    if (column.notNull) parts.push("NOT NULL");
    if (column.isUnique) parts.push("UNIQUE");
    if (column.default !== undefined) parts.push(`DEFAULT ${literal(column.default)}`);
    const enumValues = (column as { enumValues?: string[] }).enumValues;
    if (enumValues?.length)
      parts.push(`CHECK (${column.name} IN (${enumValues.map((v) => literal(v)).join(",")}))`);
    lines.push(parts.join(" "));
  }
  for (const pk of t.primaryKeys)
    lines.push(`PRIMARY KEY (${pk.columns.map((c) => c.name).join(", ")})`);
  for (const fk of t.foreignKeys) {
    const ref = fk.reference();
    lines.push(
      `FOREIGN KEY (${ref.columns.map((c) => c.name).join(", ")}) REFERENCES ${getTableConfig(ref.foreignTable).name}(${ref.foreignColumns.map((c) => c.name).join(", ")})`,
    );
  }
  for (const c of t.checks) lines.push(`CHECK (${bare(c.value)})`);
  const out = [`CREATE TABLE IF NOT EXISTS ${t.name} (\n  ${lines.join(",\n  ")}\n);`];
  for (const index of t.indexes) {
    const cfg = index.config;
    const cols = cfg.columns.map((c) => ("name" in c ? c.name : bare(c)));
    const where = cfg.where ? ` WHERE ${bare(cfg.where)}` : "";
    out.push(
      `CREATE ${cfg.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${cfg.name} ON ${t.name} (${cols.join(", ")})${where};`,
    );
  }
  return out;
}

const RAW = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TRIGGER IF NOT EXISTS tasks_transition_legal
BEFORE UPDATE OF status ON tasks
WHEN NOT (
     (OLD.status = 'open'    AND NEW.status IN ('active','done'))
  OR (OLD.status = 'active'  AND NEW.status IN ('waiting','open','done'))
  OR (OLD.status = 'waiting' AND NEW.status IN ('open','done')))
BEGIN SELECT RAISE(ABORT, 'illegal task transition (SPEC §6.1)'); END;

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='');
CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, text) VALUES (new.rowid, coalesce(json_extract(new.payload, '$.text'), ''));
END;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='');
CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts (rowid, content) VALUES (new.rowid, new.content);
END;
`;

export function ddl(): string {
  const tables = Object.values(schema as Record<string, unknown>).filter(
    (value): value is SQLiteTable =>
      typeof value === "object" && value !== null && "getSQL" in value,
  );
  return [
    ...tables.filter((t) => !getTableConfig(t).name.endsWith("_fts")).flatMap((t) => tableDdl(t)),
    RAW,
  ].join("\n");
}
