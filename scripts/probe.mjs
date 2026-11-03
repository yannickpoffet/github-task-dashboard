#!/usr/bin/env node
// Milestone 1: run the dashboard's real query once against GitHub, save the raw
// response, and report which fields came back empty or errored.
//
//   export GITHUB_TOKEN=$(gh auth token)     # needs repo + read:org, SSO-authorized
//   node scripts/probe.mjs [--org Auterion] [--repo PX4/PX4-Autopilot] [--out test/fixtures]
//
// Writes  <out>/probe-raw.json        (real data, git-ignored: never commit it)
//         <out>/probe-scrubbed.json   (logins, titles, repos, branches pseudonymized)
// Env GITHUB_GRAPHQL_URL overrides the endpoint (used to test against a local mock).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { ENDPOINT, GitHubError, graphql } from '../src/github.js';
import { ALIASES, VIEWER_QUERY, buildQuery, buildSearchStrings } from '../src/queries.js';
import { BUCKETS, classifyAll } from '../src/classify.js';

/** Count nodes where `get(node)` is null/empty. */
function nullReport(nodes, checks) {
  return Object.entries(checks).map(([name, isEmpty]) => {
    const n = nodes.filter(isEmpty).length;
    return { field: name, empty: n, total: nodes.length };
  });
}

export function fieldReport(prs, issues) {
  const empty = (v) => v == null || (Array.isArray(v) && v.length === 0);
  const prChecks = {
    'author': (n) => empty(n.author),
    'repository': (n) => empty(n.repository),
    'baseRefName': (n) => empty(n.baseRefName),
    'mergeable === UNKNOWN': (n) => n.mergeable === 'UNKNOWN',
    'reviewDecision (null = no review policy / none yet)': (n) => empty(n.reviewDecision),
    'reviewRequests.nodes (empty)': (n) => empty(n.reviewRequests?.nodes),
    'reviewRequests.requestedReviewer (null)': (n) => (n.reviewRequests?.nodes || []).some((r) => !r.requestedReviewer),
    'latestReviews.nodes (empty)': (n) => empty(n.latestReviews?.nodes),
    'comments.nodes (empty)': (n) => empty(n.comments?.nodes),
    'commits.nodes (empty)': (n) => empty(n.commits?.nodes),
    'statusCheckRollup (null = repo has no CI)': (n) => empty(n.commits?.nodes?.[0]?.commit?.statusCheckRollup),
  };
  const issueChecks = {
    'author': (n) => empty(n.author),
    'assignees.nodes (empty)': (n) => empty(n.assignees?.nodes),
  };
  return { pr: nullReport(prs, prChecks), issue: nullReport(issues, issueChecks) };
}

/** Pseudonymize everything that identifies people, repos or work, keeping structure intact. */
export function scrub(json) {
  const maps = {};
  const pseudo = (kind, v) => {
    const m = (maps[kind] ||= new Map());
    if (!m.has(v)) m.set(v, `${kind}-${m.size + 1}`);
    return m.get(v);
  };
  const me = json.data?.viewer?.login;
  const walk = (v, key, inOrgs) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key, inOrgs));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k, inOrgs || k === 'organizations');
      if (typeof out.number === 'number' && typeof v.url === 'string') {
        const kind = /\/issues\//.test(v.url) ? 'issues' : 'pull';
        out.url = `https://github.com/example/repo/${kind}/${out.number}`;
      }
      return out;
    }
    if (typeof v !== 'string') return v;
    switch (key) {
      case 'login': return inOrgs ? pseudo('org', v) : v === me ? 'me' : pseudo('user', v);
      case 'title': return `Title ${pseudo('title', v).slice(6)}`;
      case 'headRefName': return pseudo('branch', v);
      case 'slug': return pseudo('team', v);
      case 'combinedSlug': { const [o, s] = v.split('/'); return `${pseudo('org', o)}/${pseudo('team', s)}`; }
      case 'nameWithOwner': { const [o, r] = v.split('/'); return `${pseudo('org', o)}/${pseudo('repo', r)}`; }
      case 'id': return pseudo('id', v);
      case 'endCursor': return 'cursor';
      case 'url': return v; // overwritten above for nodes; leave anything else
      default: return v;
    }
  };
  return walk(json, '', false);
}

function parseArgs(argv) {
  const a = { orgs: [], repos: [], out: 'test/fixtures' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--org') a.orgs.push(argv[++i]);
    else if (argv[i] === '--repo') a.repos.push(argv[++i]);
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  return a;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Set GITHUB_TOKEN first, e.g. export GITHUB_TOKEN=$(gh auth token)');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const config = normalizeConfig({
    ...DEFAULT_CONFIG,
    ...(args.orgs.length ? { orgs: args.orgs } : {}),
    ...(args.repos.length ? { extraRepos: args.repos } : {}),
  });
  const opts = { endpoint: process.env.GITHUB_GRAPHQL_URL || ENDPOINT };
  const searches = buildSearchStrings(config);
  console.log('Endpoint:', opts.endpoint);
  console.log('Searches:'); for (const [k, v] of Object.entries(searches)) console.log(`  ${k.padEnd(15)} ${v}`);

  const t0 = Date.now();
  const v = await graphql(token, VIEWER_QUERY, {}, opts);
  const login = v.data.viewer.login;
  const { query, variables } = buildQuery(searches, { withTeams: true, login });
  const r = await graphql(token, query, variables, opts);
  const ms = Date.now() - t0;
  console.log(`\nViewer: ${login}   2 requests in ${ms} ms (target: whole refresh <= 3000 ms)`);
  console.log('Rate limit:', JSON.stringify(r.rateLimit));
  for (const w of r.warnings) console.log(`WARNING [${w.kind}] ${w.message}${w.url ? ` -> ${w.url}` : ''}`);

  const teams = (r.data.viewer.organizations?.nodes || []).flatMap((o) =>
    (o.teams?.nodes || []).map((t) => `${o.login}/${t.slug}`));
  console.log(`Teams (need read:org; 0 here means missing scope or no teams): ${teams.length}`, teams.slice(0, 8).join(', '));

  const all = { prs: [], issues: [] };
  console.log('\nAlias            issueCount  returned  hasNextPage');
  for (const alias of Object.keys(searches)) {
    const s = r.data[alias];
    const nodes = (s?.nodes || []).filter((n) => n && n.id);
    (ALIASES[alias].type === 'PullRequest' ? all.prs : all.issues).push(...nodes);
    console.log(`${alias.padEnd(16)} ${String(s?.issueCount).padStart(10)} ${String(nodes.length).padStart(9)}  ${s?.pageInfo?.hasNextPage}`);
  }

  const rep = fieldReport(all.prs, all.issues);
  for (const [kind, rows] of Object.entries(rep)) {
    console.log(`\nEmpty/null fields on ${kind} nodes:`);
    for (const x of rows) console.log(`  ${String(x.empty).padStart(4)}/${String(x.total).padEnd(4)} ${x.field}`);
  }

  const rows = classifyAll(all, { me: login, teams, staleDays: config.staleDays, now: Date.now() });
  console.log('\nClassification of this response:');
  for (const b of BUCKETS) console.log(`  ${b.label.padEnd(24)} ${rows.filter((x) => x.bucket === b.id).length}`);

  fs.mkdirSync(args.out, { recursive: true });
  const rawPath = path.join(args.out, 'probe-raw.json');
  const scrubbedPath = path.join(args.out, 'probe-scrubbed.json');
  fs.writeFileSync(rawPath, JSON.stringify(r.raw, null, 2));
  fs.writeFileSync(scrubbedPath, JSON.stringify(scrub(r.raw), null, 2));
  console.log(`\nSaved ${rawPath} (private, git-ignored) and ${scrubbedPath} (scrubbed).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    if (e instanceof GitHubError) {
      console.error(`\n[${e.kind}] ${e.message}${e.url ? `\nAuthorize here: ${e.url}` : ''}`);
    } else console.error(e);
    process.exit(1);
  });
}
