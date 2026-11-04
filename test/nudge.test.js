import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NUDGE_TEMPLATE, normalizeConfig } from '../src/config.js';
import { buildMessage, hoursSinceNudge, nudgeTargets, slackIdFor, withinCooldown, ageText } from '../src/nudge.js';
import { SlackError, isSlackId, isSlackToken, sendSlackDm } from '../src/slack.js';
import { classifyAll } from '../src/classify.js';
import { CTX, NOW, pr } from './helpers.js';

const rowOf = (node) => classifyAll({ prs: [node] }, CTX)[0];
const OPT = { now: NOW, me: 'me', nudgeAfterHours: 24 };

test('nudge targets: my PR waiting on people, quiet long enough', () => {
  const r = rowOf(pr({ mine: true, reviewers: ['bob', 'carol'], updatedAgo: 30 }));
  assert.deepEqual(nudgeTargets(r, OPT), ['bob', 'carol']);
});

test('nudge targets: too recent, not mine, draft, no individual reviewer, or not waiting are skipped', () => {
  assert.deepEqual(nudgeTargets(rowOf(pr({ mine: true, reviewers: ['bob'], updatedAgo: 5 })), OPT), []);
  assert.deepEqual(nudgeTargets(rowOf(pr({ reviewers: ['bob'], updatedAgo: 50 })), OPT), []);                     // theirs
  assert.deepEqual(nudgeTargets(rowOf(pr({ mine: true, draft: true, reviewers: ['bob'], updatedAgo: 50 })), OPT), []);
  assert.deepEqual(nudgeTargets(rowOf(pr({ mine: true, reviewers: ['team:Auterion/orca'], updatedAgo: 50 })), OPT), []);
  assert.deepEqual(nudgeTargets(rowOf(pr({ mine: true, ci: 'FAILURE', reviewers: ['bob'], updatedAgo: 50 })), OPT), []); // needs finishing
  assert.deepEqual(nudgeTargets(rowOf(pr({ mine: true, reviewers: ['bob'], updatedAgo: 50 })), { ...OPT, nudgeAfterHours: 72 }), []);
});

test('nudge targets: stale PRs with a reviewer qualify; at most 3 people; never me', () => {
  assert.deepEqual(nudgeTargets(rowOf(pr({ mine: true, reviewers: ['bob'], updatedAgo: 24 * 45 })), OPT), ['bob']);
  const many = rowOf(pr({ mine: true, reviewers: ['a', 'b', 'c', 'd'], updatedAgo: 30 }));
  assert.equal(nudgeTargets(many, OPT).length, 3);
});

test('message: tokens are filled, link is a Slack link, title is escaped so it cannot ping a channel', () => {
  const node = pr({ mine: true, reviewers: ['bob'], updatedAgo: 24 * 3, repo: 'Auterion/px4' });
  node.title = 'Fix <!channel> & "quotes"';
  const msg = buildMessage(DEFAULT_NUDGE_TEMPLATE, rowOf(node), 'bob', { now: NOW, me: 'me' });
  assert.match(msg, /^Hi bob, me is waiting on your review of </);
  assert.match(msg, new RegExp(`<https://github.com/Auterion/px4/pull/${node.number}\\|Auterion/px4#${node.number}>`));
  assert.ok(msg.includes('Fix &lt;!channel&gt; &amp; "quotes"'));
  assert.ok(!msg.includes('<!channel>'));
  assert.match(msg, /no activity for 3 days/);
});

test('message: unknown tokens are left alone and age wording', () => {
  assert.equal(buildMessage('{reviewer} {nope}', rowOf(pr({ mine: true })), 'bob', { now: NOW, me: 'me' }), 'bob {nope}');
  assert.equal(ageText(new Date(NOW - 3_600_000).toISOString(), NOW), '1 hour');
  assert.equal(ageText(new Date(NOW - 5 * 3_600_000).toISOString(), NOW), '5 hours');
});

test('cooldown bookkeeping', () => {
  const r = rowOf(pr({ mine: true, reviewers: ['bob'] }));
  const nudges = { [`${r.id}:bob`]: NOW - 3 * 3_600_000 };
  assert.equal(hoursSinceNudge(nudges, r, 'Bob', NOW), 3);
  assert.equal(withinCooldown(nudges, r, 'bob', NOW), true);
  assert.equal(withinCooldown({ [`${r.id}:bob`]: NOW - 30 * 3_600_000 }, r, 'bob', NOW), false);
  assert.equal(hoursSinceNudge({}, r, 'bob', NOW), null);
});

test('slack id lookup: overrides beat the file, case-insensitive, underscore keys ignored', () => {
  const file = { _readme: 'x', Bob: 'U111AAAAA', carol: 'U222BBBBB' };
  assert.equal(slackIdFor('bob', file, {}), 'U111AAAAA');
  assert.equal(slackIdFor('BOB', file, { bob: 'U999ZZZZZ' }), 'U999ZZZZZ');
  assert.equal(slackIdFor('_readme', file, {}), '');
  assert.equal(slackIdFor('dave', file, {}), '');
});

test('config: nudge settings are validated', () => {
  const c = normalizeConfig({ nudgeAfterHours: 99999, nudgeTemplate: '   ' });
  assert.equal(c.nudgeAfterHours, 720);
  assert.equal(c.nudgeTemplate, DEFAULT_NUDGE_TEMPLATE);
  assert.equal(normalizeConfig({ nudgeTemplate: 'Ping {reviewer}' }).nudgeTemplate, 'Ping {reviewer}');
});

test('slack validators', () => {
  assert.ok(isSlackId('U0123ABCDEF') && isSlackId('W0123ABCDE'));
  assert.ok(!isSlackId('bob') && !isSlackId('') && !isSlackId('C0123ABCDEF'));
  assert.ok(isSlackToken('xoxb-123456789012-abcdefghijkl') && !isSlackToken('ghp_abc') && !isSlackToken(''));
});

const TOKEN = 'xoxb-123456789012-abcdefghijkl';
const slackFetch = (reply) => { const calls = []; return { calls, impl: async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => reply }; } }; };

test('sendSlackDm: token goes in the form body (no Authorization header), DM target is the user id', async () => {
  const f = slackFetch({ ok: true, ts: '1.2' });
  const r = await sendSlackDm(TOKEN, 'U0123ABCDEF', 'hello', { fetchImpl: f.impl });
  assert.equal(r.ts, '1.2');
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://slack.com/api/chat.postMessage');
  assert.deepEqual(Object.keys(init.headers), ['Content-Type']);
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(init.body.get('token'), TOKEN);
  assert.equal(init.body.get('channel'), 'U0123ABCDEF');
  assert.equal(init.body.get('text'), 'hello');
});

test('sendSlackDm errors: input checks, Slack error codes, blocked requests', async () => {
  await assert.rejects(sendSlackDm('', 'U0123ABCDEF', 'x'), (e) => e instanceof SlackError && e.kind === 'no-token');
  await assert.rejects(sendSlackDm(TOKEN, 'bob', 'x'), (e) => e.kind === 'bad-id');
  await assert.rejects(sendSlackDm(TOKEN, 'U0123ABCDEF', 'x', { fetchImpl: slackFetch({ ok: false, error: 'invalid_auth' }).impl }),
    (e) => e.kind === 'invalid_auth' && /rejected the token/.test(e.message));
  await assert.rejects(sendSlackDm(TOKEN, 'U0123ABCDEF', 'x', { fetchImpl: slackFetch({ ok: false, error: 'missing_scope' }).impl }), /chat:write/);
  await assert.rejects(sendSlackDm(TOKEN, 'U0123ABCDEF', 'x', { fetchImpl: slackFetch({ ok: false, error: 'weird' }).impl }), /Slack error: weird/);
  const blocked = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(sendSlackDm(TOKEN, 'U0123ABCDEF', 'x', { fetchImpl: blocked }), (e) => e.kind === 'blocked');
});

test('config: sender name is trimmed and capped; a saved copy of the old default template is upgraded', () => {
  assert.equal(normalizeConfig({ senderName: '  Yannick  ' }).senderName, 'Yannick');
  assert.equal(normalizeConfig({ senderName: 'x'.repeat(200) }).senderName.length, 60);
  assert.equal(normalizeConfig({}).senderName, '');
  const old = 'Hi {reviewer}, friendly ping: I am waiting on your review of <{url}|{repo}#{number}> "{title}" (no activity for {age}). Could you take a look when you have a moment? Thanks!';
  assert.equal(normalizeConfig({ nudgeTemplate: old }).nudgeTemplate, DEFAULT_NUDGE_TEMPLATE);
  assert.ok(DEFAULT_NUDGE_TEMPLATE.includes('{me} is waiting'));
});
