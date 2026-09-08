import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    spec: text("spec").notNull(),
    status: text("status", { enum: ["open", "active", "waiting", "done"] }).notNull(),
    waitingOn: text("waiting_on", { enum: ["human", "timer"] }),
    waitingWhy: text("waiting_why"),
    wakeAt: text("wake_at"),
    outcome: text("outcome", { enum: ["done", "failed", "cancelled", "expired"] }),
    report: text("report"),
    seenAt: text("seen_at"),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts"),
    tier: text("tier", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("high"),
    interruptions: integer("interruptions").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
    openedAt: text("opened_at").notNull(),
  },
  (t) => [
    index("tasks_dispatch").on(t.status, t.openedAt),
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

export const mutedThreads = sqliteTable(
  "muted_threads",
  {
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    why: text("why").notNull(),
    at: text("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.channel, t.threadTs] })],
);

export const conversations = sqliteTable(
  "conversations",
  {
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    since: text("since").notNull(),
    last: text("last").notNull(),
    direct: integer("direct", { mode: "boolean" }).notNull(),
    woken: integer("woken", { mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.channel, t.threadTs] })],
);

export type Task = typeof tasks.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
