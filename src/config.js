// Defaults and validation for the user-editable config.

export const DEFAULT_CONFIG = {
  orgs: ['Auterion'],
  extraRepos: ['PX4/PX4-Autopilot'], // "owner/repo" or a bare org name
  staleDays: 30,
  refreshMinutes: 5,
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
  };
}
