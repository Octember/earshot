import type { Task } from "./schema";

export interface Anchor {
  venueId: string;
  threadRootId: string | null;
}

export type TransitionCause =
  | { type: "dispatch" }
  | { type: "wait"; waitingOn: "human"; why: string; wakeAt: string }
  | { type: "wait"; waitingOn: "timer"; wakeAt: string }
  | { type: "wake" }
  | { type: "finish"; outcome: NonNullable<Task["outcome"]>; report: string };
