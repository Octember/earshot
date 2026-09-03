import { linearGraphqlTool, githubApiTool, notionApiTool } from "@bevyl-ai/agent-tools";
import type { ToolRegistry } from "./catalog-types";

export const vendorIntegrationRegistries = (): ToolRegistry[] => [
  {
    name: "linear",
    skill:
      "Your window into the team's tickets: look them up, file new ones, update existing ones. " +
      "Before changing anything, look up the real ids you need first (a team by its key, a workflow state by its name); " +
      "names are how people talk, ids are what changes stick to. Tickets go by identifiers like ACME-4128. " +
      "Check whether a ticket already covers something before filing a new one.",
    examples: [
      {
        when: "check whether a ticket already covers it",
        tool: "linear_graphql",
        args: {
          query:
            'query { issues(first: 10, filter: { title: { containsIgnoreCase: "export fails" } }) { nodes { identifier title url state { name } } } }',
        },
      },
      {
        when: "find the team and its workflow states before filing",
        tool: "linear_graphql",
        args: {
          query:
            'query { teams(filter: { key: { eq: "ACME" } }) { nodes { id key states { nodes { id name type } } } } }',
        },
      },
      {
        when: "file the ticket once you hold the ids",
        tool: "linear_graphql",
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
    tools: { linear_graphql: linearGraphqlTool() },
  },
  {
    name: "github",
    skill:
      "The team's code home: repositories, pull requests, issues, commit history. Reach for it to answer what changed, " +
      "what's open, and who touched what — ask for the specific thing you need rather than broad dumps.",
    examples: [
      {
        when: "see what's open on a repo",
        tool: "github_api",
        args: { path: "/repos/acme/widget/pulls?state=open&per_page=10" },
      },
      {
        when: "comment on an issue",
        tool: "github_api",
        args: {
          method: "POST",
          path: "/repos/acme/widget/issues/42/comments",
          body: { body: "<the comment>" },
        },
      },
    ],
    tools: { github_api: githubApiTool() },
  },
  {
    name: "notion",
    skill:
      "The team's shared docs. Find pages by searching, then read a page's properties and its content. " +
      "Only pages shared with you are visible — an empty result can mean not-shared, not does-not-exist.",
    examples: [
      {
        when: "find a doc by words in its title",
        tool: "notion_api",
        args: { method: "POST", path: "/v1/search", body: { query: "onboarding runbook" } },
      },
      {
        when: "read a page's content once you have its id",
        tool: "notion_api",
        args: { path: "/v1/blocks/<page id>/children" },
      },
    ],
    tools: { notion_api: notionApiTool() },
  },
];
