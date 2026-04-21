/**
 * scriptlets/index.js
 *
 * Registry and executor for all bundled scriptlets.
 * This module runs in the MAIN world of the page.
 *
 * Usage (injected by service worker):
 *   window.__adblockScriptlets.run('abort-on-property-read', ['_sp_'])
 */

import { abortOnPropertyRead } from './abort-on-property-read.js';
import { abortOnPropertyWrite } from './abort-on-property-write.js';
import { setConstant } from './set-constant.js';
import { abortCurrentInlineScript } from './abort-current-inline-script.js';
import { jsonPrune } from './json-prune.js';
import { preventFetch } from './prevent-fetch.js';
import { preventXhr } from './prevent-xhr.js';
import { removeAttr } from './remove-attr.js';
import { addClass } from './add-class.js';
import { removeClass } from './remove-class.js';
import { noeval } from './noeval.js';
import { noSetTimeout } from './no-set-timeout-if.js';
import { noSetInterval } from './no-set-interval-if.js';
import { preventAddEventListener } from './prevent-add-event-listener.js';
import { setCookie } from './set-cookie.js';
import { setCookiePath } from './set-cookie-reload.js';
import { removeCookie } from './remove-cookie.js';
import { disableNewtabLinks } from './disable-newtab-links.js';
import { adjustSetTimeout } from './adjust-set-timeout.js';
import { adjustSetInterval } from './adjust-set-interval.js';
import { noWindowOpenIf } from './no-window-open-if.js';
import { preventWindowOpen } from './prevent-window-open.js';
import { setLocalStorageItem } from './set-local-storage-item.js';
import { setSessionStorageItem } from './set-session-storage-item.js';
import { abortOnStackTrace } from './abort-on-stack-trace.js';
import { noXhrIf } from './no-xhr-if.js';
import { noFetchIf } from './no-fetch-if.js';
import { objectPrune } from './object-prune.js';
import { trustedSetConstant } from './trusted-set-constant.js';
import { spoofCss } from './spoof-css.js';
import { trustedReplaceFetchResponse, trustedReplaceXhrResponse } from './trusted-replace-fetch-response.js';
import { trustedClickElement } from './trusted-click-element.js';
import { m3uPrune } from './m3u-prune.js';
import { hideWindowError } from './hide-window-error.js';
import { fingerprintNoise } from './fingerprint-noise.js';
import { batterySpoof } from './battery-spoof.js';
import { botStealth } from './bot-stealth.js';
import { personaSpoof } from './persona-spoof.js';

// ---------------------------------------------------------------------------
// Registry — maps scriptlet name (and aliases) to implementation
// ---------------------------------------------------------------------------
const REGISTRY = new Map([
  // Core property interceptors
  ['abort-on-property-read', abortOnPropertyRead],
  ['aopr', abortOnPropertyRead],
  ['abort-on-property-write', abortOnPropertyWrite],
  ['aopw', abortOnPropertyWrite],
  ['set-constant', setConstant],
  ['sc', setConstant],
  ['set', setConstant], // alias
  ['abort-current-inline-script', abortCurrentInlineScript],
  ['acis', abortCurrentInlineScript],
  ['abort-on-stack-trace', abortOnStackTrace],
  ['aost', abortOnStackTrace],

  // JSON/Object manipulation
  ['json-prune', jsonPrune],
  ['json-prune-fetch-response', jsonPrune],
  ['object-prune', objectPrune],

  // Network interception
  ['prevent-fetch', preventFetch],
  ['no-fetch-if', noFetchIf],
  ['prevent-xhr', preventXhr],
  ['no-xhr-if', noXhrIf],
  ['m3u-prune', m3uPrune],

  // DOM manipulation
  ['remove-attr', removeAttr],
  ['ra', removeAttr],
  ['add-class', addClass],
  ['ac', addClass],
  ['remove-class', removeClass],
  ['rc', removeClass],

  // Timer/Event manipulation
  ['noeval', noeval],
  ['no-eval', noeval],
  ['no-set-timeout-if', noSetTimeout],
  ['nostif', noSetTimeout],
  ['no-set-interval-if', noSetInterval],
  ['nosiif', noSetInterval],
  ['prevent-addEventListener', preventAddEventListener],
  ['aeld', preventAddEventListener], // alias
  ['addeventlistener-logger', preventAddEventListener],
  ['adjust-set-timeout', adjustSetTimeout],
  ['ast', adjustSetTimeout],
  ['adjust-set-interval', adjustSetInterval],
  ['asi', adjustSetInterval],

  // Cookie manipulation
  ['set-cookie', setCookie],
  ['set-cookie-reload', setCookiePath],
  ['remove-cookie', removeCookie],

  // Storage manipulation
  ['set-local-storage-item', setLocalStorageItem],
  ['set-lsi', setLocalStorageItem],
  ['set-session-storage-item', setSessionStorageItem],
  ['set-ssi', setSessionStorageItem],

  // Popup/window blocking
  ['no-window-open-if', noWindowOpenIf],
  ['prevent-window-open', preventWindowOpen],
  ['pwo', preventWindowOpen],
  ['disable-newtab-links', disableNewtabLinks],

  // Trusted (privileged) variants
  ['trusted-set-constant', trustedSetConstant],
  ['tsc', trustedSetConstant],
  ['trusted-set', trustedSetConstant], // alias
  ['trusted-click-element', trustedClickElement],
  ['tce', trustedClickElement],

  // Anti-adblock / CSS spoofing
  ['spoof-css', spoofCss],
  ['trusted-replace-fetch-response', trustedReplaceFetchResponse],
  ['trfr', trustedReplaceFetchResponse],
  ['trusted-replace-xhr-response', trustedReplaceXhrResponse],
  ['trxr', trustedReplaceXhrResponse],
  ['hide-window-error', hideWindowError],
  ['hwe', hideWindowError],
  ['fingerprint-noise', fingerprintNoise],
  ['fpn', fingerprintNoise],
  ['battery-spoof', batterySpoof],
  ['bs', batterySpoof],
  ['bot-stealth', botStealth],
  ['stealth', botStealth],
  ['persona-spoof', personaSpoof],
]);

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
const executed = new Set();

function run(name, args = []) {
  const fn = REGISTRY.get(name);
  if (!fn) {
    // Unknown scriptlet — skip silently
    return;
  }

  // Prevent double-execution of the same scriptlet with same args
  const key = `${name}|${JSON.stringify(args)}`;
  if (executed.has(key)) return;
  executed.add(key);

  try {
    fn(...args);
  } catch {
    // Scriptlet errors must not crash the page
  }
}

// ---------------------------------------------------------------------------
// Public API — capability token handed to the bundle by the service worker.
// ---------------------------------------------------------------------------
// The SW injects a one-shot global `__nullifyBootKey` before loading this
// bundle. We register the dispatcher under that key (non-enumerable +
// non-configurable so page scripts can't enumerate or replace it), then
// delete the temporary boot key.
//
// No fixed sentinel. No randomized `__nu*` prefix exposed via Object.keys.
// If the boot key is missing (e.g. direct <script> load) we refuse to
// register — the SW is the only legitimate caller.
const bootKey = globalThis.__nullifyBootKey;
if (typeof bootKey === 'string' && bootKey.length > 0) {
  try {
    Object.defineProperty(window, bootKey, {
      value: Object.freeze({ run }),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    // Attacker pre-claimed the key with a non-configurable descriptor — refuse.
  }
  try {
    delete globalThis.__nullifyBootKey;
  } catch { /* ignore */ }
}

export { run };
