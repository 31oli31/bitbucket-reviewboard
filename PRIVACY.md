# Privacy Policy — ReviewBoard

**Last updated: 2026-11-17**

ReviewBoard is a local browser extension that shows open Bitbucket Cloud pull
requests on a wallboard. The developer operates no servers, collects no
analytics, and receives no data from you.

## What the extension stores

- **Bitbucket email, API token, workspace and repository slug** — entered by
  you in the options page and stored only in your browser's
  `chrome.storage.local`. The storage area is restricted to trusted extension
  contexts. You can remove everything at any time with the **Clear** button in
  the options page.
- **Display preferences** (theme, filters, refresh interval) — stored locally.

## What the extension transmits

The extension sends requests **directly from your browser to
`api.bitbucket.org`**, using the token you provided, to read pull requests,
reviewers and build statuses. This is the add-on's primary function. No data
is sent to the developer or to any other third party. Responses are cached in
memory only (ETag-based) and are not persisted.

## Permissions

- `storage` — to keep your settings locally.
- `alarms` — for the auto-refresh timer.
- `host_permissions` for `https://api.bitbucket.org/*` — required to read pull
  requests.
- `optional_host_permissions` for `https://*/*` — only used for a self-hosted
  Bitbucket API if you configure one.

## Third-party components

None. The extension is plain HTML/CSS/JS with no bundled libraries and no
external network resources beyond the configured Bitbucket API.

## Contact

Questions about this policy can be opened as an issue in the
[GitHub repository](https://github.com/31oli31/bitbucket-reviewboard).
