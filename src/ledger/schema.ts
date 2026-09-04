import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

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

export const steppedBack = sqliteTable(
  "stepped_back",
  {
    identityId: text("identity_id").notNull(),
    venueId: text("venue_id").notNull(),
    threadRootId: text("thread_root_id").notNull(),
    why: text("why").notNull(),
    at: text("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.venueId, t.threadRootId] })],
);

export type Task = typeof tasks.$inferSelect;
export type TaskStatus = Task["status"];
export type WaitingOn = NonNullable<Task["waitingOn"]>;
