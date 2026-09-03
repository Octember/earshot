import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../src/ledger/clock";

export function fakeClock(
  start = "2026-07-02T00:00:00Z",
): Clock & { set: (iso: string) => void; advance: (iso: string) => void } {
  let now = start;
  const set = (iso: string) => {
    now = iso;
  };
  return Object.assign(() => now, { set, advance: set });
}

export function tempDbPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}.db`);
}

// WAL leaves -wal/-shm sidecars; remove all three.
export function cleanupDbFile(path: string): void {
  for (const filePath of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(filePath)) unlinkSync(filePath);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
