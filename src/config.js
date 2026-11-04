// Defaults and validation for the user-editable config.

// Sent by a bot, so the message must say who is asking. {me} is "Your name in messages" (or the GitHub login).
export const DEFAULT_NUDGE_TEMPLATE =
  'Hi {reviewer}, {me} is waiting on your review of <{url}|{repo}#{number}> "{title}" ' +
  '(no activity for {age}). Could you take a look when you have a moment? Thanks!';
// Earlier default; a saved copy of it is upgraded to the current default.
const OLD_NUDGE_TEMPLATE =
  'Hi {reviewer}, friendly ping: I am waiting on your review of <{url}|{repo}#{number}> "{title}" ' +
  '(no activity for {age}). Could you take a look when you have a moment? Thanks!';

export const DEFAULT_CONFIG = {
  orgs: ['Auterion'],
  extraRepos: ['PX4/PX4-Autopilot'], // "owner/repo" or a bare org name
  staleDays: 30,
  refreshMinutes: 5,
  deadBranchDays: 60,   // an unmerged branch with no commits for this long counts as dead (0 = off)
  branchWho: 'anyone',  // 'anyone' | 'mine': whose branches to list after a scan
  notify: false,        // browser notifications when something changes (needs permission)
  nudgeAfterHours: 24,  // show the Slack nudge button once a PR has been quiet this long
  nudgeTemplate: DEFAULT_NUDGE_TEMPLATE,
  senderName: '',       // how you appear in nudge messages; empty = your GitHub login
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)?$/;

/** Merge a stored/edited config over the defaults and sanitize every field. */
export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = (v, fallback) =>
    Array.isArray(v) ? [...new Set(v.map((s) => String(s).trim()).filter((s) => NAME.test(s)))] : fallback;
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  return {
    orgs: list(r.orgs, DEFAULT_CONFIG.orgs).filter((s) => !s.includes('/')),
    extraRepos: list(r.extraRepos, DEFAULT_CONFIG.extraRepos),
    staleDays: num(r.staleDays, DEFAULT_CONFIG.staleDays, 1, 365),
    refreshMinutes: num(r.refreshMinutes, DEFAULT_CONFIG.refreshMinutes, 1, 120),
    deadBranchDays: num(r.deadBranchDays, DEFAULT_CONFIG.deadBranchDays, 0, 3650),
    branchWho: r.branchWho === 'mine' ? 'mine' : 'anyone',
    notify: r.notify === true,
    nudgeAfterHours: num(r.nudgeAfterHours, DEFAULT_CONFIG.nudgeAfterHours, 0, 720),
    nudgeTemplate: typeof r.nudgeTemplate === 'string' && r.nudgeTemplate.trim() && r.nudgeTemplate.length <= 1000
      && r.nudgeTemplate !== OLD_NUDGE_TEMPLATE ? r.nudgeTemplate : DEFAULT_NUDGE_TEMPLATE,
    senderName: typeof r.senderName === 'string' ? r.senderName.trim().slice(0, 60) : '',
  };
}
