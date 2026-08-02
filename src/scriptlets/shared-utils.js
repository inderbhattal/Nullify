/**
 * shared-utils.js
 *
 * Common utilities used across scriptlets running in the MAIN world.
 * Keeps logic DRY and prevents subtle divergence in regex construction,
 * escaping, and matching behavior.
 */

/**
 * A pattern is a regex literal only when it both starts AND ends with `/` and
 * anything after the closing slash is a valid flag. Checking only "contains a
 * second slash" made every path-like argument (`/gampad/ads?`) parse as
 * /regex/flags — usually a SyntaxError that silently killed the rule, or worse
 * a valid-flag suffix that silently broadened it.
 */
const REGEX_LITERAL = /^\/(.*)\/([dgimsuvy]*)$/;

/**
 * One random token per page load, used as the message of every abort thrown by
 * a scriptlet. A literal brand string ("AdBlock", "Nullify") in the message is
 * a one-line detector for anti-adblock code; a random token carries no
 * signature and changes on every load — the same reason uBO throws its magic.
 */
export const ABORT_MESSAGE = Math.random().toString(36).slice(2);

/**
 * Convert a pattern string to a RegExp.
 * Supports /regex/flags syntax and plain-string escaping.
 * Returns null only for non-string input; a malformed author regex falls back
 * to matching the raw text literally — an over-broad literal match beats
 * silently disabling the rule.
 */
export function patternToRegex(pattern) {
  if (typeof pattern !== 'string') return null;
  const literal = REGEX_LITERAL.exec(pattern);
  if (literal) {
    try {
      return new RegExp(literal[1], stripStatefulFlags(literal[2]));
    } catch { /* fall through to literal matching */ }
  }
  return new RegExp(escapeRegex(pattern));
}

/**
 * Build a URL/string matcher from a pattern.
 * Supports /regex/flags syntax and plain-string inclusion.
 * Returns a function that accepts a string and returns boolean.
 */
export function toMatcher(pattern) {
  if (typeof pattern === 'string') {
    const literal = REGEX_LITERAL.exec(pattern);
    if (literal) {
      try {
        const re = new RegExp(literal[1], stripStatefulFlags(literal[2]));
        return (url) => re.test(url);
      } catch { /* fall through to substring matching */ }
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
  if (typeof pattern === 'string') {
    const literal = REGEX_LITERAL.exec(pattern);
    if (literal) {
      try {
        return new RegExp(literal[1], literal[2]);
      } catch { /* fall through to literal matching */ }
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
