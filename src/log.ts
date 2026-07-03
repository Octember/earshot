// SPEC §15 — structured logs (REQUIRED), carrying identity_id and, where applicable,
// task_id/turn_id/anchor. One JSON line per record → stdout (a supervisor captures it) or any
// injected sink. §10.6 defensive redaction: field values under obviously-secret keys are masked so
// a stray `{ bot_token }` in a log call never leaks the credential.
import { systemClock, type Clock } from "./ledger/clock";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface CreateLoggerOpts {
  sink?: (line: string) => void; // default: stdout
  clock?: Clock; // default: systemClock (real wall-clock for log timestamps)
}

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : v;
  return out;
}

export function createLogger(opts: CreateLoggerOpts = {}): Logger {
  const sink = opts.sink ?? ((line: string) => console.log(line));
  const clock = opts.clock ?? systemClock;
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const record = { at: clock(), level, msg, ...(fields ? redact(fields) : {}) };
    sink(JSON.stringify(record));
  };
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
