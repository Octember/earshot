import { systemClock } from "./ledger/clock";

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

export function createLogger(): Logger {
  const emit = (
    level: "info" | "warn" | "error",
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    console.log(
      JSON.stringify({ at: systemClock(), level, msg, ...(fields ? redact(fields) : {}) }),
    );
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
