// localStorage wrapper. Every access is guarded: storage can be blocked or full,
// and the page must still work (just without persistence).

import { DEFAULT_CONFIG, normalizeConfig } from './config.js';

const K = {
  token: 'taskdash.token', config: 'taskdash.config', cache: 'taskdash.cache',
  slackToken: 'taskdash.slacktoken', slackMap: 'taskdash.slackmap', nudges: 'taskdash.nudges',
};

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export const getToken = () => read(K.token) || '';
export function setToken(token) {
  clearCache(); // cached data belongs to whoever owned the previous token
  return write(K.token, token.trim());
}
export function forgetToken() { remove(K.token); clearCache(); }

export function getConfig() {
  try { return normalizeConfig(JSON.parse(read(K.config))); } catch { return { ...DEFAULT_CONFIG }; }
}
export const setConfig = (config) => write(K.config, JSON.stringify(normalizeConfig(config)));

/** Cache = last raw result + { fetchedAt }. Raw, so config changes can reclassify without refetching. */
export function getCache() {
  try { return JSON.parse(read(K.cache)); } catch { return null; }
}
export const setCache = (cache) => write(K.cache, JSON.stringify(cache));
export function clearCache() { remove(K.cache); }

// ---- Slack: token, GitHub-login -> Slack-ID overrides, and when each reviewer was last nudged
export const getSlackToken = () => read(K.slackToken) || '';
export const setSlackToken = (t) => write(K.slackToken, t.trim());
export const forgetSlackToken = () => remove(K.slackToken);

const json = (key) => { try { const v = JSON.parse(read(key)); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
export const getSlackMap = () => json(K.slackMap);
export const setSlackId = (login, id) => write(K.slackMap, JSON.stringify({ ...getSlackMap(), [login.toLowerCase()]: id }));
export const getNudges = () => json(K.nudges);
export const recordNudge = (key, at = Date.now()) => write(K.nudges, JSON.stringify({ ...getNudges(), [key]: at }));
