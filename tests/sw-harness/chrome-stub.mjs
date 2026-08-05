/**
 * In-memory stub of the Chrome MV3 extension APIs that the service worker
 * touches. Constructed via `makeChromeStub()`; each instance is independent
 * so tests can run in parallel without state leaking.
 *
 * Coverage is intentionally narrow — only the surfaces the service worker
 * actually calls. When the SW reaches for a new API, add it here. Records
 * every call into `stub.calls` so tests can assert behavior without poking
 * private state.
 *
 * Design rule: stubs never silently succeed. A method that the SW expects
 * to throw on bad input throws here too. Listener events fire synchronously
 * unless explicitly deferred — tests should not depend on tick ordering.
 */

class CallLog {
  constructor() { this.entries = []; }
  push(entry) { this.entries.push({ ...entry, t: this.entries.length }); }
  filter(fn) { return this.entries.filter(fn); }
  clear() { this.entries.length = 0; }
  get length() { return this.entries.length; }
}

function matchesPattern(pattern, url) {
  if (!pattern || !url) return false;
  // Convert MV3 match pattern to RegExp. Supports *://host/* and explicit hosts.
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(url);
}

/**
 * REVIEW-2026-08 §7.1 — the message bus is a serialization boundary.
 *
 * `chrome.runtime.sendMessage` JSON-serializes both the message and the
 * response; passing live object references (what this stub used to do) hides
 * every defect that depends on the shape that actually survives the trip:
 * `undefined` properties vanish, class instances collapse to plain objects,
 * `Error` values become `{}`, and cycles/functions are outright rejected.
 * Round-tripping both directions is what makes §4.11-class findings
 * (unchecked `{error: …}` response shapes) reachable from the harness.
 */
function serializeForBus(value, direction) {
  if (value === undefined) return undefined;
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new Error(`${direction} is not serializable: ${err.message}`);
  }
  // `JSON.stringify` returns undefined for functions/symbols/undefined.
  if (json === undefined) return undefined;
  return JSON.parse(json);
}

function makeListenerEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    _fire: (...args) => {
      for (const fn of listeners) fn(...args);
    },
    _fireAsync: async (...args) => {
      const results = [];
      for (const fn of listeners) results.push(await fn(...args));
      return results;
    },
    _listeners: listeners,
  };
}

/**
 * REVIEW-2026-08 §7.7 — DNR schema constraints Chrome enforces at rule
 * indexing time and this stub used to accept silently.
 *
 * The two that have already shipped as live defects:
 *   - `allowAllRequests` is rejected unless `resourceTypes` is present and
 *     limited to main_frame/sub_frame (§4.1). A rule that violates it is
 *     dropped by Chrome while the extension believes the site is allowlisted.
 *   - domain lists must be non-empty, ASCII and lowercase (§5.29). One
 *     upstream `$domain=Example.COM|` sheds the whole rule.
 *
 * Thrown as a batch-level rejection because that is what Chrome does:
 * `updateDynamicRules` is all-or-nothing.
 */
const DNR_ALLOW_ALL_RESOURCE_TYPES = new Set(['main_frame', 'sub_frame']);
const DNR_DOMAIN_LIST_KEYS = [
  'initiatorDomains',
  'excludedInitiatorDomains',
  'requestDomains',
  'excludedRequestDomains',
];

function validateDnrRuleSchema(rule) {
  const id = rule?.id;
  const action = rule?.action || {};
  const condition = rule?.condition || {};

  if (!Number.isInteger(id) || id < 1) {
    throw new Error(`Rule id must be a positive integer (got ${JSON.stringify(id)})`);
  }
  if ('priority' in rule && (!Number.isInteger(rule.priority) || rule.priority < 1)) {
    throw new Error(`Rule with id ${id} has an invalid priority ${JSON.stringify(rule.priority)}`);
  }

  if (action.type === 'allowAllRequests') {
    const types = condition.resourceTypes;
    if (!Array.isArray(types) || types.length === 0) {
      throw new Error(
        `Rule with id ${id}: allowAllRequests rules must specify resourceTypes ` +
        `(only main_frame and sub_frame are allowed)`
      );
    }
    for (const type of types) {
      if (!DNR_ALLOW_ALL_RESOURCE_TYPES.has(type)) {
        throw new Error(
          `Rule with id ${id}: allowAllRequests supports only main_frame/sub_frame resourceTypes (got "${type}")`
        );
      }
    }
  }

  for (const key of DNR_DOMAIN_LIST_KEYS) {
    const list = condition[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`Rule with id ${id}: ${key} must be a non-empty array`);
    }
    for (const entry of list) {
      if (typeof entry !== 'string' || entry === '') {
        throw new Error(`Rule with id ${id}: ${key} contains an empty or non-string entry`);
      }
      if (!/^[\x00-\x7F]*$/.test(entry)) {
        throw new Error(
          `Rule with id ${id}: ${key} entry "${entry}" is not ASCII (punycode is required)`
        );
      }
      if (entry !== entry.toLowerCase()) {
        throw new Error(`Rule with id ${id}: ${key} entry "${entry}" must be lowercase`);
      }
    }
  }
}

export function makeChromeStub({ extensionId = 'nullify-test-id' } = {}) {
  const calls = new CallLog();

  // ---- chrome.storage ----
  // Mirrors Chrome's dual API: promise-based when no callback is passed,
  // callback-based (invoked async) when one is — src/shared/storage.js uses
  // the callback form, the service worker's storage.session usage the
  // promise form.
  const storageArea = (initial = {}) => {
    let data = { ...initial };
    // §7.2 — a held read models the window every woken service worker starts
    // in: listeners are already firing while the restore/refresh reads are
    // still outstanding. Without it, in-harness reads resolve within a
    // microtask and no test can observe pre-restore state.
    let readGate = null;
    const settle = (result, cb, gate) => {
      if (typeof cb === 'function') {
        if (gate) gate.then(() => cb(result));
        else queueMicrotask(() => cb(result));
        return undefined;
      }
      return gate ? gate.then(() => result) : Promise.resolve(result);
    };
    // Writes are never gated — Chrome does not order them behind reads.
    const withCallback = (result, cb) => settle(result, cb, null);
    const withReadCallback = (result, cb) => settle(result, cb, readGate);
    return {
      /**
       * Hold every subsequent `get` until the returned function is called.
       * Writes are unaffected — Chrome does not order them behind reads.
       */
      _holdReads() {
        let release;
        readGate = new Promise((resolve) => { release = resolve; });
        return () => {
          const gate = readGate;
          readGate = null;
          release();
          return gate;
        };
      },
      get: (keys, cb) => {
        calls.push({ api: 'storage.get', keys });
        let out;
        if (keys == null) out = { ...data };
        else if (typeof keys === 'string') out = { [keys]: data[keys] };
        else if (Array.isArray(keys)) {
          out = {};
          for (const k of keys) out[k] = data[k];
        } else {
          // object form: keys = { foo: defaultValue }
          out = {};
          for (const [k, def] of Object.entries(keys)) {
            out[k] = k in data ? data[k] : def;
          }
        }
        return withReadCallback(out, cb);
      },
      set: (entries, cb) => {
        calls.push({ api: 'storage.set', entries });
        // Clone like real chrome.storage does — storing live references lets
        // later in-memory mutations silently rewrite "persisted" state.
        Object.assign(data, structuredClone(entries));
        return withCallback(undefined, cb);
      },
      remove: (keys, cb) => {
        calls.push({ api: 'storage.remove', keys });
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) delete data[k];
        return withCallback(undefined, cb);
      },
      clear: (cb) => {
        calls.push({ api: 'storage.clear' });
        data = {};
        return withCallback(undefined, cb);
      },
      _data: () => data,
    };
  };

  // ---- chrome.declarativeNetRequest ----
  const dnr = {
    _staticEnabled: new Set(),
    _dynamic: new Map(), // id -> rule
    _rulesetCounts: new Map(),
    async getDynamicRules() {
      calls.push({ api: 'dnr.getDynamicRules' });
      return [...dnr._dynamic.values()];
    },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] } = {}) {
      calls.push({ api: 'dnr.updateDynamicRules', removeRuleIds, addRuleCount: addRules.length });
      // Chrome-parity validation (REVIEW-2026-07 §4.15): updateDynamicRules is
      // all-or-nothing and rejects the ENTIRE batch when any rule has a
      // non-ASCII urlFilter or an RE2-incompatible regexFilter. Validate
      // BEFORE mutating so a rejected batch leaves state untouched, like
      // Chrome does.
      for (const rule of addRules) {
        const condition = rule.condition || {};
        if (typeof condition.urlFilter === 'string' && !/^[\x00-\x7F]*$/.test(condition.urlFilter)) {
          throw new Error(`Rule with id ${rule.id} has an invalid non-ascii urlFilter`);
        }
        if (typeof condition.regexFilter === 'string' && /\(\?<?[=!]/.test(condition.regexFilter)) {
          throw new Error(`Rule with id ${rule.id} has an unsupported regexFilter (RE2)`);
        }
        validateDnrRuleSchema(rule);
      }
      // Removals apply before additions (Chrome semantics), so re-adding an
      // id listed in removeRuleIds within the same call is legal.
      const removed = new Set(removeRuleIds);
      const seen = new Set();
      for (const rule of addRules) {
        if (seen.has(rule.id) || (dnr._dynamic.has(rule.id) && !removed.has(rule.id))) {
          throw new Error(`Duplicate rule id ${rule.id}`);
        }
        seen.add(rule.id);
      }
      for (const id of removeRuleIds) dnr._dynamic.delete(id);
      for (const rule of addRules) dnr._dynamic.set(rule.id, rule);
    },
    // Mirrors chrome.declarativeNetRequest.isRegexSupported: RE2 has no
    // lookaround. Tests can `delete` this to simulate API drift.
    async isRegexSupported({ regex }) {
      calls.push({ api: 'dnr.isRegexSupported', regex });
      return { isSupported: !/\(\?<?[=!]/.test(regex) };
    },
    async getEnabledRulesets() {
      calls.push({ api: 'dnr.getEnabledRulesets' });
      return [...dnr._staticEnabled];
    },
    async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] } = {}) {
      calls.push({ api: 'dnr.updateEnabledRulesets', enableRulesetIds, disableRulesetIds });
      for (const id of disableRulesetIds) dnr._staticEnabled.delete(id);
      for (const id of enableRulesetIds) dnr._staticEnabled.add(id);
    },
    async getAvailableStaticRuleCount() {
      return 30000;
    },
    onRuleMatchedDebug: makeListenerEvent(),
  };

  // ---- chrome.scripting ----
  const scripting = {
    _registered: new Map(), // id -> script
    _execLog: [],
    async getRegisteredContentScripts({ ids = null } = {}) {
      const all = [...scripting._registered.values()];
      const out = ids ? all.filter((s) => ids.includes(s.id)) : all;
      calls.push({ api: 'scripting.getRegisteredContentScripts', ids });
      return out;
    },
    async registerContentScripts(scripts) {
      calls.push({ api: 'scripting.registerContentScripts', ids: scripts.map((s) => s.id) });
      for (const script of scripts) {
        if (scripting._registered.has(script.id)) {
          throw new Error(`Duplicate registration id ${script.id}`);
        }
        scripting._registered.set(script.id, { ...script });
      }
    },
    async updateContentScripts(scripts) {
      calls.push({ api: 'scripting.updateContentScripts', ids: scripts.map((s) => s.id) });
      for (const script of scripts) {
        const existing = scripting._registered.get(script.id);
        if (!existing) throw new Error(`No registration for id ${script.id}`);
        scripting._registered.set(script.id, { ...existing, ...script });
      }
    },
    async unregisterContentScripts({ ids = [] } = {}) {
      calls.push({ api: 'scripting.unregisterContentScripts', ids });
      for (const id of ids) scripting._registered.delete(id);
    },
    // Opt-in MAIN-world evaluation. OFF by default: most tests rely on
    // `executeScript` being inert, and the boot-key/registry helpers are
    // exercised directly through the test hooks instead.
    //
    // Set `stub.scripting._evaluateInjectedFuncs = true` when the *return
    // value* of an injected func is the thing under test — §5.22's
    // unknown-scriptlet readback is carried by nothing else. The func then runs
    // in this process against `globalThis`, so the test must provide whatever
    // MAIN-world globals it touches (`globalThis.window`, the registry key).
    _evaluateInjectedFuncs: false,
    async executeScript(injection) {
      calls.push({ api: 'scripting.executeScript', target: injection.target, world: injection.world, files: injection.files, hasFunc: typeof injection.func === 'function' });
      scripting._execLog.push(injection);
      if (scripting._evaluateInjectedFuncs && typeof injection.func === 'function') {
        return [{ result: await injection.func(...(injection.args || [])), frameId: 0 }];
      }
      return [{ result: undefined, frameId: 0 }];
    },
    async insertCSS(injection) {
      calls.push({ api: 'scripting.insertCSS', target: injection.target });
    },
    async removeCSS(injection) {
      calls.push({ api: 'scripting.removeCSS', target: injection.target });
    },
  };

  // ---- chrome.tabs ----
  const tabs = {
    _tabs: new Map(), // id -> tab
    async query(filter) {
      calls.push({ api: 'tabs.query', filter });
      const list = [...tabs._tabs.values()];
      if (!filter) return list;
      return list.filter((t) => {
        if (filter.url) {
          const patterns = Array.isArray(filter.url) ? filter.url : [filter.url];
          return patterns.some((p) => matchesPattern(p, t.url));
        }
        return true;
      });
    },
    async get(id) {
      calls.push({ api: 'tabs.get', id });
      return tabs._tabs.get(id) || null;
    },
    // §4.24 — records the `options` argument, because the whole defect is an
    // omitted `{frameId: 0}`: without it Chrome broadcasts to every frame the
    // content script runs in, and the picker overlay is built once per iframe.
    async sendMessage(tabId, message, options = undefined) {
      calls.push({ api: 'tabs.sendMessage', tabId, message, options });
      return undefined;
    },
    onUpdated: makeListenerEvent(),
    onRemoved: makeListenerEvent(),
    onActivated: makeListenerEvent(),
    _addTab: (tab) => {
      const t = { id: tab.id ?? tabs._tabs.size + 1, url: tab.url, ...tab };
      tabs._tabs.set(t.id, t);
      return t;
    },
    _removeTab: (id) => tabs._tabs.delete(id),
  };

  // ---- chrome.webNavigation ----
  const webNavigation = {
    _frames: new Map(), // tabId -> frames[]
    async getAllFrames({ tabId }) {
      calls.push({ api: 'webNavigation.getAllFrames', tabId });
      return webNavigation._frames.get(tabId) || null;
    },
    onBeforeNavigate: makeListenerEvent(),
    onCommitted: makeListenerEvent(),
    onCompleted: makeListenerEvent(),
    _setFrames: (tabId, frames) => webNavigation._frames.set(tabId, frames),
  };

  // ---- chrome.runtime ----
  const messageListeners = makeListenerEvent();
  const runtime = {
    id: extensionId,
    lastError: null,
    getManifest: () => ({
      manifest_version: 3,
      name: 'Nullify',
      version: '0.0.0-test',
      declarative_net_request: { rule_resources: [] },
    }),
    getURL: (path) => `chrome-extension://${extensionId}/${path.replace(/^\//, '')}`,
    onInstalled: makeListenerEvent(),
    onStartup: makeListenerEvent(),
    onSuspend: makeListenerEvent(),
    onMessage: messageListeners,
    // `senderOverrides` is a test-only extension: merged into the default
    // sender so tests can simulate content-script senders (sender.tab etc.).
    sendMessage: async (message, senderOverrides = null) => {
      const sender = {
        id: extensionId,
        url: `chrome-extension://${extensionId}/test`,
        ...(senderOverrides || {}),
      };
      calls.push({ api: 'runtime.sendMessage', message, sender });
      // §7.1 — serialize on dispatch: the handler must never see the caller's
      // live object.
      const delivered = serializeForBus(message, 'message');
      return new Promise((resolve) => {
        let responded = false;
        const sendResponse = (response) => {
          if (responded) return;
          responded = true;
          // …and again on the way back, so a handler returning a class
          // instance, an Error, or an `undefined`-valued field is observed by
          // the caller exactly as Chrome would deliver it.
          resolve(serializeForBus(response, 'response'));
        };
        let anyAsync = false;
        for (const fn of messageListeners._listeners) {
          const result = fn(delivered, sender, sendResponse);
          if (result === true) anyAsync = true;
        }
        if (!anyAsync) {
          // No async listener — resolve undefined synchronously next tick
          queueMicrotask(() => sendResponse(undefined));
        }
      });
    },
  };

  // ---- chrome.alarms ----
  const alarms = {
    _alarms: new Map(),
    async create(name, opts) {
      calls.push({ api: 'alarms.create', name, opts });
      alarms._alarms.set(name, { name, ...opts });
    },
    async get(name) { return alarms._alarms.get(name) || null; },
    async clear(name) { return alarms._alarms.delete(name); },
    onAlarm: makeListenerEvent(),
  };

  // ---- chrome.contextMenus ----
  const contextMenus = {
    _items: new Map(),
    create(props, cb) {
      calls.push({ api: 'contextMenus.create', id: props.id });
      if (contextMenus._items.has(props.id)) {
        runtime.lastError = { message: `Cannot create item with duplicate id ${props.id}` };
      } else {
        contextMenus._items.set(props.id, props);
        runtime.lastError = null;
      }
      if (cb) cb();
      runtime.lastError = null;
      return props.id;
    },
    remove(id, cb) {
      calls.push({ api: 'contextMenus.remove', id });
      contextMenus._items.delete(id);
      if (cb) cb();
    },
    removeAll(cb) {
      calls.push({ api: 'contextMenus.removeAll' });
      contextMenus._items.clear();
      runtime.lastError = null;
      if (cb) cb();
    },
    onClicked: makeListenerEvent(),
  };

  // ---- chrome.action ----
  const action = {
    _badges: new Map(), // tabId -> { text, color }
    async setBadgeText({ text, tabId }) {
      calls.push({ api: 'action.setBadgeText', text, tabId });
      const entry = action._badges.get(tabId) || {};
      entry.text = text;
      action._badges.set(tabId, entry);
    },
    async setBadgeBackgroundColor({ color, tabId }) {
      calls.push({ api: 'action.setBadgeBackgroundColor', color, tabId });
      const entry = action._badges.get(tabId) || {};
      entry.color = color;
      action._badges.set(tabId, entry);
    },
  };

  // ---- chrome.privacy (subset used by service worker) ----
  const privacy = {
    network: {
      webRTCIPHandlingPolicy: {
        async set(opts) { calls.push({ api: 'privacy.webRTC.set', opts }); },
        async clear(opts) { calls.push({ api: 'privacy.webRTC.clear', opts }); },
      },
    },
    websites: {
      hyperlinkAuditingEnabled: {
        async set(opts) { calls.push({ api: 'privacy.hyperlinkAuditing.set', opts }); },
        async clear(opts) { calls.push({ api: 'privacy.hyperlinkAuditing.clear', opts }); },
      },
      thirdPartyCookiesAllowed: {
        set(opts, cb) { calls.push({ api: 'privacy.thirdPartyCookies.set', opts }); cb?.(); },
      },
    },
  };

  return {
    runtime,
    storage: {
      local: storageArea(),
      session: storageArea(),
      sync: storageArea(),
    },
    declarativeNetRequest: dnr,
    scripting,
    tabs,
    webNavigation,
    alarms,
    contextMenus,
    action,
    privacy,
    // Test-only handles:
    calls,
    _matchesPattern: matchesPattern,
  };
}
