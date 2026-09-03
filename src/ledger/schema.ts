import type { MessageFile } from "@bevyl-ai/agent-tools";
import type { AddressMode } from "../schemas/common";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { TurnEffect } from "../schemas/effects";
import type { AuditEntry } from "../schemas/audit";

export const events = sqliteTable(
  "events",
  {
    rowid: integer("rowid")
      .notNull()
      .generatedAlwaysAs(sql`rowid`),
    id: text("id").primaryKey(),
    dedupKey: text("dedup_key").notNull().unique(),
    kind: text("kind", {
      enum: ["addressed_message", "observed_message", "external_signal"],
    }).notNull(),
    identityId: text("identity_id").notNull(),
    venueId: text("venue_id").notNull(),
    threadRootId: text("thread_root_id"),
    principalId: text("principal_id"),
    payload: text("payload", { mode: "json" }).$type<EventPayload>().notNull(),
    receivedAt: text("received_at").notNull(),
  },
  (t) => [
    index("events_conversation").on(t.identityId, t.venueId, t.threadRootId),
    index("events_root_ts")
      .on(t.venueId)
      .where(sql`thread_root_id IS NULL`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    rowid: integer("rowid")
      .notNull()
      .generatedAlwaysAs(sql`rowid`),
    id: text("id").primaryKey(),
    identityId: text("identity_id").notNull(),
    title: text("title").notNull(),
    spec: text("spec").notNull(),
    status: text("status", {
      enum: ["open", "active", "waiting", "parked", "done", "failed", "cancelled"],
    }).notNull(),
    waitingOn: text("waiting_on", { enum: ["human", "timer"] }),
    sponsorId: text("sponsor_id").notNull(),
    homeVenueId: text("home_venue_id").notNull(),
    homeThreadRootId: text("home_thread_root_id"),
    originEventId: text("origin_event_id").notNull(),
    wakeAt: text("wake_at"),
    tier: text("tier", { enum: ["low", "medium", "high"] }).notNull(),
    terminalReport: text("terminal_report"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    openedAt: text("opened_at").notNull(),
    consecutiveInterruptions: integer("consecutive_interruptions").notNull(),
  },
  (t) => [index("tasks_dispatch").on(t.identityId, t.status, t.openedAt)],
);

export const executions = sqliteTable(
  "executions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    status: text("status", {
      enum: ["running", "yielded", "succeeded", "failed", "cancelled", "interrupted"],
    }).notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => [
    uniqueIndex("one_live_execution_per_task")
      .on(t.taskId)
      .where(sql`status = 'running'`),
  ],
);

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id").notNull(),
    kind: text("kind", {
      enum: ["execution_step", "distillation", "resident", "attention"],
    }).notNull(),
    executionId: text("execution_id"),
    venueId: text("venue_id"),
    threadRootId: text("thread_root_id"),
    status: text("status", {
      enum: ["succeeded", "failed", "timed_out"],
    }).notNull(),
    effects: text("effects", { mode: "json" }).$type<TurnEffect[]>().notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at").notNull(),
  },
  (t) => [index("turns_spend").on(t.identityId, t.startedAt)],
);

export const memoryItems = sqliteTable(
  "memory_items",
  {
    rowid: integer("rowid")
      .notNull()
      .generatedAlwaysAs(sql`rowid`),
    id: text("id").primaryKey(),
    identityId: text("identity_id").notNull(),
    content: text("content").notNull(),
    provenance: text("provenance", { mode: "json" }).$type<unknown[]>().notNull(),
    tier: text("tier", { enum: ["core", "recent", "archive"] }).notNull(),
    status: text("status", { enum: ["active", "retracted"] }).notNull(),
    supersededBy: text("superseded_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastConfirmedAt: text("last_confirmed_at").notNull(),
  },
  (t) => [index("memory_active").on(t.identityId, t.status)],
);

export const eventsFts = sqliteTable("events_fts", {
  rowid: integer("rowid"),
  text: text("text"),
});

export const memoryFts = sqliteTable("memory_fts", {
  rowid: integer("rowid"),
  content: text("content"),
});

export const timers = sqliteTable(
  "timers",
  {
    id: text("id").primaryKey(),
    kind: text("kind", {
      enum: ["task_wake", "park", "distillation"],
    }).notNull(),
    identityId: text("identity_id").notNull(),
    subjectId: text("subject_id"),
    dueAt: text("due_at").notNull(),
    firedAt: text("fired_at"),
  },
  (t) => [
    index("timers_due")
      .on(t.dueAt)
      .where(sql`fired_at IS NULL`),
    uniqueIndex("timers_singleton_pending")
      .on(t.kind, t.identityId)
      .where(sql`fired_at IS NULL AND kind IN ('ambient_tick','distillation')`),
  ],
);

export const audit = sqliteTable("audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  identityId: text("identity_id").notNull(),
  kind: text("kind", {
    enum: [
      "event_received",
      "turn_started",
      "turn_ended",
      "task_created",
      "task_transitioned",
      "tool_invoked",
      "memory_written",
      "memory_retracted",
      "memory_tier_changed",
    ],
  }).notNull(),
  payload: text("payload", { mode: "json" }).$type<AuditEntry["payload"]>().notNull(),
});

export const attentionItems = sqliteTable(
  "attention_items",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id").notNull(),
    venueId: text("venue_id").notNull(),
    threadRootId: text("thread_root_id"),
    askTs: text("ask_ts"),
    what: text("what").notNull(),
    openedAt: text("opened_at").notNull(),
    closedAt: text("closed_at"),
    closedCause: text("closed_cause"),
  },
  (t) => [index("attention_open").on(t.identityId, t.closedAt)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    identityId: text("identity_id").notNull(),
    venueId: text("venue_id").notNull(),
    threadRootId: text("thread_root_id").notNull(),
    deliveredRowid: integer("delivered_rowid").notNull(),
    judgedRowid: integer("judged_rowid").notNull(),
    wakeWhy: text("wake_why"),
    stance: text("stance", { enum: ["none", "engaged", "out"] }).notNull(),
    stanceWhy: text("stance_why"),
    stanceAt: text("stance_at"),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.venueId, t.threadRootId] })],
);

export const acts = sqliteTable(
  "acts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    wakeId: text("wake_id").notNull(),
    actKey: text("act_key").notNull(),
    identityId: text("identity_id").notNull(),
    kind: text("kind", { enum: ["posted", "reacted"] }).notNull(),
    venueId: text("venue_id").notNull(),
    threadRootId: text("thread_root_id"),
    ts: text("ts"),
    text: text("text").notNull(),
    at: text("at").notNull(),
  },
  (t) => [
    uniqueIndex("acts_wake_key").on(t.wakeId, t.actKey),
    index("acts_conversation").on(t.identityId, t.venueId, t.threadRootId, t.at),
  ],
);

export const drafts = sqliteTable("drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  identityId: text("identity_id").notNull(),
  venueId: text("venue_id").notNull(),
  threadRootId: text("thread_root_id"),
  text: text("text").notNull(),
  draftedAt: text("drafted_at").notNull(),
  consumedAt: text("consumed_at"),
});

export const outwardCalls = sqliteTable(
  "outward_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    identityId: text("identity_id").notNull(),
    scopeId: text("scope_id").notNull(),
    tool: text("tool").notNull(),
    argsHash: text("args_hash").notNull(),
    at: text("at").notNull(),
    state: text("state", {
      enum: ["pending_approval", "approved", "denied", "running", "ran", "failed"],
    }).notNull(),
    description: text("description"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
  },
  (t) => [uniqueIndex("outward_calls_scope").on(t.scopeId, t.tool, t.argsHash)],
);

export type Event = typeof events.$inferSelect;
export type OutwardCall = typeof outwardCalls.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskStatus = Task["status"];
export type WaitingOn = NonNullable<Task["waitingOn"]>;
export type Execution = typeof executions.$inferSelect;
export type Turn = typeof turns.$inferSelect;
export type TurnKind = Turn["kind"];
export type TurnStatus = Turn["status"];
export type MemoryItem = typeof memoryItems.$inferSelect;
export type MemoryTier = MemoryItem["tier"];
export type Timer = typeof timers.$inferSelect;
export type TimerKind = Timer["kind"];
export type Audit = typeof audit.$inferSelect;
export type AuditKind = Audit["kind"];
export type AttentionItem = typeof attentionItems.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;

type EventPayload = {
  text: string;
  ts: string | null;
  principalName?: string | undefined;
  addressMode?: AddressMode | undefined;
  files?: MessageFile[] | undefined;
  isBot?: boolean | undefined;
};
