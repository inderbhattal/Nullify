/**
 * Hostname normalization helpers used by the allowlist and site-scoped lookups.
 */

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
    value = value.slice(4);
  }

  return value;
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
