import { fakeClock } from "./helpers";
import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { getTurn } from "../src/ledger/turns";
import { runTurn } from "../src/turn-runner/turn";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";

function freshDb() {
  return openLedger(":memory:");
}

describe("runTurn (SPEC §4.1.6 turn envelope, §11)", () => {
  test("a normal turn records succeeded with its effects and spend", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const session = new FakeAgentRuntimeSession([], async () => {});

    const result = await runTurn({
      session,
      threadId: "thread-1",
      cwd: "/tmp",
      prompt: "hello",
      title: "t",
      db,
      clock,
      turnId: "turn-1",
      identityId: "eng",
      kind: "interactive",
      effects: [{ kind: "reply_posted" }],
      tokensUsed: () => 100,
      spendAmount: () => 0.02,
    });

    expect(result.status).toBe("succeeded");
    const turn = getTurn(db, "turn-1")!;
    expect(turn.status).toBe("succeeded");
    expect(turn.effects).toEqual([{ kind: "reply_posted" }]);
    expect(turn.spendAmount).toBe(0.02);
  });

  test("a turn whose runtime call rejects is recorded failed", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const session = new FakeAgentRuntimeSession([], async () => {
      throw new Error("codex crashed");
    });

    const result = await runTurn({
      session,
      threadId: "thread-1",
      cwd: "/tmp",
      prompt: "hello",
      title: "t",
      db,
      clock,
      turnId: "turn-1",
      identityId: "eng",
      kind: "execution_step",
      effects: [],
      tokensUsed: () => 0,
      spendAmount: () => 0,
    });

    expect(result.status).toBe("failed");
    expect(getTurn(db, "turn-1")?.status).toBe("failed");
  });

  test("interactive/ambient/distillation bounded by time envelope; breach → timed_out", async () => {
    const db = freshDb();
    const clock = fakeClock();
    let stopped = false;
    const session = new FakeAgentRuntimeSession([], async () => {
      await new Promise((resolve) => setTimeout(resolve, 100)); // longer than the 10ms envelope below
    });
    session.stop = () => {
      stopped = true;
    };

    const result = await runTurn({
      session,
      threadId: "thread-1",
      cwd: "/tmp",
      prompt: "hello",
      title: "t",
      db,
      clock,
      turnId: "turn-1",
      identityId: "eng",
      kind: "interactive",
      effects: [],
      tokensUsed: () => 0,
      spendAmount: () => 0,
      envelope: { timeoutMs: 10, tokenCeiling: 100_000 },
    });

    expect(result.status).toBe("timed_out");
    expect(stopped).toBe(true);
    expect(getTurn(db, "turn-1")?.status).toBe("timed_out");
  });

  test("token ceiling breach is envelope failure even if turn completed", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const session = new FakeAgentRuntimeSession([], async () => {});

    const result = await runTurn({
      session,
      threadId: "thread-1",
      cwd: "/tmp",
      prompt: "hello",
      title: "t",
      db,
      clock,
      turnId: "turn-1",
      identityId: "eng",
      kind: "ambient",
      effects: [],
      tokensUsed: () => 500_000,
      spendAmount: () => 1,
      envelope: { timeoutMs: 60_000, tokenCeiling: 100_000 },
    });

    expect(result.status).toBe("timed_out");
  });

  test("execution_step turns are NOT envelope-bounded (no timeoutMs/tokenCeiling passed)", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const session = new FakeAgentRuntimeSession([], async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    const result = await runTurn({
      session,
      threadId: "thread-1",
      cwd: "/tmp",
      prompt: "hello",
      title: "t",
      db,
      clock,
      turnId: "turn-1",
      identityId: "eng",
      kind: "execution_step",
      effects: [],
      tokensUsed: () => 999_999_999,
      spendAmount: () => 0,
    });

    expect(result.status).toBe("succeeded");
  });
});

describe("stall watchdog (SPEC §6.3: idle time, not total turn time)", () => {
  test("no activity for stallTimeoutMs kills the session and is recorded failed", async () => {
    const db = freshDb();
    const clock = fakeClock();
    let stopped = false;
    const session = new FakeAgentRuntimeSession([], async () => {
      await new Promise((resolve) => setTimeout(resolve, 200)); // sits idle the whole time
    });
    session.stop = () => {
      stopped = true;
    };

    const result = await runTurn({
      session,
      threadId: "thread-1",
      cwd: "/tmp",
      prompt: "hello",
      title: "t",
      db,
      clock,
      turnId: "turn-1",
      identityId: "eng",
      kind: "execution_step",
      effects: [],
      tokensUsed: () => 0,
      spendAmount: () => 0,
      stallTimeoutMs: 20,
    });

    expect(result.status).toBe("failed");
    expect(stopped).toBe(true);
    expect(getTurn(db, "turn-1")?.status).toBe("failed");
  });

  test("markActivity resets idle clock; long active turn is not killed", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const session = new FakeAgentRuntimeSession([], async (_turn, _tools, markActivity) => {
      // three 15ms slices with activity in between, well past a single 20ms stall window but
      // never idle for that long at a stretch.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        markActivity();
      }
    });

    const result = await runTurn({
      session,
      threadId: "thread-1",
      cwd: "/tmp",
      prompt: "hello",
      title: "t",
      db,
      clock,
      turnId: "turn-1",
      identityId: "eng",
      kind: "execution_step",
      effects: [],
      tokensUsed: () => 0,
      spendAmount: () => 0,
      stallTimeoutMs: 60,
    });

    expect(result.status).toBe("succeeded");
  });

  test("under envelope, silent runtime fails at stall bound (retryable), not timed_out", async () => {
    const db = freshDb();
    const clock = fakeClock();
    let stopped = false;
    const session = new FakeAgentRuntimeSession([], async () => {
      await new Promise((resolve) => setTimeout(resolve, 500)); // a blackholed gateway: no first token, no activity
    });
    session.stop = () => {
      stopped = true;
    };

    const started = Date.now();
    const result = await runTurn({
      session,
      threadId: "thread-1",
      cwd: "/tmp",
      prompt: "hello",
      title: "t",
      db,
      clock,
      turnId: "turn-1",
      identityId: "eng",
      kind: "resident",
      effects: [],
      tokensUsed: () => 0,
      spendAmount: () => 0,
      envelope: { timeoutMs: 5_000, tokenCeiling: 100_000 },
      stallTimeoutMs: 25,
    });

    expect(result.status).toBe("failed"); // failed retries; timed_out would not
    expect(result.cause).toContain("no runtime activity");
    expect(stopped).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000); // died at the stall bound, not the envelope
  });

  test("under envelope, activity keeps turn alive past stall window", async () => {
    const db = freshDb();
    const clock = fakeClock();
    const session = new FakeAgentRuntimeSession([], async (_turn, _tools, markActivity) => {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        markActivity();
      }
    });

    const result = await runTurn({
      session,
      threadId: "thread-1",
      cwd: "/tmp",
      prompt: "hello",
      title: "t",
      db,
      clock,
      turnId: "turn-1",
      identityId: "eng",
      kind: "resident",
      effects: [],
      tokensUsed: () => 0,
      spendAmount: () => 0,
      envelope: { timeoutMs: 5_000, tokenCeiling: 100_000 },
      stallTimeoutMs: 30,
    });

    expect(result.status).toBe("succeeded");
  });
});
