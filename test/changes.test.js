import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRows } from '../src/changes.js';
import { classifyAll } from '../src/classify.js';
import { CTX, branch, pr, scanOf } from './helpers.js';

const rows = (prs) => classifyAll({ prs }, CTX);
const types = (d) => d.map((x) => x.type);

test('new PR waiting on me is a change; unchanged state is not', () => {
  const a = pr({ reviewers: ['me'] });
  assert.deepEqual(types(diffRows(rows([]), rows([a]))), ['waiting']);
  assert.deepEqual(diffRows(rows([a]), rows([a])), []);
});

test('moving into "Waiting on you" from another bucket notifies, with the reason', () => {
  const before = pr({ mine: true, reviewers: ['bob'], commitAgo: 60 });
  const after = { ...before, comments: { nodes: [{ author: { login: 'bob' }, createdAt: new Date(Date.parse('2026-11-02T12:00:00Z') - 3_600_000).toISOString() }] } };
  const d = diffRows(rows([before]), rows([after]));
  assert.deepEqual(types(d), ['waiting']);
  assert.match(d[0].text, /bob commented/);
});

test('a newer comment on a PR that was already waiting is reported as an update, once', () => {
  const t = (h) => new Date(Date.parse('2026-11-02T12:00:00Z') - h * 3_600_000).toISOString();
  const base = pr({ mine: true, reviewers: ['bob'], commitAgo: 100, comments: [['bob', 10]] });
  const newer = { ...base, comments: { nodes: [{ author: { login: 'bob' }, createdAt: t(10) }, { author: { login: 'carol' }, createdAt: t(2) }] } };
  const d = diffRows(rows([base]), rows([newer]));
  assert.equal(d.length, 1);
  assert.match(d[0].text, /^Update on /);
  assert.deepEqual(diffRows(rows([newer]), rows([newer])), []);
});

test('my PR becoming ready to merge, and my CI turning red', () => {
  const pending = pr({ mine: true, decision: 'APPROVED', ci: 'PENDING' });
  const ready = { ...pending, commits: { nodes: [{ commit: { ...pending.commits.nodes[0].commit, statusCheckRollup: { state: 'SUCCESS' } } }] } };
  assert.deepEqual(types(diffRows(rows([pending]), rows([ready]))), ['ready']);

  const green = pr({ mine: true, reviewers: ['bob'] });
  const red = { ...green, commits: { nodes: [{ commit: { ...green.commits.nodes[0].commit, statusCheckRollup: { state: 'FAILURE' } } }] } };
  assert.deepEqual(types(diffRows(rows([green]), rows([red]))), ['ci']);
});

test('my PR disappearing is reported unless the fetch was incomplete; others\' PRs never are', () => {
  const mine = pr({ mine: true, reviewers: ['bob'] });
  const theirs = pr({ reviewers: ['me'] });
  assert.deepEqual(types(diffRows(rows([mine, theirs]), rows([theirs]))), ['gone']);
  assert.deepEqual(diffRows(rows([mine, theirs]), rows([theirs]), { complete: false }), []);
  assert.deepEqual(diffRows(rows([mine, theirs]), rows([mine])), []);
});

test('branches never produce changes', () => {
  const withBranch = classifyAll({ branchScans: { x: scanOf([branch({ name: 'a', ahead: 0 })]) } }, { ...CTX, branchWho: 'anyone' });
  assert.deepEqual(diffRows([], withBranch), []);
  assert.deepEqual(diffRows(withBranch, []), []);
});

test('no previous data yields no "gone" noise', () => {
  assert.deepEqual(diffRows(null, rows([pr({ mine: true })])), []);
});

test('every change carries the row id and GitHub url, including for a PR that disappeared', () => {
  const a = pr({ reviewers: ['me'] });
  const mine = pr({ mine: true, reviewers: ['bob'] });
  const d = diffRows(rows([mine]), rows([a]));
  assert.deepEqual(d.map((x) => [x.type, x.id, x.url]), [
    ['waiting', a.id, a.url],
    ['gone', mine.id, mine.url],
  ]);
});
