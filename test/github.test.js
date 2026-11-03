import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GitHubError, fetchDashboard, graphql, scanBranches } from '../src/github.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { buildQuery, buildSearchStrings } from '../src/queries.js';
import { classifyAll } from '../src/classify.js';
import { NOW, pr } from './helpers.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/synthetic-response.json', import.meta.url)));

/** Fake fetch: replies with each handler's result in turn. */
function fakeFetch(...replies) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const r = replies[Math.min(calls.length, replies.length) - 1];
    const res = typeof r === 'function' ? r(calls[calls.length - 1]) : r;
    return {
      status: res.status ?? 200, ok: (res.status ?? 200) < 400,
      headers: { get: (h) => res.headers?.[h.toLowerCase()] ?? null },
      json: async () => res.body, text: async () => JSON.stringify(res.body ?? ''),
    };
  };
  return { impl, calls };
}

test('buildSearchStrings: org and extra repo clauses, omitted when empty', () => {
  const s = buildSearchStrings(DEFAULT_CONFIG);
  assert.equal(s.involved, 'is:open is:pr involves:@me org:Auterion');
  assert.equal(s.extra, 'is:open is:pr involves:@me repo:PX4/PX4-Autopilot');
  assert.equal(s.requested, 'is:open is:pr review-requested:@me');
  const none = buildSearchStrings({ orgs: [], extraRepos: [] });
  assert.ok(!('involved' in none) && !('extra' in none));
});

test('buildQuery: search strings are variables, never interpolated', () => {
  const { query, variables } = buildQuery(buildSearchStrings(DEFAULT_CONFIG), { withTeams: true, login: 'me' });
  assert.ok(!query.includes('PX4/PX4-Autopilot'));
  assert.equal(variables.login, 'me');
  assert.match(query, /\$involved: String!/);
});

test('normalizeConfig rejects junk and clamps numbers', () => {
  const c = normalizeConfig({ orgs: ['ok', 'bad name', 'x y/z'], extraRepos: ['a/b', '"; drop'], staleDays: 99999, refreshMinutes: 'x' });
  assert.deepEqual(c.orgs, ['ok']);
  assert.deepEqual(c.extraRepos, ['a/b']);
  assert.equal(c.staleDays, 365);
  assert.equal(c.refreshMinutes, DEFAULT_CONFIG.refreshMinutes);
});

test('fetchDashboard: first run = 2 requests, cached session = 1, results merged and de-duplicated', async () => {
  const f = fakeFetch(
    { body: { data: { viewer: { login: 'me' }, rateLimit: { remaining: 1 } } } },
    { body: fixture },
  );
  const r = await fetchDashboard('tok', DEFAULT_CONFIG, null, { fetchImpl: f.impl });
  assert.equal(r.requestCount, 2);
  assert.equal(r.counts.involved, 8);
  assert.deepEqual(r.teams, ['Auterion/orca']);
  assert.equal(r.prs.length, 11);
  assert.equal(r.issues.length, 2);
  assert.ok(f.calls[1].query.includes('organizations'));

  const g = fakeFetch({ body: fixture });
  const r2 = await fetchDashboard('tok', DEFAULT_CONFIG, { login: 'me', teams: r.teams }, { fetchImpl: g.impl });
  assert.equal(r2.requestCount, 1);
  assert.ok(!g.calls[0].query.includes('organizations'));
});

test('fixture classifies into every bucket', () => {
  const rows = classifyAll({
    prs: ['involved', 'requested', 'extra'].flatMap((a) => fixture.data[a].nodes),
    issues: ['issuesAssigned', 'issuesAuthored'].flatMap((a) => fixture.data[a].nodes),
  }, { me: 'me', teams: ['Auterion/orca'], staleDays: 30, now: NOW });
  const buckets = new Set(rows.map((r) => r.bucket));
  for (const b of ['waiting-on-you', 'ready-to-merge', 'needs-finishing', 'stale', 'waiting-on-others', 'issues', 'watching']) {
    assert.ok(buckets.has(b), `no row in ${b}`);
  }
});

test('fetchDashboard: paginates an alias with more than 100 results', async () => {
  const page = (ids, next) => ({
    issueCount: 150, pageInfo: { hasNextPage: !!next, endCursor: next },
    nodes: ids.map((n) => pr({ mine: true, reviewers: ['bob'], repo: `o/r${n}` })),
  });
  const empty = { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  const base = { rateLimit: {}, viewer: { login: 'me' }, requested: empty, issuesAssigned: empty, issuesAuthored: empty, extra: empty };
  const f = fakeFetch(
    { body: { data: { ...base, involved: page([1, 2], 'CUR1') } } },
    (call) => {
      assert.match(call.query, /after: "CUR1"/);
      assert.deepEqual(Object.keys(call.variables), ['involved']);
      return { body: { data: { rateLimit: {}, involved: page([3], null) } } };
    },
  );
  const r = await fetchDashboard('tok', DEFAULT_CONFIG, { login: 'me', teams: [] }, { fetchImpl: f.impl });
  assert.equal(r.prs.length, 3);
  assert.equal(r.requestCount, 2);
});

test('errors: 401 is bad-token', async () => {
  const f = fakeFetch({ status: 401, body: {} });
  await assert.rejects(graphql('t', 'q', {}, { fetchImpl: f.impl }), (e) => e instanceof GitHubError && e.kind === 'bad-token');
});

test('errors: no token', async () => {
  await assert.rejects(graphql('', 'q'), (e) => e.kind === 'no-token');
});

test('errors: 403 with SSO header is sso and carries the authorize URL', async () => {
  const f = fakeFetch({ status: 403, headers: { 'x-github-sso': 'required; url=https://github.com/orgs/Auterion/sso?authorization_request=abc' }, body: {} });
  await assert.rejects(graphql('t', 'q', {}, { fetchImpl: f.impl }),
    (e) => e.kind === 'sso' && e.url.startsWith('https://github.com/orgs/Auterion/sso'));
});

test('errors: 403 SAML message in the body (header not exposed) is sso', async () => {
  const f = fakeFetch({ status: 403, body: { message: 'Resource protected by organization SAML enforcement. Authorize at https://github.com/orgs/Auterion/sso?authorization_request=z' } });
  await assert.rejects(graphql('t', 'q', {}, { fetchImpl: f.impl }), (e) => e.kind === 'sso' && /orgs\/Auterion\/sso/.test(e.url));
});

test('errors: partial SSO results become a warning, data is kept', async () => {
  const f = fakeFetch({
    headers: { 'x-github-sso': 'partial-results; organizations=123' },
    body: { data: { rateLimit: {} }, errors: [{ message: 'Resource protected by organization SAML enforcement.' }] },
  });
  const r = await graphql('t', 'q', {}, { fetchImpl: f.impl });
  assert.equal(r.warnings[0].kind, 'sso');
});

test('errors: rate limit', async () => {
  const f = fakeFetch({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }, body: { message: 'API rate limit exceeded' } });
  await assert.rejects(graphql('t', 'q', {}, { fetchImpl: f.impl }), (e) => e.kind === 'rate-limit' && e.resetAt === 1800000000000);
});

test('errors: network failure', async () => {
  const impl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(graphql('t', 'q', {}, { fetchImpl: impl }), (e) => e.kind === 'network');
});

test('scanBranches: resolves the default branch first when base is empty, then pages branches', async () => {
  const node = (n) => ({ name: n, target: null, associatedPullRequests: { nodes: [] }, compare: { aheadBy: 0, behindBy: 1 } });
  const f = fakeFetch(
    { body: { data: { rateLimit: {}, repository: { nameWithOwner: 'O/r', defaultBranchRef: { name: 'dev' } } } } },
    (call) => {
      assert.deepEqual([call.variables.base, call.variables.after], ['dev', null]);
      return { body: { data: { rateLimit: {}, repository: { nameWithOwner: 'O/r', defaultBranchRef: { name: 'dev' },
        refs: { pageInfo: { hasNextPage: true, endCursor: 'C1' }, nodes: [node('a')] } } } } };
    },
    (call) => {
      assert.equal(call.variables.after, 'C1');
      return { body: { data: { rateLimit: {}, repository: { nameWithOwner: 'O/r', defaultBranchRef: { name: 'dev' },
        refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node('b')] } } } } };
    },
  );
  const r = await scanBranches('tok', 'o/r', '', { fetchImpl: f.impl });
  assert.equal(r.requestCount, 3);
  assert.equal(r.scan.repo, 'O/r');
  assert.equal(r.scan.base, 'dev');
  assert.equal(r.scan.totalSeen, 2);
  assert.equal(r.scan.truncated, false);
});

test('scanBranches: uses the given base, caps at 3 pages and reports truncation', async () => {
  const page = () => ({ body: { data: { rateLimit: {}, repository: { nameWithOwner: 'O/r', defaultBranchRef: { name: 'main' },
    refs: { pageInfo: { hasNextPage: true, endCursor: 'C' }, nodes: [{ name: 'x', target: null, associatedPullRequests: { nodes: [] }, compare: { aheadBy: 0, behindBy: 1 } }] } } } } });
  const f = fakeFetch(page());
  const r = await scanBranches('tok', 'O/r', 'release/3.5-marine', { fetchImpl: f.impl });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].variables.base, 'release/3.5-marine');
  assert.equal(r.scan.truncated, true);
});

test('scanBranches: unknown base branch yields a warning, unreadable repo an error, bad name is rejected', async () => {
  const f = fakeFetch({ body: { data: { rateLimit: {}, repository: { nameWithOwner: 'O/r', defaultBranchRef: { name: 'main' },
    refs: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'x', target: null, associatedPullRequests: { nodes: [] }, compare: null }] } } } } });
  const r = await scanBranches('t', 'O/r', 'nope', { fetchImpl: f.impl });
  assert.match(r.warnings[0].message, /Base branch "nope" was not found/);
  const g = fakeFetch({ body: { data: { rateLimit: {}, repository: null } } });
  await assert.rejects(scanBranches('t', 'O/r', 'main', { fetchImpl: g.impl }), /not found or this token cannot read it/);
  await assert.rejects(scanBranches('t', 'no-slash', 'main'), /not an owner\/repo name/);
});
