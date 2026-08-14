import { describe, expect, test } from "bun:test";
import { SOUL, composeInstructions } from "../src/turn-runner/soul";

// The "soul doc": earshot's character/conduct, written to the workspace AGENTS.md so codex loads it as
// standing instructions for every turn. `persona` (SPEC's per-identity voice) extends — never
// replaces — the baked character; a policy with no persona still gets the full soul.
describe("soul / composeInstructions", () => {
  test("always includes the baked character, even with no personas", () => {
    const out = composeInstructions([]);
    expect(out).toContain(SOUL);
    expect(out.length).toBeGreaterThan(0);
  });

  test("appends each identity's persona under its own heading", () => {
    const out = composeInstructions(["You are the eng assistant.", "You are the design assistant."]);
    expect(out).toContain(SOUL);
    expect(out).toContain("You are the eng assistant.");
    expect(out).toContain("You are the design assistant.");
    // persona comes AFTER the baked soul (extends it, doesn't lead)
    expect(out.indexOf("You are the eng assistant.")).toBeGreaterThan(out.indexOf(SOUL));
  });

  // §8.6: recent-tier items ride under core, under their own budget, explicitly UNVETTED —
  // noticed is not known. Confirming promotes; ignoring decays.
  test("recent-tier items ride the soul labeled unvetted, below the durable facts", () => {
    const out = composeInstructions(
      [],
      [{
        identity: "eng",
        facts: [{ content: "the deploy runs from main", asOf: "2026-08-01T00:00:00Z" }],
        recent: [{ content: "kate mentioned the exporter might move to rust", asOf: "2026-08-12T00:00:00Z" }],
      }],
    );
    expect(out).toContain("the deploy runs from main");
    expect(out).toContain("NOT yet vetted");
    expect(out).toContain("kate mentioned the exporter might move to rust");
    expect(out.indexOf("kate mentioned")).toBeGreaterThan(out.indexOf("the deploy runs from main"));
    // a knowledge block with ONLY recent items still renders (she must see what she noticed)
    const onlyRecent = composeInstructions([], [{ identity: "eng", facts: [], recent: [{ content: "overheard thing", asOf: "2026-08-12T00:00:00Z" }] }]);
    expect(onlyRecent).toContain("overheard thing");
  });

  test("ignores blank/whitespace personas (a null persona is common)", () => {
    const out = composeInstructions(["", "   ", "real voice"]);
    expect(out).toContain("real voice");
    // no empty persona heading left dangling
    expect(out).not.toMatch(/Persona\n+\s*\n+\s*Persona/);
  });

  // §8.6: over-budget core truncates from injection, and curation is the fix — post-Collapse the
  // curator is her, so the soul must SAY what fell off or the defect recurs silently forever.
  test("an over-budget knowledge section tells her how many items didn't fit and to curate", () => {
    const out = composeInstructions([], [{ identity: "eng", facts: [{ content: "fact one", asOf: "2026-07-14T00:00:00Z" }], dropped: 3 }]);
    expect(out).toContain("(as of 2026-07-14) fact one");
    expect(out).toContain("3 more didn't fit your memory budget");
    expect(out).toContain("memory_tier");
  });

  test("a within-budget knowledge section carries no overflow note", () => {
    const out = composeInstructions([], [{ identity: "eng", facts: [{ content: "fact one", asOf: "2026-07-14T00:00:00Z" }] }]);
    expect(out).toContain("(as of 2026-07-14) fact one");
    expect(out).not.toContain("memory budget");
  });
});
