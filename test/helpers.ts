import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../src/ledger/clock";

export function fakeClock(start = "2026-07-02T00:00:00Z"): Clock & { set: (iso: string) => void; advance: (iso: string) => void } {
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

// First MESSAGE ref in session prompt (SPEC §11 addressing).
export function firstRef(sess: { prompts: string[] }): string {
  const prompt = sess.prompts.at(-1) ?? "";
  const match = /\[(r\d+)\] /.exec(prompt);
  if (!match) throw new Error(`no message ref in prompt: ${prompt.slice(0, 120)}`);
  return match[1]!;
}

// [rN] tag on prompt line matching pattern (address from render).
export function refIn(prompt: string, pattern: string | RegExp): string {
  const patternRe = typeof pattern === "string" ? new RegExp(pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")) : pattern;
  for (const line of prompt.split("\n")) {
    if (!patternRe.test(line)) continue;
    const match = /\[(r\d+)[\] ]/.exec(line);
    if (match) return match[1]!;
  }
  throw new Error(`no ref found for ${String(pattern)} in prompt:\n${prompt}`);
}
