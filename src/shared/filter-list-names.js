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
 * Every name is checked against its list's own `! Title:` header in the
 * vendored snapshot (`filter-list-names.test.mjs`), because a table of
 * literals cannot be checked against itself. Two names were wrong when the
 * two pages were merged: `annoyances` is uAssets' own annoyances list, meant
 * to be used ALONGSIDE Fanboy's and AdGuard's, not Fanboy's own; and
 * `anti-adblock` is a historical id for uBO's badware.txt, which is about
 * sites that harm the user, not about anti-adblock walls.
 *
 * Plain literals on purpose: a top-level `Object.freeze(...)` call is not
 * dropped for an unused export, so the popup — which imports only the names —
 * would bundle the descriptions as well.
 */

export const FILTER_LIST_NAMES = {
  easylist: 'EasyList',
  easyprivacy: 'EasyPrivacy',
  annoyances: 'uBO Annoyances',
  'ubo-cookie-annoyances': 'uBO Cookie Notices',
  malware: 'Malicious URLs',
  'ubo-filters': 'uBO Filters',
  'ubo-unbreak': 'uBO Unbreak',
  'anti-adblock': 'uBO Badware Risks',
  'ubo-quick-fixes': 'uBO Quick Fixes',
};

/** One line per list for the options page's cards; same ids as above. */
export const FILTER_LIST_DESCRIPTIONS = {
  easylist: 'The most widely used ad-blocking filter list',
  easyprivacy: 'Tracker, analytics, and surveillance blocking',
  annoyances: 'Social widgets, overlays and in-page nags',
  'ubo-cookie-annoyances': 'Cookie consent banners and tracking notices',
  malware: 'Malicious URLs from URLhaus — blocks the navigation, not just subresources',
  'ubo-filters': 'uBlock Origin default filter list',
  'ubo-unbreak': 'Fixes over-blocking by other lists',
  'anti-adblock': 'Sites documented to push adware or steal credentials — most block the navigation, not just subresources',
  'ubo-quick-fixes': 'Same-day countermeasures, including the current YouTube ad bypass',
};
