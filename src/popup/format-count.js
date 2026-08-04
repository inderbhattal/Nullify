/**
 * format-count.js — stat-tile number formatting for the popup.
 *
 * DOM-free so it can be tested; `popup.js` imports its own CSS and cannot be
 * loaded under `node --test`.
 */

/** Above this, the tile shows a capped label and the exact value moves to the tooltip. */
export const COUNT_DISPLAY_CAP = 1000;

/**
 * Render a stat count for a fixed-width tile.
 *
 * The daily total is unbounded — a long browsing session reaches five digits —
 * and the tiles are a three-column grid, so the number outgrows its cell and
 * pushes the layout around. Cap the *label* and keep the exact figure in the
 * tooltip: a user who wants the real number can hover, and the common case
 * stops reflowing the popup.
 *
 * Returns `{ text, title }`, where `title` is `null` when the value is shown in
 * full (so callers can clear a stale tooltip rather than leaving one behind).
 *
 * @param {unknown} value raw count from the service worker
 * @returns {{text: string, title: string|null}}
 */
export function formatStatCount(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
  if (n <= 0) return { text: '0', title: null };
  if (n <= COUNT_DISPLAY_CAP) return { text: String(n), title: null };

  return {
    text: `${COUNT_DISPLAY_CAP}+`,
    // Grouped, because the exact value is the whole reason to hover.
    title: `${n.toLocaleString()} blocked today`,
  };
}
