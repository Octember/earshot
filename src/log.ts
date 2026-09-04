import { now } from "./ledger/clock";

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key/i;

function emit(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) {
  const redacted = Object.fromEntries(
    Object.entries(fields ?? {}).map(([key, value]) => [
      key,
      SECRET_KEY.test(key) ? "[redacted]" : value,
    ]),
  );
  console.log(JSON.stringify({ at: now(), level, msg, ...redacted }));
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => {
    emit("info", msg, fields);
  },
  warn: (msg: string, fields?: Record<string, unknown>) => {
    emit("warn", msg, fields);
  },
  error: (msg: string, fields?: Record<string, unknown>) => {
    emit("error", msg, fields);
  },
};
