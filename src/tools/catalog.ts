// earshot's external-tool catalog: @bevyl/agent-kit's thin-transport integration tools, wrapped with
// earshot's policy layer (SPEC §10.1/§10.2). The kit is policy-agnostic; HERE writes get classified as
// consequential (`outward`) so the broker's preauthorization/confirmation gate applies — a Linear
// mutation or a GitHub/Notion write is an outward action, a read is just a read. Keys live only in
// the daemon's env (the codex child is scrubbed); a tool with no key fails friendly, not silently.
import {
  linearGraphqlTool,
  isLinearMutation,
  githubApiTool,
  isGithubWrite,
  notionApiTool,
  isNotionReadPath,
  type DynamicTool,
} from "@bevyl/agent-kit";
import type { ActionClass, ToolCatalog, ToolSpec } from "../policy/broker";

function fromKit(t: DynamicTool, actionClasses?: (args: unknown) => ActionClass[]): ToolSpec {
  return {
    description: t.spec.description,
    inputSchema: t.spec.inputSchema,
    run: (args) => t.run(args),
    actionClasses,
  };
}

export const INTEGRATION_TOOL_NAMES = ["linear_graphql", "github_api", "notion_api"] as const;

export function integrationCatalog(): ToolCatalog {
  return {
    linear_graphql: fromKit(linearGraphqlTool(), (args) => {
      const q = (args as { query?: string } | null)?.query ?? "";
      return isLinearMutation(q) ? ["outward"] : [];
    }),
    github_api: fromKit(githubApiTool(), (args) => {
      const m = (args as { method?: string } | null)?.method;
      return isGithubWrite(m) ? ["outward"] : [];
    }),
    notion_api: fromKit(notionApiTool(), (args) => {
      const a = (args as { method?: string; path?: string } | null) ?? {};
      return isNotionReadPath(a.method, a.path ?? "") ? [] : ["outward"];
    }),
  };
}
