// SPEC §10.3 — spend metering and budget caps. Spend is metered per turn (turns.spend_amount,
// already recorded by turns.ts) and aggregated here, calendar-monthly in the configured timezone.
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";

// A calendar month never exceeds 31 days and timezone skew is at most ~14h, so scanning 35 days
// back from "now" always covers the current calendar month in any timezone, without needing
// timezone-aware arithmetic inside SQL.
const SCAN_WINDOW_MS = 35 * 24 * 60 * 60 * 1000;

function monthKey(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(
    new Date(iso),
  );
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${year}-${month}`;
}

function sumSpendThisMonth(db: Database, now: string, timezone: string, identityId: string | null): number {
  const key = monthKey(now, timezone);
  const since = new Date(new Date(now).getTime() - SCAN_WINDOW_MS).toISOString();
  const rows = identityId
    ? (db.query("SELECT spend_amount, started_at FROM turns WHERE identity_id = ? AND started_at >= ?").all(identityId, since) as {
        spend_amount: number;
        started_at: string;
      }[])
    : (db.query("SELECT spend_amount, started_at FROM turns WHERE started_at >= ?").all(since) as {
        spend_amount: number;
        started_at: string;
      }[]);
  return rows.filter((r) => monthKey(r.started_at, timezone) === key).reduce((sum, r) => sum + r.spend_amount, 0);
}

export function identitySpendThisMonth(db: Database, clock: Clock, identityId: string, timezone: string): number {
  return sumSpendThisMonth(db, clock(), timezone, identityId);
}

export function globalSpendThisMonth(db: Database, clock: Clock, timezone: string): number {
  return sumSpendThisMonth(db, clock(), timezone, null);
}

// Lifetime, not month-scoped — per_task_cap is a cap on the task's total cost, not a recurring
// monthly allowance (SPEC §4.1.11 declares it alongside monthly caps but without the "calendar
// month" qualifier those get).
export function taskSpend(db: Database, taskId: string): number {
  const row = db
    .query(
      `SELECT COALESCE(SUM(t.spend_amount), 0) as total FROM turns t
       JOIN executions e ON e.id = t.execution_id WHERE e.task_id = ?`,
    )
    .get(taskId) as { total: number };
  return row.total;
}

export interface BudgetStatus {
  identitySpend: number;
  identityCap: number;
  globalSpend: number;
  globalCap: number;
  hasHeadroom: boolean;
  hasReserveHeadroom: boolean;
}

export interface BudgetStatusPolicy {
  timezone: string;
  identityMonthlyCap: number;
  globalMonthlyCap: number;
  reserve: number;
}

// SPEC §10.3: reaching the identity OR global cap denies headroom; a small reserve stays usable
// (by restricted interactive turns only — steer/cancel/confirm/reply) until it too is exhausted.
export function budgetStatus(db: Database, clock: Clock, policy: BudgetStatusPolicy, identityId: string): BudgetStatus {
  const identitySpend = identitySpendThisMonth(db, clock, identityId, policy.timezone);
  const globalSpend = globalSpendThisMonth(db, clock, policy.timezone);
  return {
    identitySpend,
    identityCap: policy.identityMonthlyCap,
    globalSpend,
    globalCap: policy.globalMonthlyCap,
    hasHeadroom: identitySpend < policy.identityMonthlyCap && globalSpend < policy.globalMonthlyCap,
    hasReserveHeadroom:
      identitySpend < policy.identityMonthlyCap + policy.reserve && globalSpend < policy.globalMonthlyCap + policy.reserve,
  };
}

export interface BudgetHeadroomPolicy {
  timezone: string;
  globalMonthlyCap: number;
  reserve: number;
  identityMonthlyCap: (identityId: string) => number;
}

// Factory for scheduler.dispatchRunnable's `hasBudgetHeadroom` hook (SPEC §6.2's "Dispatch MUST
// check budget headroom before launch").
export function budgetHeadroomChecker(db: Database, clock: Clock, policy: BudgetHeadroomPolicy): (identityId: string) => boolean {
  return (identityId: string) =>
    budgetStatus(
      db,
      clock,
      { timezone: policy.timezone, globalMonthlyCap: policy.globalMonthlyCap, reserve: policy.reserve, identityMonthlyCap: policy.identityMonthlyCap(identityId) },
      identityId,
    ).hasHeadroom;
}
