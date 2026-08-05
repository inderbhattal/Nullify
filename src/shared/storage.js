import { normalizeAllowlist } from './hostname.js';

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

/**
 * Typed error for storage quota failures (chrome.storage.local QUOTA_BYTES,
 * IndexedDB QuotaExceededError). Callers can recognize it via
 * `instanceof StorageQuotaError`, `err.name === 'StorageQuotaError'`, or
 * `err.code === 'QUOTA_EXCEEDED'` and surface it instead of silently
 * diverging from persisted state.
 */
export class StorageQuotaError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StorageQuotaError';
    this.code = 'QUOTA_EXCEEDED';
  }
}

const QUOTA_MESSAGE_RE = /QUOTA_BYTES|quota/i;

/** Returns true when an error represents a storage quota failure. */
export function isQuotaError(err) {
  if (!err) return false;
  if (err instanceof StorageQuotaError) return true;
  if (err.name === 'QuotaExceededError' || err.name === 'StorageQuotaError') return true;
  return QUOTA_MESSAGE_RE.test(String(err.message ?? err));
}

/** Get multiple values from storage in one call. */
export async function getStorageBulk(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      // On a failed read Chrome sets chrome.runtime.lastError and invokes the
      // callback with `undefined`. Resolve with an empty object so getStorage
      // honors its "returns null" contract instead of throwing a TypeError.
      if (chrome.runtime.lastError || !result) {
        resolve({});
        return;
      }
      resolve(result);
    });
  });
}

/** Get a single value from storage. Returns null if not found. */
export async function getStorage(key) {
  return (await getStorageBulk([key]))[key] ?? null;
}

/**
 * Set a single value in storage. Quota failures reject with
 * StorageQuotaError; other failures reject with chrome.runtime.lastError.
 */
export async function setStorage(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const err = chrome.runtime.lastError;
      if (!err) {
        resolve();
      } else if (isQuotaError(err)) {
        reject(new StorageQuotaError(err.message || 'chrome.storage.local quota exceeded'));
      } else {
        reject(err);
      }
    });
  });
}

/** Get the current allowlist. */
export async function getAllowlist() {
  return normalizeAllowlist(await getStorage(StorageKeys.ALLOWLIST));
}
