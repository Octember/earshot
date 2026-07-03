import { expect, test } from 'bun:test'
import { opsReadTool, resolveOpsRequest } from './ops-read'

// resolveOpsRequest / the tool's auth read a few env vars (tokens, VERCEL_TEAM_ID, DD_SITE); run each case with a
// controlled env and restore afterwards so tests can't leak into each other (bun runs the suite in one process).
// Awaits fn so the restore happens after an ASYNC body finishes, not when it merely returns its promise.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const err = (r: { url: string } | { error: string }): string => ('error' in r ? r.error : '')
const url = (r: { url: string } | { error: string }): string => ('url' in r ? r.url : '')

test('allows the read endpoints on each service', async () => {
  expect(url(resolveOpsRequest('trigger', 'GET', '/api/v1/runs'))).toBe('https://api.trigger.dev/api/v1/runs')
  expect(url(resolveOpsRequest('trigger', 'GET', '/api/v3/runs/run_abc123'))).toBe('https://api.trigger.dev/api/v3/runs/run_abc123')
  expect(url(resolveOpsRequest('trigger', 'GET', '/api/v1/projects/proj_ref/runs?env=prod'))).toContain('/api/v1/projects/proj_ref/runs')
  expect(url(resolveOpsRequest('trigger', 'GET', '/api/v1/deployments/dep_123'))).toContain('/api/v1/deployments/dep_123')
  await withEnv({ VERCEL_TEAM_ID: undefined }, () => {
    expect(url(resolveOpsRequest('vercel', 'GET', '/v6/deployments?projectId=prj_x'))).toBe('https://api.vercel.com/v6/deployments?projectId=prj_x')
    expect(url(resolveOpsRequest('vercel', 'GET', '/v13/deployments/dpl_123'))).toContain('/v13/deployments/dpl_123')
    expect(url(resolveOpsRequest('vercel', 'GET', '/v3/deployments/dpl_123/events'))).toContain('/v3/deployments/dpl_123/events')
  })
  expect(url(resolveOpsRequest('datadog', 'GET', '/api/v1/monitor/42'))).toContain('/api/v1/monitor/42')
  expect(url(resolveOpsRequest('datadog', 'GET', '/api/v1/dashboard'))).toContain('/api/v1/dashboard')
  expect(url(resolveOpsRequest('datadog', 'POST', '/api/v2/logs/events/search'))).toContain('/api/v2/logs/events/search')
  expect(url(resolveOpsRequest('sentry', 'GET', '/api/0/projects/bevyl/bevyl-web/rules/'))).toBe('https://sentry.io/api/0/projects/bevyl/bevyl-web/rules/')
  expect(url(resolveOpsRequest('sentry', 'GET', '/api/0/organizations/bevyl/projects/'))).toContain('/api/0/organizations/bevyl/projects/')
})

test('refuses any write-shaped call: non-GET everywhere except the datadog log search', () => {
  expect(err(resolveOpsRequest('trigger', 'POST', '/api/v1/runs'))).toContain('refused')
  expect(err(resolveOpsRequest('vercel', 'DELETE', '/v13/deployments/dpl_123'))).toContain('refused')
  expect(err(resolveOpsRequest('datadog', 'POST', '/api/v1/monitor'))).toContain('refused')
  expect(err(resolveOpsRequest('datadog', 'DELETE', '/api/v1/monitor/42'))).toContain('refused')
  expect(err(resolveOpsRequest('sentry', 'POST', '/api/0/projects/bevyl/bevyl-web/rules/'))).toContain('refused')
  expect(err(resolveOpsRequest('sentry', 'PUT', '/api/0/projects/bevyl/bevyl-web/'))).toContain('refused')
})

test('refuses GET on paths outside the allowlist, and the refusal names what IS allowed', () => {
  const e = err(resolveOpsRequest('trigger', 'GET', '/api/v1/tasks/my-task/trigger'))
  expect(e).toContain('refused')
  expect(e).toContain('GET /api/v1/runs') // the message teaches the agent the allowlist instead of just saying no
  expect(err(resolveOpsRequest('vercel', 'GET', '/v9/projects'))).toContain('refused')
  expect(err(resolveOpsRequest('datadog', 'GET', '/api/v2/logs/events/search'))).toContain('refused') // search is POST-only
  expect(err(resolveOpsRequest('sentry', 'GET', '/api/0/internal/options'))).toContain('refused') // not under projects/ or organizations/
})

test('a prefix match cannot be spoofed by a longer sibling path segment', () => {
  // /api/v1/runsomething shares the string prefix but is NOT under /api/v1/runs — the match requires a '/' boundary.
  expect(err(resolveOpsRequest('trigger', 'GET', '/api/v1/runsomething'))).toContain('refused')
})

test('dot-segments are normalized BEFORE the allowlist check, so ../ cannot smuggle another endpoint', () => {
  expect(err(resolveOpsRequest('trigger', 'GET', '/api/v1/runs/../tasks/x/trigger'))).toContain('refused')
})

test('protocol-relative and backslash paths cannot steer the credentialed request off-host', () => {
  expect(err(resolveOpsRequest('vercel', 'GET', '//evil.com/v6/deployments'))).toContain('invalid_path')
  expect(err(resolveOpsRequest('vercel', 'GET', '/\\evil.com/v6/deployments'))).toContain('invalid_path')
  expect(err(resolveOpsRequest('vercel', 'GET', 'https://evil.com/v6/deployments'))).toContain('invalid_path')
})

test('unknown service is refused with the valid options', () => {
  expect(err(resolveOpsRequest('github', 'GET', '/repos'))).toContain('unknown_service')
})

test('vercel: teamId is appended from env when set', async () => {
  await withEnv({ VERCEL_TEAM_ID: 'team_abc' }, () => {
    expect(url(resolveOpsRequest('vercel', 'GET', '/v6/deployments?projectId=prj_x'))).toBe('https://api.vercel.com/v6/deployments?projectId=prj_x&teamId=team_abc')
  })
})

test('vercel: an explicit teamId in the path is not overwritten', async () => {
  await withEnv({ VERCEL_TEAM_ID: 'team_abc' }, () => {
    expect(url(resolveOpsRequest('vercel', 'GET', '/v6/deployments?teamId=team_other'))).toContain('teamId=team_other')
    expect(url(resolveOpsRequest('vercel', 'GET', '/v6/deployments?teamId=team_other'))).not.toContain('team_abc')
  })
})

test('datadog: DD_SITE selects the regional API host (default datadoghq.com)', async () => {
  await withEnv({ DD_SITE: 'datadoghq.eu' }, () => {
    expect(url(resolveOpsRequest('datadog', 'GET', '/api/v1/monitor'))).toBe('https://api.datadoghq.eu/api/v1/monitor')
  })
  await withEnv({ DD_SITE: undefined }, () => {
    expect(url(resolveOpsRequest('datadog', 'GET', '/api/v1/monitor'))).toBe('https://api.datadoghq.com/api/v1/monitor')
  })
})

test('a service with no token on the brain returns not_configured instead of crashing (no network happens)', async () => {
  await withEnv({ TRIGGER_ACCESS_TOKEN: undefined }, async () => {
    const r = await opsReadTool().run({ service: 'trigger', path: '/api/v1/runs' })
    expect(r.success).toBe(false)
    expect(r.output).toContain('not_configured')
    expect(r.output).toContain('TRIGGER_ACCESS_TOKEN')
  })
  await withEnv({ DD_API_KEY: 'k', DD_APPLICATION_KEY: undefined, DD_APP_KEY: undefined }, async () => {
    const r = await opsReadTool().run({ service: 'datadog', path: '/api/v1/monitor' }) // one of the two datadog keys missing → still not configured
    expect(r.success).toBe(false)
    expect(r.output).toContain('not_configured')
  })
})

test('run() refuses a disallowed call before ever building a request (auth present, no network)', async () => {
  await withEnv({ TRIGGER_ACCESS_TOKEN: 'tr_secret' }, async () => {
    const r = await opsReadTool().run({ service: 'trigger', path: '/api/v1/tasks/x/trigger', method: 'POST' })
    expect(r.success).toBe(false)
    expect(r.output).toContain('refused')
  })
})

test('run() rejects malformed args cleanly', async () => {
  expect((await opsReadTool().run(null)).output).toContain('unknown_service')
  expect((await opsReadTool().run({ service: 'trigger' })).output).toContain('missing_path')
})
