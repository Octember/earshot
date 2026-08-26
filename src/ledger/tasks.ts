// Task ledger: all task/execution state changes go through transition().
import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, max, notInArray, inArray, desc, sql } from "drizzle-orm";
import { asString, isRecord, parseJson } from "../guard";
import type { Clock } from "./clock";
import { orm } from "./db";
import {
  executions,
  steering,
  tasks,
  type Steering,
  type SteeringKind,
  type TaskRow,
  type TaskStatus,
  type WaitingOn,
} from "./schema";
import { scheduleTimer, type TimerKind } from "./timers";
import { writeAudit, type AuditKind } from "./audit";

export type SteeringRow = Steering;
export type { SteeringKind, TaskStatus, WaitingOn };

export interface Anchor {
  venueId: string;
  threadRootId: string | null;
}

export interface ConfirmationResolution {
  approved: boolean;
  principalId: string;
  resolvedAt: string;
}

export interface PendingConfirmation {
  actionRef: string; // canonical ref of the EXACT action approved (broker.actionRefFor)
  description: string;
  requestedAt: string;
  resolution?: ConfirmationResolution;
  consumedAt?: string; // single-use: set when the approved call executes; a spent approval never re-allows
}

export interface Task {
  id: string;
  identityId: string;
  title: string;
  spec: string;
  status: TaskStatus;
  waitingOn: WaitingOn | null;
  sponsorId: string;
  homeAnchor: Anchor;
  originEventId: string;
  wakeAt: string | null;
  pendingConfirmation: PendingConfirmation | null;
  recurrence: string | null;
  tier: "low" | "medium" | "high"; // v10: how hard the worker thinks (policy.models maps it)
  artifacts: string[];
  terminalReport: string | null;
  createdAt: string;
  updatedAt: string;
  openedAt: string;
  consecutiveInterruptions: number;
}

export class IllegalTransitionError extends Error {
  constructor(taskId: string, from: TaskStatus, to: TaskStatus, causeType: string) {
    super(`T-illegal: cannot transition ${taskId} from ${from} to ${to} via ${causeType}`);
    this.name = "IllegalTransitionError";
  }
}

export class RecurrenceRequiresOperatorError extends Error {
  constructor() {
    super("a recurrence may only be set by an operator sponsor (SPEC §6.5)");
    this.name = "RecurrenceRequiresOperatorError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`no such task: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

// Causes never post to Slack — ledger records state only.
export type TransitionCause =
  | { type: "dispatch"; executionId: string }
  | { type: "yield_human"; nudgeDeadline: string; pendingConfirmation?: PendingConfirmation }
  | { type: "yield_timer"; wakeAt: string }
  | { type: "yield_external" }
  | { type: "yield_open" }
  | { type: "interrupted" }
  | { type: "crash_loop_parked" }
  | { type: "completed"; report: string }
  | { type: "failed"; report: string }
  | { type: "cancelled"; report: string }
  | { type: "paused" }
  | { type: "nudge_sent"; parkDeadline: string }
  | { type: "park_timeout" }
  | { type: "revive"; pendingConfirmation?: PendingConfirmation | null }
  | { type: "recurrence_rearm"; wakeAt: string }
  | { type: "recurrence_failed"; wakeAt: string };

function parsePending(raw: unknown): PendingConfirmation | null {
  if (!raw) return null;
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(value)) return null;
  const pending: PendingConfirmation = {
    actionRef: asString(value.actionRef),
    description: asString(value.description),
    requestedAt: asString(value.requestedAt),
  };
  if (isRecord(value.resolution)) {
    pending.resolution = {
      approved: value.resolution.approved === true,
      principalId: asString(value.resolution.principalId),
      resolvedAt: asString(value.resolution.resolvedAt),
    };
  }
  if (typeof value.consumedAt === "string") pending.consumedAt = value.consumedAt;
  return pending;
}

function parseArtifacts(raw: unknown): string[] {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  return Array.isArray(value) ? value.map((x) => asString(x)) : [];
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    identityId: row.identityId,
    title: row.title,
    spec: row.spec,
    status: row.status,
    waitingOn: row.waitingOn,
    sponsorId: row.sponsorId,
    homeAnchor: { venueId: row.homeVenueId, threadRootId: row.homeThreadRootId },
    originEventId: row.originEventId,
    wakeAt: row.wakeAt,
    pendingConfirmation: parsePending(row.pendingConfirmation),
    recurrence: row.recurrence,
    tier: row.tier,
    artifacts: parseArtifacts(row.artifacts),
    terminalReport: row.terminalReport,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    openedAt: row.openedAt,
    consecutiveInterruptions: row.consecutiveInterruptions,
  };
}

export function getTask(db: Database, taskId: string): Task | null {
  const row = orm(db).select().from(tasks).where(eq(tasks.id, taskId)).get();
  return row ? rowToTask(row) : null;
}

// SPEC §4.2 — "short, human-readable, unique per service instance, and usable in chat." T-1, T-2, ...
export function nextTaskId(db: Database): string {
  const row = orm(db)
    .select({ n: sql<number | null>`MAX(CAST(SUBSTR(${tasks.id}, 3) AS INTEGER))` })
    .from(tasks)
    .where(sql`${tasks.id} LIKE 'T-%'`)
    .get();
  return `T-${(row?.n ?? 0) + 1}`;
}

// Open + recent terminal tasks for one identity.
export function ledgerView(
  db: Database,
  identityId: string,
  recentTerminalsLimit = 10,
): { open: Task[]; recentTerminals: Task[] } {
  const openRows = orm(db)
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.identityId, identityId),
        notInArray(tasks.status, ["done", "failed", "cancelled"]),
      ),
    )
    .orderBy(asc(tasks.openedAt))
    .all();
  const terminalRows = orm(db)
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.identityId, identityId), inArray(tasks.status, ["done", "failed", "cancelled"])),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(recentTerminalsLimit)
    .all();
  return {
    open: openRows.map((row) => rowToTask(row)),
    recentTerminals: terminalRows.map((row) => rowToTask(row)),
  };
}

export function requireTask(db: Database, taskId: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  return task;
}

// Cross-identity ids look nonexistent (§7.1).
export function requireTaskFor(db: Database, identityId: string, taskId: string): Task {
  const task = getTask(db, taskId);
  if (!task || task.identityId !== identityId) throw new TaskNotFoundError(taskId);
  return task;
}

// At most one live execution per task.
export function liveExecutionId(db: Database, taskId: string): string | null {
  const row = orm(db)
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.taskId, taskId), eq(executions.status, "running")))
    .get();
  return row?.id ?? null;
}

function endExecution(
  db: Database,
  taskId: string,
  at: string,
  status: (typeof executions.$inferSelect)["status"],
) {
  const execId = liveExecutionId(db, taskId);
  if (!execId) return;
  orm(db).update(executions).set({ status, endedAt: at }).where(eq(executions.id, execId)).run();
}

// Kind-tagged deadline; wake_at alone cannot distinguish nudge/park/task_wake.
function scheduleWakeTimer(db: Database, task: Task, kind: TimerKind, dueAt: string) {
  scheduleTimer(db, {
    id: `${task.id}:${kind}:${dueAt}`,
    kind,
    identityId: task.identityId,
    subjectId: task.id,
    dueAt,
  });
}

export interface CreateTaskParams {
  id: string;
  identityId: string;
  title: string;
  spec: string;
  sponsorId: string;
  homeAnchor: Anchor;
  originEventId: string;
  recurrence?: string | undefined;
  tier?: Task["tier"] | undefined;
  sponsorIsOperator?: boolean | undefined;
}

export function createTask(db: Database, clock: Clock, params: CreateTaskParams): Task {
  if (params.recurrence && !params.sponsorIsOperator) {
    throw new RecurrenceRequiresOperatorError();
  }
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
      recurrence: params.recurrence ?? null,
      tier: params.tier ?? "high",
      artifacts: [],
      terminalReport: null,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      consecutiveInterruptions: 0,
    })
    .run();
  writeAudit(db, now, params.identityId, "task_created", {
    taskId: params.id,
    title: params.title,
  });
  return requireTask(db, params.id);
}

// The legal (from, causeType) -> to edges of SPEC §6.1's state machine.
const LEGAL: Record<TaskStatus, Partial<Record<TransitionCause["type"], TaskStatus>>> = {
  open: { dispatch: "active", cancelled: "cancelled", paused: "parked" },
  active: {
    yield_human: "waiting",
    yield_timer: "waiting",
    yield_external: "waiting",
    yield_open: "open",
    interrupted: "open",
    crash_loop_parked: "parked",
    completed: "done",
    failed: "failed",
    cancelled: "cancelled",
    recurrence_rearm: "waiting",
    recurrence_failed: "waiting",
  },
  waiting: {
    nudge_sent: "waiting",
    park_timeout: "parked",
    revive: "open",
    cancelled: "cancelled",
    paused: "parked",
  },
  parked: { revive: "open", cancelled: "cancelled" },
  done: {},
  failed: {},
  cancelled: {},
};

function applyTransition(
  db: Database,
  clock: Clock,
  taskId: string,
  to: TaskStatus,
  cause: TransitionCause,
): Task {
  const task = requireTask(db, taskId);
  const expected = LEGAL[task.status]?.[cause.type];
  if (expected !== to) {
    throw new IllegalTransitionError(taskId, task.status, to, cause.type);
  }
  if (cause.type === "park_timeout" && task.waitingOn !== "human") {
    throw new IllegalTransitionError(taskId, task.status, to, cause.type);
  }
  if (
    (cause.type === "recurrence_rearm" || cause.type === "recurrence_failed") &&
    !task.recurrence
  ) {
    throw new IllegalTransitionError(taskId, task.status, to, cause.type);
  }

  const now = clock();
  let waitingOn: WaitingOn | null = task.waitingOn;
  let wakeAt: string | null = task.wakeAt;
  let terminalReport = task.terminalReport;
  let pendingConfirmation = task.pendingConfirmation;
  let recurrence = task.recurrence;
  let openedAt = task.openedAt;
  if (to === "open") openedAt = now;
  // Only interrupted bumps crash-loop count; other transitions clear it.
  let consecutiveInterruptions = task.consecutiveInterruptions;
  if (cause.type === "interrupted") consecutiveInterruptions += 1;
  else if (cause.type !== "dispatch") consecutiveInterruptions = 0;

  switch (cause.type) {
    case "dispatch": {
      const attempt =
        (orm(db)
          .select({ m: max(executions.attempt) })
          .from(executions)
          .where(eq(executions.taskId, taskId))
          .get()?.m ?? 0) + 1;
      orm(db)
        .insert(executions)
        .values({
          id: cause.executionId,
          taskId,
          attempt,
          status: "running",
          startedAt: now,
          endedAt: null,
        })
        .run();
      waitingOn = null;
      wakeAt = null;
      break;
    }
    case "yield_human":
      waitingOn = "human";
      wakeAt = cause.nudgeDeadline;
      if (cause.pendingConfirmation !== undefined) pendingConfirmation = cause.pendingConfirmation;
      endExecution(db, taskId, now, "yielded");
      scheduleWakeTimer(db, task, "nudge", cause.nudgeDeadline);
      break;
    case "yield_timer":
      waitingOn = "timer";
      wakeAt = cause.wakeAt;
      endExecution(db, taskId, now, "yielded");
      scheduleWakeTimer(db, task, "task_wake", cause.wakeAt);
      break;
    case "yield_external":
      waitingOn = "external";
      wakeAt = null;
      endExecution(db, taskId, now, "yielded");
      break;
    case "yield_open":
      waitingOn = null;
      wakeAt = null;
      endExecution(db, taskId, now, "yielded");
      break;
    case "interrupted":
      waitingOn = null;
      wakeAt = null;
      endExecution(db, taskId, now, "interrupted");
      break;
    case "crash_loop_parked":
      waitingOn = null;
      wakeAt = null;
      endExecution(db, taskId, now, "interrupted");
      break;
    case "completed":
      terminalReport = cause.report;
      pendingConfirmation = null;
      endExecution(db, taskId, now, "succeeded");
      break;
    case "failed":
      terminalReport = cause.report;
      pendingConfirmation = null;
      endExecution(db, taskId, now, "failed");
      break;
    case "cancelled":
      terminalReport = cause.report;
      pendingConfirmation = null;
      waitingOn = null;
      endExecution(db, taskId, now, "cancelled");
      break;
    case "paused":
      waitingOn = null;
      wakeAt = null;
      break;
    case "nudge_sent":
      wakeAt = cause.parkDeadline;
      scheduleWakeTimer(db, task, "park", cause.parkDeadline);
      break;
    case "park_timeout":
      waitingOn = null;
      wakeAt = null;
      break;
    case "revive":
      waitingOn = null;
      wakeAt = null;
      if (cause.pendingConfirmation !== undefined) pendingConfirmation = cause.pendingConfirmation;
      break;
    case "recurrence_rearm":
      waitingOn = "timer";
      wakeAt = cause.wakeAt;
      endExecution(db, taskId, now, "succeeded");
      scheduleWakeTimer(db, task, "task_wake", cause.wakeAt);
      break;
    case "recurrence_failed":
      waitingOn = "timer";
      wakeAt = cause.wakeAt;
      endExecution(db, taskId, now, "failed");
      scheduleWakeTimer(db, task, "task_wake", cause.wakeAt);
      break;
    default: {
      const exhaustive: never = cause;
      throw new Error(`unhandled transition cause: ${JSON.stringify(exhaustive)}`);
    }
  }

  orm(db)
    .update(tasks)
    .set({
      status: to,
      waitingOn,
      wakeAt,
      terminalReport,
      pendingConfirmation: pendingConfirmation ? { ...pendingConfirmation } : null,
      recurrence,
      openedAt,
      consecutiveInterruptions,
      updatedAt: now,
    })
    .where(eq(tasks.id, taskId))
    .run();
  writeAudit(db, now, task.identityId, "task_transitioned", {
    taskId,
    from: task.status,
    to,
    cause: cause.type,
  });

  return requireTask(db, taskId);
}

export interface TransitionOpts {
  extraAudit?: Array<{ kind: AuditKind; payload: unknown }>;
}

export function transition(
  db: Database,
  clock: Clock,
  taskId: string,
  to: TaskStatus,
  cause: TransitionCause,
  opts: TransitionOpts = {},
): Task {
  db.run("BEGIN IMMEDIATE");
  try {
    const task = applyTransition(db, clock, taskId, to, cause);
    for (const entry of opts.extraAudit ?? []) {
      writeAudit(db, clock(), task.identityId, entry.kind, entry.payload);
    }
    db.run("COMMIT");
    return task;
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
}

function insertSteeringRow(
  db: Database,
  clock: Clock,
  taskId: string,
  kind: SteeringKind,
  payload: Record<string, unknown>,
  sourceEventId: string,
  consumed: boolean,
): void {
  const now = clock();
  orm(db)
    .insert(steering)
    .values({
      id: `${taskId}-steer-${now}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      kind,
      payload,
      sourceEventId,
      createdAt: now,
      consumedAt: consumed ? now : null,
    })
    .run();
}

export interface SteerParams {
  identityId: string; // the identity steering — a foreign identity's task is unreachable
  taskId: string;
  kind: SteeringKind;
  payload: Record<string, unknown>;
  sourceEventId: string;
}

export interface SteerResult {
  applied: boolean;
  task: Task;
  reply?: string;
}

const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "failed", "cancelled"]);

export function steerTask(db: Database, clock: Clock, params: SteerParams): SteerResult {
  const task = requireTaskFor(db, params.identityId, params.taskId);

  if (TERMINAL_STATUSES.has(task.status)) {
    insertSteeringRow(
      db,
      clock,
      params.taskId,
      params.kind,
      params.payload,
      params.sourceEventId,
      true,
    );
    return { applied: false, task, reply: `${task.id} already ${task.status}` };
  }

  switch (params.kind) {
    case "guidance":
      return steerGuidance(db, clock, task, params);
    case "cancel":
      return steerCancel(db, clock, task, params);
    case "pause":
      return steerPause(db, clock, task, params);
    case "resume":
      return steerResume(db, clock, task, params);
    case "confirm":
      return steerConfirm(db, clock, task, params);
    default:
      throw new Error(`unhandled steer kind: ${asString(params.kind)}`);
  }
}

function appendSpec(db: Database, clock: Clock, task: Task, addition: string): void {
  const now = clock();
  orm(db)
    .update(tasks)
    .set({ spec: sql`${tasks.spec} || ${`\n\n${addition}`}`, updatedAt: now })
    .where(eq(tasks.id, task.id))
    .run();
}

function steerGuidance(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  const text = asString(params.payload.text);
  appendSpec(db, clock, task, text);

  const live = task.status === "active";
  insertSteeringRow(db, clock, task.id, "guidance", params.payload, params.sourceEventId, !live);

  let after = requireTask(db, task.id);
  if (
    !live &&
    (task.status === "parked" || (task.status === "waiting" && task.waitingOn === "human"))
  ) {
    after = transition(db, clock, task.id, "open", { type: "revive" });
  }
  return { applied: true, task: after };
}

function steerCancel(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  const report = asString(params.payload.report, `Cancelled "${task.title}".`);
  const wasLive = task.status === "active";
  const after = transition(db, clock, task.id, "cancelled", { type: "cancelled", report });
  insertSteeringRow(db, clock, task.id, "cancel", params.payload, params.sourceEventId, !wasLive);
  return { applied: true, task: after };
}

function steerPause(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  if (task.status === "parked") {
    insertSteeringRow(db, clock, task.id, "pause", params.payload, params.sourceEventId, true);
    return { applied: false, task, reply: `${task.id} is already parked` };
  }
  if (task.status === "active") {
    insertSteeringRow(db, clock, task.id, "pause", params.payload, params.sourceEventId, true);
    return { applied: false, task, reply: `${task.id} is active; use cancel to stop live work` };
  }
  const after = transition(db, clock, task.id, "parked", { type: "paused" });
  insertSteeringRow(db, clock, task.id, "pause", params.payload, params.sourceEventId, true);
  return { applied: true, task: after };
}

function steerResume(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  if (task.status !== "parked") {
    insertSteeringRow(db, clock, task.id, "resume", params.payload, params.sourceEventId, true);
    return { applied: false, task, reply: `${task.id} is not parked` };
  }
  const after = transition(db, clock, task.id, "open", { type: "revive" });
  insertSteeringRow(db, clock, task.id, "resume", params.payload, params.sourceEventId, true);
  return { applied: true, task: after };
}

function steerConfirm(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  const approve = Boolean(params.payload.approve);
  const principalId = asString(params.payload.principalId);
  const outcome = resolveConfirmation(db, clock, {
    identityId: task.identityId,
    taskId: task.id,
    principalId,
    approve,
  });
  insertSteeringRow(db, clock, task.id, "confirm", params.payload, params.sourceEventId, true);
  return outcome;
}

export function consumeSteering(db: Database, clock: Clock, taskId: string): SteeringRow[] {
  const rows = orm(db)
    .select()
    .from(steering)
    .where(and(eq(steering.taskId, taskId), isNull(steering.consumedAt)))
    .orderBy(asc(steering.createdAt))
    .all();
  const now = clock();
  for (const row of rows) {
    orm(db).update(steering).set({ consumedAt: now }).where(eq(steering.id, row.id)).run();
  }
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    payload: isRecord(row.payload) ? row.payload : {},
    sourceEventId: row.sourceEventId,
    createdAt: row.createdAt,
    consumedAt: now,
  }));
}

export interface RequestConfirmationParams {
  taskId: string;
  actionRef: string;
  description: string;
  nudgeDeadline: string;
}

export function requestConfirmation(
  db: Database,
  clock: Clock,
  params: RequestConfirmationParams,
): Task {
  const pendingConfirmation: PendingConfirmation = {
    actionRef: params.actionRef,
    description: params.description,
    requestedAt: clock(),
  };
  return transition(
    db,
    clock,
    params.taskId,
    "waiting",
    { type: "yield_human", nudgeDeadline: params.nudgeDeadline, pendingConfirmation },
    {
      extraAudit: [
        {
          kind: "confirmation_requested",
          payload: { taskId: params.taskId, actionRef: params.actionRef },
        },
      ],
    },
  );
}

export interface ResolveConfirmationParams {
  identityId: string; // scoping: a foreign identity's confirmation is unreachable
  taskId: string;
  principalId: string;
  approve: boolean;
}

export function resolveConfirmation(
  db: Database,
  clock: Clock,
  params: ResolveConfirmationParams,
): SteerResult {
  const task = requireTaskFor(db, params.identityId, params.taskId);
  if (
    task.status !== "waiting" ||
    task.waitingOn !== "human" ||
    !task.pendingConfirmation ||
    task.pendingConfirmation.resolution
  ) {
    return { applied: false, task, reply: `${task.id} has no pending confirmation` };
  }

  const resolution: ConfirmationResolution = {
    approved: params.approve,
    principalId: params.principalId,
    resolvedAt: clock(),
  };
  const pendingConfirmation: PendingConfirmation = { ...task.pendingConfirmation, resolution };

  const after = transition(
    db,
    clock,
    task.id,
    "open",
    { type: "revive", pendingConfirmation },
    {
      extraAudit: [
        {
          kind: "confirmation_resolved",
          payload: {
            taskId: task.id,
            actionRef: pendingConfirmation.actionRef,
            approved: params.approve,
            principalId: params.principalId,
          },
        },
      ],
    },
  );

  return { applied: true, task: after };
}

// Single-use: burn at ALLOW before the call runs.
export function consumeConfirmation(db: Database, clock: Clock, taskId: string): void {
  const task = requireTask(db, taskId);
  if (!task.pendingConfirmation) return;
  const pendingConfirmation: PendingConfirmation = {
    ...task.pendingConfirmation,
    consumedAt: clock(),
  };
  orm(db)
    .update(tasks)
    .set({ pendingConfirmation: { ...pendingConfirmation }, updatedAt: clock() })
    .where(eq(tasks.id, taskId))
    .run();
}
