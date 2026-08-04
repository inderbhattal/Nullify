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

// DEBUG flag for development logging — set via chrome.storage.local for runtime control
// Checked synchronously at load time; changes require service worker restart
const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};
const warn = console.warn.bind(console);

// Structured error reporting — collects critical failures for diagnostics
const errorReport = {
  critical: [],
  warnings: [],
  lastError: null,
};

function reportError(context, error, options = { fatal: false }) {
  const entry = {
    context,
    message: error?.message || String(error),
    stack: error?.stack,
    timestamp: Date.now(),
    fatal: options.fatal,
  };
  errorReport.lastError = entry;
  if (options.fatal) {
    errorReport.critical.push(entry);
    console.error(`[Nullify] CRITICAL: ${context} — ${entry.message}`);
  } else {
    errorReport.warnings.push(entry);
    warn(`[Nullify] ${context} — ${entry.message}`);
  }
  // Keep only last 100 entries per category
  if (errorReport.critical.length > 100) errorReport.critical.shift();
  if (errorReport.warnings.length > 100) errorReport.warnings.shift();
}

// Configurable constants — defaults can be overridden via storage
// Single source of truth for tunables — every consumer reads CONFIG.* directly
// (see docs/REVIEW-2026-07.md §5.7: the previous shadow consts drifted from
// these entries, and two entries had no consumer at all).
const CONFIG = {
  BLOOM_FILL_THRESHOLD: 0.5,        // Rebuild bloom filter when fill ratio exceeds this
  BLOOM_BITS_PER_ITEM: 10,          // Bits per item for ~1% false positive rate
  DOMAIN_RULES_CACHE_MAX: 100,      // Max entries in LRU domain rules cache
  PAGE_BUNDLE_DB_MAX: 250,          // Max page bundles in IndexedDB
  FILTER_UPDATE_INTERVAL_MINUTES: 1440,  // 24 hours
  ACTIVE_INDEX_REBUILD_STALL_MS: 120_000, // §5.4 — release a rebuild that never settles
};

import {getStorage, getStorageBulk, setStorage, StorageKeys} from '../shared/storage.js';
import {RulesDB} from '../shared/db.js';
import {BloomFilter} from '../shared/bloom.js';
import {fetchAndExpand, parseFilterList, COSMETIC_SCOPE_OPTIONS} from '../shared/filter-parser.js';
import { normalizeAllowlist, normalizeHostname, isValidAllowlistDomain } from '../shared/hostname.js';
import { ancestorDomains } from '../shared/psl.js';
import { encodeBinaryRules } from '../shared/rule-transport.js';
import { applyScriptletExceptions } from '../shared/filter-syntax.js';
import { createYouTubeShieldSync } from './youtube-shield-sync.js';
import {
  COSMETIC_SELECTOR_DENYLIST,
  CORE_FILTER_SOURCE,
  shouldSkipDomainCosmeticSelector,
  shouldSkipGenericCosmeticForHostname,
} from '../shared/core-filter-source.js';
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
  parse_filter_source,
  plan_selector_rules_json,
  serialize_rules_to_binary_from_json,
  resolve_entity,
  is_semantic_ad,
  BloomFilter as WasmBloomClass
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

function runtimeAssetPath(filename) {
  const serviceWorkerPath = chrome.runtime.getManifest?.()?.background?.service_worker || '';
  return serviceWorkerPath.startsWith('dist/') ? `dist/${filename}` : filename;
}

function runtimeAssetCandidates(filename) {
  const primary = runtimeAssetPath(filename);
  const fallback = primary.startsWith('dist/') ? filename : `dist/${filename}`;
  return [...new Set([primary, fallback])].map((path) => ({
    path,
    url: chrome.runtime.getURL(path),
  }));
}

async function initWasmFromRuntimeAsset(initFn, filename) {
  const failures = [];
  for (const candidate of runtimeAssetCandidates(filename)) {
    try {
      await initWasmFromUrl(initFn, candidate.url);
      return candidate;
    } catch (err) {
      failures.push(`${candidate.path}: ${err?.message || String(err)}`);
    }
  }
  throw new Error(`Failed to initialize ${filename}; tried ${failures.join('; ')}`);
}

const db = new RulesDB();
let bloom = null;
let wasmReady = false;
let wasmReadyPromise = null;  // Promise that resolves when WASM is ready
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
let cachedGenericCosmeticExcludedDomains = [];
let domainRulesCache = new Map(); // hostname -> packaged page bundle (LRU, max 100 entries)
const _inFlightRules = new Map();
const YOUTUBE_SHIELD_SCRIPT_ID = 'nullify-youtube-shield';
const YOUTUBE_SHIELD_TARGETS = [
  { hostname: 'youtube.com', pattern: '*://youtube.com/*' },
  { hostname: 'www.youtube.com', pattern: '*://www.youtube.com/*' },
  { hostname: 'm.youtube.com', pattern: '*://m.youtube.com/*' },
  { hostname: 'music.youtube.com', pattern: '*://music.youtube.com/*' },
];
let _youtubeShieldSync = null;
function getYouTubeShieldSync() {
  if (_youtubeShieldSync) return _youtubeShieldSync;
  _youtubeShieldSync = createYouTubeShieldSync({
    chrome,
    isHostnameAllowed: isHostnameAllowedCached,
    runtimeAssetPath,
    scriptId: YOUTUBE_SHIELD_SCRIPT_ID,
    targets: YOUTUBE_SHIELD_TARGETS,
  });
  return _youtubeShieldSync;
}
async function syncYouTubeShieldRegistration() {
  return getYouTubeShieldSync().syncRegistration();
}

function setCachedDomainRules(hostname, bundle) {
  // Evict oldest entry when at capacity (Map preserves insertion order)
  if (domainRulesCache.size >= CONFIG.DOMAIN_RULES_CACHE_MAX) {
    domainRulesCache.delete(domainRulesCache.keys().next().value);
  }
  domainRulesCache.set(hostname, bundle);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ALARM_FILTER_UPDATE = 'filter-list-update';
const ALARM_STATS_CLEANUP = 'stats-cleanup';
const STATS_CLEANUP_INTERVAL_MINUTES = 30;
const RULE_DATA_SCHEMA_VERSION = 3;

// Load config from storage with fallback to defaults
async function loadConfig() {
  const stored = await getStorageBulk([
    StorageKeys.BLOOM_FILL_THRESHOLD,
  ]).catch(() => ({}));

  if (typeof stored[StorageKeys.BLOOM_FILL_THRESHOLD] === 'number') {
    CONFIG.BLOOM_FILL_THRESHOLD = stored[StorageKeys.BLOOM_FILL_THRESHOLD];
  }
}

let bundledRuleDataVersionPromise = null;
let activeRuleDataVersion = null;

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
      genericExcludedDomains: [...(source?.cosmetic?.genericExcludedDomains || [])],
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
    target[domain].push(...(selectors || []).filter(
      (selector) => !shouldSkipDomainCosmeticSelector(domain, selector)
    ));
  }
}

function normalizeGeneratedDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

function dedupeGeneratedDomains(domains) {
  return [...new Set((domains || []).map(normalizeGeneratedDomain).filter(Boolean))];
}

function collectGenericCosmeticExcludedDomains(sources) {
  return dedupeGeneratedDomains(
    (sources || []).flatMap((source) => source?.cosmetic?.genericExcludedDomains || [])
  );
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
  const cosmetic = {
    generic: [],
    domainSpecific: {},
    exceptions: {},
    genericExcludedDomains: dedupeGeneratedDomains(parsed?.genericCosmeticExceptionDomains),
  };

  const addException = (domain, selector) => {
    if (!cosmetic.exceptions[domain]) cosmetic.exceptions[domain] = [];
    cosmetic.exceptions[domain].push(selector);
  };

  for (const rule of parsed?.cosmeticRules || []) {
    if (!rule?.selector) continue;

    // `~domain` exclusions ride the existing per-domain exception map: lookup
    // already gathers exceptions across the ancestor walk and subtracts them,
    // which is precisely what an exclusion means. Mirrors the build-time
    // builder in scripts/build-rules.mjs — the two must agree.
    const excluded = rule.excludedDomains || [];

    if (rule.domains.length === 0) {
      if (!rule.exception) {
        cosmetic.generic.push(rule.selector);
        for (const domain of excluded) addException(domain, rule.selector);
      }
      continue;
    }

    for (const domain of rule.domains) {
      if (shouldSkipDomainCosmeticSelector(domain, rule.selector)) continue;
      if (rule.exception) {
        addException(domain, rule.selector);
      } else {
        if (!cosmetic.domainSpecific[domain]) cosmetic.domainSpecific[domain] = [];
        cosmetic.domainSpecific[domain].push(rule.selector);
      }
    }

    if (!rule.exception) {
      for (const domain of excluded) addException(domain, rule.selector);
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
    scriptlets: applyScriptletExceptions(
      dedupeScriptlets(parsed?.scriptletRules || []),
      parsed?.scriptletExceptions,
    ),
  };
}

function mergeFilterSources(listSources) {
  const mergedCosmetic = cloneFilterSource(CORE_FILTER_SOURCE).cosmetic;
  const mergedScriptlets = [...CORE_FILTER_SOURCE.scriptlets];

  for (const source of listSources) {
    mergedCosmetic.generic.push(...(source?.cosmetic?.generic || []));
    appendSelectorsByDomain(mergedCosmetic.domainSpecific, source?.cosmetic?.domainSpecific);
    appendSelectorsByDomain(mergedCosmetic.exceptions, source?.cosmetic?.exceptions);
    mergedCosmetic.genericExcludedDomains.push(...(source?.cosmetic?.genericExcludedDomains || []));
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
    cosmetic: {
      generic,
      domainSpecific,
      genericExcludedDomains: dedupeGeneratedDomains(mergedCosmetic.genericExcludedDomains),
    },
    scriptlets: dedupeScriptlets(mergedScriptlets),
  };
}

function foldDomainExceptionsIntoRules(domainSpecific = {}, exceptions = {}) {
  const merged = {};

  for (const [domain, selectors] of Object.entries(domainSpecific || {})) {
    const deduped = [...new Set((selectors || []).filter(
      (selector) => selector && !shouldSkipDomainCosmeticSelector(domain, selector)
    ))];
    if (deduped.length > 0) merged[domain] = deduped;
  }

  for (const [domain, selectors] of Object.entries(exceptions || {})) {
    if (!merged[domain]) merged[domain] = [];
    const seen = new Set(merged[domain]);
    for (const selector of selectors || []) {
      if (!selector) continue;
      const prefixed = '__exception__' + selector;
      if (seen.has(prefixed)) continue;
      seen.add(prefixed);
      merged[domain].push(prefixed);
    }
  }

  return merged;
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
        cosmeticSelectorDenylist: COSMETIC_SELECTOR_DENYLIST,
        packaged: packaged || {},
      }));
    })().catch((err) => {
      bundledRuleDataVersionPromise = null;
      throw err;
    });
  }
  return bundledRuleDataVersionPromise;
}

// All known procedural operators that require JS evaluation.
//
// §5.20 — this list MUST equal `PROC_OPS` in src/content/cosmetic-engine.js
// (and the operator set wasm-core plans against). `semantic` was missing here
// only, so on the WASM-down path `div:semantic(x)` was not recognised as
// procedural, passed `isSafeCssSelector`, and shipped to the page as literal
// CSS — a selector no browser matches, i.e. the rule silently died. Which
// rules a user got therefore depended on WASM health.
//
// TODO: there is still no canonical shared list; this is a hand-kept mirror of
// the content-script one. Unifying the two (plus content-main's
// PROC_TOKEN_REGEX) into src/shared/ is open work — see REVIEW-2026-08 §5.20.
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
  'semantic',
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
// DNR priority bands. One scale is shared by static rules, dynamic user-filter
// rules and the runtime rules this worker writes, with ties broken by action
// precedence (allow > block > redirect) rather than by ruleset — so every
// producer has to agree on the numbers.
//
//   1..6      static + user filters (DNR_PRIORITY in scripts/build-rules.mjs
//             and compile_user_filters in wasm-core/src/lib.rs)
//   100       this worker's privacy/header rules (§5.31)
//   1000/1100 hand-maintained system-unbreak allows/blocks
//   100000    the user allowlist (§4.5)
// ---------------------------------------------------------------------------

/**
 * §4.2 — bands for the JS user-filter fallback compiler
 * (`parseSimpleNetworkRule`). These MUST equal `DNR_PRIORITY` in
 * scripts/build-rules.mjs: a user's plain block competes directly with a
 * list's plain allow, and any disagreement inverts the result across the seam.
 * The fallback expresses no `$important`, so only the two plain bands appear.
 */
const DNR_USER_FILTER_PRIORITY = {
  BLOCK: 1,
  ALLOW: 3,
};

/**
 * §4.5 — the user allowlist must outrank every shipped rule, including the
 * hand-maintained `system-unbreak` blocks at 1100. "Trust this site" that
 * loses to a shipped block is a control that silently does not work.
 */
const DNR_ALLOWLIST_PRIORITY = 100_000;

/**
 * §5.31 — privacy/header hardening sits in its own band above the static
 * range: a filter-list exception says "don't ad-block this site", not "stop
 * stripping Referer and spoofing my User-Agent here". Still below the
 * allowlist, which is the user's own explicit opt-out.
 */
const DNR_PRIVACY_PRIORITY = 100;

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
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch;
    } else if (ch === '[') {
      // Nested attribute selectors are invalid unless the inner bracket is quoted.
      if (bracketDepth > 0) return false;
      bracketDepth++;
    } else if (ch === ']') {
      if (bracketDepth === 0) return false;
      bracketDepth--;
    } else if (ch === '(') {
      parenDepth++;
    } else if (ch === ')') {
      if (parenDepth === 0) return false;
      parenDepth--;
    } else if (ch === '{' || ch === '}') {
      return false;
    }
  }

  return !quote && bracketDepth === 0 && parenDepth === 0;
}

function hasInvalidUniversalUsage(selector) {
  let bracketDepth = 0;
  let parenDepth = 0;
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
      if (bracketDepth < 0) return true;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      parenDepth--;
      if (parenDepth < 0) return true;
      continue;
    }

    if (ch === '*' && bracketDepth === 0 && parenDepth === 0) {
      // Universal selector (*) is invalid when preceded by alphanumeric/identifier chars
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

      // Validate what follows * — reject malformed selectors
      let next = null;
      for (let j = i + 1; j < selector.length; j++) {
        const nc = selector.charAt(j);
        if (!/\s/.test(nc)) {
          next = nc;
          break;
        }
      }
      if (next && !/[A-Za-z0-9#.\[:>+~,]/.test(next)) {
        return true;
      }
    }

    // Pseudo-element safety check
    if (ch === ':' && i + 1 < selector.length && selector.charAt(i + 1) === ':') {
      const pseudoRest = selector.slice(i);
      const knownPseudoElements = [
        '::before', '::after', '::first-line', '::first-letter',
        '::selection', '::backdrop', '::placeholder', '::marker',
        '::cue', '::slotted', '::part', '::file-selector-button',
      ];
      if (!knownPseudoElements.some(p => pseudoRest.startsWith(p))) {
        return true; // Unknown pseudo-element — potential bypass
      }
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
  // §5.3 — which lists actually refreshed, so CHECK_FILTER_UPDATES can name
  // them instead of claiming a blanket success.
  const updatedLists = [];

  for (const list of REMOTE_FILTER_LISTS) {
    try {
      log(`[AdBlock] Fetching ${list.id} source bundle...`);
      const text = await fetchAndExpand(list.url);
      const parsed = parseFilterList(text);
      const sourceBundle = wasmReady
        ? parse_filter_source(text)
        : buildSourceBundleFromParsed(parsed);
      if (sourceBundle?.cosmetic) {
        sourceBundle.cosmetic.genericExcludedDomains = dedupeGeneratedDomains([
          ...(sourceBundle.cosmetic.genericExcludedDomains || []),
          ...(parsed.genericCosmeticExceptionDomains || []),
        ]);
      }
      sourceBundles[list.id] = sourceBundle;
      updatedLists.push(list.id);
      fetchedAny = true;
    } catch (err) {
      console.error(`[AdBlock] Failed to fetch ${list.id}:`, err.message);
    }
  }

  if (!fetchedAny) return { updated: false, updatedLists: [] };
  await db.putBulkFilterSources(sourceBundles);
  return { updated: true, updatedLists };
}

// §3.2 — the active-index rebuild is a destructive clear followed by a
// repopulation spanning five IndexedDB transactions and three storage writes.
// Nothing in the persisted state distinguishes "rebuilt" from "cleared and
// then killed": `hasFilterSources()` stays true (the sources store is not
// cleared), the OLD bloom filter survives, and RULE_DATA_VERSION hashes the
// bundled sources, not the DB contents — so startup sees a healthy index and
// every cosmetic/scriptlet lookup silently returns nothing.
//
// The marker closes that gap: it is written BEFORE the clear and removed only
// after the last write, so any interruption anywhere in between leaves proof
// behind for the next startup.
const RULE_INDEX_STATE_KEY = 'ruleIndexState';
const RULE_INDEX_BUILDING = 'building';

/** True when a previous rebuild started and never finished. */
async function isRuleIndexInterrupted() {
  const marker = await getStorage(RULE_INDEX_STATE_KEY).catch(() => null);
  return marker?.state === RULE_INDEX_BUILDING;
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
  const genericCosmeticExcludedDomains = collectGenericCosmeticExcludedDomains([
    CORE_FILTER_SOURCE,
    ...activeSources,
  ]);

  let compiled = null;
  if (wasmReady) {
    try {
      compiled = compile_active_filter_index(CORE_FILTER_SOURCE, activeSources, 100);
    } catch (err) {
      console.error('[Nullify] WASM active index compilation failed:', err);
    }
  }

  const merged = compiled || mergeFilterSources(activeSources);
  cachedGenericCosmeticExcludedDomains = genericCosmeticExcludedDomains;

  // §3.2 — mark the index dirty BEFORE the destructive clear. Everything from
  // here to the marker removal below is the window in which an SW kill, a
  // browser quit or a putBulk* quota rejection leaves an empty index behind.
  await setStorage(RULE_INDEX_STATE_KEY, {
    state: RULE_INDEX_BUILDING,
    version: activeRuleDataVersion || null,
  });

  await db.clearActiveRules();

  const bloomHosts = Array.isArray(compiled?.bloomHosts)
    ? compiled.bloomHosts
    : [
        ...Object.keys(merged.cosmetic.domainSpecific || {}),
        ...merged.scriptlets.flatMap((rule) => rule.domains || []),
        '',
      ];
  const totalDomains = Math.max(bloomHosts.length, 1);
  const newBloom = wasmReady
    ? new WasmBloom(totalDomains * CONFIG.BLOOM_BITS_PER_ITEM, 4)
    : BloomFilter.forCapacity(totalDomains);

  await db.putBulkCosmeticRules(merged.cosmetic.domainSpecific || {});

  await db.putBulkScriptletRules(merged.scriptlets);
  for (const hostname of bloomHosts) {
    newBloom.add(hostname || '');
  }

  bloom = newBloom;

  // Bloom filter fill-ratio monitoring — rebuild with larger size if saturated
  if (wasmReady && typeof bloom.fill_ratio === 'function') {
    const ratio = bloom.fill_ratio();
    if (ratio > CONFIG.BLOOM_FILL_THRESHOLD) {
      console.warn(`[Nullify] Bloom filter saturated (fill ratio: ${ratio.toFixed(2)}). Rebuilding with 2x capacity...`);
      const largerBloom = new WasmBloom(totalDomains * 20, 4);
      for (const hostname of bloomHosts) {
        largerBloom.add(hostname || '');
      }
      bloom = largerBloom;
      log(`[Nullify] Bloom filter rebuilt. New fill ratio: ${bloom.fill_ratio().toFixed(2)}`);
    }
  }

  let bloomData;
  if (wasmReady) {
    try {
      bloomData = bloom.serialize_to_json();
    } catch (err) {
      console.error('[Nullify] WASM bloom serialize failed:', err);
      bloomData = bloom.serialize(); // Fallback to JS serialization
    }
  } else {
    bloomData = bloom.serialize();
  }
  await setStorage(StorageKeys.BLOOM_FILTER, bloomData);

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
    setStorage(StorageKeys.GENERIC_COSMETIC_EXCLUDED_DOMAINS, cachedGenericCosmeticExcludedDomains),
  ]);

  domainRulesCache.clear();
  _inFlightRules.clear();
  await db.clearPageBundles();

  // §3.2 — last statement: the index is now fully repopulated, so clear the
  // dirty marker. A rebuild that throws leaves it set on purpose, and the next
  // startup repairs the index.
  await setStorage(RULE_INDEX_STATE_KEY, null);
  return true;
}

// All active-index rebuilds are serialized through one in-flight chain (§5.3):
// concurrent rebuilds interleave their clear/repopulate phases, and a page
// bundle computed against half-cleared stores must not be persisted — the
// rebuild's final clearPageBundles() may already have run, and the version
// check would then accept the poisoned record indefinitely. The depth counter
// goes up at enqueue time so lookups started before the rebuild also skip
// persistence.
let _activeIndexRebuildChain = Promise.resolve();
let _activeIndexRebuildDepth = 0;
// §5.4 — monotonic counter bumped when a rebuild is queued AND when it
// releases. Any lookup that spans a rebuild boundary sees a different value at
// persist time than it captured at lookup start, which is what the live
// in-flight check could not detect: a lookup that *started* before the rebuild
// and *resolved* after it was computed against pre-clear state.
let _activeIndexRebuildGeneration = 0;

function isActiveIndexRebuildInFlight() {
  return _activeIndexRebuildDepth > 0;
}

function currentRebuildGeneration() {
  return _activeIndexRebuildGeneration;
}

function queueActiveIndexRebuild() {
  _activeIndexRebuildDepth++;
  _activeIndexRebuildGeneration++;

  let released = false;
  let stallTimer = null;
  const release = () => {
    if (released) return;
    released = true;
    if (stallTimer !== null) { clearTimeout(stallTimer); stallTimer = null; }
    _activeIndexRebuildDepth--;
    _activeIndexRebuildGeneration++;
  };

  const run = _activeIndexRebuildChain
    .catch(() => {})
    .then(() => rebuildActiveRuleIndexFromStoredSources())
    .finally(release);

  // §5.4 — the depth counter was decremented only in `.finally()`, so a
  // rebuild that never settles (a hung IndexedDB transaction) pinned it above
  // zero forever: page-bundle persistence stayed disabled and every future
  // queued rebuild sat behind a chain link that never resolved. Time-box it.
  const unstick = new Promise((resolve) => {
    stallTimer = setTimeout(() => {
      stallTimer = null;
      reportError(
        'activeIndexRebuild:stalled',
        new Error(`active index rebuild exceeded ${CONFIG.ACTIVE_INDEX_REBUILD_STALL_MS}ms`)
      );
      release();
      resolve();
    }, CONFIG.ACTIVE_INDEX_REBUILD_STALL_MS);
    // Node (test harness) only: a pending stall timer must not hold the
    // process open. `unref` does not exist on Chrome's numeric timer ids.
    stallTimer?.unref?.();
  });

  // The chain advances on whichever comes first, so a stuck rebuild cannot
  // block the queue permanently either.
  _activeIndexRebuildChain = Promise.race([run.catch(() => {}), unstick]);
  return run;
}

async function ensureFilterSourcesReady() {
  if (await db.hasFilterSources()) return true;

  const packaged = await loadPackagedFilterSources();
  if (packaged && Object.keys(packaged).length > 0) {
    await db.putBulkFilterSources(packaged);
    return true;
  }

  return (await fetchAndStoreRemoteFilterSources()).updated;
}

async function ensureRuleDataReady() {
  const existingBloom = await getStorage(StorageKeys.BLOOM_FILTER);
  const storedRuleDataVersion = await getStorage(StorageKeys.RULE_DATA_VERSION);
  const bundledRuleDataVersion = await computeBundledRuleDataVersion().catch(() => null);
  activeRuleDataVersion = bundledRuleDataVersion || storedRuleDataVersion || null;
  const hadSources = await db.hasFilterSources();
  let sourcesReady = hadSources;

  const ruleDataChanged = !!bundledRuleDataVersion && storedRuleDataVersion !== bundledRuleDataVersion;
  // §3.2 — a surviving "building" marker means the last rebuild was cut short,
  // so the index stores are (partly) empty even though the bloom filter and
  // the version both look current. Treat it exactly like a rule-data change
  // for the rebuild decision. It deliberately does NOT re-seed the packaged
  // sources: those are intact, and overwriting them would roll back a remote
  // list refresh that had already landed.
  const indexInterrupted = await isRuleIndexInterrupted();

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
    if (!existingBloom || !hadSources || ruleDataChanged || indexInterrupted) {
      if (indexInterrupted) {
        reportError(
          'ruleIndex:interruptedRebuild',
          new Error('previous active-index rebuild did not complete; rebuilding')
        );
      }
      await queueActiveIndexRebuild();
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
    const removeErr = chrome.runtime.lastError;
    if (removeErr && !/No matching/i.test(removeErr.message || '')) {
      reportError('contextMenus:removeAll', new Error(removeErr.message));
    }
    chrome.contextMenus.create({
      id: 'nullify-block-element',
      title: 'Block element...',
      contexts: ['all'],
    }, () => {
      const createErr = chrome.runtime.lastError;
      if (!createErr) return;
      // Duplicate-id can happen if a prior removeAll silently failed. Try once
      // more after an explicit remove of the known id.
      if (/duplicate/i.test(createErr.message || '')) {
        chrome.contextMenus.remove('nullify-block-element', () => {
          void chrome.runtime.lastError;
          chrome.contextMenus.create({
            id: 'nullify-block-element',
            title: 'Block element...',
            contexts: ['all'],
          }, () => {
            const retryErr = chrome.runtime.lastError;
            if (retryErr) reportError('contextMenus:create:retry', new Error(retryErr.message));
          });
        });
      } else {
        reportError('contextMenus:create', new Error(createErr.message));
      }
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
      ensureStatsRestored(),
    ]);
    await ensureBackgroundSetup();
    await refreshAllBadges();
  } catch (err) {
    reportError('onInstalled handler', err, { fatal: true });
  }
});

// ---- Startup Orchestration (Speed Optimized) ----
let _criticalReady = false;
let _criticalPromise = null;
let _backgroundSetupPromise = null;

function ensureBackgroundSetup() {
  if (_backgroundSetupPromise) return _backgroundSetupPromise;

  _backgroundSetupPromise = (async () => {
    // Load user config overrides before any other initialization
    await loadConfig();
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
    reportError('Background setup', err, { fatal: true });
  });

  return _backgroundSetupPromise;
}

function startInitialization() {
  if (_criticalPromise) return _criticalPromise;

  _criticalPromise = (async () => {
    // Stage 0: Initialize WASM
    try {
      wasmReadyPromise = initWasmFromRuntimeAsset(init, 'nullify_core_bg.wasm');
      await wasmReadyPromise;
      wasmReady = true;

      // Initialize tracker detector using string-based interface
      trackerMatcher = new KeywordMatcher(trackerKeywordsCsv);
      // Pre-build stateful objects — these never need rebuilding unless data changes.
      urlSanitizer = new UrlSanitizer(trackerKeywordsCsv);
      rebuildAllowlistMatcher();

      log('[Nullify] WASM Core initialized');
    } catch (err) {
      reportError('WASM initialization', err, { fatal: true });
      // Continue without WASM — JS fallbacks will be used
    }

    // Stage 1: Ensure the active rule index exists and is list-aware.
    await ensureRuleDataReady();

    // Stage 2: Critical data for responding to content scripts
    await Promise.all([
      loadBloomFilter(),
      refreshMemoryCache(),
      ensureStatsRestored(),
    ]);
    _criticalReady = true;
    refreshAllBadges().catch(err => console.error('[Nullify] Badge refresh failed:', err));

    // Stage 3: Background tasks (non-blocking for messages)
    ensureBackgroundSetup().catch(err => console.error('[Nullify] Background startup failed:', err));

  })().catch((err) => {
    reportError('Critical startup', err, { fatal: true });
  });

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

// All allowlist mutations are serialized through one in-flight promise chain
// (the youtube-shield-sync.js pattern). Two overlapping rebuilds otherwise
// both snapshot getDynamicRules() before either writes, and the second batch
// reuses the same DNR_ALLOWLIST_START ids → Chrome rejects it (§4.7).
let _allowlistOpChain = Promise.resolve();

function enqueueAllowlistOp(op) {
  const run = _allowlistOpChain.catch(() => {}).then(op);
  _allowlistOpChain = run.catch(() => {});
  return run;
}

/**
 * Rebuild allowlist state atomically — ensures DNR rules, matcher, and
 * dependent caches stay in sync. Internal: callers must go through
 * rebuildAllowlistState (or another enqueueAllowlistOp op) so rebuilds
 * never overlap.
 */
async function _rebuildAllowlistStateNow(allowlist) {
  // §4.8 choke point: nothing that fails write-side validation may ever be
  // stored or become a DNR allowAllRequests rule — even via legacy persisted
  // state or a code path that skipped partitionAllowlistInput.
  const normalizedAllowlist = partitionAllowlistInput(allowlist).valid;
  cachedAllowlist = new Set(normalizedAllowlist);
  await setStorage(StorageKeys.ALLOWLIST, normalizedAllowlist);
  await rebuildAllowlistRules(normalizedAllowlist);
  rebuildAllowlistMatcher();
  // Dependent caches must be cleared AFTER DNR rules are updated
  domainRulesCache.clear();
  await syncYouTubeShieldRegistration();
}

/** Serialized entry point for full allowlist state rebuilds. */
function rebuildAllowlistState(normalizedAllowlist) {
  return enqueueAllowlistOp(() => _rebuildAllowlistStateNow(normalizedAllowlist));
}

// YouTube shield sync is implemented in ./youtube-shield-sync.js. The factory
// is instantiated lazily on first call so isHostnameAllowedCached and
// runtimeAssetPath are guaranteed to exist as module-level fns by then.

async function refreshMemoryCache() {
  const data = await getStorageBulk([
    StorageKeys.SETTINGS,
    StorageKeys.ALLOWLIST,
    StorageKeys.GENERIC_CSS,
    StorageKeys.GENERIC_PROCEDURAL_RULES,
    StorageKeys.GENERIC_COSMETIC_EXCLUDED_DOMAINS,
  ]);

  cachedSettings = data[StorageKeys.SETTINGS];
  const rawAllowlist = data[StorageKeys.ALLOWLIST] || [];
  // §4.8: validation applies to stored state too — a legacy allowlist entry
  // like `co.uk` (persisted before write-side validation existed) must be
  // scrubbed on startup, not resurrected into a TLD-wide DNR allow rule.
  const normalizedAllowlist = partitionAllowlistInput(rawAllowlist).valid;
  cachedAllowlist = new Set(normalizedAllowlist);
  let allowlistStateRebuilt = false;

  const needsNormalization =
    rawAllowlist.length !== normalizedAllowlist.length ||
    rawAllowlist.some((domain, index) => domain !== normalizedAllowlist[index]);

  // Reconcile the DNR allow rules against the stored allowlist UNCONDITIONALLY
  // on startup (§4.7): a previous rebuildAllowlistState could have persisted
  // the storage write and then died (SW kill / updateDynamicRules throw)
  // before the allowAllRequests rules landed. The stored list is already
  // normalized in that case, so a normalization-only check never repairs it.
  const existingDynamicRules = await chrome.declarativeNetRequest
    .getDynamicRules()
    .catch(() => null);
  const dnrAllowRuleCount = Array.isArray(existingDynamicRules)
    ? existingDynamicRules.filter((rule) => rule.id >= DNR_ALLOWLIST_START).length
    : normalizedAllowlist.length; // read failed — assume in sync, don't churn

  // Sync DNR state BEFORE rebuilding the in-memory matcher.
  // If we rebuilt the matcher first, content scripts could observe one
  // allowlist state while DNR still enforced the previous one.
  if (needsNormalization || dnrAllowRuleCount !== normalizedAllowlist.length) {
    await rebuildAllowlistState(normalizedAllowlist);
    allowlistStateRebuilt = true;
  } else {
    // Ensure matcher is built even if no change
    rebuildAllowlistMatcher();
  }

  const genericCss = data[StorageKeys.GENERIC_CSS];
  if (typeof genericCss === 'string' && genericCss.length > 0) {
    cachedGenericCss = genericCss;
  } else {
    cachedGenericCss = null;
  }
  cachedGenericProceduralRules = Array.isArray(data[StorageKeys.GENERIC_PROCEDURAL_RULES])
    ? data[StorageKeys.GENERIC_PROCEDURAL_RULES]
    : [];
  cachedGenericCosmeticExcludedDomains = Array.isArray(data[StorageKeys.GENERIC_COSMETIC_EXCLUDED_DOMAINS])
    ? data[StorageKeys.GENERIC_COSMETIC_EXCLUDED_DOMAINS]
    : [];

  domainRulesCache.clear();
  if (!allowlistStateRebuilt) {
    await syncYouTubeShieldRegistration();
  }
}

/**
 * True when the filter matches nothing at all.
 *
 * Both deserializers now degrade to an EMPTY filter rather than throwing when
 * a stored payload fails validation — `BloomFilter.deserialize` on an unknown
 * `format` tag, and (since the wasm-core parity pass) `deserialize_from_json`
 * on a payload with no `format` tag, which is exactly the shape every
 * wasm-produced legacy blob has. Degrading is the right call; silently
 * *continuing* with the result is not, and neither deserializer can tell the
 * caller which happened.
 *
 * Engine-agnostic: WASM filters expose `fill_ratio()`, the JS class exposes
 * its bitset. Bails out at the first set bit, so the populated case is O(1)
 * and only the (about-to-be-rebuilt) empty case walks the whole bitset.
 */
function isBloomEmpty(filter) {
  if (!filter) return true;
  if (typeof filter.fill_ratio === 'function') {
    try {
      return filter.fill_ratio() === 0;
    } catch {
      return false; // can't tell — don't force a rebuild on a guess
    }
  }
  const bits = filter.bitset;
  if (!bits || typeof bits.length !== 'number') return false;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== 0) return false;
  }
  return true;
}

/**
 * §3.2, second door — a bloom that loads empty while the filter sources are
 * populated is a dead index, and nothing else notices.
 *
 * `ensureRuleDataReady` decides whether to rebuild from what is *in storage*
 * (a bloom key exists, the version matches, no interrupt marker), so a stored
 * payload that deserializes to nothing sails through it. `checkBloomFillRatio`
 * only fires above the saturation threshold, and an empty filter's ratio is 0.
 * The result is that `bloom.has(d)` returns false for every domain: every
 * domain-specific cosmetic and every scriptlet is dead until some unrelated
 * change happens to trigger a rebuild — up to 24 hours, and silently.
 */
async function ensureLoadedBloomUsable() {
  if (!isBloomEmpty(bloom)) return false;

  let hasSources = false;
  try {
    hasSources = await db.hasFilterSources();
  } catch {
    return false;
  }
  if (!hasSources) return false; // genuinely nothing indexed yet — not a fault

  reportError(
    'bloom:emptyWithSources',
    new Error('stored bloom filter deserialized to an empty filter while filter sources are populated; rebuilding index')
  );
  try {
    await queueActiveIndexRebuild();
  } catch (err) {
    reportError('bloom:emptyWithSources:rebuild', err, { fatal: true });
  }
  return true;
}

async function loadBloomFilter() {
  const data = await getStorage(StorageKeys.BLOOM_FILTER);
  if (data) {
    try {
      if (typeof data === 'string') {
        if (wasmReady) {
          bloom = WasmBloom.deserialize_from_json(data);
          checkBloomFillRatio(bloom);
        } else {
          if (await db.hasFilterSources()) {
            await queueActiveIndexRebuild();
          } else {
            await ingestLegacyRules();
          }
          return;
        }
      } else if (wasmReady) {
        // Data is a raw object, but WASM needs a JSON string
        bloom = WasmBloom.deserialize_from_json(JSON.stringify(data));
        checkBloomFillRatio(bloom);
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

  await ensureLoadedBloomUsable();
}

function checkBloomFillRatio(bloomFilter) {
  if (!wasmReady || typeof bloomFilter.fill_ratio !== 'function') return;
  const ratio = bloomFilter.fill_ratio();
  // Use WASM fill_threshold if available, otherwise fall back to CONFIG
  const threshold = (typeof WasmBloomClass.fill_threshold === 'function')
    ? WasmBloomClass.fill_threshold()
    : CONFIG.BLOOM_FILL_THRESHOLD;
  if (ratio > threshold) {
    console.warn(`[Nullify] Loaded Bloom filter is saturated (fill ratio: ${ratio.toFixed(2)}). Schedule rebuild...`);
    queueActiveIndexRebuild().catch(err => {
      console.error('[Nullify] Bloom filter rebuild failed:', err);
    });
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

    log(`[AdBlock] Indexing ${cosData.generic?.length || 0} generic and ${Object.keys(cosData.domainSpecific || {}).length} domain-specific cosmetic rules...`);
    
    // Wipe and rebuild index
    await db.clear();

    // Size the Bloom Filter for actual domain count (CONFIG.BLOOM_BITS_PER_ITEM bits/item → ~1% FP rate)
    const domainSpecificRules = foldDomainExceptionsIntoRules(
      cosData.domainSpecific || {},
      cosData.exceptions || {}
    );

    const domainCount = Object.keys(domainSpecificRules).length +
      (scriptData || []).reduce((n, r) => n + (r.domains?.length || 0), 0) + 1; // +1 for generic ''

    const newBloom = wasmReady
      ? new WasmBloom(domainCount * CONFIG.BLOOM_BITS_PER_ITEM, 4)
      : BloomFilter.forCapacity(domainCount);

    if (Object.keys(domainSpecificRules).length > 0) {
      await db.putBulkCosmeticRules(domainSpecificRules);
      for (const hostname of Object.keys(domainSpecificRules)) {
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
    cachedGenericCosmeticExcludedDomains = dedupeGeneratedDomains(cosData.genericExcludedDomains);
    await Promise.all([
      setStorage(StorageKeys.GENERIC_CSS, cachedGenericCss || ''),
      setStorage(StorageKeys.GENERIC_PROCEDURAL_RULES, cachedGenericProceduralRules),
      setStorage(StorageKeys.GENERIC_COSMETIC_EXCLUDED_DOMAINS, cachedGenericCosmeticExcludedDomains),
    ]);

    await setStorage(StorageKeys.COSMETIC_RULES_VERSION, Date.now());
    log('[AdBlock] Rule indexing and Bloom Filter build complete');
  } catch (err) {
    console.error('[AdBlock] Failed to ingest rules:', err);
  }
}

// ---------------------------------------------------------------------------
// Context Menu — Quick Access to Picker
// ---------------------------------------------------------------------------

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'nullify-block-element' && tab?.id) {
    // §4.24 — `{frameId: 0}` is mandatory. The content script runs in ALL
    // frames, so an unaddressed sendMessage reaches every iframe on the page
    // and each one builds its own full-viewport capture-phase overlay. `keydown`
    // does not cross frame boundaries, so ESC dismisses only the focused frame's
    // and the rest persist for the life of the page, swallowing every click in
    // their region. The picker belongs to the top frame only.
    chrome.tabs.sendMessage(tab.id, { type: 'ACTIVATE_PICKER' }, { frameId: 0 }).catch(() => {
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

  log('[AdBlock] Defaults initialized');
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
  await applyStealthRules();

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
      priority: DNR_PRIVACY_PRIORITY,
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
      priority: DNR_PRIVACY_PRIORITY,
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
async function applyStealthRules() {
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
    priority: DNR_PRIVACY_PRIORITY,
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
    priority: DNR_PRIVACY_PRIORITY,
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
    priority: DNR_PRIVACY_PRIORITY,
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
    priority: DNR_PRIVACY_PRIORITY,
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
  // Only create the alarms when absent (§4.5). ensureBackgroundSetup runs on
  // every SW start; a clear+create here pushed the 24h filter alarm out by
  // another 24h on each wake, so with the 30-minute stats alarm guaranteeing
  // regular wakes it could never fire.
  if (!(await chrome.alarms.get(ALARM_FILTER_UPDATE))) {
    // Derive the initial delay from the last successful check so a user whose
    // alarm was lost (e.g. by the pre-fix clear) catches up instead of
    // waiting another full interval.
    const lastCheck = await getStorage(StorageKeys.LAST_UPDATE_CHECK);
    let delayInMinutes = CONFIG.FILTER_UPDATE_INTERVAL_MINUTES;
    if (typeof lastCheck === 'number' && lastCheck > 0 && lastCheck <= Date.now()) {
      const elapsedMinutes = (Date.now() - lastCheck) / 60000;
      delayInMinutes = Math.max(1, CONFIG.FILTER_UPDATE_INTERVAL_MINUTES - elapsedMinutes);
    }
    chrome.alarms.create(ALARM_FILTER_UPDATE, {
      delayInMinutes,
      periodInMinutes: CONFIG.FILTER_UPDATE_INTERVAL_MINUTES,
    });
  }

  if (!(await chrome.alarms.get(ALARM_STATS_CLEANUP))) {
    chrome.alarms.create(ALARM_STATS_CLEANUP, {
      delayInMinutes: STATS_CLEANUP_INTERVAL_MINUTES,
      periodInMinutes: STATS_CLEANUP_INTERVAL_MINUTES,
    });
  }
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

/**
 * Refresh every remote filter list and rebuild the active index.
 *
 * §5.3 — returns a status the caller can render honestly:
 *   `{ok: true,  updatedLists: [...]}`  — at least one list refreshed
 *   `{ok: false, error, updatedLists: []}` — nothing refreshed (offline), or a
 *                                            check was already running.
 * `{ok:true}` on total failure told the options page "done", and the page then
 * read a LAST_UPDATE_CHECK that was never written.
 */
async function checkFilterListUpdates() {
  if (_filterUpdateInProgress) {
    log('[AdBlock] Filter update already in progress, skipping.');
    return {
      ok: false,
      error: 'A filter list update is already in progress',
      inProgress: true,
      updatedLists: [],
    };
  }
  _filterUpdateInProgress = true;

  try {
    log('[AdBlock] Refreshing per-list cosmetic/scriptlet sources...');
    const { updated, updatedLists } = await fetchAndStoreRemoteFilterSources();
    if (!updated) {
      console.warn('[AdBlock] No filter sources were refreshed');
      return {
        ok: false,
        error: 'No filter lists could be downloaded — check your connection',
        updatedLists: [],
      };
    }

    await queueActiveIndexRebuild();
    const checkedAt = Date.now();
    await setStorage(StorageKeys.LAST_UPDATE_CHECK, checkedAt);
    log('[AdBlock] Filter source update complete');
    return { ok: true, updatedLists, lastUpdateCheck: checkedAt };
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

// In-flight counters are mirrored to chrome.storage.session on every change
// (§5.9): the 1.5s local-storage debounce means an SW kill inside the window
// silently drops those counts. storage.session survives SW kills but not a
// browser restart — exactly the lifetime the in-flight snapshot needs.
const SESSION_STATS_KEY = 'nullify:inFlightStats';

function snapshotStatsForSession() {
  const obj = {};
  for (const [tabId, stats] of tabStats) {
    obj[tabId] = stats;
  }
  return {
    tabStats: obj,
    totalBlockedToday,
    totalBlockedDate,
  };
}

function mirrorStatsToSession() {
  // §4.14 — mirroring memory that predates the restore writes zeros over the
  // very snapshot the restore prefers. Defer instead of dropping: the restore
  // never clobbers counters already in memory, so replaying afterwards is
  // both safe and lossless.
  if (!_statsRestoreDone) {
    ensureStatsRestored().then(mirrorStatsToSession, () => { });
    return;
  }
  try {
    chrome.storage.session
      ?.set({ [SESSION_STATS_KEY]: snapshotStatsForSession() })
      ?.catch?.(() => { });
  } catch { /* storage.session unavailable — nothing to mirror to */ }
}

async function readSessionStatsSnapshot() {
  try {
    const data = await chrome.storage.session?.get(SESSION_STATS_KEY);
    const snapshot = data?.[SESSION_STATS_KEY];
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch {
    return null;
  }
}

// §4.14 — `tabs.onRemoved` (and CONTENT_BLOCKED, and resetTabStats) wake a
// terminated worker and reach the persist path while `tabStats` is still
// empty, overwriting the stored counters AND the session mirror with zeros.
// The restore depends on nothing but chrome.storage, so it does not belong
// behind WASM init and the rule index in stage 2 of `_criticalPromise`: it
// gets its own promise, started at module load, and every writer waits on it.
let _statsRestorePromise = null;
let _statsRestoreDone = false;

function ensureStatsRestored() {
  if (!_statsRestorePromise) {
    _statsRestorePromise = restorePersistedStats().catch((err) => {
      // A failed restore must not wedge the writers forever — report it and
      // let persistence resume against whatever is in memory.
      reportError('restorePersistedStats', err);
      _statsRestoreDone = true;
    });
  }
  return _statsRestorePromise;
}

async function restorePersistedStats() {
  const data = await getStorageBulk([
    StorageKeys.TAB_STATS,
    StorageKeys.TOTAL_BLOCKED_TODAY,
    StorageKeys.TOTAL_BLOCKED_DATE,
  ]);
  // The session mirror is newer than the debounced local copy whenever both
  // exist (it is written on every increment) — its entries win per tab, but
  // local-only tabs are kept: an early resetTabStats in this SW life may
  // have overwritten the mirror before this restore ran.
  const sessionSnapshot = await readSessionStatsSnapshot();

  const localStats = data[StorageKeys.TAB_STATS];
  const storedStats = {
    ...(localStats && typeof localStats === 'object' ? localStats : {}),
    ...(sessionSnapshot?.tabStats && typeof sessionSnapshot.tabStats === 'object'
      ? sessionSnapshot.tabStats
      : {}),
  };
  if (storedStats && typeof storedStats === 'object') {
    for (const [key, val] of Object.entries(storedStats)) {
      const tabId = Number(key);
      if (!Number.isInteger(tabId) || tabId < 0) continue;
      // Never clobber a tabId already tracked in memory (§5.2): the
      // navigation that woke this SW may have already reset that tab's
      // stats and counted new blocks before this restore ran.
      if (tabStats.has(tabId)) continue;
      tabStats.set(tabId, normalizeTabStatsEntry(val));
    }
  }

  const today = getCurrentDayStamp();
  const localTotal = data[StorageKeys.TOTAL_BLOCKED_DATE] === today
    ? Math.max(0, Number(data[StorageKeys.TOTAL_BLOCKED_TODAY]) || 0)
    : 0;
  const sessionTotal = sessionSnapshot?.totalBlockedDate === today
    ? Math.max(0, Number(sessionSnapshot?.totalBlockedToday) || 0)
    : 0;
  totalBlockedDate = today;
  // max() keeps the restore idempotent (it runs from both onInstalled and
  // startInitialization) and preserves any increments counted before it ran.
  totalBlockedToday = Math.max(totalBlockedToday, localTotal, sessionTotal);

  // Set BEFORE the write-back below: persistTabStats waits on the restore, and
  // the restore's own write must not wait on itself.
  _statsRestoreDone = true;

  if (
    data[StorageKeys.TOTAL_BLOCKED_DATE] !== totalBlockedDate ||
    data[StorageKeys.TOTAL_BLOCKED_TODAY] !== totalBlockedToday
  ) {
    await persistTabStats();
  }
}

// Kick the restore off at module load — before any listener can fire.
ensureStatsRestored();

let _persistTimeout = null;
function schedulePersistTabStats() {
  // The session mirror is written immediately — an SW kill before the
  // debounced local write then loses nothing (§5.9).
  mirrorStatsToSession();
  if (_persistTimeout) clearTimeout(_persistTimeout);
  _persistTimeout = setTimeout(() => {
    persistTabStats();
    _persistTimeout = null;
  }, 1500);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
  // Delete again after the restore: closing a tab is one of the events that
  // wakes a terminated worker, and the restore would otherwise resurrect the
  // closed tab's entry from storage before the write-back (§4.14).
  ensureStatsRestored()
    .then(() => {
      tabStats.delete(tabId);
      return persistTabStats();
    })
    .catch(() => { });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && !tabStats.has(tabId)) {
    resetTabStats(tabId, changeInfo.url || tab?.url || '');
  }
});

// §4.25 — `onRuleMatchedDebug` (and the declarativeNetRequestFeedback
// permission) only function in unpacked/developer-mode installs. In the packed
// CRX the event object is undefined, no listener registers, and every
// network-side counter (tabStats.blocked, trackers, badge, logger network
// events) silently stays at 0. Feature-detect once and expose the result via
// GET_INIT_DATA / GET_TAB_STATS / GET_DAILY_BLOCKED_TOTAL as
// `networkStatsAvailable`, so the UI can label the counters honestly
// ("requires developer mode") instead of showing a misleading zero.
const networkStatsAvailable =
  typeof chrome.declarativeNetRequest?.onRuleMatchedDebug?.addListener === 'function';

if (networkStatsAvailable) chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
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
  // §4.14 — never write a snapshot of memory that predates the restore.
  if (!_statsRestoreDone) await ensureStatsRestored();
  const snapshot = snapshotStatsForSession();
  mirrorStatsToSession();
  await Promise.all([
    setStorage(StorageKeys.TAB_STATS, snapshot.tabStats),
    setStorage(StorageKeys.TOTAL_BLOCKED_TODAY, snapshot.totalBlockedToday),
    setStorage(StorageKeys.TOTAL_BLOCKED_DATE, snapshot.totalBlockedDate),
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

// User-filter mutations are serialized through one in-flight promise chain
// (§4.6): two overlapping applyUserFilters runs both snapshot
// getDynamicRules() before either writes, so the second one's addRules reuses
// ids the first just claimed and Chrome rejects the batch.
let _userFilterOpChain = Promise.resolve();

function enqueueUserFilterOp(op) {
  const run = _userFilterOpChain.catch(() => {}).then(op);
  _userFilterOpChain = run.catch(() => {});
  return run;
}

// Test-only seam (see tests/sw-harness): lets the harness simulate "WASM
// compiled successfully and produced zero rules" — unreachable otherwise in
// Node, where the WASM module never initializes. Never set in production.
let _compileUserFiltersOverride = null;

/**
 * Compile user filters via the WASM compiler. Returns the compiled bundle, or
 * `null` when WASM is unavailable or threw — the ONLY cases in which the JS
 * fallback may run (§5.14). "WASM succeeded with zero rules" is a legitimate
 * outcome (e.g. the critical-path guard deliberately dropped every line) and
 * must not be resurrected by the less careful JS parser.
 */
function compileUserFiltersViaWasm(filtersText) {
  const compileFn = _compileUserFiltersOverride || (wasmReady ? compile_user_filters : null);
  if (!compileFn) return null;
  try {
    return compileFn(filtersText || '', DNR_USER_RULES_START) || null;
  } catch (err) {
    console.error('[Nullify] WASM user filter compilation failed:', err);
    return null;
  }
}

/**
 * Apply user-defined filters as dynamic DNR rules + cosmetic rules.
 * Internal: callers go through applyUserFilters / setAndApplyUserFilters /
 * appendUserFilterLine so runs never overlap.
 *
 * Returns `{network, cosmetic}` counts on success, or `{error}` when the DNR
 * write failed — in which case USER_FILTERS_APPLIED is NOT updated, so the
 * next startup retries the apply instead of skipping it forever (§4.6).
 */
async function _applyUserFiltersNow(filtersText) {
  const lines = (filtersText || '').split('\n').filter(Boolean);
  let newRules = [];
  let cosmeticRules = { generic: [], domainSpecific: {}, exceptions: [] };
  let userScriptlets = [];

  const compiled = compileUserFiltersViaWasm(filtersText);
  const wasmSucceeded = compiled !== null;
  if (wasmSucceeded) {
    newRules = compiled.dnrRules || [];
    cosmeticRules = compiled.cosmeticRules || cosmeticRules;
    userScriptlets = compiled.scriptletRules || [];
  } else if (lines.length > 0) {
    // JS fallback — only on actual WASM failure/unavailability (§5.14).
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

  // §4.16 — bound the batch BEFORE any DNR round-trip. A 2 MB paste (under the
  // text cap) compiles to ~150k rules; unbounded, that is 150k sequential
  // `updateDynamicRules` calls with the op chain held, and the worker is killed
  // long before it converges — then the next wake re-enters the same loop.
  // Ids are checked here too: `compile_user_filters` numbers from
  // DNR_USER_RULES_START with no ceiling, so past ~90k rules the ids cross into
  // the allowlist range, where the user-filter cleanup can no longer reclaim
  // them and `rebuildAllowlistRules` will happily delete them.
  const budgeted = [];
  let overBudgetCount = 0;
  let outOfRangeCount = 0;
  for (const rule of newRules) {
    if (!Number.isInteger(rule?.id) ||
        rule.id < DNR_USER_RULES_START ||
        rule.id >= DNR_ALLOWLIST_START) {
      outOfRangeCount++;
      continue;
    }
    if (budgeted.length >= MAX_USER_FILTERS_DNR_RULES) {
      overBudgetCount++;
      continue;
    }
    budgeted.push(rule);
  }

  // §4.15 — `updateDynamicRules` is all-or-nothing, so one bad line (IDN
  // urlFilter, non-RE2 regex) used to zero out the ENTIRE user ruleset.
  // Pre-validate what we can, then add in chunks and retry per-rule so a
  // rejection only drops the offending rule.
  const { vetted, skipped } = await preflightUserDnrRules(budgeted);
  if (outOfRangeCount > 0) {
    skipped.push({
      id: null,
      reason: `${outOfRangeCount} rule(s) outside the user id range [${DNR_USER_RULES_START}, ${DNR_ALLOWLIST_START})`,
    });
  }
  if (overBudgetCount > 0) {
    skipped.push({
      id: null,
      reason: `${overBudgetCount} rule(s) over the ${MAX_USER_FILTERS_DNR_RULES}-rule dynamic budget`,
    });
  }

  // Clear the existing user-range IDs first. If even the removal fails, old
  // rules stay active; report failure to the caller instead of recording
  // success — storage and DNR must not diverge silently.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: userRuleIds });
  } catch (err) {
    reportError('userFilters:updateDynamicRules', err);
    return { error: `Failed to apply user filters: ${err?.message || String(err)}` };
  }

  let appliedNetworkRules = 0;
  for (let i = 0; i < vetted.length; i += USER_RULE_ADD_CHUNK) {
    const chunk = vetted.slice(i, i + USER_RULE_ADD_CHUNK);
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: chunk });
      appliedNetworkRules += chunk.length;
    } catch (chunkErr) {
      // §4.16 — classify before retrying. "This rule is malformed" is worth
      // isolating rule-by-rule; "the dynamic ruleset is full" is not — every
      // subsequent call fails identically, so the per-rule retry degenerates
      // into 50 guaranteed failures per chunk and never converges. Stop.
      if (isDnrCapacityError(chunkErr)) {
        const remaining = vetted.length - i;
        skipped.push({
          id: chunk[0]?.id ?? null,
          reason: `dynamic rule capacity reached — ${remaining} rule(s) not applied: ${chunkErr?.message || String(chunkErr)}`,
        });
        break;
      }
      // Chunk rejected — isolate the offender(s) by retrying rule-by-rule.
      for (const rule of chunk) {
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
          appliedNetworkRules += 1;
        } catch (ruleErr) {
          if (isDnrCapacityError(ruleErr)) {
            const remaining = vetted.length - i - chunk.indexOf(rule);
            skipped.push({
              id: rule.id,
              reason: `dynamic rule capacity reached — ${remaining} rule(s) not applied: ${ruleErr?.message || String(ruleErr)}`,
            });
            i = vetted.length; // stop the outer loop too
            break;
          }
          skipped.push({ id: rule.id, reason: ruleErr?.message || String(ruleErr) });
        }
      }
    }
  }
  // Honest total: every compiled rule that is not live in DNR, whether it was
  // truncated, out of range, rejected by preflight or lost to a capacity stop.
  const skippedNetworkTotal = newRules.length - appliedNetworkRules;
  if (skippedNetworkTotal > 0) {
    reportError(
      'userFilters:skippedRules',
      new Error(`${skippedNetworkTotal} user filter rule(s) skipped: ${skipped
        .slice(0, 5).map((s) => `#${s.id} ${s.reason}`).join('; ')}`)
    );
  }

  if (!wasmSucceeded) {
    cosmeticRules = parseUserCosmeticRules(filtersText);
  } else if (
    (!cosmeticRules.generic?.length && !Object.keys(cosmeticRules.domainSpecific || {}).length &&
    !cosmeticRules.genericExceptions?.length && !Object.keys(cosmeticRules.domainExceptions || {}).length &&
    !userScriptlets.length && lines.length > 0)
  ) {
    cosmeticRules = parseUserCosmeticRules(filtersText);
  }

  await setStorage(StorageKeys.USER_COSMETIC_RULES, cosmeticRules);
  await setStorage(StorageKeys.USER_SCRIPTLET_RULES, userScriptlets);

  // CRITICAL: Clear memory caches so the next page load picks up the new rules immediately
  domainRulesCache.clear();
  _inFlightRules.clear();
  await db.clearPageBundles();

  // §4.15 — the marker is written LAST, after every piece of state it
  // certifies. It is the sole guard that lets startup skip the re-apply, so a
  // worker kill or a StorageQuotaError between the scriptlet store and here
  // must leave it unwritten: the user's new `##+js(...)` line would otherwise
  // be dead forever, and persisted page bundles would keep serving the
  // previous user cosmetic rules (their version key does not change on a
  // user-filter edit).
  await setStorage(StorageKeys.USER_FILTERS_APPLIED, filtersText || '');

  const totalDomainSpecificRules = Object.values(cosmeticRules.domainSpecific || {})
    .reduce((sum, rules) => sum + (rules?.length || 0), 0);

  const counts = {
    network: appliedNetworkRules,
    cosmetic: (cosmeticRules.generic?.length || 0) + totalDomainSpecificRules,
    // §4.15 — per-rule skip report so the UI can say "N lines were dropped"
    // instead of pretending everything applied. Capped: reasons are for
    // display, not a full audit log.
    // Counted as "compiled but not live", so truncation, id-range drops,
    // preflight rejections and capacity stops are all included.
    skippedNetwork: skippedNetworkTotal,
    skippedRules: skipped.slice(0, 20),
  };

  log(`[AdBlock] Applied user filters: ${counts.network} network, ${counts.cosmetic} cosmetic, ${counts.skippedNetwork} skipped`);
  return counts;
}

// §4.15 — chunk size for dynamic-rule adds. Small enough that a rejected
// chunk's per-rule retry is cheap, large enough to keep call count low for
// multi-thousand-rule user lists.
const USER_RULE_ADD_CHUNK = 50;

/**
 * §4.16 — is this `updateDynamicRules` rejection about capacity rather than
 * about one malformed rule?
 *
 * Chrome's wording for the dynamic-rule ceiling has changed across versions
 * ("exceeds the maximum number of dynamic rules", "rule count exceeded",
 * quota), so match the family loosely. Getting it wrong in the false-negative
 * direction only costs a per-rule retry pass; in the false-positive direction
 * it drops the tail of a legitimate batch, so keep the pattern anchored on
 * capacity words, never on the generic "invalid rule".
 */
function isDnrCapacityError(err) {
  const message = String(err?.message ?? err ?? '');
  return /quota|maximum number|rule count|too many rules|exceeds? the (maximum|limit)|MAX_NUMBER_OF/i
    .test(message);
}

function isAsciiOnly(str) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * §4.15 — validate compiled user DNR rules before handing them to Chrome.
 * Chrome requires `urlFilter` to be ASCII and `regexFilter` to be
 * RE2-compatible; the WASM compiler forwards patterns verbatim. Rules that
 * fail are returned in `skipped` (with a reason) instead of poisoning the
 * whole batch. `isRegexSupported` is feature-detected: where unavailable,
 * regex rules pass through and the chunked add isolates any rejection.
 */
async function preflightUserDnrRules(rules) {
  const vetted = [];
  const skipped = [];
  for (const rule of rules) {
    const condition = rule?.condition || {};
    if (typeof condition.urlFilter === 'string' && !isAsciiOnly(condition.urlFilter)) {
      skipped.push({ id: rule.id, reason: 'non-ASCII urlFilter (Chrome requires punycode/percent-encoding)' });
      continue;
    }
    if (typeof condition.regexFilter === 'string') {
      if (!isAsciiOnly(condition.regexFilter)) {
        skipped.push({ id: rule.id, reason: 'non-ASCII regexFilter' });
        continue;
      }
      if (!(await isRegexFilterSupported(condition.regexFilter, condition.isCaseSensitive === true))) {
        skipped.push({ id: rule.id, reason: 'regexFilter not supported by RE2' });
        continue;
      }
    }
    vetted.push(rule);
  }
  return { vetted, skipped };
}

async function isRegexFilterSupported(regex, isCaseSensitive) {
  const check = chrome.declarativeNetRequest?.isRegexSupported;
  if (typeof check !== 'function') return true; // packed-API drift: let the chunked add decide
  try {
    const result = await check.call(chrome.declarativeNetRequest, { regex, isCaseSensitive });
    return result?.isSupported !== false;
  } catch {
    return true;
  }
}

/** Serialized re-apply of already-stored user filters (startup path). */
function applyUserFilters(filtersText) {
  return enqueueUserFilterOp(() => _applyUserFiltersNow(filtersText));
}

/** Serialized store + apply (SET_USER_FILTERS path). */
function setAndApplyUserFilters(filtersText) {
  return enqueueUserFilterOp(async () => {
    await setStorage(StorageKeys.USER_FILTERS, filtersText);
    return _applyUserFiltersNow(filtersText);
  });
}

/**
 * Atomically append one filter line to the stored user filters and run the
 * same apply path as SET_USER_FILTERS. The read-modify-write happens inside
 * the chained op so concurrent appends cannot drop one another's line.
 */
function appendUserFilterLine(line) {
  return enqueueUserFilterOp(async () => {
    const current = (await getStorage(StorageKeys.USER_FILTERS)) || '';
    const trimmedLine = line.trim();
    const next = current
      ? (current.endsWith('\n') ? current + trimmedLine : `${current}\n${trimmedLine}`)
      : trimmedLine;
    if (utf8ByteLength(next) > MAX_USER_FILTERS_BYTES) {
      return { error: `User filters exceed ${MAX_USER_FILTERS_BYTES} byte limit` };
    }
    await setStorage(StorageKeys.USER_FILTERS, next);
    return _applyUserFiltersNow(next);
  });
}

// §5.6 — the ONLY `$options` this parser can express in DNR. Anything absent
// from this map makes the whole line unrepresentable, and the line is dropped.
const SIMPLE_RULE_RESOURCE_TYPES = {
  script: 'script', image: 'image', stylesheet: 'stylesheet',
  xmlhttprequest: 'xmlhttprequest', document: 'main_frame',
  subdocument: 'sub_frame', font: 'font', media: 'media',
  websocket: 'websocket', ping: 'ping', other: 'other',
};

// §5.6 — options that scope *cosmetic* filtering. An `@@…$ghide` line is a
// generic-hide exception, not a network allow; emitting `{action: allow}` for
// it switched off network blocking for the whole domain (§3.3's blanket-allow
// shape, verbatim). Recognised here purely so the line can be refused.
//
// Shared with the runtime parser rather than restated: a scope option this set
// misses becomes a network allow, which is the failure this guard exists to
// prevent, so a second hand-kept copy is the wrong shape for it.
const SIMPLE_RULE_COSMETIC_SCOPE_OPTIONS = COSMETIC_SCOPE_OPTIONS;

/**
 * Parse a simple ABP-style network rule into a DNR rule object.
 *
 * ONLY used on the WASM-down path for user filters; `compile_user_filters` is
 * the real parser. Sprint 3 unified three parsers behind fail-closed unknown-
 * modifier handling and left this one out, so `$badfilter` became an active
 * block, `$removeparam` became a plain domain block, `@@…$ghide` became a
 * blanket network allow and `$important` was silently downgraded — i.e. a
 * user's filters meant different things depending on whether WASM had
 * initialized. It now refuses anything it cannot represent exactly (§5.6).
 *
 * Fail-closed is the recoverable direction here: a dropped rule under-blocks
 * and is visible to the user, where a mis-parsed one silently over-blocks or
 * (worse, for an `@@` line) silently disables blocking.
 */
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
    const types = [];

    for (const raw of pattern.slice(dollarPos + 1).split(',')) {
      const option = raw.trim().toLowerCase();

      // A cosmetic-scope option means the line is not a network rule at all.
      // Never translate it into an `allow`.
      if (SIMPLE_RULE_COSMETIC_SCOPE_OPTIONS.has(option)) return null;

      const resourceType = SIMPLE_RULE_RESOURCE_TYPES[option];
      if (resourceType) {
        types.push(resourceType);
        continue;
      }

      // Everything else — `$important`, `$badfilter`, `$removeparam`, `$csp`,
      // `$redirect`, `$domain=`, `$third-party`, `~`-negated types, an empty
      // token from a trailing comma, or a bare `$` that was really part of the
      // URL pattern — changes the rule's meaning in a way this parser does not
      // implement. Drop the line rather than emit a rule that means something
      // else. `$domain=`/`$third-party` in particular NARROW a filter, so
      // ignoring them broadens a block (over-blocks) or an allow (silently
      // stops blocking).
      return null;
    }

    if (types.length > 0) resourceTypes = types;
  }

  urlFilter = urlFilter.trim();
  if (!urlFilter) return null;

  const condition = { urlFilter };
  if (resourceTypes) condition.resourceTypes = resourceTypes;

  return {
    id,
    priority: isException ? DNR_USER_FILTER_PRIORITY.ALLOW : DNR_USER_FILTER_PRIORITY.BLOCK,
    condition,
    action: { type: isException ? 'allow' : 'block' },
  };
}

/**
 * §4.8 — server-side allowlist validation. Normalizes, dedupes, then splits
 * entries into `valid` (storable) and `rejected` (public suffixes, bare TLDs,
 * malformed hostnames). Every allowlist write path routes through this so a
 * `||co.uk^` allowAllRequests rule can never reach DNR, regardless of which
 * UI surface (or import file) supplied the entry.
 */
function partitionAllowlistInput(domains) {
  const valid = [];
  const rejected = [];
  for (const domain of normalizeAllowlist(domains)) {
    (isValidAllowlistDomain(domain) ? valid : rejected).push(domain);
  }
  return { valid, rejected };
}

/**
 * Read the authoritative allowlist from storage, validated (§4.8).
 *
 * §3.1 — every read-modify-write of the allowlist MUST start here, never from
 * `cachedAllowlist`. That cache is populated in stage 2 of `_criticalPromise`;
 * a message that reaches a freshly-woken worker before then sees an empty set,
 * and composing a "new" list from it silently deletes every stored entry.
 * Storage is the only source of truth that survives an SW kill.
 */
async function readStoredAllowlist() {
  return partitionAllowlistInput((await getStorage(StorageKeys.ALLOWLIST)) || []).valid;
}

/** Add a site to the per-site allowlist (disable blocking for domain). */
async function allowSite(domain) {
  const normalizedDomain = normalizeHostname(domain);
  if (!normalizedDomain || !isValidAllowlistDomain(normalizedDomain)) {
    return await readStoredAllowlist();
  }

  // Read-modify-write happens INSIDE the chained op so two concurrent adds
  // can't both snapshot the same base list and drop one another's entry — and
  // reads from STORAGE, not the memory cache, so a cold worker cannot compose
  // the new list from an empty set (§3.1).
  return enqueueAllowlistOp(async () => {
    const stored = await readStoredAllowlist();
    if (stored.includes(normalizedDomain)) {
      return stored;
    }
    const newAllowlist = stored.concat(normalizedDomain);
    await _rebuildAllowlistStateNow(newAllowlist);
    return newAllowlist;
  });
}

/**
 * Merge additional domains into the authoritative stored allowlist (union)
 * and rebuild dependent state. Serialized through the allowlist op chain.
 */
async function addAllowlistDomains(domains) {
  if (!Array.isArray(domains)) {
    throw new Error('ADD_ALLOWLIST_DOMAINS requires a domains array');
  }
  const { valid: additions, rejected } = partitionAllowlistInput(domains);

  return enqueueAllowlistOp(async () => {
    const stored = partitionAllowlistInput((await getStorage(StorageKeys.ALLOWLIST)) || []).valid;
    const merged = normalizeAllowlist([...stored, ...additions]);
    const changed =
      merged.length !== stored.length ||
      merged.some((entry, index) => entry !== stored[index]);
    if (changed) {
      await _rebuildAllowlistStateNow(merged);
    }
    return { allowlist: merged, rejected };
  });
}

/** Remove a site from the allowlist. */
async function disallowSite(domain) {
  const normalizedDomain = normalizeHostname(domain);
  if (!normalizedDomain) return await readStoredAllowlist();

  // §3.1 — same rule as allowSite: compose from stored state. Against an empty
  // memory cache the old code reported success for a removal it never made.
  return enqueueAllowlistOp(async () => {
    const stored = await readStoredAllowlist();
    if (!stored.includes(normalizedDomain)) {
      return stored;
    }
    const newAllowlist = stored.filter((entry) => entry !== normalizedDomain);
    await _rebuildAllowlistStateNow(newAllowlist);
    return newAllowlist;
  });
}

/**
 * §4.5 — stamp the allowlist band on rules from EITHER builder.
 *
 * The band is this worker's contract, not the compiler's: `build_allowlist_rules`
 * (wasm-core) carries its own priority literal, so without this the effective
 * priority silently depends on WASM health — the same user action would outrank
 * `system-unbreak`'s blocks with WASM down and lose to them with WASM up.
 */
function applyAllowlistPriorityBand(rules) {
  for (const rule of rules) {
    rule.priority = DNR_ALLOWLIST_PRIORITY;
  }
  return rules;
}

/** Rebuild DNR allow-all-requests rules from allowlist. */
async function rebuildAllowlistRules(allowlist) {
  // §4.8 backstop: this is the last stop before allowAllRequests rules reach
  // DNR — a public-suffix entry here would disable blocking for a whole TLD.
  const normalizedAllowlist = partitionAllowlistInput(allowlist).valid;
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
    // JS fallback — runs exactly when WASM init failed. It MUST emit the same
    // object the Rust builder does (`build_allowlist_rules`): Chrome rejects an
    // `allowAllRequests` rule that does not declare resourceTypes limited to
    // main_frame/sub_frame (§4.1), and a rejected batch means storage says
    // "allowlisted" while DNR keeps blocking.
    newRules = normalizedAllowlist.map((domain, i) => ({
      id: DNR_ALLOWLIST_START + i,
      priority: DNR_ALLOWLIST_PRIORITY,
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: ['main_frame', 'sub_frame'],
      },
      action: { type: 'allowAllRequests' },
    }));
  }

  applyAllowlistPriorityBand(newRules);

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
  // Keep in sync with rules/ruleset-counts.json (the authoritative build
  // artifact loaded just below) — e.g. system-unbreak gained a scoped-gstatic
  // rule (18 → 19).
  'system-unbreak': 19,
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

// Boot-time invariant: every ruleset declared in the manifest must have an
// explicit slot in RULESET_ENABLE_PRIORITY, otherwise it falls to the lowest
// priority during budget fallback and silently loses to its peers. Run once
// at module load so misconfigurations fail loudly in dev rather than silently
// in production. See docs/REVIEW.md §6.3.
(function validateRulesetPriorityAgainstManifest() {
  const manifestIds = getManifestRulesetIds();
  if (manifestIds.size === 0) return; // pre-test or build environment
  const priorityIds = new Set(RULESET_ENABLE_PRIORITY);
  const missing = [...manifestIds].filter((id) => !priorityIds.has(id));
  const unknown = RULESET_ENABLE_PRIORITY.filter((id) => !manifestIds.has(id));
  if (missing.length === 0 && unknown.length === 0) return;
  const detail = `missing=[${missing.join(',')}] unknown=[${unknown.join(',')}]`;
  reportError(
    'rulesetPriority:mismatch',
    new Error(`RULESET_ENABLE_PRIORITY does not match manifest: ${detail}`),
    { fatal: true }
  );
})();

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

  const manifestRulesetIds = getManifestRulesetIds();
  const enableRulesetIds = [];
  const disableRulesetIds = [];
  const unknownRulesetIds = [];

  // Derived from ALL_KNOWN_LIST_IDS — a re-declared literal here silently
  // drifted from it, so newly added lists were never enabled (§5.7).
  for (const listId of ALL_KNOWN_LIST_IDS) {
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
    log('[AdBlock] Enabled static rulesets:', enabledRulesets.join(', '));
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
        await queueActiveIndexRebuild();
      }
    } catch (err) {
      // §3.2 — a failed rebuild leaves the index empty and every cosmetic and
      // scriptlet lookup dead. console.error kept GET_ERROR_REPORT reporting a
      // healthy extension; this is the one caller that can surface it.
      reportError('activeIndexRebuild:scheduled', err, { fatal: true });
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

// ---------------------------------------------------------------------------
// §5.25 — the trust boundary for privileged scriptlets
// ---------------------------------------------------------------------------
//
// uBO marks a handful of scriptlets `requiresTrust` and refuses any filter that
// names one unless the filter came from a trusted source. Nothing enforced that
// here, so `trusted-set-constant` (which `JSON.parse`s a value and installs the
// result at an arbitrary `window` path) and `trusted-replace-fetch-response`
// (which rewrites arbitrary response bodies) were reachable from ANY filter the
// user could be induced to add — including, critically, through
// `APPEND_USER_FILTER`, which is SENDER_ANY. That made it a privilege
// escalation from a compromised renderer: append one line, get arbitrary code
// semantics injected into the MAIN world of the next page load.
//
// The gate lives here, at spec-build time, because this is the only layer that
// knows where a spec came from. Filtering in the page would be too late (the
// spec has already crossed into the renderer) and filtering at ingest would
// lose the distinction between a subscribed list and the user's own filters.
//
// The name set MIRRORS `TRUSTED_SCRIPTLETS` in src/scriptlets/index.js
// (registry keys, aliases included) rather than importing it: that module
// eagerly imports every scriptlet implementation and installs a MAIN-world
// global at load, so importing it would pull the entire scriptlet corpus into
// the service-worker bundle. tests/sw-harness/sw-scriptlet-trust.test.mjs pins
// the two lists against each other so they cannot drift.
const TRUSTED_ONLY_SCRIPTLETS = new Set([
  'trusted-set-constant', 'tsc', 'trusted-set',
  'trusted-click-element', 'tce',
  'trusted-replace-fetch-response', 'trfr',
  'trusted-replace-xhr-response', 'trxr',
  'trusted-set-cookie', 'trusted-set-cookie-reload',
  'trusted-set-local-storage-item', 'trusted-set-session-storage-item',
  // uBO's `replace-node-text`/`rpnt` are aliases of the *trusted* scriptlet:
  // the replacement text is written straight into a <script> node.
  'trusted-replace-node-text', 'trusted-rpnt', 'replace-node-text', 'rpnt',
]);

/**
 * Filter-list sources whose rules may invoke a `requiresTrust` scriptlet.
 *
 * Today that is every list this extension ships or subscribes to — all curated
 * (uAssets, EasyList, malware-filter) — plus the built-in `system-unbreak`.
 * The set exists so that adding a custom-list subscription later is a
 * *deliberate* trust decision rather than an accidental one.
 */
const TRUSTED_FILTER_LIST_IDS = new Set(ALL_KNOWN_LIST_IDS);

/**
 * Scriptlet-dispatch diagnostics (§5.22, §5.25).
 *
 * `unknown` is the miss counter the page bundle keeps — 20.4% of the shipped
 * corpus names scriptlets with no implementation, and until now nothing in the
 * worker, popup, options page or build read `getUnknownScriptlets()`, so a
 * coverage regression was invisible in production. `refusedUntrusted` counts
 * specs this gate dropped. Both surface through GET_ERROR_REPORT.
 *
 * Bounded: a hostile page cannot make either map grow without limit.
 */
const MAX_SCRIPTLET_DIAGNOSTIC_KEYS = 200;
const scriptletDiagnostics = {
  unknown: new Map(),           // name -> misses observed in pages
  refusedUntrusted: new Map(),  // name -> specs refused by the trust gate
};

function bumpScriptletDiagnostic(map, name, count) {
  const key = typeof name === 'string' ? name.slice(0, 100) : String(name).slice(0, 100);
  const increment = Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 1e6) : 1;
  if (!map.has(key) && map.size >= MAX_SCRIPTLET_DIAGNOSTIC_KEYS) return;
  map.set(key, (map.get(key) || 0) + increment);
}

function scriptletDiagnosticsSnapshot() {
  const toObject = (map) => Object.fromEntries(map);
  const total = (map) => [...map.values()].reduce((sum, n) => sum + n, 0);
  return {
    unknown: toObject(scriptletDiagnostics.unknown),
    unknownTotal: total(scriptletDiagnostics.unknown),
    refusedUntrusted: toObject(scriptletDiagnostics.refusedUntrusted),
    refusedUntrustedTotal: total(scriptletDiagnostics.refusedUntrusted),
  };
}

/**
 * May a rule from `origin` invoke a trust-gated scriptlet?
 *
 * `origin` is `'user'` for the user's own filter text (SET_USER_FILTERS and the
 * renderer-reachable APPEND_USER_FILTER) and `'list'` for the compiled index
 * built from subscribed filter lists.
 *
 * FOLLOW-UP (cross-file): the index stores scriptlet rules merged across lists
 * with no per-rule provenance — `mergeFilterSources` and wasm-core's
 * `compile_active_filter_index` both flatten them — so `rule.listId` is absent
 * today and a list rule is trusted by virtue of being in the curated index. The
 * `listId` branch is live for the moment ingestion starts tagging rules, and
 * fails closed for any id not in TRUSTED_FILTER_LIST_IDS. Tagging requires
 * changes in src/shared/db.js and wasm-core, which are outside this pass.
 */
function isTrustedScriptletSource(rule, origin) {
  if (origin !== 'list') return false;
  const listId = rule?.listId;
  if (listId === undefined || listId === null) return true;
  return TRUSTED_FILTER_LIST_IDS.has(listId);
}

/** Drop specs naming a trust-gated scriptlet that `origin` may not invoke. */
function filterTrustedScriptlets(rules, origin) {
  const allowed = [];
  for (const rule of rules) {
    if (!TRUSTED_ONLY_SCRIPTLETS.has(rule?.name)) {
      allowed.push(rule);
      continue;
    }
    if (isTrustedScriptletSource(rule, origin)) {
      allowed.push(rule);
      continue;
    }
    bumpScriptletDiagnostic(scriptletDiagnostics.refusedUntrusted, rule?.name, 1);
  }
  return allowed;
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

    const [{ result: diagnostics = null } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: executeScriptlets,
      args: [SCRIPTLET_REGISTRY_KEY, scriptletRules],
    });

    // §5.22 — pull the page bundle's unknown-name counters back across the
    // injection boundary. This is the only channel that exists: the bundle
    // runs in the page's MAIN world and cannot message the worker.
    recordUnknownScriptletsFromPage(diagnostics);
  } catch (err) {
    if (!err.message?.includes('No frame with id')) {
      reportError('scriptlet:inject', err);
    }
  }
}

/**
 * Fold a page's `{name: missCount}` report into the worker's counters.
 * Everything here is renderer-supplied, so shapes are validated, not trusted.
 */
function recordUnknownScriptletsFromPage(report) {
  const unknown = report?.unknown;
  if (!unknown || typeof unknown !== 'object' || Array.isArray(unknown)) return;
  for (const [name, count] of Object.entries(unknown)) {
    if (typeof count !== 'number') continue;
    bumpScriptletDiagnostic(scriptletDiagnostics.unknown, name, count);
  }
}

// TODO(REVIEW-2026-07 §4.24 fix 3 / §5.38): the real fix for the seed→load
// gap is registering the scriptlet bundle via
// `chrome.scripting.registerContentScripts({ world: 'MAIN', runAt:
// 'document_start' })`, so it executes before any page script and no boot-key
// round-trips exist at all. Until then the layered mitigations below
// (non-configurable seed, key-shape validation in the bundle, strict registry
// verification before specs are handed over) only raise the bar — a page
// specifically targeting Nullify can still forge the registry shape.

/**
 * §4.24 layered fix 2 — strict registry verification, run in the MAIN world
 * both for the "already registered?" fast path and after the bundle loads.
 * When the page pre-claims `window[key]` with a non-configurable descriptor,
 * the bundle's own defineProperty throws and it refuses to register — but the
 * page's object remains at the key. The old `reg && typeof reg.run ===
 * 'function'` check happily handed such a spy the full per-site scriptlet
 * spec list. Require the exact descriptor + object shape the bundle produces:
 * non-configurable/non-enumerable/non-writable data property (no accessor
 * spies) whose value is a frozen object whose own keys are drawn from a fixed
 * allowlist and always include `run`.
 *
 * §5.22 — that allowlist gained one optional member, `getUnknownScriptlets`,
 * so the bundle can hand its miss counters back through `executeScriptlets`.
 * This does not weaken the check: a forged registry could always satisfy the
 * one-key shape, so admitting a second *named, function-typed* key grants an
 * attacker nothing new. The substance of the gate — frozen, non-configurable,
 * non-writable, no accessors, no unexpected keys — is unchanged.
 */
function verifyScriptletRegistry(key) {
  try {
    const desc = Object.getOwnPropertyDescriptor(window, key);
    if (!desc) return false;
    if (desc.configurable !== false || desc.enumerable !== false) return false;
    // Accessor descriptors have no `value`/`writable` — reject getter spies.
    if (!('value' in desc) || desc.writable !== false) return false;
    const reg = desc.value;
    if (!reg || typeof reg.run !== 'function') return false;
    if (!Object.isFrozen(reg)) return false;
    const allowedKeys = ['run', 'getUnknownScriptlets'];
    const ownKeys = Reflect.ownKeys(reg);
    if (!ownKeys.includes('run')) return false;
    return ownKeys.every((k) => allowedKeys.includes(k) && typeof reg[k] === 'function');
  } catch {
    return false;
  }
}

function seedBootKey(key) {
  // Use defineProperty, NOT `globalThis.x = key`. A plain assignment to the
  // fixed-named boot property fires any setter the page pre-installed on it,
  // leaking the capability key (page could then call window[key].run(...) with
  // attacker-chosen args). defineProperty never invokes setters. Non-enumerable
  // keeps it out of Object.keys.
  //
  // §4.24 layered fix 1: configurable MUST be false. With configurable:true a
  // page polling the seed→load gap could not just read the key but REDEFINE
  // the property to a forged key, permanently killing scriptlets for itself
  // (and worse, pre-claim the real key for a spy registry). The bundle no
  // longer deletes the boot property; a frozen non-enumerable random string
  // left on the global is harmless. Returns false if the page pre-claimed the
  // name with an incompatible descriptor, so the caller skips the bundle.
  try {
    Object.defineProperty(globalThis, '__nullifyBootKey', {
      value: key,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    return false;
  }
  return globalThis.__nullifyBootKey === key;
}

async function ensureScriptletRegistry(tabId, frameId) {
  try {
    const [{ result: ready = false } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: verifyScriptletRegistry,
      args: [SCRIPTLET_REGISTRY_KEY],
    });

    if (ready === true) return true;

    const [{ result: seeded = false } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: seedBootKey,
      args: [SCRIPTLET_REGISTRY_KEY],
    });

    // Page hijacked the boot-key property with a non-configurable descriptor.
    // Don't load the bundle — it would register the dispatcher under an
    // attacker-controlled key. No scriptlets this run; safer than a leak.
    if (!seeded) return false;

    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      files: [runtimeAssetPath('scriptlets-world.js')],
    });

    // §4.24 layered fix 2: never trust the load. If the page pre-claimed
    // `window[key]` during the seed→load gap, the bundle refused to register
    // and the object sitting at the key is page-controlled — verify the
    // registry's exact shape before any specs are ever handed to it.
    const [{ result: verified = false } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: verifyScriptletRegistry,
      args: [SCRIPTLET_REGISTRY_KEY],
    });

    return verified === true;
  } catch (err) {
    if (!err.message?.includes('No frame with id')) {
      reportError('scriptlet:bootstrap', err);
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
  if (!registry || typeof registry.run !== 'function') return null;

  for (const spec of specs) {
    try {
      registry.run(spec.name, spec.args);
    } catch { }
  }

  // §5.22 — hand the bundle's unknown-name counters back to the worker as this
  // injection's result. The bundle counts every dispatch that resolved to no
  // implementation; without this readback a 20% miss rate is invisible outside
  // a debugger. Optional and best-effort: a bundle without the accessor (or a
  // page that broke it) simply reports nothing.
  try {
    if (typeof registry.getUnknownScriptlets === 'function') {
      const unknown = registry.getUnknownScriptlets();
      if (unknown && typeof unknown === 'object') return { unknown };
    }
  } catch { }
  return null;
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

/**
 * §5.5 — the cap is a BYTE budget and must be measured in bytes.
 *
 * This worker compared `raw.length`, i.e. UTF-16 code units, while
 * `src/options/messaging.js` and `wasm-core/src/lib.rs` both count UTF-8
 * bytes. A large non-ASCII list (Cyrillic, CJK — every one of those is 2-3
 * UTF-8 bytes per code unit) therefore passed this check and threw inside
 * Rust. `compileUserFiltersViaWasm` catches that throw and returns `null`,
 * which is indistinguishable from "WASM unavailable" — so the naive JS
 * fallback ran over the whole blob with none of the critical-path guards the
 * Rust compiler applies. Counting bytes here makes the three enforcers agree.
 */
function utf8ByteLength(text) {
  return new TextEncoder().encode(text ?? '').length;
}
// §5.2 — upper bound on one CONTENT_BLOCKED report. The cosmetic engine sends
// a count per observer batch; anything past this is a compromised renderer
// inflating the badge, not a page with a million ad slots.
const MAX_CONTENT_BLOCKED_COUNT = 1_000;

// ---------------------------------------------------------------------------
// Sender privilege classes (REVIEW.md §2.3, REVIEW-2026-07 §6 row 2.3).
//
// `sender.id === chrome.runtime.id` also holds for OUR content scripts running
// inside arbitrary (potentially compromised) renderers, so it is NOT a
// privilege boundary. Destructive/privileged handlers additionally require the
// sender to be one of our extension pages (popup/options — `sender.url` on the
// chrome-extension:// origin of this extension).
//
// Declarative map: message type → required sender class. Every handled type
// MUST have an entry; unlisted types fail closed to SENDER_EXTENSION_PAGE, so
// a future handler added without classification is unreachable from content
// scripts rather than silently exposed to them.
// ---------------------------------------------------------------------------
const SENDER_ANY = 'any';                         // content scripts + extension pages (payload still validated)
const SENDER_EXTENSION_PAGE = 'extension-page';   // extension pages only

// §5.33 — six handlers were removed in this pass because nothing in
// src/content, src/popup or src/options called them (re-verified by grep at
// HEAD, not taken from the review): SET_SETTINGS, SET_ALLOWLIST,
// GET_COSMETIC_RULES, GET_NOISE, GET_ANONYMIZED_STATS and
// FORCE_CLEAN_ALL_DYNAMIC_RULES. Two of them (GET_COSMETIC_RULES, GET_NOISE)
// were SENDER_ANY, i.e. renderer-reachable attack surface maintained for no
// consumer; GET_COSMETIC_RULES additionally leaked the user's own per-site
// cosmetic filters for any claimed hostname (§4.19). The remaining four were
// whole-object writers and destructive operations with live, narrower
// replacements (UPDATE_SETTINGS, ADD_ALLOWLIST_DOMAINS).
const MESSAGE_SENDER_POLICY = {
  // Content-script critical path + picker/stats reporting.
  GET_INIT_DATA: SENDER_ANY,          // §4.19: hostname derived from sender.url
  IS_SITE_ALLOWED: SENDER_ANY,
  GET_TAB_STATS: SENDER_ANY,          // §5.4: payload.tabId honored only for extension pages
  CONTENT_BLOCKED: SENDER_ANY,        // §4.13: payload validated in the handler
  APPEND_USER_FILTER: SENDER_ANY,     // element picker; single validated line
  REPORT_CONTENT_ERROR: SENDER_ANY,
  CHECK_SEMANTIC_AD: SENDER_ANY,

  // Extension pages only — settings/allowlist/filter/ruleset writers, bulk
  // readers of user data, diagnostics, and destructive operations.
  GET_SETTINGS: SENDER_EXTENSION_PAGE,
  UPDATE_SETTINGS: SENDER_EXTENSION_PAGE,
  GET_ALLOWLIST: SENDER_EXTENSION_PAGE,
  ALLOW_SITE: SENDER_EXTENSION_PAGE,
  DISALLOW_SITE: SENDER_EXTENSION_PAGE,
  ADD_ALLOWLIST_DOMAINS: SENDER_EXTENSION_PAGE,
  GET_USER_FILTERS: SENDER_EXTENSION_PAGE,
  SET_USER_FILTERS: SENDER_EXTENSION_PAGE,
  SET_RULESET_ENABLED: SENDER_EXTENSION_PAGE,
  GET_ENABLED_RULESETS: SENDER_EXTENSION_PAGE,
  GET_DAILY_BLOCKED_TOTAL: SENDER_EXTENSION_PAGE,
  CHECK_FILTER_UPDATES: SENDER_EXTENSION_PAGE,
  GET_ERROR_REPORT: SENDER_EXTENSION_PAGE,
  CLEAR_ERROR_REPORT: SENDER_EXTENSION_PAGE,
};

/**
 * Message types that must not be answered from a half-initialized worker:
 * they read or mutate state that `refreshMemoryCache()` / `restorePersistedStats()`
 * populate in stage 2 of `_criticalPromise` (§3.1).
 */
const NEEDS_CRITICAL_CACHE = new Set([
  'IS_SITE_ALLOWED',
  'GET_ALLOWLIST',
  'ALLOW_SITE',
  'DISALLOW_SITE',
  'ADD_ALLOWLIST_DOMAINS',
  'GET_TAB_STATS',
  'GET_DAILY_BLOCKED_TOTAL',
  'GET_INIT_DATA',
]);

/** True when the message came from one of our own extension pages. */
function isExtensionPageSender(sender) {
  return typeof sender?.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL(''));
}

/**
 * §4.19 — the hostname a content-script message is answered for must be
 * derived from the sender, never taken from the payload.
 *
 * `GET_INIT_DATA` is SENDER_ANY and used to trust `payload.hostname`
 * verbatim. Two consequences, both reachable from any compromised renderer:
 *
 *   - Disclosure. The reply folds in the user's OWN per-site cosmetic filters
 *     (`USER_COSMETIC_RULES`, keyed by domain). Claiming hostnames one at a
 *     time enumerated the user's private filter list for sites they never
 *     opened in that renderer.
 *   - Allowlist bypass. `isAllowed` was computed from the CLAIM, while
 *     `injectScriptlets` targets the real `sender.tab.id`/`frameId`. A page on
 *     an allowlisted host could claim an unlisted hostname and have scriptlets
 *     injected into itself — and vice versa, claim an allowlisted hostname to
 *     get `isAllowed: true` and suppress its own cosmetic filtering.
 *
 * §5.4 applied exactly this fix to `GET_TAB_STATS` (payload.tabId honored only
 * for extension pages) and stopped there.
 *
 * Extension pages have no `sender.tab`; they are trusted and keep the payload.
 * `about:blank` / `about:srcdoc` / `data:` frames yield no usable hostname
 * from `sender.url` — they inherit their parent's origin, and the content
 * script sends the hostname it computed from that parent — so those fall back
 * to the payload. That fallback grants nothing: such a frame's `sender.url`
 * is unforgeable-but-useless, and the claim is all that exists.
 */
function hostnameFromSenderUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return '';
  }
}

function resolveRequestHostname(sender, claimed) {
  const claimedHostname = normalizeHostname(claimed);
  if (!sender?.tab) return claimedHostname;
  return hostnameFromSenderUrl(sender.url) || claimedHostname;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'foreign sender rejected' });
    return false;
  }
  if (!message || typeof message.type !== 'string') {
    sendResponse({ error: 'malformed message' });
    return false;
  }
  if (MESSAGE_SENDER_POLICY[message.type] !== SENDER_ANY && !isExtensionPageSender(sender)) {
    sendResponse({ error: `${message.type}: extension-page sender required` });
    return false;
  }

  // For content-script critical-path messages, ensure caches are ready first.
  // Non-critical messages (stats, settings UI) don't need to wait.
  //
  // §3.1 — EVERY allowlist reader and writer belongs here. The writers now
  // compose from storage rather than from `cachedAllowlist`, so this gate is
  // defence in depth rather than the fix; the readers (`GET_ALLOWLIST`,
  // `IS_SITE_ALLOWED`) genuinely need the cache to be populated or they answer
  // "not allowlisted" for a site the user has allowlisted.
  const needsCache = NEEDS_CRITICAL_CACHE.has(message.type);

  const run = needsCache && !_criticalReady
    ? _criticalPromise.then(() => handleMessage(message, sender))
    : handleMessage(message, sender);

  run.then(sendResponse).catch((err) => {
    // §4.11 — the catch-all used to answer `{error}` and log nothing, so a
    // handler that threw (a rejected `getCosmeticBundleForPage`, say) left
    // GET_ERROR_REPORT describing a perfectly healthy extension while every
    // page got zero cosmetic rules. The response shape is the caller's
    // problem; the failure being *invisible* was ours.
    reportError(`message:${message.type}`, err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  const { type, payload } = message;

  switch (type) {
    case 'GET_INIT_DATA': {
      // §4.19 — resolved from `sender.url` for content scripts. Deliberately
      // the FIRST thing this handler does: every read below (allowlist check,
      // cosmetic bundle, scriptlet specs) and the injection target must all
      // agree on one hostname, and `getCosmeticBundleForPage` snapshots the
      // rebuild generation on entry, so the hostname has to be settled before
      // it is called.
      const hostname = resolveRequestHostname(sender, payload?.hostname);
      const [isAllowed, settings, cosmeticBundle, scriptletRules] = await Promise.all([
        isHostnameAllowedCached(hostname),
        (await getStorage(StorageKeys.SETTINGS)) || {},
        getCosmeticBundleForPage(hostname),
        getScriptletRulesForPage(hostname),
      ]);

      const isTopFrame = (sender.frameId || 0) === 0;

      if (!isAllowed && sender.tab?.id) {
        const scriptletsToRun = [...scriptletRules];

        const youtubeHostnames = new Set(YOUTUBE_SHIELD_TARGETS.map(t => t.hostname));
        if (!youtubeHostnames.has(hostname) && isTopFrame && settings.fingerprintProtection === true) {
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
        networkStatsAvailable, // §4.25 — false in packed builds (no onRuleMatchedDebug)
        settings,
        cosmeticRules: cosmeticBundle.rules,
        cssText: cosmeticBundle.cssText || '',
        exceptionCss: cosmeticBundle.exceptionCss || '',
        genericProceduralRules: shouldSkipGenericCosmeticForHostname(hostname, cachedGenericCosmeticExcludedDomains)
          ? []
          : cachedGenericProceduralRules,
      };

      if (wasmReady && !isAllowed && cosmeticBundle.cosmeticRulesBinary) {
        try {
          // Base64, not the raw Uint8Array: runtime messages are JSON-
          // serialized, so a typed array reaches the content script as a plain
          // object with no `.buffer` and the decode throws. `cosmeticRules` is
          // deliberately left in place as the fallback.
          responseData.cosmeticRulesBinary =
            encodeBinaryRules(cosmeticBundle.cosmeticRulesBinary);

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
      // §5.4 — honoring payload.tabId from any sender let a compromised
      // renderer enumerate tab ids and read every open tab's URL. Only
      // extension pages (no sender.tab, extension-origin sender.url) may ask
      // about arbitrary tabs; content scripts get their own tab only.
      const fromExtensionPage = !sender.tab && isExtensionPageSender(sender);
      const tabId = fromExtensionPage ? payload?.tabId : sender.tab?.id;
      return { ...normalizeTabStatsEntry(tabStats.get(tabId)), networkStatsAvailable };
    }
    case 'GET_DAILY_BLOCKED_TOTAL': {
      if (rollDailyBlockedTotalIfNeeded()) {
        await persistTabStats();
      }
      return { total: totalBlockedToday, networkStatsAvailable };
    }
    case 'GET_SETTINGS':
      return (await getStorage(StorageKeys.SETTINGS)) || {};
    case 'UPDATE_SETTINGS': {
      // Partial merge — safe when multiple UI surfaces (popup + options)
      // may be editing settings concurrently. §5.33: the whole-object
      // SET_SETTINGS writer is gone. It had no caller (options.js carries a
      // comment explaining that it deliberately does not use it), and a
      // replace composed from one tab's possibly-stale DOM silently clobbers
      // concurrent edits made in the other surface.
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
      // §4.8 — reject public suffixes / bare TLDs server-side, with an error
      // the UI can show; silently "succeeding" here would report a TLD as
      // protected while DNR carries an allow-everything rule.
      if (!isValidAllowlistDomain(domain)) {
        return {
          ok: false,
          error: `"${domain}" is not a valid allowlist domain`,
          rejected: [domain],
        };
      }
      const allowlist = await allowSite(domain);
      return { ok: true, allowlist };
    }
    case 'DISALLOW_SITE': {
      const domain = normalizeHostname(payload.domain);
      if (!domain) return { ok: false };
      const allowlist = await disallowSite(domain);
      return { ok: true, allowlist };
    }
    // §5.33 — SET_ALLOWLIST (replace the entire allowlist) is deleted. No
    // caller: the options page's import path uses ADD_ALLOWLIST_DOMAINS
    // precisely because a replace composed from a stale read can wipe entries
    // added elsewhere (§3.1's failure mode). Both share
    // `partitionAllowlistInput`, so the §4.8 public-suffix rejection is
    // unchanged and still reported through the `rejected` array.
    case 'ADD_ALLOWLIST_DOMAINS': {
      if (!Array.isArray(payload?.domains) ||
          payload.domains.some((domain) => typeof domain !== 'string')) {
        return { error: 'ADD_ALLOWLIST_DOMAINS requires a domains array of strings' };
      }
      try {
        const { allowlist, rejected } = await addAllowlistDomains(payload.domains);
        return { ok: true, allowlist, rejected };
      } catch (err) {
        return { error: err?.message || String(err) };
      }
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
      // §5.5 — bytes, not UTF-16 code units: see utf8ByteLength.
      if (utf8ByteLength(raw) > MAX_USER_FILTERS_BYTES) {
        return { error: `User filters exceed ${MAX_USER_FILTERS_BYTES} byte limit` };
      }
      const counts = await setAndApplyUserFilters(raw);
      if (counts?.error) return { error: counts.error };
      // §4.16 — the budget is now enforced inside the apply (rules past it are
      // truncated before any DNR round-trip), so this is the honesty channel
      // for it: say the list was cut rather than reporting a clean success.
      if (counts && counts.network >= MAX_USER_FILTERS_DNR_RULES && counts.skippedNetwork > 0) {
        return {
          ...counts,
          warning: `Only the first ${MAX_USER_FILTERS_DNR_RULES} network rules were applied (${counts.skippedNetwork} dropped)`,
        };
      }
      return counts;
    }
    case 'APPEND_USER_FILTER': {
      const line = payload?.line;
      if (typeof line !== 'string' || !line.trim()) {
        return { error: 'APPEND_USER_FILTER requires a non-empty filter line' };
      }
      if (line.includes('\n') || line.includes('\r')) {
        return { error: 'APPEND_USER_FILTER accepts a single line' };
      }
      if (utf8ByteLength(line) > MAX_USER_FILTERS_BYTES) {
        return { error: `User filters exceed ${MAX_USER_FILTERS_BYTES} byte limit` };
      }
      const result = await appendUserFilterLine(line);
      if (result?.error) return { error: result.error };
      return { ok: true, counts: result };
    }
    // §5.5 — RUN_SCRIPTLETS and GET_SCRIPTLET_RULES are deliberately gone:
    // they had no caller anywhere in src/content, src/popup or src/options,
    // ignored the allowlist, and accepted arbitrary scriptlet names/args from
    // any renderer. Scriptlet injection happens exclusively through
    // GET_INIT_DATA, which gates on the allowlist.
    //
    // §5.33/§4.19 — GET_COSMETIC_RULES joins them. Same story: no caller
    // anywhere, SENDER_ANY, and it answered for a caller-supplied hostname,
    // so any renderer could read the user's own per-site cosmetic filters for
    // every site they had ever written one for. The content script gets its
    // bundle from GET_INIT_DATA, which now derives the hostname from the
    // sender and gates on the allowlist.
    case 'SET_RULESET_ENABLED': {
      const enabledMap = await setRulesetEnabled(payload.rulesetId, payload.enabled);
      return { ok: true, enabledMap };
    }
    case 'GET_ENABLED_RULESETS':
      return await getEffectiveEnabledRulesetsMap();

    // §5.33 — GET_NOISE and GET_ANONYMIZED_STATS are deleted. Neither had a
    // caller. GET_NOISE was SENDER_ANY and handed any renderer an oracle over
    // the worker's CSPRNG-seeded Gaussian generator; the fingerprint-noise
    // scriptlet generates its own noise in-page. GET_ANONYMIZED_STATS returned
    // the entire cross-tab stats store (every tab's URL) with differential-
    // privacy noise applied to the counters only — the URLs were never
    // anonymized, and no surface displayed either.

    case 'CHECK_SEMANTIC_AD': {
      const { text } = payload;
      if (!text) return { isAd: false };
      return { isAd: wasmReady ? is_semantic_ad(text) : false };
    }

    // §5.33 — FORCE_CLEAN_ALL_DYNAMIC_RULES is deleted. It deleted every
    // dynamic rule the worker owns (the whole allowlist and every user filter)
    // and had no caller in any surface. §5.1 had to repair it in the previous
    // pass precisely because nothing exercised it: it wiped the user-filter
    // rules and left USER_FILTERS_APPLIED set, so the startup short-circuit
    // meant they never came back. Unreachable destructive code that silently
    // rots is worse than no recovery hatch; the allowlist and user filters are
    // both rebuilt from storage on the paths that actually run.

    case 'CHECK_FILTER_UPDATES': {
      // §5.3 — report what actually happened. `{ok:true}` on a total fetch
      // failure made "Update All" a silent no-op offline, and made the options
      // page render a `lastUpdateCheck` the SW never wrote.
      return await checkFilterListUpdates();
    }
    case 'REPORT_CONTENT_ERROR': {
      // Content-script init failures used to die in a bare `.catch(() => {})`.
      // Funnel them here so GET_ERROR_REPORT reflects a broken content side
      // instead of showing a healthy extension.
      const host = typeof payload?.hostname === 'string' ? payload.hostname.slice(0, 253) : 'unknown';
      const detail = typeof payload?.message === 'string' ? payload.message.slice(0, 500) : 'unknown';
      reportError(`content:${host}`, new Error(detail));
      return { ok: true };
    }
    case 'GET_ERROR_REPORT': {
      // Return structured error report for diagnostics
      return {
        lastError: errorReport.lastError,
        criticalCount: errorReport.critical.length,
        warningCount: errorReport.warnings.length,
        critical: errorReport.critical.slice(-20),
        warnings: errorReport.warnings.slice(-20),
        // §5.22/§5.25 — scriptlet dispatch health. `unknown` is the page
        // bundle's own miss counter, which had no consumer anywhere until now;
        // `refusedUntrusted` is what the trust gate dropped.
        scriptlets: scriptletDiagnosticsSnapshot(),
      };
    }
    case 'CLEAR_ERROR_REPORT': {
      errorReport.critical = [];
      errorReport.warnings = [];
      errorReport.lastError = null;
      scriptletDiagnostics.unknown.clear();
      scriptletDiagnostics.refusedUntrusted.clear();
      return { ok: true };
    }
    case 'CONTENT_BLOCKED': {
      // §4.13 — this payload comes straight from a content script inside a
      // potentially compromised renderer, and `action` used to flow into the
      // logger UI's innerHTML unescaped. Validate shape server-side before
      // counting or broadcasting; reject rather than coerce so a poisoned
      // renderer can't smuggle markup through the logger event stream.
      const action = payload?.action ?? 'hide';
      if (action !== 'hide' && action !== 'remove') {
        return { error: 'CONTENT_BLOCKED: invalid action' };
      }
      if (payload?.selector != null &&
          (typeof payload.selector !== 'string' || payload.selector.length > 1024)) {
        return { error: 'CONTENT_BLOCKED: invalid selector' };
      }
      if (payload?.hostname != null &&
          (typeof payload.hostname !== 'string' || payload.hostname.length > 253)) {
        return { error: 'CONTENT_BLOCKED: invalid hostname' };
      }

      // §5.2 — `Number.isFinite(1e308)` passes, so an unbounded count let a
      // hostile page drive totalBlockedToday to a nonsense value that was then
      // persisted to storage AND the session mirror. Clamp to a plausible
      // per-message batch instead of trusting the renderer.
      const count = Number(payload?.count);
      const increment = Number.isFinite(count) && count > 0
        ? Math.min(Math.floor(count), MAX_CONTENT_BLOCKED_COUNT)
        : 1;

      const tabId = sender.tab?.id;
      if (tabId != null && tabId >= 0) {
        const entry = ensureTabStatsEntry(tabId, sender.tab?.url || '');
        entry.blocked += increment;
        incrementDailyBlockedTotal(increment);
        updateBadge(tabId);
        schedulePersistTabStats();
      }

      // Broadcast to Logger
      broadcastLoggerEvent({
        type: 'cosmetic',
        action,
        hostname: payload?.hostname || sender.tab?.url || '',
        selector: typeof payload?.selector === 'string' ? payload.selector : '',
        count: increment,
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

async function getCosmeticBundleForPage(hostname) {
  // Wait for critical caches if they aren't ready yet
  if (!_criticalReady && _criticalPromise) await _criticalPromise;
  if (!bloom) {
    return buildPageBundle({ generic: [], domainSpecific: [], exceptions: [] });
  }

  // Cache hit — onBeforeNavigate pre-warms this; GET_INIT_DATA reuses it.
  const cached = domainRulesCache.get(hostname);
  if (cached) return cached;

  const persistedBundle = normalizeStoredBundle(
    await db.getPageBundle(hostname, activeRuleDataVersion)
  );
  if (persistedBundle) {
    setCachedDomainRules(hostname, persistedBundle);
    return persistedBundle;
  }

  // Deduplicate: If we are already fetching rules for this domain, return the same promise.
  if (_inFlightRules.has(hostname)) return _inFlightRules.get(hostname);

  // §5.4 — snapshot the rebuild generation before reading a single store. Any
  // rebuild that starts, finishes, or is still running when this lookup
  // resolves changes the number, and the result is then cache-only for this
  // request rather than being written anywhere durable.
  const generationAtLookupStart = currentRebuildGeneration();

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
    // Never keep a bundle that may have been computed against half-cleared
    // stores (§5.3/§5.4). Two independent signals, because neither alone is
    // sufficient: the generation compare catches a lookup that started before
    // a rebuild and resolved after it, and the in-flight check catches a
    // lookup that ran entirely inside one.
    const indexStable =
      currentRebuildGeneration() === generationAtLookupStart &&
      !isActiveIndexRebuildInFlight();

    if (indexStable) {
      // Populate cache so GET_INIT_DATA skips IndexedDB. Gated too: the
      // rebuild's `domainRulesCache.clear()` has already run by then, so an
      // ungated write reseeds the memory cache the rebuild just emptied.
      setCachedDomainRules(hostname, bundle);
      await db.putPageBundle(hostname, bundle, activeRuleDataVersion)
        .then(() => db.prunePageBundles(CONFIG.PAGE_BUNDLE_DB_MAX))
        .catch(() => {});
    }
    return bundle;
  } finally {
    _inFlightRules.delete(hostname);
  }
}

/**
 * Is `hostname` covered by `domain`, either exactly or as a subdomain?
 * This is the same containment the scriptlet lookup uses to match rules, and
 * therefore the containment an exclusion has to cancel.
 */
function domainCoversHostname(domain, hostname) {
  return hostname === domain || hostname.endsWith('.' + domain);
}

/**
 * A rule is excluded here if any of its `~domain` entries covers the hostname.
 *
 * Lookup finds rules by walking up the hostname's ancestors, so a rule scoped
 * to youtube.com is returned for music.youtube.com — exactly the subdomain a
 * `~music.youtube.com` exclusion exists to protect. Without this check the
 * exclusion is parsed and stored and then ignored at the one moment it matters.
 */
function isScriptletExcludedForHostname(rule, hostname) {
  const excluded = rule?.excludedDomains;
  if (!excluded?.length) return false;
  return excluded.some((domain) => domainCoversHostname(domain, hostname));
}

async function getScriptletRulesForPage(hostname) {
  const userScriptlets = (await getStorage(StorageKeys.USER_SCRIPTLET_RULES)) || [];
  // §5.25 — the trust gate runs here, before a single spec can be handed to
  // `injectScriptlets`. User filters can never invoke a trust-gated scriptlet,
  // whichever path wrote them (the options textarea or the element picker's
  // renderer-reachable APPEND_USER_FILTER).
  const activeUserScriptlets = filterTrustedScriptlets(userScriptlets.filter(r => {
    if (isScriptletExcludedForHostname(r, hostname)) return false;
    if (r.domains.length === 0) return true;
    return r.domains.some(d => domainCoversHostname(d, hostname));
  }), 'user');

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
  const dbRules = filterTrustedScriptlets(
    (await db.getScriptletRules(hostname))
      .filter((rule) => !isScriptletExcludedForHostname(rule, hostname)),
    'list'
  );
  return [...dbRules, ...activeUserScriptlets];
}
/**
 * Shared allowlist-ancestry check. Walks the hostname's parent domains via the
 * PSL-aware `ancestorDomains` generator, which stops before the first public
 * suffix — so a `co.uk` entry can never blanket a TLD. This is the single
 * JS-side ancestry helper; it intentionally matches the WASM
 * AllowlistMatcher's semantics (docs/REVIEW-2026-07.md §5.8).
 */
function allowlistCoversHostname(allowlistSet, hostname) {
  // §4.8 "Related": exact membership is honored BEFORE the PSL stop. The
  // generator refuses to yield a hostname that is itself a public suffix
  // (e.g. `netlify.app`, a real browsable site), which made an exact
  // allowlist entry for it a silent no-op. Exact match cannot blanket a TLD —
  // only the ancestor walk needs the public-suffix guard.
  if (allowlistSet.has(hostname)) return true;
  for (const candidate of ancestorDomains(hostname)) {
    if (allowlistSet.has(candidate)) return true;
  }
  return false;
}

/** Check if a hostname (or any parent domain) is in the memory-cached allowlist. */
function isHostnameAllowedCached(hostname) {
  hostname = normalizeHostname(hostname);
  if (!hostname) return false;
  if (!cachedAllowlist || cachedAllowlist.size === 0) return false;

  // AllowlistMatcher is built once and checks in O(1) — no Array/string alloc per call.
  if (allowlistMatcher) return allowlistMatcher.check(hostname);

  return allowlistCoversHostname(cachedAllowlist, hostname);
}

/** 
 * Reusable core injection logic.
 * Ensures CSS is injected as early as possible.
 */
async function performEarlyInjection(tabId, frameId, urlStr) {
  if (!urlStr?.startsWith('http')) return;
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return;
  }
  const hostname = normalizeHostname(url.hostname);

  // Wait for critical caches before consulting the allowlist (§5.1). On a
  // cold start the navigation that wakes the SW would otherwise see an empty
  // cachedAllowlist and inject cosmetic CSS into an allowlisted page — with
  // nothing to remove it, since the content script sees isAllowed and bails.
  if (_criticalPromise) await _criticalPromise;

  if (isHostnameAllowedCached(hostname)) return;

  let bundle = domainRulesCache.get(hostname);
  if (!bundle) {
    bundle = await getCosmeticBundleForPage(hostname);
    setCachedDomainRules(hostname, bundle);
  }

  // Re-check after the awaits — the user may have allowlisted the site while
  // the bundle was being built.
  if (isHostnameAllowedCached(hostname)) return;

  const cssText = [
    shouldSkipGenericCosmeticForHostname(hostname, cachedGenericCosmeticExcludedDomains) ? null : cachedGenericCss,
    bundle.cssText,
    bundle.exceptionCss,
  ].filter(Boolean).join('\n');

  if (cssText) {
    await chrome.scripting.insertCSS({
      target: { tabId, frameIds: [frameId] },
      css: cssText,
      origin: 'USER',
    }).catch(() => { });
  }
}

/**
 * Stage 1: onBeforeNavigate (Warm up the cache)
 */
async function handleBeforeNavigate(details) {
  if (!details.url.startsWith('http')) return;

  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  const hostname = normalizeHostname(url.hostname);

  if (details.frameId === 0) {
    resetTabStats(details.tabId, details.url);
  }

  if (!domainRulesCache.has(hostname)) {
    const bundle = await getCosmeticBundleForPage(hostname);
    setCachedDomainRules(hostname, bundle);
  }
}

/**
 * Stage 2: onCommitted (Reliability fallback)
 */
async function handleCommitted(details) {
  await performEarlyInjection(details.tabId, details.frameId || 0, details.url);
}

// Listener bodies route failures to reportError (§5.6): a persistent
// IndexedDB failure otherwise emits one unhandled rejection per navigation
// while GET_ERROR_REPORT keeps showing a healthy extension.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  handleBeforeNavigate(details).catch((err) => reportError('webNavigation', err));
});

chrome.webNavigation.onCommitted.addListener((details) => {
  handleCommitted(details).catch((err) => reportError('webNavigation', err));
});

// ---------------------------------------------------------------------------
// Test-only handles (tests/sw-harness). Do not consume from production code —
// this mirrors the youtube-shield-sync.js convention of exporting private
// seams for the harness. MV3 loads this file as a module service worker, so
// the exports are inert at runtime.
// ---------------------------------------------------------------------------
export const __testHooks = {
  whenCriticalReady: () => _criticalPromise || Promise.resolve(),
  whenBackgroundSetupDone: () => _backgroundSetupPromise || Promise.resolve(),
  // Alarms / rulesets
  scheduleFilterUpdateAlarm,
  applyRulesets,
  CONFIG,
  ALL_KNOWN_LIST_IDS,
  // User filters
  applyUserFilters,
  setAndApplyUserFilters,
  appendUserFilterLine,
  setCompileUserFiltersOverrideForTest: (fn) => { _compileUserFiltersOverride = fn; },
  parseSimpleNetworkRule,
  DNR_USER_FILTER_PRIORITY,
  DNR_ALLOWLIST_PRIORITY,
  DNR_PRIVACY_PRIORITY,
  MAX_USER_FILTERS_DNR_RULES,
  DNR_USER_RULES_START,
  DNR_ALLOWLIST_START,
  // Allowlist
  rebuildAllowlistState,
  applyAllowlistPriorityBand,
  allowSite,
  disallowSite,
  addAllowlistDomains,
  refreshMemoryCache,
  isHostnameAllowedCached,
  allowlistCoversHostname,
  partitionAllowlistInput,
  // Scriptlet boot-key hardening (§4.24)
  seedBootKey,
  verifyScriptletRegistry,
  // Scriptlet trust gate (§5.25) + dispatch diagnostics (§5.22)
  injectScriptlets,
  getScriptletRulesForPage,
  filterTrustedScriptlets,
  TRUSTED_ONLY_SCRIPTLETS,
  TRUSTED_FILTER_LIST_IDS,
  SCRIPTLET_REGISTRY_KEY,
  scriptletDiagnosticsSnapshot,
  // Bloom health (§3.2, second door)
  isBloomEmpty,
  loadBloomFilter,
  // Stats
  restorePersistedStats,
  resetTabStats,
  persistTabStats,
  tabStats,
  getTotals: () => ({ totalBlockedToday, totalBlockedDate }),
  clearInMemoryStatsForTest: () => { tabStats.clear(); totalBlockedToday = 0; },
  cancelPendingStatsPersistForTest: () => {
    if (_persistTimeout) { clearTimeout(_persistTimeout); _persistTimeout = null; }
  },
  // Cosmetic index / navigation
  getCosmeticBundleForPage,
  queueActiveIndexRebuild,
  isActiveIndexRebuildInFlight,
  currentRebuildGeneration,
  isRuleIndexInterrupted,
  RULE_INDEX_STATE_KEY,
  checkFilterListUpdates,
  getActiveRuleDataVersion: () => activeRuleDataVersion,
  performEarlyInjection,
  handleBeforeNavigate,
  handleCommitted,
  db,
  errorReport,
};
