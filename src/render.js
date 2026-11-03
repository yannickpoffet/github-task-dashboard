// DOM rendering. All API-derived text goes through textContent (never innerHTML)
// and links are restricted to https://github.com/ so a hostile title or URL
// cannot inject markup or a javascript: link.

import { BUCKETS, timeAgo } from './classify.js';
import { SHOW, TYPES, filterRows } from './filters.js';

const DEFAULT_BASES = new Set(['main', 'master', 'develop', 'dev']);
const opened = new Set(); // <details> buckets the user opened; survives re-renders
const NUM = new Intl.NumberFormat('en');

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

/** Row status stripe: red = act now, amber = needs attention, green = ready, grey = just waiting. */
export function toneOf(row) {
  if (row.bucket === 'waiting-on-you' || row.ci === 'FAILURE' || row.ci === 'ERROR' || row.mergeable === 'CONFLICTING') return 'red';
  if (row.bucket === 'ready-to-merge') return 'green';
  if (['needs-finishing', 'stale', 'dead-branches', 'unmerged-branches'].includes(row.bucket)) return 'amber';
  return 'grey';
}

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
const diffChip = (plus, minus) => chip(`+${NUM.format(plus)} / −${NUM.format(minus)}`, '', 'mono');

function pills(row, now) {
  const meta = el('div', { class: 'meta' });
  meta.append(row.mine ? chip('yours', 'own') : chip(`@${row.author}`));
  if (row.kind === 'pr') {
    meta.append(chip(`→ ${row.base}`, '', DEFAULT_BASES.has(row.base) ? '' : 'base-release'));
    if (row.isDraft) meta.append(chip('draft', 'warn'));
    meta.append(ciChip(row), reviewChip(row));
    if (row.unanswered) meta.append(chip('review unanswered', 'bad'));
    if (row.noReviewer) meta.append(chip('no reviewer', 'warn'));
    if (row.mergeable === 'CONFLICTING') meta.append(chip('conflicts', 'bad'));
    else if (row.mergeable === 'UNKNOWN') meta.append(chip('checking merge…'));
    if (row.additions != null) meta.append(diffChip(row.additions, row.deletions ?? 0));
  } else if (row.kind === 'branch') {
    meta.append(chip(`→ ${row.base}`, '', DEFAULT_BASES.has(row.base) ? '' : 'base-release'));
    if (row.ahead != null) meta.append(diffChip(row.ahead, row.behind ?? 0));
  }
  meta.append(chip(timeAgo(Date.parse(row.updatedAt), now)));
  return meta;
}

function rowEl(row, now) {
  const label = row.kind === 'branch' ? `⎇ ${row.title}` : `#${row.number} ${row.title}`;
  const link = el('a', { text: label, rel: 'noopener noreferrer' });
  const href = safeUrl(row.url);
  if (href) { link.href = href; link.target = '_blank'; }
  return el('div', { class: `row tone-${toneOf(row)}` },
    el('div', { class: 'title' }, el('span', { class: 'repo', text: row.repo }), link),
    pills(row, now),
    el('div', { class: 'reason', text: row.reason }));
}

/** Fill a <select> with sorted unique values, keeping the current selection if still present. */
export function fillSelect(select, values, labelFor = (v) => v) {
  const current = select.value;
  while (select.options.length > 1) select.remove(1);
  for (const v of values) select.append(el('option', { value: v, text: labelFor(v) }));
  select.value = values.includes(current) ? current : '';
}

export function updateFilterOptions(dom, rows) {
  const uniq = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  fillSelect(dom.repo, uniq('repo'));
  fillSelect(dom.author, uniq('author'));
}

/**
 * Chip row. defs = [{id,label}], counts = {id: n}. `active` is a Set of ids;
 * onToggle(id) is called on click. Zero-count chips stay clickable unless active-irrelevant.
 */
export function renderChips(container, defs, counts, active, onToggle) {
  container.replaceChildren(...defs.map((d) => {
    const b = el('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(active.has(d.id)) },
      el('span', { text: d.label }), el('span', { class: 'n', text: String(counts[d.id] ?? 0) }));
    b.addEventListener('click', () => onToggle(d.id));
    return b;
  }));
}
export const showDefs = SHOW;
export const typeDefs = TYPES;

/** Sticky section bar: jump links with live counts for the current selection. */
export function renderSectionNav(nav, visible) {
  nav.replaceChildren(...BUCKETS.map((b) => {
    const n = visible.filter((r) => r.bucket === b.id).length;
    const inner = [el('span', { text: b.label }), el('span', { class: 'n', text: String(n) })];
    return n
      ? el('a', { href: `#sec-${b.id}`, class: 'navlink' }, ...inner)
      : el('span', { class: 'navlink dim' }, ...inner);
  }));
}

/** Render all sections into `main`. Returns the visible rows. */
export function renderRows(main, rows, filters, now) {
  const sign = filters.sort === 'newest' ? -1 : 1;
  const visible = filterRows(rows, filters);
  main.replaceChildren();
  for (const b of BUCKETS) {
    const items = visible.filter((r) => r.bucket === b.id)
      .sort((x, y) => sign * (Date.parse(x.updatedAt) - Date.parse(y.updatedAt)));
    if (!items.length) continue;
    const head = [el('span', { text: b.label }), el('span', { class: 'count', text: String(items.length) })];
    const body = items.map((r) => rowEl(r, now));
    if (b.id === 'watching') {
      const d = el('details', { class: `bucket ${b.id}`, id: `sec-${b.id}` }, el('summary', {}, ...head), ...body);
      d.open = opened.has(b.id);
      d.addEventListener('toggle', () => (d.open ? opened.add(b.id) : opened.delete(b.id)));
      main.append(d);
    } else {
      main.append(el('section', { class: `bucket ${b.id}`, id: `sec-${b.id}` }, el('h2', {}, ...head), ...body));
    }
  }
  if (!visible.length) {
    main.append(el('p', { class: 'empty', text: rows.length ? 'Nothing matches the current filters.' : 'Nothing open that involves you. Nice.' }));
  }
  return visible;
}
