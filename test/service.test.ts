import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { createTask, transition, getTask } from "../src/ledger/tasks";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { AgentRuntimeSession, DynamicTool } from "../src/turn-runner/types";
import type { Clock } from "../src/ledger/clock";
import type { RawMessage } from "@bevyl-ai/agent-tools";

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
turns:
  backoff_ms: 1
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
models:
  low: { model: test-luna, effort: low }
  medium: { model: test-terra }
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
    earCwd: "/tmp/ear-test",
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
  test("an addressed mention wakes the resident and posts its reply into the thread", async () => {
    const { adapter, service } = makeService();
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> what's our SLA?", ts: "42.1" }));
    await service.idle();

    expect(adapter.posts).toHaveLength(1);
    expect(adapter.posts[0]!.text).toBe("ack");
    expect(adapter.posts[0]!.venueId).toBe("C1");
    expect(adapter.posts[0]!.threadRootTs).toBe("42.1"); // reply defaults to the addressing thread
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
      earCwd: "/tmp/ear-test",
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

  test("an observed message is delivered on the (flushed) debounce; silence stays silent", async () => {
    const prompts: string[] = [];
    const { adapter, service } = makeService({
      sessionFactory: (tools) => {
        const sess = new FakeAgentRuntimeSession(tools, async () => {});
        prompts.push = prompts.push.bind(prompts);
        (sess as any).onPrompt = undefined;
        return sess;
      },
    });
    await service.start();

    adapter.emit(mention({ text: "just chatting", mentionsBotId: false, ts: "7.7" }));
    await service.idle(); // flushes the settle debounce into a wake

    expect(adapter.posts).toHaveLength(0); // she read it and chose silence — nothing posts for her
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
  test("a react-only wake posts no text — the reaction is the reply", async () => {
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
    expect(adapter.posts).toHaveLength(0); // nothing was said, nothing owed
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
      earCwd: "/tmp/ear-test",
      newId: () => `id-${++n}`,
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          expect(adapter.statuses.at(-1)?.status).not.toBe(""); // shimmer is up while working
          await t.get("react")!.run({ emoji: "thumbsup" });
        }),
    });
    await service.start();

    adapter.emit(mention({ text: "<@BOT1> i did it" }));
    await service.idle();

    expect(adapter.statuses.at(-1)?.status).toBe(""); // shimmer never outlives the wake
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

    expect(adapter.posts).toHaveLength(0);
    expect(adapter.statuses.at(-1)?.status).toBe(""); // the shimmer still clears — no eternal "thinking…"
    await service.stop();
  });
});

describe("Service dispatch driver (SPEC §6.2, §17.3, §17.4)", () => {
  test("a delegated mention creates a task and drives it to a terminal report — dispatch is event-driven, no manual tick needed (M9)", async () => {
    let delegated = false;
    const { db, adapter, service } = makeService({
      // Kind-aware script (the ear shifted session ordering; indices were a trap): the ear holds,
      // the worker completes, the first wake delegates, later wakes choose silence.
      sessionFactory: (tools) =>
        new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          if (t.get("verdict")) return; // the ear: nothing needs her
          const complete = t.get("task_complete");
          if (complete) {
            await complete.run({ report: "found it: N+1 query" });
            return;
          }
          if (!delegated) {
            delegated = true;
            await t.get("task_create")!.run({ title: "dig in", spec: "why slow" });
          }
          // later wakes (the worker's report) — she chooses silence
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
          const complete = t.get("task_complete");
          if (!complete) return; // only the workers act in this test
          await new Promise((r) => setTimeout(r, 15)); // hold the slot briefly
          await complete.run({ report: "done" });
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

describe("Service workers report to the mind (2026-07-13)", () => {
  function workerHarness(worker: (t: Map<string, DynamicTool>) => Promise<void>, reportWake?: (t: Map<string, DynamicTool>, prompt: string) => Promise<void>) {
    // Kind-aware scripting (the ear's sessions interleave; indices were a trap): the ear holds,
    // the worker acts, the first mind wake delegates, later mind wakes run the report branch.
    let delegated = false;
    const sessions: FakeAgentRuntimeSession[] = [];
    const overridesByKind: { kind: "ear" | "worker" | "mind"; overrides?: { model?: string; effort?: string } }[] = [];
    const made = makeService({
      sessionFactory: (tools, _onEvent, overrides) => {
        const kind = tools.some((x) => x.spec.name === "verdict") ? "ear" : tools.some((x) => x.spec.name === "task_complete") ? "worker" : "mind";
        overridesByKind.push({ kind, overrides });
        const sess: FakeAgentRuntimeSession = new FakeAgentRuntimeSession(tools, async (_turn, t) => {
          if (t.get("verdict")) return; // the ear: nothing to judge in these tests
          if (t.get("task_complete")) {
            await worker(t);
            return;
          }
          if (!delegated) {
            delegated = true;
            await t.get("task_create")!.run({ title: "dig", spec: "dig into the export bug", tier: "low" });
            await t.get("reply")!.run({ text: "on it" });
            return;
          }
          if (reportWake) await reportWake(t, sess.prompts[0] ?? "");
        });
        sessions.push(sess);
        return sess;
      },
    });
    const nonEar = () => sessions.filter((x) => !x.hasTool("verdict"));
    return { ...made, sessions, nonEar, overridesByKind };
  }

  test("a worker's terminal report wakes the mind, who voices it — no streams, no worker posts", async () => {
    const { db, adapter, service, nonEar } = workerHarness(
      async (t) => {
        await t.get("task_complete")!.run({ report: "found it: N+1 query (receipts: PR #12)" });
      },
      async (t, prompt) => {
        expect(prompt).toContain("[task update]");
        expect(prompt).toContain("found it: N+1 query");
        await t.get("reply")!.run({ text: "that export dig landed: N+1 query, fix in PR #12", venueId: "C1" });
      },
    );
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> dig into the export bug", ts: "1.0", principalId: "U_NOAH" }));
    await service.idle();

    expect(getTask(db, "T-1")?.status).toBe("done");
    expect(adapter.streams).toHaveLength(0); // nobody streams anymore
    const texts = adapter.posts.map((p) => p.text);
    expect(texts).toContain("on it");
    expect(texts.some((t) => t.includes("N+1 query"))).toBe(true); // HER voice, not the worker's
    expect(nonEar()).toHaveLength(3);
    await service.stop();
  });

  test("a routine timer yield stays silent — no report wake, no posts", async () => {
    const { adapter, service, nonEar } = workerHarness(async (t) => {
      await t.get("set_wake")!.run({ wakeAt: "2027-01-01T00:00:00Z" });
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> dig into the export bug", ts: "1.0", principalId: "U_NOAH" }));
    await service.idle();

    expect(nonEar()).toHaveLength(2); // wake + worker, no report wake
    expect(adapter.posts.map((p) => p.text)).toEqual(["on it"]);
    await service.stop();
  });

  test("a worker's task_ask wakes the mind with the actual question", async () => {
    const prompts: string[] = [];
    const { service, adapter } = workerHarness(
      async (t) => {
        await t.get("task_ask")!.run({ question: "which environment should I profile, staging or prod?" });
      },
      async (_t, prompt) => {
        prompts.push(prompt);
      },
    );
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> dig into the export bug", ts: "1.0", principalId: "U_NOAH" }));
    await service.idle();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!).toContain("waiting on a human");
    expect(prompts[0]!).toContain("which environment should I profile");
    await service.stop();
  });

  test("the worker runs on its task's tier (policy.models), the mind on the runtime default", async () => {
    const { service, adapter, overridesByKind } = workerHarness(async (t) => {
      await t.get("task_complete")!.run({ report: "done" });
    });
    await service.start();
    adapter.emit(mention({ text: "<@BOT1> dig into the export bug", ts: "1.0", principalId: "U_NOAH" }));
    await service.idle();

    expect(overridesByKind.find((o) => o.kind === "mind")!.overrides).toBeUndefined(); // the mind: runtime default
    expect(overridesByKind.find((o) => o.kind === "worker")!.overrides).toEqual({ model: "test-luna", effort: "low" }); // the worker: its tier
    expect(overridesByKind.find((o) => o.kind === "ear")!.overrides).toEqual({ model: "test-luna", effort: "low" }); // the ear: models.low
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
      earCwd: "/tmp/ear-test",
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
      earCwd: "/tmp/ear-test",
      newId: () => `id-${++n}`,
      sessionFactory: (tools) => new FakeAgentRuntimeSession(tools, async () => {}),
    });

    yaml = "not: valid: yaml: [";
    expect(service.reloadPolicy()).toBe(false);
    expect(service.policy().budget.globalMonthlyCap).toBe(100000); // unchanged
  });
});
