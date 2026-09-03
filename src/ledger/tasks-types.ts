import type { Task } from "./schema";

export interface Anchor {
  venueId: string;
  threadRootId: string | null;
}

export function homeAnchor(task: Pick<Task, "homeVenueId" | "homeThreadRootId">): Anchor {
  return { venueId: task.homeVenueId, threadRootId: task.homeThreadRootId };
}

export type TransitionCause =
  | { type: "dispatch" }
  | { type: "wait"; waitingOn: "human"; why: string; wakeAt: string }
  | { type: "wait"; waitingOn: "timer"; wakeAt: string }
  | { type: "wake" }
  | { type: "finish"; outcome: NonNullable<Task["outcome"]>; report: string };
