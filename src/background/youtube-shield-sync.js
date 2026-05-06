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
}) {
  const targetHostnames = new Set(targets.map(({ hostname }) => normalizeHostname(hostname)));
  let inFlight = null;

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

  async function injectIntoOpenTabs() {
    const tabs = await chrome.tabs
      .query({ url: targets.map(({ pattern }) => pattern) })
      .catch(() => []);

    await Promise.all((tabs || []).map(async (tab) => {
      if (tab.id == null) return;

      const frames = await chrome.webNavigation
        .getAllFrames({ tabId: tab.id })
        .catch(() => null);

      if (!Array.isArray(frames)) {
        if (!tab.url) return;
        let hostname = '';
        try {
          hostname = normalizeHostname(new URL(tab.url).hostname);
        } catch {
          return;
        }
        if (!targetHostnames.has(hostname) || isHostnameAllowed(hostname)) return;

        await chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            files: [runtimeAssetPath('youtube-shield.js')],
          })
          .catch(() => {});
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

      await Promise.all(frameIds.map((frameId) => chrome.scripting
        .executeScript({
          target: { tabId: tab.id, frameIds: [frameId] },
          world: 'MAIN',
          files: [runtimeAssetPath('youtube-shield.js')],
        })
        .catch(() => {})));
    }));
  }

  async function _runSync() {
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
      await injectIntoOpenTabs();
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
