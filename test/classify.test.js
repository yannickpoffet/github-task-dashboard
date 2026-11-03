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

// ---- Branches ---------------------------------------------------------------
import { classifyBranch, normalizeBranch } from '../src/classify.js';
import { branch, scanOf } from './helpers.js';

const cb = (opts, scanOpts, ctx = {}) => {
  const scan = scanOf([], scanOpts);
  return classifyBranch(normalizeBranch(branch(opts), scan), { ...CTX, ...ctx });
};

test('branch: ahead/behind are mapped from the swapped compare() fields', () => {
  const b = normalizeBranch(branch({ name: 'x', ahead: 5276, behind: 2 }), scanOf([]));
  assert.equal(b.ahead, 5276);
  assert.equal(b.behind, 2);
});

test('branch dead: PR merged and the tip is not newer than the merge (squash-safe)', () => {
  const r = cb({ name: 'f', ahead: 12, committedAgo: 24 * 40, prs: [['MERGED', 801, 24 * 38]] });
  assert.equal(r.bucket, 'dead-branches');
  assert.match(r.reason, /PR #801 was merged .* can be deleted/);
});

test('branch unmerged: commits pushed after its PR was merged', () => {
  const r = cb({ name: 'f', ahead: 3, committedAgo: 24, prs: [['MERGED', 801, 24 * 38]] });
  assert.equal(r.bucket, 'unmerged-branches');
  assert.match(r.reason, /newer than its merged PR #801/);
});

test('branch dead: no commits ahead of base', () => {
  const r = cb({ name: 'f', ahead: 0, behind: 50 });
  assert.equal(r.bucket, 'dead-branches');
  assert.match(r.reason, /No commits ahead of main/);
});

test('branch unmerged: ahead of base with no PR', () => {
  const r = cb({ name: 'f', ahead: 4, committedAgo: 24 * 9 });
  assert.equal(r.bucket, 'unmerged-branches');
  assert.match(r.reason, /4 commits ahead of main, last commit 9d ago; no PR/);
});

test('branch unmerged: PR closed without merging is called out', () => {
  const r = cb({ name: 'f', ahead: 1, prs: [['CLOSED', 790, 100]] });
  assert.equal(r.bucket, 'unmerged-branches');
  assert.match(r.reason, /1 commit ahead of main; PR #790 was closed without merging/);
});

test('branch skipped: open PR, other author, unknown author, default branch, the base itself', () => {
  assert.equal(cb({ name: 'f', prs: [['OPEN', 5, 0]] }), null);
  assert.equal(cb({ name: 'f', author: 'alice' }), null);
  assert.equal(cb({ name: 'f', author: null }), null);
  assert.equal(cb({ name: 'main', ahead: 0 }), null);
  assert.equal(cb({ name: 'release/3.5' }, { base: 'release/3.5' }), null);
});

test('branch with a missing base (compare is null) is unmerged with unknown distance', () => {
  const r = cb({ name: 'f', noCompare: true });
  assert.equal(r.bucket, 'unmerged-branches');
  assert.match(r.reason, /Unknown distance from main/);
});

test('branch urls keep slashes and encode other characters', () => {
  const b = normalizeBranch(branch({ name: 'feat/a b#1' }), scanOf([]));
  assert.equal(b.url, 'https://github.com/Auterion/px4-firmware/tree/feat/a%20b%231');
});

test('classifyAll includes scanned branches and flags mine / unanswered / noReviewer / diff size', () => {
  const nodes = [branch({ name: 'wip', ahead: 2 }), branch({ name: 'gone', ahead: 0 })];
  const mineNoReviewer = pr({ mine: true });
  mineNoReviewer.additions = 10; mineNoReviewer.deletions = 2;
  const unanswered = pr({ mine: true, commitAgo: 60, comments: [['bob', 3]], reviewers: ['bob'] });
  const rows = classifyAll({ prs: [mineNoReviewer, unanswered, pr({})], branchScans: { x: scanOf(nodes) } }, CTX);
  const by = (f) => rows.find(f);
  assert.equal(rows.filter((r) => r.kind === 'branch').length, 2);
  assert.equal(by((r) => r.name === 'gone').bucket, 'dead-branches');
  assert.equal(by((r) => r.id === mineNoReviewer.id).noReviewer, true);
  assert.equal(by((r) => r.id === mineNoReviewer.id).additions, 10);
  assert.equal(by((r) => r.id === unanswered.id).unanswered, true);
  assert.equal(rows.filter((r) => r.kind === 'pr' && !r.mine).length, 1);
});

// ---- Branch options: whose branches, and the age rule ----------------------------
test('branchWho "mine" (and the default) skips other people\'s branches; "anyone" lists them', () => {
  assert.equal(cb({ name: 'f', author: 'alice', ahead: 0 }), null);
  assert.equal(cb({ name: 'f', author: 'alice', ahead: 0 }, {}, { branchWho: 'mine' }), null);
  const r = cb({ name: 'f', author: 'alice', ahead: 0 }, {}, { branchWho: 'anyone' });
  assert.equal(r.bucket, 'dead-branches');
});

test('branchWho "anyone" still lists branches whose author has no GitHub login', () => {
  const scan = scanOf([]);
  const b = normalizeBranch(branch({ name: 'f', author: null, authorName: 'Jane Dev', ahead: 0 }), scan);
  assert.equal(b.author, 'Jane Dev');
  assert.equal(classifyBranch(b, { ...CTX, branchWho: 'anyone' }).bucket, 'dead-branches');
  assert.equal(classifyBranch(b, { ...CTX, branchWho: 'mine' }), null);
});

test('age rule: unmerged branch idle longer than deadBranchDays is dead, with the facts in the reason', () => {
  const r = cb({ name: 'f', ahead: 7, committedAgo: 24 * 90 }, {}, { deadBranchDays: 60 });
  assert.equal(r.bucket, 'dead-branches');
  assert.match(r.reason, /No commits for 90 days; 7 commits ahead of main; no PR/);
  const closed = cb({ name: 'f', ahead: 1, committedAgo: 24 * 90, prs: [['CLOSED', 790, 24 * 89]] }, {}, { deadBranchDays: 60 });
  assert.match(closed.reason, /PR #790 was closed without merging/);
});

test('age rule: recent branches stay unmerged, 0 disables the rule, default is off in pure code', () => {
  assert.equal(cb({ name: 'f', ahead: 7, committedAgo: 24 * 30 }, {}, { deadBranchDays: 60 }).bucket, 'unmerged-branches');
  assert.equal(cb({ name: 'f', ahead: 7, committedAgo: 24 * 900 }, {}, { deadBranchDays: 0 }).bucket, 'unmerged-branches');
  assert.equal(cb({ name: 'f', ahead: 7, committedAgo: 24 * 900 }).bucket, 'unmerged-branches');
});

test('long-lived and protected branches are never offered for deletion', () => {
  const ctx = { branchWho: 'anyone', deadBranchDays: 1 };
  for (const name of ['release/3.5-marine', 'release-3.5', 'hotfix/urgent', 'develop', 'stable', 'master']) {
    assert.equal(cb({ name, ahead: 0, committedAgo: 24 * 400 }, {}, ctx), null, name);
  }
  assert.equal(cb({ name: 'feature/x', ahead: 0, protectedRule: true }, {}, ctx), null);
  assert.equal(cb({ name: 'feature/x', ahead: 0 }, {}, ctx).bucket, 'dead-branches');
});

test('rows: others\' branches are not "mine"; mine are', () => {
  const nodes = [branch({ name: 'a', author: 'alice', ahead: 0 }), branch({ name: 'b', author: 'me', ahead: 0 })];
  const rows = classifyAll({ branchScans: { x: scanOf(nodes) } }, { ...CTX, branchWho: 'anyone' });
  assert.deepEqual(rows.map((r) => [r.name, r.mine, r.author]), [['a', false, 'alice'], ['b', true, 'me']]);
});

test('ctx.branchRepo limits the branch list to one scan; undefined lists all', () => {
  const a = scanOf([branch({ name: 'a1', ahead: 0 })], { repo: 'Auterion/PX4_firmware_private' });
  const b = scanOf([branch({ name: 'b1', ahead: 0 })], { repo: 'Auterion/PX4_firmware_private_Kraken' });
  const scans = { a, b };
  const names = (ctx) => classifyAll({ branchScans: scans }, { ...CTX, branchWho: 'anyone', ...ctx }).map((r) => r.name);
  assert.deepEqual(names({}), ['a1', 'b1']);
  assert.deepEqual(names({ branchRepo: 'auterion/px4_firmware_private_kraken' }), ['b1']);
  assert.deepEqual(names({ branchRepo: 'auterion/px4_firmware_private' }), ['a1']);
  assert.deepEqual(names({ branchRepo: '' }), []);
});
