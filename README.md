# ReviewBoard — Bitbucket Code-Review Monitor

A Manifest V3 browser extension (Chrome / Edge / Firefox) that turns any screen into a
dark-mode wallboard of **open Bitbucket Cloud pull requests that still need review**.
Built for a TV in the team room, a spare monitor, or a pinned browser tab.

Example target repository: `acme/demo`
(`https://bitbucket.org/acme/demo`).

No build step, no framework, no third-party dependencies — plain HTML/CSS/JS.

---

## Features

- **Manifest V3**, one code base for Chrome/Edge and Firefox (two manifest files, see
  [Install](#install)).
- **Wallboard UI** tuned for large screens: high-contrast dark theme, `clamp()`-based
  typography from 1080p to 4K, card grid with colour-coded review state.
- **Filters out everything that does not need action**
  - PRs with an approval (Bitbucket `participants`, author never counts)
  - drafts (toggle)
  - source branches such as `dependabot/` / `renovate/` / `wip/`
  - title keywords such as `wip` / `do not merge` / `dnm`
  - optionally: only PRs with a **pending** reviewer
  - optionally: approvals made **before the head commit** no longer count
- **Highlights what matters**
  - changes requested, review requested, stale approval, or plain "needs review"
  - requested reviewers (avatars) or the people who requested changes
  - **build status** per PR (failing / running / passing / none) from the pull-request
    statuses endpoint (Bitbucket Pipelines, Jenkins, …)
  - age badge with urgency colouring (`<4h`, `<24h`, `<72h`, older pulses red)
  - branch pair, additions/deletions, changed-file count
- **Reviewer scoreboard** for the last 10 days: podium + leaderboard, points for
  reviews (sized by PR diff), comments, created and merged PRs; optional team filter.
- **Live refresh** with countdown ring, top progress bar and subtle "refreshing" state.
- **Alerts** on new PRs: border pulse, `NEW` ribbon, flashing tab title, optional chime.
- **Options page** for credentials, workspace/slug, API base URL, interval, filters,
  alerts. Includes **Test connection** and cache reset.
- **Background worker** polls on an alarm, keeps a snapshot in `storage.local`, updates
  the toolbar badge with the number of PRs waiting.
- **Multi-screen friendly**: every dashboard instance reads the same snapshot, so a
  second monitor or popup stays in sync without extra API calls.
- **Resilient**: ETag conditional requests, 304 handling, `Retry-After`-aware rate-limit
  countdown, offline fallback to the last snapshot, per-PR error isolation.
- **Popup, tab, full screen, wallboard mode** (hides chrome, enlarges type).

---

## Install

### Prerequisites

- Chrome / Edge / Brave **111+** (`color-mix()` in the dark theme) or Firefox
  **128+** (`optional_host_permissions`)
- Node.js **18+**, Python **3** and `rsync` — only needed to run the tests or to
  build the Firefox package
- A Bitbucket Cloud repository and a scoped API token (see
  [Authentication](#authentication)); you enter those later in the options page

### Chrome / Edge / Brave

No build step is needed.

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select this repository root (`manifest.json` must be at
   the top level). If you already ran `./scripts/package.sh`, select
   `dist/chrome` instead.
3. The options page opens automatically because nothing is configured yet.
   Enter the workspace/repository slug and token there — see
   [Configuration](#configuration).

### Firefox (128+)

Firefox does not accept `background.service_worker` in MV3, so it needs the
separate Firefox manifest. Build both packages first:

```bash
./scripts/package.sh        # writes dist/chrome and dist/firefox
```

If the script is not executable, run `chmod +x scripts/package.sh` first.

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → select `dist/firefox/manifest.json`.
3. Approve the requested host access for `api.bitbucket.org` if Firefox asks.

For a permanent install, sign the `dist/firefox` folder with
[`web-ext sign`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
(or load it as an unsigned add-on in Firefox Developer Edition / ESR with
`xpinstall.signatures.required=false`).

### Verify

```bash
node --test tests/*.test.mjs
test -f manifest.json && echo "Chrome manifest OK"
./scripts/package.sh && test -f dist/firefox/manifest.json && echo "Firefox manifest OK"
```

After editing extension code, reload it in `chrome://extensions` (or
`about:debugging`) and reload the dashboard tab.

## AI install prompt (copy & paste)

Paste this into your AI assistant to have it install and verify the extension.
It deliberately does not handle Bitbucket credentials.

```text
Install the ReviewBoard Bitbucket code-review browser extension in this repository.

Context:
- The repository root is the folder containing manifest.json (Chrome MV3) and
  manifest.firefox.json (Firefox MV3).
- Chrome needs no build step. Firefox needs ./scripts/package.sh because MV3
  service workers are not supported there.
- Node.js 18+, Python 3 and rsync are needed for tests/packaging.

Tasks:
1. Check that manifest.json and manifest.firefox.json exist. If not, stop and
   report it.
2. Run `node --test tests/*.test.mjs` and report the result. If Node is missing,
   say so and continue with the packaging check if possible.
3. Run `./scripts/package.sh` (run `chmod +x scripts/package.sh` first if it is
   not executable). Verify that dist/chrome/manifest.json and
   dist/firefox/manifest.json exist.
4. Do NOT ask for Bitbucket email, token, workspace or repository slug — I will
   enter those in the options page myself.
5. Because loading an unpacked extension requires browser UI interaction, give
   me the exact short steps for Chrome/Edge and Firefox after packaging succeeds.

Report a concise summary of commands run, verification results and the remaining
manual steps.
```

---

## Authentication

Bitbucket Cloud accepts two credential styles; the options page has a selector for both.

| Mode | Fields | Use when |
| --- | --- | --- |
| **Email + API token** (default) | Atlassian account email + API token | Normal Atlassian account. Token from <https://id.atlassian.com/manage-profile/security/api-tokens>, sent as HTTP Basic. |
| **Access token (Bearer)** | token only | Repository, workspace or OAuth access token, sent as `Authorization: Bearer …`. |

Scopes for the Atlassian API token:

- `read:pullrequest:bitbucket` — pull requests, participants, diffstat
- `read:repository:bitbucket` — repository metadata
- `read:account:bitbucket` — avatars and display names

`account:write` / `pullrequest:write` are **not** needed. Bitbucket app passwords are the
older mechanism and still work with the Basic mode if your account has one; prefer the
scoped API token.

---

## Configuration

Open the options page via the settings (gear) button on the dashboard, the extension details page, or
`chrome://extensions` → *Details* → *Extension options*.

| Field | Meaning |
| --- | --- |
| **Authentication** | Email + API token (Basic) or access token (Bearer). |
| **Atlassian account email** | Required for Basic auth. |
| **API token** | Persisted in this browser profile's `storage.local`, not `storage.sync`. Extension storage is not encrypted as a separate secret vault. |
| **Workspace / Repository slug** | `acme` + `demo`. You can paste `acme/demo` or the full URL `https://bitbucket.org/acme/demo` into either field — it is split automatically. Use the URL slug, not the display name. |
| **API base URL** | `https://api.bitbucket.org/2.0` by default. Change only for a proxy/test double; the browser then asks for host access. |
| **Refresh interval** | 15–3600 s, default 120. The dashboard honours it exactly; background alarms are clamped to ≥1 min and act only as a fallback when no dashboard tab is open. |
| **Max pull requests** | Default 25, hard cap 100. Two extra requests per shown PR (diffstat + statuses), both ETag-cached. |
| **Include drafts** | Off by default. Bitbucket marks a PR `draft: true`. |
| **Only PRs with a pending reviewer** | Hides unreviewed PRs nobody was asked to review. |
| **Treat stale approvals as unapproved** | An approval given before the head commit no longer clears the PR (Bitbucket normally resets approvals on push, so this is mostly a safety net). |
| **Ignore source branches / title keywords** | Case-insensitive, comma or newline separated. Branch matching is substring (`dependabot/`), title matching is substring too. |
| **Alerts** | Pulse and optional sound. Sound needs one click on the bell button first (browser autoplay policy). |

### Token safety

The credentials are stored in this browser profile's `storage.local` (not synchronized
through `storage.sync`). This storage is not encrypted as a separate secret vault.
ReviewBoard restricts it to trusted extension contexts where supported. Use a dedicated
read-only token, scope it to the workspace you monitor, and revoke it when the wallboard
is retired.

---

## Using the wallboard

| Action | Shortcut |
| --- | --- |
| Refresh now | `R` or the ring button |
| Pull-request view | `P` (or the *Pull Requests* tab) |
| Reviewer scoreboard | `S` (or the *Scoreboard* tab) |
| Toggle light/dark theme | `T` (or the sun/moon button) |
| Full screen | `F` (or the fullscreen button) |
| Wallboard mode (larger type, minimal chrome) | `W` (or the grid button) |
| Settings | gear button |
| Open dashboard tab | `Ctrl/Cmd+Shift+Y` |
| Leave full screen | `Esc` |

**Kiosk recipe**

1. Open the dashboard in a normal tab, press `F`, then `W`.
2. Disable the OS screen saver / sleep for that display.
3. Optional: start the browser with `--start-fullscreen --app=chrome-extension://<id>/dashboard.html`.
4. If the room monitor is logged in as a shared user, do not leave the options page open.

The toolbar popup (`dashboard.html?mode=popup`) is a compact version of the same view.

---

## What counts as "needs review"

The PR list is fetched once per refresh (`state=OPEN`, newest first, two pages worth of
`maxPullRequests`), and Bitbucket is asked to include reviewers and participants in that
single response. Then, per PR:

1. Drop drafts (unless enabled).
2. Drop excluded source branches, then excluded title keywords.
3. Collapse `participants` into review state (the PR author is ignored):
   - `state = changes_requested` → **always shown**, even if somebody else approved
   - `approved` and `participated_on` ≥ head-commit date → hidden
   - `approved` but older than the head commit → hidden by default, shown as
     *stale approval* when the option is on
   - reviewer in `reviewers` / `participants` without approval → **review requested**
   - otherwise → **needs review**
4. Drop PRs without a pending reviewer (only when that option is enabled), then apply
   *Max pull requests*.
5. Fetch diff stats (`/diffstat`, redirect followed, paginated) and build statuses
   (`/statuses`) for the remaining PRs only.

Sorting: changes requested → review requested → stale approval → needs review; within a
group failing builds first, then oldest PR first.

### Build states

| Badge | Meaning |
| --- | --- |
| `passing` | every reported status is `SUCCESSFUL` |
| `failing` | at least one `FAILED` or `STOPPED` (cancelled) build |
| `running` | at least one `INPROGRESS` build and no failure |
| `no checks` | PR has no statuses (or the token cannot read them) |

Only the newest status per `key` is counted, so superseded pipeline runs do not flip the
badge back to red. Unrecognized states are treated as running, never as passing.

### Reviewer scoreboard

The *Scoreboard* tab ranks reviewers over the last **10 days**: reviews earn points by PR size
(XS +10 … XXL +150), comments +5, created PRs +10 and merged PRs +20. The author never
gets points for their own reviews or comments. The same `Team members` filter that limits
the PR list also limits the ranking; configured members with no activity still appear
with zero points. To keep the first refresh affordable, the scoreboard inspects at most
50 recently updated PRs (10-day window, drafts and title/branch-filtered PRs excluded).

---

## Rate limits, caching and failure behaviour

- Bitbucket Cloud throttles per user/IP and answers `429` (sometimes `403`) with a
  `Retry-After` header. It publishes no quota counters, so the dashboard shows the retry
  time instead of "x of y left".
- Every response is cached with its **ETag** in `storage.local` and revalidated with
  `If-None-Match`, so unchanged PRs cost a `304` instead of a payload. A typical refresh
  is 1 repository call + 1 PR-list call + 2 conditional calls per shown PR, plus the
  bounded scoreboard lookups (recent PR list, diffstats and comments, all ETag-cached).
- Diffstats arrive via a `302` to `/diffstat/{spec}`; `fetch` follows it automatically and
  the commit hash in the target keeps the cache key honest.
- `401` → credential hint. `403` (non-throttle) → token-scope hint. `404` → workspace/slug
  hint. `429`/throttled `403` → countdown banner + automatic retry.
- On network errors the last snapshot is kept and marked stale ("Showing data from …").
- Per-PR failures (e.g. a deleted fork) degrade to `no checks` / missing diff stats
  instead of blanking the whole board.
- The cache can be cleared from the options page (this forces a fresh fetch).

---

## Project structure

```
manifest.json              Chrome/Edge MV3 manifest (service worker)
manifest.firefox.json      Firefox MV3 manifest (event page with background.scripts)
background.js              service worker: polling, ETag cache, badge, messaging
dashboard.html             wallboard markup
dashboard.css              dark TV theme, grid, wallboard/popup modes
dashboard.js               PR cards, scoreboard, countdown, alerts, keyboard shortcuts
options.html/.css/.js      settings + connection test
lib/browser-api.js         chrome/browser API shim, settings schema, storage/theme helpers
lib/bitbucket.js           REST 2.0 client, review/build triage, scoreboard, snapshot builder (unit tested)
icons/                     generated PNG icons (+ source SVG)
scripts/make-icons.py      dependency-free icon generator
scripts/package.sh         builds dist/chrome, dist/firefox and zip archives
tests/bitbucket.test.mjs   node:test suite for triage, filters, ETags, throttling
```

### Snapshot shape (storage contract)

```js
{
  fetchedAt, lastAttemptAt, lastError, configured, stale, newNumbers, suppressNewAlerts,
  skipped, warnings, rateLimit, settingsFingerprint,
  repo: { workspace, name, fullName, defaultBranch, isPrivate, openPullRequests, url },
  counts: { needingReview, changesRequested, reviewRequested, staleApprovals,
            failingChecks, pendingChecks, oldestCreatedAt },
  pullRequests: [{
    number, title, url, draft, createdAt, updatedAt, author, requestedReviewers,
    branches, diff, reasons, priority, ci, review
  }],
  scoreboard: { periodDays, since, users: [{ rank, user, level, totalScore, stats }],
                totalPoints, totalReviews, totalComments, activeContributors }
}
```

`skipped` counts `drafts`, `branches`, `titles`, `team`, `notRequested`, `approved`, `overLimit`.
The dashboard renders only this snapshot; it never talks to Bitbucket directly.

---

## Development

```bash
# unit tests (no dependencies, Node 18+)
node --test tests/*.test.mjs

# syntax check
for f in background.js dashboard.js options.js lib/*.js; do node --check "$f"; done

# regenerate icons (pure Python, no Pillow)
python3 scripts/make-icons.py

# build packages
./scripts/package.sh
```

After editing extension code, reload it in `chrome://extensions` (or `about:debugging`)
and reload the dashboard tab.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Banner "Wallboard not configured" | Add email + token, workspace and repository slug in the options page. |
| `401` / "credentials rejected" | Recreate the API token; check the email matches the token owner and the scopes listed above. |
| `403` / "access denied" | Token lacks `read:pullrequest:bitbucket` / `read:repository:bitbucket` for that workspace. |
| `404` on a private repo | Use the URL slug (`demo`, lowercase), not the display name; check the token can see the repository. |
| Rate limit banner | Wait for the retry time, lower *Max pull requests*, or raise the refresh interval. |
| Every build badge says "no checks" | The PR has no reported statuses yet, or the token lacks pull request read access. |
| Dashboard shows "Not configured" after saving | Reload the extension; the background worker may have been mid-update. |
| Firefox cannot fetch | Grant host access for `api.bitbucket.org` in the add-on permissions. |
| Countdown looks frozen on a background tab | Browsers throttle hidden tabs; the tab refreshes on focus. Keep the wallboard visible/full screen. |
| Sound does not play | Click the bell button once to satisfy the autoplay policy, and enable *Play a short sound* in the options. |

---

## Security & privacy

- No telemetry, no analytics, no proxy. Requests go straight from the browser to
  `api.bitbucket.org`.
- The only remote images are Bitbucket avatar/gravatar URLs
  (`bitbucket.org`, `*.atl-paas.net`, `*.gravatar.com`), explicitly allow-listed in the
  extension CSP.
- The dashboard never injects raw API data as HTML — all strings are escaped and URLs
  are restricted to `http(s)`.

## Privacy & license

- [Privacy Policy](PRIVACY.md) — what the extension stores and which requests
  it sends (only to `api.bitbucket.org`). Use the URL below in the Mozilla
  Add-ons submission form.
- MIT — see [LICENSE](LICENSE).
