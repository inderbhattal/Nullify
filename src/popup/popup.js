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
};

let currentTab = null;
let currentHostname = '';
let isSiteAllowed = false;

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
    const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (settings?.stealthPersona) {
      $('selectPersona').value = settings.stealthPersona;
    }
  } catch {}
}

async function loadTabStats() {
  try {
    const stats = await chrome.runtime.sendMessage({
      type: 'GET_TAB_STATS',
      payload: { tabId: currentTab.id },
    });
    $('blockedCount').textContent = stats?.blocked ?? 0;
    $('trackerCount').textContent = stats?.trackers ?? 0;
  } catch {
    $('blockedCount').textContent = '—';
    $('trackerCount').textContent = '—';
  }

  // Total today from storage
  try {
    const data = await chrome.storage.local.get('totalBlockedToday');
    $('totalBlocked').textContent = data.totalBlockedToday ?? 0;
  } catch {}
}

async function loadSiteStatus() {
  if (!currentHostname) return;

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'IS_SITE_ALLOWED',
      payload: { domain: currentHostname },
    });
    isSiteAllowed = res?.allowed === true;
  } catch {}

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
    const enabled = await chrome.runtime.sendMessage({ type: 'GET_ENABLED_RULESETS' });
    const chips = $('filterListChips');
    chips.innerHTML = '';

    for (const [id, name] of Object.entries(FILTER_LIST_NAMES)) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (enabled[id] === false ? ' disabled' : '');
      chip.textContent = name;
      chips.appendChild(chip);
    }
  } catch {}
}

function bindEvents() {
  // Toggle site allow/disallow
  $('btnAllowSite').addEventListener('click', async () => {
    if (!currentHostname) return;

    if (isSiteAllowed) {
      await chrome.runtime.sendMessage({ type: 'DISALLOW_SITE', payload: { domain: currentHostname } });
    } else {
      await chrome.runtime.sendMessage({ type: 'ALLOW_SITE', payload: { domain: currentHostname } });
    }

    isSiteAllowed = !isSiteAllowed;
    updateSiteStatusUI();
  });

  // Power button = same as allow/disallow
  $('toggleSite').addEventListener('click', () => {
    $('btnAllowSite').click();
  });

  // Reload button
  $('btnRefresh').addEventListener('click', () => {
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
      const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      settings.stealthPersona = persona;
      await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: settings });
      
      // Reload the tab to apply the new User-Agent immediately
      chrome.tabs.reload(currentTab.id);
      window.close();
    } catch (err) {
      console.error('Failed to update persona:', err);
    }
  });
}

init().catch(console.error);
