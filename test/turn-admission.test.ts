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
      ackTimeoutMs: 10_000,
      runInteractiveTurn: async (_identityId, _anchor, events) => {
        running.push(running.length + 1);
        batches.push(events.map((e) => e.id));
        await sleep(20);
        running.pop();
      },
      ackIfSlow: () => {},
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
      ackTimeoutMs: 10_000,
      runInteractiveTurn: async () => {
        concurrentNow++;
        concurrentPeak = Math.max(concurrentPeak, concurrentNow);
        await sleep(20);
        concurrentNow--;
      },
      ackIfSlow: () => {},
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
      ackTimeoutMs: 10_000,
      runInteractiveTurn: async (_id, anchor) => {
        started.push(anchor.venueId);
        concurrentNow++;
        concurrentPeak = Math.max(concurrentPeak, concurrentNow);
        await sleep(20);
        concurrentNow--;
      },
      ackIfSlow: () => {},
    });

    admission.enqueue("eng", { venueId: "C1", threadRootId: null }, { id: "e1" } as any);
    admission.enqueue("eng", { venueId: "C2", threadRootId: null }, { id: "e2" } as any);

    await sleep(60);
    expect(concurrentPeak).toBe(1);
    expect(started.sort()).toEqual(["C1", "C2"]); // the second eventually runs once the first frees its slot
  });

  test("a slow turn triggers a lightweight ack after the deadline; a fast turn never does", async () => {
    let acked = 0;
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      ackTimeoutMs: 15,
      runInteractiveTurn: async (_id, _anchor, events) => {
        if (events[0]?.id === "slow") await sleep(40);
      },
      ackIfSlow: () => {
        acked++;
      },
    });

    admission.enqueue("eng", { venueId: "C1", threadRootId: null }, { id: "fast" } as any);
    await sleep(30);
    expect(acked).toBe(0);

    admission.enqueue("eng", { venueId: "C2", threadRootId: null }, { id: "slow" } as any);
    await sleep(60);
    expect(acked).toBe(1);
  });

  test("a stale ack timer from an already-finished fast turn never fires late", async () => {
    let acked = 0;
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      ackTimeoutMs: 20,
      runInteractiveTurn: async () => {},
      ackIfSlow: () => {
        acked++;
      },
    });

    admission.enqueue("eng", { venueId: "C1", threadRootId: null }, { id: "e1" } as any);
    await sleep(50);
    expect(acked).toBe(0);
  });
});

describe("bounded memory over long uptime (M9)", () => {
  test("an anchor's state is evicted once its queue drains, so the map doesn't grow unbounded", async () => {
    const admission = new TurnAdmission({
      maxConcurrentInteractive: 10,
      ackTimeoutMs: 10_000,
      runInteractiveTurn: async () => {},
      ackIfSlow: () => {},
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
      ackTimeoutMs: 10_000,
      runInteractiveTurn: async () => {
        await gate;
      },
      ackIfSlow: () => {},
    });

    admission.enqueue("eng", { venueId: "C1", threadRootId: null }, { id: "e1" } as any);
    await sleep(5);
    expect(admission.size()).toBe(1); // still running — retained

    release();
    await sleep(10);
    expect(admission.size()).toBe(0); // now evicted
  });
});
