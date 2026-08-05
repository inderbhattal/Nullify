/**
 * Hostname normalization helpers used by the allowlist and site-scoped lookups.
 */
import { isPublicSuffix } from './psl.js';

/**
 * Convert a user-entered hostname or URL-ish string into a canonical hostname.
 * We intentionally collapse `www.example.com` to `example.com` so allowlisting
 * the common host also covers the apex site.
 *
 * @param {string} input
 * @param {{ stripWww?: boolean }} [options]
 * @returns {string}
 */
export function normalizeHostname(input, { stripWww = true } = {}) {
  if (typeof input !== 'string') return '';

  let value = input.trim().toLowerCase();
  if (!value) return '';

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `${value.startsWith('//') ? 'http:' : 'http://'}${value}`;

  try {
    const url = new URL(withScheme);
    value = url.hostname.toLowerCase();
  } catch {
    const cutoff = value.search(/[/?#]/);
    if (cutoff !== -1) value = value.slice(0, cutoff);
    value = value.replace(/^[^@]*@/, '');

    const colonCount = (value.match(/:/g) || []).length;
    if (colonCount === 1) {
      value = value.replace(/:\d+$/, '');
    }
  }

  value = value.replace(/^\.+|\.+$/g, '');

  if (stripWww && value.startsWith('www.') && value.includes('.', 4)) {
    const stripped = value.slice(4);
    // Don't collapse www.<public-suffix> — e.g. `www.co.uk` must not become
    // the bare suffix `co.uk`, which would allowlist every site on that TLD.
    if (!isPublicSuffix(stripped)) {
      value = stripped;
    }
  }

  return value;
}

/**
 * Server-side validation for a single (already-normalized) allowlist entry
 * (REVIEW-2026-07 §4.8). `normalizeHostname` is a canonicalizer, not a
 * validator: it happily returns `com`, `co.uk`, or `foo bar`. A bare public
 * suffix that reaches the DNR builder becomes `||co.uk^` + allowAllRequests —
 * a TLD-wide blocking bypass that the matchers (which stop at public
 * suffixes) never report, so the UI keeps saying "Protected".
 *
 * Rules, per the review's prescription:
 *  - charset `/^[a-z0-9.-]+$/`, length ≤ 253, non-empty labels;
 *  - at least one dot (dotted-quad IPv4 literals therefore pass; IPv6
 *    literals contain ':' and fail the charset check — DNR `||<domain>^`
 *    anchors don't support them meaningfully anyway);
 *  - never a public suffix (`com`, `co.uk`, `netlify.app`, …).
 *
 * Callers should pass the output of `normalizeHostname`; raw user input is
 * accepted but not canonicalized here.
 *
 * @param {unknown} domain
 * @returns {boolean}
 */
export function isValidAllowlistDomain(domain) {
  if (typeof domain !== 'string' || !domain) return false;
  if (domain.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(domain)) return false;
  // No empty labels ("a..b", ".a", "a.") and no oversized labels.
  const labels = domain.split('.');
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  if (!domain.includes('.')) return false;
  if (isPublicSuffix(domain)) return false;
  return true;
}

/**
 * Normalize and dedupe an allowlist array while preserving insertion order.
 *
 * @param {unknown} domains
 * @returns {string[]}
 */
export function normalizeAllowlist(domains) {
  const seen = new Set();
  const normalized = [];

  for (const domain of Array.isArray(domains) ? domains : []) {
    const value = normalizeHostname(domain);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}
