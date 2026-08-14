export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}
