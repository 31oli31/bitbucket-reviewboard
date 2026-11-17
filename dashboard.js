/*
 * ReviewBoard — dashboard controller.
 *
 * The dashboard owns the visible countdown and asks the background worker for
 * fresh data. Snapshots are also pushed via storage, so several wallboards
 * (tab + second monitor) stay in sync without extra API traffic.
 */
/* global PRShared */
(function () {
  'use strict';

  const { api, DEFAULTS } = PRShared;
  const RING_CIRCUMFERENCE = 119.38;
  const isPopup = new URLSearchParams(location.search).get('mode') === 'popup';

  const el = {
    banner: document.getElementById('banner'),
    countdown: document.getElementById('countdown'),
    empty: document.getElementById('empty'),
    fullscreenToggle: document.getElementById('fullscreen-toggle'),
    grid: document.getElementById('grid'),
    liveDot: document.getElementById('live-dot'),
    openTab: document.getElementById('open-tab'),
    progressValue: document.getElementById('progress-value'),
    quota: document.getElementById('quota'),
    refresh: document.getElementById('refresh'),
    repoMeta: document.getElementById('repo-meta'),
    repoName: document.getElementById('repo-name'),
    ringProgress: document.getElementById('ring-progress'),
    scoreboardView: document.getElementById('scoreboard-view'),
    soundToggle: document.getElementById('sound-toggle'),
    stats: document.getElementById('stats'),
    statusLine: document.getElementById('status-line'),
    tabPrCount: document.getElementById('tab-pr-count'),
    tabPrs: document.getElementById('tab-prs'),
    tabScoreboard: document.getElementById('tab-scoreboard'),
    themeToggle: document.getElementById('theme-toggle'),
    updated: document.getElementById('updated'),
    wallboardToggle: document.getElementById('wallboard-toggle'),
  };

  const state = {
    appliedKey: '',
    audio: null,
    countdownEnd: 0,
    countdownTotal: 60,
    currentView: 'prs', // 'prs' | 'scoreboard'
    hasLive: false,
    initialized: false,
    newNumbers: new Set(),
    refreshing: false,
    settings: null,
    snapshot: null,
    ticker: null,
    titleTimer: null,
    transportError: null,
  };

  if (isPopup) document.body.classList.add('mode-popup');

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                      */
  /* ------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function safeUrl(value, httpsOnly) {
    try {
      const url = new URL(String(value));
      if (url.protocol === 'https:') return url.href;
      if (!httpsOnly && url.protocol === 'http:') return url.href;
    } catch (error) {
      /* fall through */
    }
    return '';
  }

  function formatClock(timestamp) {
    if (!timestamp) return '—';
    try {
      return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (error) {
      return '—';
    }
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return '—';
    try {
      return new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    } catch (error) {
      return '—';
    }
  }

  function ageInfo(createdAt) {
    const elapsed = Math.max(0, Date.now() - createdAt);
    const minutes = Math.floor(elapsed / 60000);
    let text;

    if (!Number.isFinite(createdAt) || createdAt <= 0) {
      text = 'unknown age';
    } else if (minutes < 1) {
      text = 'just now';
    } else if (minutes < 60) {
      text = `${minutes}m ago`;
    } else {
      const hours = Math.floor(minutes / 60);
      if (hours < 48) {
        text = `${hours}h ${minutes % 60}m ago`;
      } else {
        text = `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
      }
    }

    const level =
      elapsed < 4 * 3600 * 1000
        ? 'fresh'
        : elapsed < 24 * 3600 * 1000
          ? 'notice'
          : elapsed < 72 * 3600 * 1000
            ? 'warn'
            : 'critical';

    return { level, text };
  }

  function avatar(user, extraClass) {
    const src = safeUrl(user && user.avatarUrl, true);
    if (!src) return '';
    const title = user && user.login ? ` title="@${escapeHtml(user.login)}"` : '';
    const alt = user && user.login ? ` alt="@${escapeHtml(user.login)}"` : ' alt=""';
    return `<img class="avatar ${extraClass || ''}" src="${escapeHtml(src)}"${alt}${title} loading="lazy" decoding="async" referrerpolicy="no-referrer" width="28" height="28" />`;
  }

  function stateLabel(reviewState) {
    switch (reviewState) {
      case 'changes_requested':
        return 'changes requested';
      case 'stale_approval':
        return 'stale approval';
      case 'approved':
        return 'approved';
      default:
        return 'needs review';
    }
  }

  function ciBadge(ci) {
    const rawStatus = (ci && ci.state) || 'unknown';
    const status = ['passing', 'failing', 'pending', 'unknown'].includes(rawStatus) ? rawStatus : 'unknown';
    const total = Number(ci && ci.total) || 0;
    const counts = {
      passing: Number(ci && ci.passed) || 0,
      failing: Number(ci && ci.failed) || 0,
      pending: Number(ci && ci.pending) || 0,
    };
    const label = { passing: 'passing', failing: 'failing', pending: 'running', unknown: 'no checks' }[status] || 'no checks';
    let numberPart = '';
    if (status === 'failing' && counts.failing > 0) numberPart = ` ${counts.failing}`;
    else if (status === 'pending' && counts.pending > 0) numberPart = ` ${counts.pending}`;
    else if (status === 'passing' && counts.passing > 0) numberPart = ` ${counts.passing}`;

    const tooltipParts = [`${total} check(s)`];
    if (ci && ci.failedName) tooltipParts.push(`failing: ${ci.failedName}`);
    if (ci && ci.source === 'error') tooltipParts.push('status could not be loaded');

    return `<span class="ci ci-${status}" title="${escapeHtml(tooltipParts.join(' — '))}">${label}${numberPart}</span>`;
  }

  function prSize(diff) {
    const additions = Math.max(0, Number(diff && diff.additions) || 0);
    const deletions = Math.max(0, Number(diff && diff.deletions) || 0);
    const changedFiles = Math.max(0, Number(diff && diff.changedFiles) || 0);
    const total = additions + deletions;

    // One source of truth for size thresholds: the worker uses it for scoring.
    const size = PRBitbucket.prSizeCategory(diff);
    const label = {
      XS: 'extra small',
      S: 'small',
      M: 'medium',
      L: 'large',
      XL: 'extra large',
      XXL: 'huge',
    }[size];
    const className = `size-${size.toLowerCase()}`;

    const formattedTotal = total.toLocaleString();
    const formattedAdd = additions.toLocaleString();
    const formattedDel = deletions.toLocaleString();
    const fileText = `${changedFiles} file${changedFiles === 1 ? '' : 's'}`;
    const tooltip = `Size ${size} (${label}): ${formattedTotal} lines changed (+${formattedAdd} / −${formattedDel}) across ${fileText}`;

    return {
      size,
      label,
      className,
      total,
      additions,
      deletions,
      changedFiles,
      formattedTotal,
      formattedAdd,
      formattedDel,
      tooltip,
    };
  }

  function fileChip(diff) {
    const files = Number(diff && diff.changedFiles) || 0;
    if (!files) return '';
    return `<span class="file-chip" title="${files} file(s) changed">${files} file${files === 1 ? '' : 's'}</span>`;
  }

  /* ------------------------------------------------------------------ */
  /* Card rendering (Focused & Relevant: No branch/reviewer clutter)    */
  /* ------------------------------------------------------------------ */

  function cardHtml(pr) {
    const age = ageInfo(pr.createdAt);
    const sizeInfo = prSize(pr.diff);
    const prUrl = safeUrl(pr.url) || '#';
    const isNew = state.newNumbers.has(pr.number);
    const pulse = isNew && state.settings && state.settings.pulseAlerts;
    const author = pr.author || { login: 'unknown' };
    const ci = pr.ci || { state: 'unknown' };
    const commentCount = Number(pr.commentCount) || 0;

    return `
      <article
        class="card state-${escapeHtml(pr.review.state)}${pulse ? ' is-new' : ''}"
        data-number="${Number(pr.number) || 0}"
        data-url="${escapeHtml(prUrl)}"
      >
        ${isNew ? '<span class="new-ribbon">NEW</span>' : ''}
        <header class="card-top">
          <a class="pr-number" href="${escapeHtml(prUrl)}" target="_blank" rel="noopener noreferrer">#${Number(pr.number) || 0}</a>
          <span class="state-badge">${escapeHtml(stateLabel(pr.review.state))}</span>
          <span class="size-badge ${sizeInfo.className}" title="${escapeHtml(sizeInfo.tooltip)}">
            <span class="size-tag">${escapeHtml(sizeInfo.size)}</span>
            <span class="size-lines">${escapeHtml(sizeInfo.formattedTotal)}L</span>
          </span>
          ${ciBadge(ci)}
        </header>

        <h2 class="pr-title">
          <a href="${escapeHtml(prUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pr.title)}</a>
        </h2>

        <div class="meta">
          ${avatar(author)}
          <span class="author">${escapeHtml(author.login)}</span>
          <span class="sep" aria-hidden="true">·</span>
          <span
            class="age age-${age.level}"
            data-created-at="${Number(pr.createdAt) || 0}"
            title="Opened ${escapeHtml(formatDateTime(pr.createdAt))}"
          >${escapeHtml(age.text)}</span>
          ${ci.state === 'failing' && ci.failedName ? `<span class="ci-fail-hint" title="Failed build: ${escapeHtml(ci.failedName)}">⚠️ ${escapeHtml(ci.failedName)}</span>` : ''}
        </div>

        <footer class="card-foot">
          <div class="diff-stats" title="${escapeHtml(sizeInfo.tooltip)}">
            <span class="diff">
              <span class="add">+${Number(pr.diff.additions) || 0}</span>
              <span class="del">−${Number(pr.diff.deletions) || 0}</span>
            </span>
            <span class="diff-files">${fileChip(pr.diff)}</span>
            ${commentCount ? `<span class="comment-chip" title="${commentCount} comment(s)">💬 ${commentCount}</span>` : ''}
          </div>
          <div class="card-size-tag">
            <span class="size-chip ${sizeInfo.className}" title="${escapeHtml(sizeInfo.tooltip)}">${escapeHtml(sizeInfo.size)} · ${escapeHtml(sizeInfo.formattedTotal)} lines</span>
          </div>
        </footer>
      </article>
    `;
  }

  function bindCards() {
    el.grid.querySelectorAll('.card').forEach((card) => {
      const url = card.dataset.url;
      if (!url || url === '#') return;

      const open = () => {
        // The card links are the keyboard-accessible path; this is the click
        // fallback for the card background.
        const result = api.tabs.create({ url });
        if (result && typeof result.catch === 'function') {
          result.catch(() => window.open(url, '_blank', 'noopener'));
        }
        if (isPopup) window.close();
      };

      card.addEventListener('click', (event) => {
        if (event.target.closest('a')) return;
        open();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Scoreboard Rendering (Gamification for last 10 days)               */
  /* ------------------------------------------------------------------ */

  function renderScoreboard() {
    const scoreboard = state.snapshot && state.snapshot.scoreboard;
    const hasTeamFilter = PRShared.parseList(state.settings && state.settings.teamMembers).length > 0;
    // The worker already applies the team filter when it builds the scoreboard.
    const users = (scoreboard && Array.isArray(scoreboard.users)) ? scoreboard.users : [];

    if (!scoreboard || !users.length) {
      el.scoreboardView.innerHTML = `
        <div class="empty-card scoreboard-empty">
          <div class="empty-icon" aria-hidden="true">🏆</div>
          <h2>Reviewer Scoreboard</h2>
          <p>${hasTeamFilter ? 'No activity recorded for configured team members in the last 10 days.' : 'No review activity or comments recorded in the last 10 days yet.'}</p>
          <p class="skipped">Review open pull requests to earn points and climb the leaderboard!</p>
        </div>
      `;
      return;
    }

    const totalPoints = users.reduce((sum, u) => sum + (Number(u.totalScore) || 0), 0);
    const totalReviews = users.reduce((sum, u) => sum + (Number(u.stats && u.stats.reviewsCount) || 0), 0);
    const totalComments = users.reduce((sum, u) => sum + (Number(u.stats && u.stats.commentsCount) || 0), 0);
    const activeContributors = users.length;

    const top3 = users.slice(0, 3);

    // Podium layout: 2nd place on left, 1st place in center (elevated), 3rd place on right
    let podiumUsers = [];
    if (top3.length === 3) {
      podiumUsers = [
        { data: top3[1], rank: 2, placeClass: 'place-2', medal: '🥈' },
        { data: top3[0], rank: 1, placeClass: 'place-1', medal: '🥇' },
        { data: top3[2], rank: 3, placeClass: 'place-3', medal: '🥉' },
      ];
    } else if (top3.length === 2) {
      podiumUsers = [
        { data: top3[0], rank: 1, placeClass: 'place-1', medal: '🥇' },
        { data: top3[1], rank: 2, placeClass: 'place-2', medal: '🥈' },
      ];
    } else if (top3.length === 1) {
      podiumUsers = [{ data: top3[0], rank: 1, placeClass: 'place-1', medal: '🥇' }];
    }

    const podiumHtml = podiumUsers
      .map(({ data, rank, placeClass, medal }) => {
        const user = data.user || { login: 'unknown' };
        const level = data.level || { title: 'Code Scout', level: 1, icon: '🌱' };
        const stats = data.stats || {};
        const reviews = Number(stats.reviewsCount) || 0;
        const comments = Number(stats.commentsCount) || 0;
        const approvals = Number(stats.approvalsCount) || 0;

        return `
          <div class="podium-card ${placeClass}">
            <div class="podium-medal" aria-hidden="true">${medal}</div>
            <div class="podium-avatar-wrap">
              ${avatar(user, 'podium-avatar')}
              <span class="podium-rank">#${rank}</span>
            </div>
            <div class="podium-user">
              <h3 class="podium-name">${escapeHtml(user.login)}</h3>
              <span class="level-pill" title="Level ${escapeHtml(level.level)}">
                <span class="level-icon">${escapeHtml(level.icon)}</span> ${escapeHtml(level.title)}
              </span>
            </div>
            <div class="podium-score">
              <span class="score-number">${Number(data.totalScore || 0).toLocaleString()}</span>
              <span class="score-label">POINTS</span>
            </div>
            <div class="podium-stats">
              <span class="stat-pill" title="${reviews} PR(s) reviewed">🔍 <strong>${reviews}</strong> reviews</span>
              <span class="stat-pill" title="${comments} comment(s) written">💬 <strong>${comments}</strong> comments</span>
              <span class="stat-pill" title="${approvals} approval(s)">✅ <strong>${approvals}</strong> approved</span>
            </div>
          </div>
        `;
      })
      .join('');

    const listHtml = users
      .map((data, index) => {
        const rank = index + 1;
        const user = data.user || { login: 'unknown' };
        const level = data.level || { title: 'Code Scout', level: 1, icon: '🌱' };
        const stats = data.stats || {};
        const bySize = stats.reviewsBySize || {};
        const sizeText = ['XS', 'S', 'M', 'L', 'XL', 'XXL']
          .filter((s) => Number(bySize[s]) > 0)
          .map((s) => `${s}: ${Number(bySize[s])}`)
          .join(', ');
        const reviews = Number(stats.reviewsCount) || 0;
        const comments = Number(stats.commentsCount) || 0;
        const approvals = Number(stats.approvalsCount) || 0;
        const changesRequested = Number(stats.changesRequestedCount) || 0;
        const prsCreated = Number(stats.prsCreatedCount) || 0;
        const prsMerged = Number(stats.prsMergedCount) || 0;

        const rankBadge = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;

        return `
          <div class="leader-row ${rank <= 3 ? `top-rank rank-${rank}` : ''}">
            <div class="leader-rank">${rankBadge}</div>
            <div class="leader-user">
              ${avatar(user)}
              <div class="leader-identity">
                <span class="leader-name">${escapeHtml(user.login)}</span>
                <span class="leader-level"><span class="level-icon">${escapeHtml(level.icon)}</span> ${escapeHtml(level.title)}</span>
              </div>
            </div>
            <div class="leader-breakdown">
              <span class="mini-chip" title="Reviews breakdown: ${escapeHtml(sizeText || 'none')}">
                <strong>${reviews}</strong> reviews
                ${sizeText ? `<small class="chip-detail">(${escapeHtml(sizeText)})</small>` : ''}
              </span>
              <span class="mini-chip" title="${comments} comment(s) written in the last 10 days">
                💬 <strong>${comments}</strong> comments
              </span>
              <span class="mini-chip" title="${approvals} approval(s)">
                ✅ <strong>${approvals}</strong> approvals
              </span>
              ${changesRequested > 0 ? `<span class="mini-chip is-alert" title="${changesRequested} change request(s)">📝 <strong>${changesRequested}</strong> changes</span>` : ''}
              ${prsCreated > 0 ? `<span class="mini-chip" title="${prsCreated} PR(s) created, ${prsMerged} merged">🚀 <strong>${prsCreated}</strong> PRs</span>` : ''}
            </div>
            <div class="leader-score">
              <span class="score-val">${Number(data.totalScore || 0).toLocaleString()}</span>
              <span class="score-unit">pts</span>
            </div>
          </div>
        `;
      })
      .join('');

    el.scoreboardView.innerHTML = `
      <div class="scoreboard-container">
        <header class="scoreboard-head">
          <div class="scoreboard-title-row">
            <div class="scoreboard-titles">
              <h2>🏆 Reviewer Wall of Fame</h2>
              <p>Top review contributors over the <strong>last 10 days</strong> · Gamification leaderboard</p>
            </div>
            <div class="scoreboard-summary-stats">
              <div class="sb-stat">
                <span class="sb-val">${totalPoints.toLocaleString()}</span>
                <span class="sb-lbl">Total Points</span>
              </div>
              <div class="sb-stat">
                <span class="sb-val">${totalReviews}</span>
                <span class="sb-lbl">Reviews</span>
              </div>
              <div class="sb-stat">
                <span class="sb-val">${totalComments}</span>
                <span class="sb-lbl">Comments</span>
              </div>
              <div class="sb-stat">
                <span class="sb-val">${activeContributors}</span>
                <span class="sb-lbl">Reviewers</span>
              </div>
            </div>
          </div>

          <div class="rules-banner">
            <span class="rules-title">⚡ Scoring Rules:</span>
            <span class="rules-item">📏 <strong>Reviews:</strong> XS (+10p) · S (+20p) · M (+35p) · L (+60p) · XL (+100p) · XXL (+150p)</span>
            <span class="rules-sep">·</span>
            <span class="rules-item">💬 <strong>Comments:</strong> +5p each</span>
            <span class="rules-sep">·</span>
            <span class="rules-item">🚀 <strong>PRs:</strong> Created (+10p) · Merged (+20p)</span>
          </div>
        </header>

        ${podiumUsers.length > 0 ? `<div class="podium-grid">${podiumHtml}</div>` : ''}

        <section class="leaderboard-list">
          <h3 class="leaderboard-heading">All Rankings</h3>
          <div class="leaderboard-table">${listHtml}</div>
        </section>
      </div>
    `;
  }

  function setView(view) {
    state.currentView = view === 'scoreboard' ? 'scoreboard' : 'prs';

    if (el.tabPrs) {
      el.tabPrs.classList.toggle('is-active', state.currentView === 'prs');
      el.tabPrs.setAttribute('aria-selected', String(state.currentView === 'prs'));
    }
    if (el.tabScoreboard) {
      el.tabScoreboard.classList.toggle('is-active', state.currentView === 'scoreboard');
      el.tabScoreboard.setAttribute('aria-selected', String(state.currentView === 'scoreboard'));
    }

    render();
  }

  /* ------------------------------------------------------------------ */
  /* Empty state / banner / header                                      */
  /* ------------------------------------------------------------------ */

  function setupCardHtml() {
    return `
      <div class="empty-card">
        <div class="empty-icon is-setup" aria-hidden="true">⚙</div>
        <h2>Finish the setup</h2>
        <p>Add your Bitbucket email and API token, the workspace and the repository slug. The dashboard starts as soon as the settings are saved.</p>
        <a class="cta" href="options.html" target="_blank" rel="noopener">Open settings</a>
      </div>
    `;
  }

  function skippedSummary(snapshot) {
    const skipped = (snapshot && snapshot.skipped) || {};
    const parts = [];
    if (skipped.approved) parts.push(`${skipped.approved} approved`);
    if (skipped.drafts) parts.push(`${skipped.drafts} draft`);
    if (skipped.branches) parts.push(`${skipped.branches} branch-filtered`);
    if (skipped.titles) parts.push(`${skipped.titles} title-filtered`);
    if (skipped.team) parts.push(`${skipped.team} non-team`);
    if (skipped.notRequested) parts.push(`${skipped.notRequested} without review request`);
    if (skipped.overLimit) parts.push(`${skipped.overLimit} over limit`);
    return parts.join(' · ');
  }

  function renderEmptyState() {
    if (!PRShared.isConfigured(state.settings)) {
      el.empty.innerHTML = setupCardHtml();
      return;
    }

    const snapshot = state.snapshot;
    if (!snapshot || (!snapshot.fetchedAt && !snapshot.lastError)) {
      el.empty.innerHTML = `
        <div class="empty-card">
          <div class="empty-icon" aria-hidden="true">…</div>
          <h2>Loading pull requests</h2>
          <p>Waiting for the first Bitbucket response.</p>
        </div>
      `;
      return;
    }

    const skipped = skippedSummary(snapshot);
    const approvedCount = (snapshot.skipped && snapshot.skipped.approved) || 0;
    const headline = approvedCount > 0 ? 'All clear' : 'Nothing waiting for review';
    const subline = approvedCount > 0
      ? 'Every open pull request already has an approval.'
      : 'No open pull request matches the current filters.';

    el.empty.innerHTML = `
      <div class="empty-card">
        <div class="empty-icon" aria-hidden="true">✓</div>
        <h2>${escapeHtml(headline)}</h2>
        <p>${escapeHtml(subline)}</p>
        ${skipped ? `<p class="skipped">${escapeHtml(skipped)}</p>` : ''}
        <p class="skipped">Updated ${escapeHtml(formatClock(snapshot.fetchedAt))}${snapshot.repo ? ` · ${escapeHtml(snapshot.repo.fullName)}` : ''}</p>
      </div>
    `;
  }

  function describeError(error) {
    const kind = (error && error.kind) || 'error';
    const since = state.snapshot && state.snapshot.fetchedAt
      ? ` Showing data from ${formatClock(state.snapshot.fetchedAt)}.`
      : '';

    switch (kind) {
      case 'unconfigured':
        return {
          kind: 'setup',
          title: 'Wallboard not configured',
          hint: 'Add a Bitbucket email, API token, workspace and repository slug in the settings.',
          retry: false,
        };
      case 'auth':
        return {
          kind: 'error',
          title: 'Bitbucket credentials rejected',
          hint: `${(error && error.message) || 'The token is invalid or expired.'}${since}`,
          retry: true,
        };
      case 'not_found':
        return {
          kind: 'error',
          title: 'Repository not found',
          hint: `${(error && error.message) || 'Check workspace and repository slug.'}${since}`,
          retry: true,
        };
      case 'rate_limit':
        return {
          kind: 'warn',
          title: 'Bitbucket API rate limit reached',
          hint: `${error && error.retryAt ? `Next attempt after ${formatClock(error.retryAt)}. ` : ''}The wallboard will resume automatically.${since}`,
          retry: true,
        };
      case 'forbidden':
        return {
          kind: 'error',
          title: 'Bitbucket denied access',
          hint: `${(error && error.message) || 'The API token lacks a pull request scope.'}${since}`,
          retry: true,
        };
      case 'network':
        return {
          kind: 'warn',
          title: 'Bitbucket is not reachable',
          hint: `${(error && error.message) || 'Network error.'}${since}`,
          retry: true,
        };
      case 'worker':
        return {
          kind: 'error',
          title: 'Background worker not reachable',
          hint: 'Reload the extension (chrome://extensions → Reload) and try again.',
          retry: true,
        };
      default:
        return {
          kind: 'error',
          title: 'Bitbucket request failed',
          hint: `${(error && error.message) || 'Unknown error.'}${since}`,
          retry: true,
        };
    }
  }

  function renderBanner() {
    const error = state.transportError || (state.snapshot && state.snapshot.lastError);
    if (!error) {
      el.banner.hidden = true;
      el.banner.innerHTML = '';
      return;
    }

    const described = describeError(error);
    // An unconfigured extension already shows the setup card in the empty area.
    const hasCards = Boolean(state.snapshot && state.snapshot.pullRequests && state.snapshot.pullRequests.length);
    if (described.kind === 'setup' && !hasCards) {
      el.banner.hidden = true;
      el.banner.innerHTML = '';
      return;
    }

    el.banner.className = `banner banner-${described.kind}`;
    el.banner.innerHTML = `
      <div class="banner-main">
        <strong>${escapeHtml(described.title)}</strong>
        <span>${escapeHtml(described.hint)}</span>
      </div>
      <div class="banner-actions">
        ${described.kind === 'setup' ? '<a class="btn" href="options.html" target="_blank" rel="noopener">Open settings</a>' : ''}
        ${described.retry ? '<button type="button" class="btn" id="banner-retry">Retry now</button>' : ''}
      </div>
    `;
    el.banner.hidden = false;

    const retry = el.banner.querySelector('#banner-retry');
    if (retry) {
      retry.addEventListener('click', () => {
        state.transportError = null;
        refresh('manual', true);
      });
    }
  }

  function renderStats() {
    const snapshot = state.snapshot;
    const counts = (snapshot && snapshot.counts) || {};
    const stats = [
      { value: counts.needingReview || 0, label: 'need review', className: '' },
      { value: counts.changesRequested || 0, label: 'changes', className: counts.changesRequested ? 'is-alert' : '' },
      { value: counts.failingChecks || 0, label: 'ci failing', className: counts.failingChecks ? 'is-alert' : '' },
    ];

    el.stats.innerHTML = stats
      .map(
        (stat) => `
          <div class="stat ${stat.className}">
            <span class="stat-value">${Number(stat.value) || 0}</span>
            <span class="stat-label">${escapeHtml(stat.label)}</span>
          </div>
        `,
      )
      .join('');
  }

  function renderHeader() {
    const snapshot = state.snapshot;
    const settings = state.settings;
    const repoName = (snapshot && snapshot.repo && snapshot.repo.fullName) || (settings && settings.workspace && settings.repoSlug ? `${settings.workspace}/${settings.repoSlug}` : 'ReviewBoard');

    el.repoName.textContent = repoName;
    if (snapshot && snapshot.repo) {
      const visibility = snapshot.repo.isPrivate ? 'private' : 'public';
      const open = snapshot.repo.openPullRequests !== undefined ? `${snapshot.repo.openPullRequests} open` : '';
      el.repoMeta.textContent = [open, visibility, 'pull requests awaiting review'].filter(Boolean).join(' · ');
      el.repoName.title = repoName;
    } else if (PRShared.isConfigured(settings)) {
      el.repoMeta.textContent = 'waiting for the first refresh…';
    } else {
      el.repoMeta.textContent = 'not configured — open the settings';
    }
  }

  function renderStatusBar() {
    const snapshot = state.snapshot;
    const settings = state.settings;
    const configured = PRShared.isConfigured(settings);

    el.liveDot.className = 'live-dot';
    if (!configured) {
      el.statusLine.textContent = 'Not configured';
      el.quota.textContent = '';
      el.updated.textContent = '';
      return;
    }

    if (state.refreshing) {
      el.statusLine.textContent = 'Refreshing from Bitbucket…';
    } else if (snapshot && snapshot.lastError) {
      el.statusLine.textContent = `Error: ${snapshot.lastError.message}`;
      el.liveDot.classList.add('is-error');
      if (snapshot.stale) el.liveDot.className = 'live-dot is-stale';
    } else if (snapshot && snapshot.counts) {
      el.statusLine.textContent = `${snapshot.counts.needingReview} PR(s) awaiting review · ${snapshot.counts.changesRequested} with changes requested`;
    } else {
      el.statusLine.textContent = 'Waiting for the first refresh…';
    }

    const rate = snapshot && snapshot.rateLimit;
    el.quota.textContent = rate && rate.remaining !== null && rate.remaining !== undefined
      ? `API ${rate.remaining}/${rate.limit || '?'} left`
      : '';

    el.updated.textContent = snapshot && snapshot.fetchedAt ? `updated ${formatClock(snapshot.fetchedAt)}` : '';
    el.updated.title = snapshot && snapshot.fetchedAt ? formatDateTime(snapshot.fetchedAt) : '';
  }

  function updateDocumentTitle() {
    const snapshot = state.snapshot;
    const count = (snapshot && snapshot.counts && snapshot.counts.needingReview) || 0;
    const repo = (snapshot && snapshot.repo && snapshot.repo.fullName) || 'ReviewBoard';
    document.title = count > 0 ? `(${count}) PRs need review · ${repo}` : `All clear · ${repo}`;
  }

  /* ------------------------------------------------------------------ */
  /* Theme handling (Dark / Light / System)                             */
  /* ------------------------------------------------------------------ */

  function applyTheme(themeSetting) {
    const setting = themeSetting || (state.settings && state.settings.theme) || DEFAULTS.theme;
    const effective = PRShared.applyTheme(setting);

    if (el.themeToggle) {
      const light = effective === 'light';
      const label = light ? 'Switch to dark theme' : 'Switch to light theme';
      el.themeToggle.classList.toggle('is-light', light);
      el.themeToggle.dataset.tooltip = `${label} (T)`;
      el.themeToggle.setAttribute('aria-label', label);
    }
  }

  function toggleTheme() {
    const current = (state.settings && state.settings.theme) || DEFAULTS.theme;
    const effective = PRShared.resolveEffectiveTheme(current);
    const nextTheme = effective === 'dark' ? 'light' : 'dark';
    state.settings = Object.assign({}, state.settings, { theme: nextTheme });
    applyTheme(nextTheme);
    PRShared.saveSettings({ theme: nextTheme }).catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* Snapshot application                                               */
  /* ------------------------------------------------------------------ */

  function applySnapshot(snapshot, source, options) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const opts = options || {};

    const key = `${snapshot.fetchedAt || 0}:${snapshot.lastAttemptAt || 0}:${snapshot.lastError ? snapshot.lastError.at : 0}`;
    if (key === state.appliedKey && !opts.force) {
      // Even a deduplicated live snapshot proves the data path works; the next
      // update must be allowed to raise alerts.
      if (source === 'live' || source === 'storage') state.hasLive = true;
      return;
    }
    state.appliedKey = key;

    // The first live snapshot (or the first after start-up) must not alert for
    // every PR that simply was not in the cached snapshot yet.
    const isFirstLive = (source === 'live' || source === 'storage') && !state.hasLive;

    const previous = state.snapshot;
    const previousNumbers = new Set(
      previous && Array.isArray(previous.pullRequests) ? previous.pullRequests.map((pr) => pr.number) : [],
    );
    const incoming = Array.isArray(snapshot.pullRequests) ? snapshot.pullRequests : [];
    const explicitNew = Array.isArray(snapshot.newNumbers) ? snapshot.newNumbers : [];
    // The worker sends an explicit empty list after settings changes; do not
    // reinterpret it as "diff against the old snapshot" and alert everything.
    const suppressNew = Boolean(snapshot.suppressNewAlerts);

    const newNumbers = new Set(isFirstLive || suppressNew ? [] : explicitNew);
    if (!isFirstLive && !suppressNew && state.initialized && !opts.silent && !opts.fromCache && !explicitNew.length) {
      incoming.forEach((pr) => {
        if (!previousNumbers.has(pr.number)) newNumbers.add(pr.number);
      });
    }

    if (source === 'live' || source === 'storage') state.hasLive = true;
    state.snapshot = snapshot;
    state.newNumbers = newNumbers;
    state.initialized = true;

    if (source === 'live') state.transportError = null;

    render();

    if (newNumbers.size > 0) {
      if (state.settings && state.settings.soundAlerts) playChime();
      if (!isPopup) flashTitle();
    }
  }

  function render() {
    if (!state.settings) return;

    renderHeader();
    renderStats();
    renderBanner();
    renderStatusBar();
    updateDocumentTitle();

    const prs = (state.snapshot && state.snapshot.pullRequests) || [];
    if (el.tabPrCount) el.tabPrCount.textContent = String(prs.length);

    if (state.currentView === 'scoreboard') {
      el.grid.hidden = true;
      el.empty.hidden = true;
      el.scoreboardView.hidden = false;
      renderScoreboard();
    } else {
      el.scoreboardView.hidden = true;
      if (!prs.length) {
        el.grid.innerHTML = '';
        el.grid.hidden = true;
        el.empty.hidden = false;
        renderEmptyState();
      } else {
        el.empty.hidden = true;
        el.grid.hidden = false;
        el.grid.innerHTML = prs.map(cardHtml).join('');
        bindCards();
      }
    }

    updateSoundButton();
  }

  /* ------------------------------------------------------------------ */
  /* Countdown + refresh                                                */
  /* ------------------------------------------------------------------ */

  function resetCountdown(seconds) {
    const total = Math.max(1, Number(seconds) || DEFAULTS.refreshSeconds);
    state.countdownTotal = total;
    state.countdownEnd = Date.now() + total * 1000;
    updateCountdown();
  }

  function updateCountdown() {
    const configured = PRShared.isConfigured(state.settings);
    if (!configured) {
      el.countdown.textContent = '–';
      el.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
      el.progressValue.style.width = '0%';
      return;
    }

    const remainingMs = Math.max(0, state.countdownEnd - Date.now());
    const fraction = Math.min(1, remainingMs / (state.countdownTotal * 1000));
    el.countdown.textContent = String(Math.ceil(remainingMs / 1000));
    el.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
    el.progressValue.style.width = `${(1 - fraction) * 100}%`;
  }

  function tick() {
    updateCountdown();
    // Do not poll Bitbucket while the tab is inactive / hidden in background
    if (document.hidden) return;
    if (!state.refreshing && PRShared.isConfigured(state.settings) && Date.now() >= state.countdownEnd) {
      refresh('timer', false);
    }
  }

  function startTicker() {
    if (state.ticker) return;
    state.ticker = setInterval(tick, 250);
    setInterval(() => {
      el.grid.querySelectorAll('.age').forEach((node) => {
        const createdAt = Number(node.dataset.createdAt) || 0;
        const info = ageInfo(createdAt);
        if (node.textContent !== info.text) node.textContent = info.text;
        node.className = `age age-${info.level}`;
      });
    }, 30000);
  }

  async function refresh(reason, force) {
    if (state.refreshing) return;
    if (!PRShared.isConfigured(state.settings)) {
      render();
      return;
    }

    state.refreshing = true;
    state.transportError = null;
    document.body.classList.add('is-refreshing');
    renderBanner();
    renderStatusBar();

    try {
      const result = await PRShared.sendMessage({
        type: 'pr-wallboard:refresh',
        force: Boolean(force),
        reason: reason || 'manual',
      });

      if (result && result.snapshot) {
        applySnapshot(result.snapshot, 'live', { silent: reason === 'initial' && !state.snapshot });
      }

      if (!result || result.ok !== true) {
        const error = (result && result.error) || { kind: 'error', message: 'The background worker returned no data.' };
        if (error.kind !== 'unconfigured') state.transportError = error;
      }
    } catch (error) {
      state.transportError = {
        kind: 'worker',
        message: (error && error.message) || String(error),
      };
    } finally {
      state.refreshing = false;
      document.body.classList.remove('is-refreshing');

      const error = state.transportError || (state.snapshot && state.snapshot.lastError);
      let nextIn = (state.settings && state.settings.refreshSeconds) || DEFAULTS.refreshSeconds;
      if (error && error.kind === 'rate_limit' && error.retryAt) {
        const wait = Math.ceil((error.retryAt - Date.now()) / 1000);
        if (wait > 0) nextIn = Math.min(3600, Math.max(15, wait));
      }

      resetCountdown(Math.max(10, nextIn));
      render();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Alerts (sound + title)                                             */
  /* ------------------------------------------------------------------ */

  function ensureAudio() {
    if (!state.audio) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return null;
      state.audio = new Context();
    }
    if (state.audio.state === 'suspended') {
      state.audio.resume().catch(() => {});
    }
    return state.audio;
  }

  function playChime() {
    const audio = ensureAudio();
    if (!audio) return;
    if (audio.state !== 'running') {
      // Autoplay policy: the operator must click the bell once.
      updateSoundButton();
      return;
    }

    const start = audio.currentTime;
    [880, 1174.66].forEach((frequency, index) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const begin = start + index * 0.18;
      gain.gain.setValueAtTime(0.0001, begin);
      gain.gain.exponentialRampToValueAtTime(0.16, begin + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, begin + 0.34);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(begin);
      oscillator.stop(begin + 0.4);
    });
  }

  function flashTitle() {
    if (state.titleTimer) return;
    let on = false;
    state.titleTimer = setInterval(() => {
      on = !on;
      document.title = on ? '▲ NEW PULL REQUEST' : `(${(state.snapshot && state.snapshot.counts && state.snapshot.counts.needingReview) || 0}) PRs need review`;
    }, 1200);

    setTimeout(() => {
      if (state.titleTimer) clearInterval(state.titleTimer);
      state.titleTimer = null;
      updateDocumentTitle();
    }, 12000);
  }

  function updateSoundButton() {
    const enabled = Boolean(state.settings && state.settings.soundAlerts);
    el.soundToggle.setAttribute('aria-pressed', String(enabled));
    el.soundToggle.classList.toggle('muted', !enabled);
    el.soundToggle.dataset.tooltip = enabled ? 'Sound alerts on' : 'Sound alerts off';
  }

  function toggleSound() {
    const enabled = !(state.settings && state.settings.soundAlerts);
    state.settings = Object.assign({}, state.settings, { soundAlerts: enabled });
    updateSoundButton();
    PRShared.saveSettings({ soundAlerts: enabled }).catch(() => {});
    if (enabled) {
      ensureAudio();
      playChime();
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI controls                                                        */
  /* ------------------------------------------------------------------ */

  function applyWallboardMode(enabled) {
    document.body.classList.toggle('wallboard', Boolean(enabled));
    el.wallboardToggle.setAttribute('aria-pressed', String(Boolean(enabled)));
  }

  function toggleWallboard() {
    const next = !document.body.classList.contains('wallboard');
    applyWallboardMode(next);
    PRShared.saveSettings({ wallboardMode: next }).catch(() => {});
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch((error) => {
        console.warn('[ReviewBoard] fullscreen denied', error);
      });
    }
  }

  function openDashboardTab() {
    api.tabs.create({ url: api.runtime.getURL('dashboard.html') }).then(
      () => window.close(),
      () => {},
    );
  }

  function bindEvents() {
    if (el.tabPrs) el.tabPrs.addEventListener('click', () => setView('prs'));
    if (el.tabScoreboard) el.tabScoreboard.addEventListener('click', () => setView('scoreboard'));
    if (el.themeToggle) el.themeToggle.addEventListener('click', toggleTheme);
    el.refresh.addEventListener('click', () => refresh('manual', true));
    el.soundToggle.addEventListener('click', toggleSound);
    el.wallboardToggle.addEventListener('click', toggleWallboard);
    el.fullscreenToggle.addEventListener('click', toggleFullscreen);
    el.openTab.addEventListener('click', openDashboardTab);

    document.addEventListener('fullscreenchange', () => {
      el.fullscreenToggle.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
      el.fullscreenToggle.title = document.fullscreenElement ? 'Leave full screen (Esc)' : 'Full screen (F)';
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (PRShared.isConfigured(state.settings) && Date.now() >= state.countdownEnd) {
        refresh('visible', false);
      }
    });

    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
          if (state.settings && state.settings.theme === 'system') {
            applyTheme('system');
          }
        });
      } catch (error) {
        /* older browsers fallback */
      }
    }

    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key.toLowerCase()) {
        case 'p':
          event.preventDefault();
          setView('prs');
          break;
        case 's':
          event.preventDefault();
          setView(state.currentView === 'scoreboard' ? 'prs' : 'scoreboard');
          break;
        case 'r':
          event.preventDefault();
          refresh('manual', true);
          break;
        case 'f':
          event.preventDefault();
          toggleFullscreen();
          break;
        case 'w':
          event.preventDefault();
          toggleWallboard();
          break;
        case 't':
          event.preventDefault();
          toggleTheme();
          break;
        default:
          break;
      }
    });

    PRShared.onStorageChanged((changes) => {
      if (changes.settings) {
        const previous = state.settings || {};
        state.settings = PRShared.normalizeSettings(changes.settings.newValue);
        applyWallboardMode(state.settings.wallboardMode);
        applyTheme(state.settings.theme);

        const dataChanged =
          PRShared.settingsFingerprint(previous) !== PRShared.settingsFingerprint(state.settings) ||
          Number(previous.refreshSeconds) !== Number(state.settings.refreshSeconds);

        if (!PRShared.isConfigured(state.settings)) {
          render();
        } else if (dataChanged) {
          resetCountdown(state.settings.refreshSeconds);
          refresh('settings', true);
        } else {
          // Only cosmetic preferences changed (sound, wallboard mode, theme).
          render();
          resetCountdown(state.settings.refreshSeconds);
        }
      }

      if (changes.snapshot && changes.snapshot.newValue) {
        applySnapshot(changes.snapshot.newValue, 'storage', { fromCache: false });
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  async function init() {
    bindEvents();

    try {
      state.settings = await PRShared.loadSettings();
    } catch (error) {
      state.settings = PRShared.normalizeSettings({});
    }

    applyWallboardMode(state.settings.wallboardMode);
    applyTheme(state.settings.theme);
    updateSoundButton();
    startTicker();

    let cached = null;
    try {
      cached = await PRShared.getSnapshot();
    } catch (error) {
      cached = null;
    }

    if (cached) {
      applySnapshot(cached, 'cache', { silent: true, fromCache: true, force: true });
    }

    if (!PRShared.isConfigured(state.settings)) {
      render();
      return;
    }

    resetCountdown(Math.min(2, state.settings.refreshSeconds));
    render();
    await refresh('initial', true);
  }

  init().catch((error) => {
    console.error('[ReviewBoard] init failed', error);
    state.transportError = { kind: 'error', message: (error && error.message) || String(error) };
    renderBanner();
  });
})();
