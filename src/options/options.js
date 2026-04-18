/**
 * options.js — Dashboard controller
 */

import './options.css';

import { normalizeHostname } from '../shared/hostname.js';

const $ = (id) => document.getElementById(id);

const FILTER_LISTS = [
  { id: 'easylist',     name: 'EasyList',        desc: 'The most widely used ad-blocking filter list' },
  { id: 'easyprivacy',  name: 'EasyPrivacy',      desc: 'Tracker, analytics, and surveillance blocking' },
  { id: 'annoyances',   name: 'Fanboy Annoyances', desc: 'Cookie notices, popups, social overlays' },
  { id: 'ubo-cookie-annoyances', name: 'uBO Cookie Annoyances', desc: 'Surgically targets cookie consent and tracking notices' },
  { id: 'malware',      name: 'Malware Blocklist', desc: 'Blocks malware and phishing URLs' },
  { id: 'ubo-filters',  name: 'uBO Filters',       desc: 'uBlock Origin default filter list' },
  { id: 'ubo-unbreak',  name: 'uBO Unbreak',       desc: 'Fixes over-blocking by other lists' },
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
    item.addEventListener('click', () => {
      const tabId = item.dataset.tab;

      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));

      item.classList.add('active');
      $(`tab-${tabId}`)?.classList.add('active');
    });
  });
}

// ---------------------------------------------------------------------------
// Filter Lists
// ---------------------------------------------------------------------------
async function initFilterLists() {
  let enabled = {};
  let lastUpdate = 0;
  try {
    const res = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_ENABLED_RULESETS' }),
      chrome.storage.local.get('lastUpdateCheck')
    ]);
    enabled = res[0] || {};
    lastUpdate = res[1]?.lastUpdateCheck || 0;
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
    const isEnabled = enabled[list.id] !== false;

    const card = document.createElement('div');
    card.className = 'list-card' + (isEnabled ? '' : ' disabled');
    card.innerHTML = `
      <label class="list-toggle">
        <input type="checkbox" ${isEnabled ? 'checked' : ''} data-listid="${list.id}">
        <span class="list-toggle-track"></span>
      </label>
      <div class="list-info">
        <div class="list-name">${list.name}</div>
        <div class="list-desc">${list.desc}</div>
      </div>
      <div class="list-meta" id="meta-${list.id}">
        ${isEnabled ? 'Active' : 'Disabled'}
      </div>
    `;

    const checkbox = card.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', async () => {
      const nowEnabled = checkbox.checked;
      card.className = 'list-card' + (nowEnabled ? '' : ' disabled');
      $(`meta-${list.id}`).textContent = nowEnabled ? 'Active' : 'Disabled';

      await chrome.runtime.sendMessage({
        type: 'SET_RULESET_ENABLED',
        payload: { rulesetId: list.id, enabled: nowEnabled },
      });
    });

    grid.appendChild(card);
  }

  $('btnUpdateAll').addEventListener('click', async () => {
    $('btnUpdateAll').textContent = 'Updating...';
    $('btnUpdateAll').disabled = true;
    
    try {
      // Trigger background update check
      await chrome.runtime.sendMessage({ type: 'CHECK_FILTER_UPDATES' });
      
      // Refresh last update time
      const res = await chrome.storage.local.get('lastUpdateCheck');
      lastUpdate = res.lastUpdateCheck || Date.now();
      updateStatusText();
    } catch (err) {
      console.error('Update failed:', err);
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
    const res = await chrome.runtime.sendMessage({ type: 'GET_USER_FILTERS' });
    $('userFiltersArea').value = res?.filters || '';
  } catch {}

  const saveFilters = async () => {
    const filters = $('userFiltersArea').value;
    try {
      const counts = await chrome.runtime.sendMessage({
        type: 'SET_USER_FILTERS',
        payload: { filters },
      });
      const msg = counts 
        ? `✓ Applied ${counts.network} network and ${counts.cosmetic} cosmetic rules`
        : '✓ Filters applied successfully';
      showFilterStatus(msg, 'success');
    } catch (err) {
      showFilterStatus('✗ Error: ' + err.message, 'error');
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
    const a = document.createElement('a');
    a.href = url;
    a.download = `my-filters-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showFilterStatus('✓ Filters exported', 'success');
  });

  // Import filters from file
  $('btnImportFilters').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.text,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
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
        
        // Auto-apply for better UX
        await saveFilters();
        showFilterStatus(`✓ Imported ${file.name} (${newRules.length} rules added)`, 'success');
      } catch (err) {
        showFilterStatus('✗ Import failed: ' + err.message, 'error');
      }
    });
    input.click();
  });
}

function showFilterStatus(msg, type) {
  const el = $('filterStatus');
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--red)' : 'var(--accent2)';
  setTimeout(() => { el.textContent = ''; }, 3000);
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------
async function initAllowlist() {
  await renderAllowlist();

  $('btnAddAllowlist').addEventListener('click', async () => {
    const domain = normalizeHostname($('allowlistInput').value);

    if (!domain) return;

    await chrome.runtime.sendMessage({
      type: 'ALLOW_SITE',
      payload: { domain },
    });

    $('allowlistInput').value = '';
    await renderAllowlist();
  });

  $('allowlistInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnAddAllowlist').click();
  });
}

async function renderAllowlist() {
  let allowlist = [];
  try {
    allowlist = await chrome.runtime.sendMessage({ type: 'GET_ALLOWLIST' }) || [];
  } catch {}

  const ul = $('allowlistItems');
  ul.innerHTML = '';

  if (allowlist.length === 0) {
    ul.innerHTML = '<li style="color: var(--text-muted); font-size: 13px; padding: 12px;">No sites in allowlist.</li>';
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
    removeBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: 'DISALLOW_SITE',
        payload: { domain },
      });
      await renderAllowlist();
    });
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function initSettings() {
  let settings = {};
  try {
    settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }) || {};
  } catch {}

  $('settingWebRTC').checked = settings.blockWebRTC !== false;
  $('settingPing').checked = settings.blockHyperlinkAuditing !== false;
  $('settingHTTPS').checked = settings.upgradeInsecureRequests !== false;
  $('settingBadge').checked = settings.showBadge !== false;
  $('settingCookies').checked = settings.blockThirdPartyCookies === true;
  $('settingFingerprint').checked = settings.fingerprintProtection !== false;
  $('settingHeaders').checked = settings.stripTrackingHeaders !== false;
  $('settingStealth').checked = settings.enhancedStealth === true;
  $('settingPersona').value = settings.stealthPersona || 'default';
  $('settingCache').checked = settings.cacheProtection !== false;
  $('settingReferrer').checked = settings.referrerControl !== false;

  const saveSettings = async () => {
    await chrome.runtime.sendMessage({
      type: 'SET_SETTINGS',
      payload: {
        blockWebRTC: $('settingWebRTC').checked,
        blockHyperlinkAuditing: $('settingPing').checked,
        upgradeInsecureRequests: $('settingHTTPS').checked,
        showBadge: $('settingBadge').checked,
        blockThirdPartyCookies: $('settingCookies').checked,
        fingerprintProtection: $('settingFingerprint').checked,
        stripTrackingHeaders: $('settingHeaders').checked,
        enhancedStealth: $('settingStealth').checked,
        stealthPersona: $('settingPersona').value,
        cacheProtection: $('settingCache').checked,
        referrerControl: $('settingReferrer').checked,
      },
    });
  };

  ['settingWebRTC', 'settingPing', 'settingHTTPS', 'settingBadge', 'settingCookies', 'settingFingerprint', 'settingHeaders', 'settingStealth', 'settingPersona', 'settingCache', 'settingReferrer'].forEach((id) => {
    $(id).addEventListener('change', saveSettings);
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
    const a = document.createElement('a');
    a.href = url;
    a.download = `nullify-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  listen() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'LOGGER_EVENT') {
        this.addEvent(message.payload);
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
                  <span class="log-extra">${e.method} • ${e.resourceType} • ${e.rulesetId}#${e.ruleId}</span>`;
    } else {
      infoHtml = `<span class="log-selector" title="Click to copy: ${this.esc(e.selector)}" data-copy="${this.esc(e.selector)}" style="cursor:pointer; text-decoration:underline dashed; text-underline-offset:2px">${this.esc(e.selector)}</span>
                  <span class="log-extra" title="${this.esc(e.hostname)}">${this.esc(e.hostname)}</span>`;
    }

    row.innerHTML = `
      <div class="log-col-time">${time}</div>
      <div class="log-col-type"><span class="log-badge ${typeBadge}">${e.type}</span></div>
      <div class="log-col-action"><span class="log-badge ${actionBadge}">${e.action}</span></div>
      <div class="log-col-info">${infoHtml}</div>
    `;

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
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
