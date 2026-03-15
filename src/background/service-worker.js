/**
 * service-worker.js
 *
 * The background service worker for AdBlock MV3.
 *
 * Responsibilities:
 *  - On install/startup: initialize storage, load cosmetic/scriptlet rules
 *  - Manage dynamic DNR rules (user filters, per-site exceptions)
 *  - Track blocked-request counts per tab
 *  - Respond to messages from content scripts (provide scriptlets, cosmetic rules)
 *  - Schedule periodic filter-list update checks (alarms)
 *  - Manage per-site allowlist
 *  - Apply WebRTC/privacy settings
 */

import { StorageKeys, getStorage, setStorage, getAllowlist } from '../shared/storage.js';
import { RulesDB } from '../shared/db.js';
import { BloomFilter } from '../shared/bloom.js';

const db = new RulesDB();
let bloom = new BloomFilter();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ALARM_FILTER_UPDATE = 'filter-list-update';
const ALARM_STATS_CLEANUP = 'stats-cleanup';
const FILTER_UPDATE_INTERVAL_MINUTES = 24 * 60; // 24 hours
const STATS_CLEANUP_INTERVAL_MINUTES = 30;

// DNR rule ID ranges (avoid collisions between categories)
const DNR_USER_RULES_START = 900_000;
const DNR_ALLOWLIST_START = 990_000;

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[AdBlock] onInstalled:', details.reason);

  if (details.reason === 'install') {
    await initializeDefaults();
  }

  await ingestRules(); // Build initial rule index
  await applyPrivacySettings();
  await scheduleFilterUpdateAlarm();

  // Update badge for all existing tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    updateBadge(tab.id);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadBloomFilter();
  await applyPrivacySettings();
  await scheduleFilterUpdateAlarm();
});

async function loadBloomFilter() {
  const data = await getStorage(StorageKeys.BLOOM_FILTER);
  if (data) {
    try {
      bloom = BloomFilter.deserialize(data);
      console.log('[AdBlock] Bloom Filter loaded');
    } catch (err) {
      console.error('[AdBlock] Failed to deserialize Bloom Filter:', err);
    }
  }
}

/**
 * Fetch latest rules and index them into IndexedDB.
 * This keeps the Service Worker's memory usage low by not holding rules in RAM.
 */
async function ingestRules() {
  try {
    // 1. Ingest Cosmetic Rules
    const cosUrl = chrome.runtime.getURL('rules/cosmetic-rules.json');
    const cosData = await (await fetch(cosUrl)).json();

    // 2. Ingest Scriptlet Rules
    const scriptUrl = chrome.runtime.getURL('rules/scriptlet-rules.json');
    const scriptData = await (await fetch(scriptUrl)).json();

    console.log(`[AdBlock] Indexing ${cosData.generic?.length || 0} generic and ${Object.keys(cosData.domainSpecific || {}).length} domain-specific cosmetic rules...`);
    console.log(`[AdBlock] Indexing ${scriptData.length || 0} scriptlet rules...`);

    // Wipe and rebuild index
    await db.clear();
    
    // Build a new Bloom Filter for all hostnames
    const newBloom = new BloomFilter();

    if (cosData.domainSpecific) {
      await db.putBulkCosmeticRules(cosData.domainSpecific);
      for (const hostname of Object.keys(cosData.domainSpecific)) {
        newBloom.add(hostname);
      }
    }
    
    if (scriptData) {
      await db.putBulkScriptletRules(scriptData);
      for (const rule of scriptData) {
        if (rule.domains) {
          for (const d of rule.domains) newBloom.add(d);
        }
      }
    }

    // Save Bloom Filter
    bloom = newBloom;
    await setStorage(StorageKeys.BLOOM_FILTER, bloom.serialize());

    // Pre-compile generic rules into a single CSS block
    if (cosData.generic && cosData.generic.length > 0) {
      // Chunking if too large for storage, but 2MB is usually okay for one key
      const css = cosData.generic.join(',') + ' { display: none !important; }';
      await setStorage(StorageKeys.GENERIC_CSS, css);
    }

    await setStorage(StorageKeys.COSMETIC_RULES_VERSION, Date.now());
    console.log('[AdBlock] Rule indexing and Bloom Filter build complete');
  } catch (err) {
    console.error('[AdBlock] Failed to ingest rules:', err);
  }
}

// ---------------------------------------------------------------------------
// Context Menu — Quick Access to Picker
// ---------------------------------------------------------------------------
chrome.contextMenus.create({
  id: 'nullify-block-element',
  title: 'Block element...',
  contexts: ['all'],
}, () => {
  if (chrome.runtime.lastError) {
    // Ignore error if already exists
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'nullify-block-element' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'ACTIVATE_PICKER' }).catch(() => {
      // Tab might not have content script loaded yet
    });
  }
});


// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
async function initializeDefaults() {
  const existing = await getStorage(StorageKeys.SETTINGS);
  if (existing) return;

  await setStorage(StorageKeys.SETTINGS, {
    blockWebRTC: true,
    upgradeInsecureRequests: true,
    blockHyperlinkAuditing: true,
    blockThirdPartyCookies: false,
    fingerprintProtection: true,
    stripTrackingHeaders: true,
    enhancedStealth: false,
    stealthPersona: 'default',
    cacheProtection: true,
    referrerControl: true,
    enabled: true,
  });

  await setStorage(StorageKeys.ALLOWLIST, []);
  await setStorage(StorageKeys.USER_FILTERS, '');
  await setStorage(StorageKeys.TAB_STATS, {});
  await setStorage(StorageKeys.FILTER_LISTS_META, {});

  // Enabled/disabled rulesets
  await setStorage(StorageKeys.ENABLED_RULESETS, {
    easylist: true,
    easyprivacy: true,
    annoyances: true,
    malware: true,
    'ubo-filters': true,
    'ubo-unbreak': true,
  });

  console.log('[AdBlock] Defaults initialized');
}

// ---------------------------------------------------------------------------
// Privacy settings
// ---------------------------------------------------------------------------
async function applyPrivacySettings() {
  const settings = await getStorage(StorageKeys.SETTINGS) || {};

  // Block WebRTC IP leaks
  if (chrome.privacy && settings.blockWebRTC !== false) {
    chrome.privacy.network.webRTCIPHandlingPolicy.set({
      value: 'disable_non_proxied_udp',
    });
  }

  // Block hyperlink auditing (ping attribute)
  if (chrome.privacy && settings.blockHyperlinkAuditing !== false) {
    chrome.privacy.websites.hyperlinkAuditingEnabled.set({ value: false });
  }

  // Block third-party cookies
  if (chrome.privacy && settings.blockThirdPartyCookies) {
    chrome.privacy.websites.thirdPartyCookiesAllowed.set({ value: false });
  } else if (chrome.privacy) {
    chrome.privacy.websites.thirdPartyCookiesAllowed.set({ value: true });
  }

  // Update header stripping rules
  await applyHeaderRules(settings.stripTrackingHeaders !== false);

  // Update stealth rules (CSP stripping)
  await applyStealthRules(settings.enhancedStealth === true);

  // Update persona rules
  await applyPersonaRules(settings.stealthPersona || 'default');

  // Update cache protection rules
  await applyCacheProtectionRules(settings.cacheProtection !== false);

  // Update referrer control rules
  await applyReferrerControlRules(settings.referrerControl !== false);
}

const DNR_HEADER_RULES_START = 800_000;
const DNR_STEALTH_RULES_START = 810_000;

/** Apply DNR rules to strip tracking headers (Referer, Set-Cookie). */
async function applyHeaderRules(enabled) {
  const ruleIds = [DNR_HEADER_RULES_START, DNR_HEADER_RULES_START + 1];
  
  if (!enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ruleIds,
    });
    return;
  }

  const rules = [
    {
      id: DNR_HEADER_RULES_START,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'remove' }]
      },
      condition: {
        domainType: 'thirdParty',
        resourceTypes: ['script', 'xmlhttprequest', 'other']
      }
    },
    {
      id: DNR_HEADER_RULES_START + 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
      },
      condition: {
        domainType: 'thirdParty',
        resourceTypes: ['script', 'xmlhttprequest', 'other']
      }
    }
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ruleIds,
    addRules: rules,
  });
}

/** Apply DNR rules to strip CSP headers for advanced scriptlet injection. */
async function applyStealthRules(enabled) {
  const ruleId = DNR_STEALTH_RULES_START;
  
  if (!enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
    });
    return;
  }

  const rules = [
    {
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'x-content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' }
        ]
      },
      condition: {
        resourceTypes: ['main_frame', 'sub_frame']
      }
    }
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: rules,
  });
}

const PERSONAS = {
  windows: {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    chUA: '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    platform: 'Windows'
  },
  mac: {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    chUA: '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    platform: 'macOS'
  },
  linux: {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    chUA: '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    platform: 'Linux'
  }
};

/** Apply DNR rules to spoof User-Agent and Client Hints. */
async function applyPersonaRules(personaId) {
  const ruleId = DNR_PERSONA_RULES_START;
  const persona = PERSONAS[personaId];

  if (!persona || personaId === 'default') {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
    return;
  }

  const rules = [{
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'user-agent', operation: 'set', value: persona.ua },
        { header: 'sec-ch-ua', operation: 'set', value: persona.chUA },
        { header: 'sec-ch-ua-platform', operation: 'set', value: `"${persona.platform}"` },
        { header: 'sec-ch-ua-mobile', operation: 'set', value: '?0' }
      ]
    },
    condition: { resourceTypes: ['main_frame', 'sub_frame', 'script', 'xmlhttprequest', 'other'] }
  }];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: rules
  });
}

/** Strip ETag and Last-Modified to prevent cache-based tracking. */
async function applyCacheProtectionRules(enabled) {
  const ruleId = DNR_CACHE_RULES_START;
  
  if (!enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
    return;
  }

  const rules = [{
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'etag', operation: 'remove' },
        { header: 'last-modified', operation: 'remove' }
      ]
    },
    condition: {
      domainType: 'thirdParty',
      resourceTypes: ['script', 'xmlhttprequest', 'other']
    }
  }];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: rules
  });
}

/** Enforce strict Referrer-Policy. */
async function applyReferrerControlRules(enabled) {
  const ruleId = DNR_REFERRER_RULES_START;
  
  if (!enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
    return;
  }

  const rules = [{
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'referrer-policy', operation: 'set', value: 'strict-origin-when-cross-origin' }
      ]
    },
    condition: { resourceTypes: ['main_frame', 'sub_frame'] }
  }];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: rules
  });
}

const DNR_PERSONA_RULES_START = 820_000;
const DNR_CACHE_RULES_START = 830_000;
const DNR_REFERRER_RULES_START = 840_000;


// ---------------------------------------------------------------------------
// Alarms — periodic filter list updates
// ---------------------------------------------------------------------------
async function scheduleFilterUpdateAlarm() {
  await chrome.alarms.clear(ALARM_FILTER_UPDATE);
  chrome.alarms.create(ALARM_FILTER_UPDATE, {
    delayInMinutes: FILTER_UPDATE_INTERVAL_MINUTES,
    periodInMinutes: FILTER_UPDATE_INTERVAL_MINUTES,
  });

  await chrome.alarms.clear(ALARM_STATS_CLEANUP);
  chrome.alarms.create(ALARM_STATS_CLEANUP, {
    delayInMinutes: STATS_CLEANUP_INTERVAL_MINUTES,
    periodInMinutes: STATS_CLEANUP_INTERVAL_MINUTES,
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_FILTER_UPDATE) {
    await checkFilterListUpdates();
  } else if (alarm.name === ALARM_STATS_CLEANUP) {
    await cleanupTabStats();
  }
});

async function cleanupTabStats() {
  const activeTabs = await chrome.tabs.query({});
  const activeTabIds = new Set(activeTabs.map(t => t.id));
  
  let changed = false;
  for (const tabId of Array.from(tabStats.keys())) {
    if (!activeTabIds.has(tabId)) {
      tabStats.delete(tabId);
      changed = true;
    }
  }
  if (changed) await persistTabStats();
}

async function checkFilterListUpdates() {
  console.log('[AdBlock] Checking for filter list updates...');
  
  // Re-index bundled rules to ensure caches (IDB, Bloom Filter) are fresh.
  // In a full production app, this would also fetch new .txt files from the web.
  await ingestRules();
  
  await setStorage(StorageKeys.LAST_UPDATE_CHECK, Date.now());
}

// ---------------------------------------------------------------------------
// Tab stats tracking — count blocked requests per tab
// ---------------------------------------------------------------------------
const tabStats = new Map(); // tabId → { blocked: number, url: string }

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
  persistTabStats();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabStats.set(tabId, { blocked: 0, trackers: 0, url: changeInfo.url });
    updateBadge(tabId);
  }
});

chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
  const { request, rule } = info;
  
  // Track stats
  if (rule.rulesetId !== '_dynamic' && rule.rulesetId !== '_session') {
    if (!tabStats.has(request.tabId)) {
      tabStats.set(request.tabId, { blocked: 0, trackers: 0, url: request.url });
    }
    
    const stats = tabStats.get(request.tabId);
    stats.blocked++;
    
    // Classify as tracker if from privacy/malware lists
    const isTracker = rule.rulesetId === 'easyprivacy' || rule.rulesetId === 'malware';
    if (isTracker) {
      stats.trackers++;
    }
    
    updateBadge(request.tabId);
  }

  // Broadcast to Logger
  broadcastLoggerEvent({
    type: 'network',
    action: rule.rulesetId.includes('allow') ? 'allow' : 'block',
    isTracker: rule.rulesetId === 'easyprivacy' || rule.rulesetId === 'malware',
    url: request.url,
    method: request.method,
    resourceType: request.type,
    rulesetId: rule.rulesetId,
    ruleId: rule.ruleId,
    timestamp: Date.now(),
  });
});

function broadcastLoggerEvent(event) {
  // Send to all open extension pages (options, popup)
  chrome.runtime.sendMessage({
    type: 'LOGGER_EVENT',
    payload: event,
  }).catch(() => {}); // Ignore if no one is listening
}

function updateBadge(tabId) {
  if (!tabId || tabId < 0) return; // ignore non-tab requests (tabId = -1)
  const stats = tabStats.get(tabId);
  const count = stats?.blocked || 0;
  const text = count > 999 ? '999+' : count > 0 ? String(count) : '';

  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#E74C3C', tabId }).catch(() => {});
}

async function persistTabStats() {
  const obj = {};
  for (const [tabId, stats] of tabStats) {
    obj[tabId] = stats;
  }
  await setStorage(StorageKeys.TAB_STATS, obj).catch(() => {});
}

// ---------------------------------------------------------------------------
// Dynamic rules management
// ---------------------------------------------------------------------------

/**
 * Parse cosmetic (##) and exception (#@#) rules from a user filter text.
 * Returns a structure matching the cosmetic-rules.json shape, plus exceptions.
 */
function parseUserCosmeticRules(text) {
  const generic = [];
  const domainSpecific = {};
  const genericExceptions = [];
  const domainExceptions = {};

  for (const line of (text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t.startsWith('[')) continue;

    // Exception first
    const exIdx = t.indexOf('#@#');
    if (exIdx !== -1 && !t.slice(0, exIdx).includes('#')) {
      const domain = t.slice(0, exIdx).trim();
      const sel = t.slice(exIdx + 3).trim();
      if (!sel) continue;
      if (domain) {
        (domainExceptions[domain] = domainExceptions[domain] || []).push(sel);
      } else {
        genericExceptions.push(sel);
      }
      continue;
    }

    // Scriptlet — skip (handled separately)
    if (t.includes('##+js(')) continue;

    const cosIdx = t.indexOf('##');
    if (cosIdx !== -1) {
      const domain = t.slice(0, cosIdx).trim();
      const sel = t.slice(cosIdx + 2).trim();
      if (!sel) continue;
      if (domain) {
        (domainSpecific[domain] = domainSpecific[domain] || []).push(sel);
      } else {
        generic.push(sel);
      }
    }
  }

  return { generic, domainSpecific, genericExceptions, domainExceptions };
}

/** Apply user-defined filters as dynamic DNR rules + cosmetic rules. */
async function applyUserFilters(filtersText) {
  const lines = (filtersText || '').split('\n').filter(Boolean);
  const newRules = [];
  let id = DNR_USER_RULES_START;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('!')) continue;

    const rule = parseSimpleNetworkRule(trimmed, id++);
    if (rule) newRules.push(rule);
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const userRuleIds = existing
    .filter((r) => r.id >= DNR_USER_RULES_START && r.id < DNR_ALLOWLIST_START)
    .map((r) => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: userRuleIds,
    addRules: newRules,
  });

  const cosmeticRules = parseUserCosmeticRules(filtersText);
  await setStorage(StorageKeys.USER_COSMETIC_RULES, cosmeticRules);

  console.log(`[AdBlock] Applied ${newRules.length} user network rules`);
}

/** Parse a simple ABP-style network rule into a DNR rule object. */
function parseSimpleNetworkRule(line, id) {
  const isException = line.startsWith('@@');
  const pattern = isException ? line.slice(2) : line;

  if (!pattern || pattern.length < 3) return null;
  if (pattern.includes('##') || pattern.includes('#@#') || pattern.includes('##+js')) return null;

  const dollarPos = pattern.lastIndexOf('$');
  let urlFilter = pattern;
  let resourceTypes = null;

  if (dollarPos > 0) {
    urlFilter = pattern.slice(0, dollarPos);
    const opts = pattern.slice(dollarPos + 1).split(',');
    const typeMap = {
      script: 'script', image: 'image', stylesheet: 'stylesheet',
      xmlhttprequest: 'xmlhttprequest', document: 'main_frame',
      subdocument: 'sub_frame', font: 'font', media: 'media',
      websocket: 'websocket', ping: 'ping', other: 'other',
    };
    const types = opts.map(o => typeMap[o]).filter(Boolean);
    if (types.length > 0) resourceTypes = types;
  }

  const condition = { urlFilter };
  if (resourceTypes) condition.resourceTypes = resourceTypes;

  return {
    id,
    priority: isException ? 3 : 1,
    condition,
    action: { type: isException ? 'allow' : 'block' },
  };
}

/** Add a site to the per-site allowlist (disable blocking for domain). */
async function allowSite(domain) {
  const allowlist = await getAllowlist();
  if (!allowlist.includes(domain)) {
    allowlist.push(domain);
    await setStorage(StorageKeys.ALLOWLIST, allowlist);
  }
  await rebuildAllowlistRules(allowlist);
}

/** Remove a site from the allowlist. */
async function disallowSite(domain) {
  let allowlist = await getAllowlist();
  allowlist = allowlist.filter((d) => d !== domain);
  await setStorage(StorageKeys.ALLOWLIST, allowlist);
  await rebuildAllowlistRules(allowlist);
}

/** Rebuild DNR allow-all-requests rules from allowlist. */
async function rebuildAllowlistRules(allowlist) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const allowlistRuleIds = existing
    .filter((r) => r.id >= DNR_ALLOWLIST_START)
    .map((r) => r.id);

  const newRules = allowlist.map((domain, i) => ({
    id: DNR_ALLOWLIST_START + i,
    priority: 10,
    condition: {
      requestDomains: [domain],
    },
    action: { type: 'allowAllRequests' },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: allowlistRuleIds,
    addRules: newRules,
  });
}

/** Enable or disable a static ruleset by ID. */
async function setRulesetEnabled(rulesetId, enabled) {
  if (enabled) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [rulesetId],
      disableRulesetIds: [],
    });
  } else {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [],
      disableRulesetIds: [rulesetId],
    });
  }

  const meta = (await getStorage(StorageKeys.ENABLED_RULESETS)) || {};
  meta[rulesetId] = enabled;
  await setStorage(StorageKeys.ENABLED_RULESETS, meta);
}

// ---------------------------------------------------------------------------
// Scriptlet injection
// ---------------------------------------------------------------------------

/**
 * Inject scriptlets into a tab/frame via chrome.scripting.executeScript
 * in the MAIN world — this allows intercepting window-level properties.
 */
async function injectScriptlets(tabId, frameId, scriptletRules) {
  if (!scriptletRules || scriptletRules.length === 0) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: executeScriptlets,
      args: [scriptletRules],
    });
  } catch (err) {
    if (!err.message?.includes('No frame with id')) {
      console.warn('[AdBlock] Scriptlet injection failed:', err.message);
    }
  }
}

/**
 * This function runs in the MAIN world of the page.
 */
function executeScriptlets(specs) {
  let registry = null;
  for (const key of Object.keys(window)) {
    if (key.startsWith('__nu') && typeof window[key]?.run === 'function') {
      registry = window[key];
      break;
    }
  }

  if (!registry) return;

  for (const spec of specs) {
    try {
      registry.run(spec.name, spec.args);
    } catch (e) { }
  }
}

// ---------------------------------------------------------------------------
// Message bus
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; 
});

async function handleMessage(message, sender) {
  const { type, payload } = message;

  switch (type) {
    case 'GET_TAB_STATS': {
      const tabId = payload?.tabId ?? sender.tab?.id;
      return tabStats.get(tabId) || { blocked: 0 };
    }
    case 'GET_SETTINGS':
      return (await getStorage(StorageKeys.SETTINGS)) || {};
    case 'SET_SETTINGS': {
      await setStorage(StorageKeys.SETTINGS, payload);
      await applyPrivacySettings();
      return { ok: true };
    }
    case 'GET_ALLOWLIST':
      return await getAllowlist();
    case 'ALLOW_SITE':
      await allowSite(payload.domain);
      return { ok: true };
    case 'DISALLOW_SITE':
      await disallowSite(payload.domain);
      return { ok: true };
    case 'IS_SITE_ALLOWED': {
      const allowlist = await getAllowlist();
      return { allowed: allowlist.includes(payload.domain) };
    }
    case 'GET_USER_FILTERS':
      return { filters: (await getStorage(StorageKeys.USER_FILTERS)) || '' };
    case 'SET_USER_FILTERS': {
      await setStorage(StorageKeys.USER_FILTERS, payload.filters);
      await applyUserFilters(payload.filters);
      return { ok: true };
    }
    case 'GET_COSMETIC_RULES': {
      return await getCosmeticRulesForPage(payload.hostname);
    }
    case 'GET_SCRIPTLET_RULES': {
      const rules = await getScriptletRulesForPage(payload.hostname);
      if (rules.length > 0 && sender.tab?.id) {
        await injectScriptlets(sender.tab.id, sender.frameId || 0, rules);
      }
      return { rules };
    }

    case 'RUN_SCRIPTLETS': {
      if (payload.scriptlets?.length > 0 && sender.tab?.id) {
        await injectScriptlets(sender.tab.id, sender.frameId || 0, payload.scriptlets);
      }
      return { ok: true };
    }
    case 'SET_RULESET_ENABLED': {
      await setRulesetEnabled(payload.rulesetId, payload.enabled);
      return { ok: true };
    }
    case 'GET_ENABLED_RULESETS':
      return (await getStorage(StorageKeys.ENABLED_RULESETS)) || {};

    case 'CHECK_FILTER_UPDATES': {
      await checkFilterListUpdates();
      return { ok: true };
    }

    case 'CONTENT_BLOCKED': {
      const tabId = sender.tab?.id;
      if (tabId) {
        const entry = tabStats.get(tabId) || { blocked: 0 };
        entry.blocked += payload.count || 1;
        tabStats.set(tabId, entry);
        updateBadge(tabId);

        broadcastLoggerEvent({
          type: 'cosmetic',
          action: 'hide',
          hostname: payload.hostname || sender.tab.url,
          selector: payload.selector,
          count: payload.count || 1,
          timestamp: Date.now(),
        });
      }
      return { ok: true };
    }
    default:
      return { error: `Unknown message type: ${type}` };
  }
}

// ---------------------------------------------------------------------------
// Cosmetic + scriptlet rule lookup
// ---------------------------------------------------------------------------

async function getCosmeticRulesForPage(hostname) {
  const domainSpecific = [];
  const parts = hostname.split('.');
  
  // 1. Check Bloom Filter before hitting IndexedDB
  for (let i = 0; i < parts.length - 1; i++) {
    const domain = parts.slice(i).join('.');
    if (bloom.has(domain)) {
      const domainRules = await db.getCosmeticRules(domain);
      if (domainRules.length > 0) {
        domainSpecific.push(...domainRules);
      }
    }
  }

  const userRules = (await getStorage(StorageKeys.USER_COSMETIC_RULES)) || {};
  const userGeneric = userRules.generic || [];
  const userExceptions = new Set([...(userRules.genericExceptions || [])]);
  const userDomainSelectors = [];

  for (let i = 0; i < parts.length - 1; i++) {
    const domain = parts.slice(i).join('.');
    if (userRules.domainSpecific?.[domain]) {
      userDomainSelectors.push(...userRules.domainSpecific[domain]);
    }
    if (userRules.domainExceptions?.[domain]) {
      for (const sel of userRules.domainExceptions[domain]) userExceptions.add(sel);
    }
  }

  return {
    generic: userGeneric, // Massive static rules are now injected via SW
    domainSpecific: [...domainSpecific, ...userDomainSelectors],
    exceptions: [...userExceptions],
  };
}

async function getScriptletRulesForPage(hostname) {
  const parts = hostname.split('.');
  let mightHaveRules = false;
  
  // Check the empty string key for generic scriptlet rules
  if (bloom.has('')) mightHaveRules = true;
  else {
    for (let i = 0; i < parts.length - 1; i++) {
      if (bloom.has(parts.slice(i).join('.'))) {
        mightHaveRules = true;
        break;
      }
    }
  }

  if (!mightHaveRules) return [];
  
  return await db.getScriptletRules(hostname);
}

// ---------------------------------------------------------------------------
// Injection — Native Generic Hide
// ---------------------------------------------------------------------------
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return; // Only main frame
  if (!details.url.startsWith('http')) return;

  const css = await getStorage(StorageKeys.GENERIC_CSS);
  if (!css) return;

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: details.tabId },
      css: css,
      origin: 'USER',
    });
  } catch (err) {
    // Ignore restricted pages
  }
});
