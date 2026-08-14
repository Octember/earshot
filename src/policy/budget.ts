// SPEC §10.3 — spend metering and budget caps. Spend is metered per turn (turns.spend_amount,
// already recorded by turns.ts) and aggregated here, calendar-monthly in the configured timezone.
import type { Database } from "bun:sqlite";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Clock } from "../ledger/clock";
import { orm } from "../ledger/db";
import { executions, turns } from "../ledger/schema";

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
    ? orm(db)
        .select({ spendAmount: turns.spendAmount, startedAt: turns.startedAt })
        .from(turns)
        .where(and(eq(turns.identityId, identityId), gte(turns.startedAt, since)))
        .all()
    : orm(db).select({ spendAmount: turns.spendAmount, startedAt: turns.startedAt }).from(turns).where(gte(turns.startedAt, since)).all();
  return rows.filter((r) => monthKey(r.startedAt, timezone) === key).reduce((sum, r) => sum + r.spendAmount, 0);
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
  const row = orm(db)
    .select({ total: sql<number>`coalesce(sum(${turns.spendAmount}), 0)` })
    .from(turns)
    .innerJoin(executions, eq(executions.id, turns.executionId))
    .where(eq(executions.taskId, taskId))
    .get();
  return row?.total ?? 0;
}

export interface BudgetStatusPolicy {
  timezone: string;
  identityMonthlyCap: number;
  globalMonthlyCap: number;
  reserve: number;
}

// SPEC §10.3: reaching the identity OR global cap denies headroom; a small reserve stays usable
// (by restricted interactive turns only — steer/cancel/confirm/reply) until it too is exhausted.
export function budgetStatus(db: Database, clock: Clock, policy: BudgetStatusPolicy, identityId: string) {
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
