// SPEC §6 — Task Ledger. This module is the single choke point for task state changes:
// every status change and every executions-row change for a task goes through transition().
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { scheduleTimer, type TimerKind } from "./timers";
import { writeAudit, type AuditKind } from "./audit";

export type TaskStatus = "open" | "active" | "waiting" | "parked" | "done" | "failed" | "cancelled";
export type WaitingOn = "human" | "timer" | "external";
export type SteeringKind = "guidance" | "cancel" | "pause" | "resume" | "confirm";

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
  actionRef: string;
  description: string;
  requestedAt: string;
  resolution?: ConfirmationResolution;
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

export interface SteeringRow {
  id: string;
  taskId: string;
  kind: SteeringKind;
  payload: Record<string, unknown>;
  sourceEventId: string;
  createdAt: string;
  consumedAt: string | null;
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

// No cause ever generates a Slack post. Anything the room should hear, the model says itself
// (reply/react) — the ledger records state (terminal_report, pending_confirmation, audit), never
// speaks. Harness-authored or harness-echoed messages read as noise and are banned outright.
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

interface Row {
  id: string;
  identity_id: string;
  title: string;
  spec: string;
  status: TaskStatus;
  waiting_on: WaitingOn | null;
  sponsor_id: string;
  home_venue_id: string;
  home_thread_root_id: string | null;
  origin_event_id: string;
  wake_at: string | null;
  pending_confirmation: string | null;
  recurrence: string | null;
  tier: string;
  artifacts: string;
  terminal_report: string | null;
  created_at: string;
  updated_at: string;
  opened_at: string;
  consecutive_interruptions: number;
}

function rowToTask(row: Row): Task {
  return {
    id: row.id,
    identityId: row.identity_id,
    title: row.title,
    spec: row.spec,
    status: row.status,
    waitingOn: row.waiting_on,
    sponsorId: row.sponsor_id,
    homeAnchor: { venueId: row.home_venue_id, threadRootId: row.home_thread_root_id },
    originEventId: row.origin_event_id,
    wakeAt: row.wake_at,
    pendingConfirmation: row.pending_confirmation ? JSON.parse(row.pending_confirmation) : null,
    recurrence: row.recurrence,
    tier: (row.tier as Task["tier"]) ?? "high",
    artifacts: JSON.parse(row.artifacts),
    terminalReport: row.terminal_report,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    openedAt: row.opened_at,
    consecutiveInterruptions: row.consecutive_interruptions,
  };
}

export function getTask(db: Database, taskId: string): Task | null {
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Row | null;
  return row ? rowToTask(row) : null;
}

// SPEC §4.2 — "short, human-readable, unique per service instance, and usable in chat." T-1, T-2, ...
export function nextTaskId(db: Database): string {
  const row = db.query("SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) as n FROM tasks WHERE id LIKE 'T-%'").get() as {
    n: number | null;
  };
  return `T-${(row.n ?? 0) + 1}`;
}

// SPEC §11 — the ledger view a turn's context is built from: open tasks + recent terminals, for
// one identity (never cross-identity, per §7.1).
export function ledgerView(db: Database, identityId: string, recentTerminalsLimit = 10): { open: Task[]; recentTerminals: Task[] } {
  const openRows = db
    .query("SELECT * FROM tasks WHERE identity_id = ? AND status NOT IN ('done','failed','cancelled') ORDER BY opened_at ASC")
    .all(identityId) as Row[];
  const terminalRows = db
    .query("SELECT * FROM tasks WHERE identity_id = ? AND status IN ('done','failed','cancelled') ORDER BY updated_at DESC LIMIT ?")
    .all(identityId, recentTerminalsLimit) as Row[];
  return { open: openRows.map(rowToTask), recentTerminals: terminalRows.map(rowToTask) };
}

export function requireTask(db: Database, taskId: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  return task;
}


// The running execution row for a task, if any (the "one live execution per task" invariant means
// there's at most one). Exported so the service's dispatch driver can find the execution id
// dispatchRunnable just created, to hand to runExecution.
export function liveExecutionId(db: Database, taskId: string): string | null {
  const row = db.query("SELECT id FROM executions WHERE task_id = ? AND status = 'running'").get(taskId) as
    | { id: string }
    | null;
  return row?.id ?? null;
}

function endExecution(db: Database, taskId: string, at: string, status: string) {
  const execId = liveExecutionId(db, taskId);
  if (!execId) return;
  db.query("UPDATE executions SET status = ?, ended_at = ? WHERE id = ?").run(status, at, execId);
}

// The durable counterpart to a task's wake_at: lets the scheduler tell nudge/park/task_wake
// deadlines apart (tasks.wake_at alone only holds one value at a time, SPEC §13).
function scheduleWakeTimer(db: Database, task: Task, kind: TimerKind, dueAt: string) {
  scheduleTimer(db, { id: `${task.id}:${kind}:${dueAt}`, kind, identityId: task.identityId, subjectId: task.id, dueAt });
}

export interface CreateTaskParams {
  id: string;
  identityId: string;
  title: string;
  spec: string;
  sponsorId: string;
  homeAnchor: Anchor;
  originEventId: string;
  recurrence?: string;
  tier?: Task["tier"];
  sponsorIsOperator?: boolean;
}

export function createTask(db: Database, clock: Clock, params: CreateTaskParams): Task {
  if (params.recurrence && !params.sponsorIsOperator) {
    throw new RecurrenceRequiresOperatorError();
  }
  const now = clock();
  db.query(
    `INSERT INTO tasks
       (id, identity_id, title, spec, status, waiting_on, sponsor_id, home_venue_id, home_thread_root_id,
        origin_event_id, wake_at, pending_confirmation, recurrence, tier, artifacts, terminal_report,
        created_at, updated_at, opened_at)
     VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, '[]', NULL, ?, ?, ?)`,
  ).run(
    params.id,
    params.identityId,
    params.title,
    params.spec,
    params.sponsorId,
    params.homeAnchor.venueId,
    params.homeAnchor.threadRootId,
    params.originEventId,
    params.recurrence ?? null,
    params.tier ?? "high",
    now,
    now,
    now,
  );
  writeAudit(db, now, params.identityId, "task_created", { taskId: params.id, title: params.title });
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
  if ((cause.type === "recurrence_rearm" || cause.type === "recurrence_failed") && !task.recurrence) {
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
  // Only a genuine crash (interrupted) counts toward the crash-loop bound (SPEC §14.2). A bare
  // redispatch doesn't yet prove anything, so it leaves the count untouched; any other transition
  // (a real yield or terminal outcome) proves the ledger is being driven normally and clears it.
  let consecutiveInterruptions = task.consecutiveInterruptions;
  if (cause.type === "interrupted") consecutiveInterruptions += 1;
  else if (cause.type !== "dispatch") consecutiveInterruptions = 0;

  switch (cause.type) {
    case "dispatch": {
      const attempt =
        ((db.query("SELECT MAX(attempt) as m FROM executions WHERE task_id = ?").get(taskId) as { m: number | null })
          .m ?? 0) + 1;
      db.query("INSERT INTO executions (id, task_id, attempt, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(
        cause.executionId,
        taskId,
        attempt,
        now,
      );
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

  db.query(
    `UPDATE tasks SET status = ?, waiting_on = ?, wake_at = ?, terminal_report = ?, pending_confirmation = ?,
       recurrence = ?, opened_at = ?, consecutive_interruptions = ?, updated_at = ? WHERE id = ?`,
  ).run(
    to,
    waitingOn,
    wakeAt,
    terminalReport,
    pendingConfirmation ? JSON.stringify(pendingConfirmation) : null,
    recurrence,
    openedAt,
    consecutiveInterruptions,
    now,
    taskId,
  );
  writeAudit(db, now, task.identityId, "task_transitioned", { taskId, from: task.status, to, cause: cause.type });

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
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = applyTransition(db, clock, taskId, to, cause);
    for (const entry of opts.extraAudit ?? []) {
      writeAudit(db, clock(), task.identityId, entry.kind, entry.payload);
    }
    db.exec("COMMIT");
    return task;
  } catch (err) {
    db.exec("ROLLBACK");
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
  db.query(
    `INSERT INTO steering (id, task_id, kind, payload, source_event_id, created_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`${taskId}-steer-${now}-${Math.random().toString(36).slice(2, 8)}`, taskId, kind, JSON.stringify(payload), sourceEventId, now, consumed ? now : null);
}

export interface SteerParams {
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

const TERMINAL_STATUSES: TaskStatus[] = ["done", "failed", "cancelled"];

export function steerTask(db: Database, clock: Clock, params: SteerParams): SteerResult {
  const task = requireTask(db, params.taskId);

  if (TERMINAL_STATUSES.includes(task.status)) {
    insertSteeringRow(db, clock, params.taskId, params.kind, params.payload, params.sourceEventId, true);
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
  }
}

function appendSpec(db: Database, clock: Clock, task: Task, addition: string): void {
  const now = clock();
  db.query("UPDATE tasks SET spec = spec || ? , updated_at = ? WHERE id = ?").run(`\n\n${addition}`, now, task.id);
}

function steerGuidance(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  const text = String(params.payload.text ?? "");
  appendSpec(db, clock, task, text);

  const live = task.status === "active";
  insertSteeringRow(db, clock, task.id, "guidance", params.payload, params.sourceEventId, !live);

  let after = requireTask(db, task.id);
  if (!live && (task.status === "parked" || (task.status === "waiting" && task.waitingOn === "human"))) {
    after = transition(db, clock, task.id, "open", { type: "revive" });
  }
  return { applied: true, task: after };
}

function steerCancel(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  const report = String(params.payload.report ?? `Cancelled "${task.title}".`);
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
  const principalId = String(params.payload.principalId ?? "");
  const outcome = resolveConfirmation(db, clock, { taskId: task.id, principalId, approve });
  insertSteeringRow(db, clock, task.id, "confirm", params.payload, params.sourceEventId, true);
  return outcome;
}

export function consumeSteering(db: Database, clock: Clock, taskId: string): SteeringRow[] {
  const rows = db
    .query("SELECT * FROM steering WHERE task_id = ? AND consumed_at IS NULL ORDER BY created_at")
    .all(taskId) as any[];
  const now = clock();
  for (const row of rows) {
    db.query("UPDATE steering SET consumed_at = ? WHERE id = ?").run(now, row.id);
  }
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    sourceEventId: row.source_event_id,
    createdAt: row.created_at,
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
    { extraAudit: [{ kind: "confirmation_requested", payload: { taskId: params.taskId, actionRef: params.actionRef } }] },
  );
}

export interface ResolveConfirmationParams {
  taskId: string;
  principalId: string;
  approve: boolean;
}

export function resolveConfirmation(
  db: Database,
  clock: Clock,
  params: ResolveConfirmationParams,
): SteerResult {
  const task = requireTask(db, params.taskId);
  if (task.status !== "waiting" || task.waitingOn !== "human" || !task.pendingConfirmation || task.pendingConfirmation.resolution) {
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
