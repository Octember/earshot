import { describe, expect, test } from "bun:test";
import { INTEGRATION_REGISTRIES, integrationCatalog, INTEGRATION_TOOL_NAMES, buildToolbox, type ToolRegistry } from "../src/tools/catalog";
import type { DynamicTool } from "../src/turn-runner/types";

function dyn(name: string): DynamicTool {
  return {
    spec: { name, description: `${name} does its thing`, inputSchema: { type: "object" } },
    run: async () => ({ success: true, output: "" }),
  };
}

// SPEC §11: catalog derives from registries (no drift).
describe("registry derivations", () => {
  const cat = integrationCatalog();

  test("flattened catalog and name list match the registries exactly", () => {
    const fromRegistries = INTEGRATION_REGISTRIES.flatMap((registry) => Object.keys(registry.tools)).toSorted();
    expect([...INTEGRATION_TOOL_NAMES].toSorted()).toEqual(fromRegistries);
    expect(Object.keys(cat).toSorted()).toEqual(fromRegistries);
  });

  test("every integration tool is present, self-describing, and runnable", () => {
    for (const name of INTEGRATION_TOOL_NAMES) {
      expect(cat[name]?.run).toBeDefined();
      expect(cat[name]?.description!.length).toBeGreaterThan(0);
      expect(cat[name]?.inputSchema).toBeDefined();
    }
  });

  test("every example names a tool in its registry (typo fails here)", () => {
    for (const registry of INTEGRATION_REGISTRIES) {
      for (const example of registry.examples ?? []) {
        expect(Object.keys(registry.tools)).toContain(example.tool);
        expect(example.when.length).toBeGreaterThan(0);
      }
    }
  });

  test("integration registries carry a skill and at least one worked example", () => {
    for (const registry of INTEGRATION_REGISTRIES.filter((reg) => ["linear", "github", "notion"].includes(reg.name))) {
      expect(registry.skill!.length).toBeGreaterThan(0);
      expect(registry.examples!.length).toBeGreaterThan(0);
    }
  });

  test("skills speak capability, not transport mechanics (§11 authoring rule)", () => {
    for (const registry of INTEGRATION_REGISTRIES) {
      expect(registry.skill ?? "").not.toMatch(/graphql|http|endpoint|api key|mutation|json/i);
    }
  });
});

// SPEC §18: read/write tool grain rejects opposite op before transport.
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

// SPEC §10.2 / §18: write tools consequential statically; reads never.
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

// SPEC §11 / §18: toolbox digest ≡ exposed toolset.
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

  test("full exposure: groups in registry order, skill and all examples present", () => {
    const toolbox = buildToolbox([dyn("linear_read"), dyn("linear_write"), dyn("db_read")], registries);
    expect(toolbox.map((group) => group.registry)).toEqual(["linear", "db"]);
    expect(toolbox[0]!.skill).toBe("the tickets manual");
    expect(toolbox[0]!.tools.map((tool) => tool.name)).toEqual(["linear_read", "linear_write"]);
    expect(toolbox[0]!.examples!.map((example) => example.tool)).toEqual(["linear_read", "linear_write"]);
    // descriptions from exposed tool, not registry spec
    expect(toolbox[0]!.tools[0]!.description).toBe("linear_read does its thing");
  });

  test("partial grant: only exposed tool and its examples render", () => {
    const toolbox = buildToolbox([dyn("linear_read")], registries);
    expect(toolbox).toHaveLength(1);
    expect(toolbox[0]!.tools.map((tool) => tool.name)).toEqual(["linear_read"]);
    expect(toolbox[0]!.examples!.map((example) => example.tool)).toEqual(["linear_read"]);
    expect(toolbox[0]!.skill).toBe("the tickets manual"); // the manual still shows in full
  });

  test("registry with no exposed tools contributes nothing", () => {
    const toolbox = buildToolbox([dyn("db_read")], registries);
    expect(toolbox.map((group) => group.registry)).toEqual(["db"]);
  });

  test("tool outside every registry appears as its own group", () => {
    const toolbox = buildToolbox([dyn("reply"), dyn("linear_read")], registries);
    expect(toolbox.map((group) => group.registry)).toEqual(["linear", "reply"]);
    expect(toolbox[1]!.tools).toEqual([{ name: "reply", description: "reply does its thing" }]);
  });
});
