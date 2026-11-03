import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAll, classifyPR, normalizePR, dedupeById } from '../src/classify.js';
import { CTX, pr, issue } from './helpers.js';

const run = (node, ctx = CTX) => {
  const p = normalizePR(node);
  return classifyPR(p, ctx);
};
const bucket = (node, ctx) => run(node, ctx).bucket;

// ---- Waiting on you -------------------------------------------------------
test('waiting-on-you: I am in reviewRequests', () => {
  const r = run(pr({ reviewers: ['me'] }));
  assert.equal(r.bucket, 'waiting-on-you');
  assert.match(r.reason, /requested as a reviewer/);
});

test('waiting-on-you: one of my teams is requested on someone else\'s PR', () => {
  const r = run(pr({ reviewers: ['team:Auterion/orca'] }));
  assert.equal(r.bucket, 'waiting-on-you');
  assert.match(r.reason, /Auterion\/orca/);
});

test('team request for a team I am not in does not count', () => {
  assert.notEqual(bucket(pr({ reviewers: ['team:Auterion/other'] })), 'waiting-on-you');
});

test('team request on my own PR does not count (CODEOWNERS noise)', () => {
  assert.notEqual(bucket(pr({ mine: true, reviewers: ['team:Auterion/orca'] })), 'waiting-on-you');
});

test('waiting-on-you: author pushed after my latest review', () => {
  const r = run(pr({ reviews: [['me', 'CHANGES_REQUESTED', 30]], commitAgo: 5 }));
  assert.equal(r.bucket, 'waiting-on-you');
  assert.match(r.reason, /pushed .* after your review/);
});

test('someone else\'s PR, author has not pushed since my review: waiting on others', () => {
  const r = run(pr({ reviews: [['me', 'COMMENTED', 5]], commitAgo: 30 }));
  assert.equal(r.bucket, 'waiting-on-others');
});

test('waiting-on-you: my PR, comment from someone else newer than my last activity', () => {
  const r = run(pr({ mine: true, commitAgo: 50, comments: [['bob', 3]], reviewers: ['bob'] }));
  assert.equal(r.bucket, 'waiting-on-you');
  assert.match(r.reason, /bob commented/);
});

test('waiting-on-you: my PR, review from someone else newer than my last activity', () => {
  const r = run(pr({ mine: true, commitAgo: 50, reviews: [['bob', 'COMMENTED', 3]] }));
  assert.equal(r.bucket, 'waiting-on-you');
  assert.match(r.reason, /bob reviewed/);
});

test('my PR: comment older than my last push is not waiting-on-you', () => {
  const r = run(pr({ mine: true, commitAgo: 2, comments: [['bob', 3]], reviewers: ['bob'] }));
  assert.equal(r.bucket, 'waiting-on-others');
});

test('my PR: bot comments are ignored', () => {
  const r = run(pr({ mine: true, commitAgo: 50, comments: [['codecov[bot]', 1]], reviewers: ['bob'] }));
  assert.equal(r.bucket, 'waiting-on-others');
});

test('my PR: approval newer than my activity is not "waiting on you"', () => {
  const r = run(pr({ mine: true, commitAgo: 50, reviews: [['bob', 'APPROVED', 3]], decision: 'APPROVED' }));
  assert.equal(r.bucket, 'ready-to-merge');
});

test('waiting-on-you: changes requested, I pushed since, no re-request', () => {
  // my later comment makes rule 3 not fire, so this exercises the dedicated rule
  const r = run(pr({
    mine: true, decision: 'CHANGES_REQUESTED', reviews: [['bob', 'CHANGES_REQUESTED', 30]],
    commitAgo: 5, comments: [['me', 4]],
  }));
  assert.equal(r.bucket, 'waiting-on-you');
  assert.match(r.reason, /not re-requested|have not re-requested/);
});

test('changes requested, I pushed and re-requested review: waiting on others', () => {
  const r = run(pr({
    mine: true, decision: 'CHANGES_REQUESTED', reviews: [['bob', 'CHANGES_REQUESTED', 30]],
    commitAgo: 5, reviewers: ['bob'],
  }));
  assert.equal(r.bucket, 'waiting-on-others');
});

// ---- Ready to merge --------------------------------------------------------
test('ready-to-merge: approved, CI green, mergeable', () => {
  assert.equal(bucket(pr({ mine: true, decision: 'APPROVED' })), 'ready-to-merge');
});

test('ready-to-merge: repo without CI counts as green', () => {
  assert.equal(bucket(pr({ mine: true, decision: 'APPROVED', ci: null })), 'ready-to-merge');
});

test('approved but CI pending: waiting on others, not ready', () => {
  const r = run(pr({ mine: true, decision: 'APPROVED', ci: 'PENDING' }));
  assert.equal(r.bucket, 'waiting-on-others');
  assert.match(r.reason, /CI still running/);
});

test('approved but mergeable UNKNOWN: shown as checking, not misclassified', () => {
  const r = run(pr({ mine: true, decision: 'APPROVED', mergeable: 'UNKNOWN' }));
  assert.equal(r.bucket, 'waiting-on-others');
  assert.match(r.reason, /merge status/);
});

// ---- Needs finishing -------------------------------------------------------
test('needs-finishing: CI failing', () => {
  const r = run(pr({ mine: true, ci: 'FAILURE', reviewers: ['bob'] }));
  assert.equal(r.bucket, 'needs-finishing');
  assert.match(r.reason, /CI failing/);
});

test('needs-finishing: approved but CI failing', () => {
  assert.equal(bucket(pr({ mine: true, decision: 'APPROVED', ci: 'FAILURE' })), 'needs-finishing');
});

test('needs-finishing: merge conflicts', () => {
  const r = run(pr({ mine: true, mergeable: 'CONFLICTING', reviewers: ['bob'] }));
  assert.equal(r.bucket, 'needs-finishing');
  assert.match(r.reason, /merge conflicts/i);
});

test('needs-finishing: draft', () => {
  const r = run(pr({ mine: true, draft: true, reviewers: ['bob'] }));
  assert.equal(r.bucket, 'needs-finishing');
  assert.match(r.reason, /Draft/);
});

test('needs-finishing: no reviewer requested', () => {
  const r = run(pr({ mine: true }));
  assert.equal(r.bucket, 'needs-finishing');
  assert.match(r.reason, /no reviewer requested/i);
});

test('needs-finishing: reasons are combined', () => {
  const r = run(pr({ mine: true, draft: true, ci: 'FAILURE' }));
  assert.match(r.reason, /Draft, CI failing, no reviewer requested/);
});

// ---- Waiting on others / Stale --------------------------------------------
test('waiting-on-others: review requested and nothing new', () => {
  const r = run(pr({ mine: true, reviewers: ['bob'] }));
  assert.equal(r.bucket, 'waiting-on-others');
  assert.match(r.reason, /bob/);
});

test('stale: my PR untouched for more than staleDays', () => {
  const r = run(pr({ mine: true, reviewers: ['bob'], updatedAgo: 24 * 40 }));
  assert.equal(r.bucket, 'stale');
  assert.match(r.reason, /40 days/);
});

test('stale threshold is configurable', () => {
  const node = pr({ mine: true, reviewers: ['bob'], updatedAgo: 24 * 10 });
  assert.equal(bucket(node), 'waiting-on-others');
  assert.equal(bucket(node, { ...CTX, staleDays: 7 }), 'stale');
});

test('stale does not hide a PR that needs finishing', () => {
  assert.equal(bucket(pr({ mine: true, ci: 'FAILURE', updatedAgo: 24 * 90 })), 'needs-finishing');
});

// ---- Others' PRs, watching, first match wins -------------------------------
test('watching: someone else\'s PR where I am only mentioned', () => {
  assert.equal(bucket(pr({ comments: [['me', 20]] })), 'watching');
});

test('first match wins: review request beats everything else', () => {
  assert.equal(bucket(pr({ reviewers: ['me'], ci: 'FAILURE', draft: true })), 'waiting-on-you');
});

test('logins compare case-insensitively', () => {
  assert.equal(bucket(pr({ reviewers: ['ME'] })), 'waiting-on-you');
  assert.equal(bucket(pr({ author: 'Me', decision: 'APPROVED' })), 'ready-to-merge');
});

test('missing author (deleted user) and null commit data do not throw', () => {
  const node = pr({ reviewers: ['bob'] });
  node.author = null;
  node.commits.nodes = [];
  node.latestReviews = null;
  assert.doesNotThrow(() => run(node));
});

// ---- Issues, dedupe, rows --------------------------------------------------
test('issues: assigned, authored, or both', () => {
  const rows = classifyAll({ issues: [
    issue({ author: 'alice', assignees: ['me'] }),
    issue({ author: 'me', assignees: [] }),
    issue({ author: 'me', assignees: ['me'] }),
  ] }, CTX);
  assert.deepEqual(rows.map((r) => r.bucket), ['issues', 'issues', 'issues']);
  assert.deepEqual(rows.map((r) => r.reason), ['Assigned to you', 'Opened by you', 'Assigned to you, and you opened it']);
});

test('dedupe by id across searches, ignoring empty search nodes', () => {
  const a = pr({ mine: true });
  assert.equal(dedupeById([a, { ...a }, {}, null]).length, 1);
  assert.equal(classifyAll({ prs: [a, a] }, CTX).length, 1);
});

test('rows carry the fields the table shows', () => {
  const [row] = classifyAll({ prs: [pr({ mine: true, base: 'release/3.5-marine', reviewers: ['bob'], repo: 'Auterion/px4' })] }, CTX);
  for (const k of ['repo', 'number', 'title', 'url', 'author', 'base', 'ci', 'reviewDecision', 'updatedAt', 'bucket', 'reason']) {
    assert.ok(k in row, `missing ${k}`);
  }
  assert.equal(row.base, 'release/3.5-marine');
  assert.equal(row.ci, 'SUCCESS');
});
