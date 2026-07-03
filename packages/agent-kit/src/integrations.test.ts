import { describe, expect, test } from 'bun:test'
import { isLinearMutation, linearGraphqlTool } from './linear'
import { isGithubWrite, validateGithubPath, githubApiTool } from './github'
import { isNotionReadPath, validateNotionPath, notionApiTool } from './notion'

function fakeFetch(response: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(response), { status })) as unknown as typeof fetch
}

describe('isLinearMutation (host-side write gating)', () => {
  test('classifies mutations, tolerating comments and whitespace', () => {
    expect(isLinearMutation('mutation { issueCreate(input: {}) { success } }')).toBe(true)
    expect(isLinearMutation('  # create it\n mutation Create { issueCreate { success } }')).toBe(true)
    expect(isLinearMutation('query { issues { nodes { id } } }')).toBe(false)
    expect(isLinearMutation('{ issues { nodes { id } } }')).toBe(false) // anonymous query
  })
})

describe('linear_graphql', () => {
  test('missing key → not_configured, no request attempted', async () => {
    delete process.env.LINEAR_API_KEY
    const r = await linearGraphqlTool(fakeFetch({})).run({ query: '{ viewer { id } }' })
    expect(r.success).toBe(false)
    expect(r.output).toContain('not_configured')
  })

  test('returns data, and surfaces GraphQL errors as failures', async () => {
    process.env.LINEAR_API_KEY = 'lin_test'
    const ok = await linearGraphqlTool(fakeFetch({ data: { viewer: { id: 'u1' } } })).run({ query: '{ viewer { id } }' })
    expect(ok.success).toBe(true)
    expect(JSON.parse(ok.output)).toEqual({ viewer: { id: 'u1' } })

    const bad = await linearGraphqlTool(fakeFetch({ errors: [{ message: 'nope' }] })).run({ query: '{ x }' })
    expect(bad.success).toBe(false)
    expect(bad.output).toContain('linear_graphql_errors')
    delete process.env.LINEAR_API_KEY
  })
})

describe('github_api', () => {
  test('write classification + path validation', () => {
    expect(isGithubWrite('GET')).toBe(false)
    expect(isGithubWrite(undefined)).toBe(false)
    expect(isGithubWrite('POST')).toBe(true)
    expect(isGithubWrite('delete')).toBe(true)
    expect('error' in validateGithubPath('repos/x/y')).toBe(true)
    expect('error' in validateGithubPath('/repos/x/y/pulls?state=open')).toBe(false)
  })

  test('happy path GET with the brain token', async () => {
    process.env.GITHUB_TOKEN = 'gh_test'
    const r = await githubApiTool(fakeFetch([{ number: 7, title: 'fix exports' }])).run({ path: '/repos/o/r/pulls' })
    expect(r.success).toBe(true)
    expect(r.output).toContain('fix exports')
    delete process.env.GITHUB_TOKEN
  })
})

describe('notion_api', () => {
  test('search and database queries are POST-reads; page writes are writes', () => {
    expect(isNotionReadPath('POST', '/v1/search')).toBe(true)
    expect(isNotionReadPath('POST', '/v1/databases/abc/query')).toBe(true)
    expect(isNotionReadPath('GET', '/v1/pages/abc')).toBe(true)
    expect(isNotionReadPath('POST', '/v1/pages')).toBe(false)
    expect(isNotionReadPath('PATCH', '/v1/blocks/abc')).toBe(false)
    expect('error' in validateNotionPath('/search')).toBe(true)
    expect('error' in validateNotionPath('/v1/search')).toBe(false)
  })

  test('happy path search', async () => {
    process.env.NOTION_API_KEY = 'ntn_test'
    const r = await notionApiTool(fakeFetch({ results: [{ id: 'p1' }] })).run({ method: 'POST', path: '/v1/search', body: { query: 'roadmap' } })
    expect(r.success).toBe(true)
    expect(r.output).toContain('p1')
    delete process.env.NOTION_API_KEY
  })
})
