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

export function makeChromeStub({ extensionId = 'nullify-test-id' } = {}) {
  const calls = new CallLog();

  // ---- chrome.storage ----
  // Mirrors Chrome's dual API: promise-based when no callback is passed,
  // callback-based (invoked async) when one is — src/shared/storage.js uses
  // the callback form, the service worker's storage.session usage the
  // promise form.
  const storageArea = (initial = {}) => {
    let data = { ...initial };
    const withCallback = (result, cb) => {
      if (typeof cb === 'function') {
        queueMicrotask(() => cb(result));
        return undefined;
      }
      return Promise.resolve(result);
    };
    return {
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
        return withCallback(out, cb);
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
    async executeScript(injection) {
      calls.push({ api: 'scripting.executeScript', target: injection.target, world: injection.world, files: injection.files, hasFunc: typeof injection.func === 'function' });
      scripting._execLog.push(injection);
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
      return new Promise((resolve) => {
        let responded = false;
        const sendResponse = (response) => {
          if (responded) return;
          responded = true;
          resolve(response);
        };
        let anyAsync = false;
        for (const fn of messageListeners._listeners) {
          const result = fn(message, sender, sendResponse);
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
