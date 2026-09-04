import type { MessageFile } from "@bevyl-ai/agent-tools";
import type { AddressMode } from "../schemas/common";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import type { TurnEffect } from "../schemas/effects";

export const events = sqliteTable(
  "events",
  {
    rowid: integer("rowid").primaryKey(),
    dedupKey: text("dedup_key").notNull().unique(),
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
    wakeWhy: text("wake_why"),
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
    homeVenueId: text("home_venue_id").notNull(),
    homeThreadRootId: text("home_thread_root_id"),
    tier: text("tier", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("high"),
    interruptions: integer("interruptions").notNull().default(0),
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
    id: text("id").primaryKey(),
    identityId: text("identity_id").notNull(),
    content: text("content").notNull(),
    provenance: text("provenance", { mode: "json" }).$type<unknown[]>().notNull().default([]),
    tier: text("tier", { enum: ["core", "archive"] })
      .notNull()
      .default("core"),
    status: text("status", { enum: ["active", "retracted"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
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

export const acts = sqliteTable(
  "acts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    wakeId: text("wake_id").notNull(),
    actKey: text("act_key").notNull(),
    identityId: text("identity_id").notNull(),
    kind: text("kind", { enum: ["posted", "reacted", "stepped_back"] }).notNull(),
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

export type Event = typeof events.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskStatus = Task["status"];
export type WaitingOn = NonNullable<Task["waitingOn"]>;
export type Turn = typeof turns.$inferSelect;
export type TurnKind = Turn["kind"];
export type TurnStatus = Turn["status"];
export type MemoryItem = typeof memoryItems.$inferSelect;
export type MemoryTier = MemoryItem["tier"];

type EventPayload = {
  text: string;
  ts: string | null;
  principalName?: string | undefined;
  addressMode?: AddressMode | undefined;
  files?: MessageFile[] | undefined;
};
