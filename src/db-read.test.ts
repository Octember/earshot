import { expect, test } from 'bun:test'
import { validateReadQuery } from './db-read'

const q = (r: { query: string } | { error: string }): string => ('query' in r ? r.query : '')
const e = (r: { query: string } | { error: string }): string => ('error' in r ? r.error : '')

test('allows read verbs (SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES)', () => {
  expect(q(validateReadQuery('select 1'))).toBe('select 1')
  expect(q(validateReadQuery('  SELECT a FROM t WHERE x = 1'))).toContain('SELECT a FROM t')
  expect(q(validateReadQuery('with c as (select 1) select * from c'))).toContain('with c')
  expect(q(validateReadQuery('explain select 1'))).toContain('explain')
  expect(q(validateReadQuery('show statement_timeout'))).toContain('show')
  expect(q(validateReadQuery('select 1;'))).toBe('select 1') // a single trailing ; is stripped
})

test('strips leading comments before checking the verb', () => {
  expect(q(validateReadQuery('-- a comment\nselect 1'))).toBe('select 1')
  expect(q(validateReadQuery('/* block */ select 2'))).toBe('select 2')
})

test('refuses writes and DDL — the read verbs are an allowlist', () => {
  for (const bad of ['delete from t', 'update t set x = 1', 'insert into t values (1)', 'drop table t', 'alter role x', 'create table t (x int)', 'truncate t', 'grant select on t to y']) {
    expect(e(validateReadQuery(bad))).toContain('read')
  }
})

test('refuses stacked statements (no "; …" smuggling)', () => {
  expect(e(validateReadQuery('select 1; delete from t'))).toContain('single statement')
  expect(e(validateReadQuery('select 1; select 2'))).toContain('single statement')
})

test('refuses empty / comment-only input', () => {
  expect(e(validateReadQuery('   '))).toContain('empty')
  expect(e(validateReadQuery('-- only a comment\n'))).toContain('empty')
})
