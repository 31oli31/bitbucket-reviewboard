/*
 * Shared WebExtension helpers for ReviewBoard.
 * Loaded as a classic script (no bundler, no ES modules) so the same file works
 * in a Chrome MV3 service worker and in a Firefox MV3 event page.
 */
(function (global) {
  'use strict';

  const hasBrowserNamespace = typeof browser !== 'undefined' && browser && browser.runtime && browser.runtime.id;
  const api = hasBrowserNamespace ? browser : global.chrome;

  if (!api) {
    throw new Error('No WebExtension API (chrome/browser) available.');
  }

  const STORAGE_KEYS = Object.freeze({
    settings: 'settings',
    snapshot: 'snapshot',
    httpCache: 'httpCache',
  });

  const LIMITS = Object.freeze({
    minRefreshSeconds: 15,
    maxRefreshSeconds: 3600,
    minPullRequests: 1,
    maxPullRequests: 100,
  });

  const DEFAULTS = Object.freeze({
    apiBaseUrl: 'https://api.bitbucket.org/2.0',
    authMode: 'basic',
    username: '',
    token: '',
    workspace: '',
    repoSlug: '',
    theme: 'dark',
    refreshSeconds: 120,
    maxPullRequests: 25,
    includeDrafts: false,
    onlyRequestedReviewers: false,
    treatStaleApprovalsAsUnapproved: false,
    includeSourceBranches: '',
    excludeSourceBranches: 'dependabot/, renovate/, wip/',
    excludeTitlePatterns: 'wip, do not merge, dnm',
    teamMembers: '',
    soundAlerts: false,
    pulseAlerts: true,
    wallboardMode: false,
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function parseList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    return String(value || '')
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function normalizeRepoPart(value) {
    return String(value || '')
      .trim()
      .replace(/^@/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
  }

  /**
   * Accepts "acme", "acme/demo" and full Bitbucket URLs so pasting the
   * link from the address bar works.
   */
  function parseRepository(value) {
    const raw = String(value || '').trim();
    if (!raw) return { workspace: '', repoSlug: '' };

    const urlMatch = raw.match(/bitbucket\.org\/([^/\s]+)\/([^/\s#?]+)/i);
    if (urlMatch) {
      return {
        workspace: normalizeRepoPart(urlMatch[1]),
        repoSlug: normalizeRepoPart(urlMatch[2]),
      };
    }

    const parts = raw.replace(/^@/, '').split(/[\s/]+/).filter(Boolean);
    if (parts.length >= 2) {
      return { workspace: normalizeRepoPart(parts[0]), repoSlug: normalizeRepoPart(parts[1]) };
    }
    return { workspace: normalizeRepoPart(parts[0] || ''), repoSlug: '' };
  }

  function normalizeSettings(raw) {
    const merged = Object.assign(clone(DEFAULTS), raw || {});

    merged.token = String(merged.token || '').trim();
    merged.username = String(merged.username || '').trim();
    merged.authMode = String(merged.authMode || DEFAULTS.authMode).toLowerCase() === 'bearer' ? 'bearer' : 'basic';
    merged.apiBaseUrl = String(merged.apiBaseUrl || DEFAULTS.apiBaseUrl)
      .trim()
      .replace(/\/+$/, '');

    const rawTheme = String(merged.theme || '').trim().toLowerCase();
    merged.theme = ['dark', 'light', 'system'].includes(rawTheme) ? rawTheme : DEFAULTS.theme;

    // Both fields accept a bare slug, "workspace/repo" or a full Bitbucket URL.
    const combined = [merged.workspace, merged.repoSlug]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ');
    const split = parseRepository(combined);
    merged.workspace = split.workspace;
    merged.repoSlug = split.repoSlug;

    merged.refreshSeconds = clampInt(
      merged.refreshSeconds,
      LIMITS.minRefreshSeconds,
      LIMITS.maxRefreshSeconds,
      DEFAULTS.refreshSeconds,
    );
    merged.maxPullRequests = clampInt(
      merged.maxPullRequests,
      LIMITS.minPullRequests,
      LIMITS.maxPullRequests,
      DEFAULTS.maxPullRequests,
    );

    merged.includeDrafts = Boolean(merged.includeDrafts);
    merged.onlyRequestedReviewers = Boolean(merged.onlyRequestedReviewers);
    merged.treatStaleApprovalsAsUnapproved = Boolean(merged.treatStaleApprovalsAsUnapproved);
    merged.soundAlerts = Boolean(merged.soundAlerts);
    merged.pulseAlerts = merged.pulseAlerts === undefined ? DEFAULTS.pulseAlerts : Boolean(merged.pulseAlerts);
    merged.wallboardMode = Boolean(merged.wallboardMode);

    merged.includeSourceBranches = String(merged.includeSourceBranches ?? DEFAULTS.includeSourceBranches);
    merged.excludeSourceBranches = String(merged.excludeSourceBranches ?? DEFAULTS.excludeSourceBranches);
    merged.excludeTitlePatterns = String(merged.excludeTitlePatterns ?? DEFAULTS.excludeTitlePatterns);
    merged.teamMembers = String(merged.teamMembers ?? DEFAULTS.teamMembers);

    return merged;
  }

  function isConfigured(settings) {
    if (!settings || !settings.token || !settings.workspace || !settings.repoSlug) return false;
    if (settings.authMode === 'bearer') return true;
    return Boolean(settings.username);
  }

  function settingsFingerprint(settings) {
    return [
      settings.workspace,
      settings.repoSlug,
      settings.apiBaseUrl,
      settings.maxPullRequests,
      settings.includeDrafts,
      settings.onlyRequestedReviewers,
      settings.treatStaleApprovalsAsUnapproved,
      settings.includeSourceBranches,
      settings.excludeSourceBranches,
      settings.excludeTitlePatterns,
      settings.teamMembers,
    ].join('~').toLowerCase();
  }

  async function storageGet(keys) {
    const value = await api.storage.local.get(keys);
    return value || {};
  }

  async function storageSet(items) {
    await api.storage.local.set(items);
  }

  async function storageRemove(keys) {
    await api.storage.local.remove(keys);
  }

  async function loadSettings() {
    const stored = await storageGet(STORAGE_KEYS.settings);
    return normalizeSettings(stored[STORAGE_KEYS.settings]);
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    const next = normalizeSettings(Object.assign(current, patch || {}));
    await storageSet({ [STORAGE_KEYS.settings]: next });
    return next;
  }

  async function getSnapshot() {
    const stored = await storageGet(STORAGE_KEYS.snapshot);
    const snapshot = stored[STORAGE_KEYS.snapshot];
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  }

  async function setSnapshot(snapshot) {
    await storageSet({ [STORAGE_KEYS.snapshot]: snapshot });
  }

  async function sendMessage(message) {
    try {
      return await api.runtime.sendMessage(message);
    } catch (error) {
      const text = String((error && error.message) || error);
      if (/Receiving end does not exist|Could not establish connection/i.test(text)) {
        throw new Error('Background worker is not reachable. Reload the extension.');
      }
      throw error;
    }
  }

  function onStorageChanged(listener) {
    const handler = (changes, areaName) => {
      if (areaName && areaName !== 'local') return;
      listener(changes);
    };
    api.storage.onChanged.addListener(handler);
    return () => api.storage.onChanged.removeListener(handler);
  }

  function resolveEffectiveTheme(themeSetting) {
    if (themeSetting === 'light' || themeSetting === 'dark') return themeSetting;
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  function applyTheme(themeSetting) {
    const setting = themeSetting || DEFAULTS.theme;
    const effective = resolveEffectiveTheme(setting);
    if (typeof document === 'undefined') return effective;

    document.documentElement.setAttribute('data-theme', effective);
    document.body.setAttribute('data-theme', effective);
    document.body.classList.toggle('theme-light', effective === 'light');
    document.body.classList.toggle('theme-dark', effective === 'dark');
    return effective;
  }

  global.PRShared = {
    api,
    DEFAULTS,
    LIMITS,
    STORAGE_KEYS,
    usesPromiseApi: Boolean(hasBrowserNamespace),
    applyTheme,
    clampInt,
    clone,
    getSnapshot,
    isConfigured,
    loadSettings,
    normalizeSettings,
    onStorageChanged,
    parseList,
    parseRepository,
    resolveEffectiveTheme,
    saveSettings,
    sendMessage,
    setSnapshot,
    settingsFingerprint,
    storageGet,
    storageRemove,
    storageSet,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
