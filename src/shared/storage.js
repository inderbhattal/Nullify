import { normalizeAllowlist, normalizeHostname } from './hostname.js';
import { ancestorDomains } from './psl.js';

/**
 * storage.js — shared storage abstraction
 *
 * Provides typed keys and helpers for chrome.storage.local access.
 * All async — returns Promises.
 */

export const StorageKeys = {
  SETTINGS: 'settings',
  ALLOWLIST: 'allowlist',
  USER_FILTERS: 'userFilters',
  USER_FILTERS_APPLIED: 'userFiltersApplied',
  USER_COSMETIC_RULES: 'userCosmeticRules',
  TAB_STATS: 'tabStats',
  TOTAL_BLOCKED_TODAY: 'totalBlockedToday',
  TOTAL_BLOCKED_DATE: 'totalBlockedDate',
  ENABLED_RULESETS: 'enabledRulesets',
  FILTER_LISTS_META: 'filterListsMeta',
  LAST_UPDATE_CHECK: 'lastUpdateCheck',
  COSMETIC_RULES_VERSION: 'cosmeticRulesVersion',
  COSMETIC_GENERIC_RULES: 'cosmeticGenericRules',
  BLOOM_FILTER: 'bloomFilter',
  GENERIC_CSS: 'genericCss',
  GENERIC_PROCEDURAL_RULES: 'genericProceduralRules',
  GENERIC_COSMETIC_EXCLUDED_DOMAINS: 'genericCosmeticExcludedDomains',
  RULE_DATA_VERSION: 'ruleDataVersion',
  BLOCK_THIRD_PARTY_COOKIES: 'blockThirdPartyCookies',
  FINGERPRINT_PROTECTION: 'fingerprintProtection',
  STRIP_TRACKING_HEADERS: 'stripTrackingHeaders',
  ENHANCED_STEALTH: 'enhancedStealth',
  STEALTH_PERSONA: 'stealthPersona',
  CACHE_PROTECTION: 'cacheProtection',
  REFERRER_CONTROL: 'referrerControl',
  BLOOM_FILL_THRESHOLD: 'bloomFillThreshold',
  USER_SCRIPTLET_RULES: 'userScriptletRules',
};

/** Get multiple values from storage in one call. */
export async function getStorageBulk(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result);
    });
  });
}

/** Get a single value from storage. Returns null if not found. */
export async function getStorage(key) {
  return (await getStorageBulk([key]))[key] ?? null;
}

/** Set a single value in storage. */
export async function setStorage(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

/** Get the current allowlist. */
export async function getAllowlist() {
  return normalizeAllowlist(await getStorage(StorageKeys.ALLOWLIST));
}

/**
 * Check if a hostname (or any non-public-suffix parent domain) is in the
 * allowlist. We deliberately stop ascending at the first public suffix
 * (e.g. `co.uk`) to prevent a rule at that level from blanketing a TLD.
 */
export async function isHostnameAllowed(hostname) {
  const domain = normalizeHostname(hostname);
  if (!domain) return false;

  const allowlist = await getAllowlist();
  const set = new Set(allowlist);

  for (const candidate of ancestorDomains(domain)) {
    if (set.has(candidate)) return true;
  }
  return false;
}
