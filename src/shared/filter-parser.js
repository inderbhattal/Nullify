/**
 * filter-parser.js
 *
 * Lightweight ABP/EasyList parser for use in the service worker.
 * Only extracts cosmetic rules and scriptlet rules — network/DNR rules
 * are compiled at build time and remain static.
 */

/**
 * Parse scriptlet argument string, respecting quoted commas.
 * e.g. "set-constant, ads.enabled, false" → ['set-constant', 'ads.enabled', 'false']
 */
function parseScriptletArgs(str) {
  const args = [];
  let current = '';
  let inSingle = false, inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === ',' && !inSingle && !inDouble) {
      args.push(current.trim().replace(/^['"]|['"]$/g, ''));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim().replace(/^['"]|['"]$/g, ''));
  return args;
}

/**
 * Parse a single filter line. Returns a rule object or null if not a
 * cosmetic/scriptlet rule (or if the line is a comment/blank/network rule).
 */
function parseLine(line) {
  line = line.trim();
  if (!line || line.startsWith('!') || line.startsWith('[') ||
    line.startsWith('%') || line.startsWith('@@#')) return null;

  // Scriptlet: example.com##+js(name, args)
  const scriptletMatch = line.match(/^([^#]*)##\+js\((.+)\)$/) ||
    line.match(/^([^#]*)#\+js\((.+)\)$/);
  if (scriptletMatch) {
    const [, domains, scriptletStr] = scriptletMatch;
    const args = parseScriptletArgs(scriptletStr);
    const [name, ...rest] = args;
    return {
      type: 'scriptlet',
      domains: domains ? domains.split(',').map(d => d.trim()).filter(Boolean) : [],
      name: name.trim(),
      args: rest,
    };
  }

  // ABP extended CSS (#?#) — treat as cosmetic
  const abpMatch = line.match(/^([^#]*)#\?#(.+)$/);
  if (abpMatch) {
    const [, domains, selector] = abpMatch;
    return {
      type: 'cosmetic',
      domains: domains ? domains.split(',').map(d => d.trim()).filter(Boolean) : [],
      selector,
      exception: false,
    };
  }

  // Cosmetic hide: ##.selector or example.com##.selector
  const cosmeticMatch = line.match(/^([^#]*)##(.+)$/);
  if (cosmeticMatch) {
    const [, domains, selector] = cosmeticMatch;
    return {
      type: 'cosmetic',
      domains: domains ? domains.split(',').map(d => d.trim()).filter(Boolean) : [],
      selector,
      exception: false,
    };
  }

  // Cosmetic exception: example.com#@#.selector
  const exceptionMatch = line.match(/^([^#]*)#@#(.+)$/);
  if (exceptionMatch) {
    const [, domains, selector] = exceptionMatch;
    return {
      type: 'cosmetic',
      domains: domains ? domains.split(',').map(d => d.trim()).filter(Boolean) : [],
      selector,
      exception: true,
    };
  }

  return null; // Network rule or unsupported — skip
}

/**
 * Parse a full filter list text, extracting only cosmetic + scriptlet rules.
 * Returns { cosmeticRules, scriptletRules }.
 */
export function parseFilterList(text) {
  const cosmeticRules = [];
  const scriptletRules = [];

  for (const line of text.split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (parsed.type === 'cosmetic') cosmeticRules.push(parsed);
    else if (parsed.type === 'scriptlet') scriptletRules.push(parsed);
  }

  return {cosmeticRules, scriptletRules};
}

/**
 * Fetch a filter list URL and expand any !#include directives.
 * Uses the browser fetch() API (available in service workers).
 */
export async function fetchAndExpand(url, depth = 0) {
  if (depth > 5) return '';
  const res = await fetch(url, {cache: 'no-store'});
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();

  const baseUrl = url.slice(0, url.lastIndexOf('/') + 1);
  const lines = [];

  for (const line of text.split('\n')) {
    const m = line.trim().match(/^!#include\s+(.+)$/);
    if (m) {
      const includePath = m[1].trim();
      const includeUrl = includePath.startsWith('http') ? includePath : baseUrl + includePath;
      try {
        lines.push(await fetchAndExpand(includeUrl, depth + 1));
      } catch (e) {
        console.warn('[AdBlock] Skipping include:', includeUrl, e.message);
      }
    } else {
      lines.push(line);
    }
  }

  return lines.join('\n');
}
