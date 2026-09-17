/**
 * filter-list-names.js — the one table of filter-list display names.
 *
 * Consumed by the popup (`src/popup/popup.js`, the list chips) and the options
 * page (`src/options/options.js`, the list cards and the "Update All" status).
 * Plain data, no imports, no DOM: it loads in either page bundle and in Node.
 *
 * Why one table (docs/REVIEW-2026-09.md §5.17): each page hand-maintained its
 * own copy. A list the service worker knows but a copy lacks is simply absent
 * from that page — no chip, no toggle card, no error — and the two copies had
 * drifted in wording. `filter-list-names.test.mjs` checks the ids against the
 * worker's own `ALL_KNOWN_LIST_IDS`, so a list added there fails the suite
 * until it has a row here.
 *
 * Key order is display order on both pages. The built-in `system-unbreak`
 * ruleset (always on, no toggle) deliberately has no row.
 *
 * Plain literals on purpose: a top-level `Object.freeze(...)` call is not
 * dropped for an unused export, so the popup — which imports only the names —
 * would bundle the descriptions as well.
 */

export const FILTER_LIST_NAMES = {
  easylist: 'EasyList',
  easyprivacy: 'EasyPrivacy',
  annoyances: 'Fanboy Annoyances',
  'ubo-cookie-annoyances': 'uBO Cookie Annoyances',
  malware: 'Malware Blocklist',
  'ubo-filters': 'uBO Filters',
  'ubo-unbreak': 'uBO Unbreak',
  'anti-adblock': 'Anti-Adblock',
  'ubo-quick-fixes': 'uBO Quick Fixes',
};

/** One line per list for the options page's cards; same ids as above. */
export const FILTER_LIST_DESCRIPTIONS = {
  easylist: 'The most widely used ad-blocking filter list',
  easyprivacy: 'Tracker, analytics, and surveillance blocking',
  annoyances: 'Cookie notices, popups, social overlays',
  'ubo-cookie-annoyances': 'Surgically targets cookie consent and tracking notices',
  malware: 'Blocks malware and phishing URLs',
  'ubo-filters': 'uBlock Origin default filter list',
  'ubo-unbreak': 'Fixes over-blocking by other lists',
  'anti-adblock': 'Anti-adblock and badware fixes from uBO',
  'ubo-quick-fixes': 'Same-day countermeasures, including the current YouTube ad bypass',
};
