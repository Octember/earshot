import type { MessageFile } from "@bevyl-ai/agent-tools";
import type { AddressMode } from "../schemas/common";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { TurnEffect } from "../schemas/effects";

export const events = sqliteTable(
  "events",
  {
    rowid: integer("rowid")
      .notNull()
      .generatedAlwaysAs(sql`rowid`),
    id: text("id").primaryKey(),
    dedupKey: text("dedup_key").notNull().unique(),
    kind: text("kind", {
      enum: ["addressed_message", "observed_message"],
    }).notNull(),
    identityId: text("identity_id").notNull(),
    venueId: text("venue_id").notNull(),
    threadRootId: text("thread_root_id"),
    principalId: text("principal_id"),
    payload: text("payload", { mode: "json" })
      .$type<EventPayload>()
      .notNull()
      .default(sql`'{}'`),
    receivedAt: text("received_at").notNull(),
    deliveredAt: text("delivered_at"),
    judgedAt: text("judged_at"),
  },
  (t) => [
    index("events_undelivered")
      .on(t.identityId)
      .where(sql`delivered_at IS NULL`),
    index("events_unjudged")
      .on(t.identityId)
      .where(sql`judged_at IS NULL`),
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
    status: text("status", { enum: ["open", "active", "waiting", "done"] }).notNull(),
    waitingOn: text("waiting_on", { enum: ["human", "timer"] }),
    waitingWhy: text("waiting_why"),
    wakeAt: text("wake_at"),
    outcome: text("outcome", { enum: ["done", "failed", "cancelled", "expired"] }),
    report: text("report"),
    seenAt: text("seen_at"),
    sponsorId: text("sponsor_id").notNull(),
    homeVenueId: text("home_venue_id").notNull(),
    homeThreadRootId: text("home_thread_root_id"),
    originEventId: text("origin_event_id")
      .notNull()
      .references(() => events.id),
    tier: text("tier", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("high"),
    interruptions: integer("interruptions").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    openedAt: text("opened_at").notNull(),
  },
  (t) => [
    index("tasks_dispatch").on(t.identityId, t.status, t.openedAt),
    index("tasks_due").on(t.status, t.wakeAt),
    check("tasks_waiting_on", sql`(${t.status} = 'waiting') = (${t.waitingOn} IS NOT NULL)`),
    check("tasks_wake_at", sql`${t.wakeAt} IS NULL OR ${t.status} = 'waiting'`),
    check(
      "tasks_waiting_why",
      sql`${t.waitingOn} IS NOT 'human' OR (${t.waitingWhy} IS NOT NULL AND trim(${t.waitingWhy}) <> '')`,
    ),
    check("tasks_outcome", sql`(${t.status} = 'done') = (${t.outcome} IS NOT NULL)`),
    check(
      "tasks_report",
      sql`${t.status} <> 'done' OR (${t.report} IS NOT NULL AND trim(${t.report}) <> '')`,
    ),
  ],
);

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id").notNull(),
    kind: text("kind", {
      enum: ["execution_step", "resident", "attention"],
    }).notNull(),
    taskId: text("task_id"),
    venueId: text("venue_id"),
    threadRootId: text("thread_root_id"),
    status: text("status", {
      enum: ["succeeded", "failed", "timed_out"],
    }).notNull(),
    effects: text("effects", { mode: "json" }).$type<TurnEffect[]>().notNull().default([]),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at").notNull(),
  },
  (t) => [
    index("turns_spend").on(t.identityId, t.startedAt),
    check("turns_task", sql`${t.kind} <> 'execution_step' OR ${t.taskId} IS NOT NULL`),
  ],
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
    provenance: text("provenance", { mode: "json" }).$type<unknown[]>().notNull().default([]),
    tier: text("tier", { enum: ["core", "archive"] })
      .notNull()
      .default("core"),
    status: text("status", { enum: ["active", "retracted"] }).notNull(),
    supersededBy: text("superseded_by").references((): AnySQLiteColumn => memoryItems.id),
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

export const stances = sqliteTable(
  "stances",
  {
    identityId: text("identity_id").notNull(),
    venueId: text("venue_id").notNull(),
    root: text("root").notNull(),
    stance: text("stance", { enum: ["none", "engaged", "out"] })
      .notNull()
      .default("none"),
    why: text("why"),
    at: text("at").notNull(),
    wakeWhy: text("wake_why"),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.venueId, t.root] })],
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
    check("acts_reacted_ts", sql`${t.kind} <> 'reacted' OR ${t.ts} IS NOT NULL`),
  ],
);

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
export type Turn = typeof turns.$inferSelect;
export type TurnKind = Turn["kind"];
export type TurnStatus = Turn["status"];
export type MemoryItem = typeof memoryItems.$inferSelect;
export type MemoryTier = MemoryItem["tier"];
export type Stance = typeof stances.$inferSelect;

type EventPayload = {
  text: string;
  ts: string | null;
  principalName?: string | undefined;
  addressMode?: AddressMode | undefined;
  files?: MessageFile[] | undefined;
  isBot?: boolean | undefined;
};
