import { fakeClock } from "./helpers";
import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { refIn } from "./helpers";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { pendingConversations } from "../src/ledger/conversations";
import { openItems, openAttentionItem, closeAttentionItem } from "../src/ledger/attention";
import { loadIncident, originalActions, rewindLedger } from "../src/replay/incident";
import { runReplay, recordingRegistries } from "../src/replay/run";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { DynamicTool } from "../src/turn-runner/types";
import type { Clock } from "../src/ledger/clock";
import type { RawMessage } from "@bevyl-ai/agent-tools";

// Replay harness: carve, rewind, relive against capture (codex faked).

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

// Record phase: real service + fake adapter; ids unique across db lifetime.
let idCounter = 0;
async function record(
  db: ReturnType<typeof openLedger>,
  clock: Clock,
  messages: RawMessage[],
  script: ConstructorParameters<typeof FakeAgentRuntimeSession>[1],
) {
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
  for (const message of messages) {
    adapter.emit(message);
    await service.idle();
  }
  await service.stop();
}

describe("replay: incident loading", () => {
  test("messages round-trip: mentionsBotId, thread, files, window filters", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T00:00:00Z");
    await record(db, clock, [msg({ text: "before the window", ts: "1.0" })], async () => {});
    clock.set("2026-07-02T10:00:00Z");
    await record(
      db,
      clock,
      [
        msg({
          text: "<@BOT1> look at this",
          mentionsBotId: true,
          ts: "2.0",
          files: [{ id: "F1", name: "shot.png", mimetype: "image/png", urlPrivate: "u", size: 1 }],
        }),
        msg({ text: "a thread reply", ts: "2.1", threadRootTs: "2.0", principalId: "U2" }),
      ],
      async () => {},
    );

    const events = loadIncident(db, {
      fromIso: "2026-07-02T10:00:00Z",
      toIso: "2026-07-02T11:00:00Z",
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.message).toMatchObject({
      text: "<@BOT1> look at this",
      mentionsBotId: true,
      ts: "2.0",
      threadRootTs: null,
      venueKind: "channel",
    });
    expect(events[0]!.message.files).toHaveLength(1);
    expect(events[1]!.message).toMatchObject({
      text: "a thread reply",
      mentionsBotId: false,
      threadRootTs: "2.0",
      principalId: "U2",
    });
  });
});

describe("replay: rewind", () => {
  test("rewind unwinds window events/turns/attention/cursors; past intact", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T00:00:00Z");
    await record(
      db,
      clock,
      [msg({ text: "<@BOT1> old business", mentionsBotId: true, ts: "1.0" })],
      async (_t, tools, _mark, prompt) => {
        if (tools.get("verdict")) return;
        await tools.get("reply")!.run({ text: "handled", ref: refIn(prompt, "old business") });
      },
    );
    // item opened before window but closed during it comes back open
    openAttentionItem(db, clock, {
      id: "old-item",
      identityId: "eng",
      venueId: "C1",
      threadRootId: "1.0",
      askTs: null,
      what: "an old debt",
    });
    clock.set("2026-07-02T10:00:00Z");
    await record(
      db,
      clock,
      [msg({ text: "<@BOT1> new business", mentionsBotId: true, ts: "2.0" })],
      async (_t, tools, _mark, prompt) => {
        if (tools.get("verdict")) return;
        await tools.get("reply")!.run({ text: "on it", ref: refIn(prompt, "new business") });
      },
    );
    closeAttentionItem(db, clock, "eng", "old-item", "answered in thread");
    openAttentionItem(db, clock, {
      id: "new-item",
      identityId: "eng",
      venueId: "C1",
      threadRootId: "2.0",
      askTs: null,
      what: "a window debt",
    });

    const events = loadIncident(db, {
      fromIso: "2026-07-02T10:00:00Z",
      toIso: "2026-07-02T11:00:00Z",
    });
    const original = originalActions(db, "2026-07-02T10:00:00Z", "2026-07-02T11:00:00Z");
    expect(
      original
        .flatMap((t) => t.effects)
        .some((e) => typeof e === "object" && e !== null && "text" in e && e.text === "on it"),
    ).toBe(true);

    const report = rewindLedger(db, events[0]!.rowid, "2026-07-02T10:00:00Z");
    expect(report.events).toBeGreaterThanOrEqual(1);
    expect(report.turns).toBeGreaterThanOrEqual(1);
    // window gone
    expect(originalActions(db, "2026-07-02T10:00:00Z", "2026-07-02T11:00:00Z")).toHaveLength(0);
    expect(
      loadIncident(db, { fromIso: "2026-07-02T10:00:00Z", toIso: "2026-07-02T11:00:00Z" }),
    ).toHaveLength(0);
    // past intact
    expect(
      loadIncident(db, { fromIso: "2026-07-02T00:00:00Z", toIso: "2026-07-02T01:00:00Z" }),
    ).toHaveLength(1);
    // closed-in-window item open again; opened-in-window item gone
    expect(openItems(db, "eng").map((i) => i.id)).toEqual(["old-item"]);
    // cursor at end of remaining events
    expect(pendingConversations(db, "eng")).toHaveLength(0);
  });
});

describe("replay: reliving", () => {
  test("rewound incident re-runs pipeline; actions captured, nothing posted", async () => {
    const db = openLedger(":memory:");
    const clock = fakeClock("2026-07-02T00:00:00Z");
    await record(
      db,
      clock,
      [msg({ text: "<@BOT1> keep an eye out", mentionsBotId: true, ts: "1.0" })],
      async () => {},
    );
    clock.set("2026-07-02T10:00:00Z");
    await record(
      db,
      clock,
      [msg({ text: "<@BOT1> what broke?", mentionsBotId: true, ts: "2.0", principalId: "U_NOAH" })],
      async (_t, tools, _mark, prompt) => {
        if (tools.get("verdict")) return;
        await tools
          .get("reply")!
          .run({ text: "the original answer", ref: refIn(prompt, "what broke?") });
      },
    );

    const events = loadIncident(db, {
      fromIso: "2026-07-02T10:00:00Z",
      toIso: "2026-07-02T11:00:00Z",
    });
    rewindLedger(db, events[0]!.rowid, "2026-07-02T10:00:00Z");

    const prompts: string[] = [];
    const captured = await runReplay({
      db,
      events,
      policyStore: policyStore(),
      sessionFactory: (tools: DynamicTool[]) =>
        new FakeAgentRuntimeSession(tools, async (_t, sessionTools, _mark, prompt) => {
          if (sessionTools.get("verdict")) return;
          await sessionTools
            .get("reply")!
            .run({ text: "the replayed answer", ref: refIn(prompt, "what broke?") });
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

  test("recording registries: write captured without exec; read runs real impl", async () => {
    const captured: Parameters<typeof recordingRegistries>[0] = [];
    const registries = recordingRegistries(captured, fakeClock());
    const linearWrite = registries
      .flatMap((r) => Object.entries(r.tools))
      .find(([name]) => name === "linear_write")?.[1];
    const linearRead = registries
      .flatMap((r) => Object.entries(r.tools))
      .find(([name]) => name === "linear_read")?.[1];
    expect(linearWrite).toBeDefined();
    expect(linearRead).toBeDefined();

    const write = await linearWrite!.run!({ query: "mutation { issueCreate }" });
    // real read runs (fails friendly without credentials)
    const read = await linearRead!.run!({ query: "query { issues }" });
    expect(write.success).toBe(true);
    expect(read.success).toBe(false);
    expect(captured.map((c) => c.detail["tool"])).toEqual(["linear_write"]); // only the write is stub-captured
  });
});
