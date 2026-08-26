import { describe, expect, test } from "bun:test";
import { openLedger, one } from "../src/ledger/db";
import { fakeClock, refIn } from "./helpers";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { pendingConversations } from "../src/ledger/conversations";
import { openItems } from "../src/ledger/attention";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { DynamicTool } from "../src/turn-runner/types";
import type { RawMessage } from "@bevyl-ai/agent-tools";

// Ear attention pass conformance (SPEC §11).

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

// Scripts: ear sessions have `verdict`; resident sessions have `reply`.
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

describe("ear gates waking, never delivery", () => {
  // hold/wake without a ref bounce; with a ref they record durably.
  test("refless hold/wake bounces with correctable error", async () => {
    const verdictResults: { success: boolean; output: string }[] = [];
    const { db, adapter, service } = harness(async (_turn, tools, _act, prompt) => {
      const verdict = tools.get("verdict");
      if (!verdict) return; // the mind: nothing needed
      verdictResults.push(
        await verdict.run({ decision: "hold", why: "teammates have it" }),
        await verdict.run({ decision: "hold", why: "teammates have it", ref: refIn(prompt, "lunch") }),
      );
    });
    await service.start();
    adapter.emit(msg({ text: "who's in for lunch", ts: "3.1" }));
    await service.idle();

    expect(verdictResults[0]!.success).toBe(false);
    expect(verdictResults[0]!.output).toContain("needs ref");
    expect(verdictResults[1]!.success).toBe(true);
    // The recorded hold is durable judgment on the conversation row, not a discarded verdict.
    const row = one<{ holds: number }>(db, "SELECT holds FROM conversations WHERE venue_id = 'C1'");
    expect(row?.holds).toBe(1);
    await service.stop();
  });

  test("hold verdict wakes nobody; held lines appear on next wake verbatim", async () => {
    const { adapter, service, earSessions, mindSessions } = harness(async (_turn, tools, _act, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "teammates comparing lunch orders", ref: refIn(prompt, /<#C1>/) });
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

  test("wake verdict wakes resident; why-line rides prompt as first read", async () => {
    const { service, adapter, mindSessions } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "wake", why: "kite reported a paying customer blocked on export", ref: refIn(prompt, "export broken") });
        return;
      }
    });
    await service.start();
    adapter.emit(msg({ text: "export broken for kite's customer", ts: "3.1" }));
    await service.idle();

    expect(mindSessions()).toHaveLength(1);
    const prompt = mindSessions()[0]!.prompts[0]!;
    expect(prompt).toContain("export broken for kite's customer"); // verbatim delivery, not the gloss
    // her first read rides the conversation's own card header (one renderer, durable row)
    expect(prompt).toContain("first read: kite reported a paying customer blocked on export");
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

  test("mention bypasses ear hold; resident wakes immediately", async () => {
    let earRan = false;
    const { service, adapter, mindSessions } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) {
        earRan = true;
        return;
      }
      await tools.get("reply")!.run({ text: "here", ref: refIn(prompt, "quick one") });
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> quick one", mentionsBotId: true, ts: "5.1" }));
    await service.idle();

    expect(mindSessions()).toHaveLength(1);
    expect(earRan).toBe(true); // the ear still bookkeeps addressed traffic, after the fact
    await service.stop();
  });
});

describe("attention items (open debts)", () => {
  test("open_ask records debt on wake prompt; in-thread reply closes it", async () => {
    const { db, service, adapter, mindSessions } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "open_ask", why: "julia asked for a ticket, unanswered", ref: refIn(prompt, "file this") });
        await verdict.run({ decision: "wake", why: "julia is waiting on a ticket", ref: refIn(prompt, "file this") });
        return;
      }
      await tools.get("reply")!.run({ text: "filed it", ref: refIn(prompt, "file this") });
    });
    await service.start();
    adapter.emit(msg({ text: "can someone file this?", ts: "9.1", threadRootTs: "9.0" }));
    await service.idle();

    expect(mindSessions()[0]!.prompts[0]).toContain("[still owed]");
    expect(mindSessions()[0]!.prompts[0]).toContain("julia asked for a ticket");
    expect(adapter.streams.map((s) => s.text)).toContain("filed it"); // home reply streams (reply-stream.ts)
    expect(openItems(db, "eng")).toHaveLength(0); // the reply into the thread settled the debt
    await service.stop();
  });

  test("ear can reopen a debt whose answer did not land", async () => {
    let earCalls = 0;
    let openedId = "";
    const { db, clock, service, adapter } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (!verdict) return; // the mind stays idle in this test
      earCalls++;
      if (earCalls === 1) {
        await verdict.run({ decision: "open_ask", why: "sam needs the repro steps", ref: refIn(prompt, "repro steps") });
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
    closeAttentionItem(db, clock, "eng", openedId, "answered in thread");
    expect(openItems(db, "eng")).toHaveLength(0);
    // more chatter triggers the second ear pass, which reopens the debt by id
    adapter.emit(msg({ text: "that answer was about the other bug", ts: "7.2", threadRootTs: "7.0" }));
    await service.idle();
    expect(openItems(db, "eng").map((i) => i.id)).toEqual([openedId]);
    await service.stop();
  });

  test("anchor-less open_ask refused; askTs roots debt for step-back", async () => {
    // Live 2026-07-23: the ear recorded two QA debts with no thread coordinates; step_back and
    // in-thread answers settle by thread root, so the orphans rode every wake and were reopened
    // repeatedly. A top-level ask roots on its own ts (the router's convention).
    let earCalls = 0;
    let bad: { success: boolean; output: string } | undefined;
    const { db, service, adapter } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        if (++earCalls === 1) {
          bad = await verdict.run({ decision: "open_ask", why: "qa is needed on the preview" });
          await verdict.run({ decision: "open_ask", why: "qa is needed on the preview", ref: refIn(prompt, "preview") });
          await verdict.run({ decision: "wake", why: "an open qa request with no taker", ref: refIn(prompt, "preview") });
        }
        return;
      }
      await tools.get("step_back")!.run({ why: "not mine to claim", ref: refIn(prompt, "preview") });
    });
    await service.start();
    adapter.emit(msg({ text: "Needs QA: check the upload dialog", ts: "5.0" }));
    await service.idle();

    expect(bad!.success).toBe(false);
    expect(openItems(db, "eng")).toHaveLength(0); // the askTs-rooted debt settled with her step_back
    await service.stop();
  });

  test("operator-settled debt stays settled; ear reopen refused", async () => {
    let earCalls = 0;
    let openedId = "";
    let reopen: { success: boolean; output: string } | undefined;
    const { db, clock, service, adapter } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (!verdict) return; // the mind stays idle in this test
      if (++earCalls === 1) {
        await verdict.run({ decision: "open_ask", why: "qa still outstanding", ref: refIn(prompt, "needs qa") });
        return;
      }
      reopen = await verdict.run({ decision: "reopen_ask", why: "the work is still not done", itemId: openedId });
    });
    await service.start();
    adapter.emit(msg({ text: "needs qa", ts: "6.1", threadRootTs: "6.0" }));
    await service.idle();
    openedId = openItems(db, "eng")[0]!.id;
    const { closeAttentionItem } = await import("../src/ledger/attention");
    closeAttentionItem(db, clock, "eng", openedId, "operator: not her work");
    adapter.emit(msg({ text: "still not done", ts: "6.2", threadRootTs: "6.0" }));
    await service.idle();

    expect(reopen!.success).toBe(false);
    expect(openItems(db, "eng")).toHaveLength(0);
    await service.stop();
  });

  test("owed section capped; overdue item flagged for resident judgment", async () => {
    let earCalls = 0;
    const { clock, service, adapter, mindSessions } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        if (earCalls === 1) {
          // Verdicts bind to what the pass was shown: each debt roots at a real batch message.
          for (let i = 1; i <= 7; i++) {
            await verdict.run({ decision: "open_ask", why: `debt number ${i}`, ref: refIn(prompt, `ask number ${i}`) });
          }
        }
        return;
      }
    });
    await service.start();
    for (let i = 1; i <= 7; i++) adapter.emit(msg({ text: `ask number ${i}`, ts: `${i}.1` }));
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

describe("thread-follow judgment (SPEC §11)", () => {
  test("held thread reply on next wake; ear-judged wakes resident", async () => {
    let mindCalls = 0;
    let earCalls = 0;
    const h = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        // pass 2 sees the teammates' aside: hold. pass 3 sees the reply that is plainly hers: wake.
        if (earCalls === 3) await verdict.run({ decision: "wake", why: "kate is asking her to go ahead", ref: refIn(prompt, "go ahead") });
        else await verdict.run({ decision: "hold", why: "teammates talking to each other", ref: refIn(prompt, /<#C1>/) });
        return;
      }
      mindCalls++;
      if (mindCalls === 1) await tools.get("reply")!.run({ text: "on it", ref: refIn(prompt, /<#C1>/) });
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

  test("dead wake over thread traffic fails to log only (§14.2 address-only)", async () => {
    let earCalls = 0;
    const h = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        if (earCalls === 2) await verdict.run({ decision: "wake", why: "this thread needs her", ref: refIn(prompt, /<#C1>/) });
        else await verdict.run({ decision: "hold", why: "nothing yet", ref: refIn(prompt, /<#C1>/) });
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
  test("stepping back routes thread replies to ear; mention re-engages", async () => {
    let mindCalls = 0;
    let earCalls = 0;
    const h = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        // pass 2 carries the "stop" reply: plainly hers, wake her for it
        if (earCalls === 2) await verdict.run({ decision: "wake", why: "they are telling her to stop", ref: refIn(prompt, /<#C1>/) });
        else await verdict.run({ decision: "hold", why: "the humans have this one", ref: refIn(prompt, /<#C1>/) });
        return;
      }
      mindCalls++;
      if (mindCalls === 1) await tools.get("reply")!.run({ text: "looking", ref: refIn(prompt, /<#C1>/) });
      if (mindCalls === 2) await tools.get("step_back")!.run({ why: "told to stop", ref: refIn(prompt, /<#C1>/) });
      if (mindCalls === 3) await tools.get("reply")!.run({ text: "back", ref: refIn(prompt, /<#C1>/) });
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
    expect(h.adapter.streams.map((s) => s.text)).toContain("back"); // home reply streams (reply-stream.ts)
    await h.service.stop();
  });

  test("stepping back settles open debts; dropped convo stops on wakes", async () => {
    let earCalls = 0;
    const h = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earCalls++;
        if (earCalls === 1) {
          await verdict.run({ decision: "open_ask", why: "kate asked her to weigh in", ref: refIn(prompt, "weigh in") });
          await verdict.run({ decision: "wake", why: "kate asked her to weigh in", ref: refIn(prompt, "weigh in") });
        } else {
          await verdict.run({ decision: "hold", why: "nothing new", ref: refIn(prompt, /<#C1>/) });
        }
        return;
      }
      await tools.get("step_back")!.run({ why: "the humans have it", ref: refIn(prompt, "weigh in") });
    });
    await h.service.start();
    h.adapter.emit(msg({ text: "kate: bot should weigh in on this one", ts: "50.1", threadRootTs: "50.0" }));
    await h.service.idle();
    expect(openItems(h.db, "eng")).toHaveLength(0); // step_back closed the debt, not a reply
    await h.service.stop();
  });
});

describe("what the prompts carry", () => {
  test("prompt marks direct addresses [to you]; others unmarked", async () => {
    const h = harness(async (_turn, tools, _act, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "just chatter", ref: refIn(prompt, /<#C1>/) });
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

  test("an ear pass carries the already-heard tail of every thread its batch touches", async () => {
    // The ear design's "plus the live threads that delta touches". Live 2026-07-30: a pass
    // whose whole batch was one mid-thread line ("LMK if you wanna get in on browserstack")
    // had no way to see the offer was aimed at a teammate, and recorded the ask as hers.
    const h = harness(async (_turn, tools, _act, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) await verdict.run({ decision: "hold", why: "teammates talking to each other", ref: refIn(prompt, /<#C1>/) });
    });
    await h.service.start();
    h.adapter.emit(msg({ text: "Ready for QA: the safari fix", ts: "80.0", principalId: "U_PEDRO", principalName: "pedro" }));
    h.adapter.emit(msg({ text: "awesome work, I left a nit", ts: "80.1", threadRootTs: "80.0", principalName: "noah" }));
    await h.service.idle(); // pass 1 judges these with no earlier tail
    expect(h.earSessions()[0]!.prompts[0]).not.toContain("already heard");
    h.adapter.emit(msg({ text: "LMK if you wanna get in on browserstack", ts: "80.2", threadRootTs: "80.0", principalName: "noah" }));
    await h.service.idle(); // pass 2's batch is one line — the thread rides along
    const prompt = h.earSessions().at(-1)!.prompts[0]!;
    expect(prompt).toContain("earlier in <#C1> thread=80.0 (already heard");
    // ids arrive named (adapter roster, 0.5.0) — the ear sees people, not bare mentions
    expect(prompt).toContain("<@U_PEDRO> (pedro): Ready for QA: the safari fix");
    expect(prompt).toContain("<@U1> (noah): awesome work, I left a nit");
    expect(prompt).toContain("<@U1> (noah): LMK if you wanna get in on browserstack"); // the batch line itself
    await h.service.stop();
  });

  test("ear identity from standing doc principal id", async () => {
    const h = harness(async (_turn, tools, _act, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) await verdict.run({ decision: "hold", why: "nothing needed", ref: refIn(prompt, /<#C1>/) });
    });
    await h.service.start();
    h.adapter.emit(msg({ text: "chatter", ts: "81.1" }));
    await h.service.idle(); // an ear pass writes the standing doc
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("/tmp/ear-test/eng/AGENTS.md", "utf8")).toContain("In the room she is <@BOT1>.");
    await h.service.stop();
  });

  test("own reply and reaction appear on conversation card on next traffic", async () => {
    const h = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return;
      const reply = tools.get("reply")!;
      await reply.run({ text: "filed as BEV-99, high priority", ref: refIn(prompt, "file this please") });
      await tools.get("react")!.run({ emoji: "white_check_mark", ref: refIn(prompt, "file this please") });
    });
    await h.service.start();
    h.adapter.emit(msg({ text: "the export page 500s for me", ts: "70.0", principalId: "U_KATE", principalName: "kate" }));
    h.adapter.emit(msg({ text: "<@BOT1> file this please", mentionsBotId: true, ts: "70.1", threadRootTs: "70.0" }));
    await h.service.idle(); // the mind replies and reacts
    h.adapter.emit(msg({ text: "thanks! what priority did you give it?", ts: "70.2", threadRootTs: "70.0", principalId: "U_KATE" }));
    await h.service.idle();
    const earPrompt = h.earSessions().at(-1)!.prompts[0]!;
    // Not a digest — her acts are IN the conversation's tail, interleaved where they happened.
    expect(earPrompt).toContain("she: filed as BEV-99, high priority");
    expect(earPrompt).toContain("she reacted :white_check_mark: to ts=70.1");
    await h.service.stop();
  });
});

describe("delivery invariants hold with ear active", () => {
  test("after held/promoted mix, inbox drains empty on next wake", async () => {
    const { db, service, adapter } = harness(async (_turn, tools, _act, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "just chatter", ref: refIn(prompt, /<#C1>/) });
        return;
      }
    });
    await service.start();
    adapter.emit(msg({ text: "one", ts: "30.1" }));
    adapter.emit(msg({ text: "two", ts: "30.2" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> three", mentionsBotId: true, ts: "30.3" }));
    await service.idle();
    expect(pendingConversations(db, "eng")).toHaveLength(0);
    await service.stop();
  });
});
