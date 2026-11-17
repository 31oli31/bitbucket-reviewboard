/*
 * ReviewBoard — background service worker / event page.
 *
 * Responsibilities:
 *  - fetch open PRs (ETag cached, rate-limit aware)
 *  - keep a snapshot in chrome.storage.local for the dashboard
 *  - drive the toolbar badge and the polling alarm
 *  - answer dashboard/options messages
 */
/* global PRShared, PRBitbucket */
if (typeof importScripts === 'function') {
  importScripts('lib/browser-api.js', 'lib/bitbucket.js');
}

(function () {
  'use strict';

  const { api, STORAGE_KEYS } = PRShared;
  const REFRESH_ALARM = 'pr-wallboard-refresh';
  const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 400;
  const CACHE_MAX_BYTES = 4 * 1024 * 1024;
  const CACHE_HEAVY_KEYS = new Set(['body', 'body_html', 'body_text', 'output', 'description', 'rendered']);
  const concurrency = 4;

  let inFlight = null;
  let lastRateLimit = null;

  /* ------------------------------------------------------------------ */
  /* HTTP cache (ETag store)                                            */
  /* ------------------------------------------------------------------ */

  /**
   * PR bodies and check-run output are large and never rendered. Dropping them
   * keeps the ETag cache well inside the 10 MB storage.local quota.
   */
  function slimPayload(value) {
    if (Array.isArray(value)) return value.map(slimPayload);
    if (value && typeof value === 'object') {
      const copy = {};
      Object.keys(value).forEach((key) => {
        if (CACHE_HEAVY_KEYS.has(key)) return;
        copy[key] = slimPayload(value[key]);
      });
      return copy;
    }
    return value;
  }

  function payloadSize(value) {
    try {
      return JSON.stringify(value).length;
    } catch (error) {
      return 0;
    }
  }

  function createCache() {
    let map = null;
    let dirty = false;

    async function load() {
      if (map) return map;
      const stored = await PRShared.storageGet(STORAGE_KEYS.httpCache);
      map = stored[STORAGE_KEYS.httpCache] || {};
      if (typeof map !== 'object' || Array.isArray(map)) map = {};
      return map;
    }

    function prune(store) {
      const keys = Object.keys(store);
      const ordered = keys.slice().sort((a, b) => (store[a].storedAt || 0) - (store[b].storedAt || 0));
      let total = keys.reduce((sum, key) => sum + (store[key].size || 0), 0);
      let removed = 0;

      while (ordered.length > removed) {
        const remaining = ordered.length - removed;
        if (remaining <= CACHE_MAX_ENTRIES && total <= CACHE_MAX_BYTES) break;
        const key = ordered[removed];
        removed += 1;
        total -= store[key].size || 0;
        delete store[key];
      }
    }

    return {
      async get(key) {
        const store = await load();
        const entry = store[key];
        if (!entry) return null;
        if (entry.storedAt && Date.now() - entry.storedAt > CACHE_TTL_MS) {
          delete store[key];
          dirty = true;
          return null;
        }
        return entry;
      },
      async set(key, entry) {
        const store = await load();
        const data = slimPayload(entry.data);
        store[key] = Object.assign({}, entry, { data, storedAt: Date.now(), size: payloadSize(data) });
        dirty = true;
        prune(store);
      },
      async clear() {
        map = {};
        dirty = true;
        await PRShared.storageRemove(STORAGE_KEYS.httpCache);
      },
      async flush() {
        if (!dirty || !map) return;
        dirty = false;
        try {
          await PRShared.storageSet({ [STORAGE_KEYS.httpCache]: map });
        } catch (error) {
          dirty = true;
        }
      },
    };
  }

  const cache = createCache();

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function serializeError(error) {
    return {
      kind: (error && error.kind) || 'error',
      message: String((error && error.message) || error || 'Unknown error'),
      status: (error && error.status) || 0,
      retryAt: (error && error.retryAt) || 0,
      at: Date.now(),
    };
  }

  async function scheduleAlarm(refreshSeconds) {
    const seconds = Number(refreshSeconds) || PRShared.DEFAULTS.refreshSeconds;
    // Every refresh path goes through scheduleAlarm, so keep the minimum gap
    // here: a 1-minute alarm must not double an open dashboard's 2-minute poll.
    refresh.minGapMs = Math.max(10000, Math.min(seconds * 1000 * 0.75, 60000));
    // Firefox clamps repeating alarms below one minute; the dashboard still
    // refreshes at the user configured rate and wakes the worker itself.
    const periodMinutes = Math.max(1, Math.round((seconds / 60) * 10) / 10);
    try {
      await api.alarms.clear(REFRESH_ALARM);
      api.alarms.create(REFRESH_ALARM, { delayInMinutes: periodMinutes, periodInMinutes: periodMinutes });
    } catch (error) {
      console.warn('[ReviewBoard] could not schedule alarm', error);
    }
  }

  async function updateBadge(snapshot, error) {
    const count = (snapshot && snapshot.counts && snapshot.counts.needingReview) || 0;
    const failing = (snapshot && snapshot.counts && snapshot.counts.failingChecks) || 0;
    const text = count > 99 ? '99+' : count > 0 ? String(count) : '';

    try {
      await api.action.setBadgeText({ text });
      await api.action.setBadgeBackgroundColor({ color: error ? '#6b7280' : count > 0 ? '#dc2626' : '#16a34a' });
      if (typeof api.action.setBadgeTextColor === 'function') {
        await api.action.setBadgeTextColor({ color: '#ffffff' });
      }
      await api.action.setTitle({
        title: error
          ? `ReviewBoard — error: ${error.message}`
          : count > 0
            ? `ReviewBoard — ${count} PR(s) need review${failing ? `, ${failing} with failing checks` : ''}`
            : 'ReviewBoard — nothing waiting for review',
      });
    } catch (badgeError) {
      console.warn('[ReviewBoard] badge update failed', badgeError);
    }
  }

  function decorateSnapshot(result, previous) {
    const hasPrevious = Boolean(previous && Array.isArray(previous.pullRequests));
    const previousNumbers = new Set(hasPrevious ? previous.pullRequests.map((pr) => pr.number) : []);
    const sameSettings = hasPrevious && previous.settingsFingerprint === result.settingsFingerprint;

    return Object.assign({}, result, {
      newNumbers: hasPrevious && sameSettings
        ? result.pullRequests.filter((pr) => !previousNumbers.has(pr.number)).map((pr) => pr.number)
        : [],
      // Empty newNumbers means "nothing new" only when settings stayed the same.
      suppressNewAlerts: !sameSettings,
      lastError: null,
      lastAttemptAt: Date.now(),
      stale: false,
    });
  }

  async function setUnconfiguredSnapshot() {
    const previous = await PRShared.getSnapshot();
    const settings = await PRShared.loadSettings();
    const snapshot = Object.assign({}, previous || {}, {
      fetchedAt: 0,
      lastAttemptAt: Date.now(),
      lastError: {
        kind: 'unconfigured',
        message: 'Set a Bitbucket email + API token, the workspace and the repository slug in the options page.',
        status: 0,
        retryAt: 0,
        at: Date.now(),
      },
      stale: false,
      configured: false,
      suppressNewAlerts: true,
      settingsFingerprint: PRShared.settingsFingerprint(settings),
      // Do not keep rendering data from a configuration that no longer exists.
      repo: null,
      pullRequests: [],
      scoreboard: null,
      counts: null,
    });
    await PRShared.setSnapshot(snapshot);
    return snapshot;
  }

  /* ------------------------------------------------------------------ */
  /* Refresh loop                                                       */
  /* ------------------------------------------------------------------ */

  async function doRefresh(reason) {
    const settings = await PRShared.loadSettings();

    if (!PRShared.isConfigured(settings)) {
      const snapshot = await setUnconfiguredSnapshot();
      await updateBadge(null, snapshot.lastError);
      return {
        ok: false,
        reason: 'unconfigured',
        error: snapshot.lastError,
        snapshot,
      };
    }

    const previous = await PRShared.getSnapshot();

    // Prevent hammering Bitbucket when in rate-limit cooldown
    if (lastRateLimit && lastRateLimit.resetAt && Date.now() < lastRateLimit.resetAt) {
      const waitSec = Math.ceil((lastRateLimit.resetAt - Date.now()) / 1000);
      const failure = {
        kind: 'rate_limit',
        message: `Bitbucket API rate limit reached. Next attempt after ${new Date(lastRateLimit.resetAt).toLocaleTimeString()}.`,
        status: 429,
        retryAt: lastRateLimit.resetAt,
        at: Date.now(),
      };
      const snapshot = Object.assign({}, previous || {}, {
        lastError: failure,
        lastAttemptAt: Date.now(),
        stale: Boolean(previous),
        configured: true,
        reason: reason || 'timer',
        settingsFingerprint: PRShared.settingsFingerprint(settings),
        rateLimit: Object.assign({}, lastRateLimit),
      });
      await PRShared.setSnapshot(snapshot);
      await updateBadge(previous, failure);
      return { ok: false, error: failure, snapshot };
    }

    const client = PRBitbucket.createClient(settings, {
      cache,
      onRateLimit(rateLimit) {
        lastRateLimit = rateLimit;
      },
    });

    try {
      const result = await client.fetchWallboard({
        maxPullRequests: settings.maxPullRequests,
        includeDrafts: settings.includeDrafts,
        onlyRequestedReviewers: settings.onlyRequestedReviewers,
        treatStaleApprovalsAsUnapproved: settings.treatStaleApprovalsAsUnapproved,
        includeSourceBranches: PRShared.parseList(settings.includeSourceBranches),
        excludeSourceBranches: PRShared.parseList(settings.excludeSourceBranches),
        excludeTitlePatterns: PRShared.parseList(settings.excludeTitlePatterns),
        teamMembers: PRShared.parseList(settings.teamMembers),
        concurrency,
      });

      // Use the same fingerprint format as error/unconfigured snapshots, so
      // "new PR" detection survives a failed refresh.
      result.settingsFingerprint = PRShared.settingsFingerprint(settings);
      const snapshot = decorateSnapshot(result, previous);
      snapshot.configured = true;
      snapshot.reason = reason || 'timer';
      await PRShared.setSnapshot(snapshot);
      await updateBadge(snapshot, null);
      return { ok: true, snapshot };
    } catch (error) {
      const failure = serializeError(error);
      const snapshot = Object.assign({}, previous || {}, {
        lastError: failure,
        lastAttemptAt: Date.now(),
        stale: Boolean(previous),
        configured: true,
        reason: reason || 'timer',
        settingsFingerprint: PRShared.settingsFingerprint(settings),
        rateLimit: Object.assign({}, lastRateLimit || (previous && previous.rateLimit) || {}),
      });
      if (!snapshot.counts) {
        snapshot.counts = {
          needingReview: 0,
          changesRequested: 0,
          reviewRequested: 0,
          staleApprovals: 0,
          failingChecks: 0,
          pendingChecks: 0,
          oldestCreatedAt: 0,
        };
      }
      if (!Array.isArray(snapshot.pullRequests)) snapshot.pullRequests = [];
      await PRShared.setSnapshot(snapshot);
      await updateBadge(previous, failure);
      return { ok: false, error: failure, snapshot };
    } finally {
      await cache.flush();
    }
  }

  function refresh(reason, options) {
    const opts = options || {};
    if (inFlight) return inFlight;
    if (!opts.force) {
      const lastAttempt = refresh.lastAttemptAt || 0;
      const minGap = (refresh.minGapMs || 15000) - 1500;
      if (lastAttempt && Date.now() - lastAttempt < minGap) {
        return PRShared.getSnapshot().then((snapshot) => ({ ok: Boolean(snapshot && snapshot.configured), snapshot, cached: true }));
      }
    }

    refresh.lastAttemptAt = Date.now();
    inFlight = doRefresh(reason)
      .catch((error) => ({ ok: false, error: serializeError(error), snapshot: null }))
      .finally(() => {
        inFlight = null;
        refresh.lastAttemptAt = Date.now();
      });
    return inFlight;
  }

  /* ------------------------------------------------------------------ */
  /* Messages                                                           */
  /* ------------------------------------------------------------------ */

  async function handleMessage(message) {
    switch (message.type) {
      case 'pr-wallboard:refresh': {
        return refresh(message.reason || 'message', { force: Boolean(message.force) });
      }
      case 'pr-wallboard:get-snapshot': {
        const snapshot = await PRShared.getSnapshot();
        return { ok: true, snapshot };
      }
      case 'pr-wallboard:settings-changed': {
        const settings = await PRShared.loadSettings();
        await scheduleAlarm(settings.refreshSeconds);
        return refresh('settings', { force: true });
      }
      case 'pr-wallboard:clear-cache': {
        await cache.clear();
        return { ok: true };
      }
      case 'pr-wallboard:open-dashboard': {
        await api.tabs.create({ url: api.runtime.getURL('dashboard.html') });
        return { ok: true };
      }
      case 'pr-wallboard:open-options': {
        const url = api.runtime.getURL('options.html');
        if (api.runtime.openOptionsPage) await api.runtime.openOptionsPage();
        else await api.tabs.create({ url });
        return { ok: true };
      }
      case 'pr-wallboard:ping': {
        return { ok: true, version: api.runtime.getManifest().version };
      }
      default:
        return { ok: false, error: { kind: 'unknown_message', message: `Unknown message type: ${message.type}` } };
    }
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;

    const promise = handleMessage(message).catch((error) => ({ ok: false, error: serializeError(error) }));

    // Firefox (browser.* API) resolves the sender with the returned Promise;
    // Chrome needs the callback + `return true` pattern.
    if (PRShared.usesPromiseApi) return promise;

    promise.then(sendResponse, (error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  });

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  api.runtime.onInstalled.addListener(async (details) => {
    try {
      const stored = await PRShared.storageGet(STORAGE_KEYS.settings);
      if (!stored[STORAGE_KEYS.settings]) {
        await PRShared.saveSettings({});
      }
      const settings = await PRShared.loadSettings();
      await scheduleAlarm(settings.refreshSeconds);

      if (!PRShared.isConfigured(settings)) {
        if (api.runtime.openOptionsPage) await api.runtime.openOptionsPage();
      } else if (details.reason !== 'update') {
        await refresh('install', { force: true });
      }
    } catch (error) {
      console.warn('[ReviewBoard] install handler failed', error);
    }
  });

  api.runtime.onStartup.addListener(async () => {
    try {
      const settings = await PRShared.loadSettings();
      await scheduleAlarm(settings.refreshSeconds);
      if (PRShared.isConfigured(settings)) await refresh('startup', { force: true });
    } catch (error) {
      console.warn('[ReviewBoard] startup handler failed', error);
    }
  });

  api.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== REFRESH_ALARM) return;
    refresh('alarm', { force: false });
  });

  if (api.commands && api.commands.onCommand) {
    api.commands.onCommand.addListener(async (command) => {
      if (command === 'open-dashboard') {
        await api.tabs.create({ url: api.runtime.getURL('dashboard.html') });
      }
    });
  }
})();
