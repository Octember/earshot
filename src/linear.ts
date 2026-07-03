import type { DynamicTool } from './types'

// The `linear_graphql` host tool: a single raw GraphQL operation per call against Linear, executed
// by the brain with its own API key (LINEAR_API_KEY lives ONLY on the brain — the agent names an
// operation, the brain runs it). Same posture as db_read/ops_read: the credential never reaches the
// agent's workspace. One passthrough beats a hand-carved endpoint per verb: the agent composes the
// exact query it needs, and the host stays a thin, auditable transport.

const MAX_OUTPUT = 100_000 // chars returned to the agent — bounded so a wide result can't flood the turn

// Pure classifier so hosts can policy-gate writes (mutations) differently from reads. Strips leading
// comments/whitespace; a document whose first operation keyword is `mutation` is a write.
export function isLinearMutation(query: string): boolean {
  const stripped = query.replace(/^(?:\s|#[^\n]*\n?)+/, '').trim()
  return /^mutation\b/i.test(stripped)
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', description: 'GraphQL query or mutation document to execute against Linear. One operation per call.' },
    variables: { type: 'object', description: 'Optional GraphQL variables for the document.' },
  },
}

const DESCRIPTION =
  'Execute a single raw GraphQL query or mutation against Linear (issues, projects, comments, teams, workflow states). ' +
  'Input: { query, variables? }. One operation per call; a top-level `errors` array means it failed. ' +
  'Look up ids you need (team by key, state by name) with a read query before mutating. Issue identifiers look like "BEV-4128".'

export function linearGraphqlTool(fetchFn: typeof fetch = fetch): DynamicTool {
  return {
    spec: { name: 'linear_graphql', description: DESCRIPTION, inputSchema: SCHEMA },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      const query = typeof a.query === 'string' ? a.query : ''
      if (!query.trim()) return fail('missing_query')
      const apiKey = process.env.LINEAR_API_KEY
      if (!apiKey) return fail('not_configured: LINEAR_API_KEY is unset on this brain — if this call is essential, record it as a blocker for the operator; do not retry.')
      try {
        const res = await fetchFn('https://api.linear.app/graphql', {
          method: 'POST',
          headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: a.variables ?? undefined }),
        })
        const body = (await res.json()) as { data?: unknown; errors?: unknown[] }
        if (Array.isArray(body.errors) && body.errors.length > 0) return fail(`linear_graphql_errors: ${JSON.stringify(body.errors).slice(0, 2000)}`)
        const out = JSON.stringify(body.data ?? null, null, 2)
        return { success: true, output: out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n…[truncated — narrow the query]` : out }
      } catch (e) {
        return fail(`request failed — ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

function fail(message: string): { success: false; output: string } {
  return { success: false, output: JSON.stringify({ error: { message } }, null, 2) }
}
