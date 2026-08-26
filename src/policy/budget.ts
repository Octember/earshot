// Spend metering and budget caps (§10.3); calendar-monthly in configured timezone.
import type { Database } from "bun:sqlite";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Clock } from "../ledger/clock";
import { orm } from "../ledger/db";
import { executions, turns } from "../ledger/schema";

// 35 days covers any calendar month + timezone skew without TZ-aware SQL.
const SCAN_WINDOW_MS = 35 * 24 * 60 * 60 * 1000;

function monthKey(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(
    new Date(iso),
  );
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
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
  return rows.filter((row) => monthKey(row.startedAt, timezone) === key).reduce((sum, row) => sum + row.spendAmount, 0);
}

export function identitySpendThisMonth(db: Database, clock: Clock, identityId: string, timezone: string): number {
  return sumSpendThisMonth(db, clock(), timezone, identityId);
}

export function globalSpendThisMonth(db: Database, clock: Clock, timezone: string): number {
  return sumSpendThisMonth(db, clock(), timezone, null);
}

// Lifetime total — per_task_cap is not calendar-monthly.
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

export function budgetHeadroomChecker(db: Database, clock: Clock, policy: BudgetHeadroomPolicy): (identityId: string) => boolean {
  return (identityId: string) =>
    budgetStatus(
      db,
      clock,
      { timezone: policy.timezone, globalMonthlyCap: policy.globalMonthlyCap, reserve: policy.reserve, identityMonthlyCap: policy.identityMonthlyCap(identityId) },
      identityId,
    ).hasHeadroom;
}
