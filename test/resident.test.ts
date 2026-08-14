import { describe, expect, test } from "bun:test";
import { one, openLedger } from "../src/ledger/db";
import { isRecord, parseJson } from "../src/guard";
import { PolicyStore } from "../src/policy/load";
import { Service } from "../src/service";
import { pendingConversations } from "../src/ledger/conversations";
import { FakeAdapter } from "./fakes/fake-adapter";
import { FakeAgentRuntimeSession } from "./fakes/fake-runtime-session";
import type { DynamicTool } from "../src/turn-runner/types";
import type { RawMessage } from "@bevyl-ai/agent-tools";
import { fakeClock, refIn } from "./helpers";

// The Collapse (specs/2026-07-13-the-collapse-design.md), amended: every wake runs on a fresh
// runtime thread (SPEC §11 "No thread survives its wake") — inbox messages delivered verbatim,
// continuity via the standing document + ledger, restart-durable delivery. These are the
// loop's conformance rows.

function firstSearchRef(output: string): string {
  const parsed = parseJson(output);
  if (!Array.isArray(parsed)) throw new Error("search output is not an array");
  for (const h of parsed) {
    if (isRecord(h) && typeof h.ref === "string") return h.ref;
  }
  throw new Error("no search ref");
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

const seededClock = () => "2026-07-01T00:00:00Z";

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

  test("§11: successive wakes start FRESH threads — no wake resumes a prior one; the prompt is ONLY the messages", async () => {
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
    expect(minds()[1]!.lastThreadOp!.op).toBe("start");
    expect(minds()[1]!.lastThreadOp!.id).not.toBe(minds()[0]!.lastThreadOp!.id);
    // the digest is standing knowledge (AGENTS.md), never turn input
    expect(minds()[0]!.prompts[0]!).not.toContain("Your tools");
    expect(minds()[0]!.prompts[0]!).toContain("[to you] [<#C1>"); // a mention line is marked as spoken TO her (after its ref tag)
    expect(minds()[1]!.prompts[0]!).toContain("<@BOT1> two");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("/tmp/eng/AGENTS.md", "utf8")).toContain("## Your tools (as eng)");
    await service.stop();
  });

  test("§11 her own words ride the conversation: a later wake of the same thread reads her post inline, in place", async () => {
    let wakes = 0;
    const { adapter, service, minds } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return; // the ear bookkeeps quietly
      if (++wakes === 1) await tools.get("reply")!.run({ text: "shipping the fix now", ref: refIn(prompt, "status?") });
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> status?", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> and now?", mentionsBotId: true, ts: "1.2", threadRootTs: "1.0" }));
    await service.idle();

    // Not a [what you did recently] digest — the tail of the conversation itself, her words
    // interleaved where they happened, from the acts ledger (restart-durable).
    expect(minds()[0]!.prompts[0]!).not.toContain("you: ");
    const second = minds()[1]!.prompts[0]!;
    expect(second).toContain("already heard");
    expect(second).toContain("you: shipping the fix now");
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
    expect(pendingConversations(db, "eng")).toHaveLength(0);
    await second.service.stop();
  });

  test("delivery commits AFTER the wake, never at assembly — a process death mid-turn leaves the batch undelivered for the next boot (review finding #1)", async () => {
    let assembled: (() => void) | undefined;
    const assembledSeen = new Promise<void>((r) => (assembled = r));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { db, adapter, service } = harness(async (_turn, tools, _mark, _prompt) => {
      if (tools.get("verdict")) return;
      assembled!(); // the prompt exists — assembly is done
      await gate; // the "process" hangs mid-turn
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> did you see this?", mentionsBotId: true, ts: "5.5" }));
    await assembledSeen;

    // Mid-wake, pre-completion: the watermark MUST still be unadvanced — this is exactly what a
    // crash-and-reboot would read, and it must re-deliver (SPEC §11 "a crash re-delivers").
    const stillPending = pendingConversations(db, "eng");
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]!.messages[0]!.text).toContain("did you see this?");

    release!(); // let the turn finish; the finally commits delivery
    await service.idle();
    expect(pendingConversations(db, "eng")).toHaveLength(0);
    await service.stop();
  });

  test("the reply-gate bounce card is a peek — it never advances the watermark or consumes the judgment (review finding #3)", async () => {
    let mindWakes = 0;
    const { db, adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        const seen = /held chatter|watch this|drop it/;
        if (seen.test(prompt)) await verdict.run({ decision: "hold", why: "they have it", ref: refIn(prompt, seen) });
        return;
      }
      mindWakes++;
      if (mindWakes === 2) {
        await tools.get("step_back")!.run({ why: "leaving this one", ref: refIn(prompt, "drop it") });
      } else if (mindWakes === 3) {
        // The stepped-out conversation isn't in this wake — the only way to address it is a
        // search-minted ref, which bounces with the card.
        const searchRef = firstSearchRef((await tools.get("search")!.run({ query: "watch this" })).output);
        await tools.get("reply")!.run({ text: "a stale take", ref: searchRef }); // bounces
        // ...and she chooses NOT to re-send after reading the card.
      }
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> watch this", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> drop it", mentionsBotId: true, ts: "1.1", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    adapter.emit(msg({ text: "held chatter she has not seen", ts: "1.2", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> unrelated: status?", mentionsBotId: true, ts: "9.0" }));
    await service.idle();

    // The bounce rendered a card, but the held chatter is still undelivered and the hold intact:
    // a card shows at most a tail — it must never mark a backlog delivered unseen.
    const row = one<{ delivered_rowid: number; holds: number }>(
      db,
      "SELECT delivered_rowid, holds FROM conversations WHERE venue_id = 'C1' AND thread_root_id = '1.0'",
    )!;
    const chatterRowid = (one<{ rowid: number }>(db, "SELECT rowid FROM events WHERE json_extract(payload, '$.ts') = '1.2'")!).rowid;
    expect(row.delivered_rowid).toBeLessThan(chatterRowid);
    expect(row.holds).toBeGreaterThanOrEqual(1); // NOT zeroed — the bounce didn't consume the judgment
    await service.stop();
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
      async (_turn, tools, _mark, prompt) => {
        if (tools.get("verdict")) return; // the ear bookkeeps quietly
        calls++;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 300)); // dead air past the 40ms envelope
          return;
        }
        await tools.get("reply")!.run({ text: "back — answering now", ref: refIn(prompt, "you there?") });
      },
      openLedger(":memory:"),
      yaml,
    );
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> you there?", mentionsBotId: true, ts: "8.5" }));
    await service.idle();

    expect(minds()).toHaveLength(2);
    expect(adapter.posts).toHaveLength(0);
    expect(adapter.streams).toHaveLength(1); // one wake, one streamed home reply — retries share it
    expect(adapter.lastStreamText()).toBe("back — answering now");
    await service.stop();
  });

  test("§14.2: a wake that acted without answering is NOT replayed, and the fallback still fires", async () => {
    // The script runs for every session the service spawns — the task's execution and the
    // outcome-report wake included. Act exactly once, and let the spawned execution finish
    // its task cleanly, or the test loops (task_create per wake / yield-redispatch forever).
    let acted = false;
    const { adapter, service, db } = harness(async (_turn, tools, _act, prompt) => {
      const complete = tools.get("task_complete");
      if (complete) {
        await complete.run({ report: "done" });
        return;
      }
      const taskCreate = tools.get("task_create");
      if (!taskCreate || acted) return;
      acted = true;
      await taskCreate.run({ title: "file the export bug", spec: "repro + ticket", ref: refIn(prompt, "file this") });
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
    const { adapter, service, minds } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return; // the ear bookkeeps quietly
      calls++;
      if (calls === 1) throw new Error("model request blackholed");
      await tools.get("reply")!.run({ text: "here — filing it", ref: refIn(prompt, /file this/) });
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> file this", mentionsBotId: true, ts: "8.1" }));
    await service.idle();

    expect(minds()).toHaveLength(2); // the dead attempt, then its retry
    expect(adapter.posts).toHaveLength(0);
    expect(adapter.lastStreamText()).toBe("here — filing it");
    await service.stop();
  });

  test("§14.2 fallback is suppressed when the wake already answered the addressed thread before dying — and an acted wake is never replayed", async () => {
    const { adapter, service, minds } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return; // the ear bookkeeps quietly
      await tools.get("reply")!.run({ text: "on it — checking now", ref: refIn(prompt, /urgent/) });
      throw new Error("runtime exploded mid-wake");
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> urgent — prod?", mentionsBotId: true, ts: "9.1" }));
    await service.idle();

    // the reply landed; nobody is left hanging, so the harness stays silent and doesn't retry
    expect(minds()).toHaveLength(1);
    expect(adapter.posts).toHaveLength(0);
    expect(adapter.lastStreamText()).toBe("on it — checking now");
    await service.stop();
  });

  test("§14.2 fallback is suppressed when the wake reacted to the addressed message before dying", async () => {
    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      await tools.get("react")!.run({ emoji: "eyes", ref: refIn(prompt, "seen this?") });
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

  test("a task born in a wake homes to the conversation that addressed her", async () => {
    let sessions = 0;
    const { adapter, service, db } = harness(async (_n, t, _act, prompt) => {
      // 1: the wake that delegates; 2: the worker; 3+: the report wake (does nothing)
      const which = ++sessions;
      if (which === 1) await t.get("task_create")!.run({ title: "dig", spec: "dig in", ref: refIn(prompt, /<#C1>/) });
      if (which === 2) await t.get("task_complete")!.run({ report: "done" });
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> dig into it", mentionsBotId: true, ts: "77.1", threadRootTs: "77.0" }));
    await service.idle();

    const row = one<{ home_venue_id: string; home_thread_root_id: string }>(db, "SELECT home_venue_id, home_thread_root_id FROM tasks");
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
    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      const reply = tools.get("reply");
      if (!reply) return; // the ear
      const bare = await reply.run({ text: "the export fix landed" });
      expect(bare.success).toBe(false);
      rejected.push(bare.output);
      // Coordinates are not a thing a reply can carry — addressing is the ref, minted by the
      // line she is answering. No batch-home guessing is even expressible.
      await reply.run({ text: "the export fix landed", ref: refIn(prompt, "what broke?") });
    }, db);
    await service.start();
    await service.idle(); // flushes the boot wake carrying both conversations

    expect(rejected[0]).toContain("is not a ref");
    // The reply rides a native stream seated in ITS OWN conversation — streams are created
    // per conversation at her first ref-addressed post, not pre-seated on a batch-tail guess.
    expect(adapter.posts).toHaveLength(0);
    expect(adapter.streams).toHaveLength(1);
    expect(adapter.streams[0]!.venueId).toBe("C1"); // where the answer belongs...
    expect(adapter.streams[0]!.threadTs).toBe("1.0"); // ...in ITS thread, not the batch's last
    expect(adapter.streams[0]!.text).toBe("the export fix landed");
    await service.stop();
  });

  // Same live defect, task edition (2026-08-13, T-354): a wake batch spanning two conversations,
  // and the task homed to whichever one the harness guessed (the batch's last address) — so the
  // worker's report answered an adjacent incident. task_create homes by HER ref or not at all.
  test("§11: a task homes to the ref'd conversation, not the batch's last address — a refless task_create is rejected", async () => {
    const db = openLedger(":memory:");
    const seed = db.query(
      `INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
       VALUES (?, ?, 'addressed_message', 'eng', ?, ?, 'U1', ?, '2026-07-01T00:00:00Z')`,
    );
    seed.run("e1", "k1", "C1", "1.0", JSON.stringify({ text: "<@BOT1> alert burst, investigate", ts: "1.1", addressMode: "mention" }));
    seed.run("e2", "k2", "C2", null, JSON.stringify({ text: "<@BOT1> pull it together blacksmith", ts: "2.0", addressMode: "mention" }));
    db.query("UPDATE events SET principal_id = 'U2' WHERE id = 'e2'").run(); // a different asker tails the batch

    const rejected: string[] = [];
    const { service } = harness(async (_turn, tools, _mark, prompt) => {
      const taskCreate = tools.get("task_create");
      if (!taskCreate) return; // the ear / the worker (which never reaches its report here)
      const bare = await taskCreate.run({ title: "dig", spec: "s" });
      expect(bare.success).toBe(false);
      rejected.push(bare.output);
      await taskCreate.run({ title: "dig", spec: "s", ref: refIn(prompt, "alert burst") });
    }, db);
    await service.start();
    await service.idle(); // flushes the boot wake carrying both conversations

    expect(rejected[0]).toContain("is not a ref");
    const row = one<{ home_venue_id: string; home_thread_root_id: string | null; sponsor_id: string; origin_event_id: string }>(
      db,
      "SELECT home_venue_id, home_thread_root_id, sponsor_id, origin_event_id FROM tasks",
    );
    expect(row?.home_venue_id).toBe("C1"); // the incident's thread...
    expect(row?.home_thread_root_id).toBe("1.0"); // ...not C2, the batch's last-addressed guess
    // Provenance binds to the ref too: sponsor and origin are the ref'd message's speaker and
    // event — not U2/e2, the batch-tail pick that survived the first T-354 fix in these columns.
    expect(row?.sponsor_id).toBe("U1");
    expect(row?.origin_event_id).toBe("e1");
    await service.stop();
  });

  // Audit 2026-08-13, §14.2 batch-granularity: `direct.at(-1)` used to apologize to ONE
  // conversation when several addressed her, and one wake-scoped answered boolean let any
  // answer anywhere silence every other owed room. The fallback is per owed conversation.
  test("§14.2: a dead wake owing two conversations apologizes in each; an answered one is skipped", async () => {
    const db = openLedger(":memory:");
    const seed = db.query(
      `INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
       VALUES (?, ?, 'addressed_message', 'eng', ?, ?, 'U1', ?, '2026-07-01T00:00:00Z')`,
    );
    seed.run("e1", "k1", "C1", "1.0", JSON.stringify({ text: "<@BOT1> what broke?", ts: "1.1", addressMode: "mention" }));
    seed.run("e2", "k2", "C2", "2.0", JSON.stringify({ text: "<@BOT1> status?", ts: "2.1", addressMode: "mention" }));

    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (!tools.get("reply")) return; // the ear
      // She answers C1, then the runtime dies before C2 — C2 alone is owed the fallback.
      await tools.get("reply")!.run({ text: "looking", ref: refIn(prompt, "what broke?") });
      throw new Error("runtime died mid-wake");
    }, db);
    await service.start();
    await service.idle();

    const fallbacks = adapter.posts.filter((p) => p.text.includes("can't run right now"));
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.venueId).toBe("C2"); // the unanswered asker...
    expect(fallbacks[0]!.threadRootTs).toBe("2.0"); // ...in their own thread
    await service.stop();
  });

  test("§14.2: a dead wake that answered nobody apologizes once per owed conversation, each in its own thread", async () => {
    const db = openLedger(":memory:");
    const seed = db.query(
      `INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
       VALUES (?, ?, 'addressed_message', 'eng', ?, ?, 'U1', ?, '2026-07-01T00:00:00Z')`,
    );
    seed.run("e1", "k1", "C1", "1.0", JSON.stringify({ text: "<@BOT1> what broke?", ts: "1.1", addressMode: "mention" }));
    seed.run("e2", "k2", "C2", "2.0", JSON.stringify({ text: "<@BOT1> status?", ts: "2.1", addressMode: "mention" }));

    const { adapter, service } = harness(async (_turn, tools) => {
      if (!tools.get("reply")) return; // the ear
      throw new Error("runtime died before any answer");
    }, db);
    await service.start();
    await service.idle();

    const fallbacks = adapter.posts.filter((p) => p.text.includes("can't run right now"));
    const where = fallbacks.map((p) => `${p.venueId}:${p.threadRootTs}`).toSorted();
    expect(where).toEqual(["C1:1.0", "C2:2.0"]); // one per owed conversation — nobody left hanging
    await service.stop();
  });

  // §14.2 restart-duplicate: a wake that dies AFTER its post lands (before the delivery commit)
  // re-delivers the SAME batch to a fresh wake (new wake id — the acts UNIQUE can't dedupe
  // across wakes), which may re-decide the exact same words. The room must not hear them twice.
  // The discriminator is arrival order: in a genuine re-delivery no message in the conversation
  // postdates the landed act.
  test("a re-delivered batch re-deciding identical landed words is not re-posted", async () => {
    const db = openLedger(":memory:");
    // The batch: a mention that arrived at 23:50 — and a prior wake's act answering it that
    // LANDED at 23:55, after which that wake died before committing delivery (no conversations
    // row: the watermark never advanced, so boot re-delivers the same mention).
    db.query(
      `INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
       VALUES ('e1', 'k1', 'addressed_message', 'eng', 'C1', '30.0', 'U1', ?, '2026-07-01T23:50:00Z')`,
    ).run(JSON.stringify({ text: "<@BOT1> status?", ts: "30.1", addressMode: "mention" }));
    db.query(
      `INSERT INTO acts (wake_id, act_key, identity_id, kind, venue_id, thread_root_id, ts, text, at)
       VALUES ('w-prior', 'k-prior', 'eng', 'posted', 'C1', '30.0', '30.9', 'shipping the fix now', '2026-07-01T23:55:00Z')`,
    ).run();
    const { adapter, service, minds } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return; // the ear
      const r = await tools.get("reply")!.run({ text: "shipping the fix now", ref: refIn(prompt, "status?") });
      expect(r.success).toBe(true);
      expect(r.output).toContain("already posted"); // told the truth, not a phantom "posted"
    }, db);
    await service.start();
    await service.idle(); // the boot wake re-delivers the batch

    expect(minds()).toHaveLength(1); // the wake ran and succeeded...
    expect(adapter.posts).toHaveLength(0); // ...but nothing reached the surface twice
    expect(adapter.streams.filter((s) => s.text.length > 0)).toHaveLength(0);
    expect(adapter.posts.filter((p) => p.text.includes("can't run"))).toHaveLength(0); // and no apology: the convo counts answered
    await service.stop();
  });

  // The mirror image (review 2026-08-13, reproduced): two DIFFERENT people asking two different
  // questions in one thread, minutes apart, both honestly answered with the same short words —
  // the second answer is a new decision (a newer message arrived after the landed act) and MUST
  // reach the room. Text equality alone must never eat a real answer.
  test("the same short answer to a NEW question minutes later posts — dedupe never eats a real reply", async () => {
    const { adapter, clock, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return; // the ear
      if (prompt.includes("should I merge?")) {
        await tools.get("reply")!.run({ text: "yes", ref: refIn(prompt, "should I merge?") });
        return;
      }
      const r = await tools.get("reply")!.run({ text: "yes", ref: refIn(prompt, "rebase first?") });
      expect(r.success).toBe(true);
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> should I merge?", mentionsBotId: true, ts: "50.1", threadRootTs: "50.0", principalId: "U_A" }));
    await service.idle();
    clock.set("2026-07-02T00:04:00Z"); // four minutes later — inside the dedupe window
    adapter.emit(msg({ text: "<@BOT1> rebase first?", mentionsBotId: true, ts: "50.2", threadRootTs: "50.0", principalId: "U_B" }));
    await service.idle();

    const words = adapter.streams.filter((s) => s.text === "yes");
    expect(words).toHaveLength(2); // BOTH askers got their answer on the surface
    await service.stop();
  });

  test("a crash-looping wake does not stack identical §14.2 apologies in one room", async () => {
    const { adapter, service } = harness(async (_turn, tools) => {
      if (!tools.get("reply")) return; // the ear
      throw new Error("runtime keeps dying");
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> you there?", mentionsBotId: true, ts: "40.1", threadRootTs: "40.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> hello?", mentionsBotId: true, ts: "40.2", threadRootTs: "40.0" }));
    await service.idle();

    const apologies = adapter.posts.filter((p) => p.text.includes("can't run right now"));
    expect(apologies).toHaveLength(1); // one per room per window, however many wakes die
    await service.stop();
  });

  // Review 2026-08-13: the wake stopped passing originEventId and task_steer/task_cancel died
  // for EVERY live resident turn while the whole suite stayed green — the toolset tests
  // hand-built their context. These run through Service.runWake()'s own toolset, so the wiring
  // itself is what's under test. Steers bind their source event to the ref's provenance.
  test("task_steer and task_cancel work through a real wake, sourced from the asking message's ref", async () => {
    const { db, adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (!tools.get("reply")) return; // the ear
      const taskCreate = tools.get("task_create");
      if (!taskCreate) return;
      if (!prompt.includes("check canary too")) {
        await taskCreate.run({ title: "watch", spec: "watch it", ref: refIn(prompt, "watch the deploy") });
        return;
      }
      const steerRef = refIn(prompt, "check canary too");
      const steered = await tools.get("task_steer")!.run({ taskId: "T-1", kind: "guidance", text: "check canary too", ref: steerRef });
      expect(steered.success).toBe(true);
      const cancelled = await tools.get("task_cancel")!.run({ taskId: "T-1", report: "asked to stop", ref: steerRef });
      expect(cancelled.success).toBe(true);
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> watch the deploy", mentionsBotId: true, ts: "90.1", threadRootTs: "90.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> check canary too, actually just stop", mentionsBotId: true, ts: "90.2", threadRootTs: "90.0", principalId: "U3" }));
    await service.idle();

    const task = one<{ status: string }>(db, "SELECT status FROM tasks WHERE id = 'T-1'");
    expect(task?.status).toBe("cancelled");
    const steer = one<{ source_event_id: string }>(db, "SELECT source_event_id FROM steering WHERE kind = 'guidance'");
    const askEvent = one<{ id: string }>(db, "SELECT id FROM events WHERE json_extract(payload, '$.ts') = '90.2'");
    expect(steer?.source_event_id).toBe(askEvent!.id); // provenance = the message that asked
    await service.stop();
  });

  // Review 2026-08-13, same class as the steer/cancel wiring loss: task_confirm through the
  // REAL wake toolset — the approver recorded is the SPEAKER of the ref'd approval line, and a
  // conversation-level ref (whoever-spoke-last ambiguity) bounces.
  test("task_confirm through a real wake records the ref'd speaker as approver; a conversation ref bounces", async () => {
    const db = openLedger(":memory:");
    // A task already waiting on a human go-ahead (the §10.2 state a confirm resolves) — seeded
    // via the ledger's own transitions so the wake under test is purely the approval turn.
    const { createTask, transition, requestConfirmation } = await import("../src/ledger/tasks");
    db.query("INSERT INTO events (id, dedup_key, kind, identity_id, received_at) VALUES ('e0','k0','addressed_message','eng','2026-07-01T00:00:00Z')").run();
    createTask(db, seededClock, { id: "T-1", identityId: "eng", title: "send", spec: "send the mail", sponsorId: "U1", homeAnchor: { venueId: "C1", threadRootId: "60.0" }, originEventId: "e0" });
    transition(db, seededClock, "T-1", "active", { type: "dispatch", executionId: "x1" });
    requestConfirmation(db, seededClock, { taskId: "T-1", actionRef: "send_email:x", description: "send it?", nudgeDeadline: "2026-07-03T00:00:00Z" });

    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      const confirm = tools.get("task_confirm");
      if (!confirm) return; // the ear / a worker
      const convoRef = refIn(prompt, /^\[r\d+ <#C1>/); // the conversation HEADER ref
      const loose = await confirm.run({ taskId: "T-1", approve: true, ref: convoRef });
      expect(loose.success).toBe(false);
      expect(loose.output).toContain("not a message ref");
      const done = await confirm.run({ taskId: "T-1", approve: true, ref: refIn(prompt, "ship it") });
      expect(done.success).toBe(true);
    }, db);
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> ship it", mentionsBotId: true, ts: "60.2", threadRootTs: "60.0", principalId: "U_APPROVER" }));
    await service.idle();

    const row = one<{ pending_confirmation: string }>(db, "SELECT pending_confirmation FROM tasks WHERE id = 'T-1'");
    const resolution = JSON.parse(row?.pending_confirmation ?? "{}").resolution;
    expect(resolution?.approved).toBe(true);
    expect(resolution?.principalId).toBe("U_APPROVER"); // the speaker of the ref'd line — never a batch-level pick
    await service.stop();
  });

  // Audit 2026-08-13: a react's ledger residence used to be re-derived from the wake's pending
  // batch — a react on a TAIL line (delivered in an earlier wake) filed at the surface and
  // rendered in the wrong conversation later. Residence comes from the ref target itself.
  test("a react on a tail line files its act into that line's thread, not the surface", async () => {
    let wakes = 0;
    const { db, adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (!tools.get("reply")) return; // the ear
      wakes++;
      if (wakes === 1) return; // first wake delivers the root ask; she holds her tongue
      await tools.get("react")!.run({ emoji: "eyes", ref: refIn(prompt, "root ask") }); // the TAIL line
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> root ask", mentionsBotId: true, ts: "77.1", threadRootTs: "77.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> did you see it?", mentionsBotId: true, ts: "77.9", threadRootTs: "77.0" }));
    await service.idle();

    const act = one<{ venue_id: string; thread_root_id: string | null; ts: string }>(db, "SELECT venue_id, thread_root_id, ts FROM acts WHERE kind = 'reacted'");
    expect(act?.ts).toBe("77.1"); // the tail line she reacted to...
    expect(act?.thread_root_id).toBe("77.0"); // ...filed in ITS thread — never the surface
    expect(adapter.reactions.at(-1)).toMatchObject({ venueId: "C1", messageId: "77.1", emoji: "eyes" });
    await service.stop();
  });

  // Audit 2026-08-13: checklist was the one posting tool with no ref — its cards could only
  // land on the wake's guessed home. Now the model seats it, and each conversation she speaks
  // into gets its own native stream: cards ride the seat's stream, not the batch tail's.
  test("a checklist seats on its ref'd conversation's stream in a two-conversation wake", async () => {
    const db = openLedger(":memory:");
    const seed = db.query(
      `INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
       VALUES (?, ?, 'addressed_message', 'eng', ?, ?, 'U1', ?, '2026-07-01T00:00:00Z')`,
    );
    seed.run("e1", "k1", "C1", "1.0", JSON.stringify({ text: "<@BOT1> quick one", ts: "1.1", addressMode: "mention" }));
    seed.run("e2", "k2", "C2", "2.0", JSON.stringify({ text: "<@BOT1> the long migration", ts: "2.1", addressMode: "mention" }));

    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (!tools.get("reply")) return; // the ear
      const longRef = refIn(prompt, "long migration");
      await tools.get("reply")!.run({ text: "62 done", ref: refIn(prompt, "quick one") });
      await tools.get("checklist")!.run({ items: [{ text: "migrate tables", done: false }], ref: longRef });
      await tools.get("reply")!.run({ text: "starting the migration", ref: longRef });
    }, db);
    await service.start();
    await service.idle();

    // Each conversation streams its own reply — no plain posts, no shared seat.
    expect(adapter.posts).toHaveLength(0);
    expect(adapter.streams).toHaveLength(2);
    const byVenue = new Map(adapter.streams.map((s) => [s.venueId, s]));
    expect(byVenue.get("C1")?.text).toBe("62 done");
    expect(byVenue.get("C2")?.text).toBe("starting the migration");
    // The cards ride the C2 stream — the conversation SHE said the work is for.
    const cardMessages = new Set(adapter.taskCards.map((c) => c.messageId));
    expect(cardMessages).toEqual(new Set([byVenue.get("C2")!.messageId]));
    await service.stop();
  });

  // Same live defect, task edition (2026-08-13, T-354): a wake batch spanning two conversations,
  // and the task homed to whichever one the harness guessed (the batch's last address) — so the
  // worker's report answered an adjacent incident. task_create homes by HER ref or not at all.
  test("§11: a task homes to the ref'd conversation, not the batch's last address — a refless task_create is rejected", async () => {
    const db = openLedger(":memory:");
    const seed = db.query(
      `INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
       VALUES (?, ?, 'addressed_message', 'eng', ?, ?, 'U1', ?, '2026-07-01T00:00:00Z')`,
    );
    seed.run("e1", "k1", "C1", "1.0", JSON.stringify({ text: "<@BOT1> alert burst, investigate", ts: "1.1", addressMode: "mention" }));
    seed.run("e2", "k2", "C2", null, JSON.stringify({ text: "<@BOT1> pull it together blacksmith", ts: "2.0", addressMode: "mention" }));

    const rejected: string[] = [];
    const { service } = harness(async (_turn, tools, _mark, prompt) => {
      const taskCreate = tools.get("task_create");
      if (!taskCreate) return; // the ear / the worker (which never reaches its report here)
      const bare = await taskCreate.run({ title: "dig", spec: "s" });
      expect(bare.success).toBe(false);
      rejected.push(bare.output);
      await taskCreate.run({ title: "dig", spec: "s", ref: refIn(prompt, "alert burst") });
    }, db);
    await service.start();
    await service.idle(); // flushes the boot wake carrying both conversations

    expect(rejected[0]).toContain("is not a ref");
    const row = one<{ home_venue_id: string; home_thread_root_id: string | null }>(db, "SELECT home_venue_id, home_thread_root_id FROM tasks");
    expect(row?.home_venue_id).toBe("C1"); // the incident's thread...
    expect(row?.home_thread_root_id).toBe("1.0"); // ...not C2, the batch's last-addressed guess
    await service.stop();
  });

  // The reply-stream contract (reply-stream.ts): checklist cards alone must never create (and
  // notify on) a message — they buffer until her first words materialize the stream, then ride
  // the SAME message as native task cards. Live defect 2026-07-20: the resident wake never wired
  // the stream, so a bare card-only plan box posted as her whole reply while she worked.
  test("checklist cards buffer until the reply materializes the stream — a plan box alone never posts", async () => {
    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return; // the ear bookkeeps quietly
      // The checklist seats by ref like every posting tool — the model says which conversation
      // the work is for; the cards ride that conversation's stream.
      const ref = refIn(prompt, "organize");
      await tools.get("checklist")!.run({ items: [{ text: "collect reports", done: false }, { text: "send the list", done: false }], ref });
      await tools.get("reply")!.run({ text: "3 follow-ups, list below", ref });
      await tools.get("checklist")!.run({ items: [{ text: "collect reports", done: true }, { text: "send the list", done: false }], ref });
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> organize today's reports", mentionsBotId: true, ts: "5.0" }));
    await service.idle();

    expect(adapter.posts).toHaveLength(0); // no standalone emoji checklist, no plain reply
    expect(adapter.streams).toHaveLength(1); // ONE message carries cards + words
    const stream = adapter.streams[0]!;
    expect(stream.text).toBe("3 follow-ups, list below");
    expect(stream.stopped).toBe(true);
    const cards = adapter.taskCards.filter((c) => c.messageId === stream.messageId);
    expect(cards.length).toBeGreaterThan(0);
    // The stream closed with every card settled — Slack renders a pending card on a stopped
    // stream as "Something went wrong".
    const lastByCardId = new Map(cards.map((c) => [c.id, c.status]));
    expect([...lastByCardId.values()].every((s) => s === "complete")).toBe(true);
    await service.stop();
  });

  test("a wake that only plans and never speaks posts NOTHING — buffered cards die with the wake", async () => {
    const outcomes: { success: boolean }[] = [];
    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return;
      outcomes.push(await tools.get("checklist")!.run({ items: [{ text: "a plan with no words", done: false }], ref: refIn(prompt, "hm") }));
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> hm", mentionsBotId: true, ts: "6.0", threadRootTs: "6.0" }));
    await service.idle();

    expect(outcomes[0]!.success).toBe(true); // the call RAN — this test must never pass at the ref gate
    expect(adapter.posts).toHaveLength(0);
    expect(adapter.streams).toHaveLength(0);
    expect(adapter.taskCards).toHaveLength(0);
    await service.stop();
  });

  test("when the surface has no native streaming, the reply falls back to a plain post", async () => {
    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return;
      await tools.get("reply")!.run({ text: "plain delivery still works", ref: refIn(prompt, /ping/) });
    });
    adapter.failStreams = true;
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> ping", mentionsBotId: true, ts: "7.0" }));
    await service.idle();

    expect(adapter.streams).toHaveLength(0);
    expect(adapter.posts).toHaveLength(1);
    expect(adapter.posts[0]!.text).toBe("plain delivery still works");
    await service.stop();
  });
});

// SPEC §5.5 stale-reply withholding (§18.2 row): the room can move while the model composes.
// A thread-follow turn's reply buffers until turn end; newer addressed arrivals on the same
// conversation withhold it, and the NEXT wake reconsiders it as an unsent draft. A
// directly-addressed turn's reply is never withheld.
// Each test's ear script wakes the mind for thread chatter — the ear's judgment isn't under
// test here, the wake's posting behavior is.
const earWakes = async (tools: Map<string, DynamicTool>, prompt: string): Promise<boolean> => {
  const verdict = tools.get("verdict");
  if (!verdict) return false;
  await verdict.run({ decision: "wake", why: "her thread is moving", ref: refIn(prompt, /<#C1>/) });
  return true;
};

describe("stale-reply withholding (§5.5)", () => {
  test("§5.5: a thread-follow reply is withheld when the conversation moved mid-turn; the next wake carries the unsent draft", async () => {
    let mindWakes = 0;
    let replyResult: { success: boolean; output: string } | undefined;
    let emitMidTurn!: () => void;
    const { db, adapter, service, minds } = harness(async (_turn, tools, _mark, prompt) => {
      if (await earWakes(tools, prompt)) return;
      if (++mindWakes === 2) {
        // Noah answers Nina while she is still composing her own answer.
        emitMidTurn();
        replyResult = await tools.get("reply")!.run({ text: "the shipping window was clean", ref: refIn(prompt, "when did this actually ship") });
      }
    });
    emitMidTurn = () => adapter.emit(msg({ text: "already answered: it shipped at 8pm", ts: "1.3", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> keep an eye on this thread", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "so when did this actually ship?", ts: "1.2", threadRootTs: "1.0", principalId: "U_NINA" }));
    await service.idle();

    // The reply call itself succeeds (the model is done deciding) but nothing lands in the room.
    expect(replyResult!.success).toBe(true);
    const everything = [...adapter.posts.map((p) => p.text), ...adapter.streams.map((s) => s.text)].join(" ");
    expect(everything).not.toContain("the shipping window was clean");
    // The ledger records the withhold honestly — never a "posted" that didn't post.
    const { many } = await import("../src/ledger/db");
    const rows = many<{ effects: string }>(db, "SELECT effects FROM turns WHERE kind='resident'");
    expect(rows.some((r) => r.effects.includes('"kind":"withheld"'))).toBe(true);
    expect(rows.some((r) => r.effects.includes('"kind":"posted"') && r.effects.includes("shipping window was clean"))).toBe(false);
    // The immediately following wake carries both the mover and the unsent draft.
    expect(mindWakes).toBeGreaterThanOrEqual(3);
    const next = minds()[2]!.prompts[0]!;
    expect(next).toContain("already answered: it shipped at 8pm");
    expect(next).toContain("[drafted last wake but not sent");
    expect(next).toContain("the shipping window was clean");
    await service.stop();
  });

  test("§5.5: a thread-follow reply with no mid-turn arrivals posts normally at turn end", async () => {
    let mindWakes = 0;
    const { db, adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (await earWakes(tools, prompt)) return;
      if (++mindWakes === 2) {
        await tools.get("reply")!.run({ text: "covered upthread — the fix shipped", ref: refIn(prompt, "any update?") });
      }
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> watch this one", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "any update?", ts: "1.2", threadRootTs: "1.0", principalId: "U_NINA" }));
    await service.idle();

    expect(adapter.lastStreamText()).toBe("covered upthread — the fix shipped");
    const { many } = await import("../src/ledger/db");
    const rows = many<{ effects: string }>(db, "SELECT effects FROM turns WHERE kind='resident'");
    expect(rows.some((r) => r.effects.includes('"kind":"posted"') && r.effects.includes("covered upthread"))).toBe(true);
    expect(rows.some((r) => r.effects.includes('"kind":"withheld"'))).toBe(false);
    await service.stop();
  });

  test("speaking into a conversation the wake did not read bounces once with its card — a stepped-out thread's held chatter included; the re-send posts and re-engages", async () => {
    let mindWakes = 0;
    let firstTry: { success: boolean; output: string } | undefined;
    let secondTry: { success: boolean; output: string } | undefined;
    const { db, adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "the humans settled it", venueId: "C1", threadRootId: "1.0" });
        return;
      }
      mindWakes++;
      if (mindWakes === 1) {
        await tools.get("reply")!.run({ text: "on it", ref: refIn(prompt, "watch this") });
      } else if (mindWakes === 2) {
        await tools.get("step_back")!.run({ why: "noah asked me to leave this one", ref: refIn(prompt, "drop it") });
      } else if (mindWakes === 3) {
        const searchRef = firstSearchRef((await tools.get("search")!.run({ query: "watch this" })).output);
        firstTry = await tools.get("reply")!.run({ text: "reopening: this is not settled", ref: searchRef });
        secondTry = await tools.get("reply")!.run({ text: "read it — still worth saying", ref: searchRef });
      }
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> watch this", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> drop it, we have it", mentionsBotId: true, ts: "1.1", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    adapter.emit(msg({ text: "settled: it ships tomorrow", ts: "1.2", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> unrelated: deploy status?", mentionsBotId: true, ts: "9.0" }));
    await service.idle();

    // The bounce card carries her recorded stance, the ear's read, and the chatter she never saw.
    expect(firstTry!.success).toBe(false);
    expect(firstTry!.output).toContain("noah asked me to leave this one");
    expect(firstTry!.output).toContain("settled: it ships tomorrow");
    const everything = [...adapter.posts.map((p) => p.text), ...adapter.streams.map((s) => s.text)].join(" ");
    expect(everything).not.toContain("reopening: this is not settled");
    // The informed re-send posts, and posting re-engages the conversation.
    expect(secondTry!.success).toBe(true);
    expect(everything).toContain("read it — still worth saying");
    const row = one<{ stance: string }>(db, "SELECT stance FROM conversations WHERE venue_id = 'C1' AND thread_root_id = '1.0'")!;
    expect(row.stance).toBe("engaged");
    await service.stop();
  });


  test("a retry attempt re-arms the reply gate — a bounce consumed by a dead attempt cannot wave the next one through", async () => {
    let mindWakes = 0;
    let gateAttempts = 0;
    let retryTry: { success: boolean; output: string } | undefined;
    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return;
      mindWakes++;
      if (mindWakes === 1) {
        await tools.get("reply")!.run({ text: "on it", ref: refIn(prompt, "watch this") });
      } else if (mindWakes === 2) {
        await tools.get("step_back")!.run({ why: "noah asked me to leave this one", ref: refIn(prompt, "drop it") });
      } else {
        gateAttempts++;
        const searchRef = firstSearchRef((await tools.get("search")!.run({ query: "watch this" })).output);
        if (gateAttempts === 1) {
          await tools.get("reply")!.run({ text: "stale hot take", ref: searchRef });
          throw new Error("stream disconnected before completion");
        }
        retryTry = await tools.get("reply")!.run({ text: "stale hot take", ref: searchRef });
      }
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> watch this", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> drop it, we have it", mentionsBotId: true, ts: "1.1", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> unrelated: deploy status?", mentionsBotId: true, ts: "9.0" }));
    await service.idle();

    expect(gateAttempts).toBeGreaterThanOrEqual(2);
    // The retry's first send bounces again — it never saw attempt 0's tool results.
    expect(retryTry!.success).toBe(false);
    expect(retryTry!.output).toContain("noah asked me to leave this one");
    const everything = [...adapter.posts.map((p) => p.text), ...adapter.streams.map((s) => s.text)].join(" ");
    expect(everything).not.toContain("stale hot take");
    await service.stop();
  });


  test("step-back speech gate: a mention brings her back in — no bounce on the reply", async () => {
    let mindWakes = 0;
    let firstTry: { success: boolean; output: string } | undefined;
    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (await earWakes(tools, prompt)) return;
      mindWakes++;
      if (mindWakes === 2) {
        await tools.get("step_back")!.run({ why: "the humans have it", ref: refIn(prompt, "drop it") });
      } else if (mindWakes === 3) {
        firstTry = await tools.get("reply")!.run({ text: "here as asked", ref: refIn(prompt, "one more thing") });
      }
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> watch this", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> drop it", mentionsBotId: true, ts: "1.1", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> actually, one more thing?", mentionsBotId: true, ts: "1.2", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();

    expect(firstTry!.success).toBe(true);
    const everything = [...adapter.posts.map((p) => p.text), ...adapter.streams.map((s) => s.text)].join(" ");
    expect(everything).toContain("here as asked");
    await service.stop();
  });

  test("a wake's prompt carries the already-heard tail of every thread its batch touches — the mind reads with the same context as the ear", async () => {
    const { adapter, service, minds } = harness(async (_turn, tools, _mark, prompt) => {
      if (await earWakes(tools, prompt)) return;
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> the export bug is back", mentionsBotId: true, ts: "1.0", principalId: "U_NINA" }));
    await service.idle();
    adapter.emit(msg({ text: "noah says it shipped at 8pm, not a bug", ts: "1.1", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    adapter.emit(msg({ text: "so can we close it?", ts: "1.2", threadRootTs: "1.0", principalId: "U_NINA" }));
    await service.idle();

    // The last wake's batch is bare thread chatter; the prompt carries what came before it.
    const last = minds().at(-1)!.prompts[0]!;
    expect(last).toContain("so can we close it?");
    expect(last).toContain("earlier in <#C1> thread=1.0");
    expect(last).toContain("the export bug is back");
    await service.stop();
  });

  test("held conversations deliver WITH the ear reads that held them — an unrelated wake cannot receive the messages as bare lines (2026-08-10)", async () => {
    // The 18:10 shape: the ear holds a thread twice ("settled"), then an unrelated mention
    // wakes her and the held messages ride the batch. Pre-P1 the holds were discarded and the
    // fresh session judged two bare lines from scratch; now the judgment rides the prompt and
    // is consumed by the delivery.
    let earPasses = 0;
    const { db, adapter, service, minds } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        earPasses++;
        // Holds only while judging the thread's own chatter; the later pass over the unrelated
        // mention judges nothing (the mention wakes the mind directly).
        if (earPasses <= 2) {
          await verdict.run({ decision: "hold", why: earPasses === 1 ? "kate closed this as settled" : "still settled, nothing for her", ref: refIn(prompt, /<#C1>/) });
        }
        return;
      }
    });
    await service.start();
    adapter.emit(msg({ text: "closing this one as dup", ts: "1.1", threadRootTs: "1.0", principalId: "U_KATE" }));
    await service.idle();
    adapter.emit(msg({ text: "okay perfect one less ticket", ts: "1.2", threadRootTs: "1.0", principalId: "U_KATE" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> unrelated: deploy status?", mentionsBotId: true, ts: "9.0", principalId: "U_NOAH" }));
    await service.idle();

    const wake = minds().at(-1)!.prompts[0]!;
    // The held lines deliver — nothing is dropped — but they arrive wearing the ear's reads.
    expect(wake).toContain("okay perfect one less ticket");
    expect(wake).toContain("the ear held it 2x without a wake");
    expect(wake).toContain("kate closed this as settled");
    expect(wake).toContain("still settled, nothing for her");
    // Consumed with the delivery: the row is clean for the conversation's next stretch.
    const row = one<{ holds: number; hold_whys: string }>(db, "SELECT holds, hold_whys FROM conversations WHERE venue_id = 'C1' AND thread_root_id = '1.0'")!;
    expect(row.holds).toBe(0);
    expect(JSON.parse(row.hold_whys)).toEqual([]);
    await service.stop();
  });

  test("a stepped-out conversation's chatter stays undelivered — an unrelated wake doesn't carry it; a mention re-engages and delivers the backlog with the ear's reads", async () => {
    let mindWakes = 0;
    const { adapter, service, minds } = harness(async (_turn, tools, _mark, prompt) => {
      const verdict = tools.get("verdict");
      if (verdict) {
        await verdict.run({ decision: "hold", why: "they are wrapping it up without her", ref: refIn(prompt, /<#C1>/) });
        return;
      }
      mindWakes++;
      if (mindWakes === 2) {
        await tools.get("step_back")!.run({ why: "noah asked me to leave this one", ref: refIn(prompt, "drop it") });
      }
    });
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> watch this", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> drop it, we have it", mentionsBotId: true, ts: "1.1", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    adapter.emit(msg({ text: "wrapping up, thanks all", ts: "1.2", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    adapter.emit(msg({ text: "<@BOT1> unrelated: deploy status?", mentionsBotId: true, ts: "9.0" }));
    await service.idle();

    // The unrelated wake carries nothing from the room she left.
    const unrelated = minds().at(-1)!.prompts[0]!;
    expect(unrelated).toContain("deploy status?");
    expect(unrelated).not.toContain("wrapping up, thanks all");

    // A mention brings her back in: the backlog delivers, wearing the reads made while she was out.
    adapter.emit(msg({ text: "<@BOT1> actually, one question for you here", mentionsBotId: true, ts: "1.3", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.idle();
    const reengaged = minds().at(-1)!.prompts[0]!;
    expect(reengaged).toContain("one question for you here");
    expect(reengaged).toContain("wrapping up, thanks all");
    expect(reengaged).toContain("they are wrapping it up without her");
    await service.stop();
  });


  test("§5.5 holds per conversation inside a MIXED wake: a mention in one room never disarms the withhold in another (audit finding)", async () => {
    let emitMidTurn!: () => void;
    let mixedWakes = 0;
    const { db, adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (await earWakes(tools, prompt)) return;
      if (++mixedWakes !== 2) return; // wake 1 is the C1 watch mention; wake 2 is the mixed batch
      // One wake, two conversations: the C2 mention makes it a "direct" wake; the C1 thread is
      // merely overheard. Pre-audit, the mention disarmed buffering for BOTH.
      await tools.get("reply")!.run({ text: "answering you directly", ref: refIn(prompt, "ship it?") });
      emitMidTurn(); // the overheard C1 conversation moves while she composes
      await tools.get("reply")!.run({ text: "my stale take on the export bug", ref: refIn(prompt, "export bug") });
    });
    emitMidTurn = () => adapter.emit(msg({ text: "nvm, kate answered it", ts: "1.3", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> keep an eye on this", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "so what causes the export bug?", ts: "1.2", threadRootTs: "1.0", principalId: "U_NINA" }));
    adapter.emit(msg({ text: "<@BOT1> unrelated: ship it?", mentionsBotId: true, ts: "9.0", venueId: "C2" }));
    await service.idle();

    const everything = [...adapter.posts.map((p) => p.text), ...adapter.streams.map((s) => s.text)].join(" ");
    expect(everything).toContain("answering you directly"); // the addressed reply landed
    expect(everything).not.toContain("my stale take"); // the overheard conversation's reply was withheld
    const { many } = await import("../src/ledger/db");
    const rows = many<{ effects: string }>(db, "SELECT effects FROM turns WHERE kind='resident'");
    expect(rows.some((r) => r.effects.includes('"kind":"withheld"'))).toBe(true);
    await service.stop();
  });

  test("a wake never eats its own withholds: consuming rendered drafts spares the drafts the same wake just saved (review 2026-08-11)", async () => {
    let mindWakes = 0;
    let emitMidTurn!: () => void;
    const { adapter, service, minds } = harness(async (_turn, tools, _mark, prompt) => {
      if (await earWakes(tools, prompt)) return;
      mindWakes++;
      if (mindWakes === 2) {
        // Wake 2: the thread moved mid-turn — reply A is withheld into draft A.
        emitMidTurn();
        await tools.get("reply")!.run({ text: "draft A: my first take", ref: refIn(prompt, "when did this actually ship") });
      } else if (mindWakes === 3) {
        // Wake 3 carries draft A — and withholds a NEW reply (draft B) the same way.
        expect(prompt).toContain("draft A: my first take");
        emitMidTurn();
        await tools.get("reply")!.run({ text: "draft B: my second take", ref: refIn(prompt, /already answered/) });
      }
    });
    let n = 2;
    emitMidTurn = () => adapter.emit(msg({ text: `already answered: it shipped at 8pm (${n})`, ts: `1.${++n}`, threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> keep an eye on this thread", mentionsBotId: true, ts: "1.0" }));
    await service.idle();
    adapter.emit(msg({ text: "so when did this actually ship?", ts: "1.2", threadRootTs: "1.0", principalId: "U_NINA" }));
    await service.idle();

    // Wake 4 must carry draft B — the blanket identity-wide consume would have eaten it in
    // wake 3's finally, silently destroying her words.
    const last = minds().at(-1)!.prompts[0]!;
    expect(last).toContain("draft B: my second take");
    expect(last).not.toContain("draft A: my first take"); // A was rendered (wake 3) and consumed
    await service.stop();
  });

  test("a DM answered at the venue surface is a DIRECT reply — never §5.5-withheld (review 2026-08-11)", async () => {
    let emitMidTurn!: () => void;
    let sent = false;
    const dmYaml = POLICY_YAML.replace("venue_ids: [C1, C2]", "venue_ids: [C1, C2, D1]");
    const { adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (tools.get("verdict")) return;
      if (sent) return;
      sent = true;
      emitMidTurn(); // the DM moves while she composes
      // She answers top-level — the DM norm — via the venue-surface conversation ref.
      await tools.get("reply")!.run({ text: "here's the summary you asked for", ref: refIn(prompt, /<#D1>\]/) });
    }, openLedger(":memory:"), dmYaml);
    emitMidTurn = () => adapter.emit(msg({ venueId: "D1", venueKind: "dm", text: "oh also one more thing", ts: "2.2", mentionsBotId: false, principalId: "U_NOAH" }));
    await service.start();
    adapter.emit(msg({ venueId: "D1", venueKind: "dm", text: "summarize the incident for me?", ts: "2.1", mentionsBotId: false, principalId: "U_NOAH" }));
    await service.idle();

    const everything = [...adapter.posts.map((p) => p.text), ...adapter.streams.map((s) => s.text)].join(" ");
    expect(everything).toContain("here's the summary you asked for"); // landed despite the mid-turn arrival
    await service.stop();
  });

  test("§5.5: a directly-addressed turn's reply is never withheld, even when the thread moves mid-turn", async () => {
    let emitMidTurn!: () => void;
    const { db, adapter, service } = harness(async (_turn, tools, _mark, prompt) => {
      if (await earWakes(tools, prompt)) return;
      if (adapter.streams.length === 0 && adapter.posts.length === 0) {
        emitMidTurn();
        await tools.get("reply")!.run({ text: "answering you directly", ref: refIn(prompt, "when did this ship") });
      }
    });
    emitMidTurn = () => adapter.emit(msg({ text: "meanwhile the thread moves on", ts: "1.1", threadRootTs: "1.0", principalId: "U_NOAH" }));
    await service.start();
    adapter.emit(msg({ text: "<@BOT1> when did this ship?", mentionsBotId: true, ts: "1.0" }));
    await service.idle();

    const everything = [...adapter.posts.map((p) => p.text), ...adapter.streams.map((s) => s.text)].join(" ");
    expect(everything).toContain("answering you directly");
    const { many } = await import("../src/ledger/db");
    const rows = many<{ effects: string }>(db, "SELECT effects FROM turns WHERE kind='resident'");
    expect(rows.some((r) => r.effects.includes('"kind":"withheld"'))).toBe(false);
    await service.stop();
  });
});
