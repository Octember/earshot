import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "./schema";

const RAW = `
CREATE TRIGGER tasks_transition_legal
BEFORE UPDATE OF status ON tasks
WHEN NOT (
     (OLD.status = 'open'    AND NEW.status IN ('active','done'))
  OR (OLD.status = 'active'  AND NEW.status IN ('waiting','open','done'))
  OR (OLD.status = 'waiting' AND NEW.status IN ('open','done')))
BEGIN SELECT RAISE(ABORT, 'illegal task transition (SPEC §6.1)'); END;

CREATE VIRTUAL TABLE events_fts USING fts5(text, content='');
CREATE TRIGGER events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, text) VALUES (new.rowid, coalesce(json_extract(new.payload, '$.text'), ''));
END;
CREATE VIRTUAL TABLE memory_fts USING fts5(content, content='');
CREATE TRIGGER memory_fts_insert AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts (rowid, content) VALUES (new.rowid, new.content);
END;
`;

export async function ddl(): Promise<string> {
  const tables = Object.fromEntries(
    Object.entries(schema).filter(([name]) => !name.endsWith("Fts")),
  );
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson(tables),
  );
  return [...statements, RAW].join("\n");
}
