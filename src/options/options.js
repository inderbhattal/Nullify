/**
 * options.js — Dashboard controller
 */

import './options.css';

import { normalizeAllowlist, normalizeHostname } from '../shared/hostname.js';
import { call, MAX_USER_FILTERS_BYTES, utf8ByteLength } from './messaging.js';

const $ = (id) => document.getElementById(id);

const FILTER_LISTS = [
  { id: 'easylist',     name: 'EasyList',        desc: 'The most widely used ad-blocking filter list' },
  { id: 'easyprivacy',  name: 'EasyPrivacy',      desc: 'Tracker, analytics, and surveillance blocking' },
  { id: 'annoyances',   name: 'Fanboy Annoyances', desc: 'Cookie notices, popups, social overlays' },
  { id: 'ubo-cookie-annoyances', name: 'uBO Cookie Annoyances', desc: 'Surgically targets cookie consent and tracking notices' },
  { id: 'malware',      name: 'Malware Blocklist', desc: 'Blocks malware and phishing URLs' },
  { id: 'ubo-filters',  name: 'uBO Filters',       desc: 'uBlock Origin default filter list' },
  { id: 'ubo-unbreak',  name: 'uBO Unbreak',       desc: 'Fixes over-blocking by other lists' },
  { id: 'anti-adblock', name: 'Anti-Adblock',      desc: 'Anti-adblock and badware fixes from uBO' },
];

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function initNav() {
  // Display version from manifest
  const manifest = chrome.runtime.getManifest();
  const versionEl = $('extVersion');
  const sidebarVersionEl = $('sidebarVersion');

  if (versionEl) versionEl.textContent = manifest.version;
  if (sidebarVersionEl) sidebarVersionEl.textContent = `v${manifest.version}`;

  document.querySelectorAll('.nav-item').forEach((item) => {
    const activate = () => {
      const tabId = item.dataset.tab;

      document.querySelectorAll('.nav-item').forEach((n) => {
        n.classList.remove('active');
        n.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));

      item.classList.add('active');
      item.setAttribute('aria-selected', 'true');
      $(`tab-${tabId}`)?.classList.add('active');
    };

    item.addEventListener('click', activate);
    // The nav items are <li> elements, not buttons — without this they are
    // keyboard-unreachable dead ends even with tabindex.
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Filter Lists
// ---------------------------------------------------------------------------
function showListsStatus(msg, type) {
  showStatus('listsStatus', msg, type);
}

async function initFilterLists() {
  const getStatusText = (state) => state === false ? 'Disabled' : state === 'partial' ? 'Partial' : 'Active';
  const isEffectivelyEnabled = (state) => state !== false;

  let enabled = {};
  let lastUpdate = 0;
  try {
    enabled = (await call('GET_ENABLED_RULESETS')) || {};
  } catch (err) {
    showListsStatus('✗ Failed to load filter list state: ' + err.message, 'error');
  }
  try {
    lastUpdate = (await chrome.storage.local.get('lastUpdateCheck'))?.lastUpdateCheck || 0;
  } catch {}

  const updateStatusText = () => {
    const el = $('lastUpdateText');
    if (!el) return;
    if (lastUpdate === 0) {
      el.textContent = 'Never checked';
    } else {
      const date = new Date(lastUpdate);
      el.textContent = `Last check: ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  };

  updateStatusText();

  const grid = $('filterListGrid');
  grid.innerHTML = '';

  for (const list of FILTER_LISTS) {
    let currentState = enabled[list.id];
    const isEnabled = isEffectivelyEnabled(currentState);

    const card = document.createElement('div');
    card.className = 'list-card' + (isEnabled ? '' : ' disabled');
    card.innerHTML = `
      <label class="list-toggle">
        <input type="checkbox" ${isEnabled ? 'checked' : ''} data-listid="${list.id}" aria-label="Enable ${list.name}">
        <span class="list-toggle-track"></span>
      </label>
      <div class="list-info">
        <div class="list-name">${list.name}</div>
        <div class="list-desc">${list.desc}</div>
      </div>
      <div class="list-meta" id="meta-${list.id}">
        ${getStatusText(currentState)}
      </div>
    `;

    const checkbox = card.querySelector('input[type="checkbox"]');
    checkbox.indeterminate = currentState === 'partial';
    checkbox.addEventListener('change', async () => {
      const nowEnabled = checkbox.checked;
      const prevState = currentState;
      const applyState = (enabledMap) => {
        const actualState = enabledMap?.[list.id];
        const actualEnabled = isEffectivelyEnabled(actualState);
        currentState = actualState;
        checkbox.checked = actualEnabled;
        checkbox.indeterminate = actualState === 'partial';
        card.className = 'list-card' + (actualEnabled ? '' : ' disabled');
        $(`meta-${list.id}`).textContent = getStatusText(actualState);
      };

      applyState({ [list.id]: nowEnabled });

      try {
        const res = await call('SET_RULESET_ENABLED', {
          rulesetId: list.id,
          enabled: nowEnabled,
        });
        applyState(res?.enabledMap || {});
      } catch (err) {
        // Revert the optimistic flip — the SW is authoritative.
        applyState({ [list.id]: prevState });
        showListsStatus(`✗ ${list.name}: ${err.message}`, 'error');
      }
    });

    grid.appendChild(card);
  }

  $('btnUpdateAll').addEventListener('click', async () => {
    $('btnUpdateAll').textContent = 'Updating...';
    $('btnUpdateAll').disabled = true;

    try {
      // Trigger background update check
      await call('CHECK_FILTER_UPDATES');

      // Refresh last update time
      const res = await chrome.storage.local.get('lastUpdateCheck');
      lastUpdate = res.lastUpdateCheck || Date.now();
      updateStatusText();
    } catch (err) {
      showListsStatus('✗ Update failed: ' + err.message, 'error');
    }

    setTimeout(() => {
      $('btnUpdateAll').textContent = 'Update All';
      $('btnUpdateAll').disabled = false;
    }, 1000);
  });
}

// ---------------------------------------------------------------------------
// My Filters
// ---------------------------------------------------------------------------
async function initMyFilters() {
  try {
    const res = await call('GET_USER_FILTERS');
    $('userFiltersArea').value = res?.filters || '';
  } catch (err) {
    showFilterStatus('✗ Failed to load filters: ' + err.message, 'error');
  }

  // Returns true when the filters were accepted by the SW.
  const saveFilters = async () => {
    const filters = $('userFiltersArea').value;
    // The SW enforces a 2 MB byte budget; check bytes (not .length) here so
    // an over-cap paste fails with a clear message instead of a silent drop.
    if (utf8ByteLength(filters) > MAX_USER_FILTERS_BYTES) {
      showFilterStatus(`✗ Filters exceed the ${MAX_USER_FILTERS_BYTES / (1024 * 1024)} MB limit`, 'error');
      return false;
    }
    try {
      const counts = await call('SET_USER_FILTERS', { filters });
      if (counts?.warning) {
        showFilterStatus('⚠ ' + counts.warning, 'warning');
        return true;
      }
      const msg = counts && Number.isFinite(counts.network)
        ? `✓ Applied ${counts.network} network and ${counts.cosmetic} cosmetic rules`
        : '✓ Filters applied successfully';
      showFilterStatus(msg, 'success');
      return true;
    } catch (err) {
      showFilterStatus('✗ Error: ' + err.message, 'error');
      return false;
    }
  };

  $('btnApplyFilters').addEventListener('click', saveFilters);

  // Ctrl+Enter / Cmd+Enter to apply
  $('userFiltersArea').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      saveFilters();
    }
  });

  // Export filters to file
  $('btnExportFilters').addEventListener('click', () => {
    const filters = $('userFiltersArea').value;
    if (!filters.trim()) {
      showFilterStatus('Nothing to export — filters are empty', 'error');
      return;
    }
    const header = `! Title: My Filters\n! Exported: ${new Date().toISOString()}\n!\n`;
    const blob = new Blob([header + filters], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-filters-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      showFilterStatus('✓ Filters exported', 'success');
    } finally {
      // Defer revoke past the current task so a cancelled or stalled
      // download still releases the URL reference without racing the
      // browser's download-initiation handler.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  });

  // Import filters from file
  $('btnImportFilters').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.text,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      // Reject oversized files before calling `.text()` so a huge upload
      // cannot pin the UI thread on decoding. Same 2 MB budget as the SW.
      if (file.size > MAX_USER_FILTERS_BYTES) {
        showFilterStatus(`✗ File too large (>${MAX_USER_FILTERS_BYTES / (1024 * 1024)} MB)`, 'error');
        return;
      }
      try {
        const text = await file.text();
        // Strip header comments added by export (! Title:, ! Exported:, blank ! lines)
        const lines = text.split('\n');
        const filtered = lines.filter(l => {
          const t = l.trim();
          if (t === '!') return false;
          if (/^!\s*(Title|Exported):/i.test(t)) return false;
          return true;
        }).join('\n').trim();
        if (!filtered) {
          showFilterStatus('⚠ Imported file contains no filter rules', 'error');
          return;
        }
        const area = $('userFiltersArea');
        const existing = area.value.trim();
        const newRules = filtered.split('\n').map(r => r.trim()).filter(Boolean);
        const existingRules = existing.split('\n').map(r => r.trim()).filter(Boolean);

        // Merge and deduplicate
        const merged = [...new Set([...existingRules, ...newRules])].join('\n');
        area.value = merged;

        // Auto-apply for better UX. Only report the import as done when the
        // SW actually accepted the merged filters.
        const applied = await saveFilters();
        if (applied) {
          showFilterStatus(`✓ Imported ${file.name} (${newRules.length} rules added)`, 'success');
        }
      } catch (err) {
        showFilterStatus('✗ Import failed: ' + err.message, 'error');
      }
    });
    input.click();
  });
}

function showFilterStatus(msg, type) {
  showStatus('filterStatus', msg, type);
}

function showAllowlistStatus(msg, type) {
  showStatus('allowlistStatus', msg, type);
}

function showSettingsStatus(msg, type) {
  showStatus('settingsStatus', msg, type);
}

function showStatus(id, msg, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error'
    ? 'var(--red)'
    : type === 'warning'
      ? 'var(--yellow)'
      : 'var(--accent2)';
  if (el._clearTimer) clearTimeout(el._clearTimer);
  el._clearTimer = setTimeout(() => { el.textContent = ''; }, 3000);
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------
async function initAllowlist() {
  await renderAllowlist();

  $('btnAddAllowlist').addEventListener('click', async () => {
    const domain = normalizeHostname($('allowlistInput').value);

    if (!domain) {
      showAllowlistStatus('Enter a valid hostname or URL', 'error');
      return;
    }

    try {
      const res = await call('ALLOW_SITE', { domain });
      $('allowlistInput').value = '';
      await renderAllowlist(res?.allowlist);
    } catch {
      showAllowlistStatus('Enter a valid hostname or URL', 'error');
    }
  });

  $('btnExportAllowlist').addEventListener('click', async () => {
    let allowlist;
    try {
      allowlist = await fetchAllowlist();
    } catch (err) {
      showAllowlistStatus('✗ Export failed: ' + err.message, 'error');
      return;
    }
    if (allowlist.length === 0) {
      showAllowlistStatus('Nothing to export — allowlist is empty', 'error');
      return;
    }

    const header = `# Title: Allowlist\n# Exported: ${new Date().toISOString()}\n#\n`;
    const blob = new Blob([header + allowlist.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `allowlist-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      showAllowlistStatus('✓ Allowlist exported', 'success');
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  });

  $('btnImportAllowlist').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.text,text/plain';
    const MAX_IMPORT_BYTES = 1024 * 1024; // 1 MB

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > MAX_IMPORT_BYTES) {
        showAllowlistStatus(`✗ File too large (>${MAX_IMPORT_BYTES / (1024 * 1024)} MB)`, 'error');
        return;
      }

      try {
        const text = await file.text();
        const imported = parseAllowlistText(text);
        if (imported.length === 0) {
          showAllowlistStatus('⚠ Imported file contains no valid sites', 'warning');
          return;
        }

        // Read the current list only to report an accurate "added" count.
        // If this read fails, abort — never fall back to an empty list.
        let current;
        try {
          current = await fetchAllowlist();
        } catch (err) {
          showAllowlistStatus('✗ Import aborted — could not read current allowlist: ' + err.message, 'error');
          return;
        }

        // The SW merges against its authoritative state; a read-then-replace
        // here could wipe the allowlist if the read raced a SW restart.
        const res = await call('ADD_ALLOWLIST_DOMAINS', { domains: imported });
        const merged = normalizeAllowlist(res?.allowlist || []);
        const addedCount = Math.max(0, merged.length - current.length);

        await renderAllowlist(merged);
        if (addedCount === 0) {
          showAllowlistStatus('No new sites to import', 'warning');
        } else {
          showAllowlistStatus(`✓ Imported ${file.name} (${addedCount} sites added)`, 'success');
        }
      } catch (err) {
        showAllowlistStatus('✗ Import failed: ' + err.message, 'error');
      }
    });

    input.click();
  });

  $('allowlistInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnAddAllowlist').click();
  });
}

function parseAllowlistText(text) {
  return normalizeAllowlist(
    text.split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (/^(?:!|#)\s*$/.test(line)) return false;
        if (/^(?:!|#)\s*(Title|Exported):/i.test(line)) return false;
        if (/^(?:!|#)/.test(line)) return false;
        return true;
      })
  );
}

// Throws on failure — callers must not treat "could not read" as "empty".
async function fetchAllowlist() {
  const resp = await call('GET_ALLOWLIST');
  return normalizeAllowlist(Array.isArray(resp) ? resp : []);
}

async function renderAllowlist(allowlistOverride) {
  let allowlist;
  try {
    allowlist = Array.isArray(allowlistOverride)
      ? normalizeAllowlist(allowlistOverride)
      : await fetchAllowlist();
  } catch (err) {
    // Keep whatever is currently rendered rather than showing a false empty.
    showAllowlistStatus('✗ Failed to load allowlist: ' + err.message, 'error');
    return;
  }

  const ul = $('allowlistItems');
  ul.innerHTML = '';

  if (allowlist.length === 0) {
    const li = document.createElement('li');
    li.className = 'allowlist-empty';
    li.textContent = 'No sites in allowlist.';
    ul.appendChild(li);
    return;
  }

  for (const domain of allowlist) {
    const li = document.createElement('li');
    li.className = 'allowlist-item';
    li.innerHTML = `
      <span class="allowlist-item-domain"></span>
      <button class="allowlist-remove" title="Remove">×</button>
    `;
    li.querySelector('.allowlist-item-domain').textContent = domain;

    const removeBtn = li.querySelector('.allowlist-remove');
    removeBtn.dataset.domain = domain;
    removeBtn.setAttribute('aria-label', `Remove ${domain} from allowlist`);
    removeBtn.addEventListener('click', async () => {
      try {
        const res = await call('DISALLOW_SITE', { domain });
        await renderAllowlist(res?.allowlist);
      } catch (err) {
        showAllowlistStatus(`✗ Could not remove ${domain}: ${err.message}`, 'error');
      }
    });
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const SETTING_BINDINGS = [
  { id: 'settingWebRTC',      key: 'blockWebRTC',            fromSettings: (s) => s.blockWebRTC !== false },
  { id: 'settingPing',        key: 'blockHyperlinkAuditing', fromSettings: (s) => s.blockHyperlinkAuditing !== false },
  { id: 'settingHTTPS',       key: 'upgradeInsecureRequests', fromSettings: (s) => s.upgradeInsecureRequests !== false },
  { id: 'settingBadge',       key: 'showBadge',              fromSettings: (s) => s.showBadge !== false },
  { id: 'settingCookies',     key: 'blockThirdPartyCookies', fromSettings: (s) => s.blockThirdPartyCookies === true },
  { id: 'settingFingerprint', key: 'fingerprintProtection',  fromSettings: (s) => s.fingerprintProtection === true },
  { id: 'settingHeaders',     key: 'stripTrackingHeaders',   fromSettings: (s) => s.stripTrackingHeaders !== false },
  { id: 'settingStealth',     key: 'enhancedStealth',        fromSettings: (s) => s.enhancedStealth === true },
  { id: 'settingPersona',     key: 'stealthPersona',         fromSettings: (s) => s.stealthPersona || 'default' },
  { id: 'settingCache',       key: 'cacheProtection',        fromSettings: (s) => s.cacheProtection !== false },
  { id: 'settingReferrer',    key: 'referrerControl',        fromSettings: (s) => s.referrerControl !== false },
];

function applySettingsToDom(settings) {
  const s = settings || {};
  for (const binding of SETTING_BINDINGS) {
    const el = $(binding.id);
    if (!el) continue;
    const value = binding.fromSettings(s);
    if (el.type === 'checkbox') {
      el.checked = value;
    } else {
      el.value = value;
    }
  }
}

async function initSettings() {
  let settings = {};
  try {
    settings = (await call('GET_SETTINGS')) || {};
  } catch (err) {
    showSettingsStatus('✗ Failed to load settings: ' + err.message, 'error');
  }
  applySettingsToDom(settings);

  for (const binding of SETTING_BINDINGS) {
    const el = $(binding.id);
    if (!el) continue;
    el.addEventListener('change', async () => {
      // Send only the changed key; the SW merges it atomically. A full
      // SET_SETTINGS replace from this tab's (possibly stale) DOM would
      // clobber concurrent popup edits (§4.18).
      const value = el.type === 'checkbox' ? el.checked : el.value;
      try {
        const res = await call('UPDATE_SETTINGS', { [binding.key]: value });
        if (res?.settings) applySettingsToDom(res.settings);
      } catch (err) {
        showSettingsStatus('✗ Failed to save setting: ' + err.message, 'error');
        // Re-sync the control with the SW's authoritative state.
        try {
          applySettingsToDom((await call('GET_SETTINGS')) || {});
        } catch {}
      }
    });
  }

  // Keep this tab's DOM in sync with edits made elsewhere (e.g. the popup's
  // persona selector) so a later change here can't revert them.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    applySettingsToDom(changes.settings.newValue || {});
  });
}

// ---------------------------------------------------------------------------
// Live Logger
// ---------------------------------------------------------------------------
class LiveLogger {
  constructor() {
    this.events = [];
    this.maxEvents = 1000;
    this.filter = 'all';
    this.searchQuery = '';
    this.container = $('loggerItems');

    if (!this.container) return;

    this.bindEvents();
    this.listen();
  }

  bindEvents() {
    $('btnClearLogger')?.addEventListener('click', () => this.clear());
    $('btnExportLogger')?.addEventListener('click', () => this.export());
    $('loggerFilter')?.addEventListener('change', (e) => {
      this.filter = e.target.value;
      this.render();
    });
    $('loggerSearch')?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.render();
    });
  }

  export() {
    if (this.events.length === 0) return;

    const filtered = this.events.filter(e => this.matchesFilter(e));
    if (filtered.length === 0) return;

    let csvContent = 'Time,Type,Action,Info,Extra\n';

    for (const e of filtered) {
      const time = new Date(e.timestamp).toISOString();
      let info = '';
      let extra = '';

      if (e.type === 'network') {
        info = e.url;
        extra = `${e.method} | ${e.resourceType} | ${e.rulesetId}${e.isTracker ? ' | tracker' : ''}`;
      } else {
        info = e.selector;
        extra = e.hostname || 'generic';
      }

      // Escape quotes for CSV
      const safeInfo = `"${info.replace(/"/g, '""')}"`;
      const safeExtra = `"${extra.replace(/"/g, '""')}"`;

      csvContent += `${time},${e.type},${e.action},${safeInfo},${safeExtra}\n`;
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `nullify-log-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  listen() {
    this._loggerListener = (message, sender) => {
      // Only accept logger broadcasts from the background service worker
      // (same extension id, no tab). Pages or external senders must not be
      // able to inject fake rows into the log view.
      if (!sender || sender.id !== chrome.runtime.id || sender.tab) return;
      if (message?.type === 'LOGGER_EVENT') {
        this.addEvent(message.payload);
      }
    };
    chrome.runtime.onMessage.addListener(this._loggerListener);
    window.addEventListener('beforeunload', () => {
      if (this._loggerListener) {
        chrome.runtime.onMessage.removeListener(this._loggerListener);
      }
    });
  }

  addEvent(event) {
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events.pop();
    }

    // Only render immediately if it matches current filters
    if (this.matchesFilter(event)) {
      const row = this.createLogRow(event);
      this.container.prepend(row);

      // Limit DOM size too
      if (this.container.children.length > this.maxEvents) {
        this.container.lastElementChild.remove();
      }
    }
  }

  matchesFilter(event) {
    if (this.filter !== 'all' && event.type !== this.filter) return false;
    if (this.searchQuery) {
      const text = (event.url || event.selector || '').toLowerCase();
      if (!text.includes(this.searchQuery)) return false;
    }
    return true;
  }

  clear() {
    this.events = [];
    this.container.innerHTML = '';
  }

  render() {
    this.container.innerHTML = '';
    const filtered = this.events.filter(e => this.matchesFilter(e));
    const fragment = document.createDocumentFragment();

    for (const event of filtered) {
      fragment.appendChild(this.createLogRow(event));
    }
    this.container.appendChild(fragment);
  }

  createLogRow(e) {
    const row = document.createElement('div');
    row.className = 'log-entry';

    const time = new Date(e.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const typeBadge = e.type === 'network' ? 'badge-network' : 'badge-cosmetic';
    const actionBadge = e.action === 'block' ? 'badge-block' : e.action === 'allow' ? 'badge-allow' : e.action === 'modify' ? 'badge-modify' : e.action === 'remove' ? 'badge-remove' : 'badge-hide';
    const trackerBadge = e.isTracker ? '<span class="log-badge" style="background:rgba(255,121,198,0.15);color:#ff79c6;margin-left:4px">tracker</span>' : '';
    const entityBadge = e.entity ? `<span class="log-badge" style="background:rgba(88,166,255,0.15);color:#58a6ff;margin-left:4px">${this.esc(e.entity)}</span>` : '';

    let infoHtml = '';
    if (e.type === 'network') {
      infoHtml = `<span class="log-url" title="Click to copy: ${this.esc(e.url)}" data-copy="${this.esc(e.url)}" style="cursor:pointer; text-decoration:underline dashed; text-underline-offset:2px">${this.esc(e.url)}</span>
                  ${trackerBadge} ${entityBadge}
                  <span class="log-extra">${this.esc(e.method)} • ${this.esc(e.resourceType)} • ${this.esc(e.rulesetId)}#${this.esc(e.ruleId)}</span>`;
    } else {
      infoHtml = `<span class="log-selector" title="Click to copy: ${this.esc(e.selector)}" data-copy="${this.esc(e.selector)}" style="cursor:pointer; text-decoration:underline dashed; text-underline-offset:2px">${this.esc(e.selector)}</span>
                  <span class="log-extra" title="${this.esc(e.hostname)}">${this.esc(e.hostname)}</span>`;
    }

    // `type`/`action` originate from content-script payloads (the SW passes
    // `payload.action` through unvalidated), so they must be escaped like
    // every other field before entering this privileged page's DOM (§4.13).
    row.innerHTML = `
      <div class="log-col-time">${this.esc(time)}</div>
      <div class="log-col-type"><span class="log-badge ${typeBadge}"></span></div>
      <div class="log-col-action"><span class="log-badge ${actionBadge}"></span></div>
      <div class="log-col-info">${infoHtml}</div>
    `;
    row.querySelector('.log-col-type .log-badge').textContent = e.type ?? '';
    row.querySelector('.log-col-action .log-badge').textContent = e.action ?? '';

    // Add click-to-copy handler
    const copyTarget = row.querySelector('[data-copy]');
    if (copyTarget) {
      copyTarget.addEventListener('click', async (ev) => {
        try {
          const textToCopy = ev.target.getAttribute('data-copy');
          await navigator.clipboard.writeText(textToCopy);

          // Brief visual feedback
          const originalTitle = ev.target.title;
          ev.target.title = "Copied!";
          ev.target.style.opacity = "0.5";
          setTimeout(() => {
            ev.target.title = originalTitle;
            ev.target.style.opacity = "1";
          }, 800);
        } catch (err) {
          console.error("Failed to copy", err);
        }
      });
    }

    return row;
  }

  esc(s) {
    // Treat null/undefined as empty but let falsy numbers like 0 render —
    // DNR ruleId is numeric and 0 is a valid id.
    if (s === null || s === undefined || s === '') return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main() {
  initNav();
  await Promise.all([
    initFilterLists(),
    initMyFilters(),
    initAllowlist(),
    initSettings(),
  ]);

  // Initialize Logger
  new LiveLogger();
}

main().catch(console.error);
