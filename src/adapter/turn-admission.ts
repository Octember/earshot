// SPEC §5.5, §17.2 — interactive turn admission: per-anchor serialization, batching, and the
// quiet-window hold. Implementation-defined choice (CLAUDE.md: document where SPEC leaves it
// open) — §5.5 allows either injecting newly-arrived events into a running turn or batching them
// into an immediately following one; this batches. Injection would need bidirectional mid-turn
// communication with the agent runtime session, which the turn-runner doesn't support and SPEC
// doesn't require.
//
// The quiet window (§5.5): a turn starts only after the anchor has been quiet for
// `batchDebounceMs` (each arriving event resets the window), bounded by `batchMaxWaitMs` so
// sustained chatter can't starve a turn. A burst of messages therefore lands as ONE batch with
// complete context, instead of a serial queue of turns each answering a room that has moved on.
// Zero debounce disables the hold (start immediately — the pre-window behavior).
import type { Event } from "./router";

export interface AnchorKey {
  venueId: string;
  threadRootId: string | null;
}

interface AnchorState {
  anchor: AnchorKey;
  identityId: string;
  queue: Event[];
  running: boolean;
  lastEnqueueAt: number; // epoch ms of the newest queued event (quiet-window reference)
  oldestQueuedAt: number | null; // epoch ms the current pending batch started waiting (max-wait reference)
  gate: ReturnType<typeof setTimeout> | null; // armed quiet-window timer, if any
}

function anchorKeyOf(anchor: AnchorKey): string {
  return `${anchor.venueId}\0${anchor.threadRootId ?? ""}`; // \0 can't appear in an id — collision-proof join
}

export interface TurnAdmissionOpts {
  maxConcurrentInteractive: number;
  batchDebounceMs?: number; // 0/omitted = no hold
  batchMaxWaitMs?: number; // bound on the hold (default 10s)
  runInteractiveTurn: (identityId: string, anchor: AnchorKey, events: Event[]) => Promise<void>;
}

export class TurnAdmission {
  private anchors = new Map<string, AnchorState>();
  private runningCountByIdentity = new Map<string, number>();

  constructor(private opts: TurnAdmissionOpts) {}

  // Queued events are never dropped or reordered within an anchor (SPEC §5.5) — enqueue always
  // appends, whether or not a turn is currently running for this anchor.
  enqueue(identityId: string, anchor: AnchorKey, event: Event): void {
    const key = anchorKeyOf(anchor);
    let state = this.anchors.get(key);
    if (!state) {
      state = { anchor, identityId, queue: [], running: false, lastEnqueueAt: 0, oldestQueuedAt: null, gate: null };
      this.anchors.set(key, state);
    }
    state.queue.push(event);
    state.lastEnqueueAt = Date.now();
    state.oldestQueuedAt ??= state.lastEnqueueAt;
    this.tryStart(key);
  }

  // Start every pending batch NOW, quiet window be damned — shutdown/drain support so a queued
  // event is never silently dropped by stop(); tests use it to avoid real-time waits.
  flush(): void {
    for (const [key, state] of this.anchors) {
      state.lastEnqueueAt = 0; // the window reads as long since elapsed
      this.tryStart(key);
    }
  }

  // How much longer the quiet window holds this anchor's next batch. 0 = start now.
  private holdMs(state: AnchorState): number {
    const debounce = this.opts.batchDebounceMs ?? 0;
    if (debounce <= 0 || state.oldestQueuedAt === null) return 0;
    const now = Date.now();
    const quietRemaining = debounce - (now - state.lastEnqueueAt);
    const capRemaining = (this.opts.batchMaxWaitMs ?? 10_000) - (now - state.oldestQueuedAt);
    return Math.max(0, Math.min(quietRemaining, capRemaining));
  }

  private tryStart(key: string): void {
    const state = this.anchors.get(key);
    if (!state || state.running || state.queue.length === 0) return;
    const hold = this.holdMs(state);
    if (hold > 0) {
      if (state.gate) clearTimeout(state.gate);
      state.gate = setTimeout(() => {
        state.gate = null;
        this.tryStart(key);
      }, hold);
      return;
    }
    const running = this.runningCountByIdentity.get(state.identityId) ?? 0;
    if (running >= this.opts.maxConcurrentInteractive) return; // retried when another anchor for this identity frees a slot
    if (state.gate) {
      clearTimeout(state.gate);
      state.gate = null;
    }
    state.running = true;
    this.runningCountByIdentity.set(state.identityId, running + 1);
    void this.drain(key);
  }

  private async drain(key: string): Promise<void> {
    const state = this.anchors.get(key)!;
    try {
      const batch = state.queue;
      state.queue = [];
      state.oldestQueuedAt = null;
      // §5.2's visible-response deadline is met at admission (the service shows the indicator for
      // direct-address events on enqueue, before any quiet-window hold). No harness-side ack path.
      await this.opts.runInteractiveTurn(state.identityId, state.anchor, batch);
    } finally {
      state.running = false;
      const running = this.runningCountByIdentity.get(state.identityId) ?? 1;
      if (running - 1 <= 0) this.runningCountByIdentity.delete(state.identityId);
      else this.runningCountByIdentity.set(state.identityId, running - 1);
      // M9 memory bound: a fully-drained, not-running anchor holds no state worth keeping — evict
      // it so the map tracks only active anchors, not every anchor ever seen (a later event
      // recreates the entry). SPEC §5.5's no-drop/no-reorder guarantee is unaffected: eviction
      // only happens when the queue is empty.
      if (state.queue.length === 0) this.anchors.delete(key);
      // Events queued mid-turn go back through the quiet window (the room may still be mid-burst).
      else this.tryStart(key);
      // a slot freed up: give it to one other anchor of this identity that's been waiting
      for (const [otherKey, otherState] of this.anchors) {
        if (otherState.identityId === state.identityId && otherKey !== key && !otherState.running && otherState.queue.length > 0) {
          this.tryStart(otherKey);
          break;
        }
      }
    }
  }

  // Number of anchors currently tracked (active/queued only — drained anchors are evicted).
  size(): number {
    return this.anchors.size;
  }
}
