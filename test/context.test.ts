import { describe, expect, test } from "bun:test";
import { renderTurnPrompt, coreWithinBudget, type TurnPrompt } from "../src/turn-runner/context";
import type { MemoryItem } from "../src/ledger/memory";

function fact(over: Partial<MemoryItem>): MemoryItem {
  return {
    id: "m1",
    identityId: "eng",
    content: "a fact",
    provenance: [],
    tier: "core",
    status: "active",
    supersededBy: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    lastConfirmedAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

// The TurnPrompt renderer is the ONLY place turn-input formatting lives: absent slots render
// nothing, present-but-empty slots say so, order is fixed here.
describe("renderTurnPrompt", () => {
  test("a minimal prompt is just trigger + guidance — no slot leaks an empty header", () => {
    const out = renderTurnPrompt({ trigger: "hello there", guidance: "reply or stay silent" });
    expect(out).toBe("hello there\n\nreply or stay silent");
  });

  test("slots render in fixed order with their headers; absent slots are simply missing", () => {
    const p: TurnPrompt = {
      speaker: { venueId: "C1", principalId: "U7" },
      facts: [fact({ content: "the deploy takes 8 minutes" })],
      openTasks: [{ id: "T-1", status: "open", title: "watch the deploy" }],
      threadTail: { threadTs: "9.0", messages: [{ user: "U2", text: "any update?", ts: "9.1" }] },
      trigger: "<@BOT> status?",
      guidance: "the mechanics",
    };
    const out = renderTurnPrompt(p);
    const order = [
      "You are replying in <#C1>",
      "Your durable memory:",
      "the deploy takes 8 minutes",
      "Your open tasks:",
      "thread ts 9.0",
      "<@BOT> status?",
      "the mechanics",
    ];
    let last = -1;
    for (const marker of order) {
      const at = out.indexOf(marker);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    expect(out).not.toContain("Recently finished tasks"); // absent slot → no header
    expect(out).not.toContain("Recent channel chatter");
  });

  test("present-but-empty facts say '(none yet)' — a fresh agent should know it remembers nothing", () => {
    const out = renderTurnPrompt({ facts: [], trigger: "hi", guidance: "g" });
    expect(out).toContain("Your durable memory:\n(none yet)");
  });

  test("the curation slot shows ids and budget status; the facts slot never shows ids", () => {
    const item = fact({ id: "uuid-42", content: "sam owns exports" });
    const withFacts = renderTurnPrompt({ facts: [item], trigger: "t", guidance: "g" });
    expect(withFacts).not.toContain("uuid-42");
    const withCuration = renderTurnPrompt({ curation: { items: [item], usedChars: 16, budgetChars: 8000 }, trigger: "t", guidance: "g" });
    expect(withCuration).toContain("[uuid-42] (core) sam owns exports");
    expect(withCuration).toContain("16/8000");
  });

  test("chatter lines carry venue and ts= references (ambient reacts by ts)", () => {
    const out = renderTurnPrompt({
      chatter: [{ venueId: "C9", ts: "5.5", threadRootId: "5.0", principalId: "U1", text: "the build is red" }],
      trigger: "t",
      guidance: "g",
    });
    expect(out).toContain("[<#C9> ts=5.5 thread=5.0] <@U1>: the build is red");
  });
});

// SPEC §8.6 budget selection: newest-confirmed facts win; what drops is reported, never silent.
describe("coreWithinBudget", () => {
  test("keeps the most recently confirmed facts that fit; reports the dropped remainder", () => {
    const items = [
      fact({ id: "old", content: "x".repeat(60), lastConfirmedAt: "2026-01-01T00:00:00Z" }),
      fact({ id: "new", content: "y".repeat(60), lastConfirmedAt: "2026-07-01T00:00:00Z" }),
      fact({ id: "mid", content: "z".repeat(60), lastConfirmedAt: "2026-04-01T00:00:00Z" }),
    ];
    const { kept, dropped } = coreWithinBudget(items, 130);
    expect(kept.map((k) => k.id)).toEqual(["new", "mid"]);
    expect(dropped.map((d) => d.id)).toEqual(["old"]);
  });

  test("everything fits → nothing dropped", () => {
    const { kept, dropped } = coreWithinBudget([fact({})], 8000);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });
});

// SPEC §8.6 — the noticed slot carries recent-tier facts with their unvetted caveat.
describe("renderTurnPrompt noticed slot", () => {
  test("noticed facts render under the unvetted caveat; an empty slot renders nothing", () => {
    const withNoticed = renderTurnPrompt({ noticed: [fact({ content: "retro moved to thursdays", tier: "recent" })], trigger: "t", guidance: "g" });
    expect(withNoticed).toContain("Recently noticed");
    expect(withNoticed).toContain("not yet vetted");
    expect(withNoticed).toContain("retro moved to thursdays");
    expect(renderTurnPrompt({ noticed: [], trigger: "t", guidance: "g" })).toBe("t\n\ng"); // empty → no header
  });
});

// SPEC §11 (toolbox digest rendering) — the skill as a block under the group heading, one
// line per exposed tool, worked examples with canonical-JSON args, and the room-safe closing
// line. Absent slot renders none of it.
describe("renderTurnPrompt toolbox slot", () => {
  const toolbox = [
    {
      registry: "linear",
      skill: "the tickets manual",
      tools: [{ name: "linear_read", description: "look tickets up" }],
      examples: [{ when: "look one up", tool: "linear_read", args: { query: "q { x }" } }],
    },
    { registry: "posting", tools: [{ name: "reply", description: "say something" }] },
  ];

  test("renders groups, skill block, tool lines, examples, and the closing line", () => {
    const out = renderTurnPrompt({ trigger: "t", guidance: "g", toolbox });
    const order = [
      "Your tools this turn:",
      "## linear",
      "the tickets manual",
      "- linear_read: look tickets up",
      "look one up",
      'linear_read {"query":"q { x }"}',
      "## posting",
      "- reply: say something",
      "If a tool isn't listed, you don't have it this turn",
    ];
    let at = -1;
    for (const piece of order) {
      const idx = out.indexOf(piece, at + 1);
      expect(idx).toBeGreaterThan(at);
      at = idx;
    }
  });

  test("an example result renders after its call", () => {
    const out = renderTurnPrompt({
      trigger: "t",
      guidance: "g",
      toolbox: [
        {
          registry: "linear",
          tools: [{ name: "linear_write", description: "file tickets" }],
          examples: [{ when: "file one", tool: "linear_write", args: { query: "m" }, result: '{"data":{"ok":true}}' }],
        },
      ],
    });
    expect(out.indexOf('{"data":{"ok":true}}')).toBeGreaterThan(out.indexOf('linear_write {"query":"m"}'));
  });

  test("no toolbox slot → no toolbox header and no closing line", () => {
    const out = renderTurnPrompt({ trigger: "t", guidance: "g" });
    expect(out).not.toContain("Your tools this turn");
    expect(out).not.toContain("If a tool isn't listed");
  });
});
