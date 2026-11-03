// Wiring: cached result first, then one live fetch, then auto-refresh while visible.

import { DEFAULT_CONFIG } from './config.js';
import { classifyAll, timeAgo } from './classify.js';
import { diffRows } from './changes.js';
import { SHOW, TYPES, showCounts, typeCounts } from './filters.js';
import { GitHubError, fetchDashboard, scanBranches } from './github.js';
import {
  el, fillSelect, renderChips, renderRows, renderSectionNav, safeUrl, updateFilterOptions,
} from './render.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const dom = {
  main: $('main'), banner: $('banner'), refresh: $('refresh'), user: $('user'), summary: $('summary'), updated: $('updated'),
  text: $('f-text'), repo: $('f-repo'), author: $('f-author'), sort: $('f-sort'),
  chipsShow: $('chips-show'), chipsType: $('chips-type'), nav: $('sections'),
  footRepos: $('foot-repos'), footRate: $('foot-rate'),
  changes: $('changes'), changesList: $('changes-list'),
  scanDetails: $('scan-details'), scanRepo: $('scan-repo'), scanWho: $('scan-who'), scanBase: $('scan-base'), scanRun: $('scan-run'), scanStatus: $('scan-status'),
};
const TEAMS_TTL = 24 * 3_600_000;

const demo = new URLSearchParams(location.search).has('demo');
let demoFixture = null;
let demoNow = null; // fixed clock for demo data so ages stay meaningful
let config = store.getConfig();
let cache = demo ? null : store.getCache();
let loading = false;
let scanning = false;
let paused = false; // set after auth errors so the timer does not hammer GitHub
let controller = null;
let lastRows = [];
const ui = { show: 'all', types: new Set() };

const now = () => demoNow ?? Date.now();
const ctxFor = (c) => ({
  me: c.login, teams: c.teams, staleDays: config.staleDays, now: now(),
  branchWho: config.branchWho, deadBranchDays: config.deadBranchDays,
  branchRepo: (c.activeScan || '').toLowerCase(),
});

// ---- banner ---------------------------------------------------------------
function showBanner(message, { tone = 'bad', url = null, action = null } = {}) {
  dom.banner.className = tone === 'warn' ? 'warn' : '';
  dom.banner.replaceChildren(el('span', { text: message }));
  const href = safeUrl(url);
  if (href) dom.banner.append(' ', el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: 'Open on GitHub →' }));
  if (action) {
    const b = el('button', { type: 'button', text: action.label });
    b.addEventListener('click', action.run);
    dom.banner.append(' ', b);
  }
  dom.banner.hidden = false;
}
const hideBanner = () => { dom.banner.hidden = true; };

function bannerForError(e) {
  const setToken = { label: 'Set token', run: openTokenDialog };
  switch (e.kind) {
    case 'no-token': showBanner('Add a GitHub token to load your work.', { tone: 'warn', action: setToken }); break;
    case 'bad-token': showBanner(e.message, { action: setToken }); break;
    case 'sso':
      showBanner('Your token is not authorized for the organization (SSO). Authorize it, then refresh.', { url: e.url }); break;
    case 'rate-limit':
      showBanner(`GitHub rate limit reached${e.resetAt ? `; resets ${new Date(e.resetAt).toLocaleTimeString()}` : ''}. Showing the last result.`, { tone: 'warn' }); break;
    case 'network': showBanner(`${e.message} Showing the last result.`, { tone: 'warn' }); break;
    default: showBanner(`GitHub error: ${e.message}`);
  }
}

// ---- drawing --------------------------------------------------------------
const filters = () => ({
  text: dom.text.value.trim(), repo: dom.repo.value, author: dom.author.value, sort: dom.sort.value,
  show: ui.show, types: [...ui.types],
});

function toggleShow(id) { ui.show = ui.show === id ? 'all' : id; redraw(); }
function toggleType(id) { if (ui.types.has(id)) ui.types.delete(id); else ui.types.add(id); redraw(); }

function redraw() {
  if (!cache) {
    dom.main.replaceChildren(el('p', { class: 'empty', text: demo || store.getToken() ? 'Loading…' : 'Add a token to get started.' }));
    dom.nav.replaceChildren(); dom.chipsShow.replaceChildren(); dom.chipsType.replaceChildren();
    return;
  }
  const rows = classifyAll(cache, ctxFor(cache));
  lastRows = rows;
  const waiting = rows.filter((r) => r.bucket === 'waiting-on-you').length;
  document.title = waiting ? `(${waiting}) Task Dashboard` : 'Task Dashboard';
  const f = filters();
  updateFilterOptions(dom, rows);
  const visible = renderRows(dom.main, rows, f, now());
  renderChips(dom.chipsShow, SHOW, showCounts(rows, f), new Set([ui.show]), toggleShow);
  renderChips(dom.chipsType, TYPES, typeCounts(rows, f), ui.types, toggleType);
  renderSectionNav(dom.nav, visible);
  updateScanOptions(rows);

  dom.user.textContent = `@${cache.login}${config.orgs.length ? ` · ${config.orgs.join(', ')}` : ''}`;
  const repos = new Set(rows.map((r) => r.repo)).size;
  dom.summary.textContent = `${visible.length === rows.length ? rows.length : `${visible.length} of ${rows.length}`} items · ${repos} repos`;
  const extra = config.extraRepos.length ? ` + ${config.extraRepos.join(', ')}` : '';
  dom.footRepos.textContent = `${cache.repoCount} repos with open items · searching ${config.orgs.join(', ') || 'no orgs'}${extra}`;
  const c = cache.counts;
  if (c) {
    dom.footRepos.textContent += ` · matches: PRs involving you ${c.involved ?? '-'}, review requests ${c.requested}, extra repos ${c.extra ?? '-'}, issues ${(c.issuesAssigned ?? 0) + (c.issuesAuthored ?? 0)}`;
  }
  const r = cache.rateLimit;
  dom.footRate.textContent = r
    ? `API ${r.remaining}/${r.limit} left · cost ${r.cost} · ${cache.requestCount} request${cache.requestCount === 1 ? '' : 's'} · resets ${new Date(r.resetAt).toLocaleTimeString()}`
    : '';
  for (const w of cache.warnings || []) {
    if (dom.banner.hidden) showBanner(w.message, { tone: 'warn', url: w.url });
  }
  if (dom.banner.hidden && c && config.orgs.length && c.involved === 0) {
    showBanner(`The search in ${config.orgs.join(', ')} found 0 PRs involving you. If GitHub's own search shows some, the token is probably not authorized for that organization: open the token, click Configure SSO and authorize it, then refresh.`,
      { tone: 'warn', url: 'https://github.com/settings/tokens' });
  }
  const bare = config.extraRepos.filter((x) => !x.includes('/'));
  if (dom.banner.hidden && bare.length) {
    showBanner(`"${bare.join(', ')}" in Settings has no owner, so it is searched as an organization. Write repos as owner/repo.`, { tone: 'warn' });
  }
}

function tickClock() {
  if (loading) dom.updated.textContent = 'Refreshing…';
  else if (cache?.fetchedAt) dom.updated.textContent = `Updated ${timeAgo(cache.fetchedAt, Date.now())}`;
  else dom.updated.textContent = '';
}

// ---- changes and notifications ------------------------------------------------
function showChanges(changes) {
  dom.changesList.replaceChildren(...changes.slice(0, 12).map((c) => el('li', { text: c.text })));
  if (changes.length > 12) dom.changesList.append(el('li', { class: 'muted', text: `…and ${changes.length - 12} more` }));
  dom.changes.hidden = false;
}

// Desktop notification, only when the user is not already looking at the page.
function notifyChanges(changes) {
  if (!changes.length) return;
  showChanges(changes);
  if (!config.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden && document.hasFocus()) return;
  const items = changes.length <= 3
    ? changes.map((c) => ({ body: c.text, tag: `${c.type}:${c.id}` }))
    : [{ body: `${changes.length} changes, e.g. ${changes[0].text}`, tag: 'summary' }];
  for (const it of items) {
    try {
      const n = new Notification('Task Dashboard', it);
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
}
$('changes-dismiss').addEventListener('click', () => { dom.changes.hidden = true; });

// ---- fetching -------------------------------------------------------------
function demoFetch(fixture) {
  return async (_url, init) => {
    const q = JSON.parse(init.body).query;
    let body = fixture;
    if (q.startsWith('query {')) body = { data: { viewer: fixture.data.viewer, rateLimit: fixture.data.rateLimit } };
    else if (q.startsWith('query Branches')) body = fixture.branchScan;
    else if (q.startsWith('query DefaultBranch')) body = fixture.defaultBranch;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
}

async function demoOpts() {
  if (!demoFixture) {
    demoFixture = await (await fetch('test/fixtures/synthetic-response.json')).json();
    demoNow = Date.parse(demoFixture.now);
  }
  return { fetchImpl: demoFetch(demoFixture) };
}

async function refresh() {
  if (loading) return;
  const token = demo ? 'demo' : store.getToken();
  if (!token) { bannerForError(new GitHubError('no-token', '')); redraw(); return; }
  loading = true; paused = false;
  dom.refresh.disabled = true; tickClock();
  controller = new AbortController();
  try {
    const opts = { signal: controller.signal, ...(demo ? await demoOpts() : {}) };
    const reuse = cache?.login && cache.teams && Date.now() - (cache.teamsFetchedAt || 0) < TEAMS_TTL;
    const before = cache?.login ? classifyAll(cache, ctxFor(cache)) : null; // what the user last saw
    const r = await fetchDashboard(token, config, reuse ? { login: cache.login, teams: cache.teams } : null, opts);
    cache = {
      ...r, fetchedAt: Date.now(), teamsFetchedAt: reuse ? cache.teamsFetchedAt : Date.now(),
      branchScans: cache?.branchScans || {}, // scans are on demand, so keep them across refreshes
      activeScan: cache?.activeScan || null,
    };
    if (!demo) store.setCache(cache);
    hideBanner();
    if (before) {
      notifyChanges(diffRows(before, classifyAll(cache, ctxFor(cache)), { complete: !(r.warnings || []).length }));
    }
    if (demo) showBanner('Demo mode: synthetic data, no network calls to GitHub.', { tone: 'warn' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (e instanceof GitHubError) {
      if (['bad-token', 'sso', 'no-token', 'rate-limit'].includes(e.kind)) paused = true;
      bannerForError(e);
      if (e.kind === 'bad-token') openTokenDialog();
    } else {
      showBanner(`Unexpected error: ${e.message}`);
      console.error(e);
    }
  } finally {
    loading = false; dom.refresh.disabled = false;
    redraw(); tickClock();
  }
}

// Auto-refresh only while the tab is visible and the cache is older than the interval.
function maybeAutoRefresh() {
  if (loading || paused) return;
  if (document.hidden && !config.notify) return; // notifications need background refreshes
  if (Date.now() - (cache?.fetchedAt || 0) >= config.refreshMinutes * 60_000) refresh();
}

// ---- branch scan ------------------------------------------------------------
const scanFor = (repo) => Object.values(cache?.branchScans || {}).find((s) => s.repo.toLowerCase() === (repo || '').toLowerCase());

function updateScanOptions(rows) {
  const names = new Map(); // lowercase -> display name; API-reported names win over config spelling
  for (const r of rows) if (r.kind !== 'branch') names.set(r.repo.toLowerCase(), r.repo);
  for (const s of Object.values(cache?.branchScans || {})) names.set(s.repo.toLowerCase(), s.repo);
  for (const x of config.extraRepos) if (x.includes('/') && !names.has(x.toLowerCase())) names.set(x.toLowerCase(), x);
  fillSelect(dom.scanRepo, [...names.values()].sort((a, b) => a.localeCompare(b)));
  if (cache?.activeScan && names.has(cache.activeScan.toLowerCase())) dom.scanRepo.value = names.get(cache.activeScan.toLowerCase());
  dom.scanWho.value = config.branchWho;
  dom.scanStatus.textContent = scanStatusText(dom.scanRepo.value);
}

function scanStatusText(repo) {
  const sc = scanFor(repo);
  if (!sc) return repo ? 'Not scanned yet.' : '';
  const mine = lastRows.filter((r) => r.kind === 'branch' && r.repo === sc.repo);
  const dead = mine.filter((r) => r.bucket === 'dead-branches').length;
  const unmerged = mine.length - dead;
  return `Scanned ${sc.totalSeen} branches of ${sc.repo} against ${sc.base} ${timeAgo(sc.scannedAt, Date.now())}: ${dead} dead, ${unmerged} unmerged with no PR.${sc.truncated ? ' Only the 300 most recently updated branches were scanned.' : ''}`;
}

async function runScan() {
  const repo = dom.scanRepo.value;
  if (!repo) { dom.scanStatus.textContent = 'Choose a repository first.'; return; }
  if (!cache) { dom.scanStatus.textContent = 'Wait for the first refresh to finish.'; return; }
  const token = demo ? 'demo' : store.getToken();
  if (!token) { bannerForError(new GitHubError('no-token', '')); return; }
  if (scanning) return;
  scanning = true; dom.scanRun.disabled = true;
  dom.scanStatus.textContent = `Scanning ${repo}…`;
  try {
    const r = await scanBranches(token, repo, dom.scanBase.value, demo ? await demoOpts() : {});
    cache = {
      ...cache,
      branchScans: { ...(cache.branchScans || {}), [r.scan.repo]: r.scan },
      activeScan: r.scan.repo,
      rateLimit: r.rateLimit || cache.rateLimit,
    };
    if (!demo) store.setCache(cache);
    for (const w of r.warnings) showBanner(w.message, { tone: 'warn', url: w.url });
    redraw();
    dom.scanRepo.value = r.scan.repo;
    dom.scanStatus.textContent = scanStatusText(r.scan.repo);
  } catch (e) {
    if (e instanceof GitHubError) { bannerForError(e); dom.scanStatus.textContent = e.message; }
    else { dom.scanStatus.textContent = `Unexpected error: ${e.message}`; console.error(e); }
  } finally {
    scanning = false; dom.scanRun.disabled = false;
  }
}

dom.scanRun.addEventListener('click', runScan);
dom.scanWho.addEventListener('change', () => {
  config = { ...config, branchWho: dom.scanWho.value };
  store.setConfig(config);
  config = store.getConfig();
  redraw();
});
dom.scanRepo.addEventListener('change', () => {
  // Picking a repo switches the branch list to that repo's stored scan (or to none).
  if (!cache) return;
  const sc = scanFor(dom.scanRepo.value);
  dom.scanBase.value = sc ? sc.base : '';
  cache = { ...cache, activeScan: sc ? sc.repo : null };
  if (!demo) store.setCache(cache);
  redraw();
  dom.scanStatus.textContent = scanStatusText(dom.scanRepo.value);
});
$('scan-clear').addEventListener('click', () => {
  if (!cache) return;
  cache = { ...cache, branchScans: {}, activeScan: null };
  if (!demo) store.setCache(cache);
  dom.scanBase.value = '';
  redraw();
  dom.scanStatus.textContent = 'Stored scans cleared.';
});

// ---- dialogs --------------------------------------------------------------
const tokenDialog = $('token-dialog');
const configDialog = $('config-dialog');

function openTokenDialog() {
  $('token-input').value = '';
  $('token-error').hidden = true;
  if (!tokenDialog.open) tokenDialog.showModal();
  $('token-input').focus();
}
$('token-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const value = $('token-input').value.trim();
  if (!/^[A-Za-z0-9_]{20,}$/.test(value)) {
    $('token-error').textContent = 'That does not look like a GitHub token.';
    $('token-error').hidden = false;
    return;
  }
  store.setToken(value);
  cache = null;
  tokenDialog.close();
  hideBanner();
  refresh();
});
$('token-cancel').addEventListener('click', () => tokenDialog.close());
$('token-forget').addEventListener('click', () => {
  store.forgetToken();
  cache = null; paused = true;
  tokenDialog.close();
  dom.user.textContent = ''; dom.summary.textContent = '';
  bannerForError(new GitHubError('no-token', ''));
  redraw(); tickClock();
});

function openConfigDialog() {
  $('c-orgs').value = config.orgs.join('\n');
  $('c-repos').value = config.extraRepos.join('\n');
  $('c-stale').value = config.staleDays;
  $('c-refresh').value = config.refreshMinutes;
  $('c-deadbranch').value = config.deadBranchDays;
  $('c-notify').checked = config.notify;
  $('notify-status').textContent = notifyStatus();
  configDialog.showModal();
}
function notifyStatus() {
  if (!('Notification' in window)) return 'Not supported by this browser.';
  return {
    granted: 'Permission: allowed.',
    denied: 'Permission: blocked. Allow notifications for this site in your browser settings.',
    default: 'Permission will be requested when you save.',
  }[Notification.permission];
}
const lines = (id) => $(id).value.split(/[\s,]+/).filter(Boolean);
$('config-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const notify = $('c-notify').checked;
  // Must be requested from this click handler, or the browser ignores it.
  if (notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  store.setConfig({
    ...config,
    orgs: lines('c-orgs'), extraRepos: lines('c-repos'),
    staleDays: $('c-stale').value, refreshMinutes: $('c-refresh').value,
    deadBranchDays: $('c-deadbranch').value, notify,
  });
  config = store.getConfig();
  configDialog.close();
  redraw();
  refresh();
});
$('config-cancel').addEventListener('click', () => configDialog.close());
$('config-reset').addEventListener('click', () => {
  store.setConfig({ ...DEFAULT_CONFIG, notify: config.notify });
  config = store.getConfig();
  configDialog.close();
  redraw();
  refresh();
});

// ---- wiring ---------------------------------------------------------------
dom.refresh.addEventListener('click', refresh);
$('open-config').addEventListener('click', openConfigDialog);
$('open-token').addEventListener('click', openTokenDialog);
for (const k of ['text', 'repo', 'author', 'sort']) {
  dom[k].addEventListener(k === 'text' ? 'input' : 'change', () => cache && redraw());
}
// Jump links: the "Watching" section is a collapsed <details>, so open it on the way.
dom.nav.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[href^="#sec-"]');
  const target = a && document.getElementById(a.getAttribute('href').slice(1));
  if (target?.tagName === 'DETAILS') target.open = true;
});
document.addEventListener('visibilitychange', () => { tickClock(); maybeAutoRefresh(); });
setInterval(() => { tickClock(); maybeAutoRefresh(); }, 30_000);

redraw();      // cached result appears immediately...
tickClock();
refresh();     // ...then the live fetch replaces it
