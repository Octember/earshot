// Task ledger: all task/execution state changes go through transition().
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { orm } from "./db";
import { tasks, type Task } from "./schema";
import { writeAudit } from "./audit";
import { requireTask } from "./tasks-query";
import type { Anchor } from "./tasks-types";

// Causes never post to Slack — ledger records state only.

export interface CreateTaskParams {
  id: string;
  identityId: string;
  title: string;
  spec: string;
  sponsorId: string;
  homeAnchor: Anchor;
  originEventId: string;
  tier?: Task["tier"] | undefined;
}

export function createTask(db: Database, clock: Clock, params: CreateTaskParams): Task {
  const now = clock();
  orm(db)
    .insert(tasks)
    .values({
      id: params.id,
      identityId: params.identityId,
      title: params.title,
      spec: params.spec,
      status: "open",
      waitingOn: null,
      sponsorId: params.sponsorId,
      homeVenueId: params.homeAnchor.venueId,
      homeThreadRootId: params.homeAnchor.threadRootId,
      originEventId: params.originEventId,
      wakeAt: null,
      pendingConfirmation: null,
      recurrence: null,
      tier: params.tier ?? "high",
      artifacts: [],
      terminalReport: null,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      consecutiveInterruptions: 0,
    })
    .run();
  writeAudit(db, now, params.identityId, {
    kind: "task_created",
    payload: {
      taskId: params.id,
      title: params.title,
    },
  });
  return requireTask(db, params.id);
}
