import { patternToRegex } from './shared-utils.js';

/**
 * hide-window-error.js
 *
 * Prevents specific error messages from appearing in the console.
 * Useful for suppressing noisy errors from blocked tracking scripts.
 *
 * Args:
 *   1. pattern - String or /regex/ to match in the error message.
 */
export function hideWindowError(pattern) {
  if (!pattern) return;

  const matchError = patternToRegex(pattern);

  const origError = window.onerror;
  window.onerror = function (msg, _url, _line, _col, _error) {
    const message = msg?.message || msg || '';
    const shouldHide = matchError ? matchError.test(message) : message.includes(pattern);

    if (shouldHide) {
      return true; // Prevents the default error handling
    }

    if (origError) {
      return origError.apply(this, arguments);
    }
  };

  // Also intercept console.error
  const origConsoleError = console.error;
  console.error = function (...args) {
    const message = args.join(' ');
    const shouldHide = matchError ? matchError.test(message) : message.includes(pattern);

    if (shouldHide) return;

    return origConsoleError.apply(this, args);
  };
}
