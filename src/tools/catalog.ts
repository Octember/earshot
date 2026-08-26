// External-tool catalog: registries of skill + examples + read/write tools; broker catalog is derived.
import {
  linearGraphqlTool,
  isLinearMutation,
  githubApiTool,
  isGithubWrite,
  notionApiTool,
  isNotionReadPath,
  opsReadTool,
  dbReadTool,
  type DynamicTool,
} from "@bevyl-ai/agent-tools";
import type { ToolCatalog, ToolSpec } from "../policy/broker";
import { isRecord } from "../guard";

// Worked example; filtered to tools exposed on this turn.
export interface ToolExample {
  when: string; // "file the ticket once you hold the ids"
  tool: string; // must name a tool in this registry (enforced by test, not runtime)
  args: unknown; // the literal arguments object, JSON-rendered verbatim into the prompt
  result?: string; // optional trimmed sample response — teaches the success/failure shape
}

export interface ToolRegistry {
  name: string;
  // Capability prose only — no transport mechanics (parrot risk).
  skill?: string;
  examples?: ToolExample[]; // ordered — a lookup-then-change workflow reads in sequence
  tools: Record<string, ToolSpec>;
}

// Kit grain: reject wrong read/write side before transport.
function grain(t: DynamicTool, opts: { description: string; write: boolean; wrongGrain: (args: unknown) => boolean; rejection: string; scopeCheck?: ToolSpec["scopeCheck"] }): ToolSpec {
  return {
    description: opts.description,
    inputSchema: t.spec.inputSchema,
    actionClasses: opts.write ? () => ["outward"] : () => [],
    ...(opts.scopeCheck ? { scopeCheck: opts.scopeCheck } : {}),
    run: async (args) => (opts.wrongGrain(args) ? { success: false, output: opts.rejection } : t.run(args)),
  };
}

// Top-level GraphQL mutation field names (aliases resolved); used by grant scope checks.
export function topLevelMutationFields(query: string): string[] {
  const fields: string[] = [];
  // Strip string literals and comments so braces inside them don't skew depth.
  const clean = query.replaceAll(/"(?:[^"\\]|\\.)*"/g, '""').replaceAll(/#[^\n]*/g, "");
  const opRe = /\bmutation\b[^{]*\{/g;
  let op: RegExpExecArray | null;
  while ((op = opRe.exec(clean))) {
    let depth = 1;
    let i = opRe.lastIndex;
    let buf = "";
    while (i < clean.length && depth > 0) {
      const ch = clean[i]!;
      if (ch === "{") {
        depth++;
        buf = "";
      } else if (ch === "}") {
        depth--;
        buf = "";
      } else if (depth === 1) {
        if (ch === "(") {
          // arguments open: the identifier just read is a top-level field
          const m = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(buf);
          if (m) fields.push(m[2]!);
          // skip to the matching close paren
          let p = 1;
          while (i + 1 < clean.length && p > 0) {
            i++;
            if (clean[i] === "(") p++;
            else if (clean[i] === ")") p--;
          }
          buf = "";
        } else {
          buf += ch;
        }
      }
      // a field with a selection set but no args: identifier directly before '{'
      if (ch === "{" && depth === 2) {
        const m = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(clean.slice(op.index, i).split("{").pop() ?? "");
        if (m && m[2] && !fields.includes(m[2])) fields.push(m[2]);
      }
      i++;
    }
    opRe.lastIndex = i;
  }
  return [...new Set(fields)];
}

function asRecord(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

function linearRegistry(): ToolRegistry {
  const kit = linearGraphqlTool();
  // Missing query → kit's missing_query, not wrong-grain.
  const doc = (args: unknown) => {
    const q = asRecord(args).query;
    return typeof q === "string" && q.trim().length > 0 ? q : null;
  };
  return {
    name: "linear",
    skill:
      "Your window into the team's tickets: look them up, file new ones, update existing ones. " +
      "Before changing anything, look up the real ids you need first (a team by its key, a workflow state by its name); " +
      "names are how people talk, ids are what changes stick to. Tickets go by identifiers like ACME-4128. " +
      "Check whether a ticket already covers something before filing a new one. " +
      "A change that matters will wait for a go-ahead before it lands.",
    examples: [
      {
        when: "check whether a ticket already covers it",
        tool: "linear_read",
        args: { query: 'query { issues(first: 10, filter: { title: { containsIgnoreCase: "export fails" } }) { nodes { identifier title url state { name } } } }' },
      },
      {
        when: "find the team and its workflow states before filing",
        tool: "linear_read",
        args: { query: 'query { teams(filter: { key: { eq: "ACME" } }) { nodes { id key states { nodes { id name type } } } } }' },
      },
      {
        when: "file the ticket once you hold the ids",
        tool: "linear_write",
        args: {
          query: "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
          variables: { input: { teamId: "<team id>", title: "<title>", description: "<details, links, who reported it>" } },
        },
        result: '{"data":{"issueCreate":{"success":true,"issue":{"identifier":"ACME-4321","url":"https://linear.app/acme/issue/ACME-4321/…"}}}} — a top-level "errors" array instead means it did NOT go through, whatever the status looked like',
      },
    ],
    tools: {
      linear_read: grain(kit, {
        description:
          "Look up Linear issues, projects, comments, teams, and workflow states — read-only. Input: { query, variables? } (a GraphQL query document, one operation per call).",
        write: false,
        wrongGrain: (args) => {
          const q = doc(args);
          return q !== null && isLinearMutation(q);
        },
        rejection: "linear_read is read-only — that operation changes something, so it belongs to linear_write.",
      }),
      linear_write: grain(kit, {
        description:
          "Create or update Linear issues, comments, and states. Input: { query, variables? } (a GraphQL mutation document, one operation per call). Consequential — may wait for a go-ahead.",
        write: true,
        wrongGrain: (args) => {
          const q = doc(args);
          return q !== null && !isLinearMutation(q);
        },
        rejection: "linear_write only changes things — look-ups belong to linear_read.",
        // scope.mutations allowlist; fail closed.
        scopeCheck: (scope, args) => {
          const q = doc(args);
          if (!q) return "no mutation document to authorize";
          const fields = topLevelMutationFields(q);
          if (fields.length === 0) return "couldn't identify the mutation being made — write one plain operation per call";
          const allowed = new Set(Array.isArray(scope.mutations) ? scope.mutations.filter((x): x is string => typeof x === "string") : []);
          const outside = fields.filter((f) => !allowed.has(f));
          return outside.length > 0 ? `this workspace only lets me make these kinds of changes: ${[...allowed].join(", ")} — ${outside.join(", ")} isn't one of them` : null;
        },
      }),
    },
  };
}

function githubRegistry(): ToolRegistry {
  const kit = githubApiTool();
  const method = (args: unknown) => {
    const m = asRecord(args).method;
    return typeof m === "string" ? m : undefined;
  };
  return {
    name: "github",
    skill:
      "The team's code home: repositories, pull requests, issues, commit history. Reach for it to answer what changed, " +
      "what's open, and who touched what — ask for the specific thing you need rather than broad dumps. " +
      "Making a change (filing an issue, commenting) will wait for a go-ahead before it lands.",
    examples: [
      {
        when: "see what's open on a repo",
        tool: "github_read",
        args: { path: "/repos/acme/widget/pulls?state=open&per_page=10" },
      },
      {
        when: "comment on an issue",
        tool: "github_write",
        args: { method: "POST", path: "/repos/acme/widget/issues/42/comments", body: { body: "<the comment>" } },
      },
    ],
    tools: {
      github_read: grain(kit, {
        description: "Read from the GitHub REST API — read-only (GET/HEAD). Input: { path, method? } — path starts with \"/\", query string allowed.",
        write: false,
        wrongGrain: (args) => isGithubWrite(method(args)),
        rejection: "github_read is read-only — that call changes something, so it belongs to github_write.",
      }),
      github_write: grain(kit, {
        description: "Write to the GitHub REST API (POST/PATCH/PUT/DELETE). Input: { method, path, body? }. Consequential — may wait for a go-ahead.",
        write: true,
        wrongGrain: (args) => !isGithubWrite(method(args)),
        rejection: "github_write only changes things — reads belong to github_read.",
      }),
    },
  };
}

function notionRegistry(): ToolRegistry {
  const kit = notionApiTool();
  const call = (args: unknown) => {
    const a = asRecord(args);
    return { method: typeof a.method === "string" ? a.method : undefined, path: typeof a.path === "string" ? a.path : "" };
  };
  return {
    name: "notion",
    skill:
      "The team's shared docs. Find pages by searching, then read a page's properties and its content. " +
      "Only pages shared with you are visible — an empty result can mean not-shared, not does-not-exist. " +
      "Editing a doc will wait for a go-ahead before it lands.",
    examples: [
      {
        when: "find a doc by words in its title",
        tool: "notion_read",
        args: { method: "POST", path: "/v1/search", body: { query: "onboarding runbook" } },
      },
      {
        when: "read a page's content once you have its id",
        tool: "notion_read",
        args: { path: "/v1/blocks/<page id>/children" },
      },
    ],
    tools: {
      notion_read: grain(kit, {
        description: "Read from the Notion API — searches, page properties, page content. Input: { method?, path, body? }, path starts with \"/v1/\".",
        write: false,
        wrongGrain: (args) => {
          const { method, path } = call(args);
          return path.trim().length > 0 && !isNotionReadPath(method, path);
        },
        rejection: "notion_read is read-only — that call changes something, so it belongs to notion_write.",
      }),
      notion_write: grain(kit, {
        description: "Write to the Notion API — create or update pages and blocks. Input: { method, path, body? }. Consequential — may wait for a go-ahead.",
        write: true,
        wrongGrain: (args) => {
          const { method, path } = call(args);
          return path.trim().length > 0 && isNotionReadPath(method, path);
        },
        rejection: "notion_write only changes things — searches and reads belong to notion_read.",
      }),
    },
  };
}

function fromKitReadOnly(t: DynamicTool): ToolSpec {
  return { description: t.spec.description, inputSchema: t.spec.inputSchema, actionClasses: () => [], run: (args) => t.run(args) };
}

export const INTEGRATION_REGISTRIES: ToolRegistry[] = [
  linearRegistry(),
  githubRegistry(),
  notionRegistry(),
  // Read-only by construction (per-service endpoint allowlist inside the kit) — never outward.
  {
    name: "ops",
    skill: "Read-only observability: Datadog monitors and logs, Trigger.dev runs, Vercel deployments, Sentry. Real counts beat channel-history guesses.",
    tools: { ops_read: fromKitReadOnly(opsReadTool()) },
  },
  // SELECT-only via readonly_user; needs SUPABASE_READONLY_URL.
  {
    name: "db",
    skill: "Read-only SQL against the production Postgres (SELECT-only role). Read SUPABASE.md in your workspace before writing a query; it maps the schema and the gotchas.",
    tools: { db_read: fromKitReadOnly(dbReadTool()) },
  },
];

export const INTEGRATION_TOOL_NAMES: string[] = INTEGRATION_REGISTRIES.flatMap((r) => Object.keys(r.tools));

// Flat name→spec map for the broker.
export function flattenRegistries(registries: ToolRegistry[]): ToolCatalog {
  const cat: ToolCatalog = {};
  for (const r of registries) for (const [name, spec] of Object.entries(r.tools)) cat[name] = spec;
  return cat;
}

export function integrationCatalog(): ToolCatalog {
  return flattenRegistries(INTEGRATION_REGISTRIES);
}

// Toolbox digest from the exposed toolset (not static config); groups only include exposed tools.
export interface ToolboxGroup {
  registry: string;
  skill?: string;
  tools: { name: string; description: string }[];
  examples?: ToolExample[];
}

export function buildToolbox(tools: DynamicTool[], registries: ToolRegistry[]): ToolboxGroup[] {
  const exposed = new Map(tools.map((t) => [t.spec.name, t.spec.description]));
  const grouped = new Set<string>();
  const toolbox: ToolboxGroup[] = [];
  for (const r of registries) {
    const present = Object.keys(r.tools).filter((name) => exposed.has(name));
    if (present.length === 0) continue;
    for (const name of present) grouped.add(name);
    const examples = (r.examples ?? []).filter((ex) => exposed.has(ex.tool));
    toolbox.push({
      registry: r.name,
      ...(r.skill ? { skill: r.skill } : {}),
      tools: present.map((name) => ({ name, description: exposed.get(name)! })),
      ...(examples.length > 0 ? { examples } : {}),
    });
  }
  for (const t of tools) {
    if (grouped.has(t.spec.name)) continue;
    toolbox.push({ registry: t.spec.name, tools: [{ name: t.spec.name, description: t.spec.description }] });
  }
  return toolbox;
}

// Toolbox digest for the turn prompt.
export function renderToolbox(toolbox: ToolboxGroup[], header = "Your tools this turn:"): string {
  const groups = toolbox.map((g) => {
    if (!g.skill && !(g.examples && g.examples.length > 0)) return `## ${g.registry}: ${g.tools.map((t) => t.name).join(", ")}`;
    const lines = [`## ${g.registry}`];
    if (g.skill) lines.push(g.skill);
    lines.push(...g.tools.map((t) => `- ${t.name}: ${t.description}`));
    for (const ex of g.examples ?? []) {
      lines.push(`For example — ${ex.when}:`, `${ex.tool} ${JSON.stringify(ex.args)}`);
      if (ex.result) lines.push(`→ ${ex.result}`);
    }
    return lines.join("\n");
  });
  const body = `${groups.join("\n\n")}\n\nIf a tool isn't listed, you don't have it; say so plainly rather than working around it.`;
  return header ? `${header}\n\n${body}` : body;
}
