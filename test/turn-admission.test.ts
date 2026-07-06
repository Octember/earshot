import { describe, expect, test } from "bun:test";
import { TurnAdmission } from "../src/adapter/turn-admission";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TurnAdmission (SPEC §5.5, §17.2)", () => {
  test("at most one interactive turn runs at a time per anchor — a second event during a running turn is batched, not run concurrently", async () => {
    const running: number[] = [];
    const batches: string[][] = [];
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      runInteractiveTurn: async (_identityId, _anchor, events) => {
        running.push(running.length + 1);
        batches.push(events.map((e) => e.id));
        await sleep(20);
        running.pop();
      },
    });

    const anchor = { venueId: "C1", threadRootId: null };
    admission.enqueue("eng", anchor, { id: "e1" } as any);
    await sleep(2);
    admission.enqueue("eng", anchor, { id: "e2" } as any); // arrives while turn 1 is running

    await sleep(60);

    expect(batches).toEqual([["e1"], ["e2"]]); // batched into an immediately following turn, not dropped/reordered
  });

  test("interactive turns on different anchors run concurrently", async () => {
    let concurrentPeak = 0;
    let concurrentNow = 0;
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      runInteractiveTurn: async () => {
        concurrentNow++;
        concurrentPeak = Math.max(concurrentPeak, concurrentNow);
        await sleep(20);
        concurrentNow--;
      },
    });

    admission.enqueue("eng", { venueId: "C1", threadRootId: null }, { id: "e1" } as any);
    admission.enqueue("eng", { venueId: "C2", threadRootId: null }, { id: "e2" } as any);

    await sleep(60);
    expect(concurrentPeak).toBe(2);
  });

  test("per-identity concurrency cap bounds how many anchors run at once; the rest wait for a slot", async () => {
    let concurrentPeak = 0;
    let concurrentNow = 0;
    const started: string[] = [];
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 1,
      runInteractiveTurn: async (_id, anchor) => {
        started.push(anchor.venueId);
        concurrentNow++;
        concurrentPeak = Math.max(concurrentPeak, concurrentNow);
        await sleep(20);
        concurrentNow--;
      },
    });

    admission.enqueue("eng", { venueId: "C1", threadRootId: null }, { id: "e1" } as any);
    admission.enqueue("eng", { venueId: "C2", threadRootId: null }, { id: "e2" } as any);

    await sleep(60);
    expect(concurrentPeak).toBe(1);
    expect(started.sort()).toEqual(["C1", "C2"]); // the second eventually runs once the first frees its slot
  });

});

describe("quiet-window batching (SPEC §5.5)", () => {
  test("a burst within the window collapses into ONE batch, in arrival order", async () => {
    const batches: string[][] = [];
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      batchDebounceMs: 30,
      batchMaxWaitMs: 1000,
      runInteractiveTurn: async (_i, _a, events) => {
        batches.push(events.map((e) => e.id));
      },
    });

    const anchor = { venueId: "C1", threadRootId: null };
    admission.enqueue("eng", anchor, { id: "e1" } as any);
    await sleep(10);
    admission.enqueue("eng", anchor, { id: "e2" } as any); // resets the window
    await sleep(10);
    admission.enqueue("eng", anchor, { id: "e3" } as any);
    await sleep(80); // window elapses

    expect(batches).toEqual([["e1", "e2", "e3"]]);
  });

  test("sustained chatter cannot hold a batch past max wait", async () => {
    const batches: string[][] = [];
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      batchDebounceMs: 30,
      batchMaxWaitMs: 60,
      runInteractiveTurn: async (_i, _a, events) => {
        batches.push(events.map((e) => e.id));
      },
    });

    const anchor = { venueId: "C1", threadRootId: null };
    // keep talking every 15ms — the 30ms quiet window never elapses on its own
    for (let i = 1; i <= 8; i++) {
      admission.enqueue("eng", anchor, { id: `e${i}` } as any);
      await sleep(15);
    }
    await sleep(100);

    expect(batches.length).toBeGreaterThan(1); // max-wait forced a start mid-chatter
    expect(batches.flat()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"]); // nothing dropped or reordered
  });

  test("flush() starts a held batch immediately (shutdown/drain support)", async () => {
    const batches: string[][] = [];
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      batchDebounceMs: 60_000, // would hold forever on test timescales
      runInteractiveTurn: async (_i, _a, events) => {
        batches.push(events.map((e) => e.id));
      },
    });

    admission.enqueue("eng", { venueId: "C1", threadRootId: null }, { id: "e1" } as any);
    await sleep(5);
    expect(batches).toEqual([]); // held
    admission.flush();
    await sleep(5);
    expect(batches).toEqual([["e1"]]);
  });

  test("events queued mid-turn re-enter the quiet window before the next batch", async () => {
    const batches: string[][] = [];
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      batchDebounceMs: 30,
      batchMaxWaitMs: 1000,
      runInteractiveTurn: async (_i, _a, events) => {
        batches.push(events.map((e) => e.id));
        if (events[0]!.id === "e1") await sleep(40); // hold the turn while e2/e3 arrive
      },
    });

    const anchor = { venueId: "C1", threadRootId: null };
    admission.enqueue("eng", anchor, { id: "e1" } as any);
    await sleep(35); // e1's window elapses, its turn starts and runs 40ms
    admission.enqueue("eng", anchor, { id: "e2" } as any);
    await sleep(10);
    admission.enqueue("eng", anchor, { id: "e3" } as any); // still inside e2's window when the turn ends
    await sleep(100);

    expect(batches).toEqual([["e1"], ["e2", "e3"]]); // the mid-turn arrivals landed as one later batch
  });
});

describe("bounded memory over long uptime (M9)", () => {
  test("an anchor's state is evicted once its queue drains, so the map doesn't grow unbounded", async () => {
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      runInteractiveTurn: async () => {},
    });

    // Process 100 distinct one-shot anchors.
    for (let i = 0; i < 100; i++) {
      admission.enqueue("eng", { venueId: `C${i}`, threadRootId: null }, { id: `e${i}` } as any);
    }
    await sleep(30);

    // All drained → map is back to empty, not holding 100 stale entries.
    expect(admission.size()).toBe(0);
  });

  test("an anchor with queued work is NOT evicted mid-flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      runInteractiveTurn: async () => {
        await gate;
      },
    });

    admission.enqueue("eng", { venueId: "C1", threadRootId: null }, { id: "e1" } as any);
    await sleep(5);
    expect(admission.size()).toBe(1); // still running — retained

    release();
    await sleep(10);
    expect(admission.size()).toBe(0); // now evicted
  });
});
