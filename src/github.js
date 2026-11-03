// GraphQL client: one fetch, pagination, rate-limit info, readable errors.
// Works in the browser and Node 20+ (global fetch).

import { ALIASES, VIEWER_QUERY, buildQuery, buildSearchStrings } from './queries.js';
import { dedupeById } from './classify.js';

export const ENDPOINT = 'https://api.github.com/graphql';
const MAX_EXTRA_PAGES = 4; // beyond the first 100, per alias (search caps at 1000 anyway)

/** kind: 'no-token' | 'bad-token' | 'sso' | 'rate-limit' | 'network' | 'graphql' | 'http' */
export class GitHubError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/** Extract the SSO authorization URL from an X-GitHub-SSO header or an error message. */
function ssoUrl(header, errors) {
  const fromHeader = /url=(\S+)/.exec(header || '')?.[1];
  if (fromHeader) return fromHeader;
  return /https:\/\/github\.com\/orgs\/[^\s"]+\/sso\S*/.exec(JSON.stringify(errors || []))?.[0] || null;
}

/**
 * Send one GraphQL request. Resolves { data, raw, rateLimit, warnings }.
 * Partial results (data plus errors, e.g. one org needs SSO) are returned with warnings.
 */
export async function graphql(token, query, variables = {}, { signal, endpoint = ENDPOINT, fetchImpl = fetch } = {}) {
  if (!token) throw new GitHubError('no-token', 'No token set.');
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new GitHubError('network', `Could not reach GitHub: ${e.message}`);
  }
  const sso = res.headers.get('x-github-sso');
  if (res.status === 401) throw new GitHubError('bad-token', 'GitHub rejected the token (401). It may be wrong, expired or revoked.');
  if (res.status === 403 || res.status === 429) {
    const body = await res.text().catch(() => '');
    // The header is only readable cross-origin if GitHub exposes it, so also look in the body.
    if ((sso && /required/.test(sso)) || /SAML|\bSSO\b/.test(body)) {
      throw new GitHubError('sso', 'Token is not authorized for an organization (SSO).', { url: ssoUrl(sso, body) });
    }
    if (/rate limit/i.test(body) || res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 || null;
      throw new GitHubError('rate-limit', 'GitHub API rate limit exceeded.', { resetAt: reset });
    }
    throw new GitHubError('http', `GitHub returned ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.ok) throw new GitHubError('http', `GitHub returned ${res.status}.`);

  const raw = await res.json();
  const errors = raw.errors || [];
  const warnings = [];
  const ssoErr = errors.find((e) => /SAML|SSO/i.test(e.message || ''));
  if (ssoErr || (sso && /partial-results/.test(sso))) {
    warnings.push({ kind: 'sso', message: 'Some organizations are hidden: the token is not authorized for SSO.', url: ssoUrl(sso, errors) });
  }
  const rl = errors.find((e) => e.type === 'RATE_LIMITED');
  if (rl) throw new GitHubError('rate-limit', rl.message, { resetAt: null });
  const others = errors.filter((e) => e !== ssoErr);
  if (!raw.data) throw new GitHubError('graphql', errors.map((e) => e.message).join('; ') || 'Empty response.', { errors });
  if (others.length) warnings.push({ kind: 'graphql', message: others.map((e) => e.message).join('; ') });
  return { data: raw.data, raw, rateLimit: raw.data.rateLimit || null, warnings };
}

/**
 * Fetch everything the dashboard shows.
 * Request budget: 1 when login/teams are cached, 2 on first run, plus one per extra
 * page for any alias with more than 100 results. Never more than ~6 in practice.
 *
 * session = { login, teams } from a previous run (or null). Returns
 * { login, teams, prs, issues, rateLimit, warnings, repoCount, requestCount }.
 */
export async function fetchDashboard(token, config, session = null, opts = {}) {
  const searches = buildSearchStrings(config);
  let requestCount = 0;
  const warnings = [];
  let rateLimit = null;
  const track = (r) => { requestCount++; rateLimit = r.rateLimit || rateLimit; warnings.push(...r.warnings); return r; };

  let login = session?.login;
  if (!login) {
    login = track(await graphql(token, VIEWER_QUERY, {}, opts)).data.viewer.login;
  }
  const needTeams = !session?.teams;
  const first = track(await graphql(token, ...argsOf(buildQuery(searches, { withTeams: needTeams, login })), opts));

  let teams = session?.teams || [];
  if (needTeams) {
    teams = (first.data.viewer.organizations?.nodes || []).flatMap((o) =>
      (o.teams?.nodes || []).map((t) => `${o.login}/${t.slug}`));
  }

  const nodes = {};
  const pending = {};
  const counts = {}; // total matches GitHub reports per search, for diagnostics
  for (const alias of Object.keys(searches)) {
    const s = first.data[alias];
    nodes[alias] = [...(s?.nodes || [])];
    counts[alias] = s?.issueCount ?? 0;
    if (s?.pageInfo?.hasNextPage) pending[alias] = s.pageInfo.endCursor;
  }
  for (let page = 0; page < MAX_EXTRA_PAGES && Object.keys(pending).length; page++) {
    const sub = Object.fromEntries(Object.keys(pending).map((a) => [a, searches[a]]));
    const r = track(await graphql(token, ...argsOf(buildQuery(sub, { after: pending })), opts));
    for (const alias of Object.keys(pending)) {
      const s = r.data[alias];
      nodes[alias].push(...(s?.nodes || []));
      if (s?.pageInfo?.hasNextPage) pending[alias] = s.pageInfo.endCursor; else delete pending[alias];
    }
  }
  if (Object.keys(pending).length) {
    warnings.push({ kind: 'truncated', message: `Results truncated for: ${Object.keys(pending).join(', ')}.` });
  }

  const pick = (type) => dedupeById(
    Object.keys(nodes).filter((a) => ALIASES[a].type === type).flatMap((a) => nodes[a]));
  const prs = pick('PullRequest');
  const issues = pick('Issue');
  return {
    login, teams, prs, issues, counts, rateLimit, warnings, requestCount,
    repoCount: new Set([...prs, ...issues].map((n) => n.repository?.nameWithOwner)).size,
  };
}

const argsOf = ({ query, variables }) => [query, variables];
