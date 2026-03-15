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
};

/** Get a single value from storage. Returns null if not found. */
export async function getStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      resolve(result[key] ?? null);
    });
  });
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
  return (await getStorage(StorageKeys.ALLOWLIST)) || [];
}

/** Check if a hostname (or any parent domain) is in the allowlist. */
export async function isHostnameAllowed(hostname) {
  const allowlist = await getAllowlist();
  const parts = hostname.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const domain = parts.slice(i).join('.');
    if (allowlist.includes(domain)) return true;
  }
  return false;
}
