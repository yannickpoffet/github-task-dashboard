// DOM rendering. All API-derived text goes through textContent (never innerHTML)
// and links are restricted to https://github.com/ so a hostile title or URL
// cannot inject markup or a javascript: link.

import { BUCKETS, timeAgo } from './classify.js';

const DEFAULT_BASES = new Set(['main', 'master', 'develop', 'dev']);
const opened = new Set(); // <details> buckets the user opened; survives re-renders

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

export const safeUrl = (u) => (typeof u === 'string' && u.startsWith('https://github.com/') ? u : null);
const chip = (text, tone = '', extra = '') => el('span', { class: `chip ${tone} ${extra}`.trim(), text });

function ciChip(row) {
  switch (row.ci) {
    case 'SUCCESS': return chip('CI passing', 'ok');
    case 'FAILURE': case 'ERROR': return chip('CI failing', 'bad');
    case 'PENDING': case 'EXPECTED': return chip('CI running', 'warn');
    default: return chip('no CI');
  }
}
function reviewChip(row) {
  switch (row.reviewDecision) {
    case 'APPROVED': return chip('approved', 'ok');
    case 'CHANGES_REQUESTED': return chip('changes requested', 'bad');
    case 'REVIEW_REQUIRED': return chip('review required', 'warn');
    default: return chip('no review yet');
  }
}

function rowEl(row, now) {
  const link = el('a', { text: `#${row.number} ${row.title}`, rel: 'noopener noreferrer' });
  const href = safeUrl(row.url);
  if (href) { link.href = href; link.target = '_blank'; }
  const meta = el('div', { class: 'meta' }, chip(`@${row.author}`));
  if (row.kind === 'pr') {
    meta.append(chip(`→ ${row.base}`, '', DEFAULT_BASES.has(row.base) ? '' : 'base-release'));
    if (row.isDraft) meta.append(chip('draft', 'warn'));
    meta.append(ciChip(row), reviewChip(row));
    if (row.mergeable === 'CONFLICTING') meta.append(chip('conflicts', 'bad'));
    else if (row.mergeable === 'UNKNOWN') meta.append(chip('checking merge…'));
  }
  meta.append(chip(timeAgo(Date.parse(row.updatedAt), now)));
  return el('div', { class: 'row' },
    el('div', { class: 'title' }, el('span', { class: 'repo', text: row.repo }), link),
    meta,
    el('div', { class: 'reason', text: row.reason }));
}

export function matchesFilters(row, f) {
  if (f.repo && row.repo !== f.repo) return false;
  if (f.bucket && row.bucket !== f.bucket) return false;
  if (f.author && row.author !== f.author) return false;
  if (f.text) {
    const hay = `${row.title} ${row.repo} ${row.author} ${row.reason} #${row.number} ${row.base || ''}`.toLowerCase();
    if (!f.text.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

/** Fill a <select> with sorted unique values, keeping the current selection if still present. */
function fillSelect(select, values, labelFor = (v) => v) {
  const current = select.value;
  while (select.options.length > 1) select.remove(1);
  for (const v of values) select.append(el('option', { value: v, text: labelFor(v) }));
  select.value = values.includes(current) ? current : '';
}

export function updateFilterOptions(dom, rows) {
  const uniq = (key) => [...new Set(rows.map((r) => r[key]))].sort((a, b) => a.localeCompare(b));
  fillSelect(dom.repo, uniq('repo'));
  fillSelect(dom.author, uniq('author'));
  const counts = Object.fromEntries(BUCKETS.map((b) => [b.id, rows.filter((r) => r.bucket === b.id).length]));
  fillSelect(dom.bucket, BUCKETS.map((b) => b.id), (id) => `${BUCKETS.find((b) => b.id === id).label} (${counts[id]})`);
}

/** Render all sections into `main`. Returns the number of visible rows. */
export function renderRows(main, rows, filters, now) {
  const sign = filters.sort === 'newest' ? -1 : 1;
  const visible = rows.filter((r) => matchesFilters(r, filters));
  main.replaceChildren();
  for (const b of BUCKETS) {
    const items = visible.filter((r) => r.bucket === b.id)
      .sort((x, y) => sign * (Date.parse(x.updatedAt) - Date.parse(y.updatedAt)));
    if (!items.length) continue;
    const head = [el('span', { text: b.label }), el('span', { class: 'count', text: String(items.length) })];
    const body = items.map((r) => rowEl(r, now));
    if (b.id === 'watching') {
      const d = el('details', { class: `bucket ${b.id}` }, el('summary', {}, ...head), ...body);
      d.open = opened.has(b.id) || filters.bucket === b.id;
      d.addEventListener('toggle', () => (d.open ? opened.add(b.id) : opened.delete(b.id)));
      main.append(d);
    } else {
      main.append(el('section', { class: `bucket ${b.id}` }, el('h2', {}, ...head), ...body));
    }
  }
  if (!visible.length) {
    main.append(el('p', { class: 'empty', text: rows.length ? 'Nothing matches the current filters.' : 'Nothing open that involves you. Nice.' }));
  }
  return visible.length;
}
