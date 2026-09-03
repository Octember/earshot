import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { outwardCalls, type OutwardCall } from "./schema";
import { requireTask } from "./tasks-query";
import { transition } from "./tasks-transition";
import type { SteerResult } from "./tasks-steer";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function outwardCallKey(scopeId: string, tool: string, args: unknown) {
  return and(
    eq(outwardCalls.scopeId, scopeId),
    eq(outwardCalls.tool, tool),
    eq(outwardCalls.argsHash, canonicalJson(args)),
  );
}

export function outwardCallOf(
  db: Database,
  scopeId: string,
  tool: string,
  args: unknown,
): OutwardCall | undefined {
  return orm(db)
    .select()
    .from(outwardCalls)
    .where(outwardCallKey(scopeId, tool, args))
    .get();
}

export function setOutwardCallState(
  db: Database,
  clock: Clock,
  call: { identityId: string; scopeId: string; tool: string; args: unknown },
  state: OutwardCall["state"],
  extra: Partial<Pick<OutwardCall, "description" | "decidedBy" | "decidedAt">> = {},
): void {
  const at = clock();
  orm(db)
    .insert(outwardCalls)
    .values({
      identityId: call.identityId,
      scopeId: call.scopeId,
      tool: call.tool,
      argsHash: canonicalJson(call.args),
      at,
      state,
      ...extra,
    })
    .onConflictDoUpdate({
      target: [outwardCalls.scopeId, outwardCalls.tool, outwardCalls.argsHash],
      set: { at, state, ...extra },
    })
    .run();
}

export function pendingApprovalFor(db: Database, taskId: string): OutwardCall | undefined {
  return orm(db)
    .select()
    .from(outwardCalls)
    .where(and(eq(outwardCalls.scopeId, taskId), eq(outwardCalls.state, "pending_approval")))
    .orderBy(desc(outwardCalls.at))
    .get();
}

export function decideApproval(
  db: Database,
  clock: Clock,
  params: { identityId: string; taskId: string; principalId: string; approve: boolean },
): SteerResult {
  const task = requireTask(db, params.taskId, params.identityId);
  const pending = pendingApprovalFor(db, task.id);
  if (task.status !== "waiting" || task.waitingOn !== "human" || !pending)
    return { applied: false, task, reply: `${task.id} has no pending confirmation` };
  orm(db)
    .update(outwardCalls)
    .set({
      state: params.approve ? "approved" : "denied",
      decidedBy: params.principalId,
      decidedAt: clock(),
    })
    .where(eq(outwardCalls.id, pending.id))
    .run();
  return { applied: true, task: transition(db, clock, task.id, { type: "wake" }) };
}
