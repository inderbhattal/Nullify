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
  return paths.every((path) => getByPath(obj, path) !== undefined);
}

/**
 * uBO wildcard segments: `[]`/`[-]` iterate array elements, `*` iterates own
 * keys. Everything else is a literal key. The isProtoPollutionKey guard is
 * applied per segment — including keys produced by a `*` expansion.
 */
function isArrayWildcard(part) {
  return part === '[]' || part === '[-]';
}

function wildcardKeys(target, part) {
  if (isArrayWildcard(part)) {
    return Array.isArray(target) ? target.keys() : [];
  }
  return Object.keys(target);
}

function getByPath(obj, path) {
  return findByPath(obj, path.split('.'), 0);
}

function findByPath(current, parts, index) {
  if (index === parts.length) return current;
  if (current == null || typeof current !== 'object') return undefined;
  const part = parts[index];
  if (isProtoPollutionKey(part)) return undefined;
  if (isArrayWildcard(part) || part === '*') {
    // A wildcard path "exists" if any branch resolves to a defined value.
    for (const key of wildcardKeys(current, part)) {
      if (isProtoPollutionKey(String(key))) continue;
      const found = findByPath(current[key], parts, index + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return findByPath(current[part], parts, index + 1);
}

/** @returns {boolean} whether any key was actually removed. */
function pruneObject(obj, paths) {
  let pruned = false;
  for (const path of paths) {
    if (prunePath(obj, path.split('.'), 0)) pruned = true;
  }
  return pruned;
}

function prunePath(target, parts, index) {
  if (target == null || typeof target !== 'object') return false;
  const part = parts[index];
  if (isProtoPollutionKey(part)) return false;
  const isLast = index === parts.length - 1;
  let pruned = false;

  if (isArrayWildcard(part) || part === '*') {
    for (const key of [...wildcardKeys(target, part)]) {
      if (isProtoPollutionKey(String(key))) continue;
      if (isLast) {
        if (Object.hasOwn(target, key)) pruned = true;
        delete target[key];
      } else if (prunePath(target[key], parts, index + 1)) {
        pruned = true;
      }
    }
    // Deleting array indices leaves holes; a terminal `[]` means "drop the
    // elements", so collapse the array too.
    if (isLast && Array.isArray(target)) target.length = 0;
    return pruned;
  }

  if (isLast) {
    if (Object.hasOwn(target, part) === false) return false;
    delete target[part];
    return true;
  }
  return prunePath(target[part], parts, index + 1);
}
