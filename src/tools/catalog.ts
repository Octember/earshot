import type { ToolExample, ToolRegistry } from "./catalog-types";
import { opsReadTool, dbReadTool, type DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolCatalog } from "../policy/broker";
import { vendorIntegrationRegistries } from "./catalog-integrations";
import { fromKitReadOnly } from "./catalog-grain";

export const INTEGRATION_REGISTRIES: ToolRegistry[] = [
  ...vendorIntegrationRegistries(),
  {
    name: "ops",
    skill:
      "Read-only observability: Datadog monitors and logs, Trigger.dev runs, Vercel deployments, Sentry. Real counts beat channel-history guesses.",
    tools: { ops_read: fromKitReadOnly(opsReadTool()) },
  },
  {
    name: "db",
    skill:
      "Read-only SQL against the production Postgres (SELECT-only role). Read SUPABASE.md in your workspace before writing a query; it maps the schema and the gotchas.",
    tools: { db_read: fromKitReadOnly(dbReadTool()) },
  },
];

export function flattenRegistries(registries: ToolRegistry[]): ToolCatalog {
  const catalog: ToolCatalog = {};
  for (const registry of registries)
    for (const [name, spec] of Object.entries(registry.tools)) catalog[name] = spec;
  return catalog;
}

interface ToolboxGroup {
  registry: string;
  skill?: string;
  tools: { name: string; description: string }[];
  examples?: ToolExample[];
}

export function buildToolbox(tools: DynamicTool[], registries: ToolRegistry[]): ToolboxGroup[] {
  const exposed = new Map(tools.map((tool) => [tool.spec.name, tool.spec.description]));
  const grouped = new Set<string>();
  const toolbox: ToolboxGroup[] = [];
  for (const registry of registries) {
    const present = Object.keys(registry.tools).filter((name) => exposed.has(name));
    if (present.length === 0) continue;
    for (const name of present) grouped.add(name);
    const examples = (registry.examples ?? []).filter((example) => exposed.has(example.tool));
    toolbox.push({
      registry: registry.name,
      ...(registry.skill ? { skill: registry.skill } : {}),
      tools: present.map((name) => ({ name, description: exposed.get(name)! })),
      ...(examples.length > 0 ? { examples } : {}),
    });
  }
  for (const tool of tools) {
    if (grouped.has(tool.spec.name)) continue;
    toolbox.push({
      registry: tool.spec.name,
      tools: [{ name: tool.spec.name, description: tool.spec.description }],
    });
  }
  return toolbox;
}

export function renderToolbox(
  toolbox: ToolboxGroup[],
  opts: { header?: string; brief?: boolean } = {},
): string {
  const header = opts.header ?? "Your tools this turn:";
  const describe = (text: string) => (opts.brief ? text.split(/(?<=\.)\s/)[0]! : text);
  const groups = toolbox.map((group) => {
    if (!group.skill && !(group.examples && group.examples.length > 0))
      return `## ${group.registry}: ${group.tools.map((tool) => tool.name).join(", ")}`;
    const lines = [`## ${group.registry}`];
    if (group.skill) lines.push(group.skill);
    lines.push(...group.tools.map((tool) => `- ${tool.name}: ${describe(tool.description)}`));
    for (const example of opts.brief ? [] : (group.examples ?? [])) {
      lines.push(
        `For example — ${example.when}:`,
        `${example.tool} ${JSON.stringify(example.args)}`,
      );
      if (example.result) lines.push(`→ ${example.result}`);
    }
    return lines.join("\n");
  });
  const body = `${groups.join("\n\n")}\n\nIf a tool isn't listed, you don't have it; say so plainly rather than working around it.`;
  return header ? `${header}\n\n${body}` : body;
}
