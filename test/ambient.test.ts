import { describe, expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { routeMessage } from "../src/adapter/router";
import { bufferedObservedMessages, ambientPostsToday, recordAmbientPost } from "../src/ledger/ambient";
import type { RawMessage } from "../src/adapter/types";
import type { Policy } from "../src/policy/schema";
import type { Clock } from "../src/ledger/clock";

function freshDb() {
  return openLedger(":memory:");
}

function fakeClock(start = "2026-07-02T00:00:00Z"): Clock & { advance: (iso: string) => void } {
  let now = start;
  const clock = (() => now) as Clock & { advance: (iso: string) => void };
  clock.advance = (iso: string) => {
    now = iso;
  };
  return clock;
}

function basePolicy(): Policy {
  return {
    surface: { kind: "slack", credentials: {} },
    operatorPrincipals: [],
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
        ambient: { enabledVenues: ["C1"], tickIntervalMs: 1800000, dailyPostCap: 2, followupQuietMs: 3600000, eventDebounceMs: 0 },
        venueInstructions: {},
      },
    ],
    turns: { interactiveTimeoutMs: 120000, interactiveTokenCeiling: 100000, historyWindow: 50, maxConcurrentInteractive: 4, maxRetries: 2 },
    executions: { maxConcurrentPerIdentity: 2, maxConcurrentGlobal: 4, progressMaxSilenceMs: 300000, maxTurns: 40, stallTimeoutMs: 300000, maxAttempts: 3, backoffMs: 30000 },
    tasks: { nudgeAfterMs: 86400000, parkAfterMs: 172800000 },
    memory: { distillationCadenceMs: 86400000, maxItemsPerIdentity: null, backfillWindowMs: null },
    budget: { unit: "USD", timezone: "UTC", globalMonthlyCap: 1000, reserve: 0, spendConfirmThreshold: 0 },
    retention: { auditRetentionMs: null, rawEventRetentionMs: null },
  };
}

function observe(db: ReturnType<typeof openLedger>, clock: Clock, ts: string) {
  const msg: RawMessage = {
    venueId: "C1",
    venueKind: "channel",
    principalId: "U1",
    isBot: false,
    text: `msg at ${ts}`,
    ts,
    threadRootTs: null,
    mentionsBotId: false,
    deliveryId: ts,
  };
  routeMessage(db, clock, msg, { botPrincipalId: "BOT1", policy: basePolicy(), newEventId: () => `e-${ts}` });
}

describe("bufferedObservedMessages (SPEC §9.1: the buffer since the last tick)", () => {
  test("returns observed messages for the identity received since the given time", () => {
    const db = freshDb();
    const clock = fakeClock("2026-07-02T00:00:00Z");
    observe(db, clock, "1.0");
    clock.advance("2026-07-02T01:00:00Z");
    observe(db, clock, "2.0");

    const buffered = bufferedObservedMessages(db, "eng", "2026-07-02T00:30:00Z");
    expect(buffered).toHaveLength(1);
    expect(buffered[0]?.text).toBe("msg at 2.0");
  });

  test("addressed messages are not buffered for ambient (only observed)", () => {
    const db = freshDb();
    const clock = fakeClock();
    const msg: RawMessage = {
      venueId: "C1",
      venueKind: "channel",
      principalId: "U1",
      isBot: false,
      text: "<@BOT1> hi",
      ts: "1.0",
      threadRootTs: null,
      mentionsBotId: true,
      deliveryId: "1.0",
    };
    routeMessage(db, clock, msg, { botPrincipalId: "BOT1", policy: basePolicy(), newEventId: () => "e1" });

    expect(bufferedObservedMessages(db, "eng", "2026-01-01T00:00:00Z")).toHaveLength(0);
  });

  test("is identity-scoped", () => {
    const db = freshDb();
    const clock = fakeClock();
    observe(db, clock, "1.0");
    expect(bufferedObservedMessages(db, "sales", "2026-01-01T00:00:00Z")).toHaveLength(0);
  });
});

describe("ambient daily post cap (SPEC §9.2)", () => {
  test("starts at zero for a fresh day", () => {
    const db = freshDb();
    const clock = fakeClock();
    expect(ambientPostsToday(db, clock, "eng", "C1", "UTC")).toBe(0);
  });

  test("recording a successful post increments today's count for that venue", () => {
    const db = freshDb();
    const clock = fakeClock();
    recordAmbientPost(db, clock, "eng", "C1", true);
    expect(ambientPostsToday(db, clock, "eng", "C1", "UTC")).toBe(1);
  });

  test("a dropped (capped) post does not count toward the total", () => {
    const db = freshDb();
    const clock = fakeClock();
    recordAmbientPost(db, clock, "eng", "C1", false);
    expect(ambientPostsToday(db, clock, "eng", "C1", "UTC")).toBe(0);
  });

  test("is scoped per venue — posts to a different venue don't count against this one's cap", () => {
    const db = freshDb();
    const clock = fakeClock();
    recordAmbientPost(db, clock, "eng", "C1", true);
    recordAmbientPost(db, clock, "eng", "C2", true);
    expect(ambientPostsToday(db, clock, "eng", "C1", "UTC")).toBe(1);
    expect(ambientPostsToday(db, clock, "eng", "C2", "UTC")).toBe(1);
  });

  test("resets across a calendar-day boundary in the configured timezone", () => {
    const db = freshDb();
    const clock = fakeClock("2026-07-02T23:00:00Z");
    recordAmbientPost(db, clock, "eng", "C1", true);
    expect(ambientPostsToday(db, clock, "eng", "C1", "UTC")).toBe(1);

    clock.advance("2026-07-03T01:00:00Z");
    expect(ambientPostsToday(db, clock, "eng", "C1", "UTC")).toBe(0);
  });
});

describe("distillableMessages (conversations feed memory, not just chatter)", () => {
  test("includes both addressed and observed messages since the cutoff", async () => {
    const { openLedger } = await import("../src/ledger/db");
    const { distillableMessages } = await import("../src/ledger/ambient");
    const db = openLedger(":memory:");
    const insert = db.query(
      "INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at) VALUES (?, ?, ?, 'eng', 'C1', NULL, 'U1', ?, ?)",
    );
    insert.run("e1", "k1", "observed_message", JSON.stringify({ text: "overheard chatter" }), "2026-07-03T10:00:00Z");
    insert.run("e2", "k2", "addressed_message", JSON.stringify({ text: "hey bot, the codename is HALIBUT" }), "2026-07-03T11:00:00Z");
    insert.run("e3", "k3", "addressed_message", JSON.stringify({ text: "old, already distilled" }), "2026-07-01T00:00:00Z");

    const msgs = distillableMessages(db, "eng", "2026-07-02T00:00:00Z");
    expect(msgs.map((m) => m.text)).toEqual(["overheard chatter", "hey bot, the codename is HALIBUT"]);
  });
});
