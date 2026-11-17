/*
 * Unit tests for the Bitbucket triage logic. No browser required:
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/bitbucket.js', import.meta.url), 'utf8');
vm.runInThisContext(source);
const BB = globalThis.PRBitbucket;

const sharedSource = fs.readFileSync(new URL('../lib/browser-api.js', import.meta.url), 'utf8');
const sandbox = {
  console,
  chrome: {
    runtime: { id: 'test-extension' },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(sharedSource, sandbox);
const SHARED = sandbox.PRShared;

const SETTINGS = {
  authMode: 'basic',
  username: 'dev@example.com',
  token: 'test-token',
  workspace: 'acme',
  repoSlug: 'demo',
  apiBaseUrl: 'https://api.bitbucket.org/2.0',
  refreshSeconds: 60,
  maxPullRequests: 25,
};

const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

function account(name, id) {
  const uuid = `{${String(id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}}`;
  return {
    type: 'user',
    display_name: name,
    nickname: name,
    uuid,
    account_id: `acc-${uuid}`,
    links: {
      avatar: { href: `https://bitbucket.org/account/user/${encodeURIComponent(uuid)}/avatar/32/` },
      html: { href: `https://bitbucket.org/${encodeURIComponent(uuid)}/` },
    },
  };
}

function participant(name, options) {
  const opts = options || {};
  return {
    type: 'participant',
    user: account(name, opts.id),
    role: opts.role || 'REVIEWER',
    approved: Boolean(opts.approved),
    state: opts.state === undefined ? null : opts.state,
    participated_on: opts.participated_on || null,
  };
}

function pr(overrides) {
  const base = {
    id: 1,
    title: 'Improve wallboard',
    state: 'OPEN',
    draft: false,
    created_on: iso(-2 * 3600 * 1000),
    updated_on: iso(-60 * 1000),
    author: account('Alice Author', 'alice'),
    reviewers: [account('Rita Reviewer', 'rita')],
    participants: [
      participant('Alice Author', { id: 'alice', role: 'AUTHOR' }),
      participant('Rita Reviewer', { id: 'rita' }),
    ],
    source: {
      branch: { name: 'feature/x' },
      commit: { hash: 'sha-1', date: iso(-2 * 3600 * 1000) },
      repository: { full_name: 'acme/demo' },
    },
    destination: {
      branch: { name: 'main' },
      repository: { full_name: 'acme/demo' },
    },
    comment_count: 3,
    task_count: 0,
    links: { html: { href: 'https://bitbucket.org/acme/demo/pull-requests/1' } },
  };
  return Object.assign(base, overrides || {});
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, init.headers || {}),
  });
}

function createFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: Object.assign({}, init.headers) });
    if (init.headers && init.headers['If-None-Match']) {
      const cached = routes.find((route) => route.etag && route.etag === init.headers['If-None-Match']);
      if (cached && cached.conditional) return cached.conditional();
    }
    const parsed = new URL(url);
    const key = parsed.pathname + parsed.search;
    const route = routes.find((entry) => (entry.match instanceof RegExp ? entry.match.test(key) : entry.match === key));
    if (!route) return json({ error: { message: `no route for ${key}` } }, { status: 404 });
    return typeof route.response === 'function' ? route.response(parsed) : route.response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/* ------------------------------------------------------------------ */
/* Build statuses                                                         */
/* ------------------------------------------------------------------ */

test('summarizeStatuses maps states and keeps the newest entry per key', () => {
  const summary = BB.summarizeStatuses({
    values: [
      { key: 'build', name: 'build #3', state: 'FAILED', url: 'https://ci/3', created_on: iso(-300000) },
      { key: 'build', name: 'build #4', state: 'SUCCESSFUL', created_on: iso(-60000) },
      { key: 'e2e', name: 'e2e #1', state: 'INPROGRESS', created_on: iso(-30000) },
      { key: 'lint', name: 'lint #1', state: 'SUCCESSFUL', created_on: iso(-40000) },
    ],
  });

  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 2);
  assert.equal(summary.pending, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.state, 'pending');
  assert.equal(summary.source, 'statuses');
});

test('summarizeStatuses treats a stopped build as not passing', () => {
  const summary = BB.summarizeStatuses({
    values: [{ key: 'deploy', name: 'deploy', state: 'STOPPED', url: 'https://ci/deploy' }],
  });

  assert.equal(summary.state, 'failing');
  assert.equal(summary.failed, 1);
  assert.equal(summary.stopped, 1);
  assert.equal(summary.failedName, 'deploy');
  assert.equal(summary.failedUrl, 'https://ci/deploy');
});

test('summarizeStatuses reports unknown when nothing reported', () => {
  const summary = BB.summarizeStatuses({ values: [] });
  assert.equal(summary.state, 'unknown');
  assert.equal(summary.total, 0);
  assert.equal(summary.source, 'none');
});

test('summarizeStatuses never treats an unrecognized state as passing', () => {
  const summary = BB.summarizeStatuses({
    values: [
      { key: 'custom', name: 'custom', state: 'MYSTERY' },
      { key: 'skipped', name: 'skipped', state: 'SKIPPED' },
    ],
  });
  assert.equal(summary.state, 'pending');
  assert.equal(summary.pending, 1);
  assert.equal(summary.passed, 1);
});

/* ------------------------------------------------------------------ */
/* Review state                                                           */
/* ------------------------------------------------------------------ */

test('summarizeReviews separates approvals, change requests and pending reviewers', () => {
  const summary = BB.summarizeReviews(
    pr({
      reviewers: [account('Rita Reviewer', 'rita'), account('Sam Pending', 'sam')],
      participants: [
        participant('Alice Author', { id: 'alice', role: 'AUTHOR' }),
        participant('Bob Approver', { id: 'bob', approved: true, state: 'approved', participated_on: iso(-3600000) }),
        participant('Cara Critic', {
          id: 'cara',
          state: 'changes_requested',
          participated_on: iso(-1800000),
        }),
        participant('Rita Reviewer', { id: 'rita' }),
        participant('Sam Pending', { id: 'sam' }),
      ],
    }),
  );

  assert.deepEqual(summary.approvals.map((entry) => entry.login), ['Bob Approver']);
  assert.deepEqual(summary.changesRequested.map((entry) => entry.login), ['Cara Critic']);
  assert.deepEqual(summary.pendingReviewers.map((entry) => entry.login), ['Rita Reviewer', 'Sam Pending']);
  assert.equal(summary.hasApproval, true);
  assert.equal(summary.hasChangesRequested, true);
});

test('an approval older than the head commit is stale', () => {
  const summary = BB.summarizeReviews(
    pr({
      source: { branch: { name: 'feature/x' }, commit: { hash: 'sha-2', date: iso(-3600000) } },
      reviewers: [account('Bob Approver', 'bob')],
      participants: [
        participant('Bob Approver', { id: 'bob', approved: true, state: 'approved', participated_on: iso(-7200000) }),
      ],
    }),
  );

  assert.equal(summary.approvals.length, 0);
  assert.equal(summary.staleApprovals.length, 1);
  assert.equal(summary.hasApproval, false);
  assert.equal(summary.hasStaleApproval, true);
});

test('the author never counts as an approver', () => {
  const summary = BB.summarizeReviews(
    pr({
      author: account('Alice Author', 'alice'),
      reviewers: [],
      participants: [participant('Alice Author', { id: 'alice', role: 'AUTHOR', approved: true, state: 'approved' })],
    }),
  );

  assert.equal(summary.approvals.length, 0);
  assert.equal(summary.pendingReviewers.length, 0);
});

test('evaluatePullRequest drops approved PRs and keeps change requests', () => {
  const approved = pr({
    reviewers: [],
    participants: [
      participant('Bob Approver', { id: 'bob', approved: true, state: 'approved', participated_on: iso(-60000) }),
    ],
  });
  assert.equal(BB.evaluatePullRequest(approved).keep, false);

  const changes = pr({
    participants: [
      participant('Cara Critic', { id: 'cara', state: 'changes_requested', participated_on: iso(-60000) }),
    ],
  });
  const evaluation = BB.evaluatePullRequest(changes);
  assert.equal(evaluation.keep, true);
  assert.equal(evaluation.state, 'changes_requested');
});

test('stale approvals only resurface with the opt-in', () => {
  const stale = pr({
    source: { branch: { name: 'feature/x' }, commit: { hash: 'sha-2', date: iso(-3600000) } },
    reviewers: [],
    participants: [
      participant('Bob Approver', { id: 'bob', approved: true, state: 'approved', participated_on: iso(-7200000) }),
    ],
  });

  assert.equal(BB.evaluatePullRequest(stale).keep, false);
  assert.equal(BB.evaluatePullRequest(stale, { treatStaleApprovalsAsUnapproved: true }).state, 'stale_approval');
});

test('a PR without reviewers needs a review', () => {
  const evaluation = BB.evaluatePullRequest(pr({ reviewers: [], participants: [] }));
  assert.equal(evaluation.keep, true);
  assert.equal(evaluation.state, 'needs_review');
  assert.equal(evaluation.reviewRequested, false);
});

/* ---------------------------------------------------------------------- */
/* Filters                                                                */
/* ---------------------------------------------------------------------- */

test('branch and title filters are case-insensitive and support wildcards', () => {
  assert.equal(BB.matchesExcludedBranch('dependabot/npm/lodash', ['dependabot/']), true);
  assert.equal(BB.matchesExcludedBranch('ABC-1-wip-cleanup', ['dependabot/', 'wip/']), false);
  assert.equal(BB.matchesExcludedBranch('WIP/test', ['wip/']), true);
  assert.equal(BB.matchesExcludedBranch('feature/wip-123', ['*wip*']), true);
  assert.equal(BB.matchesExcludedTitle('WIP: something', ['wip']), true);
  assert.equal(BB.matchesExcludedTitle('[WIP] spike', ['[wip]*']), true);
  assert.equal(BB.matchesExcludedTitle('Do Not Merge — spike', ['do not merge']), true);
  assert.equal(BB.matchesExcludedTitle('Feature', ['wip']), false);
});

test('matchesTeamMember identifies team members flexibly and rejects non-team members/bots', () => {
  const team = [
    'jane.doe',
    'john.smith',
    'sara.connor',
    'l.mueller',
    'lena.müller',
    'miles.example',
    'Lena Müller',
    'l.mueller@example.com',
    'felix.example',
    'Lena M\u00fcller',
  ];

  // Configured team members (all variants of Lena, Jane, John, Sara, Miles, Felix)
  assert.equal(BB.matchesTeamMember({ display_name: 'Jane Doe', nickname: 'jane.doe' }, team), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'Lena Müller', nickname: 'lena.mueller' }, team), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'Lena Müller' }, team), true);
  assert.equal(BB.matchesTeamMember({ displayName: 'Lena Müller', accountId: '712020:8503d18a' }, team), true);
  assert.equal(BB.matchesTeamMember({ login: 'Lena Müller' }, team), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'Lena Mueller' }, team), true);
  assert.equal(BB.matchesTeamMember({ nickname: 'l.mueller' }, team), true);
  assert.equal(BB.matchesTeamMember({ username: 'l.mueller' }, team), true);
  assert.equal(BB.matchesTeamMember({ email: 'l.mueller@example.com' }, team), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'Felix Example', nickname: 'felix.example' }, team), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'Miles Example', nickname: 'miles.example' }, team), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'John Smith', nickname: 'john.smith' }, team), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'Sara Connor', nickname: 'sara.connor' }, team), true);

  // Even if config only has "l.mueller", it must match full name "Lena Müller"
  assert.equal(BB.matchesTeamMember({ display_name: 'Lena Müller' }, ['l.mueller']), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'Lena Müller' }, ['lena.müller']), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'Lena Müller' }, ['l.mueller@example.com']), true);

  // prMatchesTeam with a Jira-style issue assignee
  const prWithJira = {
    id: 7423,
    author: { display_name: 'Other Dev' },
    participants: [],
    reviewers: [],
    issue: {
      key: 'ABC-2370',
      assignee: { displayName: 'Lena Müller', accountId: '712020:8503d18a' },
    },
  };
  assert.equal(BB.prMatchesTeam(prWithJira, team), true);

  // Bots and non-team members must NOT match
  assert.equal(BB.matchesTeamMember({ display_name: 'AI Code Review - Jenkins', nickname: 'aicode' }, team), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'Release Bot (API)', nickname: 'releasebot' }, team), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'Another Person', nickname: 'another.person' }, team), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'Some One', nickname: 'some.one' }, team), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'Michael Example', nickname: 'michael.example' }, team), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'Christian Example', nickname: 'christian.example' }, team), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'Stranger Danger', nickname: 'stranger' }, team), false);

  // Empty team matches all
  assert.equal(BB.matchesTeamMember({ display_name: 'AI Code Review - Jenkins' }, []), true);
});

test('matchesTeamMember works when team is configured with email addresses only', () => {
  const emailTeam = ['l.mueller@example.com', 'john.smith@example.com'];

  // Matches Lena in all forms
  assert.equal(BB.matchesTeamMember({ display_name: 'Lena Müller' }, emailTeam), true);
  assert.equal(BB.matchesTeamMember({ display_name: 'Lena Mueller' }, emailTeam), true);
  assert.equal(BB.matchesTeamMember({ nickname: 'l.mueller' }, emailTeam), true);
  assert.equal(BB.matchesTeamMember({ email: 'l.mueller@example.com' }, emailTeam), true);
  assert.equal(BB.matchesTeamMember({ raw: 'Lena Müller <l.mueller@example.com>' }, emailTeam), true);
  assert.equal(BB.matchesTeamMember({ displayName: 'Lena Müller' }, emailTeam), true);

  // Matches John in all forms
  assert.equal(BB.matchesTeamMember({ display_name: 'John Smith' }, emailTeam), true);
  assert.equal(BB.matchesTeamMember({ nickname: 'john.smith' }, emailTeam), true);
  assert.equal(BB.matchesTeamMember({ email: 'john.smith@example.com' }, emailTeam), true);
  assert.equal(BB.matchesTeamMember({ raw: 'John Smith <john.smith@example.com>' }, emailTeam), true);

  // Non-configured members and bots do NOT match
  assert.equal(BB.matchesTeamMember({ display_name: 'Jane Doe', nickname: 'jane.doe' }, emailTeam), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'Miles Example', nickname: 'miles.example' }, emailTeam), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'AI Code Review - Jenkins' }, emailTeam), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'Release Bot (API)' }, emailTeam), false);
  assert.equal(BB.matchesTeamMember({ display_name: 'Another Person' }, emailTeam), false);
});

test('matchesIncludedBranch filters branches by prefix/pattern and wildcards like ABC-*', () => {
  assert.equal(BB.matchesIncludedBranch('feature/ABC-123-checkout', ['ABC-']), true);
  assert.equal(BB.matchesIncludedBranch('feature/ABC-7762-fix', ['ABC-*']), true);
  assert.equal(BB.matchesIncludedBranch('ABC-7762', ['ABC-*']), true);
  assert.equal(BB.matchesIncludedBranch('abc-fixes', ['ABC-']), true);
  assert.equal(BB.matchesIncludedBranch('feature/OTHER-999', ['ABC-']), false);
  assert.equal(BB.matchesIncludedBranch('feature/OTHER-999', ['ABC-*']), false);
  assert.equal(BB.matchesIncludedBranch('feature/OTHER-999', []), true);
});

/* ---------------------------------------------------------------------- */
/* End-to-end snapshot                                                    */
/* ---------------------------------------------------------------------- */

function wallboardRoutes() {
  return [
    {
      match: /\/repositories\/acme\/demo$/,
      response: () =>
        json({
          full_name: 'acme/demo',
          is_private: true,
          mainbranch: { name: 'main' },
          links: { html: { href: 'https://bitbucket.org/acme/demo' } },
        }),
    },
    {
      match: /\/pullrequests\?/,
      response: () =>
        json({
          size: 7,
          values: [
            pr({
              id: 1,
              title: 'Already approved',
              reviewers: [],
              participants: [
                participant('Bob Approver', { id: 'bob', approved: true, state: 'approved', participated_on: iso(-60000) }),
              ],
            }),
            pr({
              id: 2,
              title: 'Changes requested',
              created_on: iso(-10 * 3600 * 1000),
              reviewers: [],
              participants: [
                participant('Cara Critic', { id: 'cara', state: 'changes_requested', participated_on: iso(-60000) }),
              ],
            }),
            pr({ id: 3, title: 'Draft work', draft: true }),
            pr({
              id: 4,
              title: 'Bump dependency',
              source: {
                branch: { name: 'dependabot/npm/lodash' },
                commit: { hash: 'sha-4', date: iso(-3600000) },
                repository: { full_name: 'acme/demo' },
              },
            }),
            pr({
              id: 5,
              title: 'Review requested with red builds',
              created_on: iso(-30 * 60 * 1000),
              reviewers: [account('Rita Reviewer', 'rita'), account('Sam Pending', 'sam')],
              participants: [participant('Rita Reviewer', { id: 'rita' }), participant('Sam Pending', { id: 'sam' })],
              source: {
                branch: { name: 'feature/payments' },
                commit: { hash: 'sha-5', date: iso(-1800000) },
                repository: { full_name: 'acme/demo' },
              },
            }),
            pr({
              id: 6,
              title: 'Nobody was asked',
              created_on: iso(-48 * 3600 * 1000),
              reviewers: [],
              participants: [],
              source: {
                branch: { name: 'feature/legacy' },
                commit: { hash: 'sha-6', date: iso(-48 * 3600 * 1000) },
                repository: { full_name: 'acme/demo' },
              },
            }),
            pr({
              id: 7762,
              title: 'ABC feature branch PR opened 45 days ago',
              created_on: iso(-45 * 24 * 3600 * 1000), // 45 days old — must still show in PR list!
              reviewers: [],
              participants: [],
              source: {
                branch: { name: 'feature/ABC-7762-overview' },
                commit: { hash: 'sha-7762', date: iso(-45 * 24 * 3600 * 1000) },
                repository: { full_name: 'acme/demo' },
              },
            }),
          ],
        }),
    },
    {
      match: /\/pullrequests\/2\/diffstat/,
      response: () =>
        json({
          size: 2,
          values: [
            { lines_added: 10, lines_removed: 4 },
            { lines_added: 5, lines_removed: 1 },
          ],
        }),
    },
    {
      match: /page=2/,
      response: () => json({ size: 3, values: [{ lines_added: 15, lines_removed: 2 }] }),
    },
    {
      match: /\/pullrequests\/5\/diffstat/,
      response: () =>
        json({
          size: 3,
          next: 'https://api.bitbucket.org/2.0/repositories/acme/demo/pullrequests/5/diffstat?page=2',
          values: [{ lines_added: 20, lines_removed: 10 }],
        }),
    },
    { match: /\/pullrequests\/\d+\/diffstat/, response: () => json({ size: 1, values: [{ lines_added: 1, lines_removed: 1 }] }) },
    {
      match: /\/pullrequests\/5\/statuses/,
      response: () =>
        json({
          values: [
            { key: 'build', name: 'build #4', state: 'FAILED', url: 'https://ci/build/4' },
            { key: 'lint', name: 'lint #1', state: 'SUCCESSFUL' },
          ],
        }),
    },
    { match: /\/pullrequests\/\d+\/statuses/, response: () => json({ values: [] }) },
  ];
}

test('fetchWallboard filters, scores and enriches pull requests (including old PRs not limited by 10 days)', async () => {
  const fetchImpl = createFetch(wallboardRoutes());
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });
  const snapshot = await client.fetchWallboard({
    maxPullRequests: 25,
    includeDrafts: false,
    onlyRequestedReviewers: false,
    treatStaleApprovalsAsUnapproved: false,
    excludeSourceBranches: ['dependabot/'],
    excludeTitlePatterns: ['wip'],
  });

  assert.deepEqual(snapshot.pullRequests.map((card) => card.number), [2, 5, 7762, 6]);
  assert.equal(snapshot.skipped.approved, 1);
  assert.equal(snapshot.skipped.drafts, 1);
  assert.equal(snapshot.skipped.branches, 1);
  assert.equal(snapshot.counts.needingReview, 4);
  assert.equal(snapshot.counts.changesRequested, 1);
  assert.equal(snapshot.counts.reviewRequested, 1);
  assert.equal(snapshot.counts.failingChecks, 1);

  const [changes, requested, oldPr, plain] = snapshot.pullRequests;

  assert.equal(changes.review.state, 'changes_requested');
  assert.equal(changes.diff.additions, 15);
  assert.equal(changes.diff.deletions, 5);

  assert.equal(requested.review.state, 'review_requested');
  assert.equal(requested.diff.additions, 35);
  assert.equal(requested.diff.deletions, 12);
  assert.equal(requested.diff.changedFiles, 3);
  assert.equal(requested.ci.state, 'failing');
  assert.equal(requested.ci.failedName, 'build #4');
  assert.equal(requested.requestedReviewers.length, 2);
  assert.equal(requested.branches.base, 'main');
  assert.equal(requested.branches.head, 'feature/payments');

  // PR 7762 is 45 days old and is properly kept because 10 days rule only applies to Scoreboard!
  assert.equal(oldPr.number, 7762);
  assert.equal(oldPr.review.state, 'needs_review');

  assert.equal(plain.review.state, 'needs_review');
  assert.equal(plain.ci.state, 'unknown');

  assert.equal(snapshot.repo.fullName, 'acme/demo');
  assert.equal(snapshot.repo.isPrivate, true);
  assert.equal(snapshot.repo.defaultBranch, 'main');
  assert.equal(snapshot.repo.openPullRequests, 7);
});

test('fetchWallboard filters by includeSourceBranches and teamMembers', async () => {
  const fetchImpl = createFetch(wallboardRoutes());
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });

  const branchFiltered = await client.fetchWallboard({
    includeSourceBranches: ['ABC-*'],
  });
  assert.deepEqual(branchFiltered.pullRequests.map((card) => card.number), [7762]);

  const teamFiltered = await client.fetchWallboard({
    teamMembers: ['cara'],
  });
  assert.deepEqual(teamFiltered.pullRequests.map((card) => card.number), [2]);
});

test('fetchWallboard scoreboard includes all configured team members like jane.doe and lena.müller', async () => {
  const fetchImpl = createFetch(wallboardRoutes());
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });

  const snapshot = await client.fetchWallboard({
    teamMembers: ['jane.doe', 'lena.müller', 'john.smith', 'sara.connor', 'miles.example'],
  });

  const rankedNames = snapshot.scoreboard.users.map((u) => u.user.login);
  assert.ok(rankedNames.some((name) => name.toLowerCase().includes('jane')));
  assert.ok(rankedNames.some((name) => name.toLowerCase().includes('lena')));
  assert.ok(rankedNames.some((name) => name.toLowerCase().includes('john')));
  assert.ok(rankedNames.some((name) => name.toLowerCase().includes('sara')));
  assert.ok(rankedNames.some((name) => name.toLowerCase().includes('miles')));
  assert.equal(snapshot.scoreboard.users.length, 5);
});

test('onlyRequestedReviewers hides PRs without a pending reviewer', async () => {
  const fetchImpl = createFetch(wallboardRoutes());
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });
  const snapshot = await client.fetchWallboard({
    onlyRequestedReviewers: true,
    excludeSourceBranches: [],
    excludeTitlePatterns: [],
  });

  assert.deepEqual(snapshot.pullRequests.map((card) => card.number), [5, 4]);
  assert.equal(snapshot.skipped.notRequested, 3);
});

test('maxPullRequests caps the shown cards', async () => {
  const fetchImpl = createFetch(wallboardRoutes());
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });
  const snapshot = await client.fetchWallboard({
    maxPullRequests: 1,
    excludeSourceBranches: ['dependabot/'],
    excludeTitlePatterns: [],
  });

  assert.deepEqual(snapshot.pullRequests.map((card) => card.number), [2]);
  assert.equal(snapshot.skipped.overLimit, 3);
});

/* ------------------------------------------------------------------ */
/* HTTP behaviour                                                         */
/* ------------------------------------------------------------------ */

test('authorization header supports basic and bearer modes', () => {
  assert.equal(
    BB.authorizationHeader({ authMode: 'basic', username: 'dev@example.com', token: 'secret' }),
    'Basic ZGV2QGV4YW1wbGUuY29tOnNlY3JldA==',
  );
  assert.equal(BB.authorizationHeader({ authMode: 'bearer', token: 'secret' }), 'Bearer secret');
  assert.equal(BB.authorizationHeader({ authMode: 'basic', username: '', token: '' }), '');
});

test('ETag responses are reused without extra payloads', async () => {
  let hits = 0;
  const fetchImpl = async (url, init) => {
    hits += 1;
    if (init.headers['If-None-Match'] === '"etag-1"') {
      return new Response(null, { status: 304, headers: { etag: '"etag-1"' } });
    }
    return json({ full_name: 'acme/demo' }, { headers: { etag: '"etag-1"' } });
  };

  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });
  const first = await client.getRepository();
  const second = await client.getRepository();

  assert.equal(first.full_name, 'acme/demo');
  assert.equal(second.full_name, 'acme/demo');
  assert.equal(hits, 2);
  assert.equal(client.stats.cacheHits, 1);
});

test('429 responses become retryable rate-limit errors', async () => {
  const fetchImpl = async () =>
    json({ type: 'error', error: { message: 'Rate limit for this resource has been exceeded' } }, {
      status: 429,
      headers: { 'retry-after': '120' },
    });

  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });
  const before = Date.now();
  await assert.rejects(
    () => client.getRepository(),
    (error) => error.kind === 'rate_limit' && error.retryAt - before > 100000,
  );
});

test('403 with a rate-limit message is treated as throttling', async () => {
  const fetchImpl = async () => json({ error: { message: 'Too many requests' } }, { status: 403 });
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });

  await assert.rejects(() => client.getRepository(), (error) => error.kind === 'rate_limit');
});

test('403 without a rate-limit message is a scope problem', async () => {
  const fetchImpl = async () =>
    json({ error: { message: 'Your credentials lack the required scopes' } }, { status: 403 });
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });

  await assert.rejects(
    () => client.getRepository(),
    (error) => error.kind === 'forbidden' && error.status === 403,
  );
});

test('401 responses surface an auth error', async () => {
  const fetchImpl = async () => json({ error: { message: 'Bad credentials' } }, { status: 401 });
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });

  await assert.rejects(() => client.getRepository(), (error) => error.kind === 'auth' && error.status === 401);
});

test('404 responses surface a not-found error that names the slug', async () => {
  const fetchImpl = async () => json({ error: { message: 'Repository not found' } }, { status: 404 });
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });

  await assert.rejects(
    () => client.getRepository(),
    (error) => error.kind === 'not_found' && error.message.includes('acme/demo'),
  );
});

test('comments are loaded across pages with one cache key per PR version', async () => {
  const paths = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname + parsed.search);
    if (!parsed.searchParams.get('page')) {
      return json({
        values: [{ id: 1 }],
        next: 'https://api.bitbucket.org/2.0/repositories/acme/demo/pullrequests/1/comments?page=2',
      });
    }
    return json({ values: [{ id: 2 }] });
  };
  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });
  const comments = await client.getPullRequestComments(1, '2026-01-01');

  assert.equal(comments.length, 2);
  assert.equal(paths.length, 2);
});

test('the scoreboard does not reward authors for their own comments', async () => {
  const routes = [
    { match: /\/repositories\/acme\/demo$/, response: () => json({ full_name: 'acme/demo' }) },
    {
      match: /\/pullrequests\?/,
      response: () =>
        json({
          size: 1,
          values: [pr({ id: 1, comment_count: 1, reviewers: [], participants: [] })],
        }),
    },
    {
      match: /\/pullrequests\/1\/comments/,
      response: () =>
        json({
          values: [{ id: 10, created_on: iso(-3600000), user: account('Alice Author', 'alice') }],
        }),
    },
    { match: /\/pullrequests\/\d+\/diffstat/, response: () => json({ size: 0, values: [] }) },
    { match: /\/pullrequests\/\d+\/statuses/, response: () => json({ values: [] }) },
  ];
  const client = BB.createClient(SETTINGS, { fetch: createFetch(routes), cache: BB.createMemoryCache() });
  const snapshot = await client.fetchWallboard({});

  const alice = snapshot.scoreboard.users.find((user) => user.user.login === 'Alice Author');
  assert.ok(alice);
  assert.equal(alice.stats.commentsCount, 0);
  assert.equal(alice.pointsBreakdown.comments, 0);
});

test('network failures fall back to the cached payload', async () => {
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error('offline');
    return json({ full_name: 'acme/demo' }, { headers: { etag: '"etag-offline"' } });
  };

  const client = BB.createClient(SETTINGS, { fetch: fetchImpl, cache: BB.createMemoryCache() });
  await client.getRepository();
  fail = true;
  const cached = await client.getRepository();

  assert.equal(cached.full_name, 'acme/demo');
  assert.equal(client.stats.networkErrors, 1);
});

/* ------------------------------------------------------------------ */
/* Settings                                                               */
/* ------------------------------------------------------------------ */

test('settings accept a pasted Bitbucket URL', () => {
  const settings = SHARED.normalizeSettings({
    workspace: 'https://bitbucket.org/acme/demo',
    repoSlug: '',
    token: 'token',
    username: 'dev@example.com',
  });

  assert.equal(settings.workspace, 'acme');
  assert.equal(settings.repoSlug, 'demo');
  assert.equal(SHARED.isConfigured(settings), true);
  assert.equal(settings.apiBaseUrl, 'https://api.bitbucket.org/2.0');
  assert.equal(settings.authMode, 'basic');
});

test('settings accept a URL or workspace/repo pair in the repository field', () => {
  for (const repoSlug of ['https://bitbucket.org/acme/demo', 'acme/demo']) {
    const settings = SHARED.normalizeSettings({
      workspace: '',
      repoSlug,
      token: 't',
      username: 'dev@example.com',
    });
    assert.equal(settings.workspace, 'acme');
    assert.equal(settings.repoSlug, 'demo');
  }
});

test('settings split a workspace/repo pair and keep bearer mode', () => {
  const settings = SHARED.normalizeSettings({ workspace: 'acme/demo', authMode: 'bearer', token: 't' });

  assert.equal(settings.workspace, 'acme');
  assert.equal(settings.repoSlug, 'demo');
  assert.equal(settings.authMode, 'bearer');
  assert.equal(SHARED.isConfigured(settings), true);
});

test('basic auth without an email is not configured', () => {
  const settings = SHARED.normalizeSettings({ workspace: 'acme', repoSlug: 'demo', token: 't', username: '' });
  assert.equal(SHARED.isConfigured(settings), false);
});
