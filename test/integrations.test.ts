import { describe, expect, test } from "bun:test";
import { INTEGRATION_REGISTRIES, integrationCatalog, INTEGRATION_TOOL_NAMES, buildToolbox, type ToolRegistry } from "../src/tools/catalog";
import type { DynamicTool } from "../src/turn-runner/types";

// SPEC §11 — the catalog is registries owning tool arrays; the flat broker catalog and the
// name list are derivations of that one structure, so they can never drift from it.
describe("registry derivations", () => {
  const cat = integrationCatalog();

  test("flattened catalog and name list match the registries exactly", () => {
    const fromRegistries = INTEGRATION_REGISTRIES.flatMap((r) => Object.keys(r.tools)).sort();
    expect([...INTEGRATION_TOOL_NAMES].sort()).toEqual(fromRegistries);
    expect(Object.keys(cat).sort()).toEqual(fromRegistries);
  });

  test("every integration tool is present, self-describing, and runnable", () => {
    for (const name of INTEGRATION_TOOL_NAMES) {
      expect(cat[name]?.run).toBeDefined();
      expect(cat[name]?.description!.length).toBeGreaterThan(0);
      expect(cat[name]?.inputSchema).toBeDefined();
    }
  });

  test("every example names a tool in its own registry — a typo fails here, not in a production prompt", () => {
    for (const r of INTEGRATION_REGISTRIES) {
      for (const ex of r.examples ?? []) {
        expect(Object.keys(r.tools)).toContain(ex.tool);
        expect(ex.when.length).toBeGreaterThan(0);
      }
    }
  });

  test("integration registries carry a skill and at least one worked example", () => {
    for (const r of INTEGRATION_REGISTRIES.filter((r) => ["linear", "github", "notion"].includes(r.name))) {
      expect(r.skill!.length).toBeGreaterThan(0);
      expect(r.examples!.length).toBeGreaterThan(0);
    }
  });

  test("skills speak capability, not transport mechanics (§11 authoring rule)", () => {
    for (const r of INTEGRATION_REGISTRIES) {
      expect(r.skill ?? "").not.toMatch(/graphql|http|endpoint|api key|mutation|json/i);
    }
  });
});

// SPEC §18 (read/write tool grain) — a read tool rejects a write operation at its own
// boundary with a friendly failure naming the write tool, and vice versa; the rejection
// happens before any transport, so no credentials or network are involved.
describe("read/write grain boundaries", () => {
  const cat = integrationCatalog();

  test("linear_read rejects a mutation document, pointing at linear_write", async () => {
    const res = await cat.linear_read!.run!({ query: "mutation { issueCreate(input: {}) { success } }" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("linear_write");
  });

  test("linear_write rejects a read query, pointing at linear_read", async () => {
    const res = await cat.linear_write!.run!({ query: "query { issues { nodes { id } } }" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("linear_read");
  });

  test("github_read rejects a write method, pointing at github_write", async () => {
    const res = await cat.github_read!.run!({ method: "POST", path: "/repos/o/r/issues" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("github_write");
  });

  test("github_write rejects a read method, pointing at github_read", async () => {
    const res = await cat.github_write!.run!({ method: "GET", path: "/repos/o/r/pulls" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("github_read");
  });

  test("notion_read rejects a write path, pointing at notion_write", async () => {
    const res = await cat.notion_read!.run!({ method: "POST", path: "/v1/pages" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("notion_write");
  });

  test("notion_write rejects a read path, pointing at notion_read", async () => {
    const res = await cat.notion_write!.run!({ method: "POST", path: "/v1/search" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("notion_read");
  });
});

// SPEC §10.2 / §18 — write tools are consequential (outward) statically, independent of
// arguments; read tools never are. The grain lives in the tool, not in argument sniffing.
describe("action classes are static per tool", () => {
  const cat = integrationCatalog();

  test("write tools are always outward, whatever the args", () => {
    for (const name of ["linear_write", "github_write", "notion_write"]) {
      expect(cat[name]!.actionClasses!({})).toEqual(["outward"]);
      expect(cat[name]!.actionClasses!({ query: "query { x }" })).toEqual(["outward"]);
    }
  });

  test("read tools never carry an action class", () => {
    for (const name of ["linear_read", "github_read", "notion_read", "ops_read", "db_read"]) {
      expect(cat[name]!.actionClasses!({ anything: true })).toEqual([]);
    }
  });
});

// SPEC §11 / §18 (toolbox digest) — the digest derives from the toolset actually exposed to
// the turn: a group appears only with its exposed tools, examples filter to exposed tools,
// and a tool outside every registry still shows up (as its own group) so digest ≡ toolset.
describe("buildToolbox", () => {
  const registries: ToolRegistry[] = [
    {
      name: "linear",
      skill: "the tickets manual",
      examples: [
        { when: "look one up", tool: "linear_read", args: { query: "q" } },
        { when: "file one", tool: "linear_write", args: { query: "m" } },
      ],
      tools: { linear_read: { description: "unused here" }, linear_write: { description: "unused here" } },
    },
    { name: "db", tools: { db_read: { description: "unused here" } } },
  ];
  const dyn = (name: string): DynamicTool => ({
    spec: { name, description: `${name} does its thing`, inputSchema: { type: "object" } },
    run: async () => ({ success: true, output: "" }),
  });

  test("full exposure: groups in registry order, skill and all examples present", () => {
    const tb = buildToolbox([dyn("linear_read"), dyn("linear_write"), dyn("db_read")], registries);
    expect(tb.map((g) => g.registry)).toEqual(["linear", "db"]);
    expect(tb[0]!.skill).toBe("the tickets manual");
    expect(tb[0]!.tools.map((t) => t.name)).toEqual(["linear_read", "linear_write"]);
    expect(tb[0]!.examples!.map((e) => e.tool)).toEqual(["linear_read", "linear_write"]);
    // descriptions come from the exposed tool itself, not the registry spec
    expect(tb[0]!.tools[0]!.description).toBe("linear_read does its thing");
  });

  test("partial grant: only the exposed tool and ITS examples render — no write example on a read-only grant", () => {
    const tb = buildToolbox([dyn("linear_read")], registries);
    expect(tb).toHaveLength(1);
    expect(tb[0]!.tools.map((t) => t.name)).toEqual(["linear_read"]);
    expect(tb[0]!.examples!.map((e) => e.tool)).toEqual(["linear_read"]);
    expect(tb[0]!.skill).toBe("the tickets manual"); // the manual still shows in full
  });

  test("a registry with no exposed tools contributes nothing — skill and examples included", () => {
    const tb = buildToolbox([dyn("db_read")], registries);
    expect(tb.map((g) => g.registry)).toEqual(["db"]);
  });

  test("a tool outside every registry still appears, as its own group — digest ≡ toolset", () => {
    const tb = buildToolbox([dyn("reply"), dyn("linear_read")], registries);
    expect(tb.map((g) => g.registry)).toEqual(["linear", "reply"]);
    expect(tb[1]!.tools).toEqual([{ name: "reply", description: "reply does its thing" }]);
  });
});
