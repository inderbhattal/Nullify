/**
 * proc-ops.js — the one list of procedural (uBO-dialect) cosmetic operators.
 *
 * Consumed by the content engine (`src/content/cosmetic-engine.js`), the
 * content entry point (`src/content/content-main.js`), the service worker's
 * JS planner and CSS gate, and pinned equal to the Rust core's
 * `PROC_OP_NAMES` by `tests/wasm-parity.test.mjs`. Plain ESM, no DOM: it must
 * load in a worker, a content script and Node alike.
 *
 * Why one list (docs/REVIEW-2026-09.md §3.2): four hand-kept JS copies and two
 * Rust copies drifted apart. An operator missing from a copy is not "ignored" —
 * the CSS gate treats `div:others(.x)` as a valid selector, the joiner
 * comma-joins it with every other hide rule on the site, and the browser
 * discards the whole declaration. 191 rules on 289 domains did exactly that.
 *
 * Every name here is *tokenised* as procedural. Whether the engine implements
 * it is a separate question: `_applyOp` fails closed on anything it does not
 * implement, which under-blocks the one rule instead of killing its
 * neighbours.
 */

/**
 * Operator names, longest-first within a shared prefix (`matches-css-before`
 * before `matches-css`, `remove-attr` before `remove`, `if-not` before `if`)
 * so a prefix scan never matches a shorter name inside a longer one. Same
 * names, same order as the Rust `PROC_OP_NAMES`.
 */
export const PROC_OPS = Object.freeze([
  'matches-css-before',
  'matches-css-after',
  'matches-css',
  'has-text',
  'nth-ancestor',
  'upward',
  'min-text-length',
  'xpath',
  'watch-attr',
  'remove-attr',
  'remove-class',
  'remove',
  'style',
  'matches-path',
  'matches-attr',
  'matches-media',
  'matches-prop',
  'shadow',
  'others',
  '-abp-properties',
  '-abp-contains',
  '-abp-has',
  'if-not',
  'if',
  'semantic',
]);

/**
 * Adblock Plus spellings of uBO operators. They are tokenised under their own
 * name (so a plan from the Rust planner may carry `-abp-has`) and resolved to
 * the canonical uBO name by the JS planner and by `_applyOp`.
 */
export const PROC_OP_ALIASES = Object.freeze({
  '-abp-has': 'has',
  '-abp-contains': 'has-text',
  '-abp-properties': 'matches-css',
});

/**
 * Functional pseudo-classes the browser implements. A single-colon functional
 * pseudo-class that is neither one of these nor a procedural operator is
 * invalid CSS and must be refused by the CSS gates (SW mirror, A1b; Rust,
 * B1) rather than joined into a declaration.
 */
export const NATIVE_FUNCTIONAL_PSEUDO_CLASSES = new Set([
  'not',
  'is',
  'where',
  'has',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'nth-col',
  'nth-last-col',
  'lang',
  'dir',
  'host',
  'host-context',
  'state',
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches `:<operator>(` anywhere in a selector, case-insensitively — the
 * Rust matcher is case-insensitive too, so `DIV:Has-Text(x)` is a plan in
 * both engines rather than CSS in one and a plan in the other.
 */
export const PROC_OP_REGEX = new RegExp(`:(?:${PROC_OPS.map(escapeRegex).join('|')})\\(`, 'i');

/** Does the selector string contain any procedural operator call? */
export function isProceduralSelector(selector) {
  return typeof selector === 'string' && PROC_OP_REGEX.test(selector);
}
