import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { pendingMessages } from "../src/ledger/inbox";
import { openItems } from "../src/ledger/attention";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { DynamicTool } from "../src/turn-runner/types";
import type { Clock } from "../src/ledger/clock";
import type { RawMessage } from "@bevyl-ai/agent-tools";

// The Ear (specs/2026-07-13-the-ear-design.md): observed traffic settles into a voiceless
// attention pass that decides WHEN the mind wakes — never what it sees (delivery is untouched),
// never what it says (the ear has no posting tools). These are the design's §18 rows.

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

// Scripts see both kinds of session: the ear's has a `verdict` tool, the mind's has `reply`.
function harness(script: ConstructorParameters<typeof FakeAgentRuntimeSession>[1], db = openLedger(":memory:")) {
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
    earCwd: "/tmp/ear-test",
    newId: () => `id-${++n}`,
    sessionFactory: (tools: DynamicTool[]) => {
      const s = new FakeAgentRuntimeSession(tools, script);
      sessions.push(s);
      return s;
    },
  });
  const earSessions = () => sessions.filter((s) => s.hasTool("verdict"));
  const mindSessions = () => sessions.filter((s) => s.hasTool("reply"));
  return { db, clock, adapter, service, sessions, earSessions, mindSessions };
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

describe("the ear gates waking, never delivery", () => {
  test("a hold verdict wakes nobody, posts nothing — and the held lines ride the NEXT wake verbatim", async () => {
    const { adapter, service, earSessions, mindSessions } = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "teammates comparing lunch orders" });
        return;
      }
      // the mind: no action needed for this row
    });
    await service.start();
    adapter.emit(msg({ text: "burrito day?", ts: "1.1" }));
    adapter.emit(msg({ text: "obviously", ts: "1.2", principalId: "U2" }));
    await service.idle();

    expect(earSessions()).toHaveLength(1);
    expect(mindSessions()).toHaveLength(0); // held: no wake
    expect(adapter.posts).toHaveLength(0); // the ear has no voice
    // now something real wakes her — the held chatter arrives with it, verbatim
    adapter.emit(msg({ text: "<@BOT1> status?", mentionsBotId: true, ts: "2.0" }));
    await service.idle();
    const wake = mindSessions()[0]!;
    expect(wake.prompts[0]).toContain("burrito day?");
    expect(wake.prompts[0]).toContain("obviously");
    expect(wake.prompts[0]).toContain("status?");
    await service.stop();
  });

  test("a wake verdict wakes the mind, and its why-line rides the prompt as her own first read", async () => {
    const { service, adapter, mindSessions } = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "wake", why: "kite reported a paying customer blocked on export", venueId: "C1", threadRootId: null });
        return;
      }
    });
    await service.start();
    adapter.emit(msg({ text: "export broken for kite's customer", ts: "3.1" }));
    await service.idle();

    expect(mindSessions()).toHaveLength(1);
    const prompt = mindSessions()[0]!.prompts[0]!;
    expect(prompt).toContain("export broken for kite's customer"); // verbatim delivery, not the gloss
    expect(prompt).toContain("[your first read of the room]");
    expect(prompt).toContain("paying customer blocked on export");
    await service.stop();
  });

  test("a dead ear fails open: the wake fires and delivers the batch unjudged", async () => {
    const { service, adapter, mindSessions } = harness(async (_turn, tools) => {
      if (tools.get("verdict")) throw new Error("ear runtime exploded");
    });
    await service.start();
    adapter.emit(msg({ text: "anyone seen the deploy hang?", ts: "4.1" }));
    await service.idle();

    expect(mindSessions()).toHaveLength(1);
    expect(mindSessions()[0]!.prompts[0]).toContain("anyone seen the deploy hang?");
    await service.stop();
  });

  test("a mention never waits on the ear — the mind wakes immediately", async () => {
    let earRan = false;
    const { service, adapter, mindSessions } = harness(async (_turn, tools) => {
      if (tools.get("verdict")) {
        earRan = true;
        return;
      }
      await tools.get("reply")!.run({ text: "here" });
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> quick one", mentionsBotId: true, ts: "5.1" }));
    await service.idle();

    expect(mindSessions()).toHaveLength(1);
    expect(earRan).toBe(true); // the ear still bookkeeps addressed traffic, after the fact
    await service.stop();
  });
});

describe("attention items (what she owes)", () => {
  test("open_ask records a debt that rides the wake prompt; her in-thread reply closes it optimistically", async () => {
    const { db, service, adapter, mindSessions } = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "open_ask", why: "julia asked for a ticket, unanswered", venueId: "C1", threadRootId: "9.0", askTs: "9.1" });
        await verdict.run({ decision: "wake", why: "julia is waiting on a ticket", venueId: "C1", threadRootId: "9.0" });
        return;
      }
      await tools.get("reply")!.run({ text: "filed it", venueId: "C1", threadRootId: "9.0" });
    });
    await service.start();
    adapter.emit(msg({ text: "can someone file this?", ts: "9.1", threadRootTs: "9.0" }));
    await service.idle();

    expect(mindSessions()[0]!.prompts[0]).toContain("[still owed]");
    expect(mindSessions()[0]!.prompts[0]).toContain("julia asked for a ticket");
    expect(adapter.posts.map((p) => p.text)).toContain("filed it");
    expect(openItems(db, "eng")).toHaveLength(0); // the reply into the thread settled the debt
    await service.stop();
  });

  test("the ear can reopen a debt whose answer didn't land", async () => {
    let earCalls = 0;
    let openedId = "";
    const { db, clock, service, adapter } = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (!verdict) return; // the mind stays idle in this test
      earCalls++;
      if (earCalls === 1) {
        await verdict.run({ decision: "open_ask", why: "sam needs the repro steps", venueId: "C1", threadRootId: "7.0", askTs: "7.1" });
        return;
      }
      await verdict.run({ decision: "reopen_ask", why: "that reply answered a different question", itemId: openedId });
    });
    await service.start();
    adapter.emit(msg({ text: "what are the repro steps?", ts: "7.1", threadRootTs: "7.0" }));
    await service.idle();
    openedId = openItems(db, "eng")[0]!.id;
    // simulate the optimistic close a reply would have done
    const { closeAttentionItem } = await import("../src/ledger/attention");
    closeAttentionItem(db, clock, openedId, "answered in thread");
    expect(openItems(db, "eng")).toHaveLength(0);
    // more chatter triggers the second ear pass, which reopens the debt by id
    adapter.emit(msg({ text: "that answer was about the other bug", ts: "7.2", threadRootTs: "7.0" }));
    await service.idle();
    expect(openItems(db, "eng").map((i) => i.id)).toEqual([openedId]);
    await service.stop();
  });

  test("the owed section is capped and an overdue item is flagged to the mind's own judgment", async () => {
    let earCalls = 0;
    const { clock, service, adapter, mindSessions } = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        if (earCalls === 1) {
          for (let i = 1; i <= 7; i++) {
            await verdict.run({ decision: "open_ask", why: `debt number ${i}`, venueId: "C1", threadRootId: `t${i}`, askTs: `${i}.1` });
          }
        }
        return;
      }
    });
    await service.start();
    adapter.emit(msg({ text: "a pile of asks", ts: "10.1" }));
    await service.idle();
    clock.set("2026-07-05T00:00:00Z"); // three days later — past the max age
    adapter.emit(msg({ text: "<@BOT1> morning", mentionsBotId: true, ts: "11.1" }));
    await service.idle();

    const prompt = mindSessions()[0]!.prompts[0]!;
    expect(prompt).toContain("[still owed]");
    expect(prompt).toContain("debt number 5");
    expect(prompt).not.toContain("debt number 6"); // capped at 5
    expect(prompt).toContain("(+2 newer ones not shown");
    expect(prompt).toContain("open a long time");
    await service.stop();
  });
});

describe("step_back (standing engagement state)", () => {
  test("stepping back routes thread replies to the ear; a fresh mention re-engages", async () => {
    let mindCalls = 0;
    const h = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "the humans have this one" });
        return;
      }
      mindCalls++;
      if (mindCalls === 1) await tools.get("reply")!.run({ text: "looking", venueId: "C1", threadRootId: "20.0" });
      if (mindCalls === 2) await tools.get("step_back")!.run({ why: "told to stop", venueId: "C1", threadRootId: "20.0" });
      if (mindCalls === 3) await tools.get("reply")!.run({ text: "back", venueId: "C1", threadRootId: "20.0" });
    });
    await h.service.start();
    // 1: mention in a thread → wake 1 replies (engaged via mention + her post)
    h.adapter.emit(msg({ text: "<@BOT1> can you check this?", mentionsBotId: true, ts: "20.1", threadRootTs: "20.0" }));
    await h.service.idle();
    // 2: a reply in the engaged thread (no mention) → thread_follow → wake 2 steps back
    h.adapter.emit(msg({ text: "actually we got it, stop", ts: "20.2", threadRootTs: "20.0" }));
    await h.service.idle();
    expect(h.mindSessions()).toHaveLength(2);
    // 3: another reply in the now stepped-back thread → observed → ear holds, mind stays asleep
    h.adapter.emit(msg({ text: "ok kate you take it", ts: "20.3", threadRootTs: "20.0" }));
    await h.service.idle();
    expect(h.mindSessions()).toHaveLength(2); // no new wake
    expect(h.earSessions().length).toBeGreaterThanOrEqual(1);
    // 4: a fresh mention re-engages regardless
    h.adapter.emit(msg({ text: "<@BOT1> ok actually help", mentionsBotId: true, ts: "20.4", threadRootTs: "20.0" }));
    await h.service.idle();
    expect(h.mindSessions()).toHaveLength(3);
    expect(h.adapter.posts.map((p) => p.text)).toContain("back");
    await h.service.stop();
  });
});

describe("delivery invariants hold under the ear", () => {
  test("nothing dangles: after any mix of held and promoted traffic, the inbox drains to empty on the next wake", async () => {
    const { db, service, adapter } = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "just chatter" });
        return;
      }
    });
    await service.start();
    adapter.emit(msg({ text: "one", ts: "30.1" }));
    adapter.emit(msg({ text: "two", ts: "30.2" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> three", mentionsBotId: true, ts: "30.3" }));
    await service.idle();
    expect(pendingMessages(db, "eng")).toHaveLength(0);
    await service.stop();
  });
});
