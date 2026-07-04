import { describe, expect, test } from "bun:test";
import { assistantGreeting, mentionsByName, normalizeSlackEvent, reconnectDelay, resolveChannelRef, slackPermalink } from "../src/adapter/slack";

const BOT_USER_ID = "BOT123";

describe("normalizeSlackEvent (SPEC §12.1 inbound normalization)", () => {
  test("a plain channel message with a mention", () => {
    const result = normalizeSlackEvent(
      {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        text: `hey <@${BOT_USER_ID}> can you look into this`,
        ts: "1719900000.000100",
      },
      BOT_USER_ID,
    );

    expect(result).toEqual({
      venueId: "C1",
      venueKind: "channel",
      principalId: "U1",
      isBot: false,
      text: `hey <@${BOT_USER_ID}> can you look into this`,
      ts: "1719900000.000100",
      threadRootTs: null,
      mentionsBotId: true,
      deliveryId: "1719900000.000100",
    });
  });

  test("a DM message is venueKind 'dm'", () => {
    const result = normalizeSlackEvent(
      { type: "message", channel: "D1", channel_type: "im", user: "U1", text: "hi", ts: "1.1" },
      BOT_USER_ID,
    );
    expect(result?.venueKind).toBe("dm");
    expect(result?.mentionsBotId).toBe(false);
  });

  test("a private channel message is venueKind 'private_channel'", () => {
    const result = normalizeSlackEvent(
      { type: "message", channel: "G1", channel_type: "group", user: "U1", text: "hi", ts: "1.1" },
      BOT_USER_ID,
    );
    expect(result?.venueKind).toBe("private_channel");
  });

  test("a thread reply carries the thread root ts, distinct from its own ts", () => {
    const result = normalizeSlackEvent(
      { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "following up", ts: "2.0", thread_ts: "1.0" },
      BOT_USER_ID,
    );
    expect(result?.threadRootTs).toBe("1.0");
  });

  test("a thread root message (thread_ts equals its own ts) has threadRootTs null — it IS the root", () => {
    const result = normalizeSlackEvent(
      { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "starting a thread", ts: "1.0", thread_ts: "1.0" },
      BOT_USER_ID,
    );
    expect(result?.threadRootTs).toBeNull();
  });

  test("a bot message is flagged isBot with the bot_id as principal", () => {
    const result = normalizeSlackEvent(
      { type: "message", channel: "C1", channel_type: "channel", bot_id: "B1", text: "automated update", ts: "1.0", subtype: "bot_message" },
      BOT_USER_ID,
    );
    expect(result?.isBot).toBe(true);
    expect(result?.principalId).toBe("B1");
  });

  test("a bot message with both bot_id and user (app-authored) prefers the user id as principal", () => {
    const result = normalizeSlackEvent(
      { type: "message", channel: "C1", channel_type: "channel", bot_id: "B1", user: "U_APP", text: "x", ts: "1.0" },
      BOT_USER_ID,
    );
    expect(result?.isBot).toBe(true);
    expect(result?.principalId).toBe("U_APP");
  });

  test("uninteresting message subtypes (channel_join etc.) are filtered out entirely", () => {
    const result = normalizeSlackEvent(
      { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "U1 has joined the channel", ts: "1.0", subtype: "channel_join" },
      BOT_USER_ID,
    );
    expect(result).toBeNull();
  });

  test("a message_changed edit event is filtered out (SPEC §12.2: edits have no retroactive effect)", () => {
    const result = normalizeSlackEvent(
      { type: "message", channel: "C1", channel_type: "channel", subtype: "message_changed", ts: "1.0", message: { text: "edited", user: "U1" } },
      BOT_USER_ID,
    );
    expect(result).toBeNull();
  });

  test("non-message event types are ignored", () => {
    expect(normalizeSlackEvent({ type: "reaction_added" }, BOT_USER_ID)).toBeNull();
  });

  test("deliveryId is the message ts (stable across redelivery, unique per channel — SPEC §12.2 dedup)", () => {
    const a = normalizeSlackEvent({ type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "x", ts: "5.5" }, BOT_USER_ID);
    const b = normalizeSlackEvent({ type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "x", ts: "5.5" }, BOT_USER_ID);
    expect(a?.deliveryId).toBe(b?.deliveryId);
  });
});

describe("reconnectDelay (M9: backoff with jitter)", () => {
  test("grows exponentially with attempt, jittered within [ceil/2, ceil]", () => {
    const at0lo = reconnectDelay(0, { baseMs: 1000, maxMs: 30000, rng: () => 0 });
    const at0hi = reconnectDelay(0, { baseMs: 1000, maxMs: 30000, rng: () => 1 });
    expect(at0lo).toBe(500); // ceil=1000 → ceil/2
    expect(at0hi).toBe(1000); // ceil=1000 → ceil

    const at3lo = reconnectDelay(3, { baseMs: 1000, maxMs: 30000, rng: () => 0 });
    expect(at3lo).toBe(4000); // ceil = 1000 * 2^3 = 8000 → ceil/2
  });

  test("is capped at maxMs for large attempts", () => {
    const big = reconnectDelay(20, { baseMs: 1000, maxMs: 30000, rng: () => 1 });
    expect(big).toBe(30000);
    const bigLo = reconnectDelay(20, { baseMs: 1000, maxMs: 30000, rng: () => 0 });
    expect(bigLo).toBe(15000);
  });

  test("with the default rng, stays within [ceil/2, ceil]", () => {
    for (let i = 0; i < 50; i++) {
      const d = reconnectDelay(2, { baseMs: 1000, maxMs: 30000 });
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });
});

describe("resolveChannelRef (read_channel input parsing)", () => {
  test("passes through a bare channel id", () => {
    expect(resolveChannelRef("C0123ABC")).toBe("C0123ABC");
    expect(resolveChannelRef("#C0123ABC")).toBe("C0123ABC");
  });

  test("extracts the id from a Slack channel link <#C..|name>", () => {
    expect(resolveChannelRef("<#C0123ABC456|bug-reports>")).toBe("C0123ABC456");
    expect(resolveChannelRef("<#G0PRIVATE1>")).toBe("G0PRIVATE1");
  });

  test("rejects a bare human channel name (needs channels:read to resolve)", () => {
    expect(() => resolveChannelRef("#bug-reports")).toThrow();
    expect(() => resolveChannelRef("general")).toThrow();
  });
});

describe("assistantGreeting (first-class Assistant onboarding)", () => {
  test("provides a title and non-empty, well-formed suggested prompts", () => {
    const g = assistantGreeting();
    expect(g.title.length).toBeGreaterThan(0);
    expect(g.prompts.length).toBeGreaterThan(0);
    for (const p of g.prompts) {
      expect(typeof p.title).toBe("string");
      expect(p.title.length).toBeGreaterThan(0);
      expect(typeof p.message).toBe("string");
      expect(p.message.length).toBeGreaterThan(0);
    }
  });
});

describe("mentionsByName (passive listening: plain-name addressing)", () => {
  test("saying the bot's name in plain text counts as a mention", () => {
    const result = normalizeSlackEvent(
      { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "Marvin if u see this please emoji it", ts: "1.0" },
      BOT_USER_ID,
      "marvin",
    );
    expect(result?.mentionsBotId).toBe(true);
  });

  test("case-insensitive, whole word only", () => {
    expect(mentionsByName("hey MARVIN, thoughts?", "marvin")).toBe(true);
    expect(mentionsByName("marvins stuff", "marvin")).toBe(false); // not a whole word
    expect(mentionsByName("unrelated message", "marvin")).toBe(false);
    expect(mentionsByName("anything", null)).toBe(false); // name not known yet
  });
});

describe("slackPermalink (receipts for cited claims)", () => {
  test("builds the /archives/<channel>/p<ts> form, dot stripped, trailing slash tolerated", () => {
    expect(slackPermalink("https://acme.slack.com/", "C0987ZYX654", "1783110011.612489")).toBe(
      "https://acme.slack.com/archives/C0987ZYX654/p1783110011612489",
    );
    expect(slackPermalink("https://x.slack.com", "C1", "5.5")).toBe("https://x.slack.com/archives/C1/p55");
  });
});
