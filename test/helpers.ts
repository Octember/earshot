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
