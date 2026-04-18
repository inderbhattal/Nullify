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
import { normalizeAllowlist, normalizeHostname } from '../shared/hostname.js';
import init, {
  BloomFilter as WasmBloom,
  KeywordMatcher,
  AllowlistMatcher,
  UrlSanitizer,
  build_css_from_selectors,
  build_page_bundle_from_json,
  build_allowlist_rules_json,
  compile_user_filters_to_json,
  generate_gaussian_noise,
  merge_filter_sources_to_json,
  plan_selector_rules_json,
  reduce_cosmetic_rules_json,
  serialize_rules_to_binary_from_json,
  sanitize_url_with_csv,
  resolve_entity,
  is_semantic_ad,
  sanitize_and_compact_selectors,
  anonymize_stats_json
} from '../shared/wasm/nullify_core.js';

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
let bloom = null;
let wasmReady = false;
let trackerMatcher = null;
// Stateful WASM objects — built once, never rebuilt unless data changes.
let allowlistMatcher = null;  // AllowlistMatcher: O(1) allowlist checks
let urlSanitizer = null;      // UrlSanitizer: AC built once for tracking-param stripping
const trackerKeywordsCsv = [
  'telemetry', 'analytics', 'tracking', 'pixel', 'beacon', 'metrics',
  'collect', 'segment', 'mixpanel', 'hotjar', 'amplitude', 'doubleclick',
  'googletagmanager', 'facebook.com/tr', 'fbevents', 'clickid', 'utm_'
].join(',');

// ---- Memory Cache (High Performance) ----
let cachedSettings = null;
let cachedAllowlist = new Set();
let cachedGenericCss = null;
let domainRulesCache = new Map(); // hostname -> packaged page bundle (LRU, max 100 entries)
const DOMAIN_RULES_CACHE_MAX = 100;

function setCachedDomainRules(hostname, bundle) {
  // Evict oldest entry when at capacity (Map preserves insertion order)
  if (domainRulesCache.size >= DOMAIN_RULES_CACHE_MAX) {
    domainRulesCache.delete(domainRulesCache.keys().next().value);
  }
  domainRulesCache.set(hostname, bundle);
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

function classifyAndPlanSelectors(selectors) {
  const cleanSelectors = selectors
    .filter((selector) => typeof selector === 'string')
    .map((selector) => selector.trim())
    .filter(Boolean);

  if (wasmReady) {
    try {
      return JSON.parse(plan_selector_rules_json(JSON.stringify(cleanSelectors)));
    } catch (err) {
      console.error('[Nullify] WASM selector planning failed:', err);
    }
  }

  const cssSelectors = [];
  const proceduralRules = [];
  for (const selector of cleanSelectors) {
    if (isProceduralSelector(selector)) {
      proceduralRules.push({ selector, plan: parseProceduralPlan(selector) });
    } else {
      cssSelectors.push(selector);
    }
  }

  return { cssSelectors, proceduralRules };
}

function reduceCosmeticRules(cosmetic) {
  if (wasmReady) {
    try {
      return JSON.parse(reduce_cosmetic_rules_json(
        JSON.stringify(cosmetic.generic || []),
        JSON.stringify(cosmetic.domainSpecific || {}),
        JSON.stringify(cosmetic.exceptions || {})
      ));
    } catch (err) {
      console.error('[Nullify] WASM cosmetic reduction failed:', err);
    }
  }

  const generic = [...new Set((cosmetic.generic || []).filter(Boolean))];
  const genericSet = new Set(generic);
  const domainSpecific = {};

  for (const [domain, selectors] of Object.entries(cosmetic.domainSpecific || {})) {
    const deduped = [...new Set((selectors || []).filter((selector) => selector && !genericSet.has(selector)))];
    if (deduped.length > 0) {
      domainSpecific[domain] = deduped;
    }
  }

  for (const [domain, selectors] of Object.entries(cosmetic.exceptions || {})) {
    if (!domainSpecific[domain]) domainSpecific[domain] = [];
    const seen = new Set(domainSpecific[domain]);
    for (const selector of selectors || []) {
      const prefixed = '__exception__' + selector;
      if (!seen.has(prefixed)) {
        seen.add(prefixed);
        domainSpecific[domain].push(prefixed);
      }
    }
  }

  Object.keys(domainSpecific).forEach((domain) => {
    if (domainSpecific[domain].length === 0) delete domainSpecific[domain];
  });

  return { generic, domainSpecific };
}

function buildPageBundle(rawRules) {
  if (wasmReady) {
    try {
      return build_page_bundle_from_json(
        JSON.stringify(rawRules.generic || []),
        JSON.stringify(rawRules.domainSpecific || []),
        JSON.stringify(rawRules.exceptions || []),
        150
      );
    } catch (err) {
      console.error('[Nullify] WASM page bundle build failed:', err);
    }
  }

  const exceptions = [...new Set((rawRules.exceptions || []).filter((selector) => typeof selector === 'string' && selector.trim()))];
  const exceptionSet = new Set(exceptions);
  const activeSelectors = [
    ...(rawRules.generic || []),
    ...(rawRules.domainSpecific || []),
  ].filter((selector) => typeof selector === 'string' && selector.trim() && !exceptionSet.has(selector));

  const planned = classifyAndPlanSelectors(activeSelectors);
  const proceduralRules = planned.proceduralRules || [];
  const cssSelectors = planned.cssSelectors || [];

  const rules = {
    generic: [],
    domainSpecific: proceduralRules,
    exceptions,
  };

  const cssText = cssSelectors.length > 0
    ? (wasmReady
        ? build_css_from_selectors(cssSelectors.join('\n'), '', 150)
        : cssSelectors.join(',') + ' { display: none !important; visibility: hidden !important; }')
    : '';

  const exceptionCss = exceptions.length > 0
    ? exceptions.join(',') + ' { display: revert !important; visibility: revert !important; }'
    : '';

  let cosmeticRulesBinary = null;
  if (wasmReady) {
    try {
      cosmeticRulesBinary = serialize_rules_to_binary_from_json(
        JSON.stringify([]),
        JSON.stringify(proceduralRules.map((rule) => JSON.stringify(rule))),
        JSON.stringify(exceptions)
      );
    } catch (err) {
      console.error('[Nullify] WASM page bundle serialization failed:', err);
    }
  }

  return {
    rules,
    cssText,
    exceptionCss,
    cosmeticRulesBinary,
  };
}

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
    await ensureBackgroundSetup();

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
let _backgroundSetupPromise = null;

function ensureBackgroundSetup() {
  if (_backgroundSetupPromise) return _backgroundSetupPromise;

  _backgroundSetupPromise = (async () => {
    const data = await getStorageBulk([
      StorageKeys.USER_FILTERS,
      StorageKeys.USER_FILTERS_APPLIED,
    ]);
    const userFilters = data[StorageKeys.USER_FILTERS] || '';
    const appliedUserFilters = data[StorageKeys.USER_FILTERS_APPLIED] || '';

    await Promise.all([
      userFilters === appliedUserFilters
        ? Promise.resolve({ network: 0, cosmetic: 0 })
        : applyUserFilters(userFilters),
      applyPrivacySettings(),
      applyRulesets(),
      scheduleFilterUpdateAlarm(),
    ]);
  })().catch((err) => {
    _backgroundSetupPromise = null;
    throw err;
  });

  return _backgroundSetupPromise;
}

function startInitialization() {
  if (_criticalPromise) return _criticalPromise;

  _criticalPromise = (async () => {
    // Stage 0: Initialize WASM
    try {
      const wasmUrl = chrome.runtime.getURL('dist/nullify_core_bg.wasm');
      await init({ module_or_path: wasmUrl });
      wasmReady = true;

      // Initialize tracker detector using string-based interface
      trackerMatcher = new KeywordMatcher(trackerKeywordsCsv);
      // Pre-build stateful objects — these never need rebuilding unless data changes.
      urlSanitizer = new UrlSanitizer(trackerKeywordsCsv);
      rebuildAllowlistMatcher();

      console.log('[Nullify] WASM Core initialized');
    } catch (err) {
      console.error('[Nullify] WASM initialization failed:', err);
    }

    // Stage 1: Critical data for responding to content scripts
    await Promise.all([
      loadBloomFilter(),
      refreshMemoryCache(),
    ]);
    _criticalReady = true;

    // Stage 2: Background tasks (non-blocking for messages)
    ensureBackgroundSetup().catch(err => console.error('[Nullify] Background startup failed:', err));

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

/** Rebuild the AllowlistMatcher after any allowlist mutation. */
function rebuildAllowlistMatcher() {
  if (!wasmReady) return;
  if (allowlistMatcher) { allowlistMatcher.free(); allowlistMatcher = null; }
  if (cachedAllowlist.size > 0) {
    allowlistMatcher = new AllowlistMatcher(Array.from(cachedAllowlist).join(','));
  }
}

async function refreshMemoryCache() {
  const data = await getStorageBulk([
    StorageKeys.SETTINGS,
    StorageKeys.ALLOWLIST,
    StorageKeys.GENERIC_CSS
  ]);

  cachedSettings = data[StorageKeys.SETTINGS];
  const rawAllowlist = data[StorageKeys.ALLOWLIST] || [];
  const normalizedAllowlist = normalizeAllowlist(rawAllowlist);
  cachedAllowlist = new Set(normalizedAllowlist);
  rebuildAllowlistMatcher(); // Rebuild with fresh allowlist data

  if (
    rawAllowlist.length !== normalizedAllowlist.length ||
    rawAllowlist.some((domain, index) => domain !== normalizedAllowlist[index])
  ) {
    await setStorage(StorageKeys.ALLOWLIST, normalizedAllowlist);
    await rebuildAllowlistRules(normalizedAllowlist);
  }

  const genericSelectors = data[StorageKeys.GENERIC_CSS];
  if (Array.isArray(genericSelectors) && genericSelectors.length > 0) {
    // Use WASM builder when ready for chunked, deduped CSS
    cachedGenericCss = wasmReady
      ? build_css_from_selectors(genericSelectors.join('\n'), '', 100)
      : genericSelectors.join(',') + ' { display: none !important; visibility: hidden !important; }';
  } else if (typeof genericSelectors === 'string' && genericSelectors.length > 0) {
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
      if (typeof data === 'string') {
        // Base64 format check removed - logic now handles JSON strings via WASM
        if (wasmReady) {
          bloom = WasmBloom.deserialize_from_json(data);
        } else {
          // Re-ingest if WASM not ready but we have a string
          await ingestRules();
        }
        return;
      }
      
      if (wasmReady) {
        // Data is a raw object, but WASM needs a JSON string
        bloom = WasmBloom.deserialize_from_json(JSON.stringify(data));
      } else {
        bloom = BloomFilter.deserialize(data);
      }
    } catch (err) {
      console.error('[AdBlock] Failed to deserialize Bloom Filter:', err);
      bloom = wasmReady ? new WasmBloom(256 * 1024, 4) : new BloomFilter(256 * 1024, 4);
    }
  } else {
    bloom = wasmReady ? new WasmBloom(256 * 1024, 4) : new BloomFilter(256 * 1024, 4);
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
    
    // Wipe and rebuild index
    await db.clear();

    // Size the Bloom Filter for actual domain count (10 bits/item → ~1% FP rate)
    const domainCount = Object.keys(cosData.domainSpecific || {}).length +
      (scriptData || []).reduce((n, r) => n + (r.domains?.length || 0), 0) + 1; // +1 for generic ''
    
    const newBloom = wasmReady ? new WasmBloom(domainCount * 10, 4) : BloomFilter.forCapacity(domainCount);

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

    // Always add empty string to mark presence of generic rules
    newBloom.add('');

    // Save Bloom Filter
    bloom = newBloom;
    if (wasmReady) {
      await setStorage(StorageKeys.BLOOM_FILTER, bloom.serialize_to_json());
    } else {
      await setStorage(StorageKeys.BLOOM_FILTER, bloom.serialize());
    }

    if (cosData.generic && cosData.generic.length > 0) {
      await setStorage(StorageKeys.GENERIC_CSS, cosData.generic);
      cachedGenericCss = wasmReady 
        ? sanitize_and_compact_selectors(cosData.generic.join('\n'), 100)
        : cosData.generic.join(',') + ' { display: none !important; visibility: hidden !important; }';
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
  await setStorage(StorageKeys.USER_FILTERS_APPLIED, '');
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
    'ubo-cookie-annoyances': true,
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

  // Security domains that MUST see original headers to pass human verification
  const excludedDomains = [
    'px-cloud.net', 'perimeterx.net', 'cloudflare.com', 'hcaptcha.com', 
    'google.com', 'gstatic.com', 'recaptcha.net', 'akamai.com'
  ];

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
        resourceTypes: ['script', 'xmlhttprequest', 'other'],
        excludedRequestDomains: excludedDomains
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
        resourceTypes: ['script', 'xmlhttprequest', 'other'],
        excludedRequestDomains: excludedDomains
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

    const bundledCosmetic = { generic: [], domainSpecific: {} };
    let bundledScriptlets = [];
    const remoteTexts = [];

    // 1. Load bundled cosmetic rules first (highest priority)
    try {
      const bundledUrl = chrome.runtime.getURL('rules/cosmetic-rules.json');
      const bundled = await (await fetch(bundledUrl)).json();
      bundledCosmetic.generic.push(...(bundled.generic || []));
      for (const [domain, selectors] of Object.entries(bundled.domainSpecific || {})) {
        bundledCosmetic.domainSpecific[domain] = [...selectors];
      }
    } catch (err) {
      console.warn('[AdBlock] Could not load bundled cosmetic rules:', err.message);
    }

    // 2. Load bundled scriptlet rules
    try {
      const scriptUrl = chrome.runtime.getURL('rules/scriptlet-rules.json');
      bundledScriptlets = await (await fetch(scriptUrl)).json();
    } catch { /* non-fatal */ }

    // 3. Fetch and merge remote filter lists
    for (const list of REMOTE_FILTER_LISTS) {
      try {
        console.log(`[AdBlock] Fetching ${list.id}...`);
        const text = await fetchAndExpand(list.url);
        remoteTexts.push(text);
      } catch (err) {
        console.error(`[AdBlock] Failed to fetch ${list.id}:`, err.message);
      }
    }

    let mergedCosmetic;
    let dedupedScriptlets;

    if (wasmReady) {
      try {
        const reduced = JSON.parse(merge_filter_sources_to_json(
          JSON.stringify(bundledCosmetic.generic || []),
          JSON.stringify(bundledCosmetic.domainSpecific || {}),
          JSON.stringify(bundledScriptlets || []),
          JSON.stringify(remoteTexts)
        ));
        mergedCosmetic = {
          generic: reduced.generic || [],
          domainSpecific: reduced.domainSpecific || {},
        };
        dedupedScriptlets = reduced.scriptletRules || [];
      } catch (err) {
        console.error('[Nullify] WASM filter-source merge failed:', err);
      }
    }

    if (!mergedCosmetic || !dedupedScriptlets) {
      // Start with bundled rules so curated fixes (e.g. CNN :remove()) take priority.
      // Remote rules are merged in after, then deduplicated — bundled entries win
      // because Set preserves first-seen order.
      mergedCosmetic = {
        generic: [...(bundledCosmetic.generic || [])],
        domainSpecific: { ...(bundledCosmetic.domainSpecific || {}) },
        exceptions: {},
      };
      const mergedScriptlets = [...(bundledScriptlets || [])];

      for (const text of remoteTexts) {
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
      }

      const scriptletSeen = new Set();
      dedupedScriptlets = mergedScriptlets.filter(r => {
        const key = r.name + '|' + (r.domains || []).sort().join(',') + '|' + (r.args || []).join(',');
        if (scriptletSeen.has(key)) return false;
        scriptletSeen.add(key);
        return true;
      });

      const reducedCosmetic = reduceCosmeticRules(mergedCosmetic);
      mergedCosmetic.generic = reducedCosmetic.generic;
      mergedCosmetic.domainSpecific = reducedCosmetic.domainSpecific;
    }

    // 7. Re-index into IndexedDB + rebuild Bloom Filter
    await db.clear();
    const totalDomains = Object.keys(mergedCosmetic.domainSpecific).length +
      dedupedScriptlets.reduce((n, r) => n + (r.domains?.length || 0), 0) + 1;
    
    const newBloom = wasmReady ? new WasmBloom(totalDomains * 10, 4) : BloomFilter.forCapacity(totalDomains);

    await db.putBulkCosmeticRules(mergedCosmetic.domainSpecific);
    for (const hostname of Object.keys(mergedCosmetic.domainSpecific)) newBloom.add(hostname);

    await db.putBulkScriptletRules(dedupedScriptlets);
    for (const r of dedupedScriptlets) {
      if (r.domains) for (const d of r.domains) newBloom.add(d);
    }

    // Mark that we have generic rules
    newBloom.add('');

    bloom = newBloom;
    await setStorage(
      StorageKeys.BLOOM_FILTER,
      wasmReady ? bloom.serialize_to_json() : bloom.serialize()
    );

    // 8. Always update generic CSS — store selector array, compile string in RAM
    await setStorage(StorageKeys.GENERIC_CSS, mergedCosmetic.generic);
    cachedGenericCss = mergedCosmetic.generic.length > 0
      ? (wasmReady 
          ? sanitize_and_compact_selectors(mergedCosmetic.generic.join('\n'), 100) 
          : mergedCosmetic.generic.join(',') + ' { display: none !important; visibility: hidden !important; }')
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

  // 1. Determine action from ID ranges (new robust system)
  let actionLabel = 'block';
  let isAllow = false;

  const id = rule.ruleId;
  const ruleset = rule.rulesetId;

  // Check static rulesets (exceptions assigned 1,000,000+ range by compiler)
  if (id >= 1000000) {
    isAllow = true;
    actionLabel = 'allow';
  } 
  // Check known allow-only static rulesets
  else if (['ubo-unbreak', 'anti-adblock', 'system-unbreak', '_allowlist'].some(r => ruleset.includes(r))) {
    isAllow = true;
    actionLabel = 'allow';
  }
  // Handle Dynamic Rules categorization
  else if (ruleset === '_dynamic') {
    if (id >= 990000) {
      isAllow = true;
      actionLabel = 'allow';
    } else if (id >= 800000 && id < 900000) {
      actionLabel = 'modify';
    }
  }

  // Track stats
  if (ruleset !== '_dynamic' && ruleset !== '_session') {
    if (!tabStats.has(request.tabId)) {
      tabStats.set(request.tabId, { blocked: 0, trackers: 0, url: request.url });
    }

    const stats = tabStats.get(request.tabId);

    // Only count as 'blocked' if it's an actual block rule
    if (actionLabel === 'block') {
      stats.blocked++;

      // Classify as tracker if from privacy/malware lists OR matches tracker keywords
      const isTracker = (rule.rulesetId === 'easyprivacy' || rule.rulesetId === 'malware') ||
                        (trackerMatcher?.matches(request.url));
      if (isTracker) {
        stats.trackers++;
      }

      updateBadge(request.tabId);
      schedulePersistTabStats();
    }
  }
  // Broadcast to Logger
  let entity = '';
  try {
    const hostname = normalizeHostname(new URL(request.url).hostname);
    entity = wasmReady ? resolve_entity(hostname) : '';
  } catch {}

  broadcastLoggerEvent({
    type: 'network',
    action: actionLabel,
    isTracker: actionLabel === 'block' && (rule.rulesetId === 'easyprivacy' || rule.rulesetId === 'malware'),
    url: request.url,
    method: request.method,
    resourceType: request.type,
    rulesetId: rule.rulesetId,
    ruleId: rule.ruleId,
    entity,
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
  let newRules = [];
  let cosmeticRules = { generic: [], domainSpecific: {}, exceptions: [] };
  let userScriptlets = [];

  if (wasmReady) {
    try {
      const compiled = JSON.parse(compile_user_filters_to_json(filtersText || '', DNR_USER_RULES_START));
      newRules = compiled.dnrRules || [];
      cosmeticRules = compiled.cosmeticRules || cosmeticRules;
      userScriptlets = compiled.scriptletRules || [];
    } catch (err) {
      console.error('[Nullify] WASM user filter compilation failed:', err);
    }
  }

  // Fallback to JS if WASM failed or is not ready
  if (newRules.length === 0 && lines.length > 0) {
    let id = DNR_USER_RULES_START;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('!')) continue;
      const rule = parseSimpleNetworkRule(trimmed, id++);
      if (rule) newRules.push(rule);
    }
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const userRuleIds = existing
    .filter((r) => r.id >= DNR_USER_RULES_START && r.id < DNR_ALLOWLIST_START)
    .map((r) => r.id);

  // Always clear the existing IDs in this range, then add new ones if any.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: userRuleIds,
      addRules: newRules,
    });
  } catch (err) {
    console.error('[Nullify] Failed to update dynamic DNR rules:', err);
  }

  if (!wasmReady) {
    cosmeticRules = parseUserCosmeticRules(filtersText);
  } else if (
    (!cosmeticRules.generic?.length && !Object.keys(cosmeticRules.domainSpecific || {}).length &&
    !cosmeticRules.genericExceptions?.length && !Object.keys(cosmeticRules.domainExceptions || {}).length &&
    !userScriptlets.length && lines.length > 0)
  ) {
    cosmeticRules = parseUserCosmeticRules(filtersText);
  }
    
  await setStorage(StorageKeys.USER_COSMETIC_RULES, cosmeticRules);
  await setStorage(StorageKeys.USER_FILTERS_APPLIED, filtersText || '');
  await setStorage('userScriptletRules', userScriptlets);

  // CRITICAL: Clear memory caches so the next page load picks up the new rules immediately
  domainRulesCache.clear();
  _inFlightRules.clear();

  const totalDomainSpecificRules = Object.values(cosmeticRules.domainSpecific || {})
    .reduce((sum, rules) => sum + (rules?.length || 0), 0);

  const counts = {
    network: newRules.length,
    cosmetic: (cosmeticRules.generic?.length || 0) + totalDomainSpecificRules
  };

  console.log(`[AdBlock] Applied user filters: ${counts.network} network, ${counts.cosmetic} cosmetic`);
  return counts;
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
  const normalizedDomain = normalizeHostname(domain);
  if (!normalizedDomain) return;

  const allowlist = normalizeAllowlist(await getAllowlist());
  if (!allowlist.includes(normalizedDomain)) {
    allowlist.push(normalizedDomain);
    await setStorage(StorageKeys.ALLOWLIST, allowlist);
  }
  await rebuildAllowlistRules(allowlist);
}

/** Remove a site from the allowlist. */
async function disallowSite(domain) {
  const normalizedDomain = normalizeHostname(domain);
  if (!normalizedDomain) return;

  let allowlist = normalizeAllowlist(await getAllowlist());
  allowlist = allowlist.filter((d) => d !== normalizedDomain);
  await setStorage(StorageKeys.ALLOWLIST, allowlist);
  await rebuildAllowlistRules(allowlist);
}

/** Rebuild DNR allow-all-requests rules from allowlist. */
async function rebuildAllowlistRules(allowlist) {
  const normalizedAllowlist = normalizeAllowlist(allowlist);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const allowlistRuleIds = existing
    .filter((r) => r.id >= DNR_ALLOWLIST_START)
    .map((r) => r.id);

  let newRules;
  if (wasmReady) {
    try {
      newRules = JSON.parse(build_allowlist_rules_json(
        JSON.stringify(normalizedAllowlist),
        DNR_ALLOWLIST_START
      ));
    } catch (err) {
      console.error('[Nullify] WASM allowlist rule build failed:', err);
    }
  }

  if (!newRules) {
    newRules = normalizedAllowlist.map((domain, i) => ({
      id: DNR_ALLOWLIST_START + i,
      priority: 500, // Systematic Priority for User Allowlist
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: ['main_frame', 'sub_frame'],
      },
      action: { type: 'allowAllRequests' },
    }));
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: allowlistRuleIds,
    addRules: newRules,
  });
}

// ---------------------------------------------------------------------------
// Ruleset Groups (for split filter lists)
// ---------------------------------------------------------------------------
const RULESET_GROUPS = {
  'easylist': ['easylist', 'easylist_2', 'easylist_3', 'easylist_4'],
  'easyprivacy': ['easyprivacy', 'easyprivacy_2', 'easyprivacy_3'],
  'ubo-filters': ['ubo-filters', 'ubo-filters_2'],
};

// Estimated static DNR rule counts for packaged rulesets. These let us make
// budget-aware enable decisions before Chrome rejects an oversized shard.
const RULESET_RULE_COUNTS = {
  'system-unbreak': 18,
  'ubo-unbreak': 1479,
  'anti-adblock': 4172,
  'malware': 5236,
  'ubo-filters': 4579,
  'ubo-filters_2': 0,
  'ubo-cookie-annoyances': 46,
  'annoyances': 272,
  'easyprivacy': 25000,
  'easyprivacy_2': 25000,
  'easyprivacy_3': 3411,
  'easylist': 25000,
  'easylist_2': 25000,
  'easylist_3': 15183,
  'easylist_4': 0,
};

// Prefer high-signal smaller lists before secondary large shards so Chrome's
// static-rule cap does not crowd out anti-adblock, malware, and unbreak lists.
const RULESET_ENABLE_PRIORITY = [
  'system-unbreak',
  'ubo-unbreak',
  'anti-adblock',
  'malware',
  'ubo-filters',
  'ubo-cookie-annoyances',
  'annoyances',
  'easylist',
  'easylist_2',
  'easylist_3',
  'easyprivacy',
  'easyprivacy_3',
  'easyprivacy_2',
  'easylist_4',
  'ubo-filters_2',
];

/**
 * Get all underlying DNR ruleset IDs for a given list ID (UI-level ID).
 */
function getRulesetIdsForList(listId) {
  return RULESET_GROUPS[listId] || [listId];
}

function orderRulesetIdsByPriority(rulesetIds) {
  const priority = new Map(RULESET_ENABLE_PRIORITY.map((id, index) => [id, index]));
  return [...rulesetIds].sort((a, b) => {
    const aPriority = priority.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bPriority = priority.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.localeCompare(b);
  });
}

/** Apply all enabled static rulesets, respecting Chrome's global rule count limits. */
async function applyRulesets() {
  const enabledMap = (await getStorage(StorageKeys.ENABLED_RULESETS)) || {};

  const allKnownListIds = [
    'system-unbreak', 'ubo-unbreak', 'ubo-filters', 'easylist',
    'easyprivacy', 'malware', 'annoyances', 'anti-adblock', 'ubo-cookie-annoyances'
  ];
  
  const enableRulesetIds = [];
  const disableRulesetIds = [];

  for (const listId of allKnownListIds) {
    const rulesets = getRulesetIdsForList(listId);
    if (enabledMap[listId] === true || listId === 'system-unbreak') {
      enableRulesetIds.push(...rulesets);
    } else {
      disableRulesetIds.push(...rulesets);
    }
  }

  try {
    // 1. Try batch operation first (most efficient)
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds,
      disableRulesetIds,
    });
  } catch (err) {
    if (err.message?.includes('exceeds the rule count limit')) {
      console.warn('[AdBlock] Batch enable failed due to rule limit. Falling back to sequential priority loading.');

      // 2. Reset our static rulesets so budget checks start from a clean slate.
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        disableRulesetIds: [...new Set(enableRulesetIds.concat(disableRulesetIds))],
      });

      const prioritizedRulesetIds = orderRulesetIdsByPriority(enableRulesetIds);
      const skippedRulesetIds = [];
      let availableStaticRuleCount = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();

      for (const id of prioritizedRulesetIds) {
        const estimatedRuleCount = RULESET_RULE_COUNTS[id] ?? 0;
        if (estimatedRuleCount > 0 && estimatedRuleCount > availableStaticRuleCount) {
          skippedRulesetIds.push(id);
          continue;
        }

        try {
          await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] });
          availableStaticRuleCount = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();
        } catch (seqErr) {
          if (seqErr.message?.includes('exceeds the rule count limit')) {
            console.warn(`[AdBlock] Limit reached at ruleset: ${id}`);
            skippedRulesetIds.push(id);
            continue;
          }
        }
      }

      if (skippedRulesetIds.length > 0) {
        console.warn('[AdBlock] Skipped rulesets due to Chrome static rule limit:', skippedRulesetIds.join(', '));
      }
    } else {
      console.error('[AdBlock] Failed to apply rulesets:', err);
    }
  }

  try {
    const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
    console.log('[AdBlock] Enabled static rulesets:', enabledRulesets.join(', '));
  } catch (err) {
    console.warn('[AdBlock] Failed to read enabled static rulesets:', err);
  }
}

/** Enable or disable a static ruleset (or group) by ID. */
async function setRulesetEnabled(rulesetId, enabled) {
  const idsToChange = getRulesetIdsForList(rulesetId);

  if (enabled) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: idsToChange,
      disableRulesetIds: [],
    });
  } else {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: [],
      disableRulesetIds: idsToChange,
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
      const [isAllowed, settings, cosmeticBundle, scriptletRules] = await Promise.all([
        isHostnameAllowedCached(hostname),
        (await getStorage(StorageKeys.SETTINGS)) || {},
        getCosmeticBundleForPage(hostname),
        getScriptletRulesForPage(hostname),
      ]);

      const hasScriptlets = scriptletRules.length > 0;

      if (!isAllowed && sender.tab?.id) {
        const scriptletsToRun = [...scriptletRules];

        // Targeted YouTube Anti-Adblock (uBO-grade)
        if (hostname.includes('youtube.com')) {
          // 1. Force ad flags to undefined
          scriptletsToRun.push({ name: 'set-constant', args: ['yt.config_.ADS_DATA', 'undefined'] });
          scriptletsToRun.push({ name: 'set-constant', args: ['ytInitialPlayerResponse.adPlacements', 'undefined'] });
          scriptletsToRun.push({ name: 'set-constant', args: ['playerResponse.adPlacements', 'undefined'] });

          // 2. Keep JSON pruning as a lightweight backstop. The dedicated
          // youtube-shield content script already owns fetch/XHR interception,
          // and duplicating transport-level response rewriting here makes the
          // small inline player noticeably slower on youtube.com.
          scriptletsToRun.push({ 
            name: 'json-prune', 
            args: ['playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots adClientParams'] 
          });
          }

          if (settings.fingerprintProtection !== false) {
          scriptletsToRun.push({ name: 'fingerprint-noise', args: [] });
          scriptletsToRun.push({ name: 'battery-spoof', args: [] });
        }
        if (scriptletsToRun.length > 0) {
          await injectScriptlets(sender.tab.id, sender.frameId || 0, scriptletsToRun);
        }
      }

      let responseData = { isAllowed, settings, cosmeticRules: cosmeticBundle.rules, hasScriptlets };

      if (wasmReady && !isAllowed && cosmeticBundle.cosmeticRulesBinary) {
        try {
          responseData.cosmeticRulesBinary = cosmeticBundle.cosmeticRulesBinary;
          delete responseData.cosmeticRules;
          
          // Also provide a sanitized URL for privacy reporting/cleanup
          if (sender.tab?.url) {
            // urlSanitizer has the AC pre-built — no reconstruction per call.
            responseData.sanitizedUrl = urlSanitizer
              ? urlSanitizer.sanitize(sender.tab.url)
              : sanitize_url_with_csv(sender.tab.url, trackerKeywordsCsv);
          }
        } catch (err) {
          console.error('[Nullify] Rule serialization/sanitization failed:', err);
        }
      }

      return responseData;
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
    case 'ALLOW_SITE': {
      const domain = normalizeHostname(payload.domain);
      if (!domain) return { ok: false };
      await allowSite(domain);
      cachedAllowlist.add(domain);
      domainRulesCache.delete(domain);
      rebuildAllowlistMatcher();
      return { ok: true };
    }
    case 'DISALLOW_SITE': {
      const domain = normalizeHostname(payload.domain);
      if (!domain) return { ok: false };
      await disallowSite(domain);
      cachedAllowlist.delete(domain);
      domainRulesCache.delete(domain);
      rebuildAllowlistMatcher();
      return { ok: true };
    }
    case 'IS_SITE_ALLOWED': {
      return { allowed: isHostnameAllowedCached(normalizeHostname(payload.domain)) };
    }
    case 'GET_USER_FILTERS':
      return { filters: (await getStorage(StorageKeys.USER_FILTERS)) || '' };
    case 'SET_USER_FILTERS': {
      await setStorage(StorageKeys.USER_FILTERS, payload.filters);
      return await applyUserFilters(payload.filters);
    }
    case 'GET_COSMETIC_RULES': {
      const bundle = await getCosmeticBundleForPage(payload.hostname);
      return bundle.rules;
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

    case 'GET_NOISE': {
      const { mean = 0, stdDev = 1 } = payload || {};
      if (wasmReady) {
        // Provide entropy from JS side to avoid getrandom environment issues
        const seed = Date.now() * Math.random();
        return { noise: generate_gaussian_noise(mean, stdDev, seed) };
      }
      return { noise: (Math.random() - 0.5) * 2 * stdDev + mean }; // JS fallback
    }

    case 'GET_ANONYMIZED_STATS': {
      const stats = await getStorage(StorageKeys.TAB_STATS) || {};
      if (!wasmReady) return { stats };
      
      const json = JSON.stringify(stats);
      const noiseScale = payload?.noiseScale || 2.0;
      const seed = Date.now() * Math.random();
      
      const anonymizedJson = anonymize_stats_json(json, noiseScale, seed);
      return { stats: JSON.parse(anonymizedJson) };
    }

    case 'CHECK_SEMANTIC_AD': {
      const { text } = payload;
      if (!text) return { isAd: false };
      return { isAd: wasmReady ? is_semantic_ad(text) : false };
    }

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
  const bundle = await getCosmeticBundleForPage(hostname);
  return bundle.rules;
}

async function getCosmeticBundleForPage(hostname) {
  // Wait for critical caches if they aren't ready yet
  if (!_criticalReady && _criticalPromise) await _criticalPromise;
  if (!bloom) {
    return buildPageBundle({ generic: [], domainSpecific: [], exceptions: [] });
  }

  // Cache hit — onBeforeNavigate pre-warms this; GET_INIT_DATA reuses it.
  const cached = domainRulesCache.get(hostname);
  if (cached) return cached;

  // Deduplicate: If we are already fetching rules for this domain, return the same promise.
  if (_inFlightRules.has(hostname)) return _inFlightRules.get(hostname);

  const promise = (async () => {
    const domainSpecific = [];
    const domainExceptions = new Set();

    // 1. Parallelize parent domain checks (Bloom + IndexedDB)
    const bloomHits = [];
    let d = hostname;
    while (d) {
      if (bloom.has(d)) {
        bloomHits.push(db.getCosmeticRules(d));
      }
      const dotIdx = d.indexOf('.');
      if (dotIdx === -1) break;
      d = d.slice(dotIdx + 1);
    }

    const allDomainRules = await Promise.all(bloomHits);
    for (const rules of allDomainRules) {
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.startsWith('__exception__')) {
          domainExceptions.add(rule.slice('__exception__'.length));
        } else {
          domainSpecific.push(rule);
        }
      }
    }

    const userRules = (await getStorage(StorageKeys.USER_COSMETIC_RULES)) || {};
    const userGeneric = userRules.generic || [];
    const userExceptions = new Set([...(userRules.genericExceptions || []), ...domainExceptions]);
    const userDomainSelectors = [];

    // Also check user rules for parent domains (no DB hit here, so loop is fine)
    let userDom = hostname;
    while (true) {
      if (userRules.domainSpecific?.[userDom]) {
        userDomainSelectors.push(...userRules.domainSpecific[userDom]);
      }
      if (userRules.domainExceptions?.[userDom]) {
        for (const sel of userRules.domainExceptions[userDom]) userExceptions.add(sel);
      }
      const dotIdx = userDom.indexOf('.');
      if (dotIdx === -1) break;
      userDom = userDom.slice(dotIdx + 1);
    }

    return buildPageBundle({
      generic: userGeneric,
      domainSpecific: domainSpecific.concat(userDomainSelectors),
      exceptions: [...userExceptions],
    });
  })();

  _inFlightRules.set(hostname, promise);
  try {
    const bundle = await promise;
    setCachedDomainRules(hostname, bundle); // Populate cache so GET_INIT_DATA skips IndexedDB
    return bundle;
  } finally {
    _inFlightRules.delete(hostname);
  }
}

async function getScriptletRulesForPage(hostname) {
  const userScriptlets = (await getStorage('userScriptletRules')) || [];
  const activeUserScriptlets = userScriptlets.filter(r => {
    if (r.domains.length === 0) return true;
    return r.domains.some(d => hostname === d || hostname.endsWith('.' + d));
  });

  if (!bloom) return activeUserScriptlets;

  const mightHaveRules = wasmReady
    ? bloom.check_hostname(hostname)
    : (bloom.has('') || (() => {
        let d = hostname;
        while (d) {
          if (bloom.has(d)) return true;
          const dotIdx = d.indexOf('.');
          if (dotIdx === -1) break;
          d = d.slice(dotIdx + 1);
        }
        return false;
      })());

  if (!mightHaveRules) return activeUserScriptlets;
  const dbRules = await db.getScriptletRules(hostname);
  return [...dbRules, ...activeUserScriptlets];
}
/** Check if a hostname (or any parent domain) is in the memory-cached allowlist. */
function isHostnameAllowedCached(hostname) {
  hostname = normalizeHostname(hostname);
  if (!hostname) return false;
  if (!cachedAllowlist || cachedAllowlist.size === 0) return false;

  // AllowlistMatcher is built once and checks in O(1) — no Array/string alloc per call.
  if (allowlistMatcher) return allowlistMatcher.check(hostname);

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
  const hostname = normalizeHostname(url.hostname);

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
  let bundle = domainRulesCache.get(hostname);
  if (!bundle) {
    bundle = await getCosmeticBundleForPage(hostname);
    setCachedDomainRules(hostname, bundle);
  }

  if (bundle.cssText) {
    chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      css: bundle.cssText,
      origin: 'USER',
    }).catch(() => { });
  }

  // 3. Inject Exceptions
  if (bundle.exceptionCss) {
    chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      css: bundle.exceptionCss,
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
  const hostname = normalizeHostname(url.hostname);

  if (!domainRulesCache.has(hostname)) {
    const bundle = await getCosmeticBundleForPage(hostname);
    setCachedDomainRules(hostname, bundle);
  }
});

/**
 * Stage 2: onCommitted (Reliability fallback)
 */
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  performEarlyInjection(details.tabId, details.url);
});
