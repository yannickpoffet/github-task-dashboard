// Who to nudge, the message to send, and nudge bookkeeping. Pure: no DOM, no network.

const HOUR = 3_600_000;
const NUDGE_BUCKETS = new Set(['waiting-on-others', 'stale']);
export const NUDGE_COOLDOWN_HOURS = 24;

export function ageText(updatedAt, now) {
  const h = Math.max(0, Math.round((now - Date.parse(updatedAt)) / HOUR));
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}

// Slack mrkdwn: & < > must be escaped inside text, otherwise a title like "<!channel>" would ping everyone.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Fill {reviewer} {me} {repo} {number} {title} {url} {age} {base} in the template. Unknown tokens stay as-is. */
export function buildMessage(template, row, reviewer, { now, me }) {
  const vars = {
    reviewer, me, repo: row.repo, number: row.number, title: row.title, url: row.url,
    age: ageText(row.updatedAt, now), base: row.base,
  };
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? (k === 'url' ? String(vars[k]) : esc(vars[k])) : m));
}

/**
 * Reviewers worth nudging on a row: my own open, non-draft PR, still waiting on individual people,
 * and quiet for at least nudgeAfterHours. Team requests are skipped (a team cannot be DMed).
 */
export function nudgeTargets(row, { now, me, nudgeAfterHours }) {
  if (row.kind !== 'pr' || !row.mine || row.isDraft || !NUDGE_BUCKETS.has(row.bucket)) return [];
  if ((now - Date.parse(row.updatedAt)) / HOUR < nudgeAfterHours) return [];
  return row.requestedUsers.filter((u) => u.toLowerCase() !== me.toLowerCase()).slice(0, 3);
}

export const nudgeKey = (row, login) => `${row.id}:${login.toLowerCase()}`;

/** Hours since this reviewer was last nudged on this PR, or null if never. */
export function hoursSinceNudge(nudges, row, login, now) {
  const at = nudges?.[nudgeKey(row, login)];
  return at ? (now - at) / HOUR : null;
}

export const withinCooldown = (nudges, row, login, now) => {
  const h = hoursSinceNudge(nudges, row, login, now);
  return h !== null && h < NUDGE_COOLDOWN_HOURS;
};

/** Slack ID for a GitHub login: local overrides win over the repo's slack-users.json. */
export function slackIdFor(login, fileMap = {}, overrides = {}) {
  const k = login.toLowerCase();
  const norm = (m) => Object.fromEntries(Object.entries(m || {}).filter(([key]) => !key.startsWith('_')).map(([key, v]) => [key.toLowerCase(), v]));
  return norm(overrides)[k] || norm(fileMap)[k] || '';
}
