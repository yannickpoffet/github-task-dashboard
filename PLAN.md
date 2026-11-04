# Cross-repo task dashboard — implementation plan

Nov 2, 2026 · @Yannick Poffet

## Context and goals

Build a single static web page that shows my open GitHub work across many repos, fetched live in the browser in under 3 seconds, with no backend, no scheduler and no agent in the loop.

The existing orca-triage tool works, but it has three problems this rebuild removes:

- **Slow:** a full run makes \~1000+ REST calls (mostly the branch scan) and takes 1–2 minutes.
- **Cumbersome:** a collector script, a state file and a republish step must all run before the page is current.
- **Scheduling doesn't work:** a scheduled task only fires if an agent creates it, and that agent session has no access to the GitHub repos.

Success criteria:

- [ ] Opening or reloading the page shows current data in ≤ 3 s.
- [ ] Uses ≤ 5 GitHub API requests per refresh.
- [ ] No server, no cron, no stored data outside my browser.
- [ ] Any teammate can use the same page with their own token.
- [ ] Covers every Auterion repo where something involves me, plus repos I add explicitly (e.g. `PX4/PX4-Autopilot`).

## Architecture

One static HTML page calls the GitHub GraphQL API from the browser with my own token; there is no backend, state file or scheduler.

&#91;embedded content: architecture · page, GitHub API, optional notifier\]

On load the page shows the cached last result instantly, then sends one GraphQL request and re-renders. Host it as a local file or on GitHub Pages; the page holds no data or secret, so public hosting is safe. Claude's published artifact pages block outside network requests, so the page can't live there.

## Classification rules

Each item lands in exactly one bucket, checked top to bottom; first match wins. All rules use fields returned by the queries below, so classification needs no extra API calls.

| Bucket | Rule | Data used |
| --- | --- | --- |
| Waiting on you | I or one of my teams is in `reviewRequests` | `reviewRequests` (User / Team) |
| Waiting on you | Someone else's PR: author pushed after my latest review | `latestReviews` (mine) vs last commit `committedDate` |
| Waiting on you | My PR: a comment or review from someone else is newer than my last activity | last comments/reviews `author` + `createdAt` |
| Waiting on you | My PR: changes requested and I pushed since, but no re-request | `reviewDecision = CHANGES_REQUESTED`, commit date > review date, empty `reviewRequests` |
| Ready to merge | My PR: `reviewDecision = APPROVED`, CI green, `mergeable = MERGEABLE` | `reviewDecision`, `statusCheckRollup.state`, `mergeable` |
| Needs finishing | My PR: CI failing, conflicts, draft, or no reviewer requested | `statusCheckRollup.state`, `mergeable`, `isDraft`, `reviewRequests` |
| Waiting on others | My PR: review requested and nothing new since | `reviewRequests` non-empty |
| Stale | My PR: `updatedAt` older than 30 days (configurable) | `updatedAt` |
| Issues | Open issues assigned to me or authored by me | issue search |

Every row shows: repo, number + title (link), author, base branch, CI state, review state, age, and a one-line reason for its bucket. Base branch is shown because stacked PRs on release branches (e.g. `release/3.5-marine`) matter more than the default branch.

These are heuristics; the reason line lets me verify a classification at a glance.

## GraphQL queries

Three search queries, sent as one GraphQL request with aliases, fetch everything; results are merged and de-duplicated by PR/issue `id`.

| Alias | Search string | Purpose |
| --- | --- | --- |
| `involved` | `is:open is:pr involves:@me org:Auterion` | My PRs, PRs I reviewed, commented on or was mentioned in |
| `requested` | `is:open is:pr review-requested:@me` | Direct and team review requests (any org) |
| `issues` | `is:open is:issue assignee:@me` + `is:open is:issue author:@me` | My issues |
| `extra` (optional) | `is:open is:pr involves:@me repo:PX4/PX4-Autopilot` | One clause per extra repo/org from config |

PR fragment to request per node (starting point; verify field names against the schema in GitHub's GraphQL Explorer):

```graphql
fragment PR on PullRequest {
  id number title url isDraft createdAt updatedAt
  repository { nameWithOwner }
  author { login }
  baseRefName headRefName
  mergeable reviewDecision
  reviewRequests(first: 10) {
    nodes { requestedReviewer { ... on User { login } ... on Team { slug } } }
  }
  latestReviews(first: 10) { nodes { author { login } state submittedAt } }
  comments(last: 5) { nodes { author { login } createdAt } }
  commits(last: 1) {
    nodes { commit { committedDate statusCheckRollup { state } } }
  }
}
```

Also fetch once per session: `viewer { login organizations(first: 20) { nodes { login teams(first: 50, userLogins: ["<me>"]) { nodes { slug } } } } }` to know my team slugs for the team-review rule (needs `read:org` scope).

Limits to keep in mind:

- Search returns max 100 nodes per page and 1000 total; paginate with `pageInfo.endCursor` if `issueCount > 100`.
- GraphQL rate limit is 5000 points/hour; one refresh costs roughly 10–30 points, so auto-refresh every 5 min is fine.
- `mergeable` can be `UNKNOWN` right after a push; show it as "checking" rather than misclassifying.

## Project structure and milestones

Keep it a plain static site with zero build step: vanilla JS modules, no framework, no npm dependencies at runtime. Classification lives in a pure module so it can be unit-tested with fixtures.

```
task-dashboard/
  index.html          # layout, token setup dialog, filters
  style.css           # light/dark via prefers-color-scheme
  src/
    config.js         # orgs, extra repos, stale days, refresh interval
    github.js         # GraphQL client: fetch, pagination, rate-limit info
    queries.js        # search strings + PR/issue fragments
    classify.js       # pure: raw nodes -> {bucket, reason}
    render.js         # sections, rows, filters, counts
    store.js          # token + last result in localStorage
    main.js           # wiring, auto-refresh timer
  test/
    fixtures/*.json   # recorded GraphQL responses (scrubbed)
    classify.test.js  # node --test, no deps
  README.md
```

Milestones, each ending in something I can open and use:

1. **Query spike.** Script `scripts/probe.mjs` (Node 20, built-in `fetch`) runs the combined query with `GITHUB_TOKEN` and saves the raw JSON to `test/fixtures/`. Confirm field names, SSO access and result counts.
2. **Classifier.** Implement `classify.js` against the fixtures; one test per rule in the classification table.
3. **Minimal page.** Token dialog, one fetch, sections with counts, rows with links and reason. Open via `index.html` from disk or `npx serve`.
4. **Usability.** Filters (repo, bucket, author, text search), sort by age, "last updated X min ago", cached result shown instantly on load, auto-refresh every 5 min while the tab is visible (`visibilitychange`), manual refresh button.
5. **Config and polish.** Editable config (orgs, extra repos, stale days) saved in localStorage; rate-limit indicator; clear error states for bad token, missing SSO authorization, and `mergeable = UNKNOWN`.
6. **Hosting.** Push to a repo and enable GitHub Pages, or keep it local. The page holds no data or secret, so public hosting is harmless.

Token setup to document in the README:

- Classic PAT with scopes `repo` and `read:org`, then *Configure SSO → Authorize* for Auterion.
- Alternative: fine-grained PAT with read-only Pull requests, Issues, Metadata; may need org admin approval and can miss repos in cross-repo search.
- Token stored only in `localStorage` of this origin; a "Forget token" button clears it.

## Scope, risks and how to start in Claude Code

Version 1 is PRs and issues only; branches and notifications come later if still wanted.

Out of scope for v1:

- **Branch scan** (dead branches, unmerged work without a PR): the main cause of slowness, and misleading for stacks based on release branches. Later: an on-demand button per repo comparing against a base I pick.
- **Notifications:** later, a GitHub Actions cron job in a private repo with a token secret that posts to Slack when "Waiting on you" grows. Runs inside GitHub, so no agent access problem.
- **Jira or other trackers.**
- **Any write action** (merge, comment, close): the page stays read-only.

Risks:

| Risk | Mitigation |
| --- | --- |
| Token in localStorage could leak via XSS | No third-party scripts; render with `textContent`, never `innerHTML` with API data; read-only token with expiry |
| SSO not authorized for the token | Detect the SSO error header/message and show the exact fix |
| Search misses a repo (fine-grained token, private fork) | Explicit `repo:` clauses in config; show repo count in footer |
| Classification heuristics wrong | Reason line per row; fixtures + tests per rule |
| Field names differ from this plan | Milestone 1 validates them before any UI work |

Starting in Claude Code:

1. Create an empty repo `task-dashboard`, save this doc as `PLAN.md` at its root (export as Markdown).
2. Export a token: `export GITHUB_TOKEN=$(gh auth token)` (ensure `read:org` scope and SSO authorization).
3. First prompt: *"Read PLAN.md. Do milestone 1 only: write scripts/probe.mjs, run it, save the response to test/fixtures/, and report which fields came back empty or errored. Don't build UI yet."*
4. Then one milestone per prompt, each ending with tests passing and the page opened locally. Ask Claude Code to keep `PLAN.md` updated as decisions change.

---

## Implementation notes (added during the build)

Status: milestones 1–6 implemented. Milestone 1 (live probe) has **not** been run against real
GitHub yet; see below.

- **Field names validated offline.** The generated queries (all variants: with/without teams,
  with pagination cursor, no orgs) pass `graphql-js` validation against the octokit GraphQL schema
  snapshot. `Team.combinedSlug` (`org/slug`) is used to match team requests. Still run
  `scripts/probe.mjs` with your token to confirm SSO access, `read:org` team results and counts.
- **Rule changes vs the table above**
  - *Stale* is checked **before** *Waiting on others*. In the original order, any stale PR with a
    reviewer requested would match "Waiting on others" first and Stale would almost never fire.
  - Team review requests only count as "Waiting on you" on **other people's** PRs (on my own PRs
    they are usually CODEOWNERS noise).
  - On my PRs, approvals do not count as "someone else's activity newer than mine"; they feed
    *Ready to merge*. Bot comments/reviews (`[bot]`) are ignored. Dismissed reviews are ignored.
  - A repo with no CI (`statusCheckRollup = null`) counts as green for *Ready to merge*.
  - "No reviewer requested" only triggers *Needs finishing* when the PR is not already approved.
  - Approved but CI pending or `mergeable = UNKNOWN` goes to *Waiting on others* ("merge status
    still being computed") instead of being misclassified.
  - Other people's PRs where I already reviewed and the author has not pushed: *Waiting on
    others*. Where I am only mentioned or commented: new collapsed bucket *Watching*, so nothing
    returned by the query silently disappears.
- **Request budget**: 1 request per refresh once login/teams are cached (teams re-fetched every
  24 h); 2 on first run; +1 per extra page for any search above 100 results (max 4 extra pages).
- **Probe output**: raw response is git-ignored; a scrubbed copy is written for fixtures.
- **`?demo=1`** serves a synthetic fixture through the real fetch/classify/render path.

### Added after the first live run (ported from the earlier "Orca Triage" artifact)

- Sticky section bar with live counts; Show chips and Type chips with counts that follow the other
  filters (`src/filters.js`, unit-tested); row status stripe; pills `yours`, `review unanswered`,
  `no reviewer`, `+adds / −dels`; header item/repo counts; footer sources and read-only statement.
- **Branch scan, on demand** (`scanBranches` in `src/github.js`, rules in `classifyBranch`): one repo
  at a time, 300 most recently updated branches, one GraphQL request per 100 branches (plus one to
  resolve the default branch). Merge detection uses the branch tip date versus the PR's merge date,
  because squash merges leave a merged branch "ahead" forever. `Ref.compare(headRef: base)` is taken
  from the branch's side, so `aheadBy` is the branch's *behind* count and `behindBy` its *ahead* count.
- Deliberately not ported: the "Run update now" panel, the artifact db state and quick/full runs
  (this page fetches live, so there is no snapshot to refresh), and the "details unavailable" pill
  (GraphQL either returns a PR in full or hides the repo; the SSO and empty-org warnings cover that).

### Branch options and change notifications

- Branch scan can list *anyone's* branches (default) or only mine; the scan stores every branch and
  the filter is applied when classifying. Dead = merged PR with no newer commits, nothing ahead of the
  base, or no commits for `deadBranchDays` (default 60). Long-lived names and protected branches are
  never offered for deletion. `branchProtectionRule` is only visible to users with enough access on the
  repo, so the name pattern is the fallback.
- Notifications are in-page only (`src/changes.js`, unit-tested): "What changed" panel, tab-title
  count, optional `Notification` API while a tab is open. A "no longer open" message is suppressed when
  the fetch had warnings (SSO or truncated results), to avoid false alarms. Out of scope: notifications
  while the page is closed (needs a GitHub Actions cron job plus a Slack/email secret).

### Slack nudges

- The Nudge button sends a DM straight from the browser with a Slack token the user pastes in Settings
  (same trust model as the GitHub token). A GitHub Action relay was the alternative; it keeps the Slack
  secret out of the browser but needs a workflow, repo secrets and write access for every user.
- `src/slack.js` posts `chat.postMessage` form-encoded with the token in the body (no preflight). Whether
  Slack's API accepts such cross-origin calls from github.io could not be tested from the build sandbox;
  the dialog falls back to copying the message if the browser blocks the call.
- Not done: nudging teams, bulk nudges, and any automatic sending. Every message needs a click.
