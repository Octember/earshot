import { and, asc, count, eq, like, lte, min, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { inject, singleton, type InjectionToken } from "tsyringe";
import { z } from "zod";
import { now } from "./clock";
import * as schema from "./ledger/schema";
import { conversations, mutedThreads, tasks, type Conversation, type Task } from "./ledger/schema";
import { log } from "./log";

export type Db = BunSQLiteDatabase<typeof schema>;
export const DB: InjectionToken<Db> = Symbol("db");

export function openDb(path: string): Db {
  const db = drizzle(path, { schema });
  db.run(sql`PRAGMA journal_mode = WAL`);
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

export const TaskCreate = z.object({
  title: z.string(),
  spec: z.string(),
  channel: z.string(),
  thread_ts: z.string().optional(),
  tier: z.enum(tasks.tier.enumValues).optional(),
});

export type TransitionCause =
  | { type: "dispatch" }
  | { type: "wait"; waitingOn: "human"; why: string; wakeAt: string }
  | { type: "wait"; waitingOn: "timer"; wakeAt: string }
  | { type: "wake" }
  | { type: "finish"; outcome: NonNullable<Task["outcome"]>; report: string };

const LEGAL: Record<Task["status"], readonly Task["status"][]> = {
  open: ["active", "done"],
  active: ["waiting", "open", "done"],
  waiting: ["open", "done"],
  done: [],
};

@singleton()
export class LedgerService {
  constructor(@inject(DB) private readonly db: Db) {}

  requireTask(taskId: string): Task {
    const task = this.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }).sync();
    if (!task) throw new Error(`no such task: ${taskId}`);
    return task;
  }

  createTask(params: z.infer<typeof TaskCreate>): Task {
    const last = this.db
      .select({ n: sql<number | null>`MAX(CAST(SUBSTR(${tasks.id}, 3) AS INTEGER))` })
      .from(tasks)
      .where(like(tasks.id, "T-%"))
      .get();
    const at = now();
    return this.db
      .insert(tasks)
      .values({
        id: `T-${(last?.n ?? 0) + 1}`,
        title: params.title,
        spec: params.spec,
        status: "open",
        channel: params.channel,
        threadTs: params.thread_ts ?? null,
        ...(params.tier ? { tier: params.tier } : {}),
        updatedAt: at,
        openedAt: at,
      })
      .returning()
      .get();
  }

  transition(taskId: string, cause: TransitionCause): Task {
    const task = this.requireTask(taskId);
    const at = now();
    const fields: Partial<Task> & { status: Task["status"] } = {
      status: "open",
      waitingOn: null,
      waitingWhy: null,
      wakeAt: null,
      updatedAt: at,
    };
    if (cause.type === "dispatch") fields.status = "active";
    else if (cause.type === "wait") {
      fields.status = "waiting";
      fields.waitingOn = cause.waitingOn;
      fields.wakeAt = cause.wakeAt;
      if (cause.waitingOn === "human") fields.waitingWhy = cause.why;
    } else if (cause.type === "wake") {
      fields.status = "open";
      fields.openedAt = at;
      if (task.status === "active") fields.interruptions = task.interruptions + 1;
    } else {
      fields.status = "done";
      fields.outcome = cause.outcome;
      fields.report = cause.report;
    }
    if (!LEGAL[task.status].includes(fields.status))
      throw new Error(`illegal task transition: ${task.id} ${task.status} → ${fields.status}`);
    return this.db.update(tasks).set(fields).where(eq(tasks.id, taskId)).returning().get();
  }

  appendGuidance(taskId: string, text: string): Task {
    const task = this.requireTask(taskId);
    if (task.status === "done") throw new Error(`${task.id} already ${task.outcome}`);
    this.db
      .update(tasks)
      .set({ spec: `${task.spec}\n\n${text}`, updatedAt: now() })
      .where(eq(tasks.id, task.id))
      .run();
    return task.status === "waiting" && task.waitingOn === "human"
      ? this.transition(task.id, { type: "wake" })
      : this.requireTask(task.id);
  }

  markTasksSeen(updates: Task[]): void {
    for (const task of updates)
      this.db
        .update(tasks)
        .set({ seenAt: task.updatedAt })
        .where(and(eq(tasks.id, task.id), eq(tasks.updatedAt, task.updatedAt)))
        .run();
  }

  wakeDueTasks(): boolean {
    const due = this.db
      .select({ id: tasks.id, waitingOn: tasks.waitingOn })
      .from(tasks)
      .where(and(eq(tasks.status, "waiting"), lte(tasks.wakeAt, now())))
      .all();
    for (const task of due) {
      if (task.waitingOn === "timer") this.transition(task.id, { type: "wake" });
      else
        this.transition(task.id, {
          type: "finish",
          outcome: "expired",
          report: "No answer arrived before the deadline; the task was closed without acting.",
        });
    }
    return due.some((task) => task.waitingOn === "human");
  }

  msUntilNextWake(maxMs: number): number {
    const next = this.db
      .select({ next: min(tasks.wakeAt) })
      .from(tasks)
      .where(eq(tasks.status, "waiting"))
      .get()?.next;
    if (!next) return maxMs;
    return Math.max(0, Math.min(Date.parse(next) - Date.now(), maxMs));
  }

  dispatchRunnable(maxConcurrent: number): string[] {
    const running =
      this.db.select({ c: count() }).from(tasks).where(eq(tasks.status, "active")).get()?.c ?? 0;
    const open = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.status, "open"))
      .orderBy(asc(tasks.openedAt), asc(tasks.id))
      .limit(Math.max(0, maxConcurrent - running))
      .all();
    for (const { id } of open) this.transition(id, { type: "dispatch" });
    return open.map((row) => row.id);
  }

  interrupt(taskId: string, maxInterruptions: number): "reopened" | "failed" {
    const task = this.transition(taskId, { type: "wake" });
    if (task.interruptions <= maxInterruptions) return "reopened";
    this.transition(taskId, {
      type: "finish",
      outcome: "failed",
      report: `The worker was interrupted ${task.interruptions} times in a row and the task was closed without finishing.`,
    });
    return "failed";
  }

  recoverFromRestart(maxInterruptions: number): void {
    for (const { id } of this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.status, "active"))
      .all())
      log.info("restart recovery", { taskId: id, result: this.interrupt(id, maxInterruptions) });
  }

  heard(channel: string, threadTs: string, ts: string, direct: boolean): void {
    this.db
      .insert(conversations)
      .values({ channel, threadTs, since: ts, direct, judged: direct, wakeWhy: null })
      .onConflictDoUpdate({
        target: [conversations.channel, conversations.threadTs],
        set: {
          direct: sql`${conversations.direct} OR ${direct}`,
          judged: sql`${conversations.judged} AND ${direct}`,
        },
      })
      .run();
  }

  judged(convos: Conversation[], wakeWhy: Map<string, string>): void {
    for (const convo of convos)
      this.db
        .update(conversations)
        .set({ judged: true, wakeWhy: wakeWhy.get(convo.threadTs) ?? null })
        .where(
          and(eq(conversations.channel, convo.channel), eq(conversations.threadTs, convo.threadTs)),
        )
        .run();
  }

  forget(convos: Conversation[]): void {
    for (const convo of convos)
      this.db
        .delete(conversations)
        .where(
          and(eq(conversations.channel, convo.channel), eq(conversations.threadTs, convo.threadTs)),
        )
        .run();
  }

  muted(channel: string, threadTs: string): string | null {
    return (
      this.db
        .select({ why: mutedThreads.why })
        .from(mutedThreads)
        .where(and(eq(mutedThreads.channel, channel), eq(mutedThreads.threadTs, threadTs)))
        .get()?.why ?? null
    );
  }

  mute(channel: string, threadTs: string, why: string): void {
    this.db
      .insert(mutedThreads)
      .values({ channel, threadTs, why, at: now() })
      .onConflictDoUpdate({
        target: [mutedThreads.channel, mutedThreads.threadTs],
        set: { why, at: now() },
      })
      .run();
  }

  unmute(channel: string, threadTs: string): void {
    this.db
      .delete(mutedThreads)
      .where(and(eq(mutedThreads.channel, channel), eq(mutedThreads.threadTs, threadTs)))
      .run();
  }
}
