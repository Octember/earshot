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
      await tools.get("reply")!.run({ text: "here", venueId: "C1", threadRootId: "5.1" });
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

describe("thread-follow is the ear's to judge (SPEC §11)", () => {
  test("a held thread reply wakes nobody and rides the next wake verbatim; one the ear judges hers wakes the mind", async () => {
    let mindCalls = 0;
    let earCalls = 0;
    const h = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        // pass 2 sees the teammates' aside: hold. pass 3 sees the reply that is plainly hers: wake.
        if (earCalls === 3) await verdict.run({ decision: "wake", why: "kate is asking her to go ahead", venueId: "C1", threadRootId: "40.0" });
        else await verdict.run({ decision: "hold", why: "teammates talking to each other" });
        return;
      }
      mindCalls++;
      if (mindCalls === 1) await tools.get("reply")!.run({ text: "on it", venueId: "C1", threadRootId: "40.0" });
    });
    await h.service.start();
    // 1: mention → immediate wake (engages the thread)
    h.adapter.emit(msg({ text: "<@BOT1> take a look?", mentionsBotId: true, ts: "40.1", threadRootTs: "40.0" }));
    await h.service.idle();
    expect(h.mindSessions()).toHaveLength(1);
    // 2: a teammate's aside in the engaged thread → thread_follow → the ear holds, no wake
    h.adapter.emit(msg({ text: "we can probably wait on that", ts: "40.2", threadRootTs: "40.0", principalId: "U2" }));
    await h.service.idle();
    expect(h.mindSessions()).toHaveLength(1);
    // the ear saw the aside marked as thread traffic, not as a wake it slept through
    expect(h.earSessions().at(-1)!.prompts[0]).toContain("[a thread she is part of]");
    // 3: a thread reply the ear judges hers → the mind wakes, held aside riding along verbatim
    h.adapter.emit(msg({ text: "go ahead when you can", ts: "40.3", threadRootTs: "40.0", principalId: "U2" }));
    await h.service.idle();
    expect(h.mindSessions()).toHaveLength(2);
    const prompt = h.mindSessions()[1]!.prompts[0]!;
    expect(prompt).toContain("we can probably wait on that");
    expect(prompt).toContain("go ahead when you can");
    await h.service.stop();
  });

  test("a dead wake over thread chatter fails into the log, never the room (§14.2 is direct-address-only)", async () => {
    let earCalls = 0;
    const h = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        if (earCalls === 2) await verdict.run({ decision: "wake", why: "this thread needs her", venueId: "C1", threadRootId: "45.0" });
        else await verdict.run({ decision: "hold", why: "nothing yet" });
        return;
      }
      throw new Error("mind runtime exploded");
    });
    await h.service.start();
    // engage the thread via a mention whose wake DIES — the fallback answers the direct address
    h.adapter.emit(msg({ text: "<@BOT1> check this", mentionsBotId: true, ts: "45.1", threadRootTs: "45.0" }));
    await h.service.idle();
    const fallbacks = h.adapter.posts.filter((p) => p.text.includes("can't run right now"));
    expect(fallbacks).toHaveLength(1);
    // a thread_follow-only wake that dies posts NOTHING — ledger/log only
    h.adapter.emit(msg({ text: "still seeing it btw", ts: "45.2", threadRootTs: "45.0", principalId: "U2" }));
    await h.service.idle();
    expect(h.adapter.posts.filter((p) => p.text.includes("can't run right now"))).toHaveLength(1); // no new fallback
    await h.service.stop();
  });
});

describe("step_back (standing engagement state)", () => {
  test("stepping back routes thread replies to the ear; a fresh mention re-engages", async () => {
    let mindCalls = 0;
    let earCalls = 0;
    const h = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        // pass 2 carries the "stop" reply: plainly hers, wake her for it
        if (earCalls === 2) await verdict.run({ decision: "wake", why: "they are telling her to stop", venueId: "C1", threadRootId: "20.0" });
        else await verdict.run({ decision: "hold", why: "the humans have this one" });
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
    // 2: a reply in the engaged thread (no mention) → thread_follow → the ear wakes her → wake 2 steps back
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

  test("stepping back settles the thread's open debts — a dropped conversation stops riding wakes", async () => {
    let earCalls = 0;
    const h = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        if (earCalls === 1) {
          await verdict.run({ decision: "open_ask", why: "kate asked her to weigh in", venueId: "C1", threadRootId: "50.0", askTs: "50.1" });
          await verdict.run({ decision: "wake", why: "kate asked her to weigh in", venueId: "C1", threadRootId: "50.0" });
        } else {
          await verdict.run({ decision: "hold", why: "nothing new" });
        }
        return;
      }
      await tools.get("step_back")!.run({ why: "the humans have it", venueId: "C1", threadRootId: "50.0" });
    });
    await h.service.start();
    h.adapter.emit(msg({ text: "kate: bot should weigh in on this one", ts: "50.1", threadRootTs: "50.0" }));
    await h.service.idle();
    expect(openItems(h.db, "eng")).toHaveLength(0); // step_back closed the debt, not a reply
    await h.service.stop();
  });
});

describe("what the prompts carry", () => {
  test("the mind's prompt marks direct addresses [to you]; ride-along chatter is unmarked", async () => {
    const h = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "just chatter" });
        return;
      }
    });
    await h.service.start();
    h.adapter.emit(msg({ text: "the deploy is slow today", ts: "60.1" }));
    await h.service.idle(); // held — rides the next wake
    h.adapter.emit(msg({ text: "<@BOT1> can you check?", mentionsBotId: true, ts: "60.2" }));
    await h.service.idle();
    const lines = h.mindSessions()[0]!.prompts[0]!.split("\n");
    expect(lines.find((l) => l.includes("deploy is slow"))).not.toContain("[to you]");
    expect(lines.find((l) => l.includes("can you check?"))).toContain("[to you]");
    await h.service.stop();
  });

  test("the ear is shown what she said and reacted to since its last listen", async () => {
    const h = harness(async (_turn, tools) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "nothing needed" });
        return;
      }
      await tools.get("reply")!.run({ text: "filed it, link is in the ticket", venueId: "C1", threadRootId: "70.0" });
      await tools.get("react")!.run({ emoji: "white_check_mark", venueId: "C1", ts: "70.1" });
    });
    await h.service.start();
    h.adapter.emit(msg({ text: "<@BOT1> file this please", mentionsBotId: true, ts: "70.1", threadRootTs: "70.0" }));
    await h.service.idle(); // the mind replies and reacts; ear pass 1 bookkeeps
    h.adapter.emit(msg({ text: "unrelated chatter", ts: "71.1", principalId: "U2" }));
    await h.service.idle();
    const earPrompt = h.earSessions().at(-1)!.prompts[0]!;
    expect(earPrompt).toContain("what she has said and done since your last listen");
    expect(earPrompt).toContain("she replied in <#C1> thread=70.0: filed it, link is in the ticket");
    expect(earPrompt).toContain("she reacted :white_check_mark: to ts=70.1 in <#C1>");
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
