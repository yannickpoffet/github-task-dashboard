#!/usr/bin/env node
// Generates test/fixtures/synthetic-response.json: a hand-built response in the exact
// shape of the dashboard's GraphQL query, covering every bucket. Used by ?demo=1 and by
// the pipeline test. Real recorded responses come from scripts/probe.mjs instead.

import fs from 'node:fs';
import { pr, issue, branch, NOW } from '../test/helpers.js';

const involved = [
  pr({ mine: true, decision: 'APPROVED', base: 'release/3.5-marine', repo: 'Auterion/px4-firmware', size: [5276, 2] }),
  pr({ mine: true, ci: 'FAILURE', reviewers: ['bob'], repo: 'Auterion/px4-firmware', size: [48, 12] }),
  pr({ mine: true, draft: true, mergeable: 'CONFLICTING', repo: 'Auterion/orca-core' }),
  pr({ mine: true, reviewers: ['carol'], updatedAgo: 24 * 45, repo: 'Auterion/orca-core' }),
  pr({ mine: true, reviewers: ['bob'], repo: 'Auterion/orca-ui', ci: 'PENDING' }),
  pr({ mine: true, commitAgo: 60, comments: [['bob', 3]], reviewers: ['bob'], repo: 'Auterion/orca-ui' }),
  pr({ reviews: [['me', 'CHANGES_REQUESTED', 30]], commitAgo: 4, base: 'release/3.5-marine', repo: 'Auterion/px4-firmware' }),
  pr({ comments: [['me', 90]], author: 'dave', repo: 'Auterion/orca-core' }),
];
const requested = [
  pr({ reviewers: ['me'], author: 'erin', repo: 'Auterion/orca-ui', size: [310, 95] }),
  pr({ reviewers: ['team:Auterion/orca'], author: 'frank', repo: 'Auterion/orca-core' }),
];
const extra = [pr({ mine: true, reviewers: ['bob'], repo: 'PX4/PX4-Autopilot', base: 'main' })];
const issuesAssigned = [issue({ author: 'alice', assignees: ['me'] })];
const issuesAuthored = [issue({ author: 'me', assignees: [] })];

// Branch scan of Auterion/px4-firmware against main (served for the "Scan my branches" button in demo mode).
const branchNodes = [
  branch({ name: 'main', author: 'alice', ahead: 0, committedAgo: 2 }),
  branch({ name: 'feature/old-gps-fix', committedAgo: 24 * 40, ahead: 12, prs: [['MERGED', 801, 24 * 38]] }),
  branch({ name: 'tmp/already-in-main', committedAgo: 24 * 15, ahead: 0, behind: 220 }),
  branch({ name: 'wip/ekf-tuning', committedAgo: 24 * 9, ahead: 5276, behind: 2 }),
  branch({ name: 'experiment/closed-idea', committedAgo: 24 * 70, ahead: 4, prs: [['CLOSED', 790, 24 * 69]] }),
  branch({ name: 'feature/someone-elses', author: 'alice', ahead: 7 }),
  branch({ name: 'feature/has-open-pr', ahead: 2, prs: [['OPEN', 812, 0]] }),
];
const search = (nodes) => ({ issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const out = {
  now: new Date(NOW).toISOString(), // demo mode uses this as "now" so ages stay stable
  data: {
    rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAt: '2026-11-02T13:00:00Z' },
    viewer: {
      login: 'me',
      organizations: { nodes: [{ login: 'Auterion', teams: { nodes: [{ slug: 'orca' }] } }] },
    },
    involved: search(involved),
    requested: search(requested),
    extra: search(extra),
    issuesAssigned: search(issuesAssigned),
    issuesAuthored: search(issuesAuthored),
  },
  defaultBranch: {
    data: {
      rateLimit: { cost: 1, remaining: 4998, limit: 5000, resetAt: '2026-11-02T13:00:00Z' },
      repository: { nameWithOwner: 'Auterion/px4-firmware', defaultBranchRef: { name: 'main' } },
    },
  },
  branchScan: {
    data: {
      rateLimit: { cost: 4, remaining: 4994, limit: 5000, resetAt: '2026-11-02T13:00:00Z' },
      repository: {
        nameWithOwner: 'Auterion/px4-firmware',
        defaultBranchRef: { name: 'main' },
        refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: branchNodes },
      },
    },
  },
};
const file = new URL('../test/fixtures/synthetic-response.json', import.meta.url);
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log('wrote', file.pathname);
