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
  // `{[name]: boolean}` — runtime feature flags (REMEDIATION-2026-09 §2).
  // Read through getFeatureFlag(); the defaults table lives with the consumer.
  FEATURE_FLAGS: 'featureFlags',
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

/**
 * Typed error for a failed `chrome.storage.local.get` (REVIEW-2026-09 §3.1).
 *
 * A read that fails is NOT a read that found nothing. 2026-07 §5.11 collapsed
 * the two into `{}`, and every read-modify-write downstream (allowlist, user
 * filters, settings, stats, startup defaults) committed that empty result as
 * authoritative. Strict readers reject with this so a writer answers `{error}`
 * and writes nothing; read-only consumers use the `...OrEmpty` /
 * `...OrDefault` variants below and keep degrading quietly.
 */
export class StorageReadError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StorageReadError';
    this.code = 'READ_FAILED';
  }
}

/**
 * Get multiple values from storage in one call. STRICT: rejects with
 * StorageReadError when Chrome reports the read failed (`runtime.lastError`).
 * An `undefined` result WITHOUT lastError is "empty", not "failed", and still
 * resolves `{}` (the 2026-07 §5.11 TypeError guard).
 */
export async function getStorageBulk(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new StorageReadError(err.message || 'chrome.storage.local read failed'));
        return;
      }
      resolve(result ?? {});
    });
  });
}

/**
 * Get a single value from storage. STRICT (inherits getStorageBulk's
 * rejection). Returns null if not found.
 */
export async function getStorage(key) {
  return (await getStorageBulk([key]))[key] ?? null;
}

/**
 * LENIENT bulk read for consumers that write nothing based on the result:
 * a failed read resolves `{}` exactly as it did before §3.1.
 */
export async function getStorageBulkOrEmpty(keys) {
  try {
    return await getStorageBulk(keys);
  } catch (err) {
    if (err instanceof StorageReadError) return {};
    throw err;
  }
}

/**
 * LENIENT single read: `fallback` for a missing key AND for a failed read.
 * Only for read-only consumers — never feed the result into a write.
 */
export async function getStorageOrDefault(key, fallback = null) {
  try {
    return (await getStorage(key)) ?? fallback;
  } catch (err) {
    if (err instanceof StorageReadError) return fallback;
    throw err;
  }
}

/**
 * Read one runtime feature flag (lenient: a failed read yields the default).
 * Only a stored boolean overrides `defaultValue`.
 */
export async function getFeatureFlag(name, defaultValue = false) {
  const flags = await getStorageOrDefault(StorageKeys.FEATURE_FLAGS, null);
  if (flags && typeof flags === 'object' && typeof flags[name] === 'boolean') {
    return flags[name];
  }
  return defaultValue;
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
