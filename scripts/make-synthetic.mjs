#!/usr/bin/env node
// Generates test/fixtures/synthetic-response.json: a hand-built response in the exact
// shape of the dashboard's GraphQL query, covering every bucket. Used by ?demo=1 and by
// the pipeline test. Real recorded responses come from scripts/probe.mjs instead.

import fs from 'node:fs';
import { pr, issue, NOW } from '../test/helpers.js';

const involved = [
  pr({ mine: true, decision: 'APPROVED', base: 'release/3.5-marine', repo: 'Auterion/px4-firmware' }),
  pr({ mine: true, ci: 'FAILURE', reviewers: ['bob'], repo: 'Auterion/px4-firmware' }),
  pr({ mine: true, draft: true, mergeable: 'CONFLICTING', repo: 'Auterion/orca-core' }),
  pr({ mine: true, reviewers: ['carol'], updatedAgo: 24 * 45, repo: 'Auterion/orca-core' }),
  pr({ mine: true, reviewers: ['bob'], repo: 'Auterion/orca-ui', ci: 'PENDING' }),
  pr({ mine: true, commitAgo: 60, comments: [['bob', 3]], reviewers: ['bob'], repo: 'Auterion/orca-ui' }),
  pr({ reviews: [['me', 'CHANGES_REQUESTED', 30]], commitAgo: 4, base: 'release/3.5-marine', repo: 'Auterion/px4-firmware' }),
  pr({ comments: [['me', 90]], author: 'dave', repo: 'Auterion/orca-core' }),
];
const requested = [
  pr({ reviewers: ['me'], author: 'erin', repo: 'Auterion/orca-ui' }),
  pr({ reviewers: ['team:Auterion/orca'], author: 'frank', repo: 'Auterion/orca-core' }),
];
const extra = [pr({ mine: true, reviewers: ['bob'], repo: 'PX4/PX4-Autopilot', base: 'main' })];
const issuesAssigned = [issue({ author: 'alice', assignees: ['me'] })];
const issuesAuthored = [issue({ author: 'me', assignees: [] })];

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
};
const file = new URL('../test/fixtures/synthetic-response.json', import.meta.url);
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log('wrote', file.pathname);
