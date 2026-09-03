import { systemClock, type Clock } from "./ledger/clock";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields))
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : value;
  return out;
}

export function createLogger(
  opts: {
    sink?: (line: string) => void;
    clock?: Clock;
  } = {},
): Logger {
  const sink =
    opts.sink ??
    ((line: string) => {
      console.log(line);
    });
  const clock = opts.clock ?? systemClock;
  const emit = (
    level: "info" | "warn" | "error",
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    const record = { at: clock(), level, msg, ...(fields ? redact(fields) : {}) };
    sink(JSON.stringify(record));
  };
  return {
    info: (msg, fields) => {
      emit("info", msg, fields);
    },
    warn: (msg, fields) => {
      emit("warn", msg, fields);
    },
    error: (msg, fields) => {
      emit("error", msg, fields);
    },
  };
}
