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

  test("ignores blank/whitespace personas (a null persona is common)", () => {
    const out = composeInstructions(["", "   ", "real voice"]);
    expect(out).toContain("real voice");
    // no empty persona heading left dangling
    expect(out).not.toMatch(/Persona\n+\s*\n+\s*Persona/);
  });

  // §8.6: over-budget core truncates from injection, and curation is the fix — post-Collapse the
  // curator is her, so the soul must SAY what fell off or the defect recurs silently forever.
  test("an over-budget knowledge section tells her how many items didn't fit and to curate", () => {
    const out = composeInstructions([], [{ identity: "eng", facts: ["fact one"], dropped: 3 }]);
    expect(out).toContain("fact one");
    expect(out).toContain("3 more didn't fit your memory budget");
    expect(out).toContain("memory_tier");
  });

  test("a within-budget knowledge section carries no overflow note", () => {
    const out = composeInstructions([], [{ identity: "eng", facts: ["fact one"] }]);
    expect(out).toContain("fact one");
    expect(out).not.toContain("memory budget");
  });
});
