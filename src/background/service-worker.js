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

import {getAllowlist, getStorage, getStorageBulk, setStorage, StorageKeys} from '../shared/storage.js';
import {RulesDB} from '../shared/db.js';
import {BloomFilter} from '../shared/bloom.js';
import {fetchAndExpand, parseFilterList} from '../shared/filter-parser.js';

// Remote filter list sources (cosmetic + scriptlet rules only; DNR rules are static)
const REMOTE_FILTER_LISTS = [
  { id: 'easylist',    url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'easyprivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { id: 'ubo-filters', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt' },
  { id: 'ubo-unbreak', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt' },
  { id: 'annoyances',  url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt' },
  { id: 'malware',     url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt' },
  { id: 'anti-adblock',url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt' },
];

const db = new RulesDB();
let bloom = new BloomFilter();

// ---- Memory Cache (High Performance) ----
let cachedSettings = null;
let cachedAllowlist = new Set();
let cachedGenericCss = null;
let domainRulesCache = new Map(); // hostname -> rules (LRU, max 100 entries)
const DOMAIN_RULES_CACHE_MAX = 100;

function setCachedDomainRules(hostname, rules) {
  // Evict oldest entry when at capacity (Map preserves insertion order)
  if (domainRulesCache.size >= DOMAIN_RULES_CACHE_MAX) {
    domainRulesCache.delete(domainRulesCache.keys().next().value);
  }
  domainRulesCache.set(hostname, rules);
}
let genericCssLoaded = false;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ALARM_FILTER_UPDATE = 'filter-list-update';
const ALARM_STATS_CLEANUP = 'stats-cleanup';
const FILTER_UPDATE_INTERVAL_MINUTES = 24 * 60; // 24 hours
const STATS_CLEANUP_INTERVAL_MINUTES = 30;

// All known procedural operators that require JS evaluation
const PROC_OPS = [
  'matches-css-before',
  'matches-css-after',
  'matches-css',
  'has-text',
  'nth-ancestor',
  'upward',
  'min-text-length',
  'xpath',
  'watch-attr',
  'remove',
  'style',
  'matches-path',
  'matches-attr',
  'if-not',
  'if',
];

// Compiled regex for high-performance detection (avoiding O(N) loops)
const PROC_OP_REGEX = new RegExp(`:(?:${PROC_OPS.join('|')})\\(`, 'i');

/** Returns true if the selector string contains any procedural operator. */
function isProceduralSelector(selector) {
  if (typeof selector !== 'string') return false;
  return PROC_OP_REGEX.test(selector);
}

/**
 * Depth-aware scan for the first procedural operator in a selector string.
 */
function extractFirstOp(selector) {
  let depth = 0;

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (ch !== ':' || depth !== 0) continue;

    for (const op of PROC_OPS) {
      if (selector.startsWith(op + '(', i + 1)) {
        const base = selector.slice(0, i).trimEnd();
        const argStart = i + 1 + op.length + 1;

        let d = 1, j = argStart;
        while (j < selector.length && d > 0) {
          if (selector[j] === '(') d++;
          else if (selector[j] === ')') d--;
          j++;
        }

        const arg = selector.slice(argStart, j - 1);
        const rest = selector.slice(j).trimStart();
        return { base, op, arg, rest };
      }
    }
  }

  const nativePseudos = [':has(', ':not(', ':is(', ':where('];
  for (const pseudo of nativePseudos) {
    const idx = selector.indexOf(pseudo);
    if (idx !== -1) {
      let d = 1, j = idx + pseudo.length;
      while (j < selector.length && d > 0) {
        if (selector[j] === '(') d++;
        else if (selector[j] === ')') d--;
        j++;
      }
      const inner = selector.slice(idx + pseudo.length, j - 1);
      if (isProceduralSelector(inner)) {
        const base = selector.slice(0, idx).trimEnd();
        const op = pseudo.slice(1, -1);
        const arg = inner;
        const rest = selector.slice(j).trimStart();
        return { base, op, arg, rest };
      }
    }
  }

  return null;
}

/**
 * Pre-parses a procedural selector into an execution plan.
 */
function parseProceduralPlan(selector) {
  const plan = [];
  let remaining = selector;

  while (remaining) {
    const firstOp = extractFirstOp(remaining);
    if (!firstOp) {
      plan.push({ type: 'css', selector: remaining.trim() });
      break;
    }
    
    if (firstOp.base) {
      plan.push({ type: 'css', selector: firstOp.base });
    }
    
    plan.push({ type: 'op', op: firstOp.op, arg: firstOp.arg });
    remaining = firstOp.rest;
  }
  
  return plan;
}


// DNR rule ID ranges (avoid collisions between categories)
const DNR_USER_RULES_START = 900_000;
const DNR_ALLOWLIST_START = 990_000;

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[AdBlock] onInstalled:', details.reason);

  // Register context menu on install/update
  chrome.contextMenus.create({
    id: 'nullify-block-element',
    title: 'Block element...',
    contexts: ['all'],
  }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });

  try {
    if (details.reason === 'install') {
      await initializeDefaults();
    }

    await ingestRules(); // Build initial rule index
    await refreshMemoryCache(); // Fill RAM cache for speed
    await applyPrivacySettings();
    await applyRulesets();
    await scheduleFilterUpdateAlarm();

    // Update badge for all existing tabs
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      updateBadge(tab.id);
    }
  } catch (err) {
    console.error('[Nullify] onInstalled handler failed:', err);
  }
});

// ---- Startup Orchestration (Speed Optimized) ----
let _criticalReady = false;
let _criticalPromise = null;

function startInitialization() {
  if (_criticalPromise) return _criticalPromise;

  _criticalPromise = (async () => {
    // Stage 1: Critical data for responding to content scripts
    await Promise.all([
      loadBloomFilter(),
      refreshMemoryCache(),
    ]);
    _criticalReady = true;

    // Stage 2: Background tasks (non-blocking for messages)
    (async () => {
      const userFilters = await getStorage(StorageKeys.USER_FILTERS);
      await Promise.all([
        applyUserFilters(userFilters || ''),
        applyPrivacySettings(),
        applyRulesets(),
        scheduleFilterUpdateAlarm(),
      ]);
    })().catch(err => console.error('[Nullify] Background startup failed:', err));

  })().catch(err => console.error('[Nullify] Critical startup failed:', err));

  return _criticalPromise;
}

// Ensure startup begins immediately
startInitialization();

chrome.runtime.onStartup.addListener(() => {
  chrome.contextMenus.create({
    id: 'nullify-block-element',
    title: 'Block element...',
    contexts: ['all'],
  }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
  startInitialization();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[AdBlock] onInstalled:', details.reason);

  chrome.contextMenus.create({
    id: 'nullify-block-element',
    title: 'Block element...',
    contexts: ['all'],
  }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });

  try {
    if (details.reason === 'install') {
      await initializeDefaults();
    }

    await ingestRules(); // Build initial rule index
    await startInitialization();

    // Update badge for all existing tabs
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      updateBadge(tab.id);
    }
  } catch (err) {
    console.error('[Nullify] onInstalled handler failed:', err);
  }
});

async function refreshMemoryCache() {
  const data = await getStorageBulk([
    StorageKeys.SETTINGS,
    StorageKeys.ALLOWLIST,
    StorageKeys.GENERIC_CSS
  ]);

  cachedSettings = data[StorageKeys.SETTINGS];
  cachedAllowlist = new Set(data[StorageKeys.ALLOWLIST] || []);

  const genericSelectors = data[StorageKeys.GENERIC_CSS];
  if (Array.isArray(genericSelectors) && genericSelectors.length > 0) {
    cachedGenericCss = genericSelectors.join(',') + ' { display: none !important; visibility: hidden !important; }';
  } else if (typeof genericSelectors === 'string' && genericSelectors.length > 0) {
    // Backwards compat: old installs stored the full CSS string
    cachedGenericCss = genericSelectors;
  } else {
    cachedGenericCss = null;
  }

  domainRulesCache.clear();
  genericCssLoaded = !!cachedGenericCss;
}

async function loadBloomFilter() {
  const data = await getStorage(StorageKeys.BLOOM_FILTER);
  if (data) {
    try {
      // Old format was a base64 string — if so, re-ingest rules to rebuild.
      if (typeof data === 'string') {
        console.log('[AdBlock] Bloom Filter format outdated, rebuilding...');
        await ingestRules();
        return;
      }
      bloom = BloomFilter.deserialize(data);
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

    // Size the Bloom Filter for actual domain count (10 bits/item → ~1% FP rate)
    const domainCount = Object.keys(cosData.domainSpecific || {}).length +
      (scriptData || []).reduce((n, r) => n + (r.domains?.length || 0), 0);
    const newBloom = BloomFilter.forCapacity(domainCount);

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

    // Save Bloom Filter (stored as plain object — no base64 encode/decode overhead)
    bloom = newBloom;
    await setStorage(StorageKeys.BLOOM_FILTER, bloom.serialize());

    // Generic CSS: store selector list only, compile to CSS string in RAM at runtime.
    // Avoids storing/loading megabytes of CSS text from storage on every SW wake.
    if (cosData.generic && cosData.generic.length > 0) {
      await setStorage(StorageKeys.GENERIC_CSS, cosData.generic);
      cachedGenericCss = cosData.generic.join(',') + ' { display: none !important; visibility: hidden !important; }';
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
  await rebuildAllowlistRules([]);
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
    'system-unbreak': true,
    'anti-adblock': true,
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

  // Block third-party cookies (thirdPartyCookiesAllowed removed in Chrome 112)
  if (chrome.privacy?.websites?.thirdPartyCookiesAllowed) {
    chrome.privacy.websites.thirdPartyCookiesAllowed.set({
      value: !settings.blockThirdPartyCookies,
    });
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

let _filterUpdateInProgress = false;

async function checkFilterListUpdates() {
  if (_filterUpdateInProgress) {
    console.log('[AdBlock] Filter update already in progress, skipping.');
    return;
  }
  _filterUpdateInProgress = true;

  try {
    console.log('[AdBlock] Fetching remote filter lists...');

    // Start with bundled rules so curated fixes (e.g. CNN :remove()) take priority.
    // Remote rules are merged in after, then deduplicated — bundled entries win
    // because Set preserves first-seen order.
    const mergedCosmetic = { generic: [], domainSpecific: {}, exceptions: {} };
    const mergedScriptlets = [];

    // 1. Load bundled cosmetic rules first (highest priority)
    try {
      const bundledUrl = chrome.runtime.getURL('rules/cosmetic-rules.json');
      const bundled = await (await fetch(bundledUrl)).json();
      mergedCosmetic.generic.push(...(bundled.generic || []));
      for (const [domain, selectors] of Object.entries(bundled.domainSpecific || {})) {
        mergedCosmetic.domainSpecific[domain] = [...selectors];
      }
    } catch (err) {
      console.warn('[AdBlock] Could not load bundled cosmetic rules:', err.message);
    }

    // 2. Load bundled scriptlet rules
    try {
      const scriptUrl = chrome.runtime.getURL('rules/scriptlet-rules.json');
      const bundledScriptlets = await (await fetch(scriptUrl)).json();
      mergedScriptlets.push(...bundledScriptlets);
    } catch { /* non-fatal */ }

    // 3. Fetch and merge remote filter lists
    for (const list of REMOTE_FILTER_LISTS) {
      try {
        console.log(`[AdBlock] Fetching ${list.id}...`);
        const text = await fetchAndExpand(list.url);
        const { cosmeticRules, scriptletRules } = parseFilterList(text);

        for (const r of cosmeticRules) {
          if (r.domains.length === 0) {
            if (r.exception) continue; // generic exceptions not supported
            mergedCosmetic.generic.push(r.selector);
          } else {
            for (const d of r.domains) {
              if (r.exception) {
                if (!mergedCosmetic.exceptions[d]) mergedCosmetic.exceptions[d] = [];
                mergedCosmetic.exceptions[d].push(r.selector);
              } else {
                if (!mergedCosmetic.domainSpecific[d]) mergedCosmetic.domainSpecific[d] = [];
                mergedCosmetic.domainSpecific[d].push(r.selector);
              }
            }
          }
        }

        for (const r of scriptletRules) mergedScriptlets.push(r);
        console.log(`[AdBlock] ${list.id}: ${cosmeticRules.length} cosmetic, ${scriptletRules.length} scriptlets`);
      } catch (err) {
        console.error(`[AdBlock] Failed to fetch ${list.id}:`, err.message);
      }
    }

    // 4. Deduplicate cosmetic rules (bundled entries win, appearing first in Set)
    mergedCosmetic.generic = [...new Set(mergedCosmetic.generic)];
    for (const d of Object.keys(mergedCosmetic.domainSpecific)) {
      mergedCosmetic.domainSpecific[d] = [...new Set(mergedCosmetic.domainSpecific[d])];
    }

    // 5. Deduplicate scriptlets by name+domains fingerprint
    const scriptletSeen = new Set();
    const dedupedScriptlets = mergedScriptlets.filter(r => {
      const key = r.name + '|' + (r.domains || []).sort().join(',') + '|' + (r.args || []).join(',');
      if (scriptletSeen.has(key)) return false;
      scriptletSeen.add(key);
      return true;
    });

    // 6. Merge domain-specific exceptions into domainSpecific store for retrieval
    // Store them with a special prefix so getCosmeticRulesForPage can identify them
    for (const [d, selectors] of Object.entries(mergedCosmetic.exceptions)) {
      if (!mergedCosmetic.domainSpecific[d]) mergedCosmetic.domainSpecific[d] = [];
      // Prefix exception selectors so the engine can un-hide them
      for (const sel of selectors) {
        const exceptionKey = '__exception__' + sel;
        if (!mergedCosmetic.domainSpecific[d].includes(exceptionKey)) {
          mergedCosmetic.domainSpecific[d].push(exceptionKey);
        }
      }
    }

    // 7. Re-index into IndexedDB + rebuild Bloom Filter
    await db.clear();
    const totalDomains = Object.keys(mergedCosmetic.domainSpecific).length +
      dedupedScriptlets.reduce((n, r) => n + (r.domains?.length || 0), 0);
    const newBloom = BloomFilter.forCapacity(totalDomains);

    await db.putBulkCosmeticRules(mergedCosmetic.domainSpecific);
    for (const hostname of Object.keys(mergedCosmetic.domainSpecific)) newBloom.add(hostname);

    await db.putBulkScriptletRules(dedupedScriptlets);
    for (const r of dedupedScriptlets) {
      if (r.domains) for (const d of r.domains) newBloom.add(d);
    }

    bloom = newBloom;
    await setStorage(StorageKeys.BLOOM_FILTER, bloom.serialize());

    // 8. Always update generic CSS — store selector array, compile string in RAM
    await setStorage(StorageKeys.GENERIC_CSS, mergedCosmetic.generic);
    cachedGenericCss = mergedCosmetic.generic.length > 0
      ? mergedCosmetic.generic.join(',') + ' { display: none !important; visibility: hidden !important; }'
      : null;

    domainRulesCache.clear();

    await setStorage(StorageKeys.LAST_UPDATE_CHECK, Date.now());
    console.log(`[AdBlock] Filter update complete — ${mergedCosmetic.generic.length} generic, ${Object.keys(mergedCosmetic.domainSpecific).length} domains, ${dedupedScriptlets.length} scriptlets`);
  } finally {
    _filterUpdateInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Tab stats tracking — count blocked requests per tab
// ---------------------------------------------------------------------------
const tabStats = new Map(); // tabId → { blocked: number, url: string }

// Load existing tab stats when the service worker wakes up
(async () => {
  const stored = await getStorage(StorageKeys.TAB_STATS);
  if (stored) {
    for (const [key, val] of Object.entries(stored)) {
      const numKey = Number(key);
      if (!tabStats.has(numKey)) {
        tabStats.set(numKey, val);
      } else {
        const current = tabStats.get(numKey);
        current.blocked = (current.blocked || 0) + (val.blocked || 0);
        current.trackers = (current.trackers || 0) + (val.trackers || 0);
      }
    }
  }
})();

let _persistTimeout = null;
function schedulePersistTabStats() {
  if (_persistTimeout) clearTimeout(_persistTimeout);
  _persistTimeout = setTimeout(() => {
    persistTabStats();
    _persistTimeout = null;
  }, 1500);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
  persistTabStats();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabStats.set(tabId, { blocked: 0, trackers: 0, url: changeInfo.url });
    updateBadge(tabId);
    schedulePersistTabStats();
  }
});

chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
  const { request, rule } = info;

  const ALLOW_RULESETS = ['ubo-unbreak', 'anti-adblock', 'system-unbreak', '_allowlist'];
  const isAllow = ALLOW_RULESETS.some(id => rule.rulesetId.includes(id));

  // Track stats
  if (rule.rulesetId !== '_dynamic' && rule.rulesetId !== '_session') {
    if (!tabStats.has(request.tabId)) {
      tabStats.set(request.tabId, { blocked: 0, trackers: 0, url: request.url });
    }

    const stats = tabStats.get(request.tabId);

    // Only count as 'blocked' if it's an actual block rule
    if (!isAllow) {
      stats.blocked++;

      // Classify as tracker if from privacy/malware lists
      const isTracker = rule.rulesetId === 'easyprivacy' || rule.rulesetId === 'malware';
      if (isTracker) {
        stats.trackers++;
      }

      updateBadge(request.tabId);
      schedulePersistTabStats();
    }
  }
  // Broadcast to Logger
  broadcastLoggerEvent({
    type: 'network',
    action: isAllow ? 'allow' : 'block',
    isTracker: !isAllow && (rule.rulesetId === 'easyprivacy' || rule.rulesetId === 'malware'),
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
  }).catch(() => { }); // Ignore if no one is listening
}

function updateBadge(tabId) {
  if (!tabId || tabId < 0) return; // ignore non-tab requests (tabId = -1)
  const stats = tabStats.get(tabId);
  const count = stats?.blocked || 0;
  const text = count > 999 ? '999+' : count > 0 ? String(count) : '';

  chrome.action.setBadgeText({ text, tabId }).catch(() => { });
  chrome.action.setBadgeBackgroundColor({ color: '#E74C3C', tabId }).catch(() => { });
}

async function persistTabStats() {
  const obj = {};
  for (const [tabId, stats] of tabStats) {
    obj[tabId] = stats;
  }
  await setStorage(StorageKeys.TAB_STATS, obj).catch(() => { });
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

  // Always clear the existing IDs in this range, then add new ones if any.
  // This ensures that an empty filtersText results in zero active user rules.
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: userRuleIds,
    addRules: newRules,
  });

  const cosmeticRules = parseUserCosmeticRules(filtersText);
  await setStorage(StorageKeys.USER_COSMETIC_RULES, cosmeticRules);

  if (newRules.length > 0) {
    console.log(`[AdBlock] Applied ${newRules.length} user network rules`);
  } else if (userRuleIds.length > 0) {
    console.log('[AdBlock] Cleared all user network rules');
  }
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
    priority: 500, // Systematic Priority for User Allowlist
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: ['main_frame', 'sub_frame'],
    },
    action: { type: 'allowAllRequests' },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: allowlistRuleIds,
    addRules: newRules,
  });
}

/** Apply all enabled static rulesets, respecting Chrome's global rule count limits. */
async function applyRulesets() {
  const enabledMap = (await getStorage(StorageKeys.ENABLED_RULESETS)) || {};

  const allKnownIds = [
    'system-unbreak', 'ubo-unbreak', 'ubo-filters', 'easylist',
    'easyprivacy', 'malware', 'annoyances', 'anti-adblock'
  ];
  const enableRulesetIds = allKnownIds.filter(id => enabledMap[id] === true || id === 'system-unbreak');
  const disableRulesetIds = allKnownIds.filter(id => !enableRulesetIds.includes(id));

  try {
    // 1. Try batch operation first (most efficient)
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds,
      disableRulesetIds,
    });
  } catch (err) {
    if (err.message?.includes('exceeds the rule count limit')) {
      console.warn('[AdBlock] Batch enable failed due to rule limit. Falling back to sequential priority loading.');

      // 2. Sequential fallback: Disable unwanted ones first
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds });

      for (const id of enableRulesetIds) {
        try {
          await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] });
        } catch (seqErr) {
          if (seqErr.message?.includes('exceeds the rule count limit')) {
            console.warn(`[AdBlock] Limit reached at ruleset: ${id}`);
            break;
          }
        }
      }
    } else {
      console.error('[AdBlock] Failed to apply rulesets:', err);
    }
  }
}

/** Enable or disable a static ruleset by ID. */async function setRulesetEnabled(rulesetId, enabled) {
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
  // For content-script critical-path messages, ensure caches are ready first.
  // Non-critical messages (stats, settings UI) don't need to wait.
  const needsCache = message.type === 'GET_COSMETIC_RULES' ||
    message.type === 'GET_SCRIPTLET_RULES' ||
    message.type === 'IS_SITE_ALLOWED' ||
    message.type === 'GET_INIT_DATA';

  const run = needsCache && !_criticalReady
    ? _criticalPromise.then(() => handleMessage(message, sender))
    : handleMessage(message, sender);

  run.then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(message, sender) {
  const { type, payload } = message;

  switch (type) {
    case 'GET_INIT_DATA': {
      const { hostname } = payload;
      const [isAllowed, settings, cosmeticRules, scriptletRules] = await Promise.all([
        isHostnameAllowedCached(hostname),
        (await getStorage(StorageKeys.SETTINGS)) || {},
        getCosmeticRulesForPage(hostname),
        getScriptletRulesForPage(hostname),
      ]);

      const hasScriptlets = scriptletRules.length > 0;

      if (!isAllowed && sender.tab?.id) {
        const scriptletsToRun = [...scriptletRules];
        if (settings.fingerprintProtection !== false) {
          scriptletsToRun.push({ name: 'fingerprint-noise', args: [] });
          scriptletsToRun.push({ name: 'battery-spoof', args: [] });
        }
        if (scriptletsToRun.length > 0) {
          await injectScriptlets(sender.tab.id, sender.frameId || 0, scriptletsToRun);
        }
      }

      return { isAllowed, settings, cosmeticRules, hasScriptlets };
    }
    case 'GET_TAB_STATS': {
      const tabId = payload?.tabId ?? sender.tab?.id;
      return tabStats.get(tabId) || { blocked: 0 };
    }
    case 'GET_SETTINGS':
      return (await getStorage(StorageKeys.SETTINGS)) || {};
    case 'SET_SETTINGS': {
      await setStorage(StorageKeys.SETTINGS, payload);
      cachedSettings = payload;
      await applyPrivacySettings();
      return { ok: true };
    }
    case 'GET_ALLOWLIST':
      return Array.from(cachedAllowlist);
    case 'ALLOW_SITE':
      await allowSite(payload.domain);
      cachedAllowlist.add(payload.domain);
      domainRulesCache.delete(payload.domain);
      return { ok: true };
    case 'DISALLOW_SITE':
      await disallowSite(payload.domain);
      cachedAllowlist.delete(payload.domain);
      domainRulesCache.delete(payload.domain);
      return { ok: true };
    case 'IS_SITE_ALLOWED': {
      return { allowed: isHostnameAllowedCached(payload.domain) };
    }
    case 'GET_USER_FILTERS':
      return { filters: (await getStorage(StorageKeys.USER_FILTERS)) || '' };
    case 'SET_USER_FILTERS': {
      await setStorage(StorageKeys.USER_FILTERS, payload.filters);
      await applyUserFilters(payload.filters);
      domainRulesCache.clear();
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

    case 'FORCE_CLEAN_ALL_DYNAMIC_RULES': {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const ids = existing.map(r => r.id);
      if (ids.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
      }
      domainRulesCache.clear();
      _inFlightRules.clear();
      return { cleared: ids.length, rules: existing };
    }

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
        schedulePersistTabStats();
      }

      // Broadcast to Logger
      broadcastLoggerEvent({
        type: 'cosmetic',
        action: payload.action || 'hide',
        hostname: payload.hostname || sender.tab.url,
        selector: payload.selector,
        count: payload.count || 1,
        timestamp: Date.now(),
      });

      return { ok: true };
    }
    default:
      return { error: `Unknown message type: ${type}` };
  }
}

// ---------------------------------------------------------------------------
// Cosmetic + scriptlet rule lookup
// ---------------------------------------------------------------------------

// In-flight rule requests to deduplicate redundant DB hits
const _inFlightRules = new Map();

async function getCosmeticRulesForPage(hostname) {
  // Deduplicate: If we are already fetching rules for this domain, return the same promise.
  if (_inFlightRules.has(hostname)) return _inFlightRules.get(hostname);

  const promise = (async () => {
    const domainSpecific = [];
    const domainExceptions = new Set();

    const processSelector = (s) => {
      if (isProceduralSelector(s)) {
        return { selector: s, plan: parseProceduralPlan(s) };
      }
      return s;
    };

    // 1. Parallelize parent domain checks (Bloom + IndexedDB)
    const bloomHits = [];
    let curDomain = hostname;
    while (true) {
      if (bloom.has(curDomain)) {
        bloomHits.push(db.getCosmeticRules(curDomain));
      }
      const dotIdx = curDomain.indexOf('.');
      if (dotIdx === -1) break;
      curDomain = curDomain.slice(dotIdx + 1);
    }

    const allDomainRules = await Promise.all(bloomHits);
    for (const rules of allDomainRules) {
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.startsWith('__exception__')) {
          domainExceptions.add(rule.slice('__exception__'.length));
        } else {
          domainSpecific.push(processSelector(rule));
        }
      }
    }

    const userRules = (await getStorage(StorageKeys.USER_COSMETIC_RULES)) || {};
    const userGeneric = (userRules.generic || []).map(processSelector);
    const userExceptions = new Set([...(userRules.genericExceptions || []), ...domainExceptions]);
    const userDomainSelectors = [];

    // Also check user rules for parent domains (no DB hit here, so loop is fine)
    let userDom = hostname;
    while (true) {
      if (userRules.domainSpecific?.[userDom]) {
        userDomainSelectors.push(...userRules.domainSpecific[userDom].map(processSelector));
      }
      if (userRules.domainExceptions?.[userDom]) {
        for (const sel of userRules.domainExceptions[userDom]) userExceptions.add(sel);
      }
      const dotIdx = userDom.indexOf('.');
      if (dotIdx === -1) break;
      userDom = userDom.slice(dotIdx + 1);
    }

    return {
      generic: userGeneric,
      domainSpecific: [...domainSpecific, ...userDomainSelectors],
      exceptions: [...userExceptions],
    };
  })();

  _inFlightRules.set(hostname, promise);
  try {
    return await promise;
  } finally {
    _inFlightRules.delete(hostname);
  }
}

async function getScriptletRulesForPage(hostname) {
  let mightHaveRules = bloom.has(''); // check generic
  if (!mightHaveRules) {
    let d = hostname;
    while (true) {
      if (bloom.has(d)) {
        mightHaveRules = true;
        break;
      }
      const dotIdx = d.indexOf('.');
      if (dotIdx === -1) break;
      d = d.slice(dotIdx + 1);
    }
  }

  if (!mightHaveRules) return [];
  return await db.getScriptletRules(hostname);
}

/** Check if a hostname (or any parent domain) is in the memory-cached allowlist. */
function isHostnameAllowedCached(hostname) {
  if (!cachedAllowlist || cachedAllowlist.size === 0) return false;
  let d = hostname;
  while (d) {
    if (cachedAllowlist.has(d)) return true;
    const dotIdx = d.indexOf('.');
    if (dotIdx === -1) break;
    d = d.slice(dotIdx + 1);
  }
  return false;
}

/** 
 * Reusable core injection logic.
 * Ensures CSS is injected as early as possible.
 */
async function performEarlyInjection(tabId, urlStr) {
  if (!urlStr?.startsWith('http')) return;
  const url = new URL(urlStr);
  const hostname = url.hostname.replace(/^www\./, '');

  if (isHostnameAllowedCached(hostname)) return;

  // 1. Inject Generic CSS
  if (cachedGenericCss) {
    chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      css: cachedGenericCss,
      origin: 'USER',
    }).catch(() => { });
  }

  // 2. Inject Domain Rules
  let rules = domainRulesCache.get(hostname);
  if (!rules) {
    rules = await getCosmeticRulesForPage(hostname);
    setCachedDomainRules(hostname, rules);
  }

  const cssSelectors = [];
  const allRules = [...(rules.generic || []), ...(rules.domainSpecific || [])];
  const exceptions = new Set(rules.exceptions || []);

  for (const rule of allRules) {
    if (!rule) continue;
    if (typeof rule === 'object' && rule.plan) continue; // skip procedural
    if (exceptions.has(rule)) continue;
    if (!isProceduralSelector(rule)) cssSelectors.push(rule);
  }

  if (cssSelectors.length > 0) {
    const css = cssSelectors.join(',') + ' { display: none !important; visibility: hidden !important; opacity: 0 !important; height: 0 !important; overflow: hidden !important; }';
    chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      css,
      origin: 'USER',
    }).catch(() => { });
  }

  // 3. Inject Exceptions
  const cssExceptions = rules.exceptions.filter(s => !isProceduralSelector(s));
  if (cssExceptions.length > 0) {
    const css = cssExceptions.join(',') + ' { display: revert !important; visibility: revert !important; opacity: revert !important; height: revert !important; overflow: revert !important; }';
    chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      css,
      origin: 'USER',
    }).catch(() => { });
  }
}

/**
 * Stage 1: onBeforeNavigate (Warm up the cache)
 */
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (!details.url.startsWith('http')) return;

  const url = new URL(details.url);
  const hostname = url.hostname.replace(/^www\./, '');

  if (!domainRulesCache.has(hostname)) {
    const rules = await getCosmeticRulesForPage(hostname);
    setCachedDomainRules(hostname, rules);
  }
});

/**
 * Stage 2: onCommitted (Reliability fallback)
 */
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  performEarlyInjection(details.tabId, details.url);
});

