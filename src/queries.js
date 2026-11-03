// Search strings + GraphQL fragments. Shared by the page and scripts/probe.mjs
// so both always send exactly the same query.

export const PR_FRAGMENT = /* GraphQL */ `
fragment PR on PullRequest {
  id number title url isDraft createdAt updatedAt
  repository { nameWithOwner }
  author { login }
  baseRefName headRefName
  mergeable reviewDecision
  reviewRequests(first: 10) {
    nodes { requestedReviewer { ... on User { login } ... on Team { slug combinedSlug } } }
  }
  latestReviews(first: 10) { nodes { author { login } state submittedAt } }
  comments(last: 5) { nodes { author { login } createdAt } }
  commits(last: 1) {
    nodes { commit { committedDate statusCheckRollup { state } } }
  }
}`;

export const ISSUE_FRAGMENT = /* GraphQL */ `
fragment Issue on Issue {
  id number title url createdAt updatedAt
  repository { nameWithOwner }
  author { login }
  assignees(first: 5) { nodes { login } }
}`;

const SEARCH_FIELDS = (fragmentName, type) => `
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on ${type} { ...${fragmentName} } }`;

/** Alias -> { type, fragment } for every search the dashboard can run. */
export const ALIASES = {
  involved: { type: 'PullRequest', fragment: 'PR' },
  requested: { type: 'PullRequest', fragment: 'PR' },
  extra: { type: 'PullRequest', fragment: 'PR' },
  issuesAssigned: { type: 'Issue', fragment: 'Issue' },
  issuesAuthored: { type: 'Issue', fragment: 'Issue' },
};

/** Search strings per alias, built from config. Aliases that would be empty are omitted. */
export function buildSearchStrings(config) {
  const orgs = (config.orgs || []).map((o) => `org:${o}`).join(' ');
  const repos = (config.extraRepos || []).map((r) => (r.includes('/') ? `repo:${r}` : `org:${r}`)).join(' ');
  const s = {
    requested: 'is:open is:pr review-requested:@me',
    issuesAssigned: 'is:open is:issue assignee:@me',
    issuesAuthored: 'is:open is:issue author:@me',
  };
  if (orgs) s.involved = `is:open is:pr involves:@me ${orgs}`;
  if (repos) s.extra = `is:open is:pr involves:@me ${repos}`;
  return s;
}

const TEAMS_FIELDS = `
  viewer {
    login
    organizations(first: 20) {
      nodes { login teams(first: 50, userLogins: [$login]) { nodes { slug } } }
    }
  }`;

/**
 * Build the single GraphQL document. All search strings travel as variables
 * ($involved, $requested, ...) so they never need escaping.
 * withTeams adds the viewer's team slugs (needs read:org); only requested when
 * the cache has none (then `login` is required). `after` maps alias -> cursor for follow-up pages.
 */
export function buildQuery(searchStrings, { withTeams = false, login = '', after = {} } = {}) {
  const aliases = Object.keys(searchStrings);
  const vars = aliases.map((a) => `$${a}: String!`);
  if (withTeams) vars.push('$login: String!');
  const blocks = aliases.map((a) => {
    const { type, fragment } = ALIASES[a];
    const cursor = after[a] ? `, after: ${JSON.stringify(after[a])}` : '';
    return `  ${a}: search(query: $${a}, type: ISSUE, first: 100${cursor}) {${SEARCH_FIELDS(fragment, type)}\n  }`;
  });
  const query = `query Dashboard(${vars.join(', ')}) {
  rateLimit { cost remaining limit resetAt }${withTeams ? TEAMS_FIELDS : '\n  viewer { login }'}
${blocks.join('\n')}
}
${PR_FRAGMENT}
${ISSUE_FRAGMENT}`;
  const variables = { ...searchStrings };
  if (withTeams) variables.login = login;
  return { query, variables };
}

/** Tiny query used to learn the viewer's login before the main request. */
export const VIEWER_QUERY = 'query { viewer { login } rateLimit { cost remaining limit resetAt } }';
