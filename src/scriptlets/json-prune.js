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
}

function parsePrunePaths(pathsStr) {
  return pathsStr.trim().split(/\s+/).filter(Boolean);
}

function hasAllPaths(obj, paths) {
  return paths.every((path) => getByPath(obj, path) !== undefined);
}

function getByPath(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function pruneObject(obj, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    const lastKey = parts[parts.length - 1];

    let target = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (target == null || typeof target !== 'object') { target = null; break; }
      target = target[parts[i]];
    }

    if (target && typeof target === 'object') {
      delete target[lastKey];
    }
  }
}
