export type Clock = () => string;

export function systemClock(): string {
  return new Date().toISOString();
}
