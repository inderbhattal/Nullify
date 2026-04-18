import { normalizeAllowlist, normalizeHostname } from './hostname.js';

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
  ENABLED_RULESETS: 'enabledRulesets',
  FILTER_LISTS_META: 'filterListsMeta',
  LAST_UPDATE_CHECK: 'lastUpdateCheck',
  COSMETIC_RULES_VERSION: 'cosmeticRulesVersion',
  COSMETIC_GENERIC_RULES: 'cosmeticGenericRules',
  BLOOM_FILTER: 'bloomFilter',
  GENERIC_CSS: 'genericCss',
  BLOCK_THIRD_PARTY_COOKIES: 'blockThirdPartyCookies',
  FINGERPRINT_PROTECTION: 'fingerprintProtection',
  STRIP_TRACKING_HEADERS: 'stripTrackingHeaders',
  ENHANCED_STEALTH: 'enhancedStealth',
  STEALTH_PERSONA: 'stealthPersona',
  CACHE_PROTECTION: 'cacheProtection',
  REFERRER_CONTROL: 'referrerControl',
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

/** Check if a hostname (or any parent domain) is in the allowlist. */
export async function isHostnameAllowed(hostname) {
  let domain = normalizeHostname(hostname);
  if (!domain) return false;

  const allowlist = await getAllowlist();

  while (domain) {
    if (allowlist.includes(domain)) return true;
    const dotIdx = domain.indexOf('.');
    if (dotIdx === -1) break;
    domain = domain.slice(dotIdx + 1);
  }

  return false;
}
