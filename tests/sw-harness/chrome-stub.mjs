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
  const storageArea = (initial = {}) => {
    let data = { ...initial };
    return {
      get: async (keys) => {
        calls.push({ api: 'storage.get', keys });
        if (keys == null) return { ...data };
        if (typeof keys === 'string') return { [keys]: data[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = data[k];
          return out;
        }
        // object form: keys = { foo: defaultValue }
        const out = {};
        for (const [k, def] of Object.entries(keys)) {
          out[k] = k in data ? data[k] : def;
        }
        return out;
      },
      set: async (entries) => {
        calls.push({ api: 'storage.set', entries });
        Object.assign(data, entries);
      },
      remove: async (keys) => {
        calls.push({ api: 'storage.remove', keys });
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) delete data[k];
      },
      clear: async () => {
        calls.push({ api: 'storage.clear' });
        data = {};
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
      for (const id of removeRuleIds) dnr._dynamic.delete(id);
      for (const rule of addRules) {
        if (dnr._dynamic.has(rule.id)) {
          throw new Error(`Duplicate rule id ${rule.id}`);
        }
        dnr._dynamic.set(rule.id, rule);
      }
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
    sendMessage: async (message) => {
      const sender = { id: extensionId, url: `chrome-extension://${extensionId}/test` };
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
    privacy,
    // Test-only handles:
    calls,
    _matchesPattern: matchesPattern,
  };
}
