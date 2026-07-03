import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/log";

function capture() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe("createLogger (SPEC §15 structured logs)", () => {
  test("emits one JSON line per call with level, message, timestamp, and fields", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, clock: () => "2026-07-02T00:00:00Z" });

    log.info("task dispatched", { identity_id: "eng", task_id: "T-1" });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toEqual({ at: "2026-07-02T00:00:00Z", level: "info", msg: "task dispatched", identity_id: "eng", task_id: "T-1" });
  });

  test("carries the standard context keys through (identity_id, task_id, turn_id, anchor)", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, clock: () => "2026-07-02T00:00:00Z" });

    log.warn("stall", { identity_id: "eng", task_id: "T-1", turn_id: "turn-9", anchor: { venueId: "C1", threadRootId: null } });
    const rec = JSON.parse(lines[0]!);
    expect(rec.turn_id).toBe("turn-9");
    expect(rec.anchor).toEqual({ venueId: "C1", threadRootId: null });
    expect(rec.level).toBe("warn");
  });

  test("a call with no fields still emits a valid record", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, clock: () => "2026-07-02T00:00:00Z" });
    log.error("boom");
    expect(JSON.parse(lines[0]!)).toEqual({ at: "2026-07-02T00:00:00Z", level: "error", msg: "boom" });
  });

  test("redacts obviously-sensitive field values (SPEC §10.6: secrets never logged)", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, clock: () => "2026-07-02T00:00:00Z" });
    log.info("connecting", { bot_token: "xoxb-supersecret", app_token: "xapp-secret", venue: "C1" });
    const rec = JSON.parse(lines[0]!);
    expect(rec.bot_token).toBe("[redacted]");
    expect(rec.app_token).toBe("[redacted]");
    expect(rec.venue).toBe("C1"); // non-sensitive fields pass through
  });
});
