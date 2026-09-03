import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { routeMessage } from "../src/adapter/router";
import { engage } from "../src/ledger/conversations-stance";
import type { RawMessage } from "@bevyl-ai/agent-tools";
import type { Policy } from "../src/policy/schema";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock {
  return () => start;
}

function basePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    models: { low: {}, medium: {}, high: {} },
    surface: { kind: "slack", credentials: {} },
    operatorPrincipals: ["U_OPERATOR"],
    trustedBotPrincipals: [],
    defaultDmIdentity: null,
    identities: [
      {
        id: "eng",
        persona: null,
        venueIds: ["C1"],
        learningSources: [],
        grants: [],
        budget: { monthlyCap: 100, perTaskCap: null },
        ambient: { eventDebounceMs: 0 },
        venueInstructions: {},
      },
    ],
    turns: {
      interactiveTimeoutMs: 120000,
      interactiveTokenCeiling: 100000,
      stallTimeoutMs: 45000,
      historyWindow: 50,
      maxConcurrentInteractive: 4,
      maxRetries: 2,
      backoffMs: 0,
      batchDebounceMs: 0,
      batchMaxWaitMs: 10000,
    },
    executions: {
      maxConcurrentPerIdentity: 2,
      maxConcurrentGlobal: 4,
      progressMaxSilenceMs: 300000,
      maxTurns: 40,
      stallTimeoutMs: 300000,
      maxAttempts: 3,
      backoffMs: 30000,
    },
    tasks: { nudgeAfterMs: 86400000, parkAfterMs: 172800000 },
    memory: { coreCharBudget: 8000, recentCharBudget: 2000, recentMaxAgeMs: 604800000 },
    budget: {
      unit: "USD",
      timezone: "UTC",
      globalMonthlyCap: 1000,
      reserve: 0,
      spendConfirmThreshold: 0,
    },
    retention: { auditRetentionMs: null, rawEventRetentionMs: null },
    ...overrides,
  };
}

function msg(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    venueId: "C1",
    venueKind: "channel",
    principalId: "U1",
    isBot: false,
    text: "hello",
    ts: "1.001",
    threadRootTs: null,
    mentionsBotId: false,
    ...overrides,
  };
}

function opts(overrides: Partial<Parameters<typeof routeMessage>[3]> = {}) {
  let seq = 0;
  return {
    botPrincipalId: "BOT1",
    policy: basePolicy(),
    newEventId: () => `e${++seq}`,
    ...overrides,
  };
}

describe("routeMessage (SPEC §17.1, §10.5)", () => {
  test("the agent's own messages are ignored entirely — no event, no audit", () => {
    const db = freshDb();
    const clock = fakeClock();
    const result = routeMessage(db, clock, msg({ isBot: true, principalId: "BOT1" }), opts());

    expect(result.kind).toBe("ignored_self");
    expect(db.query("SELECT COUNT(*) as c FROM events").get()).toEqual({ c: 0 });
  });

  test("an unbound venue is dropped, logged via the callback, not persisted", () => {
    const db = freshDb();
    const clock = fakeClock();
    const logged: { value: string | null } = { value: null };
    const result = routeMessage(
      db,
      clock,
      msg({ venueId: "UNKNOWN" }),
      opts({ onUnboundVenue: (v) => (logged.value = v) }),
    );

    expect(result.kind).toBe("unbound_venue");
    expect(logged.value).toBe("UNKNOWN");
    expect(db.query("SELECT COUNT(*) as c FROM events").get()).toEqual({ c: 0 });
  });

  test("a duplicate delivery (same dedup key) is recognized and produces no second event", () => {
    const db = freshDb();
    const clock = fakeClock();
    const options = opts();
    const first = routeMessage(db, clock, msg({ mentionsBotId: true, deliveryId: "d1" }), options);
    const second = routeMessage(db, clock, msg({ mentionsBotId: true, deliveryId: "d1" }), options);

    expect(first.kind).toBe("addressed");
    expect(second.kind).toBe("duplicate");
    expect(db.query("SELECT COUNT(*) as c FROM events").get()).toEqual({ c: 1 });
  });

  test("a mention is addressed and bound to the venue's identity", () => {
    const db = freshDb();
    const clock = fakeClock();
    const result = routeMessage(db, clock, msg({ mentionsBotId: true }), opts());

    expect(result.kind).toBe("addressed");
    if (result.kind === "addressed") {
      expect(result.event.identityId).toBe("eng");
      expect(result.event.kind).toBe("addressed_message");
    }
  });

  test("a non-mention, non-thread-participating message is observed, not addressed", () => {
    const db = freshDb();
    const clock = fakeClock();
    const result = routeMessage(db, clock, msg({ mentionsBotId: false }), opts());

    expect(result.kind).toBe("observed");
    if (result.kind === "observed") expect(result.event.kind).toBe("observed_message");
  });

  test("reply in thread agent posted in is addressed (§5.1)", () => {
    const db = freshDb();
    const clock = fakeClock();
    engage(db, clock, "eng", "C1", "50.0"); // the agent posted here — e.g. an ambient flag

    const result = routeMessage(
      db,
      clock,
      msg({
        ts: "51.0",
        threadRootTs: "50.0",
        mentionsBotId: false,
        deliveryId: "d-ambient-reply",
      }),
      opts(),
    );
    expect(result.kind).toBe("addressed");
  });

  test("every DM message is addressed, even without a mention", () => {
    const db = freshDb();
    const clock = fakeClock();
    const policy = basePolicy({
      identities: [{ ...basePolicy().identities[0]!, venueIds: [], id: "eng" }],
      defaultDmIdentity: "eng",
    });
    const result = routeMessage(
      db,
      clock,
      msg({ venueKind: "dm", venueId: "D1", mentionsBotId: false }),
      opts({ policy }),
    );

    expect(result.kind).toBe("addressed");
  });

  test("reply in participated thread addressed without fresh mention", () => {
    const db = freshDb();
    const clock = fakeClock();
    const options = opts();
    const mention = routeMessage(db, clock, msg({ ts: "100.000", mentionsBotId: true }), options);
    expect(mention.kind).toBe("addressed");

    const reply = routeMessage(
      db,
      clock,
      msg({ ts: "101.000", threadRootTs: "100.000", mentionsBotId: false, deliveryId: "d2" }),
      options,
    );
    expect(reply.kind).toBe("addressed");
  });

  test("a reply in a thread the agent has NOT participated in is merely observed", () => {
    const db = freshDb();
    const clock = fakeClock();
    const options = opts();
    const result = routeMessage(
      db,
      clock,
      msg({ ts: "200.000", threadRootTs: "199.000", mentionsBotId: false }),
      options,
    );
    expect(result.kind).toBe("observed");
  });

  test("untrusted bot mention never addressed; observed at most (§10.5)", () => {
    const db = freshDb();
    const clock = fakeClock();
    const result = routeMessage(
      db,
      clock,
      msg({ isBot: true, principalId: "OTHERBOT", mentionsBotId: true }),
      opts(),
    );
    expect(result.kind).toBe("observed");
  });

  test("a trusted bot's mention IS addressed (operator explicitly allowlisted it)", () => {
    const db = freshDb();
    const clock = fakeClock();
    const policy = basePolicy({ trustedBotPrincipals: ["OTHERBOT"] });
    const result = routeMessage(
      db,
      clock,
      msg({ isBot: true, principalId: "OTHERBOT", mentionsBotId: true }),
      opts({ policy }),
    );
    expect(result.kind).toBe("addressed");
  });

  test("untrusted bot DM still not addressed despite DM-always rule", () => {
    const db = freshDb();
    const clock = fakeClock();
    const policy = basePolicy({ defaultDmIdentity: "eng" });
    const result = routeMessage(
      db,
      clock,
      msg({ venueKind: "dm", venueId: "D1", isBot: true, principalId: "OTHERBOT" }),
      opts({ policy }),
    );
    expect(result.kind).toBe("observed");
  });

  // §5.1/§5.2: the address mode distinguishes "someone spoke TO the agent" (ack duty, §14.2
  // failure fallback) from "someone spoke in the agent's thread" (neither).
  test("addressed events carry their address mode: mention, dm, or thread_follow", () => {
    const db = freshDb();
    const clock = fakeClock();
    const options = opts();

    const mention = routeMessage(db, clock, msg({ ts: "300.000", mentionsBotId: true }), options);
    expect(mention.kind === "addressed" && mention.event.payload.addressMode).toBe("mention");

    const dmPolicy = basePolicy({ defaultDmIdentity: "eng" });
    let seq = 0;
    const dmRoute = routeMessage(
      db,
      clock,
      msg({ venueKind: "dm", venueId: "D1", ts: "301.000" }),
      opts({ policy: dmPolicy, newEventId: () => `dm${++seq}` }),
    );
    expect(dmRoute.kind === "addressed" && dmRoute.event.payload.addressMode).toBe("dm");

    const follow = routeMessage(
      db,
      clock,
      msg({ ts: "302.000", threadRootTs: "300.000", mentionsBotId: false, deliveryId: "d-follow" }),
      options,
    );
    expect(follow.kind === "addressed" && follow.event.payload.addressMode).toBe("thread_follow");

    const observed = routeMessage(
      db,
      clock,
      msg({ ts: "303.000", mentionsBotId: false, deliveryId: "d-obs" }),
      options,
    );
    expect(observed.kind === "observed" && observed.event.payload.addressMode).toBeUndefined();
  });

  test("a '*' wildcard in venue_ids binds ANY otherwise-unbound channel to that identity", () => {
    const db = freshDb();
    const clock = fakeClock();
    const base = basePolicy().identities[0]!;
    const policy = basePolicy({ identities: [{ ...base, id: "eng", venueIds: ["*"] }] });

    // an arbitrary channel the policy never named explicitly still routes to eng
    const mention = routeMessage(
      db,
      clock,
      msg({ venueId: "C_RANDOM_9Z", mentionsBotId: true }),
      opts({ policy }),
    );
    expect(mention.kind).toBe("addressed");
    if (mention.kind === "addressed") expect(mention.event.identityId).toBe("eng");
  });

  test("explicit venue bindings still win over a '*' wildcard on another identity", () => {
    const db = freshDb();
    const clock = fakeClock();
    const engBase = basePolicy().identities[0]!;
    const policy = basePolicy({
      identities: [
        { ...engBase, id: "eng", venueIds: ["*"] },
        { ...engBase, id: "sales", venueIds: ["C_SALES"] },
      ],
    });
    const result = routeMessage(
      db,
      clock,
      msg({ venueId: "C_SALES", mentionsBotId: true }),
      opts({ policy }),
    );
    expect(result.kind).toBe("addressed");
    if (result.kind === "addressed") expect(result.event.identityId).toBe("sales"); // not the wildcard eng
  });
});
