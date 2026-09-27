/**
 * element-picker.js
 *
 * Interactive element picker — works like uBlock Origin's element picker.
 *
 * Flow:
 *  1. Popup sends ACTIVATE_PICKER message
 *  2. Picker mode activates: hover highlights elements with a blue outline
 *  3. Click → open picker dialog showing multiple selector options + match count
 *  4. User picks/edits selector → "Create rule" adds it to My Filters via SW
 *  5. Page re-hides matching elements immediately (no reload needed)
 *  6. ESC or ✕ cancels without saving
 */

import { isProceduralSelector, PROC_OP_REGEX, NATIVE_FUNCTIONAL_PSEUDO_CLASSES } from '../shared/proc-ops.js';
import { normalizeHostname } from '../shared/hostname.js';
import { isPublicSuffix } from '../shared/psl.js';

const PICKER_HIGHLIGHT_ID = '__adblock_picker_highlight__';
const PICKER_OVERLAY_ID   = '__adblock_picker_overlay__';
const PICKER_DIALOG_ID    = '__adblock_picker_dialog__';
const PICKER_STYLE_ID     = '__adblock_picker_style__';

// PICKER-2026-09 PK5. The preview and a saved rule's immediate hide go through
// picker-owned stylesheets, never an inline `style.display` the page can read
// or clear. The preview sheet (and every mark a procedural preview sets) goes
// on cancel, save and deactivate; the applied sheet stands in for the saved
// rule until a reload, as the inline write did. Named per session. A network
// block hides only the element whose request it stops, so its preview and its
// post-save hide mark that element (the applied mark stays until a reload)
// rather than borrow a cosmetic selector that can match others (review R4).
const PICKER_SESSION = Math.random().toString(36).slice(2, 10);
const PREVIEW_SHEET_ID = `__adblock_picker_preview_${PICKER_SESSION}`;
const APPLIED_SHEET_ID = `__adblock_picker_applied_${PICKER_SESSION}`;
const PREVIEW_MARK = `data-adblock-picker-preview-${PICKER_SESSION}`;
const APPLIED_MARK = `data-adblock-picker-applied-${PICKER_SESSION}`;
let markedNodes = [];

let pickerActive = false;
let lastTarget = null;
let navStack = [];
let currentNavTarget = null;

// Every key event is swallowed while the picker is up, so the page's own
// single-key shortcuts (YouTube's k/j/space/f) cannot fire while the user
// types a selector (§5.17).
const KEY_EVENTS = ['keydown', 'keypress', 'keyup'];
// `click` alone left mousedown/pointerdown reaching the page (§5.17).
const POINTER_EVENTS = ['mousedown', 'pointerdown'];

/** True in a subframe. The picker is a top-frame-only UI (§4.24). */
function isSubframe() {
  return typeof window !== 'undefined' && window.top !== window;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * @param {{allowInFrame?: boolean}} [options] `allowInFrame` opts a subframe in
 *   explicitly. Without it a broadcast `ACTIVATE_PICKER` (the message carries
 *   no frameId today) mounted a full-viewport overlay in every iframe on the
 *   page, and ESC — which does not cross frame boundaries — could only dismiss
 *   the focused one (§4.24).
 */
export function activatePicker(options = {}) {
  if (pickerActive) return;
  if (isSubframe() && options?.allowInFrame !== true) return;
  pickerActive = true;
  navStack = [];
  currentNavTarget = null;
  injectPickerStyles();
  createOverlay();
  document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
  document.addEventListener('click', onClick, { capture: true });
  for (const type of KEY_EVENTS) document.addEventListener(type, onKeyEvent, { capture: true });
  for (const type of POINTER_EVENTS) document.addEventListener(type, onPointerDown, { capture: true });
  showPickerToast('🎯 Click any element to create a blocking rule. Press ESC to cancel.');
}

export function deactivatePicker() {
  if (!pickerActive) return;
  pickerActive = false;
  document.removeEventListener('mousemove', onMouseMove, { capture: true });
  document.removeEventListener('click', onClick, { capture: true });
  for (const type of KEY_EVENTS) document.removeEventListener(type, onKeyEvent, { capture: true });
  for (const type of POINTER_EVENTS) document.removeEventListener(type, onPointerDown, { capture: true });
  lastTarget = null;
  navStack = [];
  currentNavTarget = null;
  clearPreview();
  removeHighlight();
  removeOverlay();
  removeDialog();
  removePickerStyles();
}

// ---------------------------------------------------------------------------
// Styles injection
// ---------------------------------------------------------------------------
function injectPickerStyles() {
  if (document.getElementById(PICKER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PICKER_STYLE_ID;
  style.textContent = `
    #${PICKER_HIGHLIGHT_ID} {
      position: fixed;
      pointer-events: none;
      z-index: 2147483645;
      border: 2px dashed #58a6ff;
      background: rgba(88, 166, 255, 0.08);
      border-radius: 3px;
      box-shadow: 0 0 0 2000px rgba(0,0,0,0.12);
      transition: all 60ms ease;
    }
    #${PICKER_OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483644;
      cursor: crosshair;
    }
    #${PICKER_DIALOG_ID} {
      position: fixed;
      z-index: 2147483646;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(520px, 95vw);
      max-height: 90vh;
      overflow-y: auto;
      background: #161b22;
      color: #e6edf3;
      border: 1px solid #30363d;
      border-radius: 12px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.6);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
    }
    .__adblock_picker_toast__ {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483646;
      background: #161b22;
      color: #e6edf3;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 10px 16px;
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      pointer-events: none;
      animation: __adblock_fadein__ 0.2s ease;
    }
    @keyframes __adblock_fadein__ { from { opacity:0; transform: translateX(-50%) translateY(10px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }
  `;
  document.documentElement.appendChild(style);
}

function removePickerStyles() {
  document.getElementById(PICKER_STYLE_ID)?.remove();
}

// ---------------------------------------------------------------------------
// Highlight element
// ---------------------------------------------------------------------------
function createHighlight() {
  let el = document.getElementById(PICKER_HIGHLIGHT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = PICKER_HIGHLIGHT_ID;
    document.documentElement.appendChild(el);
  }
  return el;
}

function updateHighlight(target) {
  if (!target || target === document.documentElement || target === document.body) {
    removeHighlight();
    return;
  }
  const rect = target.getBoundingClientRect();
  const highlight = createHighlight();
  highlight.style.cssText = `
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    pointer-events: none;
    z-index: 2147483645;
    border: 2px dashed #58a6ff;
    background: rgba(88, 166, 255, 0.08);
    border-radius: 3px;
  `;
}

function removeHighlight() {
  document.getElementById(PICKER_HIGHLIGHT_ID)?.remove();
}

// ---------------------------------------------------------------------------
// Transparent overlay (captures mouse events, passes pointer to real elements)
// ---------------------------------------------------------------------------
function createOverlay() {
  let el = document.getElementById(PICKER_OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = PICKER_OVERLAY_ID;
    document.documentElement.appendChild(el);
  }
}

function removeOverlay() {
  document.getElementById(PICKER_OVERLAY_ID)?.remove();
}

/**
 * The overlay used to be removed the moment the dialog opened, after which
 * every press landed on the page's own handlers. Keep it mounted and just stop
 * it from swallowing pointer events aimed at the dialog (§5.17).
 */
function disableOverlayPointerEvents() {
  const overlay = document.getElementById(PICKER_OVERLAY_ID);
  if (!overlay) return;
  overlay.style.pointerEvents = 'none';
}

/**
 * Pierces Shadow DOM to find the deepest element at a given point.
 */
function getDeepElementFromPoint(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const deeper = el.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === el) break;
    el = deeper;
  }
  return el;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
function onMouseMove(e) {
  // Skip only if the event lands on the picker dialog or toast (user-interactive UI).
  // The overlay and highlight are NOT skipped — we use elementFromPoint to see through them.
  if (isPickerDialog(e.target)) return;

  // Temporarily hide overlay + highlight to get true element under cursor
  const overlay = document.getElementById(PICKER_OVERLAY_ID);
  const highlight = document.getElementById(PICKER_HIGHLIGHT_ID);
  if (overlay) overlay.style.display = 'none';
  if (highlight) highlight.style.display = 'none';
  
  const target = getDeepElementFromPoint(e.clientX, e.clientY);
  
  if (overlay) overlay.style.display = '';
  if (highlight) highlight.style.display = '';

  if (target && target !== lastTarget && !isPickerDialog(target)) {
    lastTarget = target;
    updateHighlight(target);
  }
}

function onClick(e) {
  // Let clicks on the dialog through — don't intercept them
  if (isPickerDialog(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  // Temporarily hide overlay + highlight to get true element under cursor
  const overlay = document.getElementById(PICKER_OVERLAY_ID);
  const highlight = document.getElementById(PICKER_HIGHLIGHT_ID);
  if (overlay) overlay.style.display = 'none';
  if (highlight) highlight.style.display = 'none';
  
  const target = getDeepElementFromPoint(e.clientX, e.clientY);
  
  if (overlay) overlay.style.display = '';
  if (highlight) highlight.style.display = '';

  if (!target || isPickerDialog(target)) return;

  // Pause hover tracking while dialog is open. The overlay stays mounted so
  // later presses keep being intercepted; it just stops eating the dialog's
  // own pointer events (§5.17).
  document.removeEventListener('mousemove', onMouseMove, { capture: true });
  disableOverlayPointerEvents();

  openPickerDialog(target);
}

/** Swallow an event so no page handler ever sees it. */
function suppressEvent(e) {
  e.preventDefault?.();
  e.stopPropagation?.();
  e.stopImmediatePropagation?.();
}

function onKeyEvent(e) {
  if (!pickerActive) return;

  if (e.key === 'Escape') {
    if (e.type === 'keydown') {
      deactivatePicker();
      showPickerToast('❌ Element picker cancelled');
      setTimeout(() => document.querySelector('.__adblock_picker_toast__')?.remove(), 2000);
    }
    suppressEvent(e);
    return;
  }

  // Keys the dialog needs. They must reach it, so nothing is stopped here at
  // capture time — `stopDialogEvent` (bubble phase, on the dialog itself)
  // keeps them from continuing on to the page (§5.17).
  if (isPickerDialog(e.target)) return;

  suppressEvent(e);
}

function onPointerDown(e) {
  if (!pickerActive || isPickerDialog(e.target)) return;
  suppressEvent(e);
}

/**
 * Bubble-phase stopper mounted on the dialog element: the event has already
 * reached the input (so typing and button clicks work) but never continues to
 * the page's document-level handlers (§5.17).
 */
function stopDialogEvent(e) {
  e.stopPropagation?.();
}

/** Returns true only for the dialog and toast — UI the user clicks on directly. */
function isPickerDialog(el) {
  return el?.closest(
    `#${PICKER_DIALOG_ID}, .__adblock_picker_toast__`
  ) !== null;
}

// ---------------------------------------------------------------------------
// Selector generation
// ---------------------------------------------------------------------------

/**
 * Finds all elements matching a selector, including those inside Shadow Roots.
 * Iterative version for better performance and safety.
 */
function deepQuerySelectorAll(selector, root = document) {
  const results = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    
    // Query current root
    try {
      const matches = current.querySelectorAll(selector);
      for (const m of matches) results.push(m);
    } catch { /* invalid selector */ }

    // Find children with shadow roots to continue traversal
    // Note: we only need to find elements that COULD have a shadowRoot
    const children = current.querySelectorAll('*');
    for (const el of children) {
      if (el.shadowRoot) {
        queue.push(el.shadowRoot);
      }
    }
  }
  return results;
}

/**
 * True when a selector matches only inside shadow roots: the picker's
 * shadow-piercing preview shows hits, but a saved document-level CSS rule
 * could never reach them — the rule would be dead on arrival (§5.30).
 */
export function isShadowOnlySelector(selector) {
  try {
    if (document.querySelectorAll(selector).length > 0) return false;
    return deepQuerySelectorAll(selector).length > 0;
  } catch {
    return false;
  }
}

/**
 * Can `selector` be saved as a `##` rule that will actually run? A line is
 * lost two independent ways: the browser cannot parse the selector — joined
 * into the site's one CSS declaration, it voids every other hide rule there
 * (REVIEW-2026-09 §3.2) — or the compiler refuses it, without a `droppedLines`
 * entry, so the save would report "Rule saved" for a dead line
 * (PICKER-2026-09 PK1b). And SW1's APPEND gate refuses some lines outright
 * for the characters in them (PK2c). A plain selector must also pass the
 * compiler's CSS gate, which is stricter than the browser's parse (review R3).
 *
 * A procedural selector skips the parse test. The browser rejects it
 * whole (`:has-text(` is not CSS), and it never reaches the joined
 * declaration: the compiler plans every `:op(` match per rule, and the engine
 * isolates each plan, so a bad base disables only its own rule. Checking its
 * CSS "the way the engine plans it" would need a copy of the planner here.
 */
function isSaveableSelector(selector) {
  if (!gateAdmitsSelectorText(selector) || !compilerKeepsSelector(selector)) return false;
  if (isProceduralSelector(selector)) return true;
  if (!compilerKeepsAsCss(selector)) return false;
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

// Mirrors the line-level half of SW1's APPEND gate (`isPickerSafeUserFilterLine`
// in the service worker), which reads a line as both trims read it. JS `trim()`
// and Rust's `str::trim` must agree where it ends (they part on U+0085 and
// U+FEFF), and the agreed line may hold no control, line or paragraph
// separator, lone surrogate or extended-syntax marker (`#@ #? #$ #% #+`), nor
// end in an odd run of backslashes; and the selector may hold no `/*`, even
// in a procedural one. A cosmetic line is `site##` and then the
// selector, so the selector's end is the line's (PICKER-2026-09 PK2c).
function gateAdmitsSelectorText(selector) {
  const stored = selector.trimEnd();
  if (stored !== selector.replace(/\p{White_Space}+$/u, '')) return false;
  if (/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(stored) || /#[@?$%+]/.test(`#${stored}`)) return false;
  if (selector.includes('/*')) return false;
  return stored.match(/\\*$/)[0].length % 2 === 0;
}

/**
 * `CSS.escape` for a class or id, with any characters at its end that a trim
 * would strip hex-escaped instead. The gate stores a line trimmed, and
 * `CSS.escape` leaves U+0080 and up raw, so a page's class `ad` + U+00A0 was
 * offered as that and stored as `.ad`: a broader rule than the one previewed.
 * A hex escape's closing space may go to the trim, as the escape reads the
 * same without it (PICKER-2026-09 PK2c).
 */
function escapeIdent(name) {
  const chars = [...name];
  let end = chars.length;
  while (end > 0 && trimStrips(chars[end - 1])) end--;
  return CSS.escape(chars.slice(0, end).join('')) +
    chars.slice(end).map((ch) => `\\${ch.codePointAt(0).toString(16)} `).join('');
}

/** Would JS `trim()` or Rust's `str::trim` strip `ch` from the end of a line? */
function trimStrips(ch) {
  return /\p{White_Space}/u.test(ch) || ch.charCodeAt(0) === 0xfeff;
}

// Mirrors `is_valid_selector` in wasm-core/src/lib.rs, the source of truth:
// change the two together. Rust's `trim()` strips every White_Space code
// point, U+0085 included, which JS `trim()` keeps. Exported so a test pins
// the mirror directly, not only through a save.
export function compilerKeepsSelector(selector) {
  const s = selector.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  if (!s || /[{}\0]/.test(s)) return false;
  return !s.includes(';') || semicolonsInProcOpArgs(s);
}

// Mirrors `semicolons_confined_to_proc_op_args`: every `;` must sit inside a
// procedural operator's argument, which ends where paren depth returns to
// zero (`find_matching_paren` — no quote or escape handling, as there).
function semicolonsInProcOpArgs(s) {
  let idx = 0;
  while (idx < s.length) {
    const m = PROC_OP_REGEX.exec(s.slice(idx));
    if (!m) return !s.slice(idx).includes(';');
    if (s.slice(idx, idx + m.index).includes(';')) return false;
    let i = idx + m.index + m[0].length;
    for (let depth = 1; depth > 0; i++) {
      if (i >= s.length) return false; // the operator never closes
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
    }
    idx = i;
  }
  return true;
}

// Mirrors `is_css_safe_selector` in wasm-core/src/lib.rs, the source of truth
// for which plain selectors compile to CSS: change the two together. The
// engine drops the rest without a `droppedLines` entry, and the browser parses
// several of them: it closes an open bracket, paren or string at the end of
// the input, reads a `/*` as a comment (one that in the joined sheet swallows
// every rule after it) and knows pseudo-elements the engine does not (review
// R3). Exported so a test pins the mirror directly, and the cross-check pins it
// against the WASM build.
export function compilerKeepsAsCss(selector) {
  const s = selector.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  return !s.includes('/*') && compilerKeepsSelector(s) && !isProceduralSelector(s) &&
    hasBalancedDelimiters(s) && !hasInvalidUniversalUsage(s) && !/^[>+~,]/.test(s);
}

// `has_balanced_selector_delimiters`: brackets, parens and quotes all close,
// skipping escapes and quoted text, with no bracket inside another.
function hasBalancedDelimiters(s) {
  let brackets = 0;
  let parens = 0;
  let quote = null;
  let escaped = false;
  for (const ch of s) {
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') { if (brackets++ > 0) return false; }
    else if (ch === ']') { if (brackets-- === 0) return false; }
    else if (ch === '(') parens++;
    else if (ch === ')') { if (parens-- === 0) return false; }
    else if (ch === '{' || ch === '}') return false;
  }
  return quote === null && brackets === 0 && parens === 0;
}

// Rust's `KNOWN_PSEUDO_ELEMENTS`, matched ASCII case-blind.
const KNOWN_PSEUDO_ELEMENTS = ['::before', '::after', '::first-line', '::first-letter', '::selection',
  '::backdrop', '::placeholder', '::marker', '::cue', '::slotted', '::part', '::file-selector-button'];

const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// `has_invalid_universal_usage`, walked by code point as Rust walks chars: a
// `*` glued to a name or a closing bracket or followed by a stray, an unknown
// pseudo-element (a known name must not run on into an identifier), a
// functional pseudo-class no browser implements, or a stray `]` or `)`.
function hasInvalidUniversalUsage(s) {
  const chars = [...s];
  let brackets = 0;
  let parens = 0;
  let quote = null;
  let escaped = false;
  let prev = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const before = prev;
    prev = ch;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[') brackets++;
    else if (ch === ']') { if (--brackets < 0) return true; }
    else if (ch === '(') parens++;
    else if (ch === ')') { if (--parens < 0) return true; }
    else if (ch === '*' && brackets === 0 && parens === 0) {
      if (before !== null && /[A-Za-z0-9_\-)\]]/.test(before)) return true;
      const next = chars.slice(i + 1).find((c) => !/\p{White_Space}/u.test(c));
      if (next !== undefined && !/[A-Za-z0-9#.[:>+~,]/.test(next)) return true;
    } else if (ch === ':' && chars[i + 1] === ':') {
      const rest = chars.slice(i).join('');
      const known = KNOWN_PSEUDO_ELEMENTS.some((p) => asciiLower(rest.slice(0, p.length)) === p &&
        !/^(?:[A-Za-z0-9_\\-]|[^\0-\x7f])/u.test(rest.slice(p.length)));
      if (!known) return true;
    } else if (ch === ':' && brackets === 0 && before !== ':') {
      const name = /^[A-Za-z_-][A-Za-z0-9_-]*\(/.exec(chars.slice(i + 1).join(''));
      if (name && !NATIVE_FUNCTIONAL_PSEUDO_CLASSES.has(asciiLower(name[0].slice(0, -1)))) return true;
    }
  }
  return false;
}

/**
 * The site a picked rule is scoped to — the cosmetic `site##` prefix and the
 * network `domain=` alike. `normalizeHostname` drops a leading `www.` only
 * when what remains is not a public suffix: the old `replace(/^www\./, '')`
 * cut the registrable `www.ck` to the suffix `ck`, scoping the rule to every
 * `.ck` site (PICKER-2026-09 PK2a).
 */
function siteScope() {
  return normalizeHostname(location.hostname);
}

/**
 * Why SW1's gate will not scope a rule to `site`, or null when it will: the
 * gate takes only a plain lower-case hostname that reaches no further than one
 * site (`isPickerScopeTooBroad`). The dialog then unchecks and disables
 * "Apply only to <site>" and says why, as a scoped line would be refused
 * (review R5).
 */
function scopeRefusal(site) {
  if (!site || !SITE_HOSTNAME.test(site)) return 'its name can\'t scope a rule';
  if (isPublicSuffix(site)) return 'it is a public suffix, shared by many sites';
  if (NUMERIC_TAIL.test(site) && !IPV4.test(site)) return 'it is not a whole IP address';
  if (isSingleLabel(site)) return 'a single-label name reaches every host under it';
  return null;
}

/** The site a rule may be scoped to, or null when the gate would refuse it. */
function scopableSite() {
  const site = siteScope();
  return scopeRefusal(site) ? null : site;
}

/**
 * Generate a ranked list of CSS selector candidates for an element.
 * Each candidate includes: selector string, match count, and a label.
 * Exported for tests.
 */
export function generateSelectors(el) {
  const candidates = [];
  const hostname = scopableSite();
  const seen = new Set();

  function add(label, selector, scope, matched) {
    if (!selector || seen.has(selector)) return;
    // Offer only what can be saved: it parses, and the compiler keeps it.
    if (!isSaveableSelector(selector)) return;
    seen.add(selector);
    // A procedural selector throws in the browser; its caller finds what it
    // would hide, which is both its count and its preview (PK5).
    const count = matched ? matched.length : deepQuerySelectorAll(selector).length;
    candidates.push({ kind: 'cosmetic', label, selector, count, scope: scope || 'page', domain: hostname,
      ...(matched && { matches: matched }) });
  }

  // Check if we are inside a shadow DOM
  let root = el.getRootNode();
  if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
    const host = root.host;
    const hostLabel = `Shadow Host <${host.tagName.toLowerCase()}>`;

    // Host-level selectors are the only way to hide shadow content via
    // global CSS — selectors built from the inner element would preview
    // fine (the picker pierces shadow roots) and then persist as dead
    // rules, so offer ONLY host-level candidates here (§5.30).
    if (host.id) add(`${hostLabel} ID`, `#${escapeIdent(host.id)}`);
    for (const cls of stableClassesFirst(Array.from(host.classList)).slice(0, 2)) {
      add(`${hostLabel} .${cls}`, `.${escapeIdent(cls)}`);
    }
    add(`${hostLabel} Tag`, host.tagName.toLowerCase());

    candidates.sort((a, b) => selectorScore(b) - selectorScore(a));
    return candidates;
  }

  // 1. By ID (most specific)
  if (el.id && /^[a-zA-Z]/.test(el.id)) {
    add('ID', `#${escapeIdent(el.id)}`, 'page');
  }

  // 2. Tag + ID
  if (el.id) {
    add('Tag + ID', `${el.tagName.toLowerCase()}#${escapeIdent(el.id)}`, 'page');
  }

  // 3. Class combinations (up to 3 most specific classes)
  const classes = stableClassesFirst(Array.from(el.classList).filter(c => c && !/^\d/.test(c)));
  if (classes.length > 0) {
    // Single class
    for (const cls of classes.slice(0, 4)) {
      add(`Class .${cls}`, `.${escapeIdent(cls)}`, 'page');
    }
    // Tag + single class
    for (const cls of classes.slice(0, 3)) {
      add(`${el.tagName.toLowerCase()}.${cls}`, `${el.tagName.toLowerCase()}.${escapeIdent(cls)}`, 'page');
    }
    // All classes combined
    if (classes.length > 1) {
      const combined = classes.slice(0, 3).map(c => `.${escapeIdent(c)}`).join('');
      add('All classes', combined, 'page');
      add(`Tag + all classes`, `${el.tagName.toLowerCase()}${combined}`, 'page');
    }
  }

  // 4. By attribute
  const importantAttrs = ['data-ad', 'data-ad-unit', 'data-adunit', 'data-slot',
    'data-testid', 'aria-label', 'role', 'name', 'data-type'];
  for (const attr of importantAttrs) {
    const val = el.getAttribute(attr);
    if (val) {
      add(`[${attr}="${val}"]`, `[${attr}="${CSS.escape(val)}"]`, 'page');
      add(`${el.tagName.toLowerCase()}[${attr}="${val}"]`,
          `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`, 'page');
    }
  }

  // 5. Partial attribute match (contains)
  if (el.id && el.id.toLowerCase().includes('ad')) {
    add(`[id*="${el.id.toLowerCase()}"]`, `[id*="${CSS.escape(el.id.toLowerCase())}"]`, 'page');
  }

  // 6. Parent-child path (2 levels)
  const parent = el.parentElement;
  if (parent && parent !== document.body && parent !== document.documentElement) {
    const parentSel = simpleSelector(parent);
    const selfSel = simpleSelector(el);
    if (parentSel && selfSel) {
      add(`Parent > Element`, `${parentSel} > ${selfSel}`, 'page');
    }
  }

  // 7. Full path from body (most specific, least reusable)
  const fullPath = buildSelectorPath(el, 3);
  if (fullPath) {
    add('Ancestor path', fullPath, 'page');
  }

  addProceduralCandidates(el, classes, candidates, add);

  // Sort: prefer domain-specific medium-count selectors (count 1-5 is ideal)
  candidates.sort((a, b) => {
    const scoreA = selectorScore(a);
    const scoreB = selectorScore(b);
    return scoreB - scoreA;
  });

  return candidates;
}

// PICKER-2026-09 PK4. A class a build hashed is renamed by the site's next
// deploy, so a candidate held only by such classes ranks below a stable one of
// equal count — by less than a count band, so the bands still decide — but is
// still offered: it may be all an element has. A positional step breaks
// whenever the page reorders, so a path that needs one ranks below every
// candidate that matches something without one (and above those that match
// nothing).
const HASHED_CLASS_PENALTY = 6;
const POSITIONAL_PENALTY = 60;
const UPWARD_PENALTY = 10;

/** Exported for tests. */
export function selectorScore(c) {
  // (PK3) `:upward(1)` hides the container, not the element picked: it ranks
  // below the element's own selector.
  // Prefer selectors that match 1-3 elements (specific enough)
  // Penalize 0 (too specific/broken) and large counts (too broad)
  const countScore = c.count === 0 ? -100
    : c.count <= 3 ? 20
    : c.count <= 10 ? 10
    : c.count <= 50 ? 0
    : -10;

  // Prefer ID selectors, then class, then attribute
  const typeScore = c.selector.startsWith('#') ? 15
    : c.selector.startsWith('.') ? 10
    : c.selector.includes('[') ? 5
    : 3;

  const penalty = (onlyHashedClasses(c.selector) ? HASHED_CLASS_PENALTY : 0) +
    (c.selector.includes(':nth-of-type(') ? POSITIONAL_PENALTY : 0) +
    (/:upward\(/i.test(c.selector) ? UPWARD_PENALTY : 0);
  return countScore + typeScore - penalty;
}

/**
 * Does `className` look build-generated? One alphabetic prefix, one hyphen,
 * then six or more letters and digits holding at least two digits:
 * `css-1x2y3z`, `jsx-2947163892`, `grid-12ab34`. The plan pins this rule
 * against its own cases — `col-md-6`, `ad-slot-300x250`, `sr-only`, `h1` and
 * `MuiBox-root` are not hashed (PICKER-2026-09 PK4). Exported for tests; PK3
 * reuses it.
 */
export function looksHashed(className) {
  const m = /^[A-Za-z]+-([A-Za-z0-9]{6,})$/.exec(className);
  return m !== null && (m[1].match(/\d/g) || []).length >= 2;
}

/**
 * `classes` with the stable-looking ones first, each group in page order.
 * Candidates take only the first few classes, so a stable class behind hashed
 * ones was never offered — on exactly the sites this penalty is for. The
 * order within each group rides on `Array.prototype.sort` being stable, which
 * ES2019 requires and V8 has guaranteed since 7.0 (PICKER-2026-09 PK4).
 */
function stableClassesFirst(classes) {
  return [...classes].sort((a, b) => looksHashed(a) - looksHashed(b));
}

/**
 * Is `selector` held only by hashed-looking classes: at least one class, all
 * of them hashed, and no id or attribute to steady it? Classes are read as
 * `CSS.escape` wrote them; a hashed-looking name never needs an escape, so a
 * class that carries one is not hashed.
 */
function onlyHashedClasses(selector) {
  if (/[#[]/.test(selector)) return false;
  const classes = [...selector.matchAll(/\.((?:\\[\s\S]|[^\s.#[\]:>+~,()*|"'=\\])+)/g)].map((m) => m[1]);
  return classes.length > 0 && classes.every(looksHashed);
}

// ---------------------------------------------------------------------------
// Procedural candidates (PICKER-2026-09 PK3)
// ---------------------------------------------------------------------------

/**
 * The element's own text as a `:has-text()` argument, or null. Page text
 * becomes the argument, so it is cut at the first character that could close
 * the operator or open another (`( ) #`), that the compiler refuses (`{ }`),
 * that escapes (`\`) or starts a comment (`/`), that SW1's gate refuses (a
 * control, a lone surrogate), or any whitespace but a single space (which
 * takes U+2028/2029 too). What is left is then a literal piece of the element's own text, so
 * the engine's case-blind substring test still matches the element it came
 * from; whitespace is cut, not collapsed, for that reason. A leading `/`, the
 * engine's regex form (`/.*\/` matches every element), so leaves nothing. At
 * most 64 characters, cut by code point; fewer than three: refused. Exported
 * for tests.
 */
export function escapeHasTextArg(text) {
  const trimmed = String(text ?? '').trim();
  const stop = trimmed.search(/[()#\\{}/\p{Cc}\p{Cs}]|[^\S ]| {2}/u);
  const arg = [...(stop === -1 ? trimmed : trimmed.slice(0, stop))].slice(0, 64).join('').trimEnd();
  return [...arg].length >= 3 ? arg : null;
}

function isDocumentRoot(node) {
  const tag = node?.tagName?.toLowerCase();
  return !node || node === document.body || node === document.documentElement || tag === 'body' || tag === 'html';
}

/**
 * `:has-text()` and `:has(> child)` for an element whose own names are weak (no
 * id, no class but hashed ones), and `:upward(1)` to block its container.
 * Each carries a real match count: the browser cannot run `:has-text()`, and
 * a count of 0 would rank it below even a positional path. Neither is offered
 * on, or up into, `body` or `html` — from the picked element or from any other
 * match of the base: the gate refuses only a bare root, and `body:has-text(x)`
 * would blank the page. (`tag:has-text()` and `tag:has()` match only `tag`
 * elements, never a root, once the picked element is not one.)
 */
function addProceduralCandidates(el, classes, candidates, add) {
  if (isDocumentRoot(el)) return;
  const tag = el.tagName.toLowerCase();
  const weak = !el.id && classes.every(looksHashed);

  if (weak) {
    const text = escapeHasTextArg(el.textContent);
    if (text) {
      // The engine's test: a case-blind substring of the element's text.
      const needle = text.toLowerCase();
      const matched = deepQuerySelectorAll(tag)
        .filter((m) => String(m.textContent ?? '').toLowerCase().includes(needle));
      add(':has-text', `${tag}:has-text(${text})`, 'page', matched);
    }
    const child = Array.from(el.children ?? []).find((c) =>
      elementResources(c).some(({ url }) => /^https?:$/.test(resolveUrl(url)?.protocol)));
    const childSel = child && simpleSelector(child);
    if (childSel) add('Contains the ad', `${tag}:has(> ${childSel})`, 'page');
  }

  if (!isDocumentRoot(el.parentElement)) {
    const self = candidates
      .filter((c) => c.count > 0 && !isProceduralSelector(c.selector) &&
        !c.selector.includes(':nth-of-type(') && !c.selector.includes(':has('))
      .sort((a, b) => selectorScore(b) - selectorScore(a))[0];
    if (self) {
      const containers = new Set(deepQuerySelectorAll(self.selector).map((m) => m.parentElement).filter(Boolean));
      // The base can match elsewhere too: if any of those sits directly in
      // the body, the rule would hide the page (review R1).
      if (![...containers].some(isDocumentRoot)) {
        add('Block the container', `${self.selector}:upward(1)`, 'page', [...containers]);
      }
    }
  }
}

function simpleSelector(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${escapeIdent(el.id)}`;
  const classes = stableClassesFirst(Array.from(el.classList).filter(Boolean)).slice(0, 2);
  if (classes.length) return `${el.tagName.toLowerCase()}.${classes.map(escapeIdent).join('.')}`;
  return el.tagName.toLowerCase();
}

function buildSelectorPath(el, maxDepth) {
  const parts = [];
  let current = el;
  for (let i = 0; i < maxDepth && current && current !== document.body; i++) {
    const sel = simpleSelector(current);
    if (!sel) break;
    parts.unshift(pinnedStep(current, sel));
    current = current.parentElement;
  }
  return parts.length > 1 ? parts.join(' > ') : null;
}

/**
 * `sel` pinned to `el`'s position when it would also match a sibling, so the
 * path can single out a structurally anonymous element: `:nth-of-type(k)`,
 * `k` counted among same-tag siblings as the pseudo-class counts it, with the
 * tag written out for an id step (PICKER-2026-09 PK4).
 */
function pinnedStep(el, sel) {
  const siblings = Array.from(el.parentElement?.children ?? []);
  const collides = siblings.some((s) => {
    if (s === el) return false;
    try {
      return s.matches(sel);
    } catch {
      return false;
    }
  });
  if (!collides) return sel;
  const k = siblings.filter((s) => s.tagName === el.tagName).indexOf(el) + 1;
  return `${sel.startsWith('#') ? el.tagName.toLowerCase() : ''}${sel}:nth-of-type(${k})`;
}

// ---------------------------------------------------------------------------
// Network-block candidates (PICKER-2026-09 PK2a)
// ---------------------------------------------------------------------------
// Every line built here must pass SW1's APPEND_USER_FILTER gate
// (`isPickerSafeUserFilterLine` in the service worker), or the save is
// refused: `||host^` or `||host/path[^]`, then `$<type>,domain=<site>`. The
// resource URL, host included, is the page's to choose, so nothing from it
// reaches the line unvalidated.

// The gate's `||` host: `[a-z0-9.-]`, or a bracketed IPv6 literal. WHATWG lets
// `$ * , = { }` into a hostname, so this is a check, not a formality.
const NETWORK_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/;
// The first path character outside the gate's class: `$` would open an option
// list, `^ | *` are pattern syntax, and a browser's URL parser may leave
// others literal (`{ } \``) that the gate refuses.
const NETWORK_PATH_STOP = /[^\w!%&'()+,\-.:;=@[\]~/]/;
// The gate's `domain=` value: plain lower-case labels, one host, no negation.
const SITE_HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
// And no wider than one site, as SW1's `isPickerScopeTooBroad` rules for a
// hide's hostname, a `||` host and `domain=` alike: not a public suffix, a
// last label that is a number only in a whole IPv4 address (`domain=1` would
// reach every x.x.x.1 host), and not a single label, trailing dots aside
// (review R10): the list's implicit `*` rule makes an unknown one such as
// `lan` a suffix, and every *.localhost is loopback. A bracketed IPv6 literal
// is one host. A URL's own host never needs the number rule: the parser writes
// such a host as a dotted quad or refuses it (PICKER-2026-09 PK2c).
const NUMERIC_TAIL = /(?:^|\.)(?:\d+|0x[0-9a-f]*)\.?$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function isSingleLabel(host) {
  return !host.startsWith('[') && !host.replace(/\.+$/, '').includes('.');
}

function scopeTooBroad(host) {
  return isPublicSuffix(host) || (NUMERIC_TAIL.test(host) && !IPV4.test(host)) || isSingleLabel(host);
}

const NETWORK_TYPES = new Set(['image', 'subdocument', 'media', 'object']);
const NETWORK_LABELS = { path: 'Block request', prefix: 'Block path prefix', host: 'Block host' };

/** `url` resolved against the document's base URL, as the browser resolves it. */
function resolveUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, document.baseURI || location.href);
  } catch {
    return null;
  }
}

/**
 * The network rule blocking `url` as a `type` request, scoped to `domain` —
 * or null when no gate-safe line exists. `scope: 'path'` keeps the pathname
 * less its query, so a cache-busting parameter cannot escape the block. A
 * path character the gate refuses cuts it to the prefix before it, with no
 * closing `^`: strictly narrower than the host, so the escape only narrows. A
 * prefix of just `/`, or a non-default port (the gate admits none, and a path
 * rule without it can never match), falls back to `scope: 'host'`, the host
 * alone. Exported so SW1's gate can be checked against real output.
 */
export function urlToNetworkPattern(url, { scope = 'path', type, domain } = {}) {
  if (!NETWORK_TYPES.has(type)) return null;
  if (domain && (!SITE_HOSTNAME.test(domain) || scopeTooBroad(domain))) return null;
  const u = resolveUrl(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  const host = u.hostname.toLowerCase();
  if (!NETWORK_HOST.test(host) || scopeTooBroad(host)) return null;

  let base = `||${host}^`;
  if (scope === 'path' && !u.port) {
    const cut = u.pathname.search(NETWORK_PATH_STOP);
    if (cut === -1) base = `||${host}${u.pathname}^`;
    else if (cut > 1) base = `||${host}${u.pathname.slice(0, cut)}`;
  }
  return `${base}$${type}${domain ? `,domain=${domain}` : ''}`;
}

/** The first `url(...)` in the element's background image, inline style first. */
function backgroundImageUrl(el) {
  const urlIn = (value) => {
    const m = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^"'()\s]+))\s*\)/.exec(value || '');
    return m ? (m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, '$1') : null;
  };
  const inline = urlIn(el.style?.backgroundImage);
  if (inline || typeof getComputedStyle !== 'function') return inline;
  try {
    return urlIn(getComputedStyle(el).backgroundImage);
  } catch {
    return null;
  }
}

/**
 * The requests the element itself makes, most direct first, each with the
 * type it is filtered as. The type follows the URL taken: a video's poster
 * is an image request, not media.
 */
function elementResources(el) {
  const attr = (name) => el.getAttribute(name);
  switch (el.tagName.toLowerCase()) {
    case 'img': {
      const srcset = attr('srcset')?.trim().split(/\s+/)[0].replace(/,+$/, '');
      return [el.currentSrc, attr('src'), srcset].map((url) => ({ url, type: 'image' }));
    }
    case 'image': // SVG
      return [{ url: attr('href') || attr('xlink:href'), type: 'image' }];
    case 'video':
      return [{ url: el.currentSrc, type: 'media' }, { url: attr('src'), type: 'media' },
        { url: attr('poster'), type: 'image' }];
    case 'audio':
      return [{ url: el.currentSrc, type: 'media' }, { url: attr('src'), type: 'media' }];
    case 'source':
      return [{ url: attr('src'), type: 'media' }];
    case 'iframe':
    case 'frame':
      return [{ url: attr('src'), type: 'subdocument' }];
    case 'embed':
      return [{ url: attr('src'), type: 'object' }];
    case 'object':
      return [{ url: attr('data'), type: 'object' }];
    default:
      return [{ url: backgroundImageUrl(el), type: 'image' }];
  }
}

/**
 * Network-block candidates for the element's own request, scoped to the site:
 * its path (or the prefix a refused character leaves), then its whole host.
 * None when the element makes no http(s) request, when that request's host is
 * not gate-safe, or when there is no plain, registrable site to scope to — an
 * unscoped block of a shared CDN path would reach every site. Each carries the
 * element as `matches`: what the preview hides, and what is hidden once saved
 * until a reload applies the block (review R4). Exported for tests and SW1's
 * gate cross-check; the dialog offers these from PK2b.
 */
export function generateNetworkCandidates(el) {
  const resource = elementResources(el).find(({ url }) => /^https?:$/.test(resolveUrl(url)?.protocol));
  const domain = siteScope();
  if (!resource || !domain) return [];

  const candidates = [];
  for (const scope of ['path', 'host']) {
    const rule = urlToNetworkPattern(resource.url, { scope, type: resource.type, domain });
    if (!rule || candidates.some((c) => c.rule === rule)) continue;
    const base = rule.slice(0, rule.indexOf('$'));
    const real = !base.includes('/') ? 'host' : base.endsWith('^') ? 'path' : 'prefix';
    candidates.push({
      kind: 'network',
      label: `${NETWORK_LABELS[real]} (${resource.type})`,
      rule,
      matches: [el],
      scope: real,
      count: 1,
      domain,
      type: resource.type,
      url: resource.url,
    });
  }
  return candidates;
}

/**
 * The line the dialog sends for `candidate`, scoped to `domain` or, when the
 * user unchecks "Apply only to <site>", to nothing: a hide as `site##selector`, a
 * network candidate rebuilt from its URL by the same `urlToNetworkPattern`.
 * Exported so the gate cross-check feeds exactly what the dialog sends
 * (PICKER-2026-09 PK2b).
 */
export function candidateLine(candidate, domain) {
  if (candidate.kind !== 'network') return buildCosmeticRule(candidate.selector, domain);
  return urlToNetworkPattern(candidate.url, {
    scope: candidate.scope === 'host' ? 'host' : 'path',
    type: candidate.type,
    domain: domain || undefined,
  });
}

// ---------------------------------------------------------------------------
// Picker dialog
// ---------------------------------------------------------------------------
function openPickerDialog(target) {
  removeDialog();
  removeHighlight();
  currentNavTarget = target;
  navStack = [];

  const dialog = document.createElement('div');
  dialog.id = PICKER_DIALOG_ID;
  // Mounted on the dialog element (not its children), so it survives the
  // `innerHTML` rewrites in `updatePickerDialog` (§5.17).
  for (const type of [...KEY_EVENTS, ...POINTER_EVENTS, 'click']) {
    dialog.addEventListener?.(type, stopDialogEvent);
  }
  document.documentElement.appendChild(dialog);

  updatePickerDialog(dialog);
}

function updatePickerDialog(dialog) {
  const target = currentNavTarget;
  const site = siteScope();
  const refusal = scopeRefusal(site);
  const hostname = refusal ? null : site;
  const cosmetic = generateSelectors(target);
  const candidates = [...generateNetworkCandidates(target), ...cosmetic];
  const scopeOf = () => (dialog.querySelector('#adblock-scope-site')?.checked ? hostname : null);

  updateHighlight(target);
  dialog.innerHTML = buildDialogHTML(candidates, target, site, !refusal);
  // A line scoped to a site the gate will not scope to is refused: offer
  // only the unscoped rule, and say why (review R5).
  const siteCheck = dialog.querySelector('#adblock-scope-site');
  const scopeReason = dialog.querySelector('#adblock-scope-reason');
  if (refusal) {
    if (siteCheck) Object.assign(siteCheck, { checked: false, disabled: true });
    if (scopeReason) scopeReason.textContent = `Can't limit the rule to ${site || 'this page'}: ${refusal}.`;
  }

  // Select first (best) candidate by default
  if (candidates.length > 0) {
    const firstRadio = dialog.querySelector('input[type="radio"]');
    if (firstRadio) {
      firstRadio.checked = true;
      updatePreview(dialog, candidates[0], scopeOf());
    }
  }

  // Wire up events
  dialog.querySelectorAll('input[type="radio"]').forEach((radio, i) => {
    radio.addEventListener('change', () => {
      updatePreview(dialog, candidates[i], scopeOf());
    });
  });

  const customInput = dialog.querySelector('#adblock-picker-custom');
  customInput?.addEventListener('input', () => {
    const sel = customInput.value.trim();
    try {
      const count = document.querySelectorAll(sel).length;
      updatePreviewForCustom(dialog, sel, hostname, count);
      showPreview({ kind: 'cosmetic', selector: sel });
    } catch {
      clearPreview();
    }
  });

  // Navigation events
  dialog.querySelector('#adblock-picker-expand')?.addEventListener('click', () => {
    if (currentNavTarget.parentElement && currentNavTarget.parentElement !== document.documentElement) {
      navStack.push(currentNavTarget);
      currentNavTarget = currentNavTarget.parentElement;
      updatePickerDialog(dialog);
    }
  });

  dialog.querySelector('#adblock-picker-shrink')?.addEventListener('click', () => {
    if (navStack.length > 0) {
      currentNavTarget = navStack.pop();
      updatePickerDialog(dialog);
    }
  });

  dialog.querySelector('#adblock-picker-cancel')?.addEventListener('click', () => {
    deactivatePicker();
  });

  dialog.querySelector('#adblock-picker-cancel2')?.addEventListener('click', () => {
    deactivatePicker();
  });

  dialog.querySelector('#adblock-picker-create')?.addEventListener('click', () => {
    const custom = dialog.querySelector('#adblock-picker-custom')?.value?.trim();
    // A typed selector is a hide; otherwise the checked candidate, of its kind.
    const candidate = custom
      ? { kind: 'cosmetic', selector: custom }
      : candidates[Number(dialog.querySelector('input[type="radio"]:checked')?.value)];
    if (!candidate?.selector && candidate?.kind !== 'network') return;

    const rule = candidateLine(candidate, scopeOf());
    if (!rule) return;
    if (candidate.kind === 'network') {
      savePickerRule(rule, null, hostname, dialog, 'network', candidate.matches);
    } else {
      savePickerRule(rule, candidate.selector, hostname, dialog);
    }
  });
}

function buildDialogHTML(candidates, target, hostname, scopable) {
  const tagName = target.tagName.toLowerCase();
  const preview = [tagName, target.id ? `#${target.id}` : '', ...Array.from(target.classList).slice(0, 3)]
    .filter(Boolean).join(' ');

  const candidateRows = candidates.slice(0, 8).map((c, i) => `
    <label class="adblock-picker-row">
      <input type="radio" name="selector" value="${i}" ${i === 0 ? 'checked' : ''}>
      <span class="adblock-picker-sel">${escHTML(c.kind === 'network' ? `${c.label}: ${c.rule}` : c.selector)}</span>
      <span class="adblock-picker-count ${c.count === 0 ? 'zero' : c.count <= 5 ? 'good' : 'broad'}">
        ${c.count} match${c.count !== 1 ? 'es' : ''}
      </span>
    </label>
  `).join('');

  const canShrink = navStack.length > 0;
  const canExpand = target.parentElement && target.parentElement !== document.documentElement;

  return `
    <div class="adblock-picker-header">
      <div style="display:flex;align-items:center">
        <div class="adblock-picker-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2">
            <circle cx="12" cy="12" r="3"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
          </svg>
          Create Rule
        </div>
        <div class="adblock-picker-nav">
          <button class="adblock-picker-nav-btn" id="adblock-picker-expand" title="Expand selection (parent)" ${!canExpand ? 'disabled' : ''}>△</button>
          <button class="adblock-picker-nav-btn" id="adblock-picker-shrink" title="Shrink selection (child)" ${!canShrink ? 'disabled' : ''}>▽</button>
        </div>
      </div>
      <button class="adblock-picker-x" id="adblock-picker-cancel">✕</button>
    </div>

    <div class="adblock-picker-body">
      <div class="adblock-picker-element-info">
        Selected: <code>${escHTML(preview)}</code>
      </div>

      <div class="adblock-picker-section-label">Choose selector</div>
      <div class="adblock-picker-candidates">${candidateRows}</div>

      <div class="adblock-picker-section-label">Or enter custom CSS selector</div>
      <input type="text" id="adblock-picker-custom" class="adblock-picker-input"
        placeholder="e.g. div.ad-slot-header or [data-ad]">

      <div class="adblock-picker-section-label">Preview — elements that will be hidden</div>
      <div id="adblock-picker-preview" class="adblock-picker-preview">
        <em>Select a rule above to preview</em>
      </div>

      <div class="adblock-picker-scope-row">
        <label>
          <input type="checkbox" id="adblock-scope-site" ${scopable ? 'checked' : 'disabled'}>
          Apply only to <strong>${escHTML(hostname || 'this page')}</strong>
        </label>
        <span class="adblock-picker-scope-reason" id="adblock-scope-reason"></span>
        <span class="adblock-picker-rule-preview" id="adblock-rule-preview"></span>
      </div>
    </div>

    <div class="adblock-picker-footer">
      <button class="adblock-btn-secondary" id="adblock-picker-cancel2">Cancel</button>
      <button class="adblock-btn-primary" id="adblock-picker-create">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Create rule
      </button>
    </div>

    <style>
      #${PICKER_DIALOG_ID} * { box-sizing: border-box; }
      .adblock-picker-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px; border-bottom: 1px solid #30363d;
      }
      .adblock-picker-title {
        font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px;
      }
      .adblock-picker-nav {
        display: flex; gap: 4px; margin-left: 12px;
      }
      .adblock-picker-nav-btn {
        background: #21262d; border: 1px solid #30363d; color: #e6edf3;
        border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 14px;
        display: flex; align-items: center; transition: background 0.1s;
      }
      .adblock-picker-nav-btn:hover:not(:disabled) { background: #30363d; }
      .adblock-picker-nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      
      .adblock-picker-x {
        background: none; border: none; color: #8b949e; cursor: pointer;
        font-size: 18px; line-height: 1; padding: 4px; border-radius: 4px;
      }
      .adblock-picker-x:hover { color: #f85149; background: rgba(248,81,73,0.1); }
      .adblock-picker-body { padding: 16px 20px; }
      .adblock-picker-element-info {
        background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
        padding: 8px 12px; font-size: 12px; color: #8b949e; margin-bottom: 14px;
      }
      .adblock-picker-element-info code {
        color: #58a6ff; font-family: monospace; font-size: 12px;
      }
      .adblock-picker-section-label {
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
        color: #8b949e; margin-bottom: 6px; margin-top: 12px;
      }
      .adblock-picker-candidates { display: flex; flex-direction: column; gap: 2px; }
      .adblock-picker-row {
        display: flex; align-items: center; gap: 8px; padding: 7px 10px;
        border-radius: 6px; cursor: pointer; border: 1px solid transparent;
      }
      .adblock-picker-row:hover { background: #21262d; }
      .adblock-picker-row:has(input:checked) { background: rgba(88,166,255,0.08); border-color: #58a6ff; }
      .adblock-picker-row input[type="radio"] {
        appearance: radio !important;
        -webkit-appearance: radio !important;
        width: 14px !important;
        height: 14px !important;
        margin: 0 !important;
        flex-shrink: 0;
        accent-color: #58a6ff !important;
        cursor: pointer;
      }
      .adblock-picker-sel {
        flex: 1; font-family: monospace; font-size: 12px; color: #e6edf3;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .adblock-picker-count {
        font-size: 11px; padding: 1px 6px; border-radius: 10px; white-space: nowrap;
        flex-shrink: 0;
      }
      .adblock-picker-count.good { background: rgba(63,185,80,0.15); color: #3fb950; }
      .adblock-picker-count.broad { background: rgba(210,153,34,0.15); color: #d29922; }
      .adblock-picker-count.zero { background: rgba(248,81,73,0.15); color: #f85149; }
      .adblock-picker-input {
        width: 100%; background: #0d1117; border: 1px solid #30363d;
        border-radius: 6px; padding: 8px 12px; color: #e6edf3;
        font-family: monospace; font-size: 13px; outline: none;
      }
      .adblock-picker-input:focus { border-color: #58a6ff; }
      .adblock-picker-preview {
        background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
        padding: 10px 12px; min-height: 48px; font-size: 12px; color: #8b949e;
        max-height: 120px; overflow-y: auto;
      }
      .adblock-picker-preview-item {
        background: rgba(88,166,255,0.06); border: 1px dashed #30363d;
        border-radius: 4px; padding: 3px 7px; margin-bottom: 3px;
        font-family: monospace; font-size: 11px; color: #58a6ff;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .adblock-picker-scope-row {
        margin-top: 12px; display: flex; align-items: center;
        justify-content: space-between; font-size: 12px; color: #8b949e;
        flex-wrap: wrap; gap: 6px;
      }
      .adblock-picker-scope-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
      .adblock-picker-scope-row input { accent-color: #58a6ff; }
      .adblock-picker-scope-reason:empty { display: none; }
      .adblock-picker-scope-reason { font-size: 11px; color: #d29922; }
      .adblock-picker-rule-preview {
        font-family: monospace; font-size: 11px; color: #3fb950;
        background: rgba(63,185,80,0.08); padding: 2px 8px; border-radius: 4px;
        max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .adblock-picker-footer {
        padding: 12px 20px; border-top: 1px solid #30363d;
        display: flex; justify-content: flex-end; gap: 8px;
      }
      .adblock-btn-secondary, .adblock-btn-primary {
        padding: 8px 16px; border-radius: 6px; border: 1px solid #30363d;
        cursor: pointer; font-size: 13px; font-weight: 500;
      }
      .adblock-btn-secondary { background: #21262d; color: #e6edf3; }
      .adblock-btn-secondary:hover { background: #30363d; }
      .adblock-btn-primary {
        background: #238636; color: #fff; border-color: #238636;
        display: flex; align-items: center; gap: 5px;
      }
      .adblock-btn-primary:hover { background: #2ea043; }
    </style>
  `;
}

function updatePreview(dialog, candidate, domain) {
  showPreview(candidate);
  if (candidate.kind === 'network') {
    // The resource is already loaded, so the block itself only shows on a
    // reload; the element is hidden meanwhile (PICKER-2026-09 PK2b).
    const preview = dialog.querySelector('#adblock-picker-preview');
    if (preview) {
      preview.innerHTML = `<div style="font-size:11px;color:#8b949e">${escHTML(candidate.label)}: ` +
        'blocks the request. It applies now and on every reload.</div>';
    }
    const ruleEl = dialog.querySelector('#adblock-rule-preview');
    if (ruleEl) ruleEl.textContent = candidateLine(candidate, domain) ?? '';
    return;
  }
  const hostname = domain || '';
  updatePreviewForCustom(dialog, candidate.selector, hostname, candidate.count);
  updateCustomInput(dialog, candidate.selector, hostname);
}

function updatePreviewForCustom(dialog, selector, hostname, count) {
  const preview = dialog.querySelector('#adblock-picker-preview');
  if (!preview) return;

  if (!selector) {
    preview.innerHTML = '<em>Enter a selector above</em>';
    return;
  }

  // The browser cannot run a procedural selector; the page's rule engine
  // does, from the saved rule (PICKER-2026-09 PK3).
  if (isProceduralSelector(selector)) {
    const n = Number.isFinite(count) ? count : 0;
    preview.innerHTML = `<div style="font-size:11px;color:#8b949e">${n} element${n !== 1 ? 's' : ''} ` +
      'will be hidden by the page\'s rule engine</div>';
    updateRulePreview(dialog, selector, hostname);
    return;
  }

  let elements = [];
  try {
    elements = deepQuerySelectorAll(selector).slice(0, 5);
  } catch {
    preview.innerHTML = '<span style="color:#f85149">⚠ Invalid CSS selector</span>';
    updateRulePreview(dialog, selector, hostname);
    return;
  }

  if (elements.length === 0) {
    preview.innerHTML = '<span style="color:#d29922">⚠ No elements match on this page</span>';
  } else {
    const actualCount = Number.isFinite(count) ? count : deepQuerySelectorAll(selector).length;
    const items = elements.map((el) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = Array.from(el.classList).slice(0, 3).map(c => `.${c}`).join('');
      const text = el.textContent?.trim().slice(0, 60);
      return `<div class="adblock-picker-preview-item">${escHTML(`${tag}${id}${cls}`)} ${text ? `— "${escHTML(text)}"` : ''}</div>`;
    }).join('');
    preview.innerHTML = `<div style="font-size:11px;color:#8b949e;margin-bottom:6px">${actualCount} element${actualCount !== 1 ? 's' : ''} will be hidden</div>${items}`;
  }

  updateRulePreview(dialog, selector, hostname);
}

function updateRulePreview(dialog, selector, hostname) {
  const el = dialog.querySelector('#adblock-rule-preview');
  if (!el) return;
  const siteCheck = dialog.querySelector('#adblock-scope-site');
  const domain = siteCheck?.checked ? hostname : '';
  el.textContent = buildCosmeticRule(selector, domain || null);
}

function updateCustomInput(dialog, selector, hostname) {
  const input = dialog.querySelector('#adblock-picker-custom');
  if (input && !input.value) {
    input.placeholder = selector;
  }
  updateRulePreview(dialog, selector, hostname);
}

function buildCosmeticRule(selector, domain) {
  return domain ? `${domain}##${selector}` : `##${selector}`;
}

// ---------------------------------------------------------------------------
// Save rule
// ---------------------------------------------------------------------------
export async function savePickerRule(rule, selector, hostname, dialog, kind = 'cosmetic', elements = []) {
  try {
    // A network line is no selector: the two selector guards below are for
    // hides. It hides `elements`, the picked element, until a reload applies
    // the block (PICKER-2026-09 PK2b, review R4).
    const network = kind === 'network';
    // Every save passes here, and the custom field arrives unvalidated: a
    // selector the browser cannot parse, or the compiler would drop, is never
    // sent (PICKER-2026-09 PK1b).
    if (!network && !isSaveableSelector(selector)) {
      showErrorInDialog(dialog,
        'This selector can\'t be saved: it is not valid CSS, or it contains ' +
        'characters a filter rule cannot carry, such as {, } or ;.');
      return;
    }

    // A rule that only matches inside shadow roots cannot be applied by
    // document-level CSS — refuse clearly instead of reporting a success
    // that evaporates on reload (§5.30).
    if (!network && isShadowOnlySelector(selector)) {
      showErrorInDialog(dialog,
        'This element is inside a shadow DOM that page-level rules cannot reach. ' +
        'Pick the outer (shadow host) element instead.');
      return;
    }

    // Single atomic append — reading the filter text and writing it back
    // here races other writers (a second picker, the options page) and
    // silently drops rules (§5.31). The SW serializes appends.
    const res = await chrome.runtime.sendMessage({
      type: 'APPEND_USER_FILTER',
      payload: { line: rule },
    });

    if (!res?.ok) {
      showErrorInDialog(dialog, res?.error || 'Failed to save rule');
      return;
    }

    // The append recompiles all of My Filters, so the skip counts cover every
    // stored line: one unsupported line pasted long ago would fail every later
    // save. Decide on this line's own entry, keyed on the text the SW stores
    // (trimmed). A dropped line is not hidden either — the element vanishing
    // is itself a claim that the rule works (PICKER-2026-09 PK1).
    const savedLine = rule.trim();
    const dropped = res.counts?.skippedRules?.find((s) => s.line === savedLine);
    if (dropped) {
      showErrorInDialog(dialog, dropped.reason || 'This rule couldn\'t be applied');
      return;
    }

    // Immediately hide elements on this page
    clearPreview();
    if (network) hideElementsImmediately(elements);
    else if (selector) applyRuleImmediately(selector);

    // Show success state in dialog
    showSuccessInDialog(dialog, rule);

    setTimeout(() => {
      deactivatePicker();
      showPickerToast(`✅ Rule saved: ${rule}`);
      setTimeout(() => document.querySelector('.__adblock_picker_toast__')?.remove(), 3000);
    }, 800);
  } catch (err) {
    showErrorInDialog(dialog, err.message);
  }
}

// The picker's own UI is never hidden, however broad the selector (`div`).
const NOT_PICKER_UI = [PICKER_DIALOG_ID, PICKER_OVERLAY_ID, PICKER_HIGHLIGHT_ID]
  .map((id) => `:not(#${id}):not(#${id} *)`).join('') + ':not(.__adblock_picker_toast__)';

function hideRule(selector) {
  return `:is(${selector})${NOT_PICKER_UI} { display: none !important; }`;
}

function pickerSheet(id) {
  let node = document.getElementById(id);
  if (!node) {
    node = document.createElement('style');
    node.id = id;
    document.documentElement.appendChild(node);
  }
  return node;
}

function clearPreview() {
  document.getElementById(PREVIEW_SHEET_ID)?.remove();
  for (const node of markedNodes) node.removeAttribute?.(PREVIEW_MARK);
  markedNodes = [];
}

/**
 * Hide what `candidate` would hide, now, through the preview sheet: a network
 * block's own element, and a procedural candidate's actual matched set (the
 * browser cannot run `:has-text()`), each marked with a picker-owned
 * attribute. `tag:has-text(x)` also matches ancestor wrappers, so the user
 * sees one go before saving (PICKER-2026-09 PK5, review R4).
 */
function showPreview(candidate) {
  clearPreview();
  let selector = candidate?.kind === 'network' ? null : candidate?.selector;
  if (candidate?.kind !== 'network' && !selector) return;
  if (candidate.kind === 'network' || isProceduralSelector(selector)) {
    if (!candidate.matches?.length) return;
    for (const node of candidate.matches) {
      node.setAttribute?.(PREVIEW_MARK, '');
      markedNodes.push(node);
    }
    selector = `[${PREVIEW_MARK}]`;
  }
  pickerSheet(PREVIEW_SHEET_ID).textContent = hideRule(selector);
}

/** Hide a saved network block's element until a reload applies the block. */
function hideElementsImmediately(elements) {
  if (!elements?.length) return;
  for (const node of elements) node.setAttribute?.(APPLIED_MARK, '');
  const node = pickerSheet(APPLIED_SHEET_ID);
  const rule = hideRule(`[${APPLIED_MARK}]`);
  if (!(node.textContent || '').includes(rule)) node.textContent = `${node.textContent || ''}${rule}\n`;
}

/** Hide a saved rule's matches until a reload applies it: the applied sheet. */
function applyRuleImmediately(selector) {
  // The engine runs a procedural rule from the saved line; CSS cannot.
  if (isProceduralSelector(selector)) return;
  const node = pickerSheet(APPLIED_SHEET_ID);
  node.textContent = `${node.textContent || ''}${hideRule(selector)}\n`;
}

function showSuccessInDialog(dialog, rule) {
  const footer = dialog.querySelector('.adblock-picker-footer');
  if (footer) {
    footer.innerHTML = `<div style="color:#3fb950;font-size:13px;display:flex;align-items:center;gap:6px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      Rule saved: <code style="font-family:monospace">${escHTML(rule)}</code>
    </div>`;
  }
}

const PICKER_ERROR_CLASS = '__adblock_picker_error__';

function showErrorInDialog(dialog, msg) {
  const footer = dialog.querySelector('.adblock-picker-footer');
  if (!footer) return;

  // `innerHTML +=` re-parses the whole footer, replacing Cancel and Create
  // with fresh nodes that carry none of the listeners wired in
  // `updatePickerDialog` — so the shadow-DOM refusal (§5.30) told the user to
  // pick the outer element and then ignored every click (§5.16). Append a
  // node: the existing buttons, and their listeners, are left alone.
  footer.querySelector?.(`.${PICKER_ERROR_CLASS}`)?.remove();

  const note = document.createElement('div');
  note.className = PICKER_ERROR_CLASS;
  note.style.color = '#f85149';
  note.style.fontSize = '12px';
  note.textContent = `Error: ${msg}`;
  footer.appendChild(note);
}

function removeDialog() {
  document.getElementById(PICKER_DIALOG_ID)?.remove();
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------
function showPickerToast(msg) {
  document.querySelector('.__adblock_picker_toast__')?.remove();
  const toast = document.createElement('div');
  toast.className = '__adblock_picker_toast__';
  toast.textContent = msg;
  document.documentElement.appendChild(toast);
}

// ---------------------------------------------------------------------------
// HTML escaping utilities
// ---------------------------------------------------------------------------
function escHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
