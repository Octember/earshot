import { SECRET_ENV } from "@bevyl-ai/agent-tools";
import { now } from "./clock";

function emit(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) {
  const redacted = Object.fromEntries(
    Object.entries(fields ?? {}).map(([key, value]) => [
      key,
      SECRET_ENV.test(key) ? "[redacted]" : value,
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
