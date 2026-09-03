import {
  linearGraphqlTool,
  isLinearMutation,
  githubApiTool,
  isGithubWrite,
  notionApiTool,
  isNotionReadPath,
} from "@bevyl-ai/agent-tools";
import type { ToolRegistry } from "./catalog-types";
import { asRecord, readWritePair, topLevelMutationFields } from "./catalog-grain";

function linearDoc(args: unknown) {
  const query = asRecord(args).query;
  return typeof query === "string" && query.trim().length > 0 ? query : null;
}

function linearRegistry(): ToolRegistry {
  const kit = linearGraphqlTool();
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
        args: {
          query:
            'query { issues(first: 10, filter: { title: { containsIgnoreCase: "export fails" } }) { nodes { identifier title url state { name } } } }',
        },
      },
      {
        when: "find the team and its workflow states before filing",
        tool: "linear_read",
        args: {
          query:
            'query { teams(filter: { key: { eq: "ACME" } }) { nodes { id key states { nodes { id name type } } } } }',
        },
      },
      {
        when: "file the ticket once you hold the ids",
        tool: "linear_write",
        args: {
          query:
            "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
          variables: {
            input: {
              teamId: "<team id>",
              title: "<title>",
              description: "<details, links, who reported it>",
            },
          },
        },
        result:
          '{"data":{"issueCreate":{"success":true,"issue":{"identifier":"ACME-4321","url":"https://linear.app/acme/issue/ACME-4321/…"}}}} — a top-level "errors" array instead means it did NOT go through, whatever the status looked like',
      },
    ],
    tools: readWritePair({
      kit,
      readName: "linear_read",
      writeName: "linear_write",
      readDescription:
        "Look up Linear issues, projects, comments, teams, and workflow states — read-only. Input: { query, variables? } (a GraphQL query document, one operation per call).",
      writeDescription:
        "Create or update Linear issues, comments, and states. Input: { query, variables? } (a GraphQL mutation document, one operation per call). Consequential — may wait for a go-ahead.",
      isWrite: (args) => {
        const document = linearDoc(args);
        return document !== null && isLinearMutation(document);
      },
      readRejection:
        "linear_read is read-only — that operation changes something, so it belongs to linear_write.",
      writeRejection: "linear_write only changes things — look-ups belong to linear_read.",
      scopeCheck: (scope, args) => {
        const document = linearDoc(args);
        if (!document) return "no mutation document to authorize";
        const fields = topLevelMutationFields(document);
        if (fields.length === 0)
          return "couldn't identify the mutation being made — write one plain operation per call";
        const allowed = new Set(
          Array.isArray(scope.mutations)
            ? scope.mutations.filter((x): x is string => typeof x === "string")
            : [],
        );
        const outside = fields.filter((field) => !allowed.has(field));
        return outside.length > 0
          ? `this workspace only lets me make these kinds of changes: ${[...allowed].join(", ")} — ${outside.join(", ")} isn't one of them`
          : null;
      },
    }),
  };
}

function githubRegistry(): ToolRegistry {
  const kit = githubApiTool();
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
        args: {
          method: "POST",
          path: "/repos/acme/widget/issues/42/comments",
          body: { body: "<the comment>" },
        },
      },
    ],
    tools: readWritePair({
      kit,
      readName: "github_read",
      writeName: "github_write",
      readDescription:
        'Read from the GitHub REST API — read-only (GET/HEAD). Input: { path, method? } — path starts with "/", query string allowed.',
      writeDescription:
        "Write to the GitHub REST API (POST/PATCH/PUT/DELETE). Input: { method, path, body? }. Consequential — may wait for a go-ahead.",
      isWrite: (args) => {
        const method = asRecord(args).method;
        return isGithubWrite(typeof method === "string" ? method : undefined);
      },
      readRejection:
        "github_read is read-only — that call changes something, so it belongs to github_write.",
      writeRejection: "github_write only changes things — reads belong to github_read.",
    }),
  };
}

function notionRegistry(): ToolRegistry {
  const kit = notionApiTool();
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
    tools: readWritePair({
      kit,
      readName: "notion_read",
      writeName: "notion_write",
      readDescription:
        'Read from the Notion API — searches, page properties, page content. Input: { method?, path, body? }, path starts with "/v1/".',
      writeDescription:
        "Write to the Notion API — create or update pages and blocks. Input: { method, path, body? }. Consequential — may wait for a go-ahead.",
      isWrite: (args) => {
        const rawArgs = asRecord(args);
        const method = typeof rawArgs.method === "string" ? rawArgs.method : undefined;
        const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
        return path.trim().length > 0 && !isNotionReadPath(method, path);
      },
      readRejection:
        "notion_read is read-only — that call changes something, so it belongs to notion_write.",
      writeRejection:
        "notion_write only changes things — searches and reads belong to notion_read.",
    }),
  };
}

export const vendorIntegrationRegistries = (): ToolRegistry[] => [
  linearRegistry(),
  githubRegistry(),
  notionRegistry(),
];
