// SPEC §6.2, §13, §14.2, §17.3 — Execution Scheduler: durable timer firing, dispatch, restart
// recovery. Built entirely on tasks.ts's transition() and timers.ts's timer-table primitives.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { listDueTimers, markTimerFired, scheduleTimer, type TimerRow, type TimerKind } from "./timers";
import { getTask, transition, type Task, type WaitingOn } from "./tasks";

export interface FiredTimerResult {
  timerId: string;
  kind: TimerKind;
  subjectId: string | null;
  applied: boolean;
}

export interface FireDueTimersOpts {
  parkAfterMs: number;
  nudgeText?: (task: Task) => string;
  // SPEC §8.2: distillation cadence is a periodic per-identity tick, not task-scoped, so there's
  // no "content to process" mechanism here — that needs a source of recent observed/addressed
  // messages, which doesn't exist until the event router (M6) stores any. This just keeps the
  // cadence alive (re-arms the next tick) and notifies the caller, who wires in the real
  // distillation turn once there's something to sweep.
  distillationCadenceMs?: number;
  onDistillationDue?: (identityId: string) => void;
  // SPEC §9.1: "a durable ambient tick per identity (ambient.tick_interval, RECOMMENDED 15-60
  // min)". Same re-arm-and-notify shape as distillation — the caller runs the actual ambient turn
  // (buffer + memory + ledger view + granted read-only tools) once it fires.
  ambientTickCadenceMs?: number;
  onAmbientTickDue?: (identityId: string) => void;
}

// SPEC §8.2: "RECOMMENDED daily per identity" — arm the first/next distillation tick.
export function scheduleDistillationTick(db: Database, clock: Clock, identityId: string, cadenceMs: number): void {
  const dueAt = new Date(new Date(clock()).getTime() + cadenceMs).toISOString();
  scheduleTimer(db, { id: `distillation:${identityId}:${dueAt}`, kind: "distillation", identityId, subjectId: null, dueAt });
}

// SPEC §9.1: "RECOMMENDED 15-60 minutes" — arm the first/next ambient tick.
export function scheduleAmbientTick(db: Database, clock: Clock, identityId: string, cadenceMs: number): void {
  const dueAt = new Date(new Date(clock()).getTime() + cadenceMs).toISOString();
  scheduleTimer(db, { id: `ambient_tick:${identityId}:${dueAt}`, kind: "ambient_tick", identityId, subjectId: null, dueAt });
}

function defaultNudgeText(task: Task): string {
  return `Still waiting on your reply for ${task.id}.`;
}

// A timer is only actionable if it's still the one currently authoritative for its subject task —
// nothing superseded it (a newer wake_at, a status change) since it was scheduled. Otherwise it's
// a safe no-op (SPEC §6.1: "renders them no-ops via a state check at firing time").
function isCurrent(task: Task | null, waitingOn: WaitingOn, dueAt: string): task is Task {
  return task !== null && task.status === "waiting" && task.waitingOn === waitingOn && task.wakeAt === dueAt;
}

// task_wake/nudge/park timers are always task-scoped by construction (tasks.ts is their only
// writer); a missing subjectId means the timers table was corrupted or hand-edited.
function subjectTaskId(timer: TimerRow): string {
  if (!timer.subjectId) throw new Error(`timer ${timer.id} of kind ${timer.kind} has no subject task id`);
  return timer.subjectId;
}

function applyTaskWake(db: Database, clock: Clock, timer: TimerRow): boolean {
  const task = getTask(db, subjectTaskId(timer));
  if (!isCurrent(task, "timer", timer.dueAt)) return false;
  transition(db, clock, task.id, "open", { type: "revive" });
  return true;
}

function applyNudge(db: Database, clock: Clock, timer: TimerRow, opts: FireDueTimersOpts): boolean {
  const task = getTask(db, subjectTaskId(timer));
  if (!isCurrent(task, "human", timer.dueAt)) return false;
  const parkDeadline = new Date(new Date(clock()).getTime() + opts.parkAfterMs).toISOString();
  const text = (opts.nudgeText ?? defaultNudgeText)(task);
  transition(db, clock, task.id, "waiting", { type: "nudge_sent", parkDeadline, text });
  return true;
}

function applyPark(db: Database, clock: Clock, timer: TimerRow): boolean {
  const task = getTask(db, subjectTaskId(timer));
  if (!isCurrent(task, "human", timer.dueAt)) return false;
  transition(db, clock, task.id, "parked", { type: "park_timeout" });
  return true;
}

// Singleton ticks (one pending per kind+identity, enforced by timers_singleton_pending): the
// firing timer must be marked fired BEFORE the re-arm inserts, or the index would treat the
// re-arm as a duplicate of the still-pending row and silently drop it — ending the cadence.
// fireDueTimers marks again after apply; a second markTimerFired is a harmless no-op.
function applyDistillation(db: Database, clock: Clock, timer: TimerRow, opts: FireDueTimersOpts): boolean {
  markTimerFired(db, clock, timer.id);
  opts.onDistillationDue?.(timer.identityId);
  if (opts.distillationCadenceMs) scheduleDistillationTick(db, clock, timer.identityId, opts.distillationCadenceMs);
  return true;
}

function applyAmbientTick(db: Database, clock: Clock, timer: TimerRow, opts: FireDueTimersOpts): boolean {
  markTimerFired(db, clock, timer.id);
  opts.onAmbientTickDue?.(timer.identityId);
  if (opts.ambientTickCadenceMs) scheduleAmbientTick(db, clock, timer.identityId, opts.ambientTickCadenceMs);
  return true;
}

function applyTimer(db: Database, clock: Clock, timer: TimerRow, opts: FireDueTimersOpts): boolean {
  switch (timer.kind) {
    case "task_wake":
      return applyTaskWake(db, clock, timer);
    case "nudge":
      return applyNudge(db, clock, timer, opts);
    case "park":
      return applyPark(db, clock, timer);
    case "distillation":
      return applyDistillation(db, clock, timer, opts);
    case "ambient_tick":
      return applyAmbientTick(db, clock, timer, opts);
    case "recurrence":
      throw new Error(`timer kind not yet implemented by the scheduler: ${timer.kind}`);
  }
}

export function fireDueTimers(db: Database, clock: Clock, opts: FireDueTimersOpts): FiredTimerResult[] {
  const due = listDueTimers(db, clock);
  const results: FiredTimerResult[] = [];
  for (const timer of due) {
    const applied = applyTimer(db, clock, timer, opts);
    markTimerFired(db, clock, timer.id);
    results.push({ timerId: timer.id, kind: timer.kind, subjectId: timer.subjectId, applied });
  }
  return results;
}

// M9 idle-efficient heartbeat: ms until the next unfired timer is due (0 if one is already
// overdue), clamped to [0, maxMs]. Lets the service sleep until there's actually work instead of
// waking on a fixed short interval all night — while `maxMs` bounds the wait so a newly-dispatched
// task or a policy reload is still picked up promptly.
export function msUntilNextTimer(db: Database, clock: Clock, maxMs: number): number {
  const row = db.query("SELECT MIN(due_at) as next FROM timers WHERE fired_at IS NULL").get() as { next: string | null };
  if (!row.next) return maxMs;
  const delta = new Date(row.next).getTime() - new Date(clock()).getTime();
  return Math.max(0, Math.min(delta, maxMs));
}

export interface DispatchOpts {
  maxConcurrentPerIdentity: number;
  maxConcurrentGlobal: number;
  hasBudgetHeadroom?: (identityId: string) => boolean;
  newExecutionId: () => string;
}

export interface DispatchResult {
  dispatched: string[];
  deferredBudget: string[];
  deferredConcurrency: string[];
}

// SPEC §6.2, §17.3: runnable = open tasks, oldest-opened-first, bounded by per-identity/global
// concurrency, budget headroom checked before launch. waiting(timer) tasks whose wake_at has
// passed are already promoted to open by fireDueTimers before this runs.
export function dispatchRunnable(db: Database, clock: Clock, opts: DispatchOpts): DispatchResult {
  const openTasks = db
    .query("SELECT id, identity_id FROM tasks WHERE status = 'open' ORDER BY opened_at ASC, id ASC")
    .all() as { id: string; identity_id: string }[];

  const runningByIdentity = new Map<string, number>();
  const runningRows = db
    .query(
      `SELECT t.identity_id as identity_id, COUNT(*) as c FROM executions e
       JOIN tasks t ON t.id = e.task_id WHERE e.status = 'running' GROUP BY t.identity_id`,
    )
    .all() as { identity_id: string; c: number }[];
  for (const row of runningRows) runningByIdentity.set(row.identity_id, row.c);
  let globalRunning = runningRows.reduce((sum, row) => sum + row.c, 0);

  const dispatched: string[] = [];
  const deferredBudget: string[] = [];
  const deferredConcurrency: string[] = [];

  for (const row of openTasks) {
    if (globalRunning >= opts.maxConcurrentGlobal) {
      deferredConcurrency.push(row.id);
      continue;
    }
    const identityRunning = runningByIdentity.get(row.identity_id) ?? 0;
    if (identityRunning >= opts.maxConcurrentPerIdentity) {
      deferredConcurrency.push(row.id);
      continue;
    }
    if (opts.hasBudgetHeadroom && !opts.hasBudgetHeadroom(row.identity_id)) {
      deferredBudget.push(row.id);
      continue;
    }
    transition(db, clock, row.id, "active", { type: "dispatch", executionId: opts.newExecutionId() });
    dispatched.push(row.id);
    runningByIdentity.set(row.identity_id, identityRunning + 1);
    globalRunning += 1;
  }

  return { dispatched, deferredBudget, deferredConcurrency };
}

export interface RestartRecoveryResult {
  reopened: string[];
  parked: string[];
}

// SPEC §14.2's "interrupted, redispatch, or park past the bound" logic — shared by restart
// recovery below AND by the execution loop's reaction to a same-process turn crash/stall (both
// are "this execution died unexpectedly"; the crash-loop protection should apply identically).
// Returns which of the two happened, for the caller's own bookkeeping.
export function interruptOrPark(
  db: Database,
  clock: Clock,
  taskId: string,
  currentConsecutiveInterruptions: number,
  maxConsecutiveInterruptions: number,
): "reopened" | "parked" {
  const nextCount = currentConsecutiveInterruptions + 1;
  if (nextCount > maxConsecutiveInterruptions) {
    transition(db, clock, taskId, "parked", {
      type: "crash_loop_parked",
      report: `${taskId} parked after ${nextCount} consecutive interruptions; needs operator attention.`,
    });
    return "parked";
  }
  transition(db, clock, taskId, "open", { type: "interrupted" });
  return "reopened";
}

// SPEC §14.2: any task still 'active' at startup was driven by a process that no longer exists —
// its execution is orphaned. Mark it interrupted and either redispatch (task -> open) or, past
// the consecutive-interruption bound, park it visibly instead of churning.
export function recoverFromRestart(
  db: Database,
  clock: Clock,
  opts: { maxConsecutiveInterruptions: number },
): RestartRecoveryResult {
  const orphaned = db
    .query("SELECT id, consecutive_interruptions FROM tasks WHERE status = 'active'")
    .all() as { id: string; consecutive_interruptions: number }[];
  const reopened: string[] = [];
  const parked: string[] = [];

  for (const { id, consecutive_interruptions } of orphaned) {
    const result = interruptOrPark(db, clock, id, consecutive_interruptions, opts.maxConsecutiveInterruptions);
    (result === "parked" ? parked : reopened).push(id);
  }

  return { reopened, parked };
}
