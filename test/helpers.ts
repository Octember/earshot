import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function tempDbPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}.db`);
}

// WAL mode leaves -wal/-shm sidecar files alongside the main db file; all three need removing.
export function cleanupDbFile(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

// What a scripted "model" reads off a delivered inbox line — `[<#C1> thread=X ts=Y]` — to
// address its reply (SPEC §11 explicit addressing: posting tools take the line's coordinates).
export function promptCoords(sess: { prompts: string[] }): { venueId: string; threadRootId: string | null } {
  const line = sess.prompts.at(-1) ?? "";
  const m = line.match(/\[<#(.+?)>(?: thread=(\S+))? ts=(\S+)\]/);
  if (!m) throw new Error(`no inbox-line coordinates in prompt: ${line.slice(0, 120)}`);
  return { venueId: m[1]!, threadRootId: m[2] ?? m[3] ?? null };
}
