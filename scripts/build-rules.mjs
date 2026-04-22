#!/usr/bin/env node
/**
 * build-rules.mjs
 *
 * Downloads and compiles popular filter lists (EasyList, EasyPrivacy, uBO filters,
 * Peter Lowe's Blocklist, etc.) into Chrome MV3 declarativeNetRequest JSON rulesets.
 *
 * Also extracts cosmetic rules and scriptlet rules into separate JSON files consumed
 * by the content-script cosmetic engine.
 *
 * Usage:
 *   node scripts/build-rules.mjs            # Full build (downloads lists from internet)
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { CORE_FILTER_SOURCE } from '../src/shared/core-filter-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.resolve(__dirname, '../rules');
const SAMPLE_MODE = process.argv.includes('--sample');

const LIST_CONFIG = {
  'easylist': { parts: 4, totalLimit: 100000 },
  'easyprivacy': { parts: 3, totalLimit: 75000 },
  'ubo-filters': { parts: 2, totalLimit: 40000 },
  'annoyances': { parts: 1, totalLimit: 30000 },
  'malware': { parts: 1, totalLimit: 30000 },
  'ubo-unbreak': { parts: 1, totalLimit: 30000 },
  'anti-adblock': { parts: 1, totalLimit: 30000 },
  'ubo-cookie-annoyances': { parts: 1, totalLimit: 30000 },
};

const MAX_PER_FILE = 25000;

// ---------------------------------------------------------------------------
// Filter list sources
// ---------------------------------------------------------------------------
const FILTER_LISTS = [
  {
    id: 'easylist',
    url: 'https://easylist.to/easylist/easylist.txt',
    description: 'EasyList — Primary ad-blocking filter list',
  },
  {
    id: 'easyprivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    description: 'EasyPrivacy — Tracker and analytics blocking',
  },
  {
    id: 'annoyances',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/annoyances.txt',
    description: 'uBO Annoyances — Popups, cookie banners, social overlays',
  },
  {
    id: 'malware',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
    description: 'URLhaus Malicious URL Blocklist',
  },
  {
    id: 'ubo-filters',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/filters.txt',
    description: 'uBlock Origin default filters',
  },
  {
    id: 'ubo-unbreak',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/unbreak.txt',
    description: 'uBlock Origin unbreak list',
  },
  {
    id: 'anti-adblock',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/badware.txt',
    description: 'uBlock Origin Anti-Adblock / Badware Filters',
  },
  {
    id: 'ubo-cookie-annoyances',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/annoyances-cookies.txt',
    description: 'uBO Cookie Annoyances — Cookie banners and consent popups',
  },
];

// ---------------------------------------------------------------------------
// HTTP fetch utility
// ---------------------------------------------------------------------------
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'adblock-mv3-builder/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch a filter list and recursively resolve !#include directives.
 * uBlock Origin's filter lists are split across many sub-files.
 */
async function fetchAndExpand(url, depth = 0) {
  if (depth > 5) return '';
  const text = await fetchText(url);
  const baseUrl = url.slice(0, url.lastIndexOf('/') + 1);
  const lines = [];

  // Simple state machine for !#if / !#else / !#endif
  // We assume we are in a 'chromium' environment
  const stack = [true];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    // 1. Handle conditionals
    if (trimmed.startsWith('!#if')) {
      const condition = trimmed.slice(4).trim();
      // Simple logic: if it mentions 'chromium' or 'cap_dnr', it's true for us
      const isTrue = condition.includes('env_chromium') || condition.includes('cap_dnr') || !condition.includes('env_');
      stack.push(isTrue && stack[stack.length - 1]);
      continue;
    }
    if (trimmed.startsWith('!#else')) {
      const prev = stack.pop();
      const parent = stack[stack.length - 1];
      stack.push(!prev && parent);
      continue;
    }
    if (trimmed.startsWith('!#endif')) {
      stack.pop();
      if (stack.length === 0) stack.push(true); // safety
      continue;
    }

    // Skip if current branch is inactive
    if (!stack[stack.length - 1]) continue;

    // 2. Handle includes
    const m = trimmed.match(/^!#include\s+(.+)$/);
    if (m) {
      const includePath = m[1].trim();
      const includeUrl = includePath.startsWith('http') ? includePath : baseUrl + includePath;
      try {
        lines.push(await fetchAndExpand(includeUrl, depth + 1));
      } catch (e) {
        console.warn(`  ⚠️  Skipping include ${includeUrl.split('/').pop()}: ${e.message}`);
      }
    } else {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ABP / EasyList filter parser
// Supports: network rules, cosmetic rules, scriptlet rules, exception rules
// ---------------------------------------------------------------------------

const RESOURCE_TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  object: 'object',
  xmlhttprequest: 'xmlhttprequest',
  subdocument: 'sub_frame',
  document: 'main_frame',
  websocket: 'websocket',
  media: 'media',
  font: 'font',
  ping: 'ping',
  other: 'other',
};

// DNR resource type list
const ALL_RESOURCE_TYPES = Object.values(RESOURCE_TYPE_MAP);

let ruleIdCounter = 1;
let exceptionIdCounter = 1000000;

function nextId(isException = false) { 
  return isException ? exceptionIdCounter++ : ruleIdCounter++; 
}

/**
 * Parse scriptlet argument string, respecting quoted commas.
 * e.g. "set-constant, ads.enabled, false"  →  ['set-constant', 'ads.enabled', 'false']
 *      "json-prune, 'a, b', 'x'"           →  ['json-prune', 'a, b', 'x']
 */
function parseScriptletArgs(str) {
  const args = [];
  let current = '';
  let inSingle = false, inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; }
    else if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; }
    else if (ch === ',' && !inSingle && !inDouble) {
      args.push(current.trim().replace(/^['"]|['"]$/g, ''));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim().replace(/^['"]|['"]$/g, ''));
  return args;
}

// Sentinel return values so callers distinguish "ignore silently" from
// "skipped for a documented reason".
const SKIP_SILENT = { skip: true, reason: null };
function skip(reason) { return { skip: true, reason }; }

/**
 * Parse a single filter line into a structured rule object.
 * Returns a rule, SKIP_SILENT (comment/blank), or `{ skip, reason }`.
 */
function parseLine(line) {
  line = line.trim();

  if (!line || line.startsWith('!') || line.startsWith('[')) return SKIP_SILENT;
  if (line.startsWith('@@#')) return SKIP_SILENT;

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

  const abpExtMatch = line.match(/^([^#]*)#\?#(.+)$/);
  if (abpExtMatch) {
    const [, domains, selector] = abpExtMatch;
    return {
      type: 'cosmetic',
      domains: domains ? domains.split(',').map(d => d.trim()).filter(Boolean) : [],
      selector,
      exception: false,
    };
  }

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

  const cosmeticExceptionMatch = line.match(/^([^#]*)#@#(.+)$/);
  if (cosmeticExceptionMatch) {
    const [, domains, selector] = cosmeticExceptionMatch;
    return {
      type: 'cosmetic',
      domains: domains ? domains.split(',').map(d => d.trim()).filter(Boolean) : [],
      selector,
      exception: true,
    };
  }

  const isException = line.startsWith('@@');
  const rawRule = isException ? line.slice(2) : line;

  let pattern = rawRule;
  let optionsStr = '';
  const dollarPos = rawRule.lastIndexOf('$');
  if (dollarPos !== -1 && !rawRule.endsWith('$')) {
    pattern = rawRule.slice(0, dollarPos);
    optionsStr = rawRule.slice(dollarPos + 1);
  }

  if (/(^|,)csp=/.test(optionsStr) && !isException) {
    return skip('csp-modifier: Chrome MV3 DNR cannot inject CSP response headers via a block rule; needs modifyHeaders which we do not translate yet');
  }

  const options = parseOptions(optionsStr);
  if (options === null) {
    return skip('unsupported-option-combo');
  }

  return {
    type: 'network',
    pattern,
    options,
    exception: isException,
  };
}

/**
 * Parse option string into a structured options object.
 * Returns null if the rule uses an option we choose not to handle.
 */
function parseOptions(optionsStr) {
  const options = {
    resourceTypes: [],
    excludedResourceTypes: [],
    initiatorDomains: [],
    excludedInitiatorDomains: [],
    requestDomains: [],
    thirdParty: null, // null=any, true=3rd-party, false=1st-party
    redirect: null,
    removeparam: null,
    important: false,
  };

  if (!optionsStr) return options;

  for (let opt of optionsStr.split(',')) {
    opt = opt.trim();
    const negated = opt.startsWith('~');
    const optName = negated ? opt.slice(1) : opt;

    if (RESOURCE_TYPE_MAP[optName]) {
      if (negated) {
        options.excludedResourceTypes.push(RESOURCE_TYPE_MAP[optName]);
      } else {
        options.resourceTypes.push(RESOURCE_TYPE_MAP[optName]);
      }
    } else if (optName === 'third-party' || optName === '3p') {
      options.thirdParty = negated ? false : true;
    } else if (optName === 'first-party' || optName === '1p') {
      options.thirdParty = negated ? true : false;
    } else if (optName.startsWith('domain=')) {
      const domains = optName.slice(7).split('|');
      for (const d of domains) {
        if (d.startsWith('~')) {
          options.excludedInitiatorDomains.push(d.slice(1));
        } else {
          options.initiatorDomains.push(d);
        }
      }
    } else if (optName === 'important') {
      options.important = true;
    } else if (optName.startsWith('redirect=') || optName.startsWith('redirect-rule=')) {
      // uBO resource names are usually simple, but the value side can contain
      // '=' for base64-encoded fallbacks — slice past the FIRST '=' rather
      // than splitting, which would truncate anything after a second '='.
      const eqIdx = optName.indexOf('=');
      options.redirect = eqIdx >= 0 ? optName.slice(eqIdx + 1) : '';
    } else if (optName.startsWith('removeparam=')) {
      options.removeparam = optName.slice(12);
    } else if (optName === 'popup') {
      options.resourceTypes.push('main_frame');
    } else if (optName === 'inline-script') {
      // Manifest V3 can't block inline scripts.
      // We don't skip the rule, we just ignore this specific option
      // so other options in the same rule (like $script) still apply.
    } else if (
      optName === 'genericblock' ||
      optName === 'generichide' ||
      optName === 'elemhide' ||
      optName === 'specifichide'
    ) {
      // Cosmetic-scope exception hints — we no longer flip `important`
      // here. Setting the priority-bumped important flag used to mask real
      // cosmetic exception rules at DNR priority 5.
      options.cosmeticScopeException = true;
    }
    // Ignore unknown options silently (many are optional/metadata)
  }

  return options;
}

/**
 * Estimate RE2 NFA instruction cost for a regex pattern.
 * RE2 expands character classes into per-character alternatives and
 * unrolls bounded quantifiers, so [0-9A-Za-z]{16} = 62 × 16 = 992
 * NFA instructions from that token alone. Chrome's 2KB program memory
 * limit corresponds to roughly 500-700 raw NFA nodes (each node has
 * ~3 bytes of overhead in RE2's compiled representation).
 */
function estimateRegexNfaCost(pattern) {
  let cost = 0;
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '[') {
      // Character class
      let j = i + 1;
      let negated = false;
      if (j < pattern.length && pattern[j] === '^') { negated = true; j++; }
      if (j < pattern.length && pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j++;
      const content = pattern.slice(i + (negated ? 2 : 1), j);
      let classSize = 0;
      for (let k = 0; k < content.length; k++) {
        if (k + 2 < content.length && content[k + 1] === '-') {
          classSize += content.charCodeAt(k + 2) - content.charCodeAt(k) + 1;
          k += 2;
        } else { classSize++; }
      }
      // Negated classes match the complement: ~256 - classSize
      if (negated) classSize = Math.max(256 - classSize, classSize);
      i = j + 1;
      const [mult, next] = getQuantMult(pattern, i);
      cost += classSize * mult;
      i = next;
    } else if (pattern[i] === '\\' && i + 1 < pattern.length) {
      const ch = pattern[i + 1];
      const shSize = ch === 'd' || ch === 'D' ? 10
                   : ch === 'w' || ch === 'W' ? 63
                   : ch === 's' || ch === 'S' ? 6
                   : ch === 'b' || ch === 'B' ? 2 : 1;
      i += 2;
      const [mult, next] = getQuantMult(pattern, i);
      cost += shSize * mult;
      i = next;
    } else if (pattern[i] === '.') {
      // Unescaped dot matches ANY byte — RE2 cost = 256 alternatives
      i++;
      const [mult, next] = getQuantMult(pattern, i);
      cost += 256 * mult;
      i = next;
    } else {
      cost++;
      i++;
    }
  }
  return cost;
}

/** Parse the quantifier at position i, returning [multiplier, nextIndex]. */
function getQuantMult(pattern, i) {
  if (i >= pattern.length) return [1, i];
  if (pattern[i] === '{') {
    // Handle {n}, {n,m}, and {n,} (open-ended — use lower bound as multiplier)
    const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
    if (m) {
      const lower = parseInt(m[1], 10);
      // m[2] is undefined for {n}, "" for {n,}, a number string for {n,m}
      const upper = m[2] !== undefined
        ? (m[2] === '' ? lower : parseInt(m[2], 10))
        : lower;
      return [upper, i + m[0].length];
    }
  }
  if (pattern[i] === '+' || pattern[i] === '*') return [10, i + 1];
  if (pattern[i] === '?') return [1, i + 1];
  return [1, i];
}

// ---------------------------------------------------------------------------
// Safe Path Guard — prevents blocking critical infrastructure
// ---------------------------------------------------------------------------
const CRITICAL_SAFE_PATHS = [
  'youtube.com/youtubei/v1/player',
  'youtube.com/youtubei/v1/next',
  'youtube.com/youtubei/v1/browse',
  'youtube.com/youtubei/v1/log_event',
  'youtube.com/api/stats/',
  'googlevideo.com/videoplayback',
  'accounts.google.com/',
  'login.microsoftonline.com',
  'aexp-static.com',
];

// Drop reporter: populated by buildDNRRules, read by parseFilterList caller
// so every networkFilterToDNR/convertPatternToUrlFilter rejection is
// recorded with the original line and a human-readable reason.
let _currentDropSink = null;
function reportDrop(reason, pattern) {
  if (_currentDropSink) _currentDropSink.push({ reason, pattern });
}

function isUnsafeGlobalFragmentImageRedirect(pattern, options, exception) {
  if (exception || !options.redirect) return false;
  if (options.important) return false;
  if (options.thirdParty !== null) return false;
  if (options.resourceTypes.length !== 1 || options.resourceTypes[0] !== 'image') return false;
  if (options.excludedResourceTypes.length > 0) return false;
  if (options.initiatorDomains.length > 0 || options.excludedInitiatorDomains.length > 0) return false;
  if (options.requestDomains.length > 0) return false;
  return /^\*\.(?:png|gif|jpe?g|svg)#$/.test(pattern);
}

/**
 * Convert a parsed network filter into a DNR rule object.
 * Returns null if conversion is not possible (reason is reported via reportDrop).
 */
function networkFilterToDNR(parsed) {
  if (parsed.type !== 'network') return null;

  const { pattern, options, exception } = parsed;

  const lowerPattern = pattern.toLowerCase();
  for (const safePath of CRITICAL_SAFE_PATHS) {
    if (lowerPattern.includes(safePath)) {
      if (exception) { reportDrop(`critical-safe-path-exception: ${safePath} (already covered by allow rule)`, pattern); return null; }
      if (!options.important) {
        reportDrop(`critical-safe-path-block: ${safePath} (blocking would break extension/browser core flow)`, pattern);
        return null;
      }
    }
  }

  let urlFilter = null;
  let regexFilter = null;

  const patternBlacklist = [
    '://www.*.com/*.css|',
    'www.*.com/*.css',
  ];
  if (patternBlacklist.includes(pattern)) {
    reportDrop('upstream-blacklist: known broken/overly-broad pattern', pattern);
    return null;
  }

  // Chromium DNR matches against the full request URL, including fragments.
  // Legacy global sprite-killer rules such as `*.svg#$image,redirect-rule=1x1.gif`
  // are therefore too broad here and break modern app icon/sprite assets.
  if (isUnsafeGlobalFragmentImageRedirect(pattern, options, exception)) {
    reportDrop('unsafe-global-fragment-image-redirect: too broad under Chromium DNR fragment matching', pattern);
    return null;
  }

  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    regexFilter = pattern.slice(1, -1);

    if (/\(\?[=!]|\(\?<[=!]|\\[1-9]|\(\?>|[*+?]\+|\(\?\(|\\k</.test(regexFilter)) {
      reportDrop('regex: uses RE2-unsupported syntax (lookaround/backref/possessive/named-backref)', pattern);
      return null;
    }
    if (/[^\x00-\x7F]/.test(regexFilter)) {
      reportDrop('regex: contains non-ASCII — DNR requires ASCII-only', pattern);
      return null;
    }
    if (regexFilter.length > 150) {
      reportDrop(`regex: source length ${regexFilter.length} > 150 (Chrome RE2 2KB program budget)`, pattern);
      return null;
    }

    let quantProduct = 1;
    const quantRe4 = /\{(\d+)(?:,(\d+))?\}/g;
    let qm4;
    while ((qm4 = quantRe4.exec(regexFilter)) !== null) {
      quantProduct *= parseInt(qm4[2] ?? qm4[1], 10);
      if (quantProduct > 500) {
        reportDrop(`regex: quantifier product ${quantProduct} > 500 (nested-quantifier blowup)`, pattern);
        return null;
      }
    }

    if (estimateRegexNfaCost(regexFilter) > 500) {
      reportDrop('regex: estimated NFA cost > 500 instructions (exceeds Chrome 2KB RE2 budget)', pattern);
      return null;
    }

    try { new RegExp(regexFilter); } catch (e) {
      reportDrop(`regex: invalid JS regex syntax (${e.message})`, pattern);
      return null;
    }
  } else {
    urlFilter = convertPatternToUrlFilter(pattern);
    if (!urlFilter) return null; // convertPatternToUrlFilter calls reportDrop itself
  }

  // Build condition
  const condition = {};

  if (urlFilter) condition.urlFilter = urlFilter;
  if (regexFilter) condition.regexFilter = regexFilter;

  if (options.resourceTypes.length > 0) {
    condition.resourceTypes = options.resourceTypes;
  }
  if (options.excludedResourceTypes.length > 0) {
    condition.excludedResourceTypes = options.excludedResourceTypes;
  }
  if (options.initiatorDomains.length > 0) {
    condition.initiatorDomains = options.initiatorDomains;
  }
  if (options.excludedInitiatorDomains.length > 0) {
    condition.excludedInitiatorDomains = options.excludedInitiatorDomains;
  }
  if (options.requestDomains.length > 0) {
    condition.requestDomains = options.requestDomains;
  }
  if (options.thirdParty === true) {
    condition.domainType = 'thirdParty';
  } else if (options.thirdParty === false) {
    condition.domainType = 'firstParty';
  }

  // Build action
  let action;
  if (exception) {
    action = { type: 'allow' };
  } else if (options.redirect) {
    // Redirect to blank resource types
    const resType = options.resourceTypes[0] || 'other';
    const blankUrl = getBlankRedirectUrl(resType);
    action = { type: 'redirect', redirect: { url: blankUrl } };
  } else if (options.removeparam) {
    action = {
      type: 'redirect',
      redirect: {
        transform: {
          queryTransform: {
            removeParams: [options.removeparam],
          },
        },
      },
    };
  } else {
    action = { type: 'block' };
  }

  let rulePriority = options.important ? 2 : 1;
  if (exception) {
    rulePriority = 3;
  }

  return {
    id: nextId(exception),
    priority: rulePriority,
    condition,
    action,
  };
}

// Common public TLDs — a ||TLD^ pattern matches EVERY domain with that TLD,
// which is far too broad (e.g. ||com^ blocks all of *.com). Reject them.
const KNOWN_TLDS = new Set([
  'com','net','org','gov','edu','mil','int','io','co','cc','tv','biz','info',
  'pro','me','name','mobi','app','dev','xyz','ai','ly','us','uk','de','fr',
  'it','es','nl','be','at','ch','se','no','fi','dk','pl','cz','sk','hu','ro',
  'bg','hr','si','rs','ru','ua','by','md','ge','am','az','kz','cn','jp','kr',
  'tw','hk','sg','my','id','ph','th','vn','au','nz','ca','br','in','mx','za',
  'eg','ng','ke','tz','gh','cm','ma','dz','tn','sd','et','eu','ar','cl',
  'pe','ve','ec','gt','hn','sv','cr','pa','cu','do','tt','bb','jm','bz',
]);

/** Convert ABP-style URL pattern to DNR urlFilter */
function convertPatternToUrlFilter(pattern) {
  const original = pattern;
  if (!pattern || pattern === '*') { reportDrop('urlFilter: empty or matches-everything ("*")', original); return null; }

  if (pattern.includes('%')) {
    try {
      const decoded = decodeURIComponent(pattern);
      if (decoded && decoded.trim().length > 0) pattern = decoded;
    } catch (e) { /* keep original */ }
  }

  if (pattern.length < 2) { reportDrop('urlFilter: pattern too short (<2 chars)', original); return null; }
  if (/[^\x00-\x7F]/.test(pattern)) { reportDrop('urlFilter: non-ASCII — Chrome DNR requires ASCII', original); return null; }
  if (pattern.startsWith('||*')) { reportDrop('urlFilter: ||* is invalid — wildcard cannot immediately follow domain anchor', original); return null; }
  if (pattern.indexOf('||', 1) !== -1) { reportDrop('urlFilter: || must only appear at pattern start', original); return null; }
  if (pattern === '||' || pattern === '|' || pattern === '^') { reportDrop('urlFilter: degenerate anchor-only pattern', original); return null; }

  if (pattern.startsWith('||')) {
    const labelMatch = /^\|\|([^.|/*?^]+)/.exec(pattern);
    if (labelMatch && KNOWN_TLDS.has(labelMatch[1].toLowerCase())) {
      reportDrop(`urlFilter: ||${labelMatch[1]}^ anchors on TLD — would match every .${labelMatch[1]} domain`, original);
      return null;
    }
  }

  return pattern;
}

/** Get a blank redirect URL for a given resource type */
function getBlankRedirectUrl(resourceType) {
  const blanks = {
    image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    script: 'data:application/javascript,',
    stylesheet: 'data:text/css,',
    xmlhttprequest: 'data:text/plain,',
    media: 'data:video/mp4,',
    font: 'data:application/x-font-ttf,',
    sub_frame: 'about:blank',
    main_frame: 'about:blank',
    ping: 'data:text/plain,',
    websocket: 'data:text/plain,',
    other: 'data:text/plain,',
  };
  return blanks[resourceType] || 'data:text/plain,';
}

// ---------------------------------------------------------------------------
// Main processing pipeline
// ---------------------------------------------------------------------------

/**
 * Parse a complete filter list text into categorized rule sets.
 * Also collects full skip records: every non-blank/non-comment line
 * that parseLine rejects is recorded with the reason.
 */
function parseFilterList(text, listId = 'unknown') {
  const networkRules = [];
  const cosmeticRules = [];
  const cosmeticExceptions = [];
  const scriptletRules = [];
  const skippedRecords = []; // [{ reason, line }]

  for (const line of text.split('\n')) {
    const parsed = parseLine(line);
    if (!parsed || parsed.skip) {
      if (parsed && parsed.skip && parsed.reason) {
        skippedRecords.push({ reason: parsed.reason, line: line.trim() });
      }
      continue;
    }

    if (parsed.type === 'network') {
      networkRules.push(parsed);
    } else if (parsed.type === 'cosmetic') {
      if (parsed.exception) cosmeticExceptions.push(parsed);
      else cosmeticRules.push(parsed);
    } else if (parsed.type === 'scriptlet') {
      scriptletRules.push(parsed);
    }
  }

  return { networkRules, cosmeticRules, cosmeticExceptions, scriptletRules, skippedRecords };
}

/**
 * Convert parsed network rules to DNR rules, deduplicate, and return.
 * Populates `droppedRecords` with every rejection + dedup drop.
 */
function buildDNRRules(networkRules) {
  const dnrRules = [];
  const seen = new Set();
  const droppedRecords = [];

  const prevSink = _currentDropSink;
  _currentDropSink = droppedRecords;

  try {
    for (const parsed of networkRules) {
      const rule = networkFilterToDNR(parsed);
      if (!rule) continue;

      const key = JSON.stringify({
        uf: rule.condition.urlFilter || rule.condition.regexFilter,
        rt: rule.condition.resourceTypes,
        at: rule.action.type,
      });
      if (seen.has(key)) {
        droppedRecords.push({ reason: 'dedup: duplicate of another DNR rule (same urlFilter+resourceTypes+action)', pattern: parsed.pattern });
        continue;
      }
      seen.add(key);

      dnrRules.push(rule);
    }
  } finally {
    _currentDropSink = prevSink;
  }

  return { dnrRules, droppedRecords };
}

function buildSourceBundleFallback(parsed) {
  const sourceCosmetic = { generic: [], domainSpecific: {}, exceptions: {} };
  const cosmeticRules = [...(parsed.cosmeticRules || []), ...(parsed.cosmeticExceptions || [])];
  for (const r of cosmeticRules) {
    if (r.domains.length === 0) {
      if (r.exception) continue;
      sourceCosmetic.generic.push(r.selector);
    } else {
      for (const d of r.domains) {
        if (r.exception) {
          if (!sourceCosmetic.exceptions[d]) sourceCosmetic.exceptions[d] = [];
          sourceCosmetic.exceptions[d].push(r.selector);
        } else {
          if (!sourceCosmetic.domainSpecific[d]) sourceCosmetic.domainSpecific[d] = [];
          sourceCosmetic.domainSpecific[d].push(r.selector);
        }
      }
    }
  }
  sourceCosmetic.generic = [...new Set(sourceCosmetic.generic)];
  for (const [domain, selectors] of Object.entries(sourceCosmetic.domainSpecific)) {
    sourceCosmetic.domainSpecific[domain] = [...new Set(selectors)];
  }
  for (const [domain, selectors] of Object.entries(sourceCosmetic.exceptions)) {
    sourceCosmetic.exceptions[domain] = [...new Set(selectors)];
  }

  const sourceScriptlets = [];
  const scriptletSeen = new Set();
  for (const rule of parsed.scriptletRules) {
    const key = `${rule.name}|${(rule.domains || []).join(',')}|${(rule.args || []).join('\u0001')}`;
    if (scriptletSeen.has(key)) continue;
    scriptletSeen.add(key);
    sourceScriptlets.push(rule);
  }

  return {
    cosmetic: sourceCosmetic,
    scriptlets: sourceScriptlets,
  };
}

function createEmptySourceBundle() {
  return {
    cosmetic: { generic: [], domainSpecific: {}, exceptions: {} },
    scriptlets: [],
  };
}

function collectExpectedRulesetFiles() {
  const files = [];
  for (const list of FILTER_LISTS) {
    const config = LIST_CONFIG[list.id] || { parts: 1 };
    for (let i = 0; i < config.parts; i++) {
      const suffix = i === 0 ? '' : `_${i + 1}`;
      files.push(`${list.id}${suffix}.json`);
    }
  }
  return files;
}

const SKIP_LOG_DIR = path.join(RULES_DIR, 'skipped');

function groupByReason(records, keyField) {
  const groups = new Map();
  for (const r of records) {
    const bucket = groups.get(r.reason) || [];
    bucket.push(r[keyField]);
    groups.set(r.reason, bucket);
  }
  return groups;
}

/**
 * Write a full, untruncated log of every skipped/dropped line for `listId`.
 * Each entry lists the reason and the exact source line — nothing is cut
 * so engineers can reproduce and triage individual filters.
 */
function writeSkipLog(listId, { parseSkips, dnrDrops, truncatedCount }) {
  fs.mkdirSync(SKIP_LOG_DIR, { recursive: true });
  const lines = [];
  lines.push(`# Skip log for ${listId}`);
  lines.push(`# generated ${new Date().toISOString()}`);
  lines.push(`# parse-skips: ${parseSkips.length}  dnr-drops: ${dnrDrops.length}  smart-truncate-dropped: ${truncatedCount}`);
  lines.push('');

  lines.push(`## Parse-time skips (parseLine rejected)`);
  const parseGroups = groupByReason(parseSkips, 'line');
  for (const [reason, entries] of parseGroups) {
    lines.push(`\n### ${reason}  (${entries.length})`);
    for (const entry of entries) lines.push(entry);
  }

  lines.push(`\n## DNR conversion drops (networkFilterToDNR / convertPatternToUrlFilter / dedup)`);
  const dnrGroups = groupByReason(dnrDrops, 'pattern');
  for (const [reason, entries] of dnrGroups) {
    lines.push(`\n### ${reason}  (${entries.length})`);
    for (const entry of entries) lines.push(entry);
  }

  if (truncatedCount > 0) {
    lines.push(`\n## Smart-truncate`);
    lines.push(`${truncatedCount} rules dropped because list exceeded configured totalLimit (see LIST_CONFIG).`);
    lines.push(`Individual lines not recorded: smartTruncate operates on already-parsed rules ranked by scoreNetworkRule.`);
  }

  const outPath = path.join(SKIP_LOG_DIR, `${listId}.log`);
  fs.writeFileSync(outPath, lines.join('\n'));
}

function printSkipSummary(listId, parseSkips, dnrDrops, truncatedCount) {
  if (parseSkips.length === 0 && dnrDrops.length === 0 && truncatedCount === 0) return;
  console.log(`   📝 Skip summary for ${listId} (full log: rules/skipped/${listId}.log)`);
}

function cleanGeneratedRuleFiles() {
  if (!fs.existsSync(RULES_DIR)) return;

  const generatedFiles = new Set([
    ...collectExpectedRulesetFiles(),
    'cosmetic-rules.json',
    'scriptlet-rules.json',
    'filter-sources.json',
  ]);

  for (const entry of fs.readdirSync(RULES_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === 'system-unbreak.json') continue;
    if (!generatedFiles.has(entry.name)) continue;
    fs.rmSync(path.join(RULES_DIR, entry.name), { force: true });
  }

  // Wipe stale per-list skip logs so a shrinking skip set doesn't leave
  // phantom entries behind from a previous build.
  if (fs.existsSync(SKIP_LOG_DIR)) {
    for (const entry of fs.readdirSync(SKIP_LOG_DIR)) {
      if (entry.endsWith('.log')) fs.rmSync(path.join(SKIP_LOG_DIR, entry), { force: true });
    }
  }
}

/**
 * Assert every rule_resources[].path referenced by manifest.json exists on disk.
 * Prevents shipping a build where the manifest references a shard that was
 * never generated — Chrome silently ignores missing rulesets at load time,
 * which is how the first-install bug slipped through in 3.4.0.
 */
function verifyManifestRuleResourcePaths() {
  const manifestPath = path.resolve(__dirname, '../manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const resources = manifest?.declarative_net_request?.rule_resources || [];
  const projectRoot = path.resolve(__dirname, '..');
  const missing = [];
  for (const entry of resources) {
    const abs = path.resolve(projectRoot, entry.path);
    if (!fs.existsSync(abs)) missing.push(entry.path);
  }
  if (missing.length > 0) {
    throw new Error(
      `Manifest references rule_resources that do not exist on disk:\n  - ${missing.join('\n  - ')}\n` +
      `Regenerate with \`npm run build:rules\` or remove the entries from manifest.json.`
    );
  }
  console.log(`✅ manifest rule_resources verified (${resources.length} paths)`);
}

function writeBuildOutputs({ rulesetOutputs, cosmeticRules, scriptletRules, filterSources }) {
  // Per-ruleset rule counts — previously hardcoded in service-worker.js and
  // drifted from reality after every filter-list refresh. Emit the actual
  // compiled counts so the SW can load them at runtime instead of guessing.
  const rulesetCounts = {};
  for (const [filename, rules] of Object.entries(rulesetOutputs)) {
    const outPath = path.join(RULES_DIR, filename);
    fs.writeFileSync(outPath, JSON.stringify(rules, null, 2));
    console.log(`✅ ${filename} — ${rules.length} DNR rules written`);
    const rulesetId = filename.replace(/\.json$/, '');
    rulesetCounts[rulesetId] = rules.length;
  }

  const countsPath = path.join(RULES_DIR, 'ruleset-counts.json');
  fs.writeFileSync(countsPath, JSON.stringify(rulesetCounts, null, 2));
  console.log(`✅ ruleset-counts.json — ${Object.keys(rulesetCounts).length} entries`);

  const cosmeticsPath = path.join(RULES_DIR, 'cosmetic-rules.json');
  fs.writeFileSync(cosmeticsPath, JSON.stringify(cosmeticRules, null, 2));
  console.log(`\n✅ cosmetic-rules.json — ${cosmeticRules.generic.length} generic + ${Object.keys(cosmeticRules.domainSpecific).length} domain-specific`);

  const scriptletsPath = path.join(RULES_DIR, 'scriptlet-rules.json');
  fs.writeFileSync(scriptletsPath, JSON.stringify(scriptletRules, null, 2));
  console.log(`✅ scriptlet-rules.json — ${scriptletRules.length} rules`);

  const filterSourcesPath = path.join(RULES_DIR, 'filter-sources.json');
  fs.writeFileSync(filterSourcesPath, JSON.stringify(filterSources, null, 2));
  console.log(`✅ filter-sources.json — ${Object.keys(filterSources).length} list sources`);
}

function buildSampleRulesetOutputs() {
  const outputs = {};
  for (const filename of collectExpectedRulesetFiles()) {
    outputs[filename] = [];
  }

  outputs['easylist.json'] = [
    {
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: '||ads.example^',
        resourceTypes: ['script', 'image', 'sub_frame', 'xmlhttprequest'],
      },
    },
  ];
  outputs['easyprivacy.json'] = [
    {
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: '||tracker.example^',
        resourceTypes: ['script', 'xmlhttprequest', 'image'],
      },
    },
  ];
  outputs['annoyances.json'] = [
    {
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: {
        urlFilter: '||consent.example^',
        resourceTypes: ['sub_frame', 'script'],
      },
    },
  ];

  return outputs;
}

function buildSampleFilterSources() {
  const sampleBundle = {
    cosmetic: generateSampleCosmeticRules(),
    scriptlets: generateSampleScriptletRules(),
  };

  return Object.fromEntries(FILTER_LISTS.map(({ id }, index) => [
    id,
    index === 0 ? sampleBundle : createEmptySourceBundle(),
  ]));
}

function writeSampleOutputs() {
  console.log('🧪 Generating sample rule artifacts (offline mode)...\n');

  writeBuildOutputs({
    rulesetOutputs: buildSampleRulesetOutputs(),
    cosmeticRules: generateSampleCosmeticRules(),
    scriptletRules: generateSampleScriptletRules(),
    filterSources: buildSampleFilterSources(),
  });

  console.log('\n🎉 Sample build complete!');
}

// ---------------------------------------------------------------------------
// Sample rules generator (for development without internet access)
// ---------------------------------------------------------------------------

function generateSampleCosmeticRules() {
  return {
    generic: [
      '.ad', '.ads', '.ad-block', '.ad-container', '.ad-banner', '.ad-unit',
      '.ad-wrapper', '.adsbygoogle', '.advertisement', '.advertisements',
      '.advertising', '.banner-ads', '.display-ads', '#ad', '#ads',
      '#ad-container', '#ad-banner', '#advertisement', '#sidebar-ad',
      '.sponsored', '.sponsor', '[id^="ad_"]', '[class^="ad_"]',
      '[id*="advertisement"]', '[class*="advertisement"]',
      '#google_ads_iframe_*', '.google-ad', '#carbonads', '.carbon-ads',
      // Cookie banners
      '#cookie-banner', '.cookie-banner', '.cookie-notice', '#gdpr-banner',
      '.gdpr-notice', '.privacy-banner', '#privacy-notice',
      // Newsletter popups
      '.newsletter-overlay', '.newsletter-popup', '#newsletter-modal',
      // Social share bars
      '.social-share-bar', '.social-floating', '.addthis_toolbox',
    ],
    domainSpecific: {
      'google.com': [
        'div[data-text-ad]',
        'div[data-ad-block]',
        '.commercial-unit-desktop-top',
        '.commercial-unit-desktop-rhs',
        '#tads',
        '#tadsb',
        '#res .g .psli',
        '#res .g .pslt',
        '#center_col .mitem',
        '.commercial-unit-mobile-top',
        '.commercial-unit-mobile-bottom',
        '.mod > ._e4b',
        'div[data-pcu]',
        'div[data-hveid] > div:has(div[data-pcu])',
        '#media_result_grouping',
        '.mnr-c > .O9S7Ff',
        '.pla-unit-container',
        '.pla-unit',
      ],
      'youtube.com': [
        '.ytd-promoted-video-renderer',
        '.ytd-ad-slot-renderer',
        'ytd-action-companion-ad-renderer',
        'ytd-display-ad-renderer',
        'ytd-video-masthead-ad-v3-renderer',
        '#masthead-ad',
        '.ytp-ad-module',
      ],
      'reddit.com': [
        '.promotedlink', '[data-promoted="true"]', '.ad-result',
        '[data-adtype]', '.ad-container--reddit',
      ],
      'facebook.com': [
        '._7jyg._7jyi', '._5jmm._3ah0',
        '[data-pagelet="AdsFeedUnit"]',
      ],
      'twitter.com': [
        '[data-testid="placementTracking"]',
        '[data-testid="UserCell"] + [data-testid="UserCell"]',
      ],
      'x.com': [
        '[data-testid="placementTracking"]',
      ],
      'cnn.com': [
        // Physical removal — defeats inline style !important overrides by CNN's JS
        '.ad-slot-header:remove()',
        // Ad slot wrappers (all variants)
        'div.ad-slot-header',
        '.ad-slot',
        '.ad-slot-header',
        '[class*="ad-slot"]',
        '.ad-slot__wrapper',
        '.ad-slot__ad-wrapper',
        '.ad-slot-dynamic',
        '.ad-slot-header__wrapper',
        '[class*="banner-ad"]',
        '[data-ad-format]',
        // Generic ad containers
        '.ad-container',
        '.el__ad',
        '.cnn-ad',
        '.commercialContent',
        '.ad-feedback-link',
        '.ad-feedback__modal',
        '.zn-body__paragraph--sponsored',
        // ID-based
        '#ad-slot-header',
        '#js-outbrain-rightrail-ads-module',
        '#partner-zone',
        '#sponsored-outbrain-1',
        // Zone/stack ads (new CNN layout)
        '.stack__ads',
        '.zone__ads',
        '[data-zone-label="Paid Partner Content"]',
        '[data-zone-label="PAID PARTNER CONTENT"]',
        // Products/affiliate content
        '.featured-product__card',
        '.product-offer-card-container_related-products',
      ],
      'greenhouse.io': [
        'section:has(h2:has-text(Featured Jobs))',
        '.featured-jobs',
        '.job-post:has(.featured)',
        '.featured',
      ],
      'greenhouse.com': [
        '#api-v1-tracking',
        '.tracking-pixel',
      ],
      'nytimes.com': [
        '.ad-container', '.ad-unit-wrapper', '#dfp-ad-top',
        '[id^="dfp-ad"]', '.nytd-ads-wrapper',
      ],
      'forbes.com': [
        '.fbs-ad', '.fbs-ad--slot', '[data-ad-unit]',
      ],
      'dailymail.co.uk': [
        '.article-text .sponsored-links', '.mol-ads-below-module',
        '[data-mol-fe-page-type="ad"]',
      ],
    },
  };
}

function generateSampleScriptletRules() {
  return [
    { domains: ['example.com'], name: 'abort-on-property-read', args: ['_sp_'] },
    { domains: ['somesite.com'], name: 'set-constant', args: ['adblockEnabled', 'false'] },
  ];
}

// ---------------------------------------------------------------------------
// Smart rule selection (used when a filter list exceeds the DNR rule limit)
// ---------------------------------------------------------------------------

/**
 * Score a parsed network rule by its expected coverage breadth.
 * Higher score = block more traffic = keep when budget is tight.
 *
 * Tiers:
 *   10000 — Exception (allow) rules: must keep to prevent false positives
 *    500  — !important flag
 *    300  — Domain-only anchor (||domain.com^ covers all paths/types)
 *    150  — Domain anchor with path (||domain.com/path)
 *    100  — No resource-type restriction (matches every request type)
 *     80  — Non-anchored double-pipe (covers subdomains too)
 *     50  — No initiator/request domain restrictions
 *     50  — 3+ resource types listed
 *     20  — Generic substring / other pattern
 *    -10  — Third-party-only restriction (reduces coverage)
 *    -30  — Regex rule (narrow, Chrome NFA budget is tight)
 */
function scoreNetworkRule(rule) {
  const { pattern, options, exception } = rule;
  let score = 0;

  if (exception) return 10000;                 // Always keep allow rules
  if (options.important) score += 500;

  // Pattern breadth
  if (/^\|\|[^/*?^]+\^?$/.test(pattern)) {
    score += 300;                              // Domain-only anchor (broadest)
  } else if (pattern.startsWith('||')) {
    score += 150;                              // Domain anchor + path
  } else if (pattern.startsWith('|https://') || pattern.startsWith('|http://')) {
    score += 50;
  } else {
    score += 20;                               // Generic / substring
  }

  // Resource-type breadth
  if (options.resourceTypes.length === 0) {
    score += 100;
  } else if (options.resourceTypes.length >= 3) {
    score += 50;
  } else {
    score += 10;
  }

  // Domain restriction breadth
  if (options.initiatorDomains.length === 0 && options.requestDomains.length === 0) {
    score += 50;
  }

  // Penalties
  if (options.thirdParty !== null && options.thirdParty !== undefined) score -= 10;
  if (pattern.startsWith('/') && pattern.endsWith('/')) score -= 30;

  return score;
}

/**
 * Trim `networkRules` (parsed ABP objects) to at most `limit` entries
 * using three passes:
 *
 *  1. Early dedup — drop rules with identical (pattern + exception + important + types)
 *     before scoring, so duplicates don't consume budget.
 *
 *  2. Score & sort — rank surviving rules by coverage breadth (see scoreNetworkRule).
 *
 *  3. Subsumption filter — once we have a domain-only anchor rule (||domain.com^),
 *     skip any more-specific rule whose pattern is anchored to the same domain
 *     (e.g. ||domain.com/specific/path) — it's already covered.
 */
function smartTruncate(networkRules, limit) {
  // Pass 1: early ABP-level dedup
  const abpSeen = new Set();
  networkRules = networkRules.filter(r => {
    const key = `${r.pattern}|${r.exception ? 1 : 0}|${r.options.important ? 1 : 0}|${r.options.resourceTypes.join(',')}`;
    if (abpSeen.has(key)) return false;
    abpSeen.add(key);
    return true;
  });
  console.log(`   🔍 After early dedup: ${networkRules.length} rules`);

  if (networkRules.length <= limit) return networkRules;

  // Pass 2: score & sort descending
  networkRules.sort((a, b) => scoreNetworkRule(b) - scoreNetworkRule(a));

  // Pass 3: subsumption — domain-only anchors subsume path-specific anchors,
  // but ONLY when the broader rule's resourceTypes is a superset of the
  // narrower rule's. Otherwise ||ads.foo (no types) wrongly subsumes
  // ||ads.foo$image, which actually covers a different request set.
  // dominantDomains: domain -> Set<resourceType> | null (null = all types)
  const dominantDomains = new Map();
  const selected = [];

  const typeSetFor = (rule) => {
    const types = rule.options?.resourceTypes;
    return Array.isArray(types) && types.length > 0 ? new Set(types) : null;
  };

  const broaderCoversNarrower = (broaderTypes, narrowerTypes) => {
    // Broader has no resourceTypes constraint → matches all types → always covers.
    if (broaderTypes === null) return true;
    // Narrower has no constraint but broader does → broader is NOT a superset.
    if (narrowerTypes === null) return false;
    for (const t of narrowerTypes) if (!broaderTypes.has(t)) return false;
    return true;
  };

  for (const r of networkRules) {
    if (selected.length >= limit) break;

    const isDomainOnly = /^\|\|([^/*?^]+)\^?$/.exec(r.pattern);
    if (isDomainOnly && !r.exception) {
      const existing = dominantDomains.get(isDomainOnly[1]);
      const incoming = typeSetFor(r);
      // Track the broadest (type-wise) rule per domain — null wins.
      if (!existing || existing === null) {
        dominantDomains.set(isDomainOnly[1], incoming === null ? null : incoming);
      } else if (incoming === null) {
        dominantDomains.set(isDomainOnly[1], null);
      } else {
        for (const t of incoming) existing.add(t);
      }
      selected.push(r);
      continue;
    }

    if (!r.exception && r.pattern.startsWith('||')) {
      const domainMatch = /^\|\|([^/*?^]+)/.exec(r.pattern);
      if (domainMatch && dominantDomains.has(domainMatch[1])) {
        const broaderTypes = dominantDomains.get(domainMatch[1]);
        const narrowerTypes = typeSetFor(r);
        if (broaderCoversNarrower(broaderTypes, narrowerTypes)) continue;
      }
    }

    selected.push(r);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(RULES_DIR, { recursive: true });
  cleanGeneratedRuleFiles();

  if (SAMPLE_MODE) {
    writeSampleOutputs();
    verifyManifestRuleResourcePaths();
    process.exit(0);
  }

  let rustSourceParserReady = false;
  let parseFilterSourceWithRust = null;
  try {
    const wasmJsPath = path.resolve(__dirname, '../src/shared/wasm/nullify_core.js');
    const wasmPath = path.resolve(__dirname, '../src/shared/wasm/nullify_core_bg.wasm');
    if (fs.existsSync(wasmJsPath) && fs.existsSync(wasmPath)) {
      const wasmModule = await import('../src/shared/wasm/nullify_core.js');
      await wasmModule.default({ module_or_path: fs.readFileSync(wasmPath) });
      const fn = wasmModule.parse_filter_source;
      if (typeof fn === 'function') {
        parseFilterSourceWithRust = fn;
        rustSourceParserReady = true;
      } else {
        console.warn('⚠️  WASM loaded but parse_filter_source export missing — using JS fallback. Rebuild wasm with `npm run build:wasm` if Rust parser is expected.');
      }
    }
  } catch (err) {
    console.warn(`⚠️  Rust source parser unavailable, falling back to JS extraction: ${err.message}`);
  }

  const allCosmeticRules = JSON.parse(JSON.stringify(CORE_FILTER_SOURCE.cosmetic));
  const allScriptletRules = JSON.parse(JSON.stringify(CORE_FILTER_SOURCE.scriptlets));
  const filterSources = {};
  const rulesetOutputs = {};
  const failures = [];

  console.log('📡 Downloading filter lists...\n');

  for (const list of FILTER_LISTS) {
    try {
      console.log(`⬇️  Fetching ${list.description}...`);
      const text = await fetchAndExpand(list.url);
      const parsed = parseFilterList(text, list.id);

      console.log(`   Parsed: ${parsed.networkRules.length} network, ${parsed.cosmeticRules.length} cosmetic, ${parsed.scriptletRules.length} scriptlets, ${parsed.skippedRecords.length} skipped`);
      const config = LIST_CONFIG[list.id] || { parts: 1, totalLimit: 30000 };
      let networkRules = parsed.networkRules;
      let sourceBundle = null;
      if (rustSourceParserReady) {
        try {
          sourceBundle = parseFilterSourceWithRust(text);
        } catch (err) {
          console.warn(`   ⚠️  Rust parse_filter_source failed for ${list.id} (${err.message}); using JS fallback.`);
        }
      }
      if (!sourceBundle) sourceBundle = buildSourceBundleFallback(parsed);

      let truncatedCount = 0;
      if (networkRules.length > config.totalLimit) {
        const before = networkRules.length;
        console.log(`   ⚠️  Rule count (${before}) exceeds limit for ${list.id}. Applying smart selection to ${config.totalLimit}...`);
        networkRules = smartTruncate(networkRules, config.totalLimit);
        truncatedCount = before - networkRules.length;
        console.log(`   ✂️  Smart selection: ${networkRules.length} rules kept (${truncatedCount} trimmed by smartTruncate)`);
      }

      const { dnrRules, droppedRecords } = buildDNRRules(networkRules);

      writeSkipLog(list.id, {
        parseSkips: parsed.skippedRecords,
        dnrDrops: droppedRecords,
        truncatedCount,
      });
      printSkipSummary(list.id, parsed.skippedRecords, droppedRecords, truncatedCount);

      // Split and stage rules for a single final write.
      for (let i = 0; i < config.parts; i++) {
        const chunk = dnrRules.slice(i * MAX_PER_FILE, (i + 1) * MAX_PER_FILE);
        const suffix = i === 0 ? '' : `_${i + 1}`;
        rulesetOutputs[`${list.id}${suffix}.json`] = chunk;
        console.log(`✅ ${list.id}${suffix}.json — ${chunk.length} DNR rules staged`);
      }
      console.log('');

      filterSources[list.id] = sourceBundle;

      // Merge cosmetic/scriptlet rules
      for (const selector of sourceBundle.cosmetic?.generic || []) {
        allCosmeticRules.generic.push(selector);
      }
      for (const [domain, selectors] of Object.entries(sourceBundle.cosmetic?.domainSpecific || {})) {
        if (!allCosmeticRules.domainSpecific[domain]) allCosmeticRules.domainSpecific[domain] = [];
        allCosmeticRules.domainSpecific[domain].push(...selectors);
      }
      for (const rule of sourceBundle.scriptlets || []) {
        allScriptletRules.push(rule);
      }
    } catch (err) {
      failures.push(list.id);
      console.error(`❌ Failed to process ${list.id}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to process filter lists: ${failures.join(', ')}`);
  }

  // Deduplicate generic selectors
  allCosmeticRules.generic = [...new Set(allCosmeticRules.generic)];
  // Deduplicate domain-specific
  for (const d of Object.keys(allCosmeticRules.domainSpecific)) {
    allCosmeticRules.domainSpecific[d] = [...new Set(allCosmeticRules.domainSpecific[d])];
  }

  writeBuildOutputs({
    rulesetOutputs,
    cosmeticRules: allCosmeticRules,
    scriptletRules: allScriptletRules,
    filterSources,
  });

  verifyManifestRuleResourcePaths();

  console.log('\n🎉 Build complete!');
  process.exit(0);
}

export { parseLine, networkFilterToDNR };

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}
