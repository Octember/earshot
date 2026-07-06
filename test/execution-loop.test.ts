import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { createTask, transition, getTask, steerTask } from "../src/ledger/tasks";
import { recordTurn } from "../src/ledger/turns";
import { runExecution } from "../src/turn-runner/execution-loop";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { IdentityConfig } from "../src/policy/schema";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock & { advance: (iso: string) => void } {
  let now = start;
  const clock = (() => now) as Clock & { advance: (iso: string) => void };
  clock.advance = (iso: string) => {
    now = iso;
  };
  return clock;
}

function identity(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    id: "eng",
    persona: null,
    venueIds: ["C1"],
    learningSources: [],
    grants: [],
    budget: { monthlyCap: 100, perTaskCap: null },
    ambient: { enabledVenues: [], tickIntervalMs: 1800000, dailyPostCap: 5, followupQuietMs: 3600000, eventDebounceMs: 0 },
    venueInstructions: {},
    ...overrides,
  };
}

function makeActiveTask(db: ReturnType<typeof openLedger>, clock: Clock, id = "T-1") {
  db.query(
    "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES (?, ?, 'addressed_message', 'eng', ?)",
  ).run(`${id}-e`, `${id}-k`, clock());
  createTask(db, clock, {
    id,
    identityId: "eng",
    title: "dig in",
    spec: "figure out why it's slow",
    sponsorId: "U1",
    homeAnchor: { venueId: "C1", threadRootId: null },
    originEventId: `${id}-e`,
  });
  transition(db, clock, id, "active", { type: "dispatch", executionId: "x1" });
}

function baseParams(db: ReturnType<typeof openLedger>, clock: Clock, session: (tools: any) => FakeAgentRuntimeSession) {
  let n = 0;
  return {
    db,
    clock,
    taskId: "T-1",
    executionId: "x1",
    identity: identity(),
    catalog: {},
    cwd: "/tmp",
    nudgeAfterMs: 24 * 60 * 60 * 1000,
    maxTurns: 5,
    maxConsecutiveInterruptions: 2,
    stallTimeoutMs: 2000,
    postMessage: async () => ({ messageId: "m1" }),
    buildPrompt: (turnNumber: number) => `turn ${turnNumber}`,
    newTurnId: () => `turn-${++n}`,
    sessionFactory: session,
  };
}

describe("runExecution (SPEC §17.4)", () => {
  test("a turn calling task_complete ends the loop with outcome done", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);

    const result = await runExecution(
      baseParams(db, clock, (tools) => new FakeAgentRuntimeSession(tools, async (_n, t) => {
        await t.get("task_complete")!.run({ report: "fixed the slow query" });
      })),
    );

    expect(result.outcome).toBe("done");
    expect(result.turnsRun).toBe(1);
    expect(getTask(db, "T-1")?.terminalReport).toBe("fixed the slow query");
  });

  test("set_wake ends the loop with outcome yielded, task waiting(timer)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);

    const result = await runExecution(
      baseParams(db, clock, (tools) => new FakeAgentRuntimeSession(tools, async (_n, t) => {
        await t.get("set_wake")!.run({ wakeAt: "2026-07-09T00:00:00Z" });
      })),
    );

    expect(result.outcome).toBe("yielded");
    const task = getTask(db, "T-1")!;
    expect(task.status).toBe("waiting");
    expect(task.waitingOn).toBe("timer");
  });

  test("reaching max_turns forces a graceful yield with a progress report", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);

    const params = baseParams(db, clock, (tools) => new FakeAgentRuntimeSession(tools, async () => {
      // never declares an outcome — just keeps "working"
    }));
    const result = await runExecution({ ...params, maxTurns: 3 });

    expect(result.outcome).toBe("yielded");
    expect(result.turnsRun).toBe(3);
    const task = getTask(db, "T-1")!;
    expect(task.status).toBe("open");
  });

  test("a cancel steer applied before a turn stops the loop immediately with outcome cancelled", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);
    db.query(
      "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e2', 'k2', 'addressed_message', 'eng', ?)",
    ).run(clock());
    steerTask(db, clock, { taskId: "T-1", kind: "cancel", payload: { report: "member asked to stop" }, sourceEventId: "e2" });

    let turnsInvoked = 0;
    const result = await runExecution(
      baseParams(db, clock, (tools) => new FakeAgentRuntimeSession(tools, async () => {
        turnsInvoked++;
      })),
    );

    expect(result.outcome).toBe("cancelled");
    expect(result.turnsRun).toBe(0);
    expect(turnsInvoked).toBe(0);
  });

  test("steering guidance queued mid-execution is folded into the next turn's prompt", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);

    const seenGuidance: string[][] = [];
    let turnNum = 0;
    const params = baseParams(db, clock, (tools) =>
      new FakeAgentRuntimeSession(tools, async (n, t) => {
        turnNum = n;
        if (n === 1) {
          db.query(
            "INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e2', 'k2', 'addressed_message', 'eng', ?)",
          ).run(clock());
          steerTask(db, clock, { taskId: "T-1", kind: "guidance", payload: { text: "also check redis" }, sourceEventId: "e2" });
        } else {
          await t.get("task_complete")!.run({ report: "done" });
        }
      }),
    );
    const result = await runExecution({
      ...params,
      buildPrompt: (n: number, guidance: string[]) => {
        seenGuidance.push(guidance);
        return `turn ${n}`;
      },
    });

    expect(result.outcome).toBe("done");
    expect(seenGuidance[0]).toEqual([]);
    expect(seenGuidance[1]).toEqual(["also check redis"]);
  });

  test("effects are reset per turn — a completed turn's record doesn't carry an earlier turn's effects", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);

    const params = baseParams(db, clock, (tools) =>
      new FakeAgentRuntimeSession(tools, async (n, t) => {
        if (n === 1) {
          await t.get("reply")!.run({ text: "starting work" });
        } else {
          await t.get("task_complete")!.run({ report: "done" });
        }
      }),
    );
    await runExecution(params);

    const { getTurn } = await import("../src/ledger/turns");
    const turn1 = getTurn(db, "turn-1")!;
    const turn2 = getTurn(db, "turn-2")!;
    expect(turn1.effects).toEqual([{ kind: "posted", anchor: { venueId: "C1", threadRootId: null }, text: "starting work" }]);
    expect(turn2.effects).toEqual([{ kind: "task_completed", taskId: "T-1" }]);
  });

  test("a stalled turn within the interruption bound reopens the task (redispatchable)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);

    const params = baseParams(db, clock, (tools) =>
      new FakeAgentRuntimeSession(tools, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100)); // longer than stallTimeoutMs
      }),
    );
    const result = await runExecution({ ...params, stallTimeoutMs: 10, maxConsecutiveInterruptions: 3 });

    expect(result.outcome).toBe("yielded");
    const task = getTask(db, "T-1")!;
    expect(task.status).toBe("open");
    expect(task.consecutiveInterruptions).toBe(1);
  });

  test("exceeding the consecutive-interruption bound parks the task instead of reopening it", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);
    // simulate two prior interruptions already on the task
    transition(db, clock, "T-1", "open", { type: "interrupted" });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x2" });
    transition(db, clock, "T-1", "open", { type: "interrupted" });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x3" });

    const params = baseParams(db, clock, (tools) =>
      new FakeAgentRuntimeSession(tools, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }),
    );
    const posted: string[] = [];
    const result = await runExecution({
      ...params,
      executionId: "x3",
      stallTimeoutMs: 10,
      maxConsecutiveInterruptions: 2,
      postMessage: async (_a: unknown, text: string) => {
        posted.push(text);
        return { messageId: "m1" };
      },
    });

    expect(result.outcome).toBe("parked");
    expect(getTask(db, "T-1")?.status).toBe("parked");
    // The park is ledger-visible only — the harness never posts on its own.
    expect(posted).toEqual([]);
  });

  test("session.stop() is always called, even after a normal completion", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);
    let stopped = false;

    const result = await runExecution(
      baseParams(db, clock, (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("task_complete")!.run({ report: "done" });
        });
        const origStop = s.stop.bind(s);
        s.stop = () => {
          stopped = true;
          origStop();
        };
        return s;
      }),
    );

    expect(result.outcome).toBe("done");
    expect(stopped).toBe(true);
  });

  // The live self-editing checklist: one message posted on first use, then edited in place
  // (chat.update) on every subsequent call across the execution's turns — never a second post.
  test("checklist posts once, then updates the same message in place across turns", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);

    const posts: string[] = [];
    const updates: { messageId: string; text: string }[] = [];

    const params = baseParams(db, clock, (tools) =>
      new FakeAgentRuntimeSession(tools, async (n, t) => {
        if (n === 1) {
          await t.get("checklist")!.run({ items: [{ text: "clone", done: false }, { text: "build", done: false }] });
        } else if (n === 2) {
          await t.get("checklist")!.run({ items: [{ text: "clone", done: true }, { text: "build", done: false }] });
        } else {
          await t.get("checklist")!.run({ items: [{ text: "clone", done: true }, { text: "build", done: true }] });
          await t.get("task_complete")!.run({ report: "shipped" });
        }
      }),
    );
    const result = await runExecution({
      ...params,
      postMessage: async (_a, text) => {
        posts.push(text);
        return { messageId: "chk-msg" };
      },
      updateMessage: async (_v, messageId, text) => {
        updates.push({ messageId, text });
      },
    });

    expect(result.outcome).toBe("done");
    const checklistPosts = posts.filter((p) => p.includes("clone"));
    expect(checklistPosts).toHaveLength(1); // the checklist itself is posted exactly once
    expect(checklistPosts[0]).toBe("⬜️ clone\n⬜️ build");
    expect(updates).toHaveLength(2); // edited in place on turns 2 and 3
    expect(updates.every((u) => u.messageId === "chk-msg")).toBe(true);
    expect(updates[1]!.text).toBe("✅ clone\n✅ build");
  });
});

describe("budget enforcement mid-execution (SPEC §10.3)", () => {
  test("reaching per_task_cap yields to waiting(human) with a visible notice, not silently", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);
    recordTurn(db, clock, { id: "prior-turn", identityId: "eng", kind: "execution_step", executionId: "x1", status: "succeeded", effects: [], spendAmount: 12, startedAt: clock() });

    let turnsInvoked = 0;
    const params = baseParams(db, clock, (tools) => new FakeAgentRuntimeSession(tools, async () => {
      turnsInvoked++;
    }));
    const result = await runExecution({ ...params, perTaskCap: 10 });

    expect(result.outcome).toBe("yielded");
    expect(turnsInvoked).toBe(0); // never even started a turn once already over cap
    const task = getTask(db, "T-1")!;
    expect(task.status).toBe("waiting");
    expect(task.waitingOn).toBe("human");
  });

  test("no per_task_cap configured means no cap check runs", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);
    recordTurn(db, clock, { id: "prior-turn", identityId: "eng", kind: "execution_step", executionId: "x1", status: "succeeded", effects: [], spendAmount: 999, startedAt: clock() });

    const params = baseParams(db, clock, (tools) => new FakeAgentRuntimeSession(tools, async (_n, t) => {
      await t.get("task_complete")!.run({ report: "done" });
    }));
    const result = await runExecution(params);

    expect(result.outcome).toBe("done");
  });

  test("reaching the identity/global budget cap yields the task back to open (deferred, not lost)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);
    recordTurn(db, clock, { id: "prior-turn", identityId: "eng", kind: "execution_step", executionId: "x1", status: "succeeded", effects: [], spendAmount: 100, startedAt: clock() });

    let turnsInvoked = 0;
    const params = baseParams(db, clock, (tools) => new FakeAgentRuntimeSession(tools, async () => {
      turnsInvoked++;
    }));
    const result = await runExecution({
      ...params,
      budgetPolicy: { timezone: "UTC", identityMonthlyCap: 50, globalMonthlyCap: 1000, reserve: 0 },
    });

    expect(result.outcome).toBe("yielded");
    expect(turnsInvoked).toBe(0);
    const task = getTask(db, "T-1")!;
    expect(task.status).toBe("open"); // deferred — the scheduler will redispatch once budget frees up
  });

  test("headroom available lets the execution proceed normally", async () => {
    const db = freshDb();
    const clock = fakeClock();
    makeActiveTask(db, clock);

    const params = baseParams(db, clock, (tools) => new FakeAgentRuntimeSession(tools, async (_n, t) => {
      await t.get("task_complete")!.run({ report: "done" });
    }));
    const result = await runExecution({
      ...params,
      perTaskCap: 10,
      budgetPolicy: { timezone: "UTC", identityMonthlyCap: 50, globalMonthlyCap: 1000, reserve: 0 },
    });

    expect(result.outcome).toBe("done");
  });
});
