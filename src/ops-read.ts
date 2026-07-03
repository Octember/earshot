import type { DynamicTool } from './types'

// The `ops_read` host tool: READ-ONLY observability over Trigger.dev, Vercel, Datadog, and Sentry. The factory's security
// posture deliberately keeps high-privilege keys off worker VMs (vm-setup.sh) — so, exactly like linear_graphql, the
// BRAIN holds the tokens and executes the call on the agent's behalf. Capability, not credential: the agent names an
// allowlisted read endpoint; the brain attaches auth, runs it, and returns the body. Nothing here can write: every
// (method, path) must match the per-service allowlist below, and the only non-GET entry is Datadog's log SEARCH
// endpoint (read-semantic, but POST-shaped). This exists because pit triage kept dead-ending tickets on
// "can't inspect prod" (failed Trigger runs, skipped Vercel preview builds, Datadog monitors).

const MAX_OUTPUT = 100_000 // chars of response body returned to the agent — plenty for run/deploy JSON, bounded for logs

interface OpsService {
  base(): string
  auth(): Record<string, string> | null // null = the brain has no token for this service
  envHint: string // what the operator must set, for the not-configured message
  allow: [method: string, prefix: string][] // (method, normalized-pathname prefix) — everything else is refused
}

const SERVICES: Record<string, OpsService> = {
  trigger: {
    base: () => 'https://api.trigger.dev',
    auth: () => (process.env.TRIGGER_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.TRIGGER_ACCESS_TOKEN}` } : null),
    envHint: 'TRIGGER_ACCESS_TOKEN',
    allow: [
      ['GET', '/api/v1/runs'], // list runs (filter by env/status/task via query params)
      ['GET', '/api/v3/runs'], // retrieve one run: /api/v3/runs/:runId (status, attempts, error, output)
      ['GET', '/api/v1/projects'], // project-scoped listing: /api/v1/projects/:projectRef/runs
      ['GET', '/api/v1/deployments'], // retrieve a deployment: /api/v1/deployments/:deploymentId
    ],
  },
  vercel: {
    base: () => 'https://api.vercel.com',
    auth: () => (process.env.VERCEL_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.VERCEL_ACCESS_TOKEN}` } : null),
    envHint: 'VERCEL_ACCESS_TOKEN',
    // One prefix per API version rather than a version-agnostic regex: Vercel moves endpoints across versions
    // (list=v6, get=v13, events=v3), and an explicit row per known-good path keeps the allowlist auditable.
    allow: [
      ['GET', '/v6/deployments'], // list deployments (?projectId=&state=&target=)
      ['GET', '/v13/deployments'], // get one deployment: /v13/deployments/:idOrUrl
      ['GET', '/v3/deployments'], // build events / logs: /v3/deployments/:idOrUrl/events
    ],
  },
  datadog: {
    base: () => `https://api.${process.env.DD_SITE || 'datadoghq.com'}`,
    auth: () => {
      // DATADOG_* first: that's the spelling in the brain's secrets.env (and the operator's ~/.bevyl/.env); the
      // DD_* forms are accepted as the other spelling common in the wild.
      const api = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
      const app = process.env.DATADOG_APPLICATION_KEY || process.env.DD_APPLICATION_KEY || process.env.DD_APP_KEY
      return api && app ? { 'dd-api-key': api, 'dd-application-key': app } : null
    },
    envHint: 'DATADOG_API_KEY + DATADOG_APPLICATION_KEY',
    allow: [
      ['GET', '/api/v1/monitor'], // list monitors + /api/v1/monitor/:id
      ['GET', '/api/v1/dashboard'], // list dashboards + /api/v1/dashboard/:id
      ['POST', '/api/v2/logs/events/search'], // the ONLY non-GET: log search is a read that Datadog shapes as a POST
    ],
  },
  sentry: {
    // Sentry's REST API lives under /api/0/. A read-scoped personal token (SENTRY_PERSONAL_API_KEY) — or the CI/release
    // SENTRY_AUTH_TOKEN as the other common spelling — goes in as a Bearer. GET-only on the two top-level read roots
    // covers alert rules, issues, and project/org config: the "why didn't Sentry page for this crash?" triage.
    base: () => 'https://sentry.io',
    auth: () => {
      const t = process.env.SENTRY_PERSONAL_API_KEY || process.env.SENTRY_AUTH_TOKEN
      return t ? { authorization: `Bearer ${t}` } : null
    },
    envHint: 'SENTRY_PERSONAL_API_KEY',
    allow: [
      ['GET', '/api/0/projects'], // project config + subpaths: /api/0/projects/:org/:project/(rules|issues|events|keys)
      ['GET', '/api/0/organizations'], // org-level: /api/0/organizations/:org/(projects|issues|integrations)
    ],
  },
}

// Resolve (service, method, path) to the exact URL the brain will hit — or a refusal. Pure apart from env reads
// (VERCEL_TEAM_ID, DD_SITE), so the allowlist + URL hygiene are unit-testable without any live API. Exported for tests.
export function resolveOpsRequest(service: string, method: string, path: string): { url: string } | { error: string } {
  const svc = SERVICES[service]
  if (!svc) return { error: `unknown_service: ${service} — one of: ${Object.keys(SERVICES).join(', ')}` }
  // The brain attaches real credentials to this request, so the path must not be able to steer it off-host:
  // '//evil.com/x' is protocol-relative, and WHATWG URL folds '\' to '/' ('/\evil.com' → '//evil.com'). Require a
  // plain absolute path AND pin the resolved origin to the service base — belt and braces.
  if (!path.startsWith('/') || /^\/[/\\]/.test(path)) return { error: 'invalid_path: must be an absolute path like /api/v1/runs' }
  let url: URL
  try {
    url = new URL(path, svc.base())
  } catch {
    return { error: `invalid_path: ${path}` }
  }
  if (url.origin !== new URL(svc.base()).origin) return { error: 'invalid_path: must stay on the service API host' }
  // Match on the NORMALIZED pathname (URL parsing resolves ../ segments and strips the query), so dot-segment or
  // query tricks can't smuggle a non-allowlisted endpoint past a prefix check on the raw string.
  const m = method.toUpperCase()
  const ok = svc.allow.some(([am, prefix]) => am === m && (url.pathname === prefix || url.pathname.startsWith(prefix + '/')))
  if (!ok) {
    const allowed = svc.allow.map(([am, prefix]) => `${am} ${prefix}`).join(', ')
    return { error: `refused: ${m} ${url.pathname} is not on the ${service} READ allowlist. This tool is read-only; allowed: ${allowed} (each also matches subpaths).` }
  }
  // Vercel scopes everything by team: append the brain's teamId so the agent doesn't have to know it (an explicit
  // teamId in the path wins, for the odd cross-team read an operator might steer).
  if (service === 'vercel' && process.env.VERCEL_TEAM_ID && !url.searchParams.has('teamId')) url.searchParams.set('teamId', process.env.VERCEL_TEAM_ID)
  return { url: url.toString() }
}

// Built per session, not module-load, so the project refs/ids reflect the brain's CURRENT env — the agent can't read
// them any other way (they live only on the brain).
function describe(): string {
  const refs = [
    process.env.TRIGGER_FAST_PROJECT_REF ? `fast=${process.env.TRIGGER_FAST_PROJECT_REF}` : null,
    process.env.BACKEND_TASKS_TRIGGER_PROJECT_REF ? `backend-tasks=${process.env.BACKEND_TASKS_TRIGGER_PROJECT_REF}` : null,
  ].filter(Boolean)
  return (
    'READ-ONLY observability over production systems, executed by the brain (no credentials exist on this VM). ' +
    'Input: { service: "trigger"|"vercel"|"datadog"|"sentry", path, method?, body? }. Only allowlisted read endpoints run; everything else is refused:\n' +
    `• trigger (api.trigger.dev): GET /api/v1/runs (list), /api/v3/runs/:runId (one run: status/attempts/error), /api/v1/projects/:projectRef/runs, /api/v1/deployments/:id.${refs.length ? ` Project refs: ${refs.join(', ')}.` : ''}\n` +
    `• vercel (api.vercel.com): GET /v6/deployments (list — filter ?projectId=…), /v13/deployments/:idOrUrl (one deployment incl. build state), /v3/deployments/:idOrUrl/events (build logs). teamId is appended for you.${process.env.VERCEL_PROJECT_ID ? ` Project id: ${process.env.VERCEL_PROJECT_ID}.` : ''}\n` +
    '• datadog: GET /api/v1/monitor (+/:id), /api/v1/dashboard (+/:id); POST /api/v2/logs/events/search with { body } (log search — the only POST allowed).\n' +
    '• sentry (sentry.io): GET /api/0/projects/:org/:project/(rules|issues|events) and /api/0/organizations/:org/(projects|integrations) — alert rules, issues, and project/org config (e.g. why an error did not page).\n' +
    "Use it to diagnose a failed prod Trigger run, see why a Vercel preview didn't build, read Datadog monitors/logs, or check Sentry alert rules — instead of dead-ending on \"can't inspect prod\"."
  )
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['service', 'path'],
  properties: {
    service: { enum: ['trigger', 'vercel', 'datadog', 'sentry'], description: 'Which system to read.' },
    path: { type: 'string', description: 'Absolute API path incl. query string, e.g. /v6/deployments?projectId=…' },
    method: { enum: ['GET', 'POST'], description: 'Default GET. POST only for the datadog log search endpoint.' },
    body: { type: 'object', description: '(POST only) JSON request body, e.g. { filter: { query, from, to } }.', additionalProperties: true },
  },
}

export function opsReadTool(): DynamicTool {
  return {
    spec: { name: 'ops_read', description: describe(), inputSchema: SCHEMA },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      const service = typeof a.service === 'string' ? a.service : ''
      const path = typeof a.path === 'string' ? a.path.trim() : ''
      const method = typeof a.method === 'string' ? a.method.toUpperCase() : 'GET'
      const svc = SERVICES[service]
      if (!svc) return fail(`unknown_service: ${service || '(missing)'} — one of: ${Object.keys(SERVICES).join(', ')}`)
      if (!path) return fail('missing_path')
      const headers = svc.auth()
      // Missing token = a brain-config gap, not an agent error: say so plainly so the agent reports it as a blocker
      // instead of retrying or inventing credentials.
      if (!headers) return fail(`not_configured: ${service} is not configured on this brain (${svc.envHint} unset) — if this read is essential, record it as a blocker for the operator; do not retry.`)
      const req = resolveOpsRequest(service, method, path)
      if ('error' in req) return fail(req.error)
      const body = method === 'POST' && a.body && typeof a.body === 'object' && !Array.isArray(a.body) ? JSON.stringify(a.body) : undefined
      let res: Response
      try {
        // 30s network timeout, same as linear.ts — a hung upstream must never wedge the agent's turn.
        res = await fetch(req.url, { method, headers: body ? { ...headers, 'content-type': 'application/json' } : headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(30_000) })
      } catch (e) {
        return fail(`${service}: request failed — ${e instanceof Error ? e.message : String(e)}`)
      }
      const text = await res.text()
      const out = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} of ${text.length} chars — narrow the query]` : text
      return { success: res.ok, output: `HTTP ${res.status}\n${out}` }
    },
  }
}

function fail(message: string): { success: false; output: string } {
  return { success: false, output: JSON.stringify({ error: { message } }, null, 2) }
}
