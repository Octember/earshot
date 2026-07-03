import type { DynamicTool } from './types'

// The `github_api` host tool: one GitHub REST call per invocation, executed by the brain with its
// own token (GITHUB_TOKEN lives ONLY on the brain). The agent names method + path; the host is a
// thin, auditable transport — same posture as linear_graphql/db_read.

const MAX_OUTPUT = 100_000

// Pure validators so hosts can policy-gate and reject junk fast (unit-testable, not the security
// boundary — the token's scopes are).
export function isGithubWrite(method: string | undefined): boolean {
  return !['GET', 'HEAD', undefined, ''].includes(method?.toUpperCase?.() ?? undefined)
}

export function validateGithubPath(path: string): { path: string } | { error: string } {
  const p = path.trim()
  if (!p.startsWith('/')) return { error: 'path must start with "/" (e.g. /repos/{owner}/{repo}/pulls)' }
  if (p.includes('..') || /\s/.test(p)) return { error: 'malformed path' }
  return { path: p }
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    method: { type: 'string', description: 'HTTP method (default GET). Writes (POST/PATCH/PUT/DELETE) may be policy-gated by the host.' },
    path: { type: 'string', description: 'REST path starting with "/", e.g. /repos/{owner}/{repo}/pulls?state=open or /search/issues?q=…' },
    body: { type: 'object', description: 'JSON request body for writes.' },
  },
}

const DESCRIPTION =
  'Call the GitHub REST API (api.github.com) with the brain\'s token. Input: { method?, path, body? } — path starts with "/", query string allowed. ' +
  'Examples: GET /repos/{owner}/{repo}/pulls?state=open, GET /search/issues?q=repo:owner/name+is:open+export, GET /repos/{owner}/{repo}/commits. ' +
  'Responses are JSON, truncated when huge — prefer specific endpoints and per_page over broad dumps.'

export function githubApiTool(fetchFn: typeof fetch = fetch): DynamicTool {
  return {
    spec: { name: 'github_api', description: DESCRIPTION, inputSchema: SCHEMA },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      const rawPath = typeof a.path === 'string' ? a.path : ''
      const v = validateGithubPath(rawPath)
      if ('error' in v) return fail(v.error)
      const token = process.env.GITHUB_TOKEN
      if (!token) return fail('not_configured: GITHUB_TOKEN is unset on this brain — if this call is essential, record it as a blocker for the operator; do not retry.')
      const method = (typeof a.method === 'string' && a.method ? a.method : 'GET').toUpperCase()
      try {
        const res = await fetchFn(`https://api.github.com${v.path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'bevyl-agent-kit',
            ...(a.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: a.body ? JSON.stringify(a.body) : undefined,
        })
        const text = await res.text()
        if (!res.ok) return fail(`github ${res.status}: ${text.slice(0, 2000)}`)
        return { success: true, output: text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated — narrow the request]` : text }
      } catch (e) {
        return fail(`request failed — ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

function fail(message: string): { success: false; output: string } {
  return { success: false, output: JSON.stringify({ error: { message } }, null, 2) }
}
