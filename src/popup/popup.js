/**
 * popup.js — Extension popup controller
 */

import './popup.css';
import { normalizeHostname } from '../shared/hostname.js';

const $ = (id) => document.getElementById(id);

const FILTER_LIST_NAMES = {
  easylist: 'EasyList',
  easyprivacy: 'EasyPrivacy',
  annoyances: 'Annoyances',
  'ubo-cookie-annoyances': 'Cookie Annoyances',
  malware: 'Malware',
  'ubo-filters': 'uBO Filters',
  'ubo-unbreak': 'uBO Unbreak',
  'anti-adblock': 'Anti-Adblock',
};

let currentTab = null;
let currentHostname = '';
let isSiteAllowed = false;

/**
 * Popup-side service-worker messaging wrapper (§4.16). The bus reports
 * failure as `undefined`, `{error}`, or `{ok:false}` — none of which reject
 * the raw sendMessage promise, so every call must go through here. Mirrors
 * `src/options/messaging.js` (which carries the regression tests).
 */
async function call(type, payload) {
  const message = payload === undefined ? { type } : { type, payload };
  const resp = await chrome.runtime.sendMessage(message);
  if (resp === undefined) {
    throw new Error(`${type}: no response from service worker`);
  }
  if (resp !== null && typeof resp === 'object' && !Array.isArray(resp)) {
    if (resp.error) throw new Error(String(resp.error));
    if (resp.ok === false) throw new Error(`${type} failed`);
  }
  return resp;
}

let _statusTimer = null;
function showPopupStatus(msg) {
  const el = $('popupStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  if (_statusTimer) clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => {
    el.textContent = '';
    el.classList.remove('visible');
  }, 3000);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  try {
    const url = new URL(tab.url);
    currentHostname = normalizeHostname(url.hostname);
  } catch {
    currentHostname = '';
  }

  $('siteUrl').textContent = currentHostname || 'This page';

  await Promise.all([
    loadTabStats(),
    loadSiteStatus(),
    loadFilterLists(),
    loadSettings(),
  ]);

  bindEvents();
}

async function loadSettings() {
  try {
    const settings = await call('GET_SETTINGS');
    if (settings?.stealthPersona) {
      $('selectPersona').value = settings.stealthPersona;
    }
  } catch (err) {
    console.error('[Nullify] failed to load settings:', err);
  }
}

async function loadTabStats() {
  try {
    const [stats, dailyTotal] = await Promise.all([
      call('GET_TAB_STATS', { tabId: currentTab.id }),
      call('GET_DAILY_BLOCKED_TOTAL'),
    ]);

    // Packed builds have no onRuleMatchedDebug, so network counters cannot
    // tick (§4.25) — show an honest placeholder instead of a misleading 0.
    if (stats?.networkStatsAvailable === false) {
      const note = 'Detailed network counters require an unpacked (developer mode) install';
      for (const id of ['blockedCount', 'trackerCount', 'totalBlocked']) {
        $(id).textContent = '—';
        $(id).title = note;
        $(id).parentElement?.setAttribute('title', note);
      }
    } else {
      $('blockedCount').textContent = stats?.blocked ?? 0;
      $('trackerCount').textContent = stats?.trackers ?? 0;
      $('totalBlocked').textContent = dailyTotal?.total ?? 0;
    }
  } catch {
    $('blockedCount').textContent = '—';
    $('trackerCount').textContent = '—';
    $('totalBlocked').textContent = '—';
  }
}

async function loadSiteStatus() {
  if (!currentHostname) return;

  try {
    const res = await call('IS_SITE_ALLOWED', { domain: currentHostname });
    isSiteAllowed = res?.allowed === true;
  } catch (err) {
    console.error('[Nullify] failed to load site status:', err);
  }

  updateSiteStatusUI();
}

function updateSiteStatusUI() {
  const siteBar = $('siteBar');
  const siteStatus = $('siteStatus');
  const allowLabel = $('allowLabel');
  const toggleBtn = $('toggleSite');

  if (isSiteAllowed) {
    siteBar.className = 'site-bar paused';
    siteStatus.textContent = 'Paused';
    allowLabel.textContent = 'Resume';
    toggleBtn.classList.add('disabled');
    $('btnAllowSite').classList.add('active');
  } else {
    siteBar.className = 'site-bar';
    siteStatus.textContent = 'Protected';
    allowLabel.textContent = 'Pause on site';
    toggleBtn.classList.remove('disabled');
    $('btnAllowSite').classList.remove('active');
  }
}

async function loadFilterLists() {
  try {
    const enabled = (await call('GET_ENABLED_RULESETS')) || {};
    const chips = $('filterListChips');
    chips.innerHTML = '';

    for (const [id, name] of Object.entries(FILTER_LIST_NAMES)) {
      const state = enabled[id];
      const chip = document.createElement('span');
      chip.className = 'chip' + (state === false ? ' disabled' : state === 'partial' ? ' partial' : '');
      chip.textContent = state === 'partial' ? `${name}*` : name;
      if (state === 'partial') {
        chip.title = `${name} partially enabled due to Chrome static rule limits`;
      }
      chips.appendChild(chip);
    }
  } catch (err) {
    console.error('[Nullify] failed to load filter lists:', err);
  }
}

function bindEvents() {
  // Toggle site allow/disallow
  $('btnAllowSite').addEventListener('click', async () => {
    if (!currentHostname) return;

    const type = isSiteAllowed ? 'DISALLOW_SITE' : 'ALLOW_SITE';
    try {
      // Trust the SW's view, not an optimistic local flip. If the SW
      // reports failure (e.g. invalid domain) the UI must not lie.
      await call(type, { domain: currentHostname });
      const confirmRes = await call('IS_SITE_ALLOWED', { domain: currentHostname });
      isSiteAllowed = !!confirmRes?.allowed;
    } catch (err) {
      console.error('[Nullify] allowlist toggle failed:', err);
      showPopupStatus(isSiteAllowed ? 'Could not resume blocking on this site' : 'Could not pause blocking on this site');
      return;
    }
    updateSiteStatusUI();
  });

  // Power button = same as allow/disallow
  $('toggleSite').addEventListener('click', () => {
    $('btnAllowSite').click();
  });

  // Reload button
  $('btnRefresh').addEventListener('click', () => {
    if (!currentTab?.id) return;
    chrome.tabs.reload(currentTab.id);
    window.close();
  });

  // Open dashboard
  $('btnDashboard').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // Element picker — activate on the current tab then close popup
  $('btnPicker').addEventListener('click', async () => {
    if (!currentTab?.id) return;
    await chrome.tabs.sendMessage(currentTab.id, { type: 'ACTIVATE_PICKER' }).catch(() => {});
    window.close();
  });

  // Persona selector
  $('selectPersona').addEventListener('change', async (e) => {
    const persona = e.target.value;
    try {
      // Send only the changed key so the SW can merge atomically. A full
      // read-modify-write here clobbers concurrent option-page edits.
      await call('UPDATE_SETTINGS', { stealthPersona: persona });

      if (!currentTab?.id) return;
      chrome.tabs.reload(currentTab.id);
      window.close();
    } catch (err) {
      console.error('Failed to update persona:', err);
      showPopupStatus('Could not update persona');
      // Re-sync the selector with the SW's authoritative state.
      loadSettings();
    }
  });
}

init().catch(console.error);
