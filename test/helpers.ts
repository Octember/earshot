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
// The first MESSAGE ref in the session's latest prompt — the default "answer whatever woke me".
export function firstRef(sess: { prompts: string[] }): string {
  const prompt = sess.prompts.at(-1) ?? "";
  const m = /\[(r\d+)\] /.exec(prompt);
  if (!m) throw new Error(`no message ref in prompt: ${prompt.slice(0, 120)}`);
  return m[1]!;
}

// The [rN] tag on the prompt line matching `pattern` — a message line ("[r3] [to you] [<#C1>…")
// or a conversation line ("[r1 <#C1> thread=…]"). Tests address exactly like the model: from
// what was rendered, never from composed coordinates.
export function refIn(prompt: string, pattern: string | RegExp): string {
  const re = typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : pattern;
  for (const line of prompt.split("\n")) {
    if (!re.test(line)) continue;
    const m = /\[(r\d+)[\] ]/.exec(line);
    if (m) return m[1]!;
  }
  throw new Error(`no ref found for ${String(pattern)} in prompt:\n${prompt}`);
}
