// Pure filter logic: chip definitions, matching, and per-chip counts that follow the
// current selection (a chip's count = rows that would show if that chip were picked,
// with every other filter still applied).

const ACTION = new Set(['waiting-on-you', 'ready-to-merge', 'needs-finishing']);

export const SHOW = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'needs-action', label: 'Needs action', test: (r) => ACTION.has(r.bucket) },
  { id: 'mine', label: 'Mine', test: (r) => !!r.mine },
  { id: 'ci-failing', label: 'CI failing', test: (r) => r.ci === 'FAILURE' || r.ci === 'ERROR' },
  { id: 'no-reviewer', label: 'No reviewer', test: (r) => !!r.noReviewer },
  { id: 'stale', label: 'Stale', test: (r) => r.bucket === 'stale' },
  { id: 'close-delete', label: 'Close or delete', test: (r) => r.bucket === 'stale' || r.bucket === 'dead-branches' },
];

export const TYPES = [
  { id: 'pr', label: 'PRs' },
  { id: 'issue', label: 'Issues' },
  { id: 'branch', label: 'Branches' },
];

const showTest = (id) => (SHOW.find((s) => s.id === id) || SHOW[0]).test;

/**
 * f = { text, repo, author, show: 'all', types: [] }. `skip` names facets to ignore
 * ({ show: true } / { types: true }) so their own counts can be computed.
 */
export function matches(row, f, skip = {}) {
  if (f.repo && row.repo !== f.repo) return false;
  if (f.author && row.author !== f.author) return false;
  if (f.text) {
    const hay = `${row.title} ${row.repo} ${row.author} ${row.reason} #${row.number ?? ''} ${row.base || ''}`.toLowerCase();
    if (!f.text.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  if (!skip.show && f.show && !showTest(f.show)(row)) return false;
  if (!skip.types && f.types?.length && !f.types.includes(row.kind)) return false;
  return true;
}

export const filterRows = (rows, f) => rows.filter((r) => matches(r, f));

export function showCounts(rows, f) {
  const base = rows.filter((r) => matches(r, f, { show: true }));
  return Object.fromEntries(SHOW.map((s) => [s.id, base.filter(s.test).length]));
}

export function typeCounts(rows, f) {
  const base = rows.filter((r) => matches(r, f, { types: true }));
  return Object.fromEntries(TYPES.map((t) => [t.id, base.filter((r) => r.kind === t.id).length]));
}
