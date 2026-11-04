// Send a Slack DM from the browser. The token goes in the form body (not a header) so the
// request stays a "simple" cross-origin POST and needs no CORS preflight. If the browser still
// blocks it, the caller falls back to copying the message.

export const SLACK_POST_MESSAGE = 'https://slack.com/api/chat.postMessage';

/** kind: 'no-token' | 'bad-id' | 'blocked' | 'http' | a Slack error code such as 'invalid_auth' */
export class SlackError extends Error {
  constructor(kind, message) { super(message); this.name = 'SlackError'; this.kind = kind; }
}

const EXPLAIN = {
  invalid_auth: 'Slack rejected the token. Check it in Settings.',
  not_authed: 'Slack rejected the token. Check it in Settings.',
  token_revoked: 'The Slack token was revoked. Add a new one in Settings.',
  account_inactive: 'The Slack token belongs to an inactive account.',
  missing_scope: 'The Slack token lacks a scope. A bot token needs chat:write; a user token needs chat:write and im:write.',
  channel_not_found: 'Slack could not find that member ID. Check the Slack ID.',
  user_not_found: 'Slack could not find that member ID. Check the Slack ID.',
  cannot_dm_bot: 'That Slack ID belongs to a bot, not a person.',
  user_disabled: 'That Slack user is deactivated.',
  ratelimited: 'Slack is rate limiting this token. Try again in a minute.',
};

export const isSlackId = (id) => /^[UW][A-Z0-9]{7,}$/.test(id || '');
export const isSlackToken = (t) => /^xox[bpa]-[A-Za-z0-9-]{10,}$/.test(t || '');

export async function sendSlackDm(token, userId, text, { fetchImpl = fetch } = {}) {
  if (!isSlackToken(token)) throw new SlackError('no-token', 'Add a Slack token in Settings first.');
  if (!isSlackId(userId)) throw new SlackError('bad-id', 'That does not look like a Slack member ID (it starts with U or W).');
  let res;
  try {
    res = await fetchImpl(SLACK_POST_MESSAGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, channel: userId, text, unfurl_links: 'false', unfurl_media: 'false' }),
    });
  } catch {
    throw new SlackError('blocked', 'The browser blocked the request to Slack (CORS or network).');
  }
  const body = await res.json().catch(() => null);
  if (!body) throw new SlackError('http', `Slack returned HTTP ${res.status} without a JSON body.`);
  if (!body.ok) throw new SlackError(body.error || 'unknown', EXPLAIN[body.error] || `Slack error: ${body.error}`);
  return { ts: body.ts };
}
