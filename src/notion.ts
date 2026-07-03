import type { DynamicTool } from './types'

// The `notion_api` host tool: one Notion REST call per invocation, executed by the brain with its
// own integration token (NOTION_API_KEY lives ONLY on the brain). Same thin-transport posture as
// github_api/linear_graphql. Only pages/databases shared with the integration are visible.

const MAX_OUTPUT = 100_000
const NOTION_VERSION = '2022-06-28'

export function isNotionWrite(method: string | undefined): boolean {
  // Notion's search + database queries are POSTs that read — treat those paths as reads.
  return !['GET', 'HEAD', undefined, ''].includes(method?.toUpperCase?.() ?? undefined)
}

export function isNotionReadPath(method: string | undefined, path: string): boolean {
  const m = (method ?? 'GET').toUpperCase()
  if (m === 'GET' || m === 'HEAD') return true
  if (m !== 'POST') return false
  return /^\/v1\/(search|databases\/[^/]+\/query|data_sources\/[^/]+\/query)\b/.test(path.trim())
}

export function validateNotionPath(path: string): { path: string } | { error: string } {
  const p = path.trim()
  if (!p.startsWith('/v1/')) return { error: 'path must start with "/v1/" (e.g. /v1/search, /v1/pages/{id}, /v1/blocks/{id}/children)' }
  if (p.includes('..') || /\s/.test(p)) return { error: 'malformed path' }
  return { path: p }
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    method: { type: 'string', description: 'HTTP method (default GET). POST /v1/search and database queries are reads; page/block writes may be policy-gated by the host.' },
    path: { type: 'string', description: 'Notion API path starting with "/v1/", e.g. /v1/search, /v1/pages/{id}, /v1/blocks/{id}/children?page_size=50' },
    body: { type: 'object', description: 'JSON request body (e.g. { query: "roadmap" } for search).' },
  },
}

const DESCRIPTION =
  'Call the Notion API (api.notion.com) with the brain\'s integration token. Input: { method?, path, body? }. ' +
  'Find things: POST /v1/search with { query }. Read a page: GET /v1/pages/{id} for properties, GET /v1/blocks/{id}/children for content. ' +
  'Only pages shared with the integration are visible. Responses truncated when huge.'

export function notionApiTool(fetchFn: typeof fetch = fetch): DynamicTool {
  return {
    spec: { name: 'notion_api', description: DESCRIPTION, inputSchema: SCHEMA },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      const rawPath = typeof a.path === 'string' ? a.path : ''
      const v = validateNotionPath(rawPath)
      if ('error' in v) return fail(v.error)
      const token = process.env.NOTION_API_KEY
      if (!token) return fail('not_configured: NOTION_API_KEY is unset on this brain — if this call is essential, record it as a blocker for the operator; do not retry.')
      const method = (typeof a.method === 'string' && a.method ? a.method : 'GET').toUpperCase()
      try {
        const res = await fetchFn(`https://api.notion.com${v.path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': NOTION_VERSION,
            ...(a.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: a.body ? JSON.stringify(a.body) : undefined,
        })
        const text = await res.text()
        if (!res.ok) return fail(`notion ${res.status}: ${text.slice(0, 2000)}`)
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
