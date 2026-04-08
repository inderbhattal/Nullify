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

const PICKER_HIGHLIGHT_ID = '__adblock_picker_highlight__';
const PICKER_OVERLAY_ID   = '__adblock_picker_overlay__';
const PICKER_DIALOG_ID    = '__adblock_picker_dialog__';
const PICKER_STYLE_ID     = '__adblock_picker_style__';

let pickerActive = false;
let highlightEl = null;
let lastTarget = null;
let navStack = [];
let currentNavTarget = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function activatePicker() {
  if (pickerActive) return;
  pickerActive = true;
  navStack = [];
  currentNavTarget = null;
  injectPickerStyles();
  createOverlay();
  document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
  document.addEventListener('click', onClick, { capture: true });
  document.addEventListener('keydown', onKeyDown, { capture: true });
  showPickerToast('🎯 Click any element to create a blocking rule. Press ESC to cancel.');
}

export function deactivatePicker() {
  if (!pickerActive) return;
  pickerActive = false;
  document.removeEventListener('mousemove', onMouseMove, { capture: true });
  document.removeEventListener('click', onClick, { capture: true });
  document.removeEventListener('keydown', onKeyDown, { capture: true });
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

  // Pause hover tracking while dialog is open
  document.removeEventListener('mousemove', onMouseMove, { capture: true });
  removeOverlay();

  openPickerDialog(target);
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    deactivatePicker();
    showPickerToast('❌ Element picker cancelled');
    setTimeout(() => document.querySelector('.__adblock_picker_toast__')?.remove(), 2000);
  }
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
 * Generate a ranked list of CSS selector candidates for an element.
 * Each candidate includes: selector string, match count, and a label.
 */
function generateSelectors(el) {
  const candidates = [];
  const hostname = location.hostname.replace(/^www\./, '');
  const seen = new Set();

  function add(label, selector, scope) {
    if (!selector || seen.has(selector)) return;
    // Validate selector
    try { document.querySelector(selector); } catch { return; }
    seen.add(selector);
    const count = deepQuerySelectorAll(selector).length;
    candidates.push({ label, selector, count, scope: scope || 'page', domain: hostname });
  }

  // Check if we are inside a shadow DOM
  let root = el.getRootNode();
  if (root instanceof ShadowRoot) {
    const host = root.host;
    const hostLabel = `Shadow Host <${host.tagName.toLowerCase()}>`;
    
    // Suggest host-level selectors first as they are the only way to hide 
    // shadow content via global CSS.
    if (host.id) add(`${hostLabel} ID`, `#${CSS.escape(host.id)}`);
    for (const cls of Array.from(host.classList).slice(0, 2)) {
      add(`${hostLabel} .${cls}`, `.${CSS.escape(cls)}`);
    }
    add(`${hostLabel} Tag`, host.tagName.toLowerCase());
  }

  // 1. By ID (most specific)
  if (el.id && /^[a-zA-Z]/.test(el.id)) {
    add('ID', `#${CSS.escape(el.id)}`, 'page');
  }

  // 2. Tag + ID
  if (el.id) {
    add('Tag + ID', `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}`, 'page');
  }

  // 3. Class combinations (up to 3 most specific classes)
  const classes = Array.from(el.classList).filter(c => c && !/^\d/.test(c));
  if (classes.length > 0) {
    // Single class
    for (const cls of classes.slice(0, 4)) {
      add(`Class .${cls}`, `.${CSS.escape(cls)}`, 'page');
    }
    // Tag + single class
    for (const cls of classes.slice(0, 3)) {
      add(`${el.tagName.toLowerCase()}.${cls}`, `${el.tagName.toLowerCase()}.${CSS.escape(cls)}`, 'page');
    }
    // All classes combined
    if (classes.length > 1) {
      const combined = classes.slice(0, 3).map(c => `.${CSS.escape(c)}`).join('');
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

  // Sort: prefer domain-specific medium-count selectors (count 1-5 is ideal)
  candidates.sort((a, b) => {
    const scoreA = selectorScore(a);
    const scoreB = selectorScore(b);
    return scoreB - scoreA;
  });

  return candidates;
}

function selectorScore(c) {
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

  return countScore + typeScore;
}

function simpleSelector(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const classes = Array.from(el.classList).filter(Boolean).slice(0, 2);
  if (classes.length) return `${el.tagName.toLowerCase()}.${classes.map(CSS.escape).join('.')}`;
  return el.tagName.toLowerCase();
}

function buildSelectorPath(el, maxDepth) {
  const parts = [];
  let current = el;
  for (let i = 0; i < maxDepth && current && current !== document.body; i++) {
    const sel = simpleSelector(current);
    if (!sel) break;
    parts.unshift(sel);
    current = current.parentElement;
  }
  return parts.length > 1 ? parts.join(' > ') : null;
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
  document.documentElement.appendChild(dialog);
  
  updatePickerDialog(dialog);
}

function updatePickerDialog(dialog) {
  const target = currentNavTarget;
  const hostname = location.hostname.replace(/^www\./, '');
  const candidates = generateSelectors(target);

  updateHighlight(target);
  dialog.innerHTML = buildDialogHTML(candidates, target, hostname);

  // Select first (best) candidate by default
  if (candidates.length > 0) {
    const firstRadio = dialog.querySelector('input[type="radio"]');
    if (firstRadio) {
      firstRadio.checked = true;
      updatePreview(dialog, candidates[0], hostname);
    }
  }

  // Wire up events
  dialog.querySelectorAll('input[type="radio"]').forEach((radio, i) => {
    radio.addEventListener('change', () => {
      updatePreview(dialog, candidates[i], hostname);
      updateCustomInput(dialog, candidates[i].selector, hostname);
    });
  });

  const customInput = dialog.querySelector('#adblock-picker-custom');
  customInput?.addEventListener('input', () => {
    const sel = customInput.value.trim();
    try {
      const count = document.querySelectorAll(sel).length;
      updatePreviewForCustom(dialog, sel, hostname, count);
    } catch {}
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
    const selected = dialog.querySelector('input[type="radio"]:checked');
    const selector = custom || (selected ? selected.value : '');

    if (!selector) return;

    const rule = buildCosmeticRule(selector, dialog.querySelector('#adblock-scope-site')?.checked ? hostname : null);
    savePickerRule(rule, selector, hostname, dialog);
  });
}

function buildDialogHTML(candidates, target, hostname) {
  const tagName = target.tagName.toLowerCase();
  const preview = [tagName, target.id ? `#${target.id}` : '', ...Array.from(target.classList).slice(0, 3)]
    .filter(Boolean).join(' ');

  const candidateRows = candidates.slice(0, 8).map((c, i) => `
    <label class="adblock-picker-row">
      <input type="radio" name="selector" value="${escAttr(c.selector)}" ${i === 0 ? 'checked' : ''}>
      <span class="adblock-picker-sel">${escHTML(c.selector)}</span>
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
          <input type="checkbox" id="adblock-scope-site" checked>
          Apply only to <strong>${escHTML(hostname)}</strong>
        </label>
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

function updatePreview(dialog, candidate, hostname) {
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
    const actualCount = deepQuerySelectorAll(selector).length;
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
async function savePickerRule(rule, selector, hostname, dialog) {
  try {
    // Add to user filters via message to service worker
    const res = await chrome.runtime.sendMessage({ type: 'GET_USER_FILTERS' });
    const existing = res?.filters || '';
    const newFilters = existing
      ? `${existing.trimEnd()}\n${rule}`
      : rule;

    await chrome.runtime.sendMessage({
      type: 'SET_USER_FILTERS',
      payload: { filters: newFilters },
    });

    // Immediately hide elements on this page
    applyRuleImmediately(selector);

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

function applyRuleImmediately(selector) {
  try {
    deepQuerySelectorAll(selector).forEach((el) => {
      el.style.setProperty('display', 'none', 'important');
    });
  } catch {}
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

function showErrorInDialog(dialog, msg) {
  const footer = dialog.querySelector('.adblock-picker-footer');
  if (footer) {
    footer.innerHTML += `<div style="color:#f85149;font-size:12px">Error: ${escHTML(msg)}</div>`;
  }
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

function escAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}
