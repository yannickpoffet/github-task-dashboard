// Pure change detection between two classified row lists (PRs and issues only;
// branches come from on-demand scans, so they are never "changes").

const failing = (r) => r.ci === 'FAILURE' || r.ci === 'ERROR';
const label = (r) => `${r.repo}#${r.number} ${r.title}`;

/**
 * Returns [{ type, id, url, text }] describing what is new in `next` compared to `prev`:
 *  - waiting:  entered "Waiting on you", or its triggering event (comment, push) is newer
 *  - ready:    my PR became ready to merge
 *  - ci:       my PR's CI started failing
 *  - gone:     my PR is no longer open (merged or closed). Skipped when `complete` is false,
 *              i.e. when the last fetch had warnings and may have missed results.
 */
export function diffRows(prev, next, { complete = true } = {}) {
  const before = new Map((prev || []).filter((r) => r.kind !== 'branch').map((r) => [r.id, r]));
  const after = (next || []).filter((r) => r.kind !== 'branch');
  const out = [];
  for (const r of after) {
    const p = before.get(r.id);
    if (r.bucket === 'waiting-on-you') {
      if (!p || p.bucket !== 'waiting-on-you') out.push({ type: 'waiting', id: r.id, url: r.url, text: `Waiting on you: ${label(r)}. ${r.reason}` });
      else if (r.eventAt && r.eventAt > (p.eventAt || 0)) out.push({ type: 'waiting', id: r.id, url: r.url, text: `Update on ${label(r)}. ${r.reason}` });
    } else if (r.kind === 'pr' && r.mine && p) {
      if (r.bucket === 'ready-to-merge' && p.bucket !== 'ready-to-merge') {
        out.push({ type: 'ready', id: r.id, url: r.url, text: `Ready to merge: ${label(r)}` });
      } else if (failing(r) && !failing(p)) {
        out.push({ type: 'ci', id: r.id, url: r.url, text: `CI failing: ${label(r)}` });
      }
    }
  }
  if (complete) {
    const ids = new Set(after.map((r) => r.id));
    for (const [id, p] of before) {
      if (p.kind === 'pr' && p.mine && !ids.has(id)) out.push({ type: 'gone', id, url: p.url, text: `No longer open (merged or closed): ${label(p)}` });
    }
  }
  return out;
}
