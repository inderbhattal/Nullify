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

import {getStorage, getStorageBulk, setStorage, StorageKeys} from '../shared/storage.js';
import {RulesDB} from '../shared/db.js';
import {BloomFilter} from '../shared/bloom.js';
import {fetchAndExpand, parseFilterList} from '../shared/filter-parser.js';
import { normalizeAllowlist, normalizeHostname } from '../shared/hostname.js';
import { CORE_FILTER_SOURCE } from '../shared/core-filter-source.js';
import { initWasmFromUrl } from '../shared/wasm-loader.js';
import init, {
  BloomFilter as WasmBloom,
  KeywordMatcher,
  AllowlistMatcher,
  UrlSanitizer,
  compile_active_filter_index,
  build_allowlist_rules,
  build_css_from_selectors,
  build_page_bundle,
  compile_user_filters,
  generate_gaussian_noise,
  parse_filter_source,
  plan_selector_rules_json,
  serialize_rules_to_binary_from_json,
  resolve_entity,
  is_semantic_ad,
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
  { id: 'ubo-cookie-annoyances', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt' },
];
const REMOTE_FILTER_LIST_IDS = REMOTE_FILTER_LISTS.map((list) => list.id);
const ALL_KNOWN_LIST_IDS = [
  'system-unbreak',
  ...REMOTE_FILTER_LIST_IDS,
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
let cachedGenericProceduralRules = [];
let domainRulesCache = new Map(); // hostname -> packaged page bundle (LRU, max 100 entries)
const _inFlightRules = new Map();
const DOMAIN_RULES_CACHE_MAX = 100;
const PAGE_BUNDLE_DB_MAX = 250;
const YOUTUBE_SHIELD_SCRIPT_ID = 'nullify-youtube-shield';
const YOUTUBE_SHIELD_TARGETS = [
  { hostname: 'youtube.com', pattern: '*://youtube.com/*' },
  { hostname: 'www.youtube.com', pattern: '*://www.youtube.com/*' },
  { hostname: 'm.youtube.com', pattern: '*://m.youtube.com/*' },
  { hostname: 'music.youtube.com', pattern: '*://music.youtube.com/*' },
];
let youtubeShieldSyncPromise = null;

function setCachedDomainRules(hostname, bundle) {
  // Evict oldest entry when at capacity (Map preserves insertion order)
  if (domainRulesCache.size >= DOMAIN_RULES_CACHE_MAX) {
    domainRulesCache.delete(domainRulesCache.keys().next().value);
  }
  domainRulesCache.set(hostname, bundle);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ALARM_FILTER_UPDATE = 'filter-list-update';
const ALARM_STATS_CLEANUP = 'stats-cleanup';
const FILTER_UPDATE_INTERVAL_MINUTES = 24 * 60; // 24 hours
const STATS_CLEANUP_INTERVAL_MINUTES = 30;
const RULE_DATA_SCHEMA_VERSION = 2;

let bundledRuleDataVersionPromise = null;

function getDefaultEnabledRulesets() {
  return {
    easylist: true,
    easyprivacy: true,
    annoyances: true,
    malware: true,
    'ubo-filters': true,
    'ubo-unbreak': true,
    'system-unbreak': true,
    'anti-adblock': true,
    'ubo-cookie-annoyances': true,
  };
}

function normalizeEnabledRulesetsMap(raw = {}) {
  const defaults = getDefaultEnabledRulesets();
  const normalized = { ...defaults };
  for (const listId of Object.keys(defaults)) {
    if (raw[listId] === false) normalized[listId] = false;
    else if (raw[listId] === true) normalized[listId] = true;
  }
  normalized['system-unbreak'] = true;
  return normalized;
}

function cloneFilterSource(source) {
  return {
    cosmetic: {
      generic: [...(source?.cosmetic?.generic || [])],
      domainSpecific: Object.fromEntries(
        Object.entries(source?.cosmetic?.domainSpecific || {}).map(([domain, selectors]) => [
          domain,
          [...(selectors || [])],
        ])
      ),
      exceptions: Object.fromEntries(
        Object.entries(source?.cosmetic?.exceptions || {}).map(([domain, selectors]) => [
          domain,
          [...(selectors || [])],
        ])
      ),
    },
    scriptlets: (source?.scriptlets || []).map((rule) => ({
      ...rule,
      domains: [...(rule.domains || [])],
      args: [...(rule.args || [])],
    })),
  };
}

function appendSelectorsByDomain(target, source = {}) {
  for (const [domain, selectors] of Object.entries(source)) {
    if (!target[domain]) target[domain] = [];
    target[domain].push(...(selectors || []));
  }
}

function dedupeScriptlets(rules) {
  const seen = new Set();
  return (rules || []).filter((rule) => {
    const key = `${rule.name}|${(rule.domains || []).join(',')}|${(rule.args || []).join('\u0001')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSourceBundleFromParsed(parsed) {
  const cosmetic = { generic: [], domainSpecific: {}, exceptions: {} };

  for (const rule of parsed?.cosmeticRules || []) {
    if (!rule?.selector) continue;
    if (rule.domains.length === 0) {
      if (!rule.exception) cosmetic.generic.push(rule.selector);
      continue;
    }

    for (const domain of rule.domains) {
      const target = rule.exception ? cosmetic.exceptions : cosmetic.domainSpecific;
      if (!target[domain]) target[domain] = [];
      target[domain].push(rule.selector);
    }
  }

  cosmetic.generic = [...new Set(cosmetic.generic)];
  for (const [domain, selectors] of Object.entries(cosmetic.domainSpecific)) {
    cosmetic.domainSpecific[domain] = [...new Set(selectors)];
  }
  for (const [domain, selectors] of Object.entries(cosmetic.exceptions)) {
    cosmetic.exceptions[domain] = [...new Set(selectors)];
  }

  return {
    cosmetic,
    scriptlets: dedupeScriptlets(parsed?.scriptletRules || []),
  };
}

function mergeFilterSources(listSources) {
  const mergedCosmetic = cloneFilterSource(CORE_FILTER_SOURCE).cosmetic;
  const mergedScriptlets = [...CORE_FILTER_SOURCE.scriptlets];

  for (const source of listSources) {
    mergedCosmetic.generic.push(...(source?.cosmetic?.generic || []));
    appendSelectorsByDomain(mergedCosmetic.domainSpecific, source?.cosmetic?.domainSpecific);
    appendSelectorsByDomain(mergedCosmetic.exceptions, source?.cosmetic?.exceptions);
    mergedScriptlets.push(...(source?.scriptlets || []));
  }

  const generic = [...new Set((mergedCosmetic.generic || []).filter(Boolean))];
  const genericSet = new Set(generic);
  const domainSpecific = {};

  for (const [domain, selectors] of Object.entries(mergedCosmetic.domainSpecific || {})) {
    const deduped = [...new Set((selectors || []).filter((selector) => selector && !genericSet.has(selector)))];
    if (deduped.length > 0) {
      domainSpecific[domain] = deduped;
    }
  }

  for (const [domain, selectors] of Object.entries(mergedCosmetic.exceptions || {})) {
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

  return {
    cosmetic: { generic, domainSpecific },
    scriptlets: dedupeScriptlets(mergedScriptlets),
  };
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `rv${RULE_DATA_SCHEMA_VERSION}-${(hash >>> 0).toString(16)}`;
}

async function computeBundledRuleDataVersion() {
  if (!bundledRuleDataVersionPromise) {
    bundledRuleDataVersionPromise = (async () => {
      const packaged = await loadPackagedFilterSources();
      return hashString(JSON.stringify({
        schema: RULE_DATA_SCHEMA_VERSION,
        core: CORE_FILTER_SOURCE,
        packaged: packaged || {},
      }));
    })().catch((err) => {
      bundledRuleDataVersionPromise = null;
      throw err;
    });
  }
  return bundledRuleDataVersionPromise;
}

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

function hasBalancedSelectorDelimiters(selector) {
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote = null;
  let escaped = false;

  for (const ch of selector) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch;
    } else if (ch === '[') {
      bracketDepth++;
    } else if (ch === ']') {
      bracketDepth--;
      if (bracketDepth < 0) return false;
    } else if (ch === '(') {
      parenDepth++;
    } else if (ch === ')') {
      parenDepth--;
      if (parenDepth < 0) return false;
    }
  }

  return !quote && bracketDepth === 0 && parenDepth === 0;
}

function hasInvalidUniversalUsage(selector) {
  let bracketDepth = 0;
  let quote = null;
  let escaped = false;

  for (let i = 0; i < selector.length; i++) {
    const ch = selector.charAt(i);

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      continue;
    }
    if (ch === ']') {
      bracketDepth--;
      continue;
    }
    if (ch !== '*' || bracketDepth > 0) continue;

    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      const pc = selector.charAt(j);
      if (!/\s/.test(pc)) {
        prev = pc;
        break;
      }
    }

    if (prev && /[A-Za-z0-9_\-)\]]/.test(prev)) {
      return true;
    }
  }

  return false;
}

function isSafeCssSelector(selector) {
  if (typeof selector !== 'string') return false;
  const trimmed = selector.trim();
  return !!trimmed &&
    !trimmed.includes('{') &&
    !trimmed.includes('}') &&
    !trimmed.includes(';') &&
    !isProceduralSelector(trimmed) &&
    hasBalancedSelectorDelimiters(trimmed) &&
    !hasInvalidUniversalUsage(trimmed);
}

function buildCssFromSelectorList(selectors, declarations) {
  const uniqueSelectors = [...new Set(
    (selectors || [])
      .filter((selector) => isSafeCssSelector(selector))
      .map((selector) => selector.trim())
  )];

  return uniqueSelectors
    .map((selector) => `${selector} { ${declarations} }`)
    .join('\n');
}

function buildPageBundle(rawRules) {
  if (wasmReady) {
    try {
      return build_page_bundle(
        rawRules.generic || [],
        rawRules.domainSpecific || [],
        rawRules.exceptions || [],
        150
      );
    } catch (err) {
      console.error('[Nullify] WASM page bundle build failed:', err);
    }
  }

  const exceptions = [...new Set(
    (rawRules.exceptions || [])
      .filter((selector) => isSafeCssSelector(selector))
      .map((selector) => selector.trim())
  )];
  const exceptionSet = new Set(exceptions);
  const activeSelectors = [
    ...(rawRules.generic || []),
    ...(rawRules.domainSpecific || []),
  ].filter((selector) => typeof selector === 'string' && selector.trim() && !exceptionSet.has(selector));

  const planned = classifyAndPlanSelectors(activeSelectors.filter((selector) => isProceduralSelector(selector) || isSafeCssSelector(selector)));
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
        : buildCssFromSelectorList(cssSelectors, 'display: none !important; visibility: hidden !important;'))
    : '';

  const exceptionCss = exceptions.length > 0
    ? buildCssFromSelectorList(exceptions, 'display: revert !important; visibility: revert !important;')
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

function normalizeStoredBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;

  if (bundle.cosmeticRulesBinary instanceof Uint8Array || bundle.cosmeticRulesBinary == null) {
    return bundle;
  }
  if (bundle.cosmeticRulesBinary instanceof ArrayBuffer) {
    return {
      ...bundle,
      cosmeticRulesBinary: new Uint8Array(bundle.cosmeticRulesBinary),
    };
  }
  if (Array.isArray(bundle.cosmeticRulesBinary)) {
    return {
      ...bundle,
      cosmeticRulesBinary: new Uint8Array(bundle.cosmeticRulesBinary),
    };
  }
  return bundle;
}

async function loadPackagedFilterSources() {
  try {
    const url = chrome.runtime.getURL('rules/filter-sources.json');
    return await (await fetch(url)).json();
  } catch {
    return null;
  }
}

async function fetchAndStoreRemoteFilterSources() {
  const sourceBundles = {};
  let fetchedAny = false;

  for (const list of REMOTE_FILTER_LISTS) {
    try {
      console.log(`[AdBlock] Fetching ${list.id} source bundle...`);
      const text = await fetchAndExpand(list.url);
      sourceBundles[list.id] = wasmReady
        ? parse_filter_source(text)
        : buildSourceBundleFromParsed(parseFilterList(text));
      fetchedAny = true;
    } catch (err) {
      console.error(`[AdBlock] Failed to fetch ${list.id}:`, err.message);
    }
  }

  if (!fetchedAny) return false;
  await db.putBulkFilterSources(sourceBundles);
  return true;
}

async function rebuildActiveRuleIndexFromStoredSources() {
  const enabledMap = normalizeEnabledRulesetsMap(
    (await getStorage(StorageKeys.ENABLED_RULESETS)) || {}
  );
  const storedSources = await db.getAllFilterSources();
  const sourceMap = new Map(storedSources.map((entry) => [entry.listId, entry]));
  const activeSources = REMOTE_FILTER_LIST_IDS
    .filter((listId) => enabledMap[listId] !== false)
    .map((listId) => sourceMap.get(listId))
    .filter(Boolean);

  let compiled = null;
  if (wasmReady) {
    try {
      compiled = compile_active_filter_index(CORE_FILTER_SOURCE, activeSources, 100);
    } catch (err) {
      console.error('[Nullify] WASM active index compilation failed:', err);
    }
  }

  const merged = compiled || mergeFilterSources(activeSources);

  await db.clearActiveRules();

  const bloomHosts = Array.isArray(compiled?.bloomHosts)
    ? compiled.bloomHosts
    : [
        ...Object.keys(merged.cosmetic.domainSpecific || {}),
        ...merged.scriptlets.flatMap((rule) => rule.domains || []),
        '',
      ];
  const totalDomains = Math.max(bloomHosts.length, 1);
  const newBloom = wasmReady ? new WasmBloom(totalDomains * 10, 4) : BloomFilter.forCapacity(totalDomains);

  await db.putBulkCosmeticRules(merged.cosmetic.domainSpecific || {});

  await db.putBulkScriptletRules(merged.scriptlets);
  for (const hostname of bloomHosts) {
    newBloom.add(hostname || '');
  }

  bloom = newBloom;
  await setStorage(
    StorageKeys.BLOOM_FILTER,
    wasmReady ? bloom.serialize_to_json() : bloom.serialize()
  );

  const genericBundle = buildPageBundle({
    generic: merged.cosmetic.generic || [],
    domainSpecific: [],
    exceptions: [],
  });
  cachedGenericCss = genericBundle.cssText || null;
  cachedGenericProceduralRules = genericBundle.rules?.domainSpecific || [];
  await Promise.all([
    setStorage(StorageKeys.GENERIC_CSS, cachedGenericCss || ''),
    setStorage(StorageKeys.GENERIC_PROCEDURAL_RULES, cachedGenericProceduralRules),
  ]);

  domainRulesCache.clear();
  _inFlightRules.clear();
  await db.clearPageBundles();
  return true;
}

async function ensureFilterSourcesReady() {
  if (await db.hasFilterSources()) return true;

  const packaged = await loadPackagedFilterSources();
  if (packaged && Object.keys(packaged).length > 0) {
    await db.putBulkFilterSources(packaged);
    return true;
  }

  return await fetchAndStoreRemoteFilterSources();
}

async function ensureRuleDataReady() {
  const existingBloom = await getStorage(StorageKeys.BLOOM_FILTER);
  const storedRuleDataVersion = await getStorage(StorageKeys.RULE_DATA_VERSION);
  const bundledRuleDataVersion = await computeBundledRuleDataVersion().catch(() => null);
  const hadSources = await db.hasFilterSources();
  let sourcesReady = hadSources;

  const ruleDataChanged = !!bundledRuleDataVersion && storedRuleDataVersion !== bundledRuleDataVersion;

  if (ruleDataChanged) {
    const packaged = await loadPackagedFilterSources();
    if (packaged && Object.keys(packaged).length > 0) {
      await db.putBulkFilterSources(packaged);
      sourcesReady = true;
    }
  }

  if (!sourcesReady) {
    sourcesReady = await ensureFilterSourcesReady();
  }

  if (sourcesReady) {
    if (!existingBloom || !hadSources || ruleDataChanged) {
      await rebuildActiveRuleIndexFromStoredSources();
      if (bundledRuleDataVersion) {
        await setStorage(StorageKeys.RULE_DATA_VERSION, bundledRuleDataVersion);
      }
    }
    return true;
  }

  if (!existingBloom || ruleDataChanged) {
    await ingestLegacyRules();
    if (bundledRuleDataVersion) {
      await setStorage(StorageKeys.RULE_DATA_VERSION, bundledRuleDataVersion);
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------
// Re-registers the context menu idempotently. Chrome throws
// "Cannot create item with duplicate id" if `create` runs twice with the
// same id — onInstalled AND onStartup both fire during update, so we must
// wipe first.
function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // Swallow lastError from removeAll (no-op if nothing to remove).
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: 'nullify-block-element',
      title: 'Block element...',
      contexts: ['all'],
    }, () => {
      void chrome.runtime.lastError;
    });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  registerContextMenus();

  try {
    if (details.reason === 'install') {
      await initializeDefaults();
    }

    await ensureRuleDataReady();
    await Promise.all([
      refreshMemoryCache(), // Fill RAM cache for speed
      restorePersistedStats(),
    ]);
    await ensureBackgroundSetup();
    await refreshAllBadges();
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
    // Defaults must be persisted BEFORE applyRulesets reads ENABLED_RULESETS.
    // initializeDefaults is idempotent (returns early if SETTINGS exists).
    await initializeDefaults();
    // Load the compiled per-ruleset rule counts before applyRulesets so
    // budget-fallback decisions use fresh numbers, not the stale literals.
    await loadRulesetCountsFromBuild();

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
      await initWasmFromUrl(init, wasmUrl);
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

    // Stage 1: Ensure the active rule index exists and is list-aware.
    await ensureRuleDataReady();

    // Stage 2: Critical data for responding to content scripts
    await Promise.all([
      loadBloomFilter(),
      refreshMemoryCache(),
      restorePersistedStats(),
    ]);
    _criticalReady = true;
    refreshAllBadges().catch(err => console.error('[Nullify] Badge refresh failed:', err));

    // Stage 3: Background tasks (non-blocking for messages)
    ensureBackgroundSetup().catch(err => console.error('[Nullify] Background startup failed:', err));

  })().catch(err => console.error('[Nullify] Critical startup failed:', err));

  return _criticalPromise;
}

// Ensure startup begins immediately
startInitialization();

chrome.runtime.onStartup.addListener(() => {
  registerContextMenus();
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

function getYouTubeShieldExcludeMatches() {
  return YOUTUBE_SHIELD_TARGETS
    .filter(({ hostname }) => isHostnameAllowedCached(hostname))
    .map(({ pattern }) => pattern);
}

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function syncYouTubeShieldRegistration() {
  const run = async () => {
    const registration = {
      id: YOUTUBE_SHIELD_SCRIPT_ID,
      matches: YOUTUBE_SHIELD_TARGETS.map(({ pattern }) => pattern),
      excludeMatches: getYouTubeShieldExcludeMatches(),
      js: ['dist/youtube-shield.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      persistAcrossSessions: true,
    };

    const existingScripts = await chrome.scripting.getRegisteredContentScripts({
      ids: [YOUTUBE_SHIELD_SCRIPT_ID],
    }).catch(() => []);
    const existing = existingScripts?.[0] || null;

    if (
      existing &&
      arraysEqual(existing.matches || [], registration.matches) &&
      arraysEqual(existing.excludeMatches || [], registration.excludeMatches) &&
      existing.runAt === registration.runAt &&
      existing.world === registration.world &&
      existing.allFrames === registration.allFrames
    ) {
      return;
    }

    if (existing && typeof chrome.scripting.updateContentScripts === 'function') {
      await chrome.scripting.updateContentScripts([{
        id: YOUTUBE_SHIELD_SCRIPT_ID,
        matches: registration.matches,
        excludeMatches: registration.excludeMatches,
        runAt: registration.runAt,
        world: registration.world,
        allFrames: registration.allFrames,
      }]);
      return;
    }

    if (existing) {
      await chrome.scripting.unregisterContentScripts({ ids: [YOUTUBE_SHIELD_SCRIPT_ID] }).catch(() => {});
    }

    await chrome.scripting.registerContentScripts([registration]);
  };

  const pending = (youtubeShieldSyncPromise || Promise.resolve())
    .then(run)
    .catch((err) => {
      console.error('[Nullify] Failed to sync YouTube shield registration:', err);
    });

  youtubeShieldSyncPromise = pending.finally(() => {
    if (youtubeShieldSyncPromise === pending) {
      youtubeShieldSyncPromise = null;
    }
  });

  return youtubeShieldSyncPromise;
}

async function refreshMemoryCache() {
  const data = await getStorageBulk([
    StorageKeys.SETTINGS,
    StorageKeys.ALLOWLIST,
    StorageKeys.GENERIC_CSS,
    StorageKeys.GENERIC_PROCEDURAL_RULES,
  ]);

  cachedSettings = data[StorageKeys.SETTINGS];
  const rawAllowlist = data[StorageKeys.ALLOWLIST] || [];
  const normalizedAllowlist = normalizeAllowlist(rawAllowlist);
  cachedAllowlist = new Set(normalizedAllowlist);

  // Sync DNR state BEFORE rebuilding the in-memory matcher.
  // If we rebuilt the matcher first, content scripts could observe one
  // allowlist state while DNR still enforced the previous one.
  if (
    rawAllowlist.length !== normalizedAllowlist.length ||
    rawAllowlist.some((domain, index) => domain !== normalizedAllowlist[index])
  ) {
    await setStorage(StorageKeys.ALLOWLIST, normalizedAllowlist);
    await rebuildAllowlistRules(normalizedAllowlist);
  }

  rebuildAllowlistMatcher(); // Rebuild with fresh allowlist data — last, so matcher and DNR agree.

  const genericCss = data[StorageKeys.GENERIC_CSS];
  if (typeof genericCss === 'string' && genericCss.length > 0) {
    cachedGenericCss = genericCss;
  } else {
    cachedGenericCss = null;
  }
  cachedGenericProceduralRules = Array.isArray(data[StorageKeys.GENERIC_PROCEDURAL_RULES])
    ? data[StorageKeys.GENERIC_PROCEDURAL_RULES]
    : [];

  domainRulesCache.clear();
  await syncYouTubeShieldRegistration();
}

async function loadBloomFilter() {
  const data = await getStorage(StorageKeys.BLOOM_FILTER);
  if (data) {
    try {
      if (typeof data === 'string') {
        if (wasmReady) {
          bloom = WasmBloom.deserialize_from_json(data);
        } else {
          if (await db.hasFilterSources()) {
            await rebuildActiveRuleIndexFromStoredSources();
          } else {
            await ingestLegacyRules();
          }
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
async function ingestLegacyRules() {
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

    const genericBundle = buildPageBundle({
      generic: cosData.generic || [],
      domainSpecific: [],
      exceptions: [],
    });
    cachedGenericCss = genericBundle.cssText || null;
    cachedGenericProceduralRules = genericBundle.rules?.domainSpecific || [];
    await Promise.all([
      setStorage(StorageKeys.GENERIC_CSS, cachedGenericCss || ''),
      setStorage(StorageKeys.GENERIC_PROCEDURAL_RULES, cachedGenericProceduralRules),
    ]);

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
    showBadge: true,
    blockThirdPartyCookies: false,
    fingerprintProtection: false,
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
  await setStorage(StorageKeys.TOTAL_BLOCKED_TODAY, 0);
  await setStorage(StorageKeys.TOTAL_BLOCKED_DATE, getCurrentDayStamp());
  await setStorage(StorageKeys.FILTER_LISTS_META, {});

  // Enabled/disabled rulesets
  await setStorage(StorageKeys.ENABLED_RULESETS, getDefaultEnabledRulesets());

  console.log('[AdBlock] Defaults initialized');
}

// ---------------------------------------------------------------------------
// Privacy settings
// ---------------------------------------------------------------------------
async function applyPrivacySettings() {
  const settings = await getStorage(StorageKeys.SETTINGS) || {};

  // Block WebRTC IP leaks
  if (chrome.privacy?.network?.webRTCIPHandlingPolicy) {
    if (settings.blockWebRTC !== false) {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({
        value: 'disable_non_proxied_udp',
      });
    } else {
      await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
    }
  }

  // Block hyperlink auditing (ping attribute)
  if (chrome.privacy?.websites?.hyperlinkAuditingEnabled) {
    if (settings.blockHyperlinkAuditing !== false) {
      await chrome.privacy.websites.hyperlinkAuditingEnabled.set({ value: false });
    } else {
      await chrome.privacy.websites.hyperlinkAuditingEnabled.clear({});
    }
  }

  // Block third-party cookies (thirdPartyCookiesAllowed removed in Chrome 112)
  if (chrome.privacy?.websites?.thirdPartyCookiesAllowed) {
    await new Promise((resolve) => {
      chrome.privacy.websites.thirdPartyCookiesAllowed.set(
        { value: !settings.blockThirdPartyCookies },
        () => resolve()
      );
    });
  }

  // Update header stripping rules
  await applyHeaderRules(settings.stripTrackingHeaders !== false);

  // Upgrade insecure requests where possible.
  await applyUpgradeSchemeRules(settings.upgradeInsecureRequests !== false);

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
const DNR_HTTPS_RULES_START = 815_000;

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

/** Clear the legacy CSP-stripping rule. Enhanced stealth now runs in MAIN world. */
async function applyStealthRules(enabled) {
  const ruleId = DNR_STEALTH_RULES_START;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
  });
}

/** Upgrade HTTP requests to HTTPS. */
async function applyUpgradeSchemeRules(enabled) {
  const ruleId = DNR_HTTPS_RULES_START;

  if (!enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
    return;
  }

  const rules = [{
    id: ruleId,
    priority: 1,
    action: { type: 'upgradeScheme' },
    condition: {
      urlFilter: '|http://',
      excludedRequestDomains: ['localhost', '127.0.0.1', '0.0.0.0']
    }
  }];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: rules
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
    console.log('[AdBlock] Refreshing per-list cosmetic/scriptlet sources...');
    const updated = await fetchAndStoreRemoteFilterSources();
    if (!updated) {
      console.warn('[AdBlock] No filter sources were refreshed');
      return;
    }

    await rebuildActiveRuleIndexFromStoredSources();
    await setStorage(StorageKeys.LAST_UPDATE_CHECK, Date.now());
    console.log('[AdBlock] Filter source update complete');
  } finally {
    _filterUpdateInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Tab stats tracking — count blocked requests per tab
// ---------------------------------------------------------------------------
const tabStats = new Map(); // tabId → { blocked: number, url: string }
let totalBlockedToday = 0;
let totalBlockedDate = getCurrentDayStamp();

function getCurrentDayStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeTabStatsEntry(entry, fallbackUrl = '') {
  return {
    blocked: Math.max(0, Number(entry?.blocked) || 0),
    trackers: Math.max(0, Number(entry?.trackers) || 0),
    url: typeof entry?.url === 'string' ? entry.url : fallbackUrl,
  };
}

function ensureTabStatsEntry(tabId, url = '') {
  if (tabId == null || tabId < 0) return null;

  const stats = normalizeTabStatsEntry(tabStats.get(tabId), url);
  if (url) stats.url = url;
  tabStats.set(tabId, stats);
  return stats;
}

function rollDailyBlockedTotalIfNeeded() {
  const today = getCurrentDayStamp();
  if (totalBlockedDate === today) return false;

  totalBlockedDate = today;
  totalBlockedToday = 0;
  return true;
}

function incrementDailyBlockedTotal(count = 1) {
  const increment = Math.max(0, Number(count) || 0);
  if (increment === 0) return;

  rollDailyBlockedTotalIfNeeded();
  totalBlockedToday += increment;
}

function resetTabStats(tabId, url = '') {
  if (tabId == null || tabId < 0) return;

  tabStats.set(tabId, { blocked: 0, trackers: 0, url });
  updateBadge(tabId);
  schedulePersistTabStats();
}

async function restorePersistedStats() {
  const data = await getStorageBulk([
    StorageKeys.TAB_STATS,
    StorageKeys.TOTAL_BLOCKED_TODAY,
    StorageKeys.TOTAL_BLOCKED_DATE,
  ]);

  tabStats.clear();
  const storedStats = data[StorageKeys.TAB_STATS];
  if (storedStats && typeof storedStats === 'object') {
    for (const [key, val] of Object.entries(storedStats)) {
      const tabId = Number(key);
      if (!Number.isInteger(tabId) || tabId < 0) continue;
      tabStats.set(tabId, normalizeTabStatsEntry(val));
    }
  }

  const today = getCurrentDayStamp();
  totalBlockedDate = today;
  totalBlockedToday = data[StorageKeys.TOTAL_BLOCKED_DATE] === today
    ? Math.max(0, Number(data[StorageKeys.TOTAL_BLOCKED_TODAY]) || 0)
    : 0;

  if (
    data[StorageKeys.TOTAL_BLOCKED_DATE] !== totalBlockedDate ||
    data[StorageKeys.TOTAL_BLOCKED_TODAY] !== totalBlockedToday
  ) {
    await persistTabStats();
  }
}

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && !tabStats.has(tabId)) {
    resetTabStats(tabId, changeInfo.url || tab?.url || '');
  }
});

chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
  const { request, rule } = info;

  // 1. Determine action from ID ranges (new robust system)
  let actionLabel = 'block';

  const id = rule.ruleId;
  const ruleset = rule.rulesetId || '';

  // Check static rulesets (exceptions assigned 1,000,000+ range by compiler)
  if (id >= 1000000) {
    actionLabel = 'allow';
  } 
  // Check known allow-only static rulesets
  else if (['ubo-unbreak', 'anti-adblock', 'system-unbreak', '_allowlist'].some(r => ruleset.includes(r))) {
    actionLabel = 'allow';
  }
  // Handle Dynamic Rules categorization
  else if (ruleset === '_dynamic') {
    if (id >= 990000) {
      actionLabel = 'allow';
    } else if (id === DNR_HTTPS_RULES_START) {
      actionLabel = 'upgrade';
    } else if (id >= 800000 && id < 900000) {
      actionLabel = 'modify';
    }
  }

  if (request.tabId >= 0 && actionLabel === 'block') {
    const stats = ensureTabStatsEntry(request.tabId, request.url);
    stats.blocked++;
    incrementDailyBlockedTotal();

    // Classify as tracker if from privacy/malware lists OR matches tracker keywords
    const isTracker = (ruleset === 'easyprivacy' || ruleset === 'malware') ||
      (trackerMatcher?.matches(request.url));
    if (isTracker) {
      stats.trackers++;
    }

    updateBadge(request.tabId);
    schedulePersistTabStats();
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
    isTracker: actionLabel === 'block' && (
      ruleset === 'easyprivacy' ||
      ruleset === 'malware' ||
      !!trackerMatcher?.matches(request.url)
    ),
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

async function refreshAllBadges() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id != null) updateBadge(tab.id);
  }
}

function updateBadge(tabId) {
  if (tabId == null || tabId < 0) return; // ignore non-tab requests (tabId = -1)

  if (cachedSettings?.showBadge === false) {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => { });
    return;
  }

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
  await Promise.all([
    setStorage(StorageKeys.TAB_STATS, obj),
    setStorage(StorageKeys.TOTAL_BLOCKED_TODAY, totalBlockedToday),
    setStorage(StorageKeys.TOTAL_BLOCKED_DATE, totalBlockedDate),
  ]).catch(() => { });
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
      const compiled = compile_user_filters(filtersText || '', DNR_USER_RULES_START);
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
  await db.clearPageBundles();

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

  urlFilter = urlFilter.trim();
  if (!urlFilter) return null;

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
  if (!normalizedDomain) return Array.from(cachedAllowlist);

  if (cachedAllowlist.has(normalizedDomain)) {
    return Array.from(cachedAllowlist);
  }

  return setAllowlistDomains(Array.from(cachedAllowlist).concat(normalizedDomain));
}

/** Replace the entire allowlist and synchronize all dependent runtime state. */
async function setAllowlistDomains(domains) {
  const normalizedAllowlist = normalizeAllowlist(domains);

  cachedAllowlist = new Set(normalizedAllowlist);
  await setStorage(StorageKeys.ALLOWLIST, normalizedAllowlist);
  await rebuildAllowlistRules(normalizedAllowlist);
  rebuildAllowlistMatcher();

  // The allowlist changes which page bundles and script registrations apply,
  // so drop cached bundles and recompute the YouTube shield exclusions.
  domainRulesCache.clear();
  await syncYouTubeShieldRegistration();

  return normalizedAllowlist;
}

/** Remove a site from the allowlist. */
async function disallowSite(domain) {
  const normalizedDomain = normalizeHostname(domain);
  if (!normalizedDomain || !cachedAllowlist.has(normalizedDomain)) {
    return Array.from(cachedAllowlist);
  }

  return setAllowlistDomains(Array.from(cachedAllowlist).filter((entry) => entry !== normalizedDomain));
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
      newRules = build_allowlist_rules(normalizedAllowlist, DNR_ALLOWLIST_START);
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

// Static DNR rule counts for packaged rulesets. Populated at startup from
// `rules/ruleset-counts.json`, which `scripts/build-rules.mjs` emits. The
// literal defaults below are a frozen-in-time fallback if the build
// artifact is missing; they will drift, but keep budget checks working.
let RULESET_RULE_COUNTS = {
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

async function loadRulesetCountsFromBuild() {
  try {
    const url = chrome.runtime.getURL('rules/ruleset-counts.json');
    const res = await fetch(url);
    if (!res.ok) return;
    const counts = await res.json();
    if (counts && typeof counts === 'object') {
      RULESET_RULE_COUNTS = counts;
    }
  } catch (err) {
    console.warn('[Nullify] ruleset-counts.json load failed, using defaults:', err?.message || err);
  }
}

// Stability/safety lists first, then core blockers, then niche lists. Under
// tight static-rule budgets we prioritize ad blocking before tracker blocking,
// so every EasyList shard is attempted before any EasyPrivacy shard.
const RULESET_ENABLE_PRIORITY = [
  'system-unbreak',
  'ubo-unbreak',
  'easylist',
  'easylist_2',
  'easylist_3',
  'easylist_4',
  'malware',
  'ubo-filters',
  'anti-adblock',
  'annoyances',
  'ubo-cookie-annoyances',
  'ubo-filters_2',
  'easyprivacy',
  'easyprivacy_2',
  'easyprivacy_3',
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

/**
 * Return the set of ruleset IDs that this extension actually declares in its
 * manifest. Used to filter out stale/unknown IDs before calling
 * chrome.declarativeNetRequest.updateEnabledRulesets, which rejects the whole
 * batch if any ID is unknown.
 */
function getManifestRulesetIds() {
  const rulesetIds = new Set();
  try {
    const manifest = chrome.runtime.getManifest();
    const resources = manifest?.declarative_net_request?.rule_resources || [];
    for (const resource of resources) {
      if (resource?.id) rulesetIds.add(resource.id);
    }
  } catch (err) {
    console.warn('[AdBlock] Failed to read manifest ruleset IDs:', err);
  }
  return rulesetIds;
}

/**
 * Run the sequential priority fallback: disable everything, then enable
 * rulesets one at a time in priority order, stopping at Chrome's static rule
 * limit. Returns the list of IDs that could not be enabled.
 */
async function applyRulesetsSequentially(enableRulesetIds, disableRulesetIds) {
  // Reset our static rulesets so budget checks start from a clean slate.
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: [...new Set(enableRulesetIds.concat(disableRulesetIds))],
    });
  } catch (resetErr) {
    console.warn('[AdBlock] Reset before sequential fallback failed:', resetErr);
  }

  const prioritizedRulesetIds = orderRulesetIdsByPriority(enableRulesetIds);
  const skippedRulesetIds = [];
  let availableStaticRuleCount = await chrome.declarativeNetRequest
    .getAvailableStaticRuleCount()
    .catch(() => Number.MAX_SAFE_INTEGER);

  for (const id of prioritizedRulesetIds) {
    const estimatedRuleCount = RULESET_RULE_COUNTS[id] ?? 0;
    if (estimatedRuleCount > 0 && estimatedRuleCount > availableStaticRuleCount) {
      skippedRulesetIds.push(id);
      continue;
    }

    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] });
      availableStaticRuleCount = await chrome.declarativeNetRequest
        .getAvailableStaticRuleCount()
        .catch(() => availableStaticRuleCount);
    } catch (seqErr) {
      // Log every failure — previously only rule-limit errors were
      // recorded, which silently hid missing/malformed ruleset errors.
      console.warn(`[AdBlock] Enable ruleset "${id}" failed:`, seqErr?.message || seqErr);
      skippedRulesetIds.push(id);
    }
  }

  return skippedRulesetIds;
}

/** Apply all enabled static rulesets, respecting Chrome's global rule count limits. */
async function applyRulesets() {
  const enabledMap = normalizeEnabledRulesetsMap(
    (await getStorage(StorageKeys.ENABLED_RULESETS)) || {}
  );

  const allKnownListIds = [
    'system-unbreak', 'ubo-unbreak', 'ubo-filters', 'easylist',
    'easyprivacy', 'malware', 'annoyances', 'anti-adblock', 'ubo-cookie-annoyances'
  ];

  const manifestRulesetIds = getManifestRulesetIds();
  const enableRulesetIds = [];
  const disableRulesetIds = [];
  const unknownRulesetIds = [];

  for (const listId of allKnownListIds) {
    const rulesets = getRulesetIdsForList(listId);
    for (const rulesetId of rulesets) {
      // Filter out IDs that the manifest no longer declares. Passing an
      // unknown ID to updateEnabledRulesets rejects the entire batch, which
      // historically caused every ruleset to stay disabled on fresh install.
      if (manifestRulesetIds.size > 0 && !manifestRulesetIds.has(rulesetId)) {
        unknownRulesetIds.push(rulesetId);
        continue;
      }

      if (enabledMap[listId] === true || listId === 'system-unbreak') {
        enableRulesetIds.push(rulesetId);
      } else {
        disableRulesetIds.push(rulesetId);
      }
    }
  }

  if (unknownRulesetIds.length > 0) {
    console.warn('[AdBlock] Skipping ruleset IDs not declared in manifest:', unknownRulesetIds.join(', '));
  }

  try {
    // 1. Try batch operation first (most efficient)
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds,
      disableRulesetIds,
    });
  } catch (err) {
    // 2. Fall back to the sequential per-ruleset path for ANY error —
    // previously only rule-limit errors triggered the fallback, so a single
    // unknown/malformed ruleset would cause every other list to stay off.
    const isRuleLimitError = err?.message?.includes('exceeds the rule count limit');
    if (isRuleLimitError) {
      console.warn('[AdBlock] Batch enable failed due to rule limit. Falling back to sequential priority loading.');
    } else {
      console.warn('[AdBlock] Batch enable failed; falling back to sequential loading:', err?.message || err);
    }

    const skippedRulesetIds = await applyRulesetsSequentially(enableRulesetIds, disableRulesetIds);

    if (skippedRulesetIds.length > 0) {
      console.warn('[AdBlock] Skipped rulesets during sequential fallback:', skippedRulesetIds.join(', '));
    }
  }

  try {
    const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
    console.log('[AdBlock] Enabled static rulesets:', enabledRulesets.join(', '));
  } catch (err) {
    console.warn('[AdBlock] Failed to read enabled static rulesets:', err);
  }

  return getEffectiveEnabledRulesetsMap();
}

// Debounced cosmetic index rebuild — toggling several rulesets in quick
// succession (e.g. from the options UI) would otherwise trigger one full
// rebuild per toggle. Trailing-edge so the final state is always applied.
const REBUILD_DEBOUNCE_MS = 150;
let _rebuildIndexTimer = null;
let _rebuildIndexPromise = null;
let _rebuildIndexResolve = null;

function scheduleActiveIndexRebuild() {
  if (!_rebuildIndexPromise) {
    _rebuildIndexPromise = new Promise((resolve) => {
      _rebuildIndexResolve = resolve;
    });
  }
  if (_rebuildIndexTimer) clearTimeout(_rebuildIndexTimer);
  _rebuildIndexTimer = setTimeout(async () => {
    _rebuildIndexTimer = null;
    const resolve = _rebuildIndexResolve;
    _rebuildIndexPromise = null;
    _rebuildIndexResolve = null;
    try {
      if (await ensureFilterSourcesReady()) {
        await rebuildActiveRuleIndexFromStoredSources();
      }
    } catch (err) {
      console.error('[Nullify] Cosmetic index rebuild failed:', err);
    } finally {
      resolve?.();
    }
  }, REBUILD_DEBOUNCE_MS);
  return _rebuildIndexPromise;
}

/** Enable or disable a static ruleset (or group) by ID. */
async function setRulesetEnabled(rulesetId, enabled) {
  const meta = normalizeEnabledRulesetsMap(
    (await getStorage(StorageKeys.ENABLED_RULESETS)) || {}
  );
  meta[rulesetId] = enabled;
  await setStorage(StorageKeys.ENABLED_RULESETS, meta);

  const enabledMap = await applyRulesets();
  scheduleActiveIndexRebuild();
  return enabledMap;
}

async function getEffectiveEnabledRulesetsMap() {
  const activeRulesets = new Set(await chrome.declarativeNetRequest.getEnabledRulesets().catch(() => []));
  const effective = normalizeEnabledRulesetsMap({});

  for (const listId of ALL_KNOWN_LIST_IDS) {
    if (listId === 'system-unbreak') {
      effective[listId] = true;
      continue;
    }

    const rulesetIds = getRulesetIdsForList(listId);
    const enabledCount = rulesetIds.filter((id) => activeRulesets.has(id)).length;

    if (enabledCount === 0) effective[listId] = false;
    else if (enabledCount === rulesetIds.length) effective[listId] = true;
    else effective[listId] = 'partial';
  }

  return effective;
}

// ---------------------------------------------------------------------------
// Scriptlet injection
// ---------------------------------------------------------------------------

// Per-SW-session capability key the scriptlet bundle registers itself under.
// We don't expose this key to the page via any fixed name, and the registry
// property is installed non-enumerable + non-configurable so page scripts
// can't enumerate or shadow it. A page could still reach the bundle by
// guessing the key, but the 128-bit nonce makes that infeasible.
const SCRIPTLET_REGISTRY_KEY = (() => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return '__n_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
})();

// Produce a 64-bit integer seed from the CSPRNG for WASM noise generators.
// `Date.now() * Math.random()` is predictable, low-entropy, and callable in
// a timing attack — `crypto.getRandomValues` is both faster and unbiased.
function cryptoSeed64() {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  // JS numbers are float64 (53-bit mantissa); combining two u32s saturates
  // below 2^53 which fits the `seed as u64` cast on the Rust side.
  return buf[0] * 0x1_0000 + buf[1];
}

/**
 * Inject scriptlets into a tab/frame via chrome.scripting.executeScript
 * in the MAIN world — this allows intercepting window-level properties.
 */
async function injectScriptlets(tabId, frameId, scriptletRules) {
  if (!scriptletRules || scriptletRules.length === 0) return;

  try {
    const registryReady = await ensureScriptletRegistry(tabId, frameId);
    if (!registryReady) return;

    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: executeScriptlets,
      args: [SCRIPTLET_REGISTRY_KEY, scriptletRules],
    });
  } catch (err) {
    if (!err.message?.includes('No frame with id')) {
      console.warn('[AdBlock] Scriptlet injection failed:', err.message);
    }
  }
}

function hasScriptletRegistry(key) {
  const reg = window[key];
  return reg && typeof reg.run === 'function';
}

function seedBootKey(key) {
  globalThis.__nullifyBootKey = key;
}

async function ensureScriptletRegistry(tabId, frameId) {
  try {
    const [{ result: ready = false } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: hasScriptletRegistry,
      args: [SCRIPTLET_REGISTRY_KEY],
    });

    if (ready) return true;

    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: seedBootKey,
      args: [SCRIPTLET_REGISTRY_KEY],
    });

    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      files: ['dist/scriptlets-world.js'],
    });

    return true;
  } catch (err) {
    if (!err.message?.includes('No frame with id')) {
      console.warn('[AdBlock] Failed to bootstrap scriptlet registry:', err.message);
    }
    return false;
  }
}

/**
 * This function runs in the MAIN world of the page. The registry is looked
 * up under a specific per-session key the page does not know and cannot
 * enumerate (property is non-enumerable). Unknown registries are ignored.
 */
function executeScriptlets(key, specs) {
  const registry = window[key];
  if (!registry || typeof registry.run !== 'function') return;

  for (const spec of specs) {
    try {
      registry.run(spec.name, spec.args);
    } catch (e) { }
  }
}

// ---------------------------------------------------------------------------
// Message bus
// ---------------------------------------------------------------------------
// Messages only ever come from this extension's own pages + content scripts.
// Reject anything else up front rather than dispatching it into the handler
// (defense in depth against accidental `externally_connectable` regressions
// or malformed traffic from compromised renderers).
const MAX_USER_FILTERS_BYTES = 2 * 1024 * 1024;   // 2 MB text cap
const MAX_USER_FILTERS_DNR_RULES = 10_000;        // dynamic DNR budget guard

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'foreign sender rejected' });
    return false;
  }
  if (!message || typeof message.type !== 'string') {
    sendResponse({ error: 'malformed message' });
    return false;
  }

  // For content-script critical-path messages, ensure caches are ready first.
  // Non-critical messages (stats, settings UI) don't need to wait.
  const needsCache = message.type === 'GET_COSMETIC_RULES' ||
    message.type === 'GET_SCRIPTLET_RULES' ||
    message.type === 'IS_SITE_ALLOWED' ||
    message.type === 'GET_ALLOWLIST' ||
    message.type === 'GET_TAB_STATS' ||
    message.type === 'GET_DAILY_BLOCKED_TOTAL' ||
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

      const isTopFrame = (sender.frameId || 0) === 0;

      if (!isAllowed && sender.tab?.id) {
        const scriptletsToRun = [...scriptletRules];

        if (!hostname.includes('youtube.com') && isTopFrame && settings.fingerprintProtection === true) {
          scriptletsToRun.push({ name: 'fingerprint-noise', args: [] });
          scriptletsToRun.push({ name: 'battery-spoof', args: [] });
        }
        if (isTopFrame && settings.enhancedStealth === true) {
          scriptletsToRun.push({ name: 'bot-stealth', args: [settings.stealthPersona || 'default'] });
        }
        if (isTopFrame && settings.stealthPersona && settings.stealthPersona !== 'default') {
          scriptletsToRun.push({ name: 'persona-spoof', args: [settings.stealthPersona] });
        }
        if (scriptletsToRun.length > 0) {
          await injectScriptlets(sender.tab.id, sender.frameId || 0, scriptletsToRun);
        }
      }

      let responseData = {
        isAllowed,
        settings,
        cosmeticRules: cosmeticBundle.rules,
        cssText: cosmeticBundle.cssText || '',
        exceptionCss: cosmeticBundle.exceptionCss || '',
        genericProceduralRules: cachedGenericProceduralRules,
      };

      if (wasmReady && !isAllowed && cosmeticBundle.cosmeticRulesBinary) {
        try {
          responseData.cosmeticRulesBinary = cosmeticBundle.cosmeticRulesBinary;
          delete responseData.cosmeticRules;
          
          // Also provide a sanitized URL for privacy reporting/cleanup.
          // `urlSanitizer` is initialized alongside WASM readiness, so if
          // it is missing we skip sanitization rather than reconstructing
          // the AC per call (the standalone fn has been removed).
          if (sender.tab?.url && urlSanitizer) {
            responseData.sanitizedUrl = urlSanitizer.sanitize(sender.tab.url);
          }
        } catch (err) {
          console.error('[Nullify] Rule serialization/sanitization failed:', err);
        }
      }

      return responseData;
    }
    case 'GET_TAB_STATS': {
      const tabId = payload?.tabId ?? sender.tab?.id;
      return normalizeTabStatsEntry(tabStats.get(tabId));
    }
    case 'GET_DAILY_BLOCKED_TOTAL': {
      if (rollDailyBlockedTotalIfNeeded()) {
        await persistTabStats();
      }
      return { total: totalBlockedToday };
    }
    case 'GET_SETTINGS':
      return (await getStorage(StorageKeys.SETTINGS)) || {};
    case 'SET_SETTINGS': {
      await setStorage(StorageKeys.SETTINGS, payload);
      cachedSettings = payload;
      await applyPrivacySettings();
      await refreshAllBadges();
      return { ok: true };
    }
    case 'UPDATE_SETTINGS': {
      // Partial merge — safe when multiple UI surfaces (popup + options)
      // may be editing settings concurrently. SET_SETTINGS is read-modify-
      // write from the caller's perspective and can drop sibling changes.
      const current = (await getStorage(StorageKeys.SETTINGS)) || {};
      const merged = { ...current, ...(payload || {}) };
      await setStorage(StorageKeys.SETTINGS, merged);
      cachedSettings = merged;
      await applyPrivacySettings();
      await refreshAllBadges();
      return { ok: true, settings: merged };
    }
    case 'GET_ALLOWLIST':
      return Array.from(cachedAllowlist);
    case 'ALLOW_SITE': {
      const domain = normalizeHostname(payload.domain);
      if (!domain) return { ok: false };
      const allowlist = await allowSite(domain);
      return { ok: true, allowlist };
    }
    case 'DISALLOW_SITE': {
      const domain = normalizeHostname(payload.domain);
      if (!domain) return { ok: false };
      const allowlist = await disallowSite(domain);
      return { ok: true, allowlist };
    }
    case 'SET_ALLOWLIST': {
      const allowlist = await setAllowlistDomains(payload?.domains);
      return { ok: true, allowlist };
    }
    case 'IS_SITE_ALLOWED': {
      return { allowed: isHostnameAllowedCached(normalizeHostname(payload.domain)) };
    }
    case 'GET_USER_FILTERS':
      return { filters: (await getStorage(StorageKeys.USER_FILTERS)) || '' };
    case 'SET_USER_FILTERS': {
      const raw = typeof payload?.filters === 'string' ? payload.filters : '';
      // Cap raw text at 2 MB so a pasted/imported blob cannot exhaust the
      // service worker's heap or block the filter compiler indefinitely.
      if (raw.length > MAX_USER_FILTERS_BYTES) {
        return { error: `User filters exceed ${MAX_USER_FILTERS_BYTES} byte limit` };
      }
      await setStorage(StorageKeys.USER_FILTERS, raw);
      const counts = await applyUserFilters(raw);
      // Extra guard on compiled DNR output — dynamic rule budget is finite.
      if (counts && Number.isFinite(counts.network) && counts.network > MAX_USER_FILTERS_DNR_RULES) {
        return { ...counts, warning: `Network rule count ${counts.network} exceeds budget ${MAX_USER_FILTERS_DNR_RULES}` };
      }
      return counts;
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
      const enabledMap = await setRulesetEnabled(payload.rulesetId, payload.enabled);
      return { ok: true, enabledMap };
    }
    case 'GET_ENABLED_RULESETS':
      return await getEffectiveEnabledRulesetsMap();

    case 'GET_NOISE': {
      const { mean = 0, stdDev = 1 } = payload || {};
      if (wasmReady) {
        return { noise: generate_gaussian_noise(mean, stdDev, cryptoSeed64()) };
      }
      return { noise: (Math.random() - 0.5) * 2 * stdDev + mean }; // JS fallback
    }

    case 'GET_ANONYMIZED_STATS': {
      const stats = await getStorage(StorageKeys.TAB_STATS) || {};
      if (!wasmReady) return { stats };

      const json = JSON.stringify(stats);
      const noiseScale = payload?.noiseScale || 2.0;
      const anonymizedJson = anonymize_stats_json(json, noiseScale, cryptoSeed64());
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
      if (tabId != null && tabId >= 0) {
        const count = Number(payload.count);
        const increment = Number.isFinite(count) && count > 0 ? count : 1;
        const entry = ensureTabStatsEntry(tabId, sender.tab?.url || '');
        entry.blocked += increment;
        incrementDailyBlockedTotal(increment);
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

  const persistedBundle = normalizeStoredBundle(await db.getPageBundle(hostname));
  if (persistedBundle) {
    setCachedDomainRules(hostname, persistedBundle);
    return persistedBundle;
  }

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
    const bundle = normalizeStoredBundle(await promise);
    setCachedDomainRules(hostname, bundle); // Populate cache so GET_INIT_DATA skips IndexedDB
    await db.putPageBundle(hostname, bundle)
      .then(() => db.prunePageBundles(PAGE_BUNDLE_DB_MAX))
      .catch(() => {});
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
async function performEarlyInjection(tabId, frameId, urlStr) {
  if (!urlStr?.startsWith('http')) return;
  const url = new URL(urlStr);
  const hostname = normalizeHostname(url.hostname);

  if (isHostnameAllowedCached(hostname)) return;

  // 1. Inject Generic CSS
  if (cachedGenericCss) {
    chrome.scripting.insertCSS({
      target: { tabId, frameIds: [frameId] },
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
      target: { tabId, frameIds: [frameId] },
      css: bundle.cssText,
      origin: 'USER',
    }).catch(() => { });
  }

  // 3. Inject Exceptions
  if (bundle.exceptionCss) {
    chrome.scripting.insertCSS({
      target: { tabId, frameIds: [frameId] },
      css: bundle.exceptionCss,
      origin: 'USER',
    }).catch(() => { });
  }
}

/**
 * Stage 1: onBeforeNavigate (Warm up the cache)
 */
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (!details.url.startsWith('http')) return;

  if (details.frameId === 0) {
    resetTabStats(details.tabId, details.url);
  }

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
  performEarlyInjection(details.tabId, details.frameId || 0, details.url);
});
