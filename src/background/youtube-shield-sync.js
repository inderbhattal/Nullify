/**
 * YouTube Shield registration sync — extracted from service-worker.js so it
 * can be exercised against an in-memory chrome stub in tests. Behavior is a
 * one-for-one match with the prior in-line implementation. The factory takes
 * the chrome API and a small set of helpers as parameters; production wires
 * it to globalThis.chrome and the SW's allowlist matcher.
 *
 * The pattern of bugs this module has historically suffered from
 * (commits b327340, 3a35970, f9b4f39):
 * - registerContentScripts only affects future navigations, so an existing
 *   YT tab kept the stale registration after an allowlist change.
 * - Two allowlist mutations close together raced via abort-controller; the
 *   second could be aborted by the first while it was still resolving.
 * - persistAcrossSessions missing from the equality check made every refresh
 *   redundantly re-register.
 *
 * The current implementation:
 * - Sequences calls through a single in-flight promise chain (no abort).
 * - Compares persistAcrossSessions in the same-registration short-circuit.
 * - Always invokes injectIntoOpenTabs after a registration touch so live
 *   tabs reflect the new excludeMatches without a reload.
 * - Behind `shieldNoReinject` (§5.18, default off): an unchanged registration
 *   is left alone unless a document may have been missed — see below. The flag
 *   is injected (`isFeatureEnabled`) rather than read from storage here, so the
 *   harness can drive it without a global chrome.
 *
 * §5.18 second review — why the same-registration branch still injects
 * sometimes.
 * `registerContentScripts` and `injectIntoOpenTabs` are the only two ways the
 * shield ever enters a page, and this branch is the only repair path for a
 * document the persisted registration did not actually reach. §5.18's premise
 * — Chrome injects a persisted registration into every new document — holds
 * only for documents created *after* the registration existed and whose
 * injection *succeeded*. Two cases break it, and in both the user sees ads on
 * YouTube with the extension enabled and the popup reporting the site is not
 * allowlisted, until they navigate:
 *   - an injection that failed silently (a tab mid-navigation, on an error
 *     page, or not yet matching the target patterns when the first sync ran);
 *   - a tab loaded while no registration was in force at all — the extension
 *     disabled and re-enabled, or updated — with the registration surviving in
 *     Chrome's store, so `sameRegistration` is true and nothing else would ever
 *     touch that tab.
 * Both are repaired, and the repair is bounded so §5.18's win survives: a full
 * sweep only on the first sync of an *extension* life, and otherwise only the
 * tabs an injection actually missed — normally none, so a worker wake still
 * costs zero injections.
 */

import { normalizeHostname } from '../shared/hostname.js';

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createYouTubeShieldSync({
  chrome,
  isHostnameAllowed,
  runtimeAssetPath,
  scriptId,
  targets,
  isFeatureEnabled = () => false,
}) {
  const targetHostnames = new Set(targets.map(({ hostname }) => normalizeHostname(hostname)));
  let inFlight = null;

  // §5.18 — the bounded repair state. Closure-scoped, not module-scoped: the
  // worker builds one instance, and a test builds one per scenario.
  //
  // `pendingRepairTabs` holds the tab ids whose injection did not complete
  // cleanly; `pendingFullSweep` covers the case where a failed `tabs.query`
  // means we do not even know which tabs we did not see.
  const pendingRepairTabs = new Set();
  let pendingFullSweep = false;

  // `storage.session` is cleared when the extension is reloaded, updated or
  // disabled and re-enabled, but survives a service-worker restart — exactly
  // the distinction the sweep needs. A new *worker* can trust the persisted
  // registration; a new *extension life* cannot, because a document may have
  // loaded while no registration was in force.
  const SWEPT_KEY = 'nullify:shieldSweptLife';
  let sweptThisLife = false;

  function sessionArea() {
    try {
      return chrome.storage?.session || null;
    } catch {
      return null;
    }
  }

  async function hasSweptThisLife() {
    if (sweptThisLife) return true;
    const area = sessionArea();
    // No session storage, or an unreadable one: sweep. One extra injection is
    // a far cheaper mistake than a YouTube tab that never gets the shield.
    if (!area) return false;
    const stored = await area.get(SWEPT_KEY).catch(() => null);
    if (stored?.[SWEPT_KEY] !== true) return false;
    sweptThisLife = true;
    return true;
  }

  async function markSweptThisLife() {
    if (sweptThisLife) return;
    sweptThisLife = true;
    const area = sessionArea();
    if (!area) return;
    await area.set({ [SWEPT_KEY]: true }).catch(() => {});
  }

  function getExcludeMatches() {
    return targets
      .filter(({ hostname }) => isHostnameAllowed(hostname))
      .map(({ pattern }) => pattern);
  }

  function buildRegistration() {
    return {
      id: scriptId,
      matches: targets.map(({ pattern }) => pattern),
      excludeMatches: getExcludeMatches(),
      js: [runtimeAssetPath('youtube-shield.js')],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      persistAcrossSessions: true,
    };
  }

  /**
   * @param {{ onlyTabIds?: Set<number>|null }} [options] Restrict the pass to
   *   these tab ids — the §5.18 repair. Omitted, every open target tab is swept,
   *   which is what every caller but the same-registration branch wants.
   */
  async function injectIntoOpenTabs({ onlyTabIds = null } = {}) {
    let queryFailed = false;
    const tabs = await chrome.tabs
      .query({ url: targets.map(({ pattern }) => pattern) })
      .catch(() => { queryFailed = true; return []; });

    // §5.18 — a failed query hides which tabs were missed, so the repair set
    // cannot be trusted and the next sync sweeps everything instead.
    if (queryFailed) {
      pendingFullSweep = true;
      return;
    }

    const openTabs = tabs || [];

    // A tab that is no longer open (or has navigated off a target host) cannot
    // be repaired, so drop it rather than carrying it forever.
    if (onlyTabIds !== null) {
      const open = new Set(openTabs.map((tab) => tab.id));
      for (const id of onlyTabIds) {
        if (!open.has(id)) pendingRepairTabs.delete(id);
      }
    }

    await Promise.all(openTabs.map(async (tab) => {
      if (tab.id == null) return;
      if (onlyTabIds !== null && !onlyTabIds.has(tab.id)) return;

      // §5.18 — the outcome is recorded rather than swallowed. With
      // `shieldNoReinject` on, the same-registration branch injects into
      // exactly the tabs this set holds, so a failure dropped here would never
      // be repaired: `registerContentScripts` and this function are the only
      // two paths that ever put the shield into a page.
      let clean = true;
      const inject = (target) => chrome.scripting
        .executeScript({
          target,
          world: 'MAIN',
          files: [runtimeAssetPath('youtube-shield.js')],
        })
        .catch(() => { clean = false; });

      try {
        const frames = await chrome.webNavigation
          .getAllFrames({ tabId: tab.id })
          // A rejection degrades to the tab-URL path below, which reaches the
          // top frame only — so the tab stays marked for repair.
          .catch(() => { clean = false; return null; });

        if (!Array.isArray(frames)) {
          if (!tab.url) return;
          let hostname = '';
          try {
            hostname = normalizeHostname(new URL(tab.url).hostname);
          } catch {
            return;
          }
          if (!targetHostnames.has(hostname) || isHostnameAllowed(hostname)) return;

          await inject({ tabId: tab.id });
          return;
        }

        const frameIds = frames
          .filter((frame) => {
            if (!frame?.url?.startsWith('http')) return false;
            try {
              const hostname = normalizeHostname(new URL(frame.url).hostname);
              return targetHostnames.has(hostname) && !isHostnameAllowed(hostname);
            } catch {
              return false;
            }
          })
          .map((frame) => frame.frameId)
          .filter((frameId) => Number.isInteger(frameId));

        if (frameIds.length === 0) return;

        await Promise.all(frameIds.map((frameId) => inject({
          tabId: tab.id,
          frameIds: [frameId],
        })));
      } finally {
        // Reached by every path above, including the early returns: an
        // allowlisted or non-target tab is not a tab we missed.
        if (clean) pendingRepairTabs.delete(tab.id);
        else pendingRepairTabs.add(tab.id);
      }
    }));
  }

  /**
   * §5.18 — the bounded repair the same-registration branch performs when
   * `shieldNoReinject` is on. Normally a no-op: the repair set is empty and the
   * extension life is already marked, so not one `executeScript` is issued.
   */
  async function repairMissedDocuments() {
    if (pendingFullSweep || !(await hasSweptThisLife())) {
      pendingFullSweep = false;
      await injectIntoOpenTabs();
      return;
    }
    if (pendingRepairTabs.size === 0) return;
    // Snapshot: the pass mutates the set as tabs succeed or fail again.
    await injectIntoOpenTabs({ onlyTabIds: new Set(pendingRepairTabs) });
  }

  async function _runSync() {
    // Read once per sync, not at construction: the SW's flag cache fills after
    // start-up and can change while the worker lives. Both branches below need
    // the answer, so it is read here rather than at the point of use.
    const noReinject = isFeatureEnabled('shieldNoReinject') === true;
    await _syncBranches(noReinject);
    // §5.18 — every branch above has considered this extension life's open tabs,
    // so a later worker in the same life can skip the sweep. Only reached on
    // success: a throw propagates and leaves the life unmarked, so the next
    // sync sweeps. The flag-off path never marks — it sweeps unconditionally
    // and must stay byte-for-byte what shipped.
    if (noReinject) await markSweptThisLife();
  }

  async function _syncBranches(noReinject) {
    const registration = buildRegistration();
    const existingScripts = await chrome.scripting
      .getRegisteredContentScripts({ ids: [scriptId] })
      .catch(() => []);
    const existing = existingScripts?.[0] || null;

    const sameRegistration =
      existing &&
      arraysEqual(existing.matches || [], registration.matches) &&
      arraysEqual(existing.excludeMatches || [], registration.excludeMatches) &&
      arraysEqual(existing.js || [], registration.js) &&
      existing.runAt === registration.runAt &&
      existing.world === registration.world &&
      existing.allFrames === registration.allFrames &&
      existing.persistAcrossSessions === registration.persistAcrossSessions;

    if (sameRegistration) {
      // §5.18 — a persisted registration is injected by Chrome into every new
      // document, including one opened while the worker was asleep, so
      // re-injecting here evaluates the bundle a second time in every open
      // YouTube tab on every wake. Only a changed excludeMatches needs live
      // tabs touched, and that is the branch below, not this one.
      if (!noReinject) {
        await injectIntoOpenTabs();
        return;
      }
      // …except for the documents the registration never actually reached.
      // See §5.18 in the file header: bounded, and normally zero injections.
      await repairMissedDocuments();
      return;
    }

    const canUpdateExcludeMatchesOnly =
      existing &&
      typeof chrome.scripting.updateContentScripts === 'function' &&
      arraysEqual(existing.matches || [], registration.matches) &&
      arraysEqual(existing.js || [], registration.js) &&
      existing.runAt === registration.runAt &&
      existing.world === registration.world &&
      existing.allFrames === registration.allFrames &&
      existing.persistAcrossSessions === registration.persistAcrossSessions;

    if (canUpdateExcludeMatchesOnly) {
      await chrome.scripting.updateContentScripts([{
        id: scriptId,
        excludeMatches: registration.excludeMatches,
      }]);
      await injectIntoOpenTabs();
      return;
    }

    if (existing) {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] }).catch(() => {});
    }

    await chrome.scripting.registerContentScripts([registration]);
    await injectIntoOpenTabs();
  }

  async function syncRegistration() {
    const previous = inFlight || Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(_runSync)
      .catch((err) => {
        console.error('[Nullify] Failed to sync YouTube shield registration:', err);
      });

    let tracked;
    tracked = pending.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  }

  return {
    syncRegistration,
    injectIntoOpenTabs,
    // Test-only handles (do not consume from production code):
    _buildRegistration: buildRegistration,
    _arraysEqual: arraysEqual,
  };
}
