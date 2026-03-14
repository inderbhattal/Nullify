/**
 * options.js — Dashboard controller
 */

import './options.css';

const $ = (id) => document.getElementById(id);

const FILTER_LISTS = [
  { id: 'easylist',     name: 'EasyList',        desc: 'The most widely used ad-blocking filter list' },
  { id: 'easyprivacy',  name: 'EasyPrivacy',      desc: 'Tracker, analytics, and surveillance blocking' },
  { id: 'annoyances',   name: 'Fanboy Annoyances', desc: 'Cookie notices, popups, social overlays' },
  { id: 'malware',      name: 'Malware Blocklist', desc: 'Blocks malware and phishing URLs' },
  { id: 'ubo-filters',  name: 'uBO Filters',       desc: 'uBlock Origin default filter list' },
  { id: 'ubo-unbreak',  name: 'uBO Unbreak',       desc: 'Fixes over-blocking by other lists' },
];

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function initNav() {
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
  try {
    enabled = await chrome.runtime.sendMessage({ type: 'GET_ENABLED_RULESETS' }) || {};
  } catch {}

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
    // Trigger background update check
    await chrome.runtime.sendMessage({ type: 'CHECK_FILTER_UPDATES' }).catch(() => {});
    setTimeout(() => {
      $('btnUpdateAll').textContent = 'Update All';
      $('btnUpdateAll').disabled = false;
    }, 1500);
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

  $('btnApplyFilters').addEventListener('click', async () => {
    const filters = $('userFiltersArea').value;
    try {
      await chrome.runtime.sendMessage({
        type: 'SET_USER_FILTERS',
        payload: { filters },
      });
      showFilterStatus('✓ Filters applied successfully', 'success');
    } catch (err) {
      showFilterStatus('✗ Error: ' + err.message, 'error');
    }
  });

  // Ctrl+Enter / Cmd+Enter to apply
  $('userFiltersArea').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      $('btnApplyFilters').click();
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
        area.value = existing ? existing + '\n' + filtered : filtered;
        showFilterStatus(`✓ Imported ${file.name} — click Apply to activate`, 'success');
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
    const domain = $('allowlistInput').value.trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*/, '')
      .toLowerCase();

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

  const saveSettings = async () => {
    await chrome.runtime.sendMessage({
      type: 'SET_SETTINGS',
      payload: {
        blockWebRTC: $('settingWebRTC').checked,
        blockHyperlinkAuditing: $('settingPing').checked,
        upgradeInsecureRequests: $('settingHTTPS').checked,
        showBadge: $('settingBadge').checked,
      },
    });
  };

  ['settingWebRTC', 'settingPing', 'settingHTTPS', 'settingBadge'].forEach((id) => {
    $(id).addEventListener('change', saveSettings);
  });
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
}

main().catch(console.error);
