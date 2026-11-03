import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOW, filterRows, showCounts, typeCounts } from '../src/filters.js';
import { classifyAll } from '../src/classify.js';
import { CTX, branch, issue, pr, scanOf } from './helpers.js';

const rows = classifyAll({
  prs: [
    pr({ mine: true, decision: 'APPROVED', repo: 'A/one' }),                              // ready, mine
    pr({ mine: true, ci: 'FAILURE', reviewers: ['bob'], repo: 'A/one' }),                  // CI failing, mine
    pr({ mine: true, repo: 'A/two' }),                                                     // no reviewer, mine
    pr({ mine: true, reviewers: ['bob'], updatedAgo: 24 * 60, repo: 'A/two' }),            // stale, mine
    pr({ reviewers: ['me'], repo: 'A/two' }),                                              // waiting on you, theirs
  ],
  issues: [issue({ repo: 'A/one' })],
  branchScans: { a: scanOf([branch({ name: 'dead', ahead: 0 }), branch({ name: 'wip', ahead: 3 })], { repo: 'A/one' }) },
}, CTX);
const F = (o = {}) => ({ text: '', repo: '', author: '', show: 'all', types: [], ...o });

test('every Show chip selects the intended rows', () => {
  const n = (id) => filterRows(rows, F({ show: id })).length;
  assert.equal(n('all'), rows.length);
  assert.equal(n('needs-action'), 4);   // 1 ready + CI failing + no-reviewer (needs finishing) + waiting on you
  assert.equal(n('mine'), rows.filter((r) => r.mine).length);
  assert.equal(n('ci-failing'), 1);
  assert.equal(n('no-reviewer'), 1);
  assert.equal(n('stale'), 1);
  assert.equal(n('close-delete'), 2);   // 1 stale PR + 1 dead branch
});

test('type chips: PRs, Issues, Branches, and several at once', () => {
  assert.equal(filterRows(rows, F({ types: ['branch'] })).length, 2);
  assert.equal(filterRows(rows, F({ types: ['issue'] })).length, 1);
  assert.equal(filterRows(rows, F({ types: ['issue', 'branch'] })).length, 3);
});

test('filters combine, and chip counts follow the current selection', () => {
  const f = F({ repo: 'A/one' });
  const sc = showCounts(rows, f);
  assert.equal(sc.all, rows.filter((r) => r.repo === 'A/one').length);
  assert.equal(sc['ci-failing'], 1);
  assert.equal(sc['no-reviewer'], 0);                       // that PR is in A/two
  const f2 = F({ repo: 'A/one', show: 'close-delete' });
  assert.deepEqual(typeCounts(rows, f2), { pr: 0, issue: 0, branch: 1 });
  // a chip's own facet is ignored in its counts, so counts for "Show" do not collapse to the picked chip
  assert.equal(showCounts(rows, f2).all, sc.all);
});

test('text search spans repo, title, reason, id and combines with chips', () => {
  assert.equal(filterRows(rows, F({ text: 'a/two' })).length, 3);
  assert.equal(filterRows(rows, F({ text: 'a/two', show: 'stale' })).length, 1);
  assert.equal(filterRows(rows, F({ text: 'dead' })).length, 1);
  assert.equal(filterRows(rows, F({ text: 'already merged' })).length, 1);
});

test('SHOW ids are unique and start with all', () => {
  assert.equal(SHOW[0].id, 'all');
  assert.equal(new Set(SHOW.map((s) => s.id)).size, SHOW.length);
});
