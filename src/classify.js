// Pure classification: raw GraphQL nodes -> rows with { bucket, reason }.
// No DOM, no network, no clock (callers pass ctx.now), so it is unit-testable.
//
// ctx = { me: 'login', teams: ['auterion/orca', ...], staleDays: 30, now: Date.now() }

export const BUCKETS = [
  { id: 'waiting-on-you', label: 'Waiting on you' },
  { id: 'ready-to-merge', label: 'Ready to merge' },
  { id: 'needs-finishing', label: 'Needs finishing' },
  { id: 'stale', label: 'Stale' },
  { id: 'waiting-on-others', label: 'Waiting on others' },
  { id: 'issues', label: 'Issues' },
  { id: 'dead-branches', label: 'Dead branches' },
  { id: 'unmerged-branches', label: 'Unmerged work, no PR' },
  { id: 'watching', label: 'Watching (no action)' },
];

const DAY = 86_400_000;
const lc = (s) => (s ? String(s).toLowerCase() : '');
const ts = (s) => (s ? Date.parse(s) || 0 : 0);
const isBot = (login) => /\[bot\]$/i.test(login || '');

export function dedupeById(nodes) {
  const seen = new Map();
  for (const n of nodes || []) if (n && n.id && !seen.has(n.id)) seen.set(n.id, n);
  return [...seen.values()];
}

export function timeAgo(then, now) {
  const m = Math.max(0, Math.round((now - then) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * GitHub leaves reviewDecision empty when the repo does not require reviews, even if someone
 * approved or asked for changes. Derive it from each reviewer's latest review in that case.
 */
function decisionFromReviews(reviews) {
  const states = reviews.map((r) => r.state);
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (states.includes('APPROVED')) return 'APPROVED';
  return null;
}

/** Flatten a raw PullRequest node into the fields the rules need. */
export function normalizePR(n) {
  const commit = n.commits?.nodes?.[0]?.commit;
  const reviewers = (n.reviewRequests?.nodes || []).map((r) => r?.requestedReviewer).filter(Boolean);
  return {
    kind: 'pr',
    id: n.id,
    repo: n.repository?.nameWithOwner || '?',
    number: n.number,
    title: n.title || '',
    url: n.url || '',
    author: n.author?.login || 'ghost',
    base: n.baseRefName || '',
    head: n.headRefName || '',
    isDraft: !!n.isDraft,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    additions: n.additions ?? null,
    deletions: n.deletions ?? null,
    mergeable: n.mergeable || 'UNKNOWN',
    reviewDecision: n.reviewDecision || decisionFromReviews(n.latestReviews?.nodes || []),
    ci: commit?.statusCheckRollup?.state || 'NONE',
    lastCommitAt: ts(commit?.committedDate),
    requestedUsers: reviewers.filter((r) => r.login).map((r) => r.login),
    requestedTeams: reviewers.filter((r) => r.slug).map((r) => r.combinedSlug || r.slug),
    reviews: (n.latestReviews?.nodes || []).map((r) => ({
      author: r.author?.login || 'ghost', state: r.state, at: ts(r.submittedAt),
    })),
    // Top-level comments plus the latest comment of each unresolved inline review thread, so a
    // reply on a code line counts as activity (by me or by someone else).
    comments: [
      ...(n.comments?.nodes || []),
      ...(n.reviewThreads?.nodes || []).filter((t) => !t.isResolved).flatMap((t) => t.comments?.nodes || []),
    ].map((c) => ({ author: c.author?.login || 'ghost', at: ts(c.createdAt) })),
  };
}

export function normalizeIssue(n) {
  return {
    kind: 'issue',
    id: n.id,
    repo: n.repository?.nameWithOwner || '?',
    number: n.number,
    title: n.title || '',
    url: n.url || '',
    author: n.author?.login || 'ghost',
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    assignees: (n.assignees?.nodes || []).map((a) => a.login),
  };
}

/** Returns { bucket, reason } for a normalized PR. Rules are checked top to bottom. */
export function classifyPR(pr, ctx) {
  const me = lc(ctx.me);
  const teams = new Set((ctx.teams || []).map(lc));
  const now = ctx.now;
  const ago = (t) => timeAgo(t, now);
  const isMine = lc(pr.author) === me;
  const myReview = pr.reviews.find((r) => lc(r.author) === me && r.state !== 'PENDING');
  const requested = [...pr.requestedUsers, ...pr.requestedTeams];
  const hit = (bucket, reason, extra = {}) => ({ bucket, reason, ...extra });

  // --- Waiting on you -------------------------------------------------------
  if (pr.requestedUsers.some((u) => lc(u) === me)) {
    return hit('waiting-on-you', 'You are requested as a reviewer');
  }
  if (!isMine) {
    // Team requests on my own PRs are usually CODEOWNERS noise, so only count others' PRs.
    const team = pr.requestedTeams.find((t) => teams.has(lc(t)));
    if (team) return hit('waiting-on-you', `Your team ${team} is requested as a reviewer`);
    if (myReview && pr.lastCommitAt > myReview.at) {
      return hit('waiting-on-you', `Author pushed ${ago(pr.lastCommitAt)}, after your review (${myReview.state.toLowerCase().replace('_', ' ')})`, { eventAt: pr.lastCommitAt });
    }
  } else {
    const mine = Math.max(
      pr.lastCommitAt,
      ...pr.comments.filter((c) => lc(c.author) === me).map((c) => c.at),
      ...pr.reviews.filter((r) => lc(r.author) === me).map((r) => r.at),
    );
    // Approvals are not a request for action: they feed "Ready to merge" instead.
    const others = [
      ...pr.comments.filter((c) => lc(c.author) !== me && !isBot(c.author)).map((c) => ({ ...c, what: 'commented' })),
      ...pr.reviews
        // A reviewer who is requested again has the ball: submitting a review clears the request,
        // so a pending request next to a review means I re-requested after it.
        .filter((r) => lc(r.author) !== me && !isBot(r.author) && !['APPROVED', 'PENDING', 'DISMISSED'].includes(r.state)
          && !pr.requestedUsers.some((u) => lc(u) === lc(r.author)))
        .map((r) => ({ author: r.author, at: r.at, what: r.state === 'CHANGES_REQUESTED' ? 'requested changes' : 'reviewed' })),
    ].sort((a, b) => b.at - a.at);
    if (others.length && others[0].at > mine) {
      return hit('waiting-on-you', `${others[0].author} ${others[0].what} ${ago(others[0].at)}, after your last activity`, { unanswered: true, eventAt: others[0].at });
    }
    const cr = pr.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').sort((a, b) => b.at - a.at)[0];
    if (pr.reviewDecision === 'CHANGES_REQUESTED' && cr && pr.lastCommitAt > cr.at && requested.length === 0) {
      return hit('waiting-on-you', 'Changes were requested and you pushed since, but have not re-requested review');
    }
  }

  // --- Others' PRs with nothing left for me --------------------------------
  if (!isMine) {
    return myReview
      ? hit('waiting-on-others', `You reviewed (${myReview.state.toLowerCase().replace('_', ' ')}); waiting for the author`)
      : hit('watching', 'Mentioned or commented; no action detected');
  }

  // --- My PRs ---------------------------------------------------------------
  const approved = pr.reviewDecision === 'APPROVED';
  const ciGreen = pr.ci === 'SUCCESS' || pr.ci === 'NONE';
  if (!pr.isDraft && approved && ciGreen && pr.mergeable === 'MERGEABLE') {
    return hit('ready-to-merge', 'Approved, CI green, no conflicts');
  }

  const problems = [];
  if (pr.isDraft) problems.push('draft');
  if (pr.ci === 'FAILURE' || pr.ci === 'ERROR') problems.push('CI failing');
  if (pr.mergeable === 'CONFLICTING') problems.push('merge conflicts');
  if (requested.length === 0 && !approved) problems.push('no reviewer requested');
  if (problems.length) return hit('needs-finishing', problems.join(', ').replace(/^./, (c) => c.toUpperCase()));

  const idleDays = (now - ts(pr.updatedAt)) / DAY;
  if (idleDays > ctx.staleDays) return hit('stale', `No activity for ${Math.floor(idleDays)} days`);

  if (approved) {
    const why = pr.mergeable === 'UNKNOWN' ? 'merge status still being computed' : 'CI still running';
    return hit('waiting-on-others', `Approved; ${why}`);
  }
  if (requested.length) return hit('waiting-on-others', `Review requested from ${requested.join(', ')}; nothing new since`);
  return hit('waiting-on-others', 'No pending action detected');
}

export function classifyIssue(issue, ctx) {
  const me = lc(ctx.me);
  const assigned = issue.assignees.some((a) => lc(a) === me);
  const authored = lc(issue.author) === me;
  const reason = assigned && authored ? 'Assigned to you, and you opened it'
    : assigned ? 'Assigned to you' : 'Opened by you';
  return { bucket: 'issues', reason };
}

/** Flatten one branch node of a scan (see BRANCH_QUERY) into display fields. */
export function normalizeBranch(n, scan) {
  const t = n.target || {};
  const cmp = n.compare;
  const path = String(n.name).split('/').map(encodeURIComponent).join('/');
  const login = t.author?.user?.login || null;
  return {
    kind: 'branch',
    id: `${scan.repo}:${n.name}`,
    repo: scan.repo,
    name: n.name,
    title: n.name,
    number: null,
    url: `https://github.com/${scan.repo}/tree/${path}`,
    base: scan.base,
    defaultBranch: scan.defaultBranch,
    protected: !!n.branchProtectionRule,
    authorLogin: login,
    author: login || t.author?.name || 'unknown',
    committedAt: ts(t.committedDate),
    createdAt: t.committedDate,
    updatedAt: t.committedDate,
    // compare() is taken from the branch's point of view, see BRANCH_QUERY.
    ahead: cmp ? cmp.behindBy : null,
    behind: cmp ? cmp.aheadBy : null,
    prs: (n.associatedPullRequests?.nodes || []).map((p) => ({
      number: p.number, state: p.state, mergedAt: ts(p.mergedAt), closedAt: ts(p.closedAt),
    })),
  };
}

// Long-lived branches are never offered for deletion, whatever their age.
const LONG_LIVED = /^(main|master|develop|dev|stable|trunk|release([/-].*)?|hotfix\/.*)$/i;

/**
 * Branch rules. ctx.branchWho: 'mine' (tip commit authored by me) or 'anyone';
 * ctx.deadBranchDays: unmerged branches idle for longer are dead (0 = off).
 * Branches with an open PR are skipped (they already show up as PRs). Returns null to skip.
 */
export function classifyBranch(b, ctx) {
  const isMine = !!b.authorLogin && lc(b.authorLogin) === lc(ctx.me);
  if ((ctx.branchWho || 'mine') === 'mine' && !isMine) return null;
  if (b.name === b.defaultBranch || b.name === b.base || b.protected || LONG_LIVED.test(b.name)) return null;
  if (b.prs.some((p) => p.state === 'OPEN')) return null;
  const now = ctx.now;
  const merged = b.prs.filter((p) => p.state === 'MERGED').sort((x, y) => y.mergedAt - x.mergedAt)[0];
  if (merged) {
    // Squash merges leave the branch "ahead" forever, so judge by the tip date instead.
    return b.committedAt <= merged.mergedAt + 60_000
      ? { bucket: 'dead-branches', reason: `PR #${merged.number} was merged ${timeAgo(merged.mergedAt, now)}; the branch can be deleted` }
      : { bucket: 'unmerged-branches', reason: `Has commits newer than its merged PR #${merged.number} (${timeAgo(b.committedAt, now)})` };
  }
  if (b.ahead === 0) {
    return { bucket: 'dead-branches', reason: `No commits ahead of ${b.base}; already merged or empty` };
  }
  const closed = b.prs.filter((p) => p.state === 'CLOSED').sort((x, y) => y.closedAt - x.closedAt)[0];
  const ahead = b.ahead == null ? 'Unknown distance from' : `${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead of`;
  const prNote = closed ? `PR #${closed.number} was closed without merging` : 'no PR';
  const idleDays = (now - b.committedAt) / DAY;
  if (ctx.deadBranchDays > 0 && idleDays > ctx.deadBranchDays) {
    return { bucket: 'dead-branches', reason: `No commits for ${Math.floor(idleDays)} days; ${ahead} ${b.base}; ${prNote}` };
  }
  return {
    bucket: 'unmerged-branches',
    reason: closed ? `${ahead} ${b.base}; ${prNote}` : `${ahead} ${b.base}, last commit ${timeAgo(b.committedAt, now)}; ${prNote}`,
  };
}

/**
 * Raw nodes -> flat list of display rows, one per unique PR/issue/branch.
 * branchScans = { 'owner/repo': { repo, base, defaultBranch, nodes } } from on-demand scans;
 * ctx.branchRepo (lowercase owner/repo, '' = none) selects which scan's branches are listed.
 */
export function classifyAll({ prs = [], issues = [], branchScans = {} }, ctx) {
  const me = lc(ctx.me);
  const rows = [];
  for (const n of dedupeById(prs)) {
    const pr = normalizePR(n);
    const mine = lc(pr.author) === me;
    const res = classifyPR(pr, ctx);
    const noReviewer = mine && !pr.isDraft && pr.reviewDecision !== 'APPROVED'
      && pr.requestedUsers.length + pr.requestedTeams.length === 0;
    rows.push({ ...pr, ...res, mine, noReviewer, unanswered: !!res.unanswered });
  }
  for (const n of dedupeById(issues)) {
    const issue = normalizeIssue(n);
    rows.push({ ...issue, ...classifyIssue(issue, ctx), mine: true }); // issues are mine by construction
  }
  const seen = new Set();
  for (const scan of Object.values(branchScans || {})) {
    // ctx.branchRepo (when given) limits the list to the repo currently chosen in the scan picker.
    if (ctx.branchRepo !== undefined && scan.repo.toLowerCase() !== ctx.branchRepo) continue;
    for (const n of scan.nodes || []) {
      const b = normalizeBranch(n, scan);
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const res = classifyBranch(b, ctx);
      if (res) rows.push({ ...b, ...res, mine: !!b.authorLogin && lc(b.authorLogin) === me });
    }
  }
  return rows;
}
