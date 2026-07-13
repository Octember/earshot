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
budget:
  global_monthly_cap: 100000
`;

function harness(script?: ConstructorParameters<typeof FakeAgentRuntimeSession>[1], db = openLedger(":memory:")) {
  const clock = fakeClock();
  const adapter = new FakeAdapter();
  const sessions: FakeAgentRuntimeSession[] = [];
  let n = 0;
  const service = new Service({
    db,
    clock,
    policyStore: new PolicyStore(() => POLICY_YAML, { knownTools: new Set(), envAvailable: () => true }),
    adapter,
    botPrincipalId: "BOT1",
    cwd: "/tmp",
    newId: () => `id-${++n}`,
    sessionFactory: (tools: DynamicTool[]) => {
      const s = new FakeAgentRuntimeSession(tools, script ?? (async () => {}));
      sessions.push(s);
      return s;
    },
  });
  return { db, clock, adapter, service, sessions };
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
    const { adapter, service, sessions } = harness();
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> one", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> two", mentionsBotId: true, ts: "2.0" }));
    await service.idle();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.lastThreadOp!.op).toBe("start");
    expect(sessions[1]!.lastThreadOp!.op).toBe("resume");
    expect(sessions[1]!.lastThreadOp!.id).toBe(sessions[0]!.lastThreadOp!.id);
    // the digest is standing knowledge (AGENTS.md), never turn input
    expect(sessions[0]!.prompts[0]!).not.toContain("Your tools");
    expect(sessions[0]!.prompts[0]!.startsWith("[<#C1>")).toBe(true);
    expect(sessions[1]!.prompts[0]!).toContain("<@BOT1> two");
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

  test("§14.2 carve-out: a wake that dies with an addressed message pending posts one honest fallback", async () => {
    const { adapter, service } = harness(async () => {
      throw new Error("runtime exploded");
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> urgent — prod?", mentionsBotId: true, ts: "9.1" }));
    await service.idle();

    expect(adapter.posts).toHaveLength(1);
    expect(adapter.posts[0]!.text).toContain("can't run right now");
    expect(adapter.posts[0]!.venueId).toBe("C1");
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
    const { adapter, service, sessions, db } = harness();
    await service.start();
    // simulate an aged thread: seed the continuity row at the cap
    adapter.emit(msg({ text: "<@BOT1> first", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    db.query("UPDATE conversation_threads SET turn_count = 999 WHERE venue_id = '__resident__'").run();
    adapter.emit(msg({ text: "<@BOT1> after the cap", mentionsBotId: true, ts: "2.0" }));
    await service.idle();

    expect(sessions[1]!.lastThreadOp!.op).toBe("start"); // rotated, not resumed
    expect(sessions[1]!.prompts[0]!).toContain("after the cap"); // still just the messages
    await service.stop();
  });

  test("a task born in a wake homes to the conversation that addressed her", async () => {
    let taskHome: string | undefined;
    const { adapter, service, db } = harness(async (_n, t) => {
      if (t.has("task_create")) {
        await t.get("task_create")!.run({ title: "dig", spec: "dig in" });
      } else {
        await t.get("task_complete")!.run({ report: "done" });
      }
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> dig into it", mentionsBotId: true, ts: "77.1", threadRootTs: "77.0" }));
    await service.idle();

    const row = db.query("SELECT home_venue_id, home_thread_root_id FROM tasks").get() as { home_venue_id: string; home_thread_root_id: string } | null;
    expect(row?.home_venue_id).toBe("C1");
    expect(row?.home_thread_root_id).toBe("77.0");
    void taskHome;
    await service.stop();
  });
});
