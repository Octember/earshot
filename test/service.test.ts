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

  test("streams the reply: codex token deltas append to one native stream ending at the full text (#1)", async () => {
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
      // a session that emits growing token deltas via onEvent (like real codex), no reply tool.
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

    // exactly one stream, and its accumulated appended text is the full reply (deltas, not re-posts)
    expect(adapter.streams).toHaveLength(1);
    expect(adapter.lastStreamText()).toBe("Hello, world!");
    expect(adapter.posts).toHaveLength(0); // replies stream; they are never plain posts
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
  test("codex tool calls render as live task cards: in_progress, then complete when the answer lands", async () => {
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

    expect(adapter.taskCards.map((t) => `${t.title}:${t.status}`)).toEqual([
      "read_channel:in_progress",
      "read_channel:complete",
    ]);
    expect(adapter.lastStreamText()).toBe("here's what I found");
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
    const cwd = mkdtempSync(join(tmpdir(), "tag-soul-"));

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
