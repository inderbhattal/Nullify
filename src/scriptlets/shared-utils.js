/**
 * shared-utils.js
 *
 * Common utilities used across scriptlets running in the MAIN world.
 * Keeps logic DRY and prevents subtle divergence in regex construction,
 * escaping, and matching behavior.
 */

/**
 * Convert a pattern string to a RegExp.
 * Supports /regex/flags syntax and plain-string escaping.
 * Returns null on invalid regex.
 */
export function patternToRegex(pattern) {
  if (typeof pattern !== 'string') return null;
  try {
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const lastSlash = pattern.lastIndexOf('/');
      return new RegExp(
        pattern.slice(1, lastSlash),
        stripStatefulFlags(pattern.slice(lastSlash + 1)),
      );
    }
    return new RegExp(escapeRegex(pattern));
  } catch {
    return null;
  }
}

/**
 * Build a URL/string matcher from a pattern.
 * Supports /regex/flags syntax and plain-string inclusion.
 * Returns a function that accepts a string and returns boolean.
 */
export function toMatcher(pattern) {
  if (typeof pattern === 'string' && pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    try {
      const re = new RegExp(
        pattern.slice(1, lastSlash),
        stripStatefulFlags(pattern.slice(lastSlash + 1)),
      );
      return (url) => re.test(url);
    } catch {
      return () => false;
    }
  }
  return (url) => url.includes(pattern);
}

/**
 * Convert a pattern string to a RegExp for find/replace operations.
 * Supports /regex/flags syntax and plain-string escaping (global by default).
 */
export function toRegex(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern === 'string' && pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    try {
      return new RegExp(pattern.slice(1, lastSlash), pattern.slice(lastSlash + 1));
    } catch {
      return new RegExp(escapeRegex(pattern), 'g');
    }
  }
  return new RegExp(escapeRegex(pattern), 'g');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drop `g`/`y` from a flag string.
 *
 * `RegExp.prototype.test` advances `lastIndex` on a stateful regex. Matchers
 * built here are held for the lifetime of the page and reused across every
 * request, so a stateful flag makes every second matching call return false.
 * `toRegex` deliberately does NOT use this — it feeds `String.replace`, which
 * needs `g` to replace more than the first occurrence.
 */
function stripStatefulFlags(flags) {
  return flags.replace(/[gy]/g, '');
}
