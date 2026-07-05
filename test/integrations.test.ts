import { describe, expect, test } from "bun:test";
import { integrationCatalog, INTEGRATION_TOOL_NAMES } from "../src/tools/catalog";

// SPEC §10.2 — writes to external systems are consequential (outward) and flow through the
// broker's preauthorization/confirmation gate; reads carry no action class.
describe("integration catalog action classes", () => {
  const cat = integrationCatalog();

  test("every integration tool is present, self-describing, and runnable", () => {
    for (const name of INTEGRATION_TOOL_NAMES) {
      expect(cat[name]?.run).toBeDefined();
      expect(cat[name]?.description!.length).toBeGreaterThan(0);
      expect(cat[name]?.inputSchema).toBeDefined();
    }
  });

  test("linear: mutations are outward, queries are plain reads", () => {
    expect(cat.linear_graphql!.actionClasses!({ query: "mutation { issueCreate { success } }" })).toEqual(["outward"]);
    expect(cat.linear_graphql!.actionClasses!({ query: "query { issues { nodes { id } } }" })).toEqual([]);
  });

  test("github: non-GET is outward", () => {
    expect(cat.github_api!.actionClasses!({ method: "POST", path: "/repos/o/r/issues" })).toEqual(["outward"]);
    expect(cat.github_api!.actionClasses!({ path: "/repos/o/r/pulls" })).toEqual([]);
  });

  test("notion: search/database-query POSTs are reads; page writes are outward", () => {
    expect(cat.notion_api!.actionClasses!({ method: "POST", path: "/v1/search" })).toEqual([]);
    expect(cat.notion_api!.actionClasses!({ method: "POST", path: "/v1/pages" })).toEqual(["outward"]);
    expect(cat.notion_api!.actionClasses!({ method: "PATCH", path: "/v1/blocks/x" })).toEqual(["outward"]);
  });

  test("ops_read and db_read are never outward — read-only by construction/role", () => {
    expect(cat.ops_read!.actionClasses!({ service: "datadog", path: "/anything" })).toEqual([]);
    expect(cat.db_read!.actionClasses!({ query: "select 1" })).toEqual([]);
  });
});
