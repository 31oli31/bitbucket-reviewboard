/*
 * ReviewBoard — options page.
 * Plain DOM, no framework. Saves to chrome.storage.local via PRShared.
 */
/* global PRShared, PRBitbucket */
(function () {
  'use strict';

  const { api, DEFAULTS, LIMITS } = PRShared;

  const el = {
    form: document.getElementById('settings-form'),
    notice: document.getElementById('notice'),
    token: document.getElementById('token'),
    toggleToken: document.getElementById('toggle-token'),
    authMode: document.getElementById('authMode'),
    username: document.getElementById('username'),
    usernameField: document.getElementById('username-field'),
    workspace: document.getElementById('workspace'),
    repoSlug: document.getElementById('repoSlug'),
    apiBaseUrl: document.getElementById('apiBaseUrl'),
    theme: document.getElementById('theme'),
    refreshSeconds: document.getElementById('refreshSeconds'),
    maxPullRequests: document.getElementById('maxPullRequests'),
    includeDrafts: document.getElementById('includeDrafts'),
    onlyRequestedReviewers: document.getElementById('onlyRequestedReviewers'),
    treatStaleApprovalsAsUnapproved: document.getElementById('treatStaleApprovalsAsUnapproved'),
    teamMembers: document.getElementById('teamMembers'),
    includeSourceBranches: document.getElementById('includeSourceBranches'),
    excludeSourceBranches: document.getElementById('excludeSourceBranches'),
    excludeTitlePatterns: document.getElementById('excludeTitlePatterns'),
    pulseAlerts: document.getElementById('pulseAlerts'),
    soundAlerts: document.getElementById('soundAlerts'),
    test: document.getElementById('test'),
    testResult: document.getElementById('test-result'),
    openDashboard: document.getElementById('open-dashboard'),
    clearCache: document.getElementById('clear-cache'),
    reset: document.getElementById('reset'),
  };

  let noticeTimer = null;

  function notify(message, kind) {
    el.notice.textContent = message;
    el.notice.className = `notice ${kind || ''}`.trim();
    el.notice.hidden = false;
    if (noticeTimer) clearTimeout(noticeTimer);
    if (kind !== 'error') {
      noticeTimer = setTimeout(() => {
        el.notice.hidden = true;
      }, 6000);
    }
  }

  function setTestResult(message, kind) {
    el.testResult.textContent = message;
    el.testResult.className = `test-result ${kind || ''}`.trim();
  }

  function applyTheme(themeSetting) {
    PRShared.applyTheme(themeSetting || (el.theme && el.theme.value) || DEFAULTS.theme);
  }

  /* ------------------------------------------------------------------ */
  /* Form <-> settings                                                  */
  /* ------------------------------------------------------------------ */

  function syncAuthMode() {
    const bearer = el.authMode.value === 'bearer';
    el.usernameField.hidden = bearer;
    el.username.required = !bearer;
  }

  function fillForm(settings) {
    el.authMode.value = settings.authMode || DEFAULTS.authMode;
    el.token.value = settings.token || '';
    el.username.value = settings.username || '';
    el.workspace.value = settings.workspace || '';
    el.repoSlug.value = settings.repoSlug || '';
    el.apiBaseUrl.value = settings.apiBaseUrl || DEFAULTS.apiBaseUrl;
    if (el.theme) el.theme.value = settings.theme || DEFAULTS.theme;
    el.refreshSeconds.value = String(settings.refreshSeconds);
    el.maxPullRequests.value = String(settings.maxPullRequests);
    el.includeDrafts.checked = Boolean(settings.includeDrafts);
    el.onlyRequestedReviewers.checked = Boolean(settings.onlyRequestedReviewers);
    el.treatStaleApprovalsAsUnapproved.checked = Boolean(settings.treatStaleApprovalsAsUnapproved);
    if (el.teamMembers) el.teamMembers.value = settings.teamMembers || '';
    if (el.includeSourceBranches) el.includeSourceBranches.value = settings.includeSourceBranches || '';
    el.excludeSourceBranches.value = settings.excludeSourceBranches || '';
    el.excludeTitlePatterns.value = settings.excludeTitlePatterns || '';
    el.pulseAlerts.checked = Boolean(settings.pulseAlerts);
    el.soundAlerts.checked = Boolean(settings.soundAlerts);
    syncAuthMode();
    applyTheme(settings.theme);
  }

  function readForm() {
    // normalizeSettings() splits bare "workspace/repo" values and Bitbucket URLs.
    return {
      authMode: el.authMode.value,
      username: el.username.value.trim(),
      token: el.token.value.trim(),
      workspace: el.workspace.value,
      repoSlug: el.repoSlug.value,
      apiBaseUrl: el.apiBaseUrl.value.trim() || DEFAULTS.apiBaseUrl,
      theme: el.theme ? el.theme.value : DEFAULTS.theme,
      refreshSeconds: el.refreshSeconds.value,
      maxPullRequests: el.maxPullRequests.value,
      includeDrafts: el.includeDrafts.checked,
      onlyRequestedReviewers: el.onlyRequestedReviewers.checked,
      treatStaleApprovalsAsUnapproved: el.treatStaleApprovalsAsUnapproved.checked,
      teamMembers: el.teamMembers ? el.teamMembers.value : '',
      includeSourceBranches: el.includeSourceBranches ? el.includeSourceBranches.value : '',
      excludeSourceBranches: el.excludeSourceBranches.value,
      excludeTitlePatterns: el.excludeTitlePatterns.value,
      pulseAlerts: el.pulseAlerts.checked,
      soundAlerts: el.soundAlerts.checked,
    };
  }

  function validate(raw, settings) {
    if (!/^https:\/\//i.test(settings.apiBaseUrl)) {
      return 'API base URL must start with https://';
    }
    // Check the raw values: normalizeSettings() clamps numbers silently.
    const refresh = Number(raw.refreshSeconds);
    if (!Number.isFinite(refresh) || refresh < LIMITS.minRefreshSeconds || refresh > LIMITS.maxRefreshSeconds) {
      return `Refresh interval must be between ${LIMITS.minRefreshSeconds} and ${LIMITS.maxRefreshSeconds} seconds.`;
    }
    const maxPullRequests = Number(raw.maxPullRequests);
    if (!Number.isFinite(maxPullRequests) || maxPullRequests < LIMITS.minPullRequests || maxPullRequests > LIMITS.maxPullRequests) {
      return `Max pull requests must be between ${LIMITS.minPullRequests} and ${LIMITS.maxPullRequests}.`;
    }
    if (!settings.workspace || !settings.repoSlug) return 'Workspace and repository slug are required.';
    if (settings.authMode === 'basic' && settings.token && !settings.username) {
      return 'The Atlassian account email is required for email + API token authentication.';
    }
    return null;
  }

  /**
   * Must be invoked synchronously from the click/submit handler: Chrome ties
   * permissions.request() to the user gesture.
   */
  function requestHostPermission(apiBaseUrl) {
    try {
      const url = new URL(apiBaseUrl);
      if (/(^|\.)api\.bitbucket\.org$/i.test(url.hostname)) return Promise.resolve(true);
      if (!api.permissions || typeof api.permissions.request !== 'function') return Promise.resolve(true);
      return api.permissions.request({ origins: [`${url.origin}/*`] });
    } catch (error) {
      return Promise.resolve(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                            */
  /* ------------------------------------------------------------------ */

  async function save(event) {
    event.preventDefault();

    const raw = readForm();
    const normalized = PRShared.normalizeSettings(raw);
    const problem = validate(raw, normalized);
    if (problem) {
      notify(problem, 'error');
      return;
    }

    const permissionPromise = requestHostPermission(normalized.apiBaseUrl);

    try {
      const granted = await permissionPromise;
      if (!granted) {
        notify('Host access for the custom API base URL was denied. Requests will fail until access is granted.', 'warn');
      }

      const saved = await PRShared.saveSettings(normalized);
      fillForm(saved);

      try {
        const result = await PRShared.sendMessage({ type: 'pr-wallboard:settings-changed' });
        if (result && result.ok === false && result.error && result.error.kind !== 'unconfigured') {
          notify(`Settings saved, but the first refresh failed: ${result.error.message}`, 'warn');
          return;
        }
      } catch (error) {
        notify('Settings saved. Reload the extension if the background worker does not pick them up.', 'warn');
        return;
      }

      notify('Settings saved. The wallboard is refreshing.', 'ok');
    } catch (error) {
      notify(`Could not save settings: ${(error && error.message) || error}`, 'error');
    }
  }

  async function testConnection() {
    const settings = PRShared.normalizeSettings(readForm());
    if (!settings.token || !settings.workspace || !settings.repoSlug) {
      setTestResult('Fill in the API token, the workspace and the repository slug first.', 'error');
      return;
    }
    if (settings.authMode === 'basic' && !settings.username) {
      setTestResult('Add the Atlassian account email for email + API token authentication.', 'error');
      return;
    }

    const granted = await requestHostPermission(settings.apiBaseUrl);
    if (!granted) {
      setTestResult('Host access for the custom API base URL was denied.', 'error');
      return;
    }

    el.test.disabled = true;
    setTestResult('Contacting Bitbucket…', '');

    try {
      const client = PRBitbucket.createClient(settings, { cache: PRBitbucket.createMemoryCache() });
      const repository = await client.getRepository();
      const list = await client.listOpenPullRequests({ pagelen: 50 });
      const visibility = repository.is_private ? 'private' : 'public';
      setTestResult(`Connected to ${repository.full_name} (${visibility}) — ${list.total} open pull request(s).`, 'ok');
    } catch (error) {
      const kind = error && error.kind;
      let message = (error && error.message) || String(error);
      if (kind === 'auth') message = 'Credentials rejected (401). Check the email/API token pair and its Bitbucket scopes.';
      if (kind === 'forbidden') message = `Access denied (403). Grant the token read:pullrequest:bitbucket and read:repository:bitbucket. ${message}`;
      if (kind === 'not_found') message = `${settings.workspace}/${settings.repoSlug} not found (404). Use the URL slug and check the token can see it.`;
      if (kind === 'rate_limit' && error.retryAt) {
        message = `Rate limit reached. Retry after ${new Date(error.retryAt).toLocaleTimeString()}.`;
      }
      if (kind === 'network') message = `Network/CORS problem: ${message}`;
      setTestResult(message, 'error');
    } finally {
      el.test.disabled = false;
    }
  }

  async function openDashboard() {
    try {
      await PRShared.sendMessage({ type: 'pr-wallboard:open-dashboard' });
      window.close();
    } catch (error) {
      api.tabs.create({ url: api.runtime.getURL('dashboard.html') }).catch(() => {});
    }
  }

  async function clearCache() {
    try {
      await PRShared.sendMessage({ type: 'pr-wallboard:clear-cache' });
      notify('API cache cleared. The next refresh fetches everything fresh (costs rate limit).', 'ok');
    } catch (error) {
      notify(`Could not clear the cache: ${(error && error.message) || error}`, 'error');
    }
  }

  async function resetDefaults() {
    if (!window.confirm('Reset all settings, including the token, to their defaults?')) return;
    await PRShared.storageRemove(PRShared.STORAGE_KEYS.settings);
    const defaults = await PRShared.loadSettings();
    fillForm(defaults);
    notify('Defaults restored. Add your token and repository to start monitoring.', 'ok');
    try {
      await PRShared.sendMessage({ type: 'pr-wallboard:settings-changed' });
    } catch (error) {
      /* background may be asleep; it will reload settings on next alarm */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                             */
  /* ------------------------------------------------------------------ */

  el.form.addEventListener('submit', save);
  el.authMode.addEventListener('change', syncAuthMode);
  if (el.theme) {
    el.theme.addEventListener('change', () => applyTheme(el.theme.value));
  }
  el.test.addEventListener('click', testConnection);
  el.openDashboard.addEventListener('click', openDashboard);
  el.clearCache.addEventListener('click', clearCache);
  el.reset.addEventListener('click', resetDefaults);

  if (window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (el.theme && el.theme.value === 'system') {
          applyTheme('system');
        }
      });
    } catch (error) {
      /* ignore */
    }
  }

  el.toggleToken.addEventListener('click', () => {
    const show = el.token.type === 'password';
    el.token.type = show ? 'text' : 'password';
    el.toggleToken.textContent = show ? 'Hide' : 'Show';
    el.toggleToken.setAttribute('aria-label', show ? 'Hide token' : 'Show token');
  });

  PRShared.loadSettings()
    .then((settings) => {
      fillForm(settings);
      if (!PRShared.isConfigured(settings)) {
        notify('Add your Bitbucket credentials, workspace and repository slug to start the wallboard.', 'warn');
      }
    })
    .catch((error) => notify(`Could not load settings: ${(error && error.message) || error}`, 'error'));
})();
