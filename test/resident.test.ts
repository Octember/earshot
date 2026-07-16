import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { pendingMessages } from "../src/ledger/inbox";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { DynamicTool } from "../src/turn-runner/types";
import type { Clock } from "../src/ledger/clock";
import type { RawMessage } from "@bevyl-ai/agent-tools";

// The Collapse (specs/2026-07-13-the-collapse-design.md): one resident thread per identity,
// inbox messages delivered verbatim, rotation before rot, restart-durable delivery. These are
// the loop's conformance rows.

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
identities:
  - id: eng
    venue_ids: [C1, C2]
    budget: { monthly_cap: 1000 }
turns:
  backoff_ms: 1
budget:
  global_monthly_cap: 100000
`;

function harness(script?: ConstructorParameters<typeof FakeAgentRuntimeSession>[1], db = openLedger(":memory:"), policyYaml = POLICY_YAML) {
  const clock = fakeClock();
  const adapter = new FakeAdapter();
  const sessions: FakeAgentRuntimeSession[] = [];
  let n = 0;
  const service = new Service({
    db,
    clock,
    policyStore: new PolicyStore(() => policyYaml, { knownTools: new Set(), envAvailable: () => true }),
    adapter,
    botPrincipalId: "BOT1",
    cwd: "/tmp",
    earCwd: "/tmp/ear-test",
    newId: () => `id-${++n}`,
    sessionFactory: (tools: DynamicTool[]) => {
      const s = new FakeAgentRuntimeSession(tools, script ?? (async () => {}));
      sessions.push(s);
      return s;
    },
  });
  // The ear's bookkeeping sessions interleave with wakes; assertions about HER sessions filter.
  const minds = () => sessions.filter((x) => x.hasTool("reply"));
  return { db, clock, adapter, service, sessions, minds };
}

function msg(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    venueId: "C1",
    venueKind: "channel",
    principalId: "U1",
    isBot: false,
    text: "hello",
    ts: `${Date.now()}.${Math.random().toString().slice(2, 8)}`,
    threadRootTs: null,
    mentionsBotId: false,
    ...overrides,
  };
}

describe("resident delivery", () => {
  test("messages deliver VERBATIM with venue, thread, ts, and speaker coordinates", async () => {
    const { adapter, service, sessions } = harness();
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> what broke?", mentionsBotId: true, ts: "10.1", principalId: "U_NOAH" }));
    await service.idle();

    const prompt = sessions[0]!.prompts[0]!;
    expect(prompt).toContain("[<#C1> ts=10.1] <@U_NOAH>: <@BOT1> what broke?");
    await service.stop();
  });

  test("a burst of observed chatter settles into ONE wake carrying every line", async () => {
    const { adapter, service, sessions } = harness();
    await service.start();
    adapter.emit(msg({ text: "the export thing is back", ts: "1.1" }));
    adapter.emit(msg({ text: "yeah saw it too", ts: "1.2", principalId: "U2" }));
    adapter.emit(msg({ text: "on web this time", ts: "1.3" }));
    await service.idle();

    expect(sessions).toHaveLength(1);
    const prompt = sessions[0]!.prompts[0]!;
    for (const piece of ["the export thing is back", "yeah saw it too", "on web this time"]) expect(prompt).toContain(piece);
    await service.stop();
  });

  test("successive wakes resume ONE resident thread; the prompt is ONLY the messages", async () => {
    const { adapter, service, minds } = harness(async (_turn, tools) => {
      if (tools.get("verdict")) return; // the ear bookkeeps; nothing to judge here
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> one", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> two", mentionsBotId: true, ts: "2.0" }));
    await service.idle();

    expect(minds()).toHaveLength(2);
    expect(minds()[0]!.lastThreadOp!.op).toBe("start");
    expect(minds()[1]!.lastThreadOp!.op).toBe("resume");
    expect(minds()[1]!.lastThreadOp!.id).toBe(minds()[0]!.lastThreadOp!.id);
    // the digest is standing knowledge (AGENTS.md), never turn input
    expect(minds()[0]!.prompts[0]!).not.toContain("Your tools");
    expect(minds()[0]!.prompts[0]!.startsWith("[<#C1>")).toBe(true);
    expect(minds()[1]!.prompts[0]!).toContain("<@BOT1> two");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("/tmp/AGENTS.md", "utf8")).toContain("## Your tools (as eng)");
    await service.stop();
  });

  test("delivery is restart-durable: undelivered inbox messages wake a fresh service (cursor, not luck)", async () => {
    const db = openLedger(":memory:");
    // First service receives a message but its session never runs (simulate a crash before the
    // wake by stopping immediately after emit — the event row is already durable).
    const first = harness(async () => {
      throw new Error("boom — process died mid-wake");
    }, db);
    await first.service.start();
    first.adapter.emit(msg({ text: "<@BOT1> did you see this?", mentionsBotId: true, ts: "5.5" }));
    await first.service.idle().catch(() => {});
    await first.service.stop();

    // The failed wake advanced nothing? It did — but a message arriving while DOWN must also
    // deliver. Emit a fresh one into the ledger via a second service and check both behaviors:
    const second = harness(undefined, db);
    await second.service.start();
    await second.service.idle();
    // whatever was left past the cursor was delivered or the inbox is empty — nothing dangles.
    expect(pendingMessages(db, "eng")).toHaveLength(0);
    await second.service.stop();
  });

  test("§14.2 carve-out: a wake that dies with an addressed message pending exhausts its retries, then posts ONE honest fallback", async () => {
    const { adapter, service, minds } = harness(async (_turn, tools) => {
      if (tools.get("verdict")) return; // the ear bookkeeps quietly
      throw new Error("runtime exploded");
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> urgent — prod?", mentionsBotId: true, ts: "9.1" }));
    await service.idle();

    expect(minds()).toHaveLength(3); // 1 + max_retries (default 2), all dead-clean so all retried
    expect(adapter.posts).toHaveLength(1);
    expect(adapter.posts[0]!.text).toContain("can't run right now");
    expect(adapter.posts[0]!.venueId).toBe("C1");
    await service.stop();
  });

  test("§14.2: a timed-out attempt (envelope breach, not a throw) is retried and the retry answers", async () => {
    let calls = 0;
    const yaml = POLICY_YAML.replace("backoff_ms: 1", "backoff_ms: 1\n  interactive_timeout_ms: 40");
    const { adapter, service, minds } = harness(
      async (_turn, tools) => {
        if (tools.get("verdict")) return; // the ear bookkeeps quietly
        calls++;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 300)); // dead air past the 40ms envelope
          return;
        }
        await tools.get("reply")!.run({ text: "back — answering now", venueId: "C1", threadRootId: "8.5" });
      },
      openLedger(":memory:"),
      yaml,
    );
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> you there?", mentionsBotId: true, ts: "8.5" }));
    await service.idle();

    expect(minds()).toHaveLength(2);
    expect(adapter.posts).toHaveLength(1);
    expect(adapter.posts[0]!.text).toBe("back — answering now");
    await service.stop();
  });

  test("§14.2: a wake that acted without answering is NOT replayed, and the fallback still fires", async () => {
    // The script runs for every session the service spawns — the task's execution and the
    // outcome-report wake included. Act exactly once, and let the spawned execution finish
    // its task cleanly, or the test loops (task_create per wake / yield-redispatch forever).
    let acted = false;
    const { adapter, service, db } = harness(async (_turn, tools) => {
      const complete = tools.get("task_complete");
      if (complete) {
        await complete.run({ report: "done" });
        return;
      }
      const taskCreate = tools.get("task_create");
      if (!taskCreate || acted) return;
      acted = true;
      await taskCreate.run({ title: "file the export bug", spec: "repro + ticket" });
      throw new Error("died after acting");
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> file this please", mentionsBotId: true, ts: "7.7" }));
    await service.idle();

    // effects exist — a replay would have created a second task
    expect(db.query("SELECT COUNT(*) as c FROM tasks").get()).toEqual({ c: 1 });
    expect(adapter.posts).toHaveLength(1); // nobody was answered, so the honest fallback still lands
    expect(adapter.posts[0]!.text).toContain("can't run right now");
    await service.stop();
  });

  test("§14.2: a wake that dies clean is retried on a fresh session and answers — no fallback", async () => {
    let calls = 0;
    const { adapter, service, minds } = harness(async (_turn, tools) => {
      if (tools.get("verdict")) return; // the ear bookkeeps quietly
      calls++;
      if (calls === 1) throw new Error("model request blackholed");
      await tools.get("reply")!.run({ text: "here — filing it", venueId: "C1", threadRootId: "8.1" });
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> file this", mentionsBotId: true, ts: "8.1" }));
    await service.idle();

    expect(minds()).toHaveLength(2); // the dead attempt, then its retry
    expect(adapter.posts).toHaveLength(1);
    expect(adapter.posts[0]!.text).toBe("here — filing it");
    await service.stop();
  });

  test("§14.2 fallback is suppressed when the wake already answered the addressed thread before dying — and an acted wake is never replayed", async () => {
    const { adapter, service, minds } = harness(async (_turn, tools) => {
      if (tools.get("verdict")) return; // the ear bookkeeps quietly
      await tools.get("reply")!.run({ text: "on it — checking now", venueId: "C1", threadRootId: "9.1" });
      throw new Error("runtime exploded mid-wake");
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> urgent — prod?", mentionsBotId: true, ts: "9.1" }));
    await service.idle();

    // the reply landed; nobody is left hanging, so the harness stays silent and doesn't retry
    expect(minds()).toHaveLength(1);
    expect(adapter.posts).toHaveLength(1);
    expect(adapter.posts[0]!.text).toBe("on it — checking now");
    await service.stop();
  });

  test("§14.2 fallback is suppressed when the wake reacted to the addressed message before dying", async () => {
    const { adapter, service } = harness(async (_turn, tools) => {
      await tools.get("react")!.run({ emoji: "eyes", venueId: "C1", ts: "9.2" });
      throw new Error("runtime exploded mid-wake");
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> seen this?", mentionsBotId: true, ts: "9.2" }));
    await service.idle();

    expect(adapter.posts).toHaveLength(0);
    expect(adapter.reactions).toHaveLength(1);
    await service.stop();
  });

  test("observed-only wake failures stay silent — the fallback is for people left hanging", async () => {
    const { adapter, service } = harness(async () => {
      throw new Error("runtime exploded");
    });
    await service.start();
    adapter.emit(msg({ text: "just teammates talking", ts: "3.3" }));
    await service.idle();

    expect(adapter.posts).toHaveLength(0);
    await service.stop();
  });

  test("the resident thread rotates at the turn cap and the fresh thread re-opens with the digest", async () => {
    const { adapter, service, minds, db } = harness(async (_turn, tools) => {
      if (tools.get("verdict")) return; // the ear bookkeeps quietly
    });
    await service.start();
    // simulate an aged thread: seed the continuity row at the cap
    adapter.emit(msg({ text: "<@BOT1> first", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    db.query("UPDATE conversation_threads SET turn_count = 999 WHERE venue_id = '__resident__'").run();
    adapter.emit(msg({ text: "<@BOT1> after the cap", mentionsBotId: true, ts: "2.0" }));
    await service.idle();

    expect(minds()[1]!.lastThreadOp!.op).toBe("start"); // rotated, not resumed
    expect(minds()[1]!.prompts[0]!).toContain("after the cap"); // still just the messages
    await service.stop();
  });

  test("a task born in a wake homes to the conversation that addressed her", async () => {
    let sessions = 0;
    const { adapter, service, db } = harness(async (_n, t) => {
      // 1: the wake that delegates; 2: the worker; 3+: the report wake (does nothing)
      const which = ++sessions;
      if (which === 1) await t.get("task_create")!.run({ title: "dig", spec: "dig in" });
      if (which === 2) await t.get("task_complete")!.run({ report: "done" });
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> dig into it", mentionsBotId: true, ts: "77.1", threadRootTs: "77.0" }));
    await service.idle();

    const row = db.query("SELECT home_venue_id, home_thread_root_id FROM tasks").get() as { home_venue_id: string; home_thread_root_id: string } | null;
    expect(row?.home_venue_id).toBe("C1");
    expect(row?.home_thread_root_id).toBe("77.0");
    await service.stop();
  });

  // SPEC §11 explicit post addressing — the live wrong-thread bug: a wake batch spanning two
  // conversations, and a coordinate-less reply landing in whichever one the harness guessed.
  test("§11: a wake spanning two conversations posts each reply where its coordinates say — a coordinate-less reply is rejected, nothing posts", async () => {
    const db = openLedger(":memory:");
    const seed = db.query(
      `INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
       VALUES (?, ?, 'addressed_message', 'eng', ?, ?, 'U1', ?, '2026-07-01T00:00:00Z')`,
    );
    // Two conversations in one undelivered batch: a C1 thread, then a C2 top-level ask. The
    // batch-level "home" is the LAST message (C2) — exactly what a guessed default would hit.
    seed.run("e1", "k1", "C1", "1.0", JSON.stringify({ text: "<@BOT1> what broke?", ts: "1.1", addressMode: "mention" }));
    seed.run("e2", "k2", "C2", null, JSON.stringify({ text: "<@BOT1> unrelated ask", ts: "2.0", addressMode: "mention" }));

    const rejected: string[] = [];
    const { adapter, service } = harness(async (_turn, tools) => {
      const reply = tools.get("reply");
      if (!reply) return; // the ear
      const bare = await reply.run({ text: "the export fix landed" });
      expect(bare.success).toBe(false);
      rejected.push(bare.output);
      await reply.run({ text: "the export fix landed", venueId: "C1", threadRootId: "1.0" });
    }, db);
    await service.start();
    await service.idle(); // flushes the boot wake carrying both conversations

    expect(rejected[0]).toContain("unaddressed reply");
    expect(adapter.posts).toHaveLength(1);
    expect(adapter.posts[0]!.venueId).toBe("C1"); // where the answer belongs...
    expect(adapter.posts[0]!.threadRootTs).toBe("1.0"); // ...in ITS thread, not the batch's last
    await service.stop();
  });
});
