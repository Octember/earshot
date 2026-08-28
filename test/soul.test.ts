import { describe, expect, test } from "bun:test";
import { SOUL, composeInstructions } from "../src/turn-runner/soul";

// Soul doc composition for AGENTS.md; persona extends baked character.
describe("soul / composeInstructions", () => {
  test("always includes baked character, even with no personas", () => {
    const out = composeInstructions([]);
    expect(out).toContain(SOUL);
    expect(out.length).toBeGreaterThan(0);
  });

  test("appends each identity's persona under its own heading", () => {
    const out = composeInstructions([
      "You are the eng assistant.",
      "You are the design assistant.",
    ]);
    expect(out).toContain(SOUL);
    expect(out).toContain("You are the eng assistant.");
    expect(out).toContain("You are the design assistant.");
    // persona after baked soul (extends, does not lead)
    expect(out.indexOf("You are the eng assistant.")).toBeGreaterThan(out.indexOf(SOUL));
  });

  // §8.6: recent-tier items ride under core, under their own budget, explicitly UNVETTED —
  // noticed is not known. Confirming promotes; ignoring decays.
  test("recent-tier items in soul labeled unvetted, below durable facts", () => {
    const out = composeInstructions(
      [],
      [
        {
          identity: "eng",
          facts: [{ content: "the deploy runs from main", asOf: "2026-08-01T00:00:00Z" }],
          recent: [
            {
              content: "kate mentioned the exporter might move to rust",
              asOf: "2026-08-12T00:00:00Z",
            },
          ],
        },
      ],
    );
    expect(out).toContain("the deploy runs from main");
    expect(out).toContain("NOT yet vetted");
    expect(out).toContain("kate mentioned the exporter might move to rust");
    expect(out.indexOf("kate mentioned")).toBeGreaterThan(out.indexOf("the deploy runs from main"));
    // knowledge block with only recent items still renders
    const onlyRecent = composeInstructions(
      [],
      [
        {
          identity: "eng",
          facts: [],
          recent: [{ content: "overheard thing", asOf: "2026-08-12T00:00:00Z" }],
        },
      ],
    );
    expect(onlyRecent).toContain("overheard thing");
  });

  test("ignores blank/whitespace personas", () => {
    const out = composeInstructions(["", "   ", "real voice"]);
    expect(out).toContain("real voice");
    // no empty persona heading
    expect(out).not.toMatch(/Persona\n+\s*\n+\s*Persona/);
  });

  // §8.6: over-budget core truncates; soul must report how many items dropped.
  test("over-budget knowledge section reports how many items didn't fit", () => {
    const out = composeInstructions(
      [],
      [
        {
          identity: "eng",
          facts: [{ content: "fact one", asOf: "2026-07-14T00:00:00Z" }],
          dropped: 3,
        },
      ],
    );
    expect(out).toContain("(as of 2026-07-14) fact one");
    expect(out).toContain("3 more didn't fit your memory budget");
    expect(out).toContain("memory_tier");
  });

  test("within-budget knowledge section carries no overflow note", () => {
    const out = composeInstructions(
      [],
      [{ identity: "eng", facts: [{ content: "fact one", asOf: "2026-07-14T00:00:00Z" }] }],
    );
    expect(out).toContain("(as of 2026-07-14) fact one");
    expect(out).not.toContain("memory budget");
  });
});
