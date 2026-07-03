// SPEC: timestamps are ISO-8601 UTC strings everywhere, injected — never Date.now() in ledger logic.
export type Clock = () => string;

export function systemClock(): string {
  return new Date().toISOString();
}
