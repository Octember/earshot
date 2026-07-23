import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { pendingMessages } from "../src/ledger/inbox";
import { openItems, openAttentionItem, closeAttentionItem } from "../src/ledger/attention";
import { loadIncident, originalActions, rewindLedger } from "../src/replay/incident";
import { runReplay, recordingRegistries } from "../src/replay/run";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { DynamicTool } from "../src/turn-runner/types";
import type { Clock } from "../src/ledger/clock";
import type { RawMessage } from "@bevyl-ai/agent-tools";

// The replay harness (src/replay): carve a recorded incident out of a ledger snapshot, rewind
// the snapshot to the moment before it, and relive it through the real Service against a capture
// surface. Codex is faked here per the repo's test rules — the CLI injects the real factory.

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
    venue_ids: [C1]
    budget: { monthly_cap: 1000 }
turns:
  backoff_ms: 1
budget:
  global_monthly_cap: 100000
`;

function policyStore(): PolicyStore {
  return new PolicyStore(() => POLICY_YAML, { knownTools: new Set(), envAvailable: () => true });
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

// Record phase: run a real service over the fake adapter so the ledger fills exactly the way a
// live one would (router-written payloads, cursors, turns). Ids must be unique across the db's
// LIFETIME, not one service run — a reused id is silently dropped as a duplicate event.
let idCounter = 0;
async function record(db: ReturnType<typeof openLedger>, clock: Clock, messages: RawMessage[], script: ConstructorParameters<typeof FakeAgentRuntimeSession>[1]) {
  const adapter = new FakeAdapter();
  const service = new Service({
    db,
    clock,
    policyStore: policyStore(),
    adapter,
    botPrincipalId: "BOT1",
    cwd: "/tmp",
    earCwd: "/tmp/ear-test",
    newId: () => `rec-${++idCounter}`,
    sessionFactory: (tools: DynamicTool[]) => new FakeAgentRuntimeSession(tools, script),
  });
  await service.start();
  for (const m of messages) {
    adapter.emit(m);
    await service.idle();
  }
  await service.stop();
}

describe("replay: incident loading", () => {
  test("messages round-trip: a mention regains mentionsBotId, thread and files survive, window filters apply", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T00:00:00Z");
    await record(db, clock, [msg({ text: "before the window", ts: "1.0" })], async () => {});
    clock.set("2026-07-02T10:00:00Z");
    await record(db, clock, [
      msg({ text: "<@BOT1> look at this", mentionsBotId: true, ts: "2.0", files: [{ id: "F1", name: "shot.png", mimetype: "image/png", urlPrivate: "u", size: 1 }] }),
      msg({ text: "a thread reply", ts: "2.1", threadRootTs: "2.0", principalId: "U2" }),
    ], async () => {});

    const events = loadIncident(db, { fromIso: "2026-07-02T10:00:00Z", toIso: "2026-07-02T11:00:00Z" });
    expect(events).toHaveLength(2);
    expect(events[0]!.message).toMatchObject({ text: "<@BOT1> look at this", mentionsBotId: true, ts: "2.0", threadRootTs: null, venueKind: "channel" });
    expect(events[0]!.message.files).toHaveLength(1);
    expect(events[1]!.message).toMatchObject({ text: "a thread reply", mentionsBotId: false, threadRootTs: "2.0", principalId: "U2" });
  });
});

describe("replay: rewind", () => {
  test("rewind unwinds the window — events, turns, attention items, cursors — and leaves the past intact", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T00:00:00Z");
    await record(db, clock, [msg({ text: "<@BOT1> old business", mentionsBotId: true, ts: "1.0" })], async (_t, tools) => {
      if (tools.get("verdict")) return;
      await tools.get("reply")!.run({ text: "handled", venueId: "C1", threadRootId: "1.0" });
    });
    // an item opened before the window but closed during it must come back open
    openAttentionItem(db, clock, { id: "old-item", identityId: "eng", venueId: "C1", threadRootId: "1.0", askTs: null, what: "an old debt" });
    clock.set("2026-07-02T10:00:00Z");
    await record(db, clock, [msg({ text: "<@BOT1> new business", mentionsBotId: true, ts: "2.0" })], async (_t, tools) => {
      if (tools.get("verdict")) return;
      await tools.get("reply")!.run({ text: "on it", venueId: "C1", threadRootId: "2.0" });
    });
    closeAttentionItem(db, clock, "old-item", "answered in thread");
    openAttentionItem(db, clock, { id: "new-item", identityId: "eng", venueId: "C1", threadRootId: "2.0", askTs: null, what: "a window debt" });

    const events = loadIncident(db, { fromIso: "2026-07-02T10:00:00Z", toIso: "2026-07-02T11:00:00Z" });
    const original = originalActions(db, "2026-07-02T10:00:00Z", "2026-07-02T11:00:00Z");
    expect(original.flatMap((t) => t.effects as { kind?: string; text?: string }[]).some((e) => e.text === "on it")).toBe(true);

    const report = rewindLedger(db, events[0]!.rowid, "2026-07-02T10:00:00Z");
    expect(report.events).toBeGreaterThanOrEqual(1);
    expect(report.turns).toBeGreaterThanOrEqual(1);
    // the window is gone…
    expect(originalActions(db, "2026-07-02T10:00:00Z", "2026-07-02T11:00:00Z")).toHaveLength(0);
    expect(loadIncident(db, { fromIso: "2026-07-02T10:00:00Z", toIso: "2026-07-02T11:00:00Z" })).toHaveLength(0);
    // …the past is not…
    expect(loadIncident(db, { fromIso: "2026-07-02T00:00:00Z", toIso: "2026-07-02T01:00:00Z" })).toHaveLength(1);
    // …the closed-in-window item is open again, the opened-in-window item is gone…
    expect(openItems(db, "eng").map((i) => i.id)).toEqual(["old-item"]);
    // …and nothing is pending: the cursor sits exactly at the end of the remaining events.
    expect(pendingMessages(db, "eng")).toHaveLength(0);
  });
});

describe("replay: reliving", () => {
  test("a rewound incident re-runs through the real pipeline; her actions are captured, nothing reaches the fake room", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T00:00:00Z");
    await record(db, clock, [msg({ text: "<@BOT1> keep an eye out", mentionsBotId: true, ts: "1.0" })], async () => {});
    clock.set("2026-07-02T10:00:00Z");
    await record(db, clock, [msg({ text: "<@BOT1> what broke?", mentionsBotId: true, ts: "2.0", principalId: "U_NOAH" })], async (_t, tools) => {
      if (tools.get("verdict")) return;
      await tools.get("reply")!.run({ text: "the original answer", venueId: "C1", threadRootId: "2.0" });
    });

    const events = loadIncident(db, { fromIso: "2026-07-02T10:00:00Z", toIso: "2026-07-02T11:00:00Z" });
    rewindLedger(db, events[0]!.rowid, "2026-07-02T10:00:00Z");

    const prompts: string[] = [];
    const captured = await runReplay({
      db,
      events,
      policyStore: policyStore(),
      sessionFactory: (tools: DynamicTool[]) =>
        new FakeAgentRuntimeSession(tools, async (_t, sessionTools) => {
          if (sessionTools.get("verdict")) return;
          await sessionTools.get("reply")!.run({ text: "the replayed answer", venueId: "C1", threadRootId: "2.0" });
        }),
      workspace: "/tmp",
      botPrincipalId: "BOT1",
      clock,
      out: (line) => prompts.push(line),
    });

    const posts = captured.filter((c) => c.kind === "post");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.detail["text"]).toBe("the replayed answer");
    expect(prompts.some((l) => l.includes("what broke?"))).toBe(true); // the run narrates each replayed line
  });

  test("recording registries: a write reports done without executing, a read reports unavailable — both captured", async () => {
    const captured: Parameters<typeof recordingRegistries>[0] = [];
    const registries = recordingRegistries(captured, fakeClock());
    const linearWrite = registries.flatMap((r) => Object.entries(r.tools)).find(([name]) => name === "linear_write")?.[1];
    const linearRead = registries.flatMap((r) => Object.entries(r.tools)).find(([name]) => name === "linear_read")?.[1];
    expect(linearWrite).toBeDefined();
    expect(linearRead).toBeDefined();

    const write = await linearWrite!.run!({ query: "mutation { issueCreate }" });
    const read = await linearRead!.run!({ query: "query { issues }" });
    expect(write.success).toBe(true);
    expect(read.success).toBe(false);
    expect(captured.map((c) => c.detail["tool"])).toEqual(["linear_write", "linear_read"]);
  });
});
