import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { createTask, transition, getTask } from "../src/ledger/tasks";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { AgentRuntimeSession, DynamicTool } from "../src/turn-runner/types";
import type { Clock } from "../src/ledger/clock";
import type { RawMessage } from "../src/adapter/types";

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock & { set: (iso: string) => void } {
  let now = start;
  const clock = (() => now) as Clock & { set: (iso: string) => void };
  clock.set = (iso: string) => {
    now = iso;
  };
  return clock;
}

const POLICY_YAML = `
surface:
  kind: slack
  credentials:
    bot_token: $BOT
operator_principals:
  - U_OPERATOR
executions:
  max_concurrent_per_identity: 2
  max_concurrent_global: 4
  max_turns: 5
identities:
  - id: eng
    venue_ids: [C1, C2]
    budget: { monthly_cap: 1000 }
budget:
  global_monthly_cap: 100000
`;

function makeStore() {
  return new PolicyStore(() => POLICY_YAML, {
    knownTools: new Set(),
    envAvailable: () => true,
  });
}

function makeService(overrides: Partial<ConstructorParameters<typeof Service>[0]> = {}) {
  const db = openLedger(":memory:");
  const clock = fakeClock();
  const adapter = new FakeAdapter();
  let n = 0;
  const service = new Service({
    db,
    clock,
    policyStore: makeStore(),
    adapter,
    botPrincipalId: "BOT1",
    cwd: "/tmp",
    newId: () => `id-${++n}`,
    // default: a session that just replies — overridden per test
    sessionFactory: (tools: DynamicTool[]): AgentRuntimeSession =>
      new FakeAgentRuntimeSession(tools, async (_turn, t) => {
        await t.get("reply")!.run({ text: "ack" });
      }),
    ...overrides,
  });
  return { db, clock, adapter, service };
}

function mention(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    venueId: "C1",
    venueKind: "channel",
    principalId: "U1",
    isBot: false,
    text: "<@BOT1> help",
    ts: `${Date.now()}.${Math.random().toString().slice(2, 8)}`,
    threadRootTs: null,
    mentionsBotId: true,
    ...overrides,
  };
}

describe("Service boot (SPEC §14.2 restart recovery on startup)", () => {
  test("an orphaned active task from a prior run is recovered to open on start, then dispatched+run on a tick", async () => {
    const { db, clock, service } = makeService({
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          await t.get("task_complete")!.run({ report: "resumed and finished" });
        }),
    });
    // Simulate a prior run that died mid-execution: a task left 'active' with a running execution.
    db.query("INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e0', 'k0', 'addressed_message', 'eng', ?)").run(clock());
    createTask(db, clock, { id: "T-1", identityId: "eng", title: "t", spec: "s", sponsorId: "U1", homeAnchor: { venueId: "C1", threadRootId: null }, originEventId: "e0" });
    transition(db, clock, "T-1", "active", { type: "dispatch", executionId: "x0" });

    await service.start();
    expect(getTask(db, "T-1")?.status).toBe("open"); // recovered

    await service.tick();
    await service.idle();
    expect(getTask(db, "T-1")?.status).toBe("done");

    await service.stop();
  });
});

describe("Service inbound (SPEC §5, §17.1)", () => {
  test("an addressed mention runs an interactive turn and posts its reply", async () => {
    const { adapter, service } = makeService();
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> what's our SLA?" }));
    await service.idle();

    // The reply is delivered via native Slack streaming — one stream, closed, rendering the reply.
    expect(adapter.streams).toHaveLength(1);
    expect(adapter.streams[0]!.stopped).toBe(true);
    expect(adapter.lastStreamText()).toBe("ack");
    await service.stop();
  });

  // §5.3 silence-is-an-outcome: in-flight token deltas belong to a message the model never
  // finished sending. They are a draft, not a reply — the harness must not leak them.
  test("token deltas that never complete into a message are not posted (no leaked drafts)", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock();
    const adapter = new FakeAdapter();
    let n = 0;
    const service = new Service({
      db,
      clock,
      policyStore: makeStore(),
      adapter,
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      // a session that emits growing token deltas via onEvent but no completed message/reply.
      sessionFactory: (tools, onEvent) =>
        new FakeAgentRuntimeSession(tools, async () => {
          onEvent?.({ stream: "Hel" });
          onEvent?.({ stream: "Hello, wor" });
          onEvent?.({ stream: "Hello, world!" });
        }),
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> hi", ts: "111.222" }));
    await service.idle();

    expect(adapter.streams).toHaveLength(0);
    expect(adapter.posts).toHaveLength(0);
    await service.stop();
  });

  test("an observed (non-addressed) message triggers no turn", async () => {
    const { adapter, service } = makeService();
    await service.start();

    adapter.emit(mention({ text: "just chatting", mentionsBotId: false }));
    await service.idle();

    expect(adapter.posts).toHaveLength(0);
    await service.stop();
  });

  test("the agent's own message is ignored entirely", async () => {
    const { adapter, service } = makeService();
    await service.start();

    adapter.emit(mention({ isBot: true, principalId: "BOT1", text: "<@BOT1> loop?" }));
    await service.idle();

    expect(adapter.posts).toHaveLength(0);
    await service.stop();
  });

  // §6.1 every turn owes a visible reply — and a reaction IS one. A turn whose whole response was
  // an emoji must not get a canned text line stacked on top ("i did it" → 👍 + "On it." was absurd).
  test("a react-only interactive turn posts no text — the reaction is the reply", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          await t.get("react")!.run({ emoji: "thumbsup" });
        }),
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> i did it", ts: "500.100" }));
    await service.idle();

    expect(adapter.reactions).toEqual([{ venueId: "C1", messageId: "500.100", emoji: "thumbsup" }]);
    expect(adapter.streams).toHaveLength(0); // no stream ever opens — nothing was said, nothing owed
    expect(adapter.posts).toHaveLength(0);
    await service.stop();
  });

  // The "is thinking…" shimmer promises a message. The moment a reaction lands with nothing said,
  // the reaction IS the response — the shimmer must clear right then, not at turn end.
  test("a reaction with nothing said clears the typing shimmer immediately", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock();
    const adapter = new FakeAdapter();
    let n = 0;
    const service = new Service({
      db,
      clock,
      policyStore: makeStore(),
      adapter,
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          expect(adapter.statuses.at(-1)?.status).not.toBe(""); // shimmer is up while working
          await t.get("react")!.run({ emoji: "thumbsup" });
          expect(adapter.statuses.at(-1)?.status).toBe(""); // cleared at react time, turn still running
        }),
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> i did it" }));
    await service.idle();

    expect(adapter.streams).toHaveLength(0);
    await service.stop();
  });

  // §5.3 `pass`: a succeeded turn that said nothing and reacted to nothing chose silence, and the
  // harness never speaks on the model's behalf — no fallback line, no canned "came back empty".
  test("a succeeded turn that says and does nothing posts nothing — silence is the model's outcome", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools) => new FakeAgentRuntimeSession(tools, async () => {}),
    });
    await service.start();

    adapter.emit(mention());
    await service.idle();

    expect(adapter.streams).toHaveLength(0);
    expect(adapter.posts).toHaveLength(0);
    expect(adapter.statuses.at(-1)?.status).toBe(""); // the shimmer still clears — no eternal "thinking…"
    await service.stop();
  });

  // §5.3 explicit effects: the one debt silence can't settle. The receipt comes from a re-prompted
  // MODEL turn, never from a harness line.
  test("a task_create with no visible receipt gets one re-prompt; the receipt is model-authored", async () => {
    let interactiveTurns = 0;
    let sessionCount = 0;
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const isExecution = sessionCount++ > 0; // 1st session = interactive turn, later = execution
        return new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          if (isExecution) {
            await t.get("task_complete")!.run({ report: "done" });
            return;
          }
          interactiveTurns++;
          if (interactiveTurns === 1) {
            await t.get("task_create")!.run({ title: "dig", spec: "dig into the export bug" }); // silent mutation
          } else {
            await t.get("reply")!.run({ text: "taking the export dig, updates here" }); // the re-prompted receipt
          }
        });
      },
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> dig into the export bug", ts: "700.0" }));
    await service.idle();

    expect(interactiveTurns).toBe(2); // exactly one re-prompt
    expect(adapter.streams[0]!.text).toContain("taking the export dig");
    await service.stop();
  });
});

describe("Service dispatch driver (SPEC §6.2, §17.3, §17.4)", () => {
  test("a delegated mention creates a task and drives it to a terminal report — dispatch is event-driven, no manual tick needed (M9)", async () => {
    const { db, adapter, service } = makeService({
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          // interactive turn (no open task yet) creates one; execution_step turn completes it.
          const view = JSON.parse((await t.get("task_query")!.run({})).output);
          if (view.open.length === 0) {
            await t.get("task_create")!.run({ title: "dig in", spec: "why slow" });
            return;
          }
          await t.get("task_complete")!.run({ report: "found it: N+1 query" });
        }),
    });
    await service.start();

    // One inbound mention: the interactive turn creates the task, its completion triggers a tick
    // that dispatches it, and the execution runs to a terminal report — all awaited by one idle().
    adapter.emit(mention({ text: "<@BOT1> why is the dashboard slow, dig in" }));
    await service.idle();

    expect(getTask(db, "T-1")?.status).toBe("done");
    expect(getTask(db, "T-1")?.terminalReport).toBe("found it: N+1 query");

    await service.stop();
  });

  test("dispatch respects the per-identity concurrency cap across ticks", async () => {
    // Two open tasks, cap of 2 → both dispatch; a third stays open until a slot frees.
    const { db, clock, service } = makeService({
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          await new Promise((r) => setTimeout(r, 15)); // hold the slot briefly
          await t.get("task_complete")!.run({ report: "done" });
        }),
    });
    for (const id of ["T-1", "T-2", "T-3"]) {
      db.query("INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES (?, ?, 'addressed_message', 'eng', ?)").run(`${id}-e`, `${id}-k`, clock());
      createTask(db, clock, { id, identityId: "eng", title: id, spec: "s", sponsorId: "U1", homeAnchor: { venueId: "C1", threadRootId: null }, originEventId: `${id}-e` });
    }
    await service.start();

    await service.tick();
    // At most 2 running immediately after the tick (cap=2).
    const runningNow = db.query("SELECT COUNT(*) as c FROM executions WHERE status = 'running'").get() as { c: number };
    expect(runningNow.c).toBe(2);

    await service.idle();
    await service.tick(); // third dispatches now that slots freed
    await service.idle();

    for (const id of ["T-1", "T-2", "T-3"]) expect(getTask(db, id)?.status).toBe("done");
    await service.stop();
  });
});

describe("Service graceful shutdown", () => {
  test("stop() awaits in-flight work and closes the db", async () => {
    const { db, clock, service } = makeService({
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          await new Promise((r) => setTimeout(r, 20));
          await t.get("task_complete")!.run({ report: "finished during drain" });
        }),
    });
    db.query("INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e1', 'k1', 'addressed_message', 'eng', ?)").run(clock());
    createTask(db, clock, { id: "T-1", identityId: "eng", title: "t", spec: "s", sponsorId: "U1", homeAnchor: { venueId: "C1", threadRootId: null }, originEventId: "e1" });
    await service.start();
    await service.tick(); // launches the execution

    await service.stop(); // must await the in-flight execution before returning
    expect(getTask(db, "T-1")?.status).toBe("done");
  });
});

describe("Service distillation (SPEC §8.2)", () => {
  test("on its cadence, sweeps observed messages into memory via a distillation turn", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T00:00:00Z");
    const adapter = new FakeAdapter();
    let n = 0;
    const service = new Service({
      db,
      clock,
      policyStore: makeStore(),
      adapter,
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      // the distillation turn writes a memory item from what it observed.
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          await t.get("memory_write")!.run({ content: "distilled: the eng team uses Bun" });
        }),
    });
    await service.start();

    // an observed (non-addressed) channel message accumulates for distillation
    adapter.emit({ venueId: "C1", venueKind: "channel", principalId: "U1", isBot: false, text: "we use Bun here", ts: "1.0", threadRootTs: null, mentionsBotId: false });
    await service.idle();

    // advance past the (default 24h) distillation cadence → the tick fires the distillation turn
    clock.set("2026-07-03T12:00:00Z");
    await service.tick();
    await service.idle();

    const { queryMemory } = await import("../src/ledger/memory");
    expect(queryMemory(db, "eng").some((m) => m.content.includes("Bun"))).toBe(true);
    await service.stop();
  });
});

describe("Service native reply streaming (SPEC §5.2)", () => {
  test("tool cards before the first text are NOT rendered — no cards-only notification", async () => {
    const { adapter, service } = makeService({
      // codex runs a tool (⚙), then answers (●) — like a real "search the channel" turn
      sessionFactory: (tools, onEvent) =>
        new FakeAgentRuntimeSession(tools, async () => {
          onEvent?.({ log: "⚙ read_channel" });
          onEvent?.({ log: "● here's what I found" });
        }),
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> search it", ts: "7.0" }));
    await service.idle();

    // pre-text work is covered by the typing shimmer; the message opens with content, not a todo
    expect(adapter.taskCards).toHaveLength(0);
    expect(adapter.lastStreamText()).toBe("here's what I found");
    await service.stop();
  });

  test("the thinking shimmer (setStatus) shows on the conversation thread immediately and clears after", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "done" });
        }),
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> think about it", ts: "6.0", threadRootTs: null }));
    await service.idle();

    expect(adapter.statuses[0]).toEqual({ venueId: "C1", threadRootTs: "6.0", status: "is thinking…" });
    expect(adapter.statuses.at(-1)!.status).toBe(""); // cleared when the turn ends
    await service.stop();
  });

  test("everything he says streams in order as paragraphs — no message is demoted or dropped", async () => {
    const { adapter, service } = makeService({
      // codex narrates ("Let me dig into that…"), runs a tool, then answers — two agent messages
      sessionFactory: (tools, onEvent) =>
        new FakeAgentRuntimeSession(tools, async () => {
          onEvent?.({ log: "● Let me dig into that…" });
          onEvent?.({ log: "⚙ read_channel" });
          onEvent?.({ log: "● the export bug is a cluster, not a one-off" });
        }),
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> investigate", ts: "9.0" }));
    await service.idle();

    // both messages show, in order, as paragraphs of ONE streamed message; tool calls show nothing
    expect(adapter.lastStreamText()).toBe("Let me dig into that…\n\nthe export bug is a cluster, not a one-off");
    expect(adapter.taskCards).toHaveLength(0);
    await service.stop();
  });

  // Progress cards are the MODEL'S plan (checklist tool: high-level goals), never tool machinery.
  // The plan may open the stream (an interactive turn always ends with text in the same message),
  // and items the model leaves pending settle complete at turn end (no error render).
  test("the checklist renders as plan cards on the reply stream; unfinished items settle at turn end", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools, onEvent) =>
        new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("checklist")!.run({ items: [{ text: "figure out if this alert is already tracked", done: false }, { text: "write up the verdict", done: false }] });
          onEvent?.({ log: "⚙ linear_graphql" }); // machinery — must not become a card
          await t.get("checklist")!.run({ items: [{ text: "figure out if this alert is already tracked", done: true }, { text: "write up the verdict", done: false }] });
          onEvent?.({ log: "● already tracked: BEV-1 covers it" });
        }),
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> is this alert known?", ts: "11.0" }));
    await service.idle();

    const stream = adapter.streams[0]!;
    const cards = adapter.taskCards.filter((c) => c.messageId === stream.messageId);
    // plan items only (item-0/item-1), goal-level titles, and the final settle completes item-1
    expect(new Set(cards.map((c) => c.id))).toEqual(new Set(["item-0", "item-1"]));
    expect(cards.some((c) => c.title.includes("linear"))).toBe(false);
    expect(cards.at(-1)!).toMatchObject({ id: "item-1", status: "complete" });
    expect(adapter.lastStreamText()).toContain("already tracked");
    await service.stop();
  });

  test("a duplicate message (reply tool + identical final message) streams only once", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools, onEvent) =>
        new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "the answer is 10" });
          onEvent?.({ log: "● the answer is 10" }); // codex often repeats the reply as its final message
        }),
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> q", ts: "10.0" }));
    await service.idle();

    expect(adapter.lastStreamText()).toBe("the answer is 10");
    await service.stop();
  });

  test("if the stream can't start, the reply is still delivered as a plain post (no dangling threads)", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "the answer" });
        }),
    });
    adapter.failStreams = true;
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> q", ts: "8.0" }));
    await service.idle();

    expect(adapter.streams).toHaveLength(0);
    expect(adapter.posts.map((p) => p.text)).toContain("the answer"); // delivered anyway
    await service.stop();
  });

  test("a top-level mention streams the reply into a fresh thread under the mention's ts", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "here's your answer" });
        }),
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> question", ts: "42.0", principalId: "U_ASKER", threadRootTs: null }));
    await service.idle();

    expect(adapter.streams).toHaveLength(1);
    const s = adapter.streams[0]!;
    expect(s.threadTs).toBe("42.0"); // streams into a thread rooted at the mention (streaming needs a thread)
    expect(s.recipient).toBe("U_ASKER"); // recipient_user_id = whoever addressed us
    expect(s.text).toBe("here's your answer");
    expect(s.stopped).toBe(true);
    await service.stop();
  });
});

describe("Service interactive context injection (smart across threads)", () => {
  test("a fresh conversation opens with memory, ledger, other-thread digest, and speaker context", async () => {
    const sessions: FakeAgentRuntimeSession[] = [];
    const { db, clock, adapter, service } = makeService({
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "ok" });
        });
        sessions.push(s);
        return s;
      },
    });
    const { writeMemory } = await import("../src/ledger/memory");
    writeMemory(db, clock, { id: "m1", identityId: "eng", content: "the staging deploy takes 8 minutes" });
    await service.start();

    // first conversation (thread A), then a FRESH one (thread B) — B's opening prompt must know about A
    adapter.emit(mention({ text: "<@BOT1> the export bug is back", ts: "1.0", threadRootTs: "A" }));
    await service.idle();
    adapter.emit(mention({ text: "<@BOT1> hello again", ts: "2.0", threadRootTs: "B", principalId: "U_NOAH" }));
    await service.idle();

    const opening = sessions[1]!.prompts[0]!;
    expect(opening).toContain("the staging deploy takes 8 minutes"); // durable memory
    expect(opening).toContain("<@U_NOAH>"); // who's speaking
    expect(opening).toContain("the export bug is back"); // other-conversation digest
    expect(opening).toContain("memory_write"); // instant-memory instruction
    await service.stop();
  });

  test("a resumed conversation does NOT re-inject the context block", async () => {
    const sessions: FakeAgentRuntimeSession[] = [];
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "ok" });
        });
        sessions.push(s);
        return s;
      },
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> hi", ts: "1.0", threadRootTs: "A" }));
    await service.idle();
    adapter.emit(mention({ text: "<@BOT1> and also", ts: "2.0", threadRootTs: "A" }));
    await service.idle();

    expect(sessions[0]!.prompts[0]!).toContain("Your durable memory"); // fresh → context
    expect(sessions[1]!.prompts[0]!).not.toContain("Your durable memory"); // resumed → already has it
    await service.stop();
  });

  test("the react tool adds an emoji reaction to the triggering message", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_n, t) => {
          const result = await t.get("react")!.run({ emoji: "white_check_mark" });
          if (!(result as { success: boolean }).success) throw new Error("react failed");
        }),
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> if u see this please emoji it", ts: "3.5" }));
    await service.idle();

    expect(adapter.reactions).toContainEqual({ venueId: "C1", messageId: "3.5", emoji: "white_check_mark" });
    await service.stop();
  });
});

describe("Service interactive continuity (SPEC §5)", () => {
  test("a second message in the same conversation thread resumes its codex thread, not a fresh one", async () => {
    const sessions: FakeAgentRuntimeSession[] = [];
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "ok" });
        });
        sessions.push(s);
        return s;
      },
    });
    await service.start();

    // two messages in the SAME Slack thread → same conversation thread → two turns, one codex thread
    adapter.emit(mention({ text: "<@BOT1> hi", ts: "1.0", threadRootTs: "conv-1" }));
    await service.idle();
    adapter.emit(mention({ text: "<@BOT1> still there?", ts: "2.0", threadRootTs: "conv-1" }));
    await service.idle();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.lastThreadOp).toEqual({ op: "start", id: "thread-1" }); // first turn: cold start
    expect(sessions[1]!.lastThreadOp).toEqual({ op: "resume", id: "thread-1" }); // second turn: RESUMES it
    await service.stop();
  });

  test("a different anchor gets its own fresh thread (continuity is per-anchor)", async () => {
    const sessions: FakeAgentRuntimeSession[] = [];
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "ok" });
        });
        sessions.push(s);
        return s;
      },
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> hi", ts: "1.0", threadRootTs: null }));
    await service.idle();
    // a message inside a DISTINCT Slack thread → anchor (C1, "9.9") → no prior thread to resume
    adapter.emit(mention({ text: "<@BOT1> over here", ts: "9.91", threadRootTs: "9.9" }));
    await service.idle();

    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.lastThreadOp).toEqual({ op: "start", id: "thread-1" });
    await service.stop();
  });
});

describe("Service soul doc (workspace AGENTS.md)", () => {
  test("start() writes the composed soul + persona to <cwd>/AGENTS.md", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SOUL } = await import("../src/turn-runner/soul");
    const cwd = mkdtempSync(join(tmpdir(), "earshot-soul-"));

    const db = openLedger(":memory:");
    let n = 0;
    const service = new Service({
      db,
      clock: fakeClock(),
      // policy YAML sets identity `eng` with a persona line
      policyStore: new PolicyStore(
        () => POLICY_YAML.replace("    venue_ids: [C1, C2]", "    persona: \"You are the crew's eng sidekick.\"\n    venue_ids: [C1, C2]"),
        { knownTools: new Set(), envAvailable: () => true },
      ),
      adapter: new FakeAdapter(),
      botPrincipalId: "BOT1",
      cwd,
      newId: () => `id-${++n}`,
      sessionFactory: (tools) => new FakeAgentRuntimeSession(tools, async () => {}),
    });
    await service.start();

    const written = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(written).toContain(SOUL);
    expect(written).toContain("You are the crew's eng sidekick.");
    await service.stop();
  });
});

describe("Service ambient / proactive mode (SPEC §9.2)", () => {
  const AMBIENT_YAML = `
surface:
  kind: slack
  credentials:
    bot_token: $BOT
operator_principals:
  - U_OPERATOR
executions:
  max_concurrent_per_identity: 2
  max_concurrent_global: 4
  max_turns: 5
identities:
  - id: eng
    venue_ids: [C1, C2]
    budget: { monthly_cap: 1000 }
    ambient:
      enabled_venues: [C1]
      tick_interval_ms: 1800000
      daily_post_cap: 5
budget:
  global_monthly_cap: 100000
`;
  function ambientStore() {
    return new PolicyStore(() => AMBIENT_YAML, { knownTools: new Set(), envAvailable: () => true });
  }

  test("on its tick, runs a speak-only turn that may post proactively into an enabled venue", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T00:00:00Z");
    const adapter = new FakeAdapter();
    let n = 0;
    const service = new Service({
      db,
      clock,
      policyStore: ambientStore(),
      adapter,
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      // the ambient turn decides to surface something proactively into the enabled venue
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          await t.get("reply")!.run({ venueId: "C1", text: "heads up: the staging deploy has been red for 2h" });
        }),
    });
    await service.start();

    // advance past the ambient tick interval → the scheduled ambient_tick fires the turn
    clock.set("2026-07-02T00:31:00Z");
    await service.tick();
    await service.idle();

    expect(adapter.posts.some((p) => p.venueId === "C1" && p.text.includes("staging deploy"))).toBe(true);
    await service.stop();
  });

  // Ambient continuity: same-day sweeps resume ONE codex thread (working state carries); the
  // thread rotates on the budget-timezone day boundary so context can't grow unbounded.
  test("same-day ambient sweeps resume one thread; a new day starts fresh", async () => {
    const sessions: FakeAgentRuntimeSession[] = [];
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T10:00:00Z");
    let n = 0;
    const service = new Service({
      db,
      clock,
      policyStore: ambientStore(),
      adapter: new FakeAdapter(),
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async () => {});
        sessions.push(s);
        return s;
      },
    });

    service.ambientNow("eng");
    await service.idle();
    clock.set("2026-07-02T14:00:00Z"); // later the same day
    service.ambientNow("eng");
    await service.idle();
    clock.set("2026-07-03T10:00:00Z"); // next day
    service.ambientNow("eng");
    await service.idle();

    expect(sessions[0]!.lastThreadOp!.op).toBe("start");
    expect(sessions[1]!.lastThreadOp!.op).toBe("resume"); // same day → same thread
    expect(sessions[1]!.lastThreadOp!.id).toBe(sessions[0]!.lastThreadOp!.id);
    expect(sessions[2]!.lastThreadOp!.op).toBe("start"); // day rolled → rotate
    expect(sessions[1]!.prompts[0]!).toContain("Continuing today's ambient thread");
    expect(sessions[2]!.prompts[0]!).not.toContain("Continuing today's ambient thread");
  });

  test("an ambient turn may NOT post to a venue that is not ambient-enabled", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T00:00:00Z");
    const adapter = new FakeAdapter();
    let n = 0;
    const service = new Service({
      db,
      clock,
      policyStore: ambientStore(),
      adapter,
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      // tries to post to C2, which is NOT ambient-enabled → the broker/scope gate blocks it
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          await t.get("reply")!.run({ venueId: "C2", text: "should never appear" });
        }),
    });
    await service.start();

    service.ambientNow("eng");
    await service.idle();

    expect(adapter.posts.some((p) => p.venueId === "C2")).toBe(false);
    await service.stop();
  });
});

describe("Service execution stream (one delightful message)", () => {
  test("checklist renders as native task cards and the report appends — all in ONE streamed message", async () => {
    let sessionCount = 0;
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const isExecution = sessionCount++ > 0; // 1st session = interactive turn, 2nd = the execution
        return new FakeAgentRuntimeSession(tools, async (_n, t) => {
          if (isExecution) {
            // execution turn: plan → work → say the outcome with reply → complete (the report is
            // a ledger record only, never posted)
            await t.get("checklist")!.run({ items: [{ text: "dig through history", done: false }, { text: "report back", done: false }] });
            await t.get("checklist")!.run({ items: [{ text: "dig through history", done: true }, { text: "report back", done: true }] });
            await t.get("reply")!.run({ text: "the export bug is one root cause, fix is BEV-1" });
            await t.get("task_complete")!.run({ report: "root cause found; fix tracked in BEV-1" });
          } else {
            // interactive turn: acknowledge + delegate
            await t.get("task_create")!.run({ title: "dig", spec: "dig through history" });
            await t.get("reply")!.run({ text: "on it" });
          }
        });
      },
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> dig through the history", ts: "1.0", principalId: "U_NOAH" }));
    await service.idle(); // interactive turn + immediate dispatch + execution, all drained

    // two streams: the interactive reply, and the execution's own message
    expect(adapter.streams).toHaveLength(2);
    const exec = adapter.streams[1]!;
    expect(exec.threadTs).toBe("1.0"); // execution streams into the conversation thread
    expect(exec.recipient).toBe("U_NOAH"); // sponsor
    // checklist cards BUFFER until the first text (the report) materializes the message — then
    // flush in their final state. No cards-only notification ever exists.
    const cards = adapter.taskCards.filter((c) => c.messageId === exec.messageId);
    expect(cards.map((c) => `${c.title}:${c.status}`)).toEqual([
      "dig through history:complete",
      "report back:complete",
    ]);
    // the terminal report appended to the SAME message; no separate posts anywhere
    expect(exec.text).toContain("the export bug is one root cause");
    expect(adapter.posts.filter((p) => p.text.includes("⬜️") || p.text.includes("✅"))).toHaveLength(0);
    expect(exec.stopped).toBe(true);
    await service.stop();
  });

  // A silent check turn (checklist + set_wake, nothing to say) must not create ANY message —
  // a cards-only streamed message is a wasted notification. And the execution prompt must ASK for
  // that silence: set_wake is a scheduled next check, not an occasion for a no-update status post.
  test("a silent yielded execution creates no streamed message at all, and the prompt says yields are silent by default", async () => {
    let sessionCount = 0;
    const sessions: FakeAgentRuntimeSession[] = [];
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const isExecution = sessionCount++ > 0;
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          if (isExecution) {
            await t.get("checklist")!.run({ items: [{ text: "check the ticket", done: true }, { text: "report when it moves", done: false }] });
            await t.get("set_wake")!.run({ wakeAt: "2027-01-01T00:00:00Z", note: "watching" });
          } else {
            await t.get("task_create")!.run({ title: "watch", spec: "watch the ticket" });
            await t.get("reply")!.run({ text: "on it" });
          }
        });
        sessions.push(s);
        return s;
      },
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> watch the ticket", ts: "1.0", principalId: "U_NOAH" }));
    await service.idle();

    expect(adapter.streams).toHaveLength(1); // the interactive reply only — no execution message
    expect(adapter.taskCards).toHaveLength(0);
    expect(adapter.posts.filter((p) => p.text.includes("⬜️") || p.text.includes("✅"))).toHaveLength(0); // no emoji fallback either

    const execPrompt = sessions[1]!.prompts[0]!;
    expect(execPrompt).toContain("set_wake merely schedules your next check and is SILENT by default");
    expect(execPrompt).toContain("never re-announce it");
    expect(execPrompt).not.toContain("must never end silently"); // the old blanket order that produced no-update status dumps
    await service.stop();
  });

  // A yield (set_wake) is not a failure: Slack paints pending cards on a stopped stream as an
  // error plan ("Something went wrong"), so unfinished items must settle before the close.
  test("a yielded execution that DID speak settles unfinished checklist cards as deferred-complete", async () => {
    let sessionCount = 0;
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const isExecution = sessionCount++ > 0;
        return new FakeAgentRuntimeSession(tools, async (_n, t) => {
          if (isExecution) {
            await t.get("reply")!.run({ text: "pr attached, watching for the merge" }); // text materializes the message
            await t.get("checklist")!.run({ items: [{ text: "check the ticket", done: true }, { text: "report when it moves", done: false }] });
            await t.get("set_wake")!.run({ wakeAt: "2027-01-01T00:00:00Z", note: "watching" });
          } else {
            await t.get("task_create")!.run({ title: "watch", spec: "watch the ticket" });
            await t.get("reply")!.run({ text: "on it" });
          }
        });
      },
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> watch the ticket", ts: "1.0", principalId: "U_NOAH" }));
    await service.idle();

    const exec = adapter.streams[1]!;
    expect(exec.stopped).toBe(true);
    expect(exec.text).toContain("pr attached");
    const last = adapter.taskCards.filter((c) => c.messageId === exec.messageId).at(-1)!;
    expect(last.id).toBe("item-1");
    expect(last.status).toBe("complete"); // settled, not left pending → no error render
    expect(last.title).toContain("resumes on next check");
    await service.stop();
  });

  test("a terminal report is NOT re-posted when the same turn already delivered content to the home anchor", async () => {
    let sessionCount = 0;
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const isExecution = sessionCount++ > 0;
        return new FakeAgentRuntimeSession(tools, async (_n, t) => {
          if (isExecution) {
            // the common codex pattern: deliver findings via reply, then complete with meta-narration
            await t.get("reply")!.run({ text: "top 3 actionable: 1) fix exports 2) perf 3) file tickets" });
            await t.get("task_complete")!.run({ report: "Done — posted the 3-item actionable summary in the channel." });
          } else {
            await t.get("task_create")!.run({ title: "dig", spec: "dig" });
            await t.get("reply")!.run({ text: "on it" });
          }
        });
      },
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> dig", ts: "1.0", principalId: "U_NOAH" }));
    await service.idle();

    const exec = adapter.streams[1]!;
    expect(exec.text).toContain("top 3 actionable"); // the findings landed
    expect(exec.text).not.toContain("Done — posted"); // the meta-narration report did NOT re-post
    await service.stop();
  });

  test("a bare 'Done.' after a real reply is dropped as babble", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools, onEvent) =>
        new FakeAgentRuntimeSession(tools, async () => {
          onEvent?.({ log: "● On it. I'll dig through the history." });
          onEvent?.({ log: "● Done." });
        }),
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> go", ts: "2.0" }));
    await service.idle();

    expect(adapter.lastStreamText()).toBe("On it. I'll dig through the history.");
    await service.stop();
  });
});

describe("Service event-driven ambient (proactive engagement)", () => {
  const REACTIVE_YAML = `
surface:
  kind: slack
  credentials:
    bot_token: $BOT
operator_principals:
  - U_OPERATOR
executions:
  max_concurrent_per_identity: 2
  max_concurrent_global: 4
  max_turns: 5
identities:
  - id: eng
    venue_ids: ["*"]
    budget: { monthly_cap: 1000 }
    ambient:
      enabled_venues: ["*"]
      event_debounce_ms: 20
      daily_post_cap: 5
budget:
  global_monthly_cap: 100000
`;
  function reactiveService(sessionFactory: ConstructorParameters<typeof Service>[0]["sessionFactory"]) {
    const db = openLedger(":memory:");
    const adapter = new FakeAdapter();
    let n = 0;
    const service = new Service({
      db,
      clock: fakeClock(),
      policyStore: new PolicyStore(() => REACTIVE_YAML, { knownTools: new Set(), envAvailable: () => true }),
      adapter,
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      sessionFactory,
    });
    return { adapter, service };
  }

  test("an overheard message arms a debounce; after quiet, an ambient turn may engage proactively", async () => {
    const { adapter, service } = reactiveService((tools) =>
      new FakeAgentRuntimeSession(tools, async (_n, t) => {
        await t.get("reply")!.run({ venueId: "C1", text: "that doc mentions the export bug — I have context, want a summary?" });
      }),
    );
    await service.start();

    // NOT addressed — just overheard chatter (someone shares a doc with the team)
    adapter.emit(mention({ text: "team, here's the Q3 planning doc", ts: "1.0", mentionsBotId: false }));
    await new Promise((r) => setTimeout(r, 60)); // debounce (20ms) elapses
    await service.idle();

    expect(adapter.posts.some((p) => p.venueId === "C1" && p.text.includes("export bug"))).toBe(true);
    await service.stop();
  });

  test("a BOT message does not arm the debounce (firehose protection)", async () => {
    let turns = 0;
    const { adapter, service } = reactiveService((tools) => new FakeAgentRuntimeSession(tools, async () => { turns++; }));
    await service.start();

    adapter.emit(mention({ isBot: true, principalId: "B_ALERTS", text: "prod run failed: thumbnail-refresh", ts: "1.0", mentionsBotId: false }));
    await new Promise((r) => setTimeout(r, 60));
    await service.idle();

    expect(turns).toBe(0);
    await service.stop();
  });

  // §9.5: a standing venue instruction opts the venue into event-driven ambient for bot messages,
  // and the instruction rides into the ambient prompt.
  test("a bot message in a venue with a standing instruction arms the debounce, and the prompt carries the instruction", async () => {
    const yaml = REACTIVE_YAML.replace(
      "    ambient:",
      `    venue_instructions:
      C1: "front-run Noah on prod alerts: dedupe repeats, flag what matters"
    ambient:`,
    );
    const db = openLedger(":memory:");
    const adapter = new FakeAdapter();
    let n = 0;
    const sessions: FakeAgentRuntimeSession[] = [];
    const service = new Service({
      db,
      clock: fakeClock(),
      policyStore: new PolicyStore(() => yaml, { knownTools: new Set(), envAvailable: () => true }),
      adapter,
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async () => {});
        sessions.push(s);
        return s;
      },
    });
    await service.start();

    adapter.emit(mention({ isBot: true, principalId: "B_ALERTS", text: "prod run failed: thumbnail-refresh", ts: "1.0", mentionsBotId: false }));
    await new Promise((r) => setTimeout(r, 60));
    await service.idle();

    expect(sessions.length).toBe(1);
    expect(sessions[0]!.prompts[0]!).toContain("front-run Noah on prod alerts");
    await service.stop();
  });

  test("a burst of messages collapses to ONE ambient turn (debounce resets)", async () => {
    let turns = 0;
    const { adapter, service } = reactiveService((tools) =>
      new FakeAgentRuntimeSession(tools, async () => {
        turns++;
      }),
    );
    await service.start();

    adapter.emit(mention({ text: "one", ts: "1.0", mentionsBotId: false }));
    adapter.emit(mention({ text: "two", ts: "1.1", mentionsBotId: false }));
    adapter.emit(mention({ text: "three", ts: "1.2", mentionsBotId: false }));
    await new Promise((r) => setTimeout(r, 80));
    await service.idle();

    expect(turns).toBe(1);
    await service.stop();
  });
});

describe("Service policy reload (SPEC §16.2)", () => {
  test("reloadPolicy swaps the live policy when the source changes", () => {
    let yaml = POLICY_YAML;
    const db = openLedger(":memory:");
    const store = new PolicyStore(() => yaml, { knownTools: new Set(), envAvailable: () => true });
    let n = 0;
    const service = new Service({
      db,
      clock: fakeClock(),
      policyStore: store,
      adapter: new FakeAdapter(),
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      sessionFactory: (tools) => new FakeAgentRuntimeSession(tools, async () => {}),
    });

    expect(service.policy().budget.globalMonthlyCap).toBe(100000);
    yaml = POLICY_YAML.replace("global_monthly_cap: 100000", "global_monthly_cap: 250000");
    const ok = service.reloadPolicy();
    expect(ok).toBe(true);
    expect(service.policy().budget.globalMonthlyCap).toBe(250000);
  });

  test("an invalid reload keeps the last-known-good policy", () => {
    let yaml = POLICY_YAML;
    const db = openLedger(":memory:");
    const store = new PolicyStore(() => yaml, { knownTools: new Set(), envAvailable: () => true });
    let n = 0;
    const service = new Service({
      db,
      clock: fakeClock(),
      policyStore: store,
      adapter: new FakeAdapter(),
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      sessionFactory: (tools) => new FakeAgentRuntimeSession(tools, async () => {}),
    });

    yaml = "not: valid: yaml: [";
    expect(service.reloadPolicy()).toBe(false);
    expect(service.policy().budget.globalMonthlyCap).toBe(100000); // unchanged
  });
});

describe("Service vision: attached images reach the turn input", () => {
  test("an image on the triggering message downloads to the workspace and rides the turn as a local path", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "earshot-vision-"));
    const sessions: FakeAgentRuntimeSession[] = [];
    const { adapter, service } = makeService({
      cwd,
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "red button, got it" });
        });
        sessions.push(s);
        return s;
      },
    });
    adapter.fileBytes.set("https://files.slack.com/f-shot", new Uint8Array([137, 80, 78, 71]));
    await service.start();

    adapter.emit(mention({
      text: "<@BOT1> why does this look broken?",
      ts: "20.0",
      files: [{ id: "F9", name: "Screenshot.png", mimetype: "image/png", urlPrivate: "https://files.slack.com/f-shot", size: 4 }],
    }));
    await service.idle();

    expect(adapter.downloads).toEqual(["https://files.slack.com/f-shot"]);
    expect(sessions[0]!.images[0]).toHaveLength(1);
    expect(sessions[0]!.images[0]![0]).toContain("incoming/");
    expect(sessions[0]!.prompts[0]!).toContain("attached image is included in your input");
    await service.stop();
  });

  test("a failed download degrades honestly: no image item, a note in the prompt instead", async () => {
    const sessions: FakeAgentRuntimeSession[] = [];
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "can't see it" });
        });
        sessions.push(s);
        return s;
      },
    });
    await service.start();

    adapter.emit(mention({
      text: "<@BOT1> look",
      ts: "21.0",
      files: [{ id: "F8", name: "shot.png", mimetype: "image/png", urlPrivate: "https://files.slack.com/nope", size: 4 }],
    }));
    await service.idle();

    expect(sessions[0]!.images[0]).toHaveLength(0);
    expect(sessions[0]!.prompts[0]!).toContain("could not be fetched");
    expect(sessions[0]!.prompts[0]!).toContain("files:read");
    await service.stop();
  });
});

describe("Service thread grounding: a reply turn sees the thread it stands in", () => {
  test("a bare mention under a bot alert gets the alert's content in the prompt", async () => {
    const sessions: FakeAgentRuntimeSession[] = [];
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "on it" });
        });
        sessions.push(s);
        return s;
      },
    });
    adapter.threads.set("500.0", [
      { user: "B_SENTRY", text: "SecurityError: history.replaceState >100 per 10s on /home/acme", ts: "500.0" },
      { user: "U_NOAH", text: "<@BOT1>", ts: "500.1" },
    ]);
    await service.start();

    adapter.emit(mention({ text: "<@BOT1>", ts: "500.1", threadRootTs: "500.0", principalId: "U_NOAH" }));
    await service.idle();

    const prompt = sessions[0]!.prompts[0]!;
    expect(prompt).toContain("SecurityError: history.replaceState");
    expect(prompt).toContain("thread ts 500.0");
    expect(prompt.indexOf("SecurityError")).toBeLessThan(prompt.indexOf("<@BOT1>")); // context precedes the bare mention
    await service.stop();
  });
});

describe("Service busy-thread etiquette (SPEC §5.2, §5.5, §14.2 — scenario 13)", () => {
  // §5.2: thread-follow messages carry no ack duty — no "thinking…" flicker on asides.
  test("a thread-follow message shows no thinking shimmer; a direct mention does", async () => {
    let sessionCount = 0;
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const first = sessionCount++ === 0;
        return new FakeAgentRuntimeSession(tools, async (_n, t) => {
          if (first) await t.get("reply")!.run({ text: "joining" }); // establishes participation
          // second turn (the aside): silence
        });
      },
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> hey", ts: "800.1", threadRootTs: "800.0" }));
    await service.idle();
    const statusCountAfterMention = adapter.statuses.filter((s) => s.status !== "").length;
    expect(statusCountAfterMention).toBeGreaterThan(0); // direct address → shimmer

    // an aside between teammates in the same thread: addressed via participation only
    adapter.emit(mention({ text: "i've got it, can fix", ts: "800.2", threadRootTs: "800.0", mentionsBotId: false, principalId: "U2" }));
    await service.idle();

    expect(adapter.statuses.filter((s) => s.status !== "").length).toBe(statusCountAfterMention); // no new shimmer
    expect(adapter.streams).toHaveLength(1); // and the model's silence stood — no second reply
    await service.stop();
  });

  // §14.2: the failure fallback is for someone who addressed the agent directly and got nothing.
  // A thread-follow turn's failure is log/ledger-only.
  test("a failing turn posts an honest failure for a mention, but stays silent on a thread-follow", async () => {
    let sessionCount = 0;
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const first = sessionCount++ === 0;
        return new FakeAgentRuntimeSession(tools, async (_n, t) => {
          if (first) {
            await t.get("reply")!.run({ text: "in the thread" }); // participation
            return;
          }
          throw new Error("runtime died");
        });
      },
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> hi", ts: "810.1", threadRootTs: "810.0" }));
    await service.idle();
    adapter.emit(mention({ text: "so anyway, as I was saying", ts: "810.2", threadRootTs: "810.0", mentionsBotId: false, principalId: "U2" }));
    await service.idle();

    expect(adapter.streams).toHaveLength(1); // only the first reply — the aside's failure said nothing
    expect(adapter.posts).toHaveLength(0);
    await service.stop();
  });

  // §5.5 quiet-window batching at the service level: a burst becomes ONE turn whose prompt frames
  // the messages as a moved-on conversation, never "address them all".
  test("a burst of thread messages collapses into one turn with conversation framing", async () => {
    const yaml = POLICY_YAML.replace(
      "executions:",
      `turns:
  batch_debounce_ms: 25
  batch_max_wait_ms: 500
executions:`,
    );
    const sessions: FakeAgentRuntimeSession[] = [];
    const db = openLedger(":memory:");
    const adapter = new FakeAdapter();
    let n = 0;
    const service = new Service({
      db,
      clock: fakeClock(),
      policyStore: new PolicyStore(() => yaml, { knownTools: new Set(), envAvailable: () => true }),
      adapter,
      botPrincipalId: "BOT1",
      cwd: "/tmp",
      newId: () => `id-${++n}`,
      sessionFactory: (tools) => {
        const s = new FakeAgentRuntimeSession(tools, async (_n, t) => {
          await t.get("reply")!.run({ text: "one reply for the lot" });
        });
        sessions.push(s);
        return s;
      },
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> saw the bug report?", ts: "820.1", threadRootTs: "820.0", principalId: "U1" }));
    adapter.emit(mention({ text: "<@BOT1> i can hotfix it", ts: "820.2", threadRootTs: "820.0", principalId: "U2" }));
    await new Promise((r) => setTimeout(r, 80)); // quiet window (25ms) elapses on its own
    await service.idle();

    expect(sessions).toHaveLength(1); // ONE turn for the burst
    const prompt = sessions[0]!.prompts[0]!;
    expect(prompt).toContain("<@U1>: <@BOT1> saw the bug report?");
    expect(prompt).toContain("<@U2>: <@BOT1> i can hotfix it");
    expect(prompt).toContain("respond to where it stands NOW");
    expect(prompt).not.toContain("address them all");
    expect(adapter.streams).toHaveLength(1);
    await service.stop();
  });
});

describe("Service honest failure replies (SPEC §6.1 for failures)", () => {
  test("a turn the runtime fails is reported with the runtime's own cause, not a canned success", async () => {
    const { adapter, service } = makeService({
      sessionFactory: (tools, onEvent) =>
        new FakeAgentRuntimeSession(tools, async () => {
          onEvent?.({ event: "turn_failed", ts: "t", log: "You've hit your usage limit. Try again Jul 7." });
          throw new Error("turn failed");
        }),
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> u alive?", ts: "600.0" }));
    await service.idle();

    const text = adapter.lastStreamText() || adapter.posts.map((p) => p.text).join("\n");
    expect(text.toLowerCase()).toMatch(/couldn.t finish|can.t run/);
    expect(text).toContain("usage limit");
    await service.stop();
  });
});
