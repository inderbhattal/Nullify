/**
 * json-prune.js
 *
 * Removes specified properties from JSON.parse results or fetch/XHR responses.
 * Used to strip ad-related payloads from JSON APIs.
 *
 * uBlock Origin equivalent: json-prune
 *
 * @param {string} paths     - Space-separated list of property paths to remove
 * @param {string} requiredPaths - Space-separated paths that must exist (to confirm match)
 */
export function jsonPrune(paths, requiredPaths) {
  if (!paths) return;

  const prune = parsePrunePaths(paths);
  const required = requiredPaths ? parsePrunePaths(requiredPaths) : [];

  const originalParse = JSON.parse;

  JSON.parse = function (...args) {
    const result = originalParse.apply(this, args);
    if (result && typeof result === 'object') {
      if (required.length === 0 || hasAllPaths(result, required)) {
        pruneObject(result, prune);
      }
    }
    return result;
  };

  // Modern sites use Fetch API + Response.json()
  if (window.Response && Response.prototype.json) {
    const originalJson = Response.prototype.json;
    Response.prototype.json = async function (...args) {
      const result = await originalJson.apply(this, args);
      if (result && typeof result === 'object') {
        if (required.length === 0 || hasAllPaths(result, required)) {
          pruneObject(result, prune);
        }
      }
      return result;
    };
  }
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

function pruneObject(obj, paths) {
  for (const path of paths) {
    prunePath(obj, path.split('.'), 0);
  }
}

function prunePath(target, parts, index) {
  if (target == null || typeof target !== 'object') return;
  const part = parts[index];
  if (isProtoPollutionKey(part)) return;
  const isLast = index === parts.length - 1;

  if (isArrayWildcard(part) || part === '*') {
    for (const key of [...wildcardKeys(target, part)]) {
      if (isProtoPollutionKey(String(key))) continue;
      if (isLast) delete target[key];
      else prunePath(target[key], parts, index + 1);
    }
    // Deleting array indices leaves holes; a terminal `[]` means "drop the
    // elements", so collapse the array too.
    if (isLast && Array.isArray(target)) target.length = 0;
    return;
  }

  if (isLast) {
    delete target[part];
    return;
  }
  prunePath(target[part], parts, index + 1);
}
