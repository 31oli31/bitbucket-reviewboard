/*
 * Bitbucket Cloud REST 2.0 client + pull-request triage for ReviewBoard.
 * Classic script (no modules) so a service worker can importScripts() it and a
 * Firefox event page can load it via manifest background.scripts.
 *
 * Nothing in here touches WebExtension APIs: the storage cache and fetch are
 * injected, so the module is unit-testable in plain Node.
 *
 * API notes (verified against api.bitbucket.org/2.0):
 *  - The pull-request *list* endpoint omits reviewers/participants by default,
 *    but `?fields=` can pull them in, so one request covers review state.
 *  - `source.commit.date` is the head-commit timestamp; an approval given
 *    before it is stale (repositories that reset approvals on push will never
 *    produce one).
 *  - Diff stats need one request per PR (/diffstat answers with a 302 that
 *    fetch follows), CI needs one more (/statuses).
 */
(function (global) {
  'use strict';

  const DEFAULT_API_BASE = 'https://api.bitbucket.org/2.0';

  const LIST_FIELDS = [
    'values.id',
    'values.title',
    'values.state',
    'values.draft',
    'values.created_on',
    'values.updated_on',
    'values.comment_count',
    'values.task_count',
    'values.author',
    'values.reviewers',
    'values.participants',
    'values.links.html',
    'values.source.branch.name',
    'values.source.commit.hash',
    'values.source.commit.date',
    'values.source.repository.full_name',
    'values.destination.branch.name',
    'values.destination.repository.full_name',
    'next',
    'size',
  ].join(',');

  const STATUS_STATE = Object.freeze({
    SUCCESSFUL: 'passed',
    FAILED: 'failed',
    INPROGRESS: 'pending',
    PAUSED: 'pending',
    STOPPED: 'failed',
    SKIPPED: 'passed',
  });

  const PRIORITY = Object.freeze({
    changes_requested: 0,
    review_requested: 1,
    stale_approval: 2,
    needs_review: 3,
  });

  const SCORE_POINTS = Object.freeze({
    reviews: {
      XS: 10,
      S: 20,
      M: 35,
      L: 60,
      XL: 100,
      XXL: 150,
    },
    changesRequestedBonus: 5,
    comment: 5,
    prCreated: 10,
    prMerged: 20,
  });

  const FATAL_ERROR_KINDS = new Set(['auth', 'rate_limit', 'forbidden']);

  function isFatalError(error) {
    return Boolean(error && FATAL_ERROR_KINDS.has(error.kind));
  }

  class BitbucketError extends Error {
    constructor(message, options) {
      super(message);
      const opts = options || {};
      this.name = 'BitbucketError';
      this.kind = opts.kind || 'http';
      this.status = opts.status || 0;
      this.retryAt = opts.retryAt || 0;
      this.details = opts.details || null;
    }
  }

  function createMemoryCache() {
    const map = new Map();
    return {
      async get(key) {
        return map.get(key) || null;
      },
      async set(key, entry) {
        map.set(key, entry);
      },
    };
  }

  function mapLimit(items, limit, worker) {
    const list = Array.from(items || []);
    const size = Math.max(1, Math.min(limit || 4, list.length || 1));
    const results = new Array(list.length);
    let cursor = 0;

    async function run() {
      while (cursor < list.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(list[index], index);
      }
    }

    return Promise.all(Array.from({ length: size }, run)).then(() => results);
  }

  function displayName(user) {
    if (!user) return 'unknown';
    return String(user.display_name || user.displayName || user.nickname || user.username || user.name || user.uuid || 'unknown');
  }

  function avatarUrl(user) {
    const href = user && user.links && user.links.avatar && user.links.avatar.href;
    return String(href || '');
  }

  function profileUrl(user) {
    const href = user && user.links && user.links.html && user.links.html.href;
    return String(href || '');
  }

  /** Bitbucket exposes several ids; prefer the stable one for identity checks. */
  function identity(user) {
    if (!user) return '';
    return String(user.account_id || user.accountId || user.uuid || user.nickname || user.username || user.display_name || user.displayName || '');
  }

  function person(user) {
    return {
      login: displayName(user),
      avatarUrl: avatarUrl(user),
      url: profileUrl(user),
      uuid: String((user && user.uuid) || ''),
      nickname: String((user && (user.nickname || user.username || user.name)) || ''),
      displayName: String((user && (user.display_name || user.displayName)) || ''),
      accountId: String((user && (user.account_id || user.accountId)) || ''),
    };
  }

  /** Only Retry-After is exposed; Bitbucket publishes no quota counters. */
  function readRetryAfter(headers) {
    const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
    if (raw === null || raw === undefined || raw === '') return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);
    const date = Date.parse(String(raw));
    return Number.isFinite(date) ? Math.max(0, Math.round((date - Date.now()) / 1000)) : 0;
  }

  function latestByKey(entries) {
    const byKey = new Map();
    (entries || []).forEach((entry) => {
      if (!entry) return;
      const key = String(entry.key || entry.name || '');
      if (!key) return;
      const at = Date.parse(entry.updated_on || entry.created_on || '') || 0;
      const previous = byKey.get(key);
      if (!previous || at >= previous.at) byKey.set(key, { entry, at });
    });
    return Array.from(byKey.values()).map((item) => item.entry);
  }

  /**
   * Bitbucket CI reports one status per build, often several per pipeline name.
   * Keeping the newest entry per key avoids showing superseded results.
   */
  function summarizeStatuses(payload) {
    const values = latestByKey((payload && payload.values) || []);
    let failed = 0;
    let pending = 0;
    let passed = 0;
    let stopped = 0;
    let failedName = '';
    let failedUrl = '';

    values.forEach((entry) => {
      // Unknown states must not silently mark a PR as green.
      const bucket = STATUS_STATE[String(entry.state || '').toUpperCase()] || 'pending';
      if (bucket === 'failed') {
        failed += 1;
        if (String(entry.state).toUpperCase() === 'STOPPED') stopped += 1;
        if (!failedName) {
          failedName = String(entry.name || entry.key || 'build');
          failedUrl = String(entry.url || '');
        }
        return;
      }
      if (bucket === 'pending') {
        pending += 1;
        return;
      }
      passed += 1;
    });

    const state = failed > 0 ? 'failing' : pending > 0 ? 'pending' : values.length ? 'passing' : 'unknown';

    return {
      state,
      total: values.length,
      failed,
      pending,
      passed,
      stopped,
      failedName,
      failedUrl,
      source: values.length ? 'statuses' : 'none',
    };
  }

  function normalizePattern(value) {
    return String(value || '').trim().toLowerCase();
  }

  function replaceUmlauts(str) {
    return String(str || '')
      .replace(/ä/g, 'ae')
      .replace(/Ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/Ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/Ü/g, 'ue')
      .replace(/ß/g, 'ss');
  }

  function normalizeName(str) {
    if (!str) return '';
    return replaceUmlauts(str)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  function collapseVowels(str) {
    if (!str) return '';
    return str
      .replace(/ae/g, 'a')
      .replace(/oe/g, 'o')
      .replace(/ue/g, 'u');
  }

  function tokenizeName(str) {
    if (!str) return [];
    return String(str)
      .toLowerCase()
      .replace(/@.+$/, '')
      .split(/[\s._\-+/:;,]+/)
      .map((part) => replaceUmlauts(part).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''))
      .filter(Boolean);
  }

  function matchBranchRule(branchName, pattern) {
    const branch = normalizePattern(branchName);
    const rawPattern = normalizePattern(pattern);
    if (!branch || !rawPattern) return false;

    // Direct substring or exact match
    if (branch.includes(rawPattern)) return true;

    // Strip trailing wildcard/glob (e.g. "ABC-*" -> "ABC-", "feature/*" -> "feature/")
    const stripped = rawPattern.replace(/\*+$/, '');
    if (stripped && branch.includes(stripped)) return true;

    // Glob pattern matching with * and ?
    if (rawPattern.includes('*') || rawPattern.includes('?')) {
      try {
        const regexStr = rawPattern
          .split('*')
          .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
          .join('.*')
          .replace(/\?/g, '.');
        const regex = new RegExp(regexStr, 'i');
        if (regex.test(branch)) return true;
      } catch (e) {
        /* fallback */
      }
    }

    return false;
  }

  function matchesExcludedBranch(branchName, patterns) {
    const branch = normalizePattern(branchName);
    if (!branch || !patterns || !patterns.length) return false;
    return patterns.some((pattern) => matchBranchRule(branch, pattern));
  }

  function matchesIncludedBranch(branchName, patterns) {
    if (!patterns || !patterns.length) return true;
    const branch = normalizePattern(branchName);
    if (!branch) return false;
    return patterns.some((pattern) => matchBranchRule(branch, pattern));
  }

  function matchTitleRule(title, pattern) {
    const haystack = String(title || '').toLowerCase();
    const rawPattern = normalizePattern(pattern);
    if (!haystack || !rawPattern) return false;
    if (haystack.includes(rawPattern)) return true;
    const stripped = rawPattern.replace(/\*+$/, '');
    if (stripped && haystack.includes(stripped)) return true;
    if (rawPattern.includes('*') || rawPattern.includes('?')) {
      try {
        const regexStr = rawPattern
          .split('*')
          .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
          .join('.*')
          .replace(/\?/g, '.');
        const regex = new RegExp(regexStr, 'i');
        if (regex.test(haystack)) return true;
      } catch (e) {
        /* fallback */
      }
    }
    return false;
  }

  function matchesExcludedTitle(title, patterns) {
    if (!title || !patterns || !patterns.length) return false;
    return patterns.some((pattern) => matchTitleRule(title, pattern));
  }

  function extractUserCandidates(user) {
    if (!user) return [];
    if (typeof user === 'string') return [user];
    const candidates = [
      user.login,
      user.display_name,
      user.displayName,
      user.nickname,
      user.username,
      user.name,
      user.email,
      user.emailAddress,
    ].filter(Boolean);

    if (user.raw && typeof user.raw === 'string') {
      candidates.push(user.raw);
    }

    if (user.user && typeof user.user === 'object') {
      candidates.push(...extractUserCandidates(user.user));
    }

    if (!candidates.length) {
      if (user.uuid) candidates.push(user.uuid);
      if (user.account_id) candidates.push(user.account_id);
      if (user.accountId) candidates.push(user.accountId);
    }
    return candidates;
  }

  function matchSingleUserAndPattern(rawCandidate, rawPattern) {
    const cleanCand = String(rawCandidate || '').trim();
    const cleanPatt = String(rawPattern || '').trim();
    if (!cleanCand || !cleanPatt) return false;

    const candEmailStripped = cleanCand.replace(/@.+$/, '').trim();
    const pattEmailStripped = cleanPatt.replace(/@.+$/, '').trim();

    // 1. Direct case-insensitive match (with or without email domain)
    const lowerCand = cleanCand.toLowerCase();
    const lowerPatt = cleanPatt.toLowerCase();
    const lowerCandNoMail = candEmailStripped.toLowerCase();
    const lowerPattNoMail = pattEmailStripped.toLowerCase();

    if (lowerCand === lowerPatt || lowerCandNoMail === lowerPattNoMail) return true;
    if (lowerCand.includes(lowerPattNoMail) || lowerCandNoMail.includes(lowerPattNoMail)) return true;
    if (lowerPattNoMail.includes(lowerCandNoMail) && lowerCandNoMail.length >= 3) return true;

    // 2. Normalized matching (with umlaut translation ä->ae, etc.)
    const candNorm = normalizeName(cleanCand);
    const pattNorm = normalizeName(pattEmailStripped);
    if (!candNorm || !pattNorm) return false;

    if (candNorm === pattNorm) return true;
    if (candNorm.includes(pattNorm)) return true;
    if (pattNorm.includes(candNorm) && candNorm.length >= 3) return true;

    // 3. Vowel-collapsed matching (e.g. mueller vs muller)
    const candVowel = collapseVowels(candNorm);
    const pattVowel = collapseVowels(pattNorm);
    if (candVowel === pattVowel) return true;
    if (candVowel.includes(pattVowel)) return true;
    if (pattVowel.includes(candVowel) && candVowel.length >= 3) return true;

    // 4. Token-based matching
    const candTokens = tokenizeName(cleanCand);
    const pattTokens = tokenizeName(pattEmailStripped);

    if (pattTokens.length >= 2) {
      const allTokensMatch = pattTokens.every((pt) => {
        const ptVowel = collapseVowels(pt);
        return candTokens.some((ct) => ct === pt || collapseVowels(ct) === ptVowel || ct.includes(pt));
      });
      if (allTokensMatch) return true;
    }

    if (candTokens.length >= 2) {
      const allCandTokensMatch = candTokens.every((ct) => {
        const ctVowel = collapseVowels(ct);
        return pattTokens.some((pt) => pt === ct || collapseVowels(pt) === ctVowel || pt.includes(ct));
      });
      if (allCandTokensMatch) return true;
    }

    // 5. Initial + Lastname matching (e.g. "a.mueller" <-> "Anna Müller")
    if (pattTokens.length === 2 && pattTokens[0].length === 1 && pattTokens[1].length >= 2) {
      const initial = pattTokens[0];
      const lastName = pattTokens[1];
      const lastNameVowel = collapseVowels(lastName);

      const hasLastName = candTokens.some((ct) => ct === lastName || collapseVowels(ct) === lastNameVowel);
      const hasInitial = candTokens.some((ct) => ct.startsWith(initial));
      if (hasLastName && hasInitial) return true;
    }

    if (candTokens.length === 2 && candTokens[0].length === 1 && candTokens[1].length >= 2) {
      const initial = candTokens[0];
      const lastName = candTokens[1];
      const lastNameVowel = collapseVowels(lastName);

      const hasLastName = pattTokens.some((pt) => pt === lastName || collapseVowels(pt) === lastNameVowel);
      const hasInitial = pattTokens.some((pt) => pt.startsWith(initial));
      if (hasLastName && hasInitial) return true;
    }

    // Single token initial + last (e.g. "amueller")
    if (pattTokens.length === 1 && pattNorm.length >= 4 && candTokens.length >= 2) {
      const candInitial = candTokens[0][0];
      const candLast = candTokens[candTokens.length - 1];
      if (pattNorm === candInitial + candLast || pattVowel === candInitial + collapseVowels(candLast)) return true;
    }

    if (candTokens.length === 1 && candNorm.length >= 4 && pattTokens.length >= 2) {
      const pattInitial = pattTokens[0][0];
      const pattLast = pattTokens[pattTokens.length - 1];
      if (candNorm === pattInitial + pattLast || candVowel === pattInitial + collapseVowels(pattLast)) return true;
    }

    return false;
  }

  function matchesTeamMember(user, teamList) {
    if (!teamList || !teamList.length) return true;
    if (!user) return false;

    const rawCandidates = extractUserCandidates(user);
    if (!rawCandidates.length) return false;

    return teamList.some((memberPattern) => {
      const rawPattern = String(memberPattern || '').trim();
      if (!rawPattern) return false;
      return rawCandidates.some((candidate) => matchSingleUserAndPattern(candidate, rawPattern));
    });
  }

  function prMatchesTeam(pr, teamMembers) {
    if (!teamMembers || !teamMembers.length) return true;
    if (!pr) return false;
    if (matchesTeamMember(pr.author, teamMembers)) return true;
    const participants = Array.isArray(pr.participants) ? pr.participants : [];
    if (participants.some((p) => p && (matchesTeamMember(p.user, teamMembers) || matchesTeamMember(p, teamMembers)))) return true;
    const reviewers = Array.isArray(pr.reviewers) ? pr.reviewers : [];
    if (reviewers.some((r) => r && matchesTeamMember(r, teamMembers))) return true;
    if (pr.issue && pr.issue.assignee && matchesTeamMember(pr.issue.assignee, teamMembers)) return true;
    if (pr.issue && pr.issue.author && matchesTeamMember(pr.issue.author, teamMembers)) return true;
    if (pr.issue && pr.issue.reporter && matchesTeamMember(pr.issue.reporter, teamMembers)) return true;
    return false;
  }

  function prSizeCategory(diff) {
    const additions = Math.max(0, Number(diff && diff.additions) || 0);
    const deletions = Math.max(0, Number(diff && diff.deletions) || 0);
    const changedFiles = Math.max(0, Number(diff && diff.changedFiles) || 0);
    const total = additions + deletions;

    if (total >= 1000 || changedFiles >= 30) return 'XXL';
    if (total >= 500 || changedFiles >= 15) return 'XL';
    if (total >= 200 || changedFiles >= 8) return 'L';
    if (total >= 60 || changedFiles >= 4) return 'M';
    if (total >= 10 || changedFiles >= 2) return 'S';
    return 'XS';
  }

  function getLevelInfo(score) {
    if (score >= 1000) return { level: 6, title: 'Legendary Reviewer', icon: '👑', color: '#f59e0b' };
    if (score >= 600) return { level: 5, title: 'Code Titan', icon: '🥇', color: '#eab308' };
    if (score >= 300) return { level: 4, title: 'Master Reviewer', icon: '🥈', color: '#a855f7' };
    if (score >= 150) return { level: 3, title: 'Code Guardian', icon: '🥉', color: '#3b82f6' };
    if (score >= 50) return { level: 2, title: 'Active Reviewer', icon: '⚡', color: '#06b6d4' };
    return { level: 1, title: 'Code Scout', icon: '🌱', color: '#10b981' };
  }

  /**
   * Collapse reviewers, approvals and change requests from `participants`.
   * An approval counts as stale when it predates the head commit, which is what
   * Bitbucket's own merge check does when approvals survive a push.
   */
  function summarizeReviews(pr) {
    const headDate = Date.parse((pr && pr.source && pr.source.commit && pr.source.commit.date) || '') || 0;
    const authorId = identity(pr && pr.author);
    const reviewers = Array.isArray(pr && pr.reviewers) ? pr.reviewers : [];
    const participants = Array.isArray(pr && pr.participants) ? pr.participants : [];

    const approvals = [];
    const staleApprovals = [];
    const changesRequested = [];
    const acted = new Set();

    participants.forEach((participant) => {
      const user = participant && participant.user;
      if (!user) return;
      const id = identity(user);
      if (id && authorId && id === authorId) return;
      const approved = participant.approved === true || String(participant.state || '') === 'approved';
      const changesRequestedState = String(participant.state || '') === 'changes_requested';

      if (approved) {
        acted.add(id);
        const at = Date.parse(participant.participated_on || '') || 0;
        const entry = Object.assign(person(user), { at });
        if (headDate && at && at < headDate) staleApprovals.push(entry);
        else approvals.push(entry);
        return;
      }
      if (changesRequestedState) {
        acted.add(id);
        changesRequested.push(Object.assign(person(user), {
          at: Date.parse(participant.participated_on || '') || 0,
        }));
      }
    });

    const pendingById = new Map();
    participants.forEach((participant) => {
      if (!participant || String(participant.role || '').toUpperCase() !== 'REVIEWER') return;
      const user = participant.user;
      if (!user) return;
      const id = identity(user);
      if (!id || acted.has(id) || (authorId && id === authorId)) return;
      pendingById.set(id, person(user));
    });
    reviewers.forEach((user) => {
      const id = identity(user);
      if (!id || acted.has(id) || (authorId && id === authorId)) return;
      pendingById.set(id, person(user));
    });

    return {
      headDate,
      approvals,
      staleApprovals,
      changesRequested,
      pendingReviewers: Array.from(pendingById.values()),
      hasApproval: approvals.length > 0,
      hasStaleApproval: staleApprovals.length > 0,
      hasChangesRequested: changesRequested.length > 0,
    };
  }

  function evaluatePullRequest(pr, options) {
    const opts = options || {};
    const summary = summarizeReviews(pr);
    const reviewRequested = summary.pendingReviewers.length > 0;

    if (summary.hasChangesRequested) {
      return { keep: true, state: 'changes_requested', summary, reviewRequested };
    }
    if (summary.hasApproval) {
      return { keep: false, state: 'approved', summary, reviewRequested };
    }
    if (summary.hasStaleApproval && !opts.treatStaleApprovalsAsUnapproved) {
      // Bitbucket treats a surviving approval as "mergeable"; only surface the
      // PR when the operator explicitly distrusts stale approvals.
      return { keep: false, state: 'approved', summary, reviewRequested };
    }
    if (reviewRequested) {
      return { keep: true, state: 'review_requested', summary, reviewRequested };
    }
    if (summary.hasStaleApproval) {
      return { keep: true, state: 'stale_approval', summary, reviewRequested };
    }
    return { keep: true, state: 'needs_review', summary, reviewRequested };
  }

  function buildReasons(state, ci) {
    const reasons = [];
    if (state === 'changes_requested') reasons.push('changes requested');
    else if (state === 'stale_approval') reasons.push('stale approval');
    else reasons.push('awaiting review');

    if (ci && ci.state === 'failing') reasons.push('builds failing');
    else if (ci && ci.state === 'pending') reasons.push('builds running');

    return reasons;
  }

  function toCard(pr, evaluation, ci, diff) {
    const summary = evaluation.summary;
    const stats = diff || { additions: 0, deletions: 0, changedFiles: 0 };
    const source = pr.source || {};
    const destination = pr.destination || {};
    const sourceRepo = source.repository && source.repository.full_name;
    const destinationRepo = destination.repository && destination.repository.full_name;

    return {
      number: Number(pr.id) || 0,
      title: String(pr.title || ''),
      url: String((pr.links && pr.links.html && pr.links.html.href) || ''),
      draft: Boolean(pr.draft),
      commentCount: Number(pr.comment_count) || 0,
      createdAt: Date.parse(pr.created_on || '') || Date.now(),
      updatedAt: Date.parse(pr.updated_on || '') || Date.now(),
      author: person(pr.author),
      requestedReviewers: summary.pendingReviewers,
      branches: {
        base: String((destination.branch && destination.branch.name) || ''),
        head: String((source.branch && source.branch.name) || ''),
        headSha: String((source.commit && source.commit.hash) || ''),
        isFork: Boolean(sourceRepo && destinationRepo && sourceRepo !== destinationRepo),
      },
      diff: {
        additions: Number(stats.additions) || 0,
        deletions: Number(stats.deletions) || 0,
        changedFiles: Number(stats.changedFiles) || 0,
      },
      review: {
        state: evaluation.state,
        approvedBy: summary.approvals.map((entry) => ({ login: entry.login, avatarUrl: entry.avatarUrl })),
        staleApprovals: summary.staleApprovals.map((entry) => ({
          login: entry.login,
          avatarUrl: entry.avatarUrl,
          at: entry.at,
        })),
        changesRequestedBy: summary.changesRequested.map((entry) => ({ login: entry.login, avatarUrl: entry.avatarUrl })),
        reviewRequested: evaluation.reviewRequested,
      },
      ci: ci || { state: 'unknown', total: 0, failed: 0, pending: 0, passed: 0, stopped: 0, source: 'none' },
      reasons: buildReasons(evaluation.state, ci),
      priority: PRIORITY[evaluation.state] !== undefined ? PRIORITY[evaluation.state] : 9,
    };
  }

  function compareCards(a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aFailing = a.ci && a.ci.state === 'failing' ? 0 : 1;
    const bFailing = b.ci && b.ci.state === 'failing' ? 0 : 1;
    if (aFailing !== bFailing) return aFailing - bFailing;
    return a.createdAt - b.createdAt;
  }

  function encodeBasic(username, secret) {
    const raw = `${username}:${secret}`;
    if (typeof btoa === 'function') return btoa(raw);
    return Buffer.from(raw, 'utf8').toString('base64');
  }

  function authorizationHeader(settings) {
    const token = String(settings.token || '').trim();
    if (!token) return '';
    if (String(settings.authMode || 'basic') === 'bearer') return `Bearer ${token}`;
    const username = String(settings.username || '').trim();
    return `Basic ${encodeBasic(username, token)}`;
  }

  function createClient(settings, options) {
    const opts = options || {};
    const baseUrl = String(settings.apiBaseUrl || DEFAULT_API_BASE).replace(/\/+$/, '');
    const authorization = authorizationHeader(settings);
    const cache = opts.cache || createMemoryCache();
    const fetchImpl = opts.fetch || global.fetch;
    const userAgent = opts.userAgent || 'ReviewBoard/1.1';
    const stats = { requests: 0, cacheHits: 0, networkErrors: 0 };
    const rateLimit = { limit: null, remaining: null, resetAt: 0, retryAfterSeconds: 0 };

    if (typeof fetchImpl !== 'function') {
      throw new BitbucketError('No fetch implementation available in this environment.', { kind: 'network' });
    }

    const workspace = encodeURIComponent(settings.workspace);
    const slug = encodeURIComponent(settings.repoSlug);

    function repoPath(suffix) {
      return `/repositories/${workspace}/${slug}${suffix || ''}`;
    }

    function bodyMessage(body) {
      if (!body) return '';
      if (body.error && body.error.message) return String(body.error.message);
      if (body.message) return String(body.message);
      return '';
    }

    async function readBody(response) {
      const text = await response.text().catch(() => '');
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (error) {
        return { message: text.slice(0, 300) };
      }
    }

    function updateRateLimit(headers) {
      const retryAfterSeconds = readRetryAfter(headers);
      if (retryAfterSeconds) {
        rateLimit.retryAfterSeconds = retryAfterSeconds;
        rateLimit.resetAt = Date.now() + retryAfterSeconds * 1000;
      }
      if (opts.onRateLimit) {
        try {
          opts.onRateLimit(Object.assign({}, rateLimit));
        } catch (error) {
          /* observer must never break a fetch */
        }
      }
      return retryAfterSeconds;
    }

    /**
     * GET with ETag conditional requests. Bitbucket answers 304 for unchanged
     * resources, which keeps a 60s wallboard from burning the request budget.
     */
    async function request(path, requestOptions) {
      const reqOpts = requestOptions || {};
      const method = reqOpts.method || 'GET';
      const cacheKey = reqOpts.cacheKey || null;
      const url = /^https?:\/\//i.test(path) ? path : baseUrl + path;
      const headers = { Accept: reqOpts.accept || 'application/json' };
      if (authorization) headers.Authorization = authorization;
      if (userAgent) headers['User-Agent'] = userAgent;

      let cachedEntry = null;
      if (cacheKey && method === 'GET') {
        cachedEntry = await cache.get(cacheKey);
        if (cachedEntry && cachedEntry.etag) headers['If-None-Match'] = cachedEntry.etag;
      }

      stats.requests += 1;
      let response;
      try {
        response = await fetchImpl(url, { method, headers, cache: 'no-store' });
      } catch (networkError) {
        stats.networkErrors += 1;
        if (cachedEntry && cachedEntry.data) {
          stats.cacheHits += 1;
          return { data: cachedEntry.data, fromCache: true, stale: true };
        }
        throw new BitbucketError(`Network error contacting ${baseUrl}: ${networkError.message}`, { kind: 'network' });
      }

      const retryAfterSeconds = updateRateLimit(response.headers);

      if (response.status === 304) {
        if (cachedEntry && cachedEntry.data) {
          stats.cacheHits += 1;
          return { data: cachedEntry.data, fromCache: true, stale: false };
        }
        throw new BitbucketError('Bitbucket answered 304 but no cached payload exists.', { kind: 'http', status: 304 });
      }

      if (response.status === 401) {
        throw new BitbucketError(
          'Bitbucket rejected the credentials (401). Check the email/API token pair (or the access token) and that it has pull request read access.',
          { kind: 'auth', status: 401 },
        );
      }

      if (response.status === 429 || response.status === 403) {
        const body = await readBody(response);
        const message = bodyMessage(body);
        const rateLimited = response.status === 429 || /rate limit|too many requests/i.test(message);
        if (rateLimited) {
          const retryAt = retryAfterSeconds ? Date.now() + retryAfterSeconds * 1000 : Date.now() + 60 * 1000;
          throw new BitbucketError(
            `Bitbucket rate limit reached. Next attempt after ${new Date(retryAt).toLocaleTimeString()}.`,
            { kind: 'rate_limit', status: response.status, retryAt },
          );
        }
        throw new BitbucketError(
          message || 'Bitbucket denied the request (403). The token is probably missing a pull request scope.',
          { kind: 'forbidden', status: 403, details: message },
        );
      }

      if (response.status === 404) {
        throw new BitbucketError(
          `${settings.workspace}/${settings.repoSlug} not found (404). Use the lowercase URL slug and check that the token can see the repository.`,
          { kind: 'not_found', status: 404 },
        );
      }

      if (!response.ok) {
        const body = await readBody(response);
        throw new BitbucketError(
          `Bitbucket request failed (${response.status}): ${bodyMessage(body) || response.statusText || 'unknown error'}`,
          { kind: 'http', status: response.status, details: bodyMessage(body) },
        );
      }

      const data = await response.json().catch(() => null);
      const etag = response.headers.get('etag');
      // A null payload could never satisfy a later 304, so do not cache it.
      if (cacheKey && data) {
        try {
          await cache.set(cacheKey, { etag: etag || null, data, storedAt: Date.now() });
        } catch (error) {
          /* cache is best effort */
        }
      }

      return { data, fromCache: false, stale: false };
    }

    async function getRepository() {
      const result = await request(repoPath(''), { cacheKey: `repo:${workspace}/${slug}` });
      return result.data || {};
    }

    async function listOpenPullRequests(config) {
      const cfg = config || {};
      const pagelen = Math.max(1, Math.min(Number(cfg.pagelen) || 50, 100));
      const maxPages = Math.max(1, Math.min(Number(cfg.maxPages) || 5, 10));
      const query = new URLSearchParams({
        state: 'OPEN',
        pagelen: String(pagelen),
        sort: '-created_on',
        fields: LIST_FIELDS,
      });

      let next = repoPath(`/pullrequests?${query.toString()}`);
      const values = [];
      let total = null;
      let page = 0;

      while (next && page < maxPages) {
        page += 1;
        const result = await request(next, { cacheKey: `pulls:${workspace}/${slug}:p${page}:${pagelen}` });
        const data = result.data || {};
        if (Array.isArray(data.values)) values.push.apply(values, data.values);
        if (total === null && Number.isFinite(Number(data.size))) total = Number(data.size);
        next = typeof data.next === 'string' ? data.next : null;
      }

      return { values, total: total === null ? values.length : total };
    }

    async function listRecentPullRequests(days) {
      const pagelen = 50;
      const cutoff = Date.now() - (Number(days) || 10) * 24 * 3600 * 1000;
      const query = new URLSearchParams({
        pagelen: String(pagelen),
        sort: '-updated_on',
        fields: [
          'values.id',
          'values.title',
          'values.state',
          'values.created_on',
          'values.updated_on',
          'values.comment_count',
          'values.task_count',
          'values.author',
          'values.participants',
          'values.source.branch.name',
          'values.source.commit.hash',
          'values.links.html',
          'next',
        ].join(','),
      });

      let next = repoPath(`/pullrequests?${query.toString()}`);
      const values = [];
      let page = 0;

      while (next && page < 3) {
        page += 1;
        let result;
        try {
          result = await request(next, { cacheKey: `pulls_recent:${workspace}/${slug}:p${page}:${pagelen}` });
        } catch (error) {
          break;
        }
        const data = result.data || {};
        const pageValues = Array.isArray(data.values) ? data.values : [];
        if (!pageValues.length) break;
        values.push.apply(values, pageValues);

        const oldestOnPage = Math.min(
          ...pageValues.map((pr) => Math.max(Date.parse(pr.updated_on || '') || 0, Date.parse(pr.created_on || '') || 0))
        );
        if (oldestOnPage > 0 && oldestOnPage < cutoff) {
          break;
        }
        next = typeof data.next === 'string' ? data.next : null;
        if (result.fromCache && pageValues.length < pagelen) break;
      }

      return values.filter((pr) => {
        const updated = Date.parse((pr && pr.updated_on) || '') || 0;
        const created = Date.parse((pr && pr.created_on) || '') || 0;
        return updated >= cutoff || created >= cutoff;
      });
    }

    async function getPullRequestComments(id, updatedOn) {
      if (!id) return [];
      const version = String(updatedOn || '');
      let next = repoPath(`/pullrequests/${Number(id)}/comments?pagelen=100`);
      const values = [];
      let page = 0;

      while (next && page < 3) {
        page += 1;
        let result;
        try {
          result = await request(next, {
            cacheKey: `comments:${workspace}/${slug}#${id}@${version}:p${page}`,
          });
        } catch (error) {
          if (isFatalError(error)) throw error;
          break;
        }
        const data = result.data || {};
        if (Array.isArray(data.values)) values.push.apply(values, data.values);
        next = typeof data.next === 'string' ? data.next : null;
      }

      return values;
    }

    async function getDiffstat(id, headSha) {
      if (headSha) {
        const diffKey = `diffstat_v2:${workspace}/${slug}#${id}@${headSha}`;
        try {
          const cached = await cache.get(diffKey);
          if (cached && cached.data) {
            return cached.data;
          }
        } catch (e) {
          /* proceed */
        }
      }

      const query = '?pagelen=100';
      let next = repoPath(`/pullrequests/${Number(id)}/diffstat${query}`);
      const totals = { additions: 0, deletions: 0, changedFiles: 0 };
      let page = 0;

      while (next && page < 3) {
        page += 1;
        const result = await request(next, {
          cacheKey: `diffstat:${workspace}/${slug}#${id}@${headSha}:p${page}`,
        });
        const data = result.data || {};
        const values = Array.isArray(data.values) ? data.values : [];
        values.forEach((file) => {
          totals.additions += Number(file.lines_added) || 0;
          totals.deletions += Number(file.lines_removed) || 0;
        });
        totals.changedFiles = Math.max(totals.changedFiles, Number(data.size) || 0, values.length);
        next = typeof data.next === 'string' ? data.next : null;
        if (result.fromCache) break;
      }

      if (headSha) {
        const diffKey = `diffstat_v2:${workspace}/${slug}#${id}@${headSha}`;
        try {
          await cache.set(diffKey, { data: totals, storedAt: Date.now() });
        } catch (e) {}
      }

      return totals;
    }

    async function getPullRequestStatuses(id, headSha) {
      if (!id) {
        return { state: 'unknown', total: 0, failed: 0, pending: 0, passed: 0, stopped: 0, source: 'none' };
      }
      let next = repoPath(`/pullrequests/${Number(id)}/statuses?pagelen=100`);
      const entries = [];
      let page = 0;

      while (next && page < 3) {
        page += 1;
        const result = await request(next, {
          cacheKey: `statuses:${workspace}/${slug}#${id}@${headSha}:p${page}`,
        });
        const data = result.data || {};
        if (Array.isArray(data.values)) entries.push.apply(entries, data.values);
        next = typeof data.next === 'string' ? data.next : null;
      }

      return Object.assign({ sha: headSha || '' }, summarizeStatuses({ values: entries }));
    }

    async function fetchWallboard(config) {
      const cfg = Object.assign(
        {
          maxPullRequests: 25,
          includeDrafts: false,
          onlyRequestedReviewers: false,
          treatStaleApprovalsAsUnapproved: false,
          includeSourceBranches: [],
          excludeSourceBranches: [],
          excludeTitlePatterns: [],
          teamMembers: [],
          concurrency: 4,
          listPages: 5,
          scoreboardMaxPrs: 50,
        },
        config || {},
      );

      const repository = await getRepository().catch((error) => {
        if (error.kind === 'auth' || error.kind === 'rate_limit' || error.kind === 'not_found' || error.kind === 'forbidden') {
          throw error;
        }
        return {};
      });

      const list = await listOpenPullRequests({
        pagelen: 50,
        maxPages: cfg.listPages,
      });

      const warnings = [];
      const skipped = {
        drafts: 0,
        branches: 0,
        titles: 0,
        team: 0,
        notRequested: 0,
        approved: 0,
        overLimit: 0,
      };

      const candidates = [];
      list.values.forEach((pr) => {
        if (!pr || String(pr.state || 'OPEN') !== 'OPEN') return;
        if (pr.draft && !cfg.includeDrafts) {
          skipped.drafts += 1;
          return;
        }

        const branchName = pr.source && pr.source.branch && pr.source.branch.name;
        if (!matchesIncludedBranch(branchName, cfg.includeSourceBranches)) {
          skipped.branches += 1;
          return;
        }
        if (matchesExcludedBranch(branchName, cfg.excludeSourceBranches)) {
          skipped.branches += 1;
          return;
        }
        if (matchesExcludedTitle(pr.title, cfg.excludeTitlePatterns)) {
          skipped.titles += 1;
          return;
        }
        if (cfg.teamMembers && cfg.teamMembers.length > 0 && !prMatchesTeam(pr, cfg.teamMembers)) {
          skipped.team += 1;
          return;
        }

        const evaluation = evaluatePullRequest(pr, cfg);
        if (!evaluation.keep) {
          skipped.approved += 1;
          return;
        }
        if (cfg.onlyRequestedReviewers && !evaluation.reviewRequested) {
          skipped.notRequested += 1;
          return;
        }
        if (candidates.length >= cfg.maxPullRequests) {
          skipped.overLimit += 1;
          return;
        }
        candidates.push({ pr, evaluation });
      });

      const withDetails = await mapLimit(candidates, cfg.concurrency, async (entry) => {
        const headSha = entry.pr.source && entry.pr.source.commit && entry.pr.source.commit.hash;
        const [diff, ci] = await Promise.all([
          (async () => {
            try {
              return await getDiffstat(entry.pr.id, headSha);
            } catch (error) {
              if (error.kind === 'auth' || error.kind === 'rate_limit' || error.kind === 'not_found' || error.kind === 'forbidden') {
                throw error;
              }
              warnings.push(`#${entry.pr.id}: could not load diff stats (${error.message})`);
              return null;
            }
          })(),
          (async () => {
            try {
              return await getPullRequestStatuses(entry.pr.id, headSha);
            } catch (error) {
              if (error.kind === 'auth' || error.kind === 'rate_limit' || error.kind === 'not_found' || error.kind === 'forbidden') {
                throw error;
              }
              warnings.push(`#${entry.pr.id}: could not load build status (${error.message})`);
              return { state: 'unknown', total: 0, failed: 0, pending: 0, passed: 0, stopped: 0, source: 'error' };
            }
          })(),
        ]);
        return { entry, diff, ci };
      });

      const pullRequests = withDetails
        .map(({ entry, diff, ci }) => toCard(entry.pr, entry.evaluation, ci, diff))
        .sort(compareCards);

      const counts = {
        needingReview: pullRequests.length,
        changesRequested: pullRequests.filter((card) => card.review.state === 'changes_requested').length,
        reviewRequested: pullRequests.filter((card) => card.review.state === 'review_requested').length,
        staleApprovals: pullRequests.filter((card) => card.review.state === 'stale_approval').length,
        failingChecks: pullRequests.filter((card) => card.ci.state === 'failing').length,
        pendingChecks: pullRequests.filter((card) => card.ci.state === 'pending').length,
        oldestCreatedAt: pullRequests.length ? Math.min.apply(null, pullRequests.map((card) => card.createdAt)) : 0,
      };

      const mainBranch = repository.mainbranch && repository.mainbranch.name;

      // ------------------------------------------------------------------
      // Scoreboard calculation (Gamification for last 10 days only)
      // ------------------------------------------------------------------
      const days = 10;
      const cutoffTime = Date.now() - days * 24 * 3600 * 1000;
      let recentPrs = [];
      try {
        recentPrs = await listRecentPullRequests(days);
      } catch (error) {
        recentPrs = [];
      }

      // Use the same visibility rules as the wallboard and a hard cap: each
      // extra PR costs diffstat + comment requests on the first refresh.
      const scoreboardMaxPrs = Math.max(1, Math.min(Number(cfg.scoreboardMaxPrs) || 50, 150));
      const filteredRecentPrs = recentPrs
        .filter((pr) => {
          if (pr.draft && !cfg.includeDrafts) return false;
          const bName = pr.source && pr.source.branch && pr.source.branch.name;
          if (!matchesIncludedBranch(bName, cfg.includeSourceBranches)) return false;
          if (matchesExcludedBranch(bName, cfg.excludeSourceBranches)) return false;
          if (matchesExcludedTitle(pr.title, cfg.excludeTitlePatterns)) return false;
          return true;
        })
        .slice(0, scoreboardMaxPrs);

      const diffCache = new Map();
      withDetails.forEach(({ entry, diff }) => {
        if (entry && entry.pr && diff) {
          diffCache.set(entry.pr.id, diff);
        }
      });

      const recentDetails = await mapLimit(filteredRecentPrs, cfg.concurrency, async (pr) => {
        const id = pr.id;
        const headSha = pr.source && pr.source.commit && pr.source.commit.hash;
        let diff = diffCache.get(id);
        if (!diff) {
          try {
            diff = await getDiffstat(id, headSha);
            diffCache.set(id, diff);
          } catch (e) {
            diff = { additions: 0, deletions: 0, changedFiles: 0 };
          }
        }
        let comments = [];
        if (Number(pr.comment_count) > 0) {
          try {
            comments = await getPullRequestComments(id, pr.updated_on);
          } catch (error) {
            if (isFatalError(error)) throw error;
            comments = [];
          }
        }
        return { pr, diff, comments };
      });

      const userMap = new Map();

      // If team members are configured, pre-populate all team members so they appear on the scoreboard
      if (Array.isArray(cfg.teamMembers) && cfg.teamMembers.length > 0) {
        cfg.teamMembers.forEach((memberPattern) => {
          const raw = String(memberPattern || '').trim();
          if (!raw) return;
          const cleanName = raw.replace(/@.+$/, '').replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          const key = normalizeName(raw) || raw.toLowerCase();
          if (key && !userMap.has(key)) {
            userMap.set(key, {
              rawPattern: raw,
              user: {
                login: cleanName,
                avatarUrl: '',
                url: '',
                uuid: '',
                nickname: raw,
                displayName: cleanName,
                accountId: '',
              },
              totalScore: 0,
              stats: {
                reviewsCount: 0,
                reviewsBySize: { XS: 0, S: 0, M: 0, L: 0, XL: 0, XXL: 0 },
                commentsCount: 0,
                approvalsCount: 0,
                changesRequestedCount: 0,
                prsCreatedCount: 0,
                prsMergedCount: 0,
              },
              pointsBreakdown: {
                reviews: 0,
                comments: 0,
                prsCreated: 0,
                prsMerged: 0,
              },
            });
          }
        });
      }

      function getUserRecord(rawUser) {
        if (!rawUser) return null;
        if (cfg.teamMembers && cfg.teamMembers.length > 0 && !matchesTeamMember(rawUser, cfg.teamMembers)) {
          return null;
        }

        // Prefer stable account IDs over fuzzy name matching: otherwise similar
        // team-member names can steal each other's points.
        const stableId = identity(rawUser);
        if (stableId) {
          for (const entry of userMap.values()) {
            const ids = [entry.user.accountId, entry.user.uuid].filter(Boolean);
            if (ids.includes(stableId)) return entry;
          }
        }

        // Search userMap for existing team entry to match and enrich
        for (const entry of userMap.values()) {
          const testList = [entry.rawPattern, entry.user.nickname, entry.user.login, entry.user.displayName].filter(Boolean);
          if (matchesTeamMember(rawUser, testList)) {
            const p = person(rawUser);
            if (p.avatarUrl && !entry.user.avatarUrl) entry.user.avatarUrl = p.avatarUrl;
            if (p.login && p.login !== 'unknown' && (!entry.user.login || entry.user.login === entry.rawPattern)) {
              entry.user.login = p.login;
            }
            if (p.url && !entry.user.url) entry.user.url = p.url;
            if (p.uuid && !entry.user.uuid) entry.user.uuid = p.uuid;
            return entry;
          }
        }

        const id = identity(rawUser) || normalizeName(displayName(rawUser));
        if (!id) return null;
        if (!userMap.has(id)) {
          userMap.set(id, {
            rawPattern: '',
            user: person(rawUser),
            totalScore: 0,
            stats: {
              reviewsCount: 0,
              reviewsBySize: { XS: 0, S: 0, M: 0, L: 0, XL: 0, XXL: 0 },
              commentsCount: 0,
              approvalsCount: 0,
              changesRequestedCount: 0,
              prsCreatedCount: 0,
              prsMergedCount: 0,
            },
            pointsBreakdown: {
              reviews: 0,
              comments: 0,
              prsCreated: 0,
              prsMerged: 0,
            },
          });
        }
        return userMap.get(id);
      }

      recentDetails.forEach(({ pr, diff, comments }) => {
        const prCreated = Date.parse(pr.created_on || '') || 0;
        const prUpdated = Date.parse(pr.updated_on || '') || 0;
        const authorId = identity(pr.author);
        const authorRecord = getUserRecord(pr.author);

        if (authorRecord && prCreated >= cutoffTime) {
          authorRecord.totalScore += SCORE_POINTS.prCreated;
          authorRecord.stats.prsCreatedCount += 1;
          authorRecord.pointsBreakdown.prsCreated += SCORE_POINTS.prCreated;
        }

        if (authorRecord && String(pr.state).toUpperCase() === 'MERGED' && prUpdated >= cutoffTime) {
          authorRecord.totalScore += SCORE_POINTS.prMerged;
          authorRecord.stats.prsMergedCount += 1;
          authorRecord.pointsBreakdown.prsMerged += SCORE_POINTS.prMerged;
        }

        const sizeCategory = prSizeCategory(diff);
        const reviewBasePoints = SCORE_POINTS.reviews[sizeCategory] || 10;
        const participants = Array.isArray(pr.participants) ? pr.participants : [];

        participants.forEach((participant) => {
          const user = participant && participant.user;
          if (!user) return;
          const uId = identity(user);
          if (uId && authorId && uId === authorId) return;

          const pTime = Date.parse(participant.participated_on || '') || prUpdated;
          if (pTime < cutoffTime) return;

          const approved = participant.approved === true || String(participant.state || '') === 'approved';
          const changesReq = String(participant.state || '') === 'changes_requested';

          if (approved || changesReq) {
            const reviewer = getUserRecord(user);
            if (!reviewer) return;

            let pts = reviewBasePoints;
            if (changesReq) pts += SCORE_POINTS.changesRequestedBonus;

            reviewer.totalScore += pts;
            reviewer.stats.reviewsCount += 1;
            reviewer.stats.reviewsBySize[sizeCategory] = (reviewer.stats.reviewsBySize[sizeCategory] || 0) + 1;
            reviewer.pointsBreakdown.reviews += pts;

            if (approved) reviewer.stats.approvalsCount += 1;
            if (changesReq) reviewer.stats.changesRequestedCount += 1;
          }
        });

        (comments || []).forEach((comment) => {
          if (!comment || comment.deleted) return;
          const cTime = Date.parse(comment.created_on || '') || 0;
          if (cTime < cutoffTime) return;
          const commenterId = identity(comment.user);
          if (commenterId && authorId && commenterId === authorId) return;

          const commenter = getUserRecord(comment.user);
          if (!commenter) return;

          commenter.totalScore += SCORE_POINTS.comment;
          commenter.stats.commentsCount += 1;
          commenter.pointsBreakdown.comments += SCORE_POINTS.comment;
        });
      });

      const rankedUsers = Array.from(userMap.values())
        .filter((entry) => {
          if (!entry) return false;
          if (cfg.teamMembers && cfg.teamMembers.length > 0) {
            return matchesTeamMember(entry.user, cfg.teamMembers);
          }
          return entry.totalScore > 0;
        })
        .sort((a, b) => b.totalScore - a.totalScore)
        .map((entry, index) => {
          return Object.assign({}, entry, {
            rank: index + 1,
            level: getLevelInfo(entry.totalScore),
          });
        });

      const scoreboard = {
        periodDays: days,
        since: cutoffTime,
        users: rankedUsers,
        totalPoints: rankedUsers.reduce((sum, u) => sum + u.totalScore, 0),
        totalReviews: rankedUsers.reduce((sum, u) => sum + u.stats.reviewsCount, 0),
        totalComments: rankedUsers.reduce((sum, u) => sum + u.stats.commentsCount, 0),
        activeContributors: rankedUsers.length,
      };

      return {
        fetchedAt: Date.now(),
        repo: {
          workspace: settings.workspace,
          name: settings.repoSlug,
          fullName: String(repository.full_name || `${settings.workspace}/${settings.repoSlug}`),
          defaultBranch: String(mainBranch || ''),
          isPrivate: Boolean(repository.is_private),
          url: String((repository.links && repository.links.html && repository.links.html.href) || `https://bitbucket.org/${settings.workspace}/${settings.repoSlug}`),
          openPullRequests: list.total,
        },
        pullRequests,
        counts,
        scoreboard,
        skipped,
        warnings,
        rateLimit: Object.assign({}, rateLimit),
        cache: Object.assign({}, stats),
      };
    }

    return {
      fetchWallboard,
      getDiffstat,
      getPullRequestComments,
      getPullRequestStatuses,
      getRepository,
      listOpenPullRequests,
      listRecentPullRequests,
      rateLimit,
      request,
      stats,
    };
  }

  global.PRBitbucket = {
    BitbucketError,
    DEFAULT_API_BASE,
    LIST_FIELDS,
    PRIORITY,
    SCORE_POINTS,
    authorizationHeader,
    compareCards,
    createClient,
    createMemoryCache,
    displayName,
    evaluatePullRequest,
    getLevelInfo,
    mapLimit,
    matchesExcludedBranch,
    matchesIncludedBranch,
    matchesExcludedTitle,
    matchesTeamMember,
    prMatchesTeam,
    prSizeCategory,
    summarizeReviews,
    summarizeStatuses,
    toCard,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
