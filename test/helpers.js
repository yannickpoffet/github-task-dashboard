// Builders for raw GraphQL PullRequest/Issue nodes, shaped like the real API response.

export const NOW = Date.parse('2026-11-02T12:00:00Z');
export const CTX = { me: 'me', teams: ['auterion/orca'], staleDays: 30, now: NOW };

/** ISO timestamp `h` hours before NOW. */
export const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();

let seq = 0;

/**
 * Raw PR node. Defaults: someone else's PR, CI green, mergeable, no reviews.
 * Pass `mine: true` to make me the author.
 * reviewers: ['login', 'team:org/slug'], reviews: [[login, state, hoursAgo]],
 * comments: [[login, hoursAgo]], commitAgo: hours since last commit, ci: rollup state or null.
 */
export function pr({
  mine = false, author, reviewers = [], reviews = [], comments = [], commitAgo = 48,
  ci = 'SUCCESS', mergeable = 'MERGEABLE', decision = null, draft = false,
  updatedAgo = 24, base = 'main', repo = 'Auterion/example',
} = {}) {
  seq += 1;
  return {
    id: `PR_${seq}`, number: seq, title: `Test PR ${seq}`, url: `https://github.com/${repo}/pull/${seq}`,
    isDraft: draft, createdAt: ago(updatedAgo + 100), updatedAt: ago(updatedAgo),
    repository: { nameWithOwner: repo },
    author: { login: author || (mine ? 'me' : 'alice') },
    baseRefName: base, headRefName: `feature-${seq}`,
    mergeable, reviewDecision: decision,
    reviewRequests: {
      nodes: reviewers.map((r) => ({
        requestedReviewer: r.startsWith('team:')
          ? { slug: r.split('/')[1], combinedSlug: r.slice(5) }
          : { login: r },
      })),
    },
    latestReviews: { nodes: reviews.map(([login, state, h]) => ({ author: { login }, state, submittedAt: ago(h) })) },
    comments: { nodes: comments.map(([login, h]) => ({ author: { login }, createdAt: ago(h) })) },
    commits: {
      nodes: [{ commit: { committedDate: ago(commitAgo), statusCheckRollup: ci ? { state: ci } : null } }],
    },
  };
}

export function issue({ author = 'me', assignees = ['me'], repo = 'Auterion/example' } = {}) {
  seq += 1;
  return {
    id: `I_${seq}`, number: seq, title: `Test issue ${seq}`, url: `https://github.com/${repo}/issues/${seq}`,
    createdAt: ago(500), updatedAt: ago(10), repository: { nameWithOwner: repo },
    author: { login: author }, assignees: { nodes: assignees.map((login) => ({ login })) },
  };
}
