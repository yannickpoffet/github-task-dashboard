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
  updatedAgo = 24, base = 'main', repo = 'Auterion/example', size = null,
} = {}) {
  seq += 1;
  return {
    id: `PR_${seq}`, number: seq, title: `Test PR ${seq}`, url: `https://github.com/${repo}/pull/${seq}`,
    isDraft: draft, createdAt: ago(updatedAgo + 100), updatedAt: ago(updatedAgo),
    repository: { nameWithOwner: repo },
    author: { login: author || (mine ? 'me' : 'alice') },
    baseRefName: base, headRefName: `feature-${seq}`,
    mergeable, reviewDecision: decision,
    ...(size ? { additions: size[0], deletions: size[1] } : {}),
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

/**
 * Raw ref node as returned by BRANCH_QUERY. `ahead`/`behind` are from the branch's point
 * of view; the API reports them swapped (compare is taken with the branch as the base).
 * prs: [[state, number, hoursAgoMerged|hoursAgoClosed]]
 */
export function branch({ name, author = 'me', committedAgo = 100, ahead = 3, behind = 0, prs = [], noCompare = false } = {}) {
  return {
    name,
    target: { committedDate: ago(committedAgo), author: { user: author ? { login: author } : null } },
    associatedPullRequests: {
      nodes: prs.map(([state, number, h]) => ({
        number, state, baseRefName: 'main',
        mergedAt: state === 'MERGED' ? ago(h) : null,
        closedAt: state === 'CLOSED' || state === 'MERGED' ? ago(h) : null,
      })),
    },
    compare: noCompare ? null : { aheadBy: behind, behindBy: ahead },
  };
}

/** A scan as stored in the cache (what scanBranches() returns as `scan`). */
export function scanOf(nodes, { repo = 'Auterion/px4-firmware', base = 'main', defaultBranch = 'main' } = {}) {
  return { repo, base, defaultBranch, scannedAt: NOW - 60_000, truncated: false, totalSeen: nodes.length, nodes };
}
