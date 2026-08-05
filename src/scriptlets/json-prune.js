import {
  collateFetchArguments, getExtraArgs, matchObjectProperties, parsePropsToMatch,
  proxyApply, wrapInstanceGetter,
} from './shared-utils.js';

/**
 * json-prune.js
 *
 * Removes specified properties from parsed JSON. uBO ships three scriptlets
 * over one pruning core, each hooking exactly one surface:
 *
 *   json-prune                 → JSON.parse
 *   json-prune-fetch-response  → fetch(), URL-gated by construction
 *   json-prune-xhr-response    → XMLHttpRequest.response, URL-gated
 *
 * §4.21: all three used to be one function that hooked JSON.parse *and*
 * Response.prototype.json and ignored `propsToMatch` entirely, so a rule
 * scoped upstream to a single endpoint pruned the result of every JSON.parse
 * on the site — the YouTube `reelWatchSequenceResponse…` deletion, scoped to
 * `url:/reel_watch_sequence?`, ran against every parsed JSON on youtube.com.
 *
 * All 41 corpus rules carrying a `propsToMatch` vararg are
 * `json-prune-fetch-response`, and 18 more are `json-prune-xhr-response`; the
 * plain `json-prune` never takes one, because JSON.parse has no URL.
 *
 * @param {string} paths         - Space-separated property paths to remove.
 * @param {string} requiredPaths - Space-separated paths that must all exist.
 */
export function jsonPrune(paths, requiredPaths) {
  if (!paths) return;
  const pruner = makePruner(paths, requiredPaths);

  proxyApply(JSON, 'parse', (context) => {
    const result = context.reflect();
    pruner(result);
    return result;
  });
}

/** uBO's `json-prune-fetch-response` — prunes fetch bodies, never JSON.parse. */
export function jsonPruneFetchResponse(paths, requiredPaths, ...args) {
  if (!paths) return;
  const pruner = makePruner(paths, requiredPaths);
  const extraArgs = getExtraArgs(args, 0);
  const propNeedles = parsePropsToMatch(extraArgs.propsToMatch, 'url');

  const pruneResponse = async (context) => {
    const before = await context.reflect();
    try {
      const obj = await before.clone().json();
      if (!obj || typeof obj !== 'object') return before;
      if (pruner(obj) === false) return before;
      const after = new Response(JSON.stringify(obj), {
        status: before.status,
        statusText: before.statusText,
        headers: before.headers,
      });
      try {
        Object.defineProperties(after, {
          ok: { value: before.ok },
          redirected: { value: before.redirected },
          type: { value: before.type },
          url: { value: before.url },
        });
      } catch { /* best effort */ }
      return after;
    } catch {
      return before; // not JSON, or the body was already consumed
    }
  };

  proxyApply(window, 'fetch', (context) => {
    if (propNeedles.size !== 0) {
      const props = collateFetchArguments(...context.callArgs);
      if (matchObjectProperties(propNeedles, props) === undefined) return context.reflect();
    }
    return pruneResponse(context);
  });
}

/** uBO's `json-prune-xhr-response` — prunes XHR bodies, never JSON.parse. */
export function jsonPruneXhrResponse(paths, requiredPaths, ...args) {
  if (!paths) return;
  const pruner = makePruner(paths, requiredPaths);
  const extraArgs = getExtraArgs(args, 0);
  const propNeedles = parsePropsToMatch(extraArgs.propsToMatch, 'url');

  const XHR = window.XMLHttpRequest;
  if (typeof XHR !== 'function') return;
  const targets = new WeakMap();

  proxyApply(XHR.prototype, 'open', (context) => {
    const { thisArg, callArgs } = context;
    const haystack = { method: callArgs[0], url: String(callArgs[1] ?? '') };
    if (propNeedles.size === 0 || matchObjectProperties(propNeedles, haystack)) {
      targets.set(thisArg, true);
    } else {
      targets.delete(thisArg);
    }
    return context.reflect();
  });

  const transform = (value, xhr) => {
    if (targets.get(xhr) !== true) return value;
    let obj = value;
    if (typeof value === 'string') {
      try { obj = JSON.parse(value); } catch { return value; }
    }
    if (!obj || typeof obj !== 'object') return value;
    if (pruner(obj) === false) return value;
    return typeof value === 'string' ? JSON.stringify(obj) : obj;
  };
  wrapInstanceGetter(XHR.prototype, 'response', transform);
  wrapInstanceGetter(XHR.prototype, 'responseText', transform);
}

/**
 * Compile the prune/require path lists into a single in-place pruner.
 * @returns {(obj: unknown) => boolean} whether anything was pruned.
 */
function makePruner(paths, requiredPaths) {
  const prune = parsePrunePaths(paths);
  const required = requiredPaths ? parsePrunePaths(requiredPaths) : [];
  return (result) => {
    if (!result || typeof result !== 'object') return false;
    if (required.length !== 0 && hasAllPaths(result, required) === false) return false;
    return pruneObject(result, prune);
  };
}

function isProtoPollutionKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function parsePrunePaths(pathsStr) {
  return pathsStr.trim().split(/\s+/).filter(Boolean);
}

function hasAllPaths(obj, paths) {
  return paths.every((path) => objectFindOwner(obj, path.split('.'), 0, false));
}

/** Terminal-segment array wildcards; see the note in `objectFindOwner`. */
function isArrayWildcard(part) {
  return part === '[]' || part === '[-]';
}

/** @returns {boolean} whether any key was actually removed. */
function pruneObject(obj, paths) {
  let pruned = false;
  for (const path of paths) {
    if (objectFindOwner(obj, path.split('.'), 0, true)) pruned = true;
  }
  return pruned;
}

/**
 * uBO's `objectFindOwnerFn` (resources/object-prune.js), in path-array form.
 *
 * §5.38: `[-]` used to be an alias of `[]` — the element was walked into and
 * the leaf key deleted, but the element itself stayed. uBO's four wildcard
 * families are distinct:
 *
 *   `[-]`  on an array : SPLICE OUT every element whose remaining path exists
 *   `{-}`  on an object: DELETE every key whose remaining path exists
 *   `[]` `{}` `*`      : iterate, removing nothing at this level
 *   trailing `*`       : delete every own key
 *
 * The difference is what the shipped Shorts rule turns on:
 * `json-prune, entries.[-].command.reelWatchEndpoint.adClientParams.isAd`
 * must remove the ad reel from the sequence, not merely strip its `isAd` flag
 * and leave it occupying a slot.
 *
 * The `isProtoPollutionKey` guard is applied per segment, including keys
 * produced by a wildcard expansion.
 *
 * @param {unknown} owner
 * @param {string[]} parts
 * @param {number} index
 * @param {boolean} prune  false = existence test only, never mutates.
 * @returns {boolean} whether the path resolved (and, when pruning, removed).
 */
function objectFindOwner(owner, parts, index, prune) {
  let current = owner;
  let i = index;

  for (;;) {
    if (current === null || typeof current !== 'object') return false;
    const part = parts[i];
    if (isProtoPollutionKey(part)) return false;

    // --- terminal segment ---------------------------------------------------
    if (i === parts.length - 1) {
      if (prune === false) return Object.hasOwn(current, part);
      let modified = false;
      if (part === '*' || part === '{-}') {
        for (const key of Object.keys(current)) {
          if (isProtoPollutionKey(key)) continue;
          delete current[key];
          modified = true;
        }
      } else if (isArrayWildcard(part) && Array.isArray(current)) {
        // Nullify extension (uBO reads a terminal `[]` as a literal key, i.e.
        // a no-op): drop every element. No shipped rule ends in `[]`, but a
        // hand-written one plainly means "empty this array".
        modified = current.length !== 0;
        current.length = 0;
      } else if (Object.hasOwn(current, part)) {
        delete current[part];
        modified = true;
      }
      return modified;
    }

    // --- removing wildcards: the remainder is an existence test -------------
    if (prune && part === '[-]' && Array.isArray(current)) {
      let found = false;
      for (let k = current.length - 1; k >= 0; k--) {
        if (objectFindOwner(current[k], parts, i + 1, false) === false) continue;
        current.splice(k, 1);
        found = true;
      }
      return found;
    }
    if (prune && part === '{-}') {
      let found = false;
      for (const key of Object.keys(current)) {
        if (isProtoPollutionKey(key)) continue;
        if (objectFindOwner(current[key], parts, i + 1, false) === false) continue;
        delete current[key];
        found = true;
      }
      return found;
    }

    // --- iterating wildcards ------------------------------------------------
    const iterates = part === '{}' || part === '*' || part === '{-}'
      || (isArrayWildcard(part) && Array.isArray(current));
    if (iterates) {
      let found = false;
      for (const key of Object.keys(current)) {
        if (isProtoPollutionKey(key)) continue;
        if (objectFindOwner(current[key], parts, i + 1, prune)) found = true;
      }
      return found;
    }
    if (part === '[]' || part === '[-]') return false; // array wildcard, not an array

    if (Object.hasOwn(current, part) === false) return false;
    current = current[part];
    i += 1;
  }
}
