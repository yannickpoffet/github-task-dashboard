// Wiring: cached result first, then one live fetch, then auto-refresh while visible.

import { DEFAULT_CONFIG } from './config.js';
import { classifyAll, timeAgo } from './classify.js';
import { GitHubError, fetchDashboard } from './github.js';
import { el, renderRows, safeUrl, updateFilterOptions } from './render.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const dom = {
  main: $('main'), banner: $('banner'), refresh: $('refresh'), user: $('user'), updated: $('updated'),
  text: $('f-text'), repo: $('f-repo'), bucket: $('f-bucket'), author: $('f-author'), sort: $('f-sort'),
  footRepos: $('foot-repos'), footRate: $('foot-rate'),
};
const TEAMS_TTL = 24 * 3_600_000;

const demo = new URLSearchParams(location.search).has('demo');
let demoNow = null; // fixed clock for demo data so ages stay meaningful
let config = store.getConfig();
let cache = demo ? null : store.getCache();
let loading = false;
let paused = false; // set after auth errors so the timer does not hammer GitHub
let controller = null;

const now = () => demoNow ?? Date.now();

// ---- banner ---------------------------------------------------------------
function showBanner(message, { tone = 'bad', url = null, action = null } = {}) {
  dom.banner.className = tone === 'warn' ? 'warn' : '';
  dom.banner.replaceChildren(el('span', { text: message }));
  const href = safeUrl(url);
  if (href) dom.banner.append(' ', el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: 'Authorize the token →' }));
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
  text: dom.text.value.trim(), repo: dom.repo.value, bucket: dom.bucket.value, author: dom.author.value, sort: dom.sort.value,
});

function redraw() {
  if (!cache) {
    dom.main.replaceChildren(el('p', { class: 'empty', text: demo || store.getToken() ? 'Loading…' : 'Add a token to get started.' }));
    return;
  }
  const rows = classifyAll(cache, { me: cache.login, teams: cache.teams, staleDays: config.staleDays, now: now() });
  updateFilterOptions(dom, rows);
  renderRows(dom.main, rows, filters(), now());
  dom.user.textContent = `@${cache.login}`;
  const extra = config.extraRepos.length ? ` + ${config.extraRepos.join(', ')}` : '';
  dom.footRepos.textContent = `${cache.repoCount} repos with open items · searching ${config.orgs.join(', ') || 'no orgs'}${extra}`;
  const r = cache.rateLimit;
  dom.footRate.textContent = r
    ? `API ${r.remaining}/${r.limit} left · cost ${r.cost} · ${cache.requestCount} request${cache.requestCount === 1 ? '' : 's'} · resets ${new Date(r.resetAt).toLocaleTimeString()}`
    : '';
  const c = cache.counts;
  if (c) {
    dom.footRepos.textContent += ` · matches: PRs involving you ${c.involved ?? '-'}, review requests ${c.requested}, extra repos ${c.extra ?? '-'}, issues ${(c.issuesAssigned ?? 0) + (c.issuesAuthored ?? 0)}`;
  }
  for (const w of cache.warnings || []) {
    if (dom.banner.hidden) showBanner(w.message, { tone: 'warn', url: w.url });
  }
  if (dom.banner.hidden && c && config.orgs.length && c.involved === 0) {
    showBanner(`The search in ${config.orgs.join(', ')} found 0 PRs involving you. If GitHub's own search shows some, the token is probably not authorized for that organization: open the token, click Configure SSO and authorize it, then refresh.`,
      { tone: 'warn', url: 'https://github.com/settings/tokens' });
  }
  const bare = config.extraRepos.filter((r) => !r.includes('/'));
  if (dom.banner.hidden && bare.length) {
    showBanner(`"${bare.join(', ')}" in Settings has no owner, so it is searched as an organization. Write repos as owner/repo.`, { tone: 'warn' });
  }
}

function tickClock() {
  if (loading) dom.updated.textContent = 'Refreshing…';
  else if (cache?.fetchedAt) dom.updated.textContent = `Updated ${timeAgo(cache.fetchedAt, Date.now())}`;
  else dom.updated.textContent = '';
}

// ---- fetching -------------------------------------------------------------
function demoFetch(fixture) {
  return async (_url, init) => {
    const viewerOnly = JSON.parse(init.body).query.startsWith('query {');
    const body = viewerOnly ? { data: { viewer: fixture.data.viewer, rateLimit: fixture.data.rateLimit } } : fixture;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
}

async function refresh() {
  if (loading) return;
  const token = demo ? 'demo' : store.getToken();
  if (!token) { bannerForError(new GitHubError('no-token', '')); redraw(); return; }
  loading = true; paused = false;
  dom.refresh.disabled = true; tickClock();
  controller = new AbortController();
  try {
    const opts = { signal: controller.signal };
    if (demo) {
      const fixture = await (await fetch('test/fixtures/synthetic-response.json')).json();
      demoNow = Date.parse(fixture.now);
      opts.fetchImpl = demoFetch(fixture);
    }
    const reuse = cache?.login && cache.teams && Date.now() - (cache.teamsFetchedAt || 0) < TEAMS_TTL;
    const r = await fetchDashboard(token, config, reuse ? { login: cache.login, teams: cache.teams } : null, opts);
    cache = { ...r, fetchedAt: Date.now(), teamsFetchedAt: reuse ? cache.teamsFetchedAt : Date.now() };
    if (!demo) store.setCache(cache);
    hideBanner();
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
  if (document.hidden || loading || paused) return;
  if (Date.now() - (cache?.fetchedAt || 0) >= config.refreshMinutes * 60_000) refresh();
}

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
  dom.user.textContent = '';
  bannerForError(new GitHubError('no-token', ''));
  redraw(); tickClock();
});

function openConfigDialog() {
  $('c-orgs').value = config.orgs.join('\n');
  $('c-repos').value = config.extraRepos.join('\n');
  $('c-stale').value = config.staleDays;
  $('c-refresh').value = config.refreshMinutes;
  configDialog.showModal();
}
const lines = (id) => $(id).value.split(/[\s,]+/).filter(Boolean);
$('config-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  store.setConfig({
    orgs: lines('c-orgs'), extraRepos: lines('c-repos'),
    staleDays: $('c-stale').value, refreshMinutes: $('c-refresh').value,
  });
  config = store.getConfig();
  configDialog.close();
  redraw();
  refresh();
});
$('config-cancel').addEventListener('click', () => configDialog.close());
$('config-reset').addEventListener('click', () => {
  store.setConfig(DEFAULT_CONFIG);
  config = store.getConfig();
  configDialog.close();
  redraw();
  refresh();
});

// ---- wiring ---------------------------------------------------------------
dom.refresh.addEventListener('click', refresh);
$('open-config').addEventListener('click', openConfigDialog);
$('open-token').addEventListener('click', openTokenDialog);
for (const k of ['text', 'repo', 'bucket', 'author', 'sort']) {
  dom[k].addEventListener(k === 'text' ? 'input' : 'change', () => cache && redraw());
}
document.addEventListener('visibilitychange', () => { tickClock(); maybeAutoRefresh(); });
setInterval(() => { tickClock(); maybeAutoRefresh(); }, 30_000);

redraw();      // cached result appears immediately...
tickClock();
refresh();     // ...then the live fetch replaces it
