# Task Dashboard

One static page that shows your open GitHub work (PRs and issues) across many repos.
It calls the GitHub GraphQL API straight from your browser with your own token:
no backend, no scheduler, no stored data outside your browser. A refresh is **one**
GraphQL request (two on first run, to learn your login and team slugs).
See `PLAN.md` for goals, classification rules and decisions.

## Run it

ES modules do not load from `file://` in most browsers, so serve the folder:

```bash
cd task-dashboard
python3 -m http.server 8000     # or: npx serve .
```

Open <http://localhost:8000/>, paste a token when asked. Try `?demo=1` to see the page with
synthetic data and no token.

Hosting on GitHub Pages works too: the page holds no data or secret. It ships a
Content-Security-Policy that only allows scripts and styles from itself and network
access to `api.github.com`.

## Token

- **Classic PAT** (recommended): scopes `repo` and `read:org`, then *Configure SSO → Authorize*
  for your organization. `read:org` is needed to know your team slugs for team review requests.
- **Fine-grained PAT**: read-only Pull requests, Issues, Metadata. May need org admin approval
  and can miss repos in cross-repo search; add them under Settings → Extra repos.
- The token lives only in this origin's `localStorage`. Settings → "Forget token" (the token
  dialog) clears it and the cached data. Use a read-only token with an expiry.

## Settings (saved in localStorage)

Organizations searched for anything involving you, extra repos/orgs (e.g. `PX4/PX4-Autopilot`),
stale threshold (days), auto-refresh interval (minutes). Auto-refresh runs only while the tab is
visible and pauses after an auth or rate-limit error until you press Refresh.

## Buckets

Each item lands in exactly one bucket, first match wins: Waiting on you, Ready to merge,
Needs finishing, Stale, Waiting on others, Issues; plus a collapsed "Watching" bucket for other
people's PRs where you are only mentioned. Every row shows a one-line reason. Rules and the
deviations from the original plan are in `PLAN.md`; the code is `src/classify.js`.

## Layout

```
index.html  style.css
src/   config.js github.js queries.js classify.js render.js store.js main.js
scripts/probe.mjs            # run the real query once, save + scrub the response, report empty fields
scripts/make-synthetic.mjs   # regenerates test/fixtures/synthetic-response.json
test/                        # node --test, no dependencies
```

## Develop

```bash
npm test                                      # or: node --test
export GITHUB_TOKEN=$(gh auth token)
node scripts/probe.mjs --org Auterion --repo PX4/PX4-Autopilot
```

The probe writes `test/fixtures/probe-raw.json` (real data, git-ignored) and
`probe-scrubbed.json` (pseudonymized, safe to commit and to build fixtures from).
