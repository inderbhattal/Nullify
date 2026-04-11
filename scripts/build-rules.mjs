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
 *   node scripts/build-rules.mjs --sample   # Generate minimal sample rules for dev/testing
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.resolve(__dirname, '../rules');

const isSample = process.argv.includes('--sample');

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
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt',
    description: 'uBO Annoyances — Popups, cookie banners, social overlays',
  },
  {
    id: 'malware',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
    description: 'URLhaus Malicious URL Blocklist',
  },
  {
    id: 'ubo-filters',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    description: 'uBlock Origin default filters',
  },
  {
    id: 'ubo-unbreak',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
    description: 'uBlock Origin unbreak list',
  },
  {
    id: 'anti-adblock',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
    description: 'uBlock Origin Anti-Adblock / Badware Filters',
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

  for (const line of text.split('\n')) {
    const m = line.trim().match(/^!#include\s+(.+)$/);
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
function nextId() { return ruleIdCounter++; }

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

/**
 * Parse a single filter line into a structured rule object.
 * Returns null if the line is a comment, blank, or unsupported.
 */
function parseLine(line) {
  line = line.trim();

  // Skip comments and empty lines
  if (!line || line.startsWith('!') || line.startsWith('[')) return null;
  // Skip Adblock Plus-specific directives
  if (line.startsWith('%') || line.startsWith('@@#')) return null;

  // ---- Scriptlet injections (MUST come before generic ## check) ----
  // example.com##+js(scriptlet-name, arg1, arg2)
  // Also handles AdGuard format: example.com#%#//scriptlet('name', 'arg')
  const scriptletMatch = line.match(/^([^#]*)##\+js\((.+)\)$/) ||
                         line.match(/^([^#]*)#\+js\((.+)\)$/);
  if (scriptletMatch) {
    const [, domains, scriptletStr] = scriptletMatch;
    // Parse args carefully — scriptlet args can contain commas inside quotes
    const args = parseScriptletArgs(scriptletStr);
    const [name, ...rest] = args;
    return {
      type: 'scriptlet',
      domains: domains ? domains.split(',').map(d => d.trim()).filter(Boolean) : [],
      name: name.trim(),
      args: rest,
    };
  }

  // ---- ABP extended CSS selectors (#?#) — treat as cosmetic rules ----
  // These use ABP's :-abp-contains(), :-abp-has() pseudo-selectors
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

  // ---- Cosmetic filters ----
  // Domain-specific: example.com##.ad-class
  // Generic: ##.ad-class
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

  // Cosmetic exception: example.com#@#.ad-class
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

  // ---- Network filters ----
  // Exception rules start with @@
  const isException = line.startsWith('@@');
  const rawRule = isException ? line.slice(2) : line;

  // Parse options block ($option1,option2,...)
  let pattern = rawRule;
  let optionsStr = '';
  const dollarPos = rawRule.lastIndexOf('$');
  if (dollarPos !== -1 && !rawRule.endsWith('$')) {
    pattern = rawRule.slice(0, dollarPos);
    optionsStr = rawRule.slice(dollarPos + 1);
  }

  // Skip rules we can't handle at all
  if (optionsStr.includes('$csp=') && !isException) {
    // CSP rules: convert to modifyHeaders if possible (simplified)
    return null; // Too complex for now
  }

  // Parse options
  const options = parseOptions(optionsStr);
  if (options === null) return null; // Unsupported option combo

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
      options.redirect = optName.split('=')[1];
    } else if (optName.startsWith('removeparam=')) {
      options.removeparam = optName.slice(12);
    } else if (optName === 'popup') {
      options.resourceTypes.push('main_frame');
    } else if (optName === 'inline-script') {
      // Can't block inline scripts in MV3, skip
      return null;
    } else if (optName === 'genericblock' || optName === 'generichide') {
      return null; // Complex, skip
    } else if (optName === 'elemhide' || optName === 'specifichide') {
      return null; // Handled in cosmetic engine
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

/**
 * Convert a parsed network filter into a DNR rule object.
 * Returns null if conversion is not possible.
 */
function networkFilterToDNR(parsed) {
  if (parsed.type !== 'network') return null;

  const { pattern, options, exception } = parsed;

  // Safe Path Guard: If this pattern matches a critical path, 
  // and it's a block rule, skip it or convert to allow if it's an exception.
  const lowerPattern = pattern.toLowerCase();
  for (const safePath of CRITICAL_SAFE_PATHS) {
    if (lowerPattern.includes(safePath)) {
      if (exception) return null; // already handled by allow rule
      if (!options.important) {
        // console.log(`   🛡️  Neutralizing critical path block: ${pattern}`);
        return null; // Skip this block rule
      }
    }
  }

  // Build URL condition
  let urlFilter = null;
  let regexFilter = null;

  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    // Regex filter — Chrome DNR compiles with RE2 under a 2KB program memory limit.
    //
    // Rejection criteria:
    // 1. RE2-unsupported syntax: lookaheads, lookbehinds, backrefs, etc.
    // 2. Non-ASCII characters.
    // 3. Source longer than 150 chars.
    // 4. Product of all {n,m} upper-bounds > 500 (catches nested quantifiers).
    // 5. Estimated NFA instruction count > 1000.
    //    RE2 expands character classes into per-char alternatives:
    //    [0-9A-Za-z]{16} = 62 chars × 16 reps = 992 NFA instructions.
    //    \d, \w, \s shorthands expand similarly (10, 63, 6 chars).
    // 6. Must compile as valid JS regex (final syntax check).

    regexFilter = pattern.slice(1, -1);

    // Check 1: RE2-unsupported syntax
    if (/\(\?[=!]|\(\?<[=!]|\\[1-9]|\(\?>|[*+?]\+|\(\?\(|\\k</.test(regexFilter)) return null;

    // Check 2: non-ASCII
    if (/[^\x00-\x7F]/.test(regexFilter)) return null;

    // Check 3: source length
    if (regexFilter.length > 150) return null;

    // Check 4: product of all quantifier upper-bounds
    let quantProduct = 1;
    const quantRe4 = /\{(\d+)(?:,(\d+))?\}/g;
    let qm4;
    while ((qm4 = quantRe4.exec(regexFilter)) !== null) {
      quantProduct *= parseInt(qm4[2] ?? qm4[1], 10);
      if (quantProduct > 500) return null;
    }

    // Check 5: estimated NFA instruction cost
    // RE2 expands [a-z] into 26 alternatives, \d into 10, \w into 63, etc.
    // A quantifier {n,m} on an expression of cost C produces ~C*m instructions.
    // Chrome's 2KB limit ≈ 500-700 raw nodes (each has ~3 bytes RE2 overhead).
    if (estimateRegexNfaCost(regexFilter) > 500) return null;

    // Check 6: valid JS regex syntax
    try { new RegExp(regexFilter); } catch { return null; }
  } else {
    // Convert ABP-style URL pattern to DNR urlFilter
    urlFilter = convertPatternToUrlFilter(pattern);
    if (!urlFilter) return null;
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
    id: nextId(),
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
  'eg','ng','ke','tz','gh','cm','ma','dz','tn','ly','sd','et','eu','ar','cl',
  'pe','ve','ec','co','gt','hn','sv','cr','pa','cu','do','tt','bb','jm','bz',
]);

/** Convert ABP-style URL pattern to DNR urlFilter */
function convertPatternToUrlFilter(pattern) {
  if (!pattern || pattern === '*') return null; // Too broad
  if (pattern.length < 4) return null; // Too short

  // DNR urlFilter must be ASCII-only
  if (/[^\x00-\x7F]/.test(pattern)) return null;

  // || means domain anchor — wildcard immediately after || is invalid in DNR
  if (pattern.startsWith('||*')) return null;

  // || must only appear at the very start
  if (pattern.indexOf('||', 1) !== -1) return null;

  // Check for extreme broadness
  if (pattern === '||' || pattern === '|' || pattern === '^') return null;

  // Guard: ||TLD^ (e.g. ||com^, ||net^, ||io^) anchors on the TLD component and
  // therefore matches EVERY domain with that TLD — far too broad.
  // Extract the first hostname label after ||: everything up to the first . ^ / * ?
  if (pattern.startsWith('||')) {
    const labelMatch = /^\|\|([^.|/*?^]+)/.exec(pattern);
    if (labelMatch && KNOWN_TLDS.has(labelMatch[1].toLowerCase())) return null;
  }

  // DNR urlFilter uses the same syntax as ABP for these tokens, so it maps directly
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
 */
function parseFilterList(text) {
  const networkRules = [];
  const cosmeticRules = [];
  const cosmeticExceptions = [];
  const scriptletRules = [];
  let skipped = 0;

  for (const line of text.split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) { skipped++; continue; }

    if (parsed.type === 'network') {
      networkRules.push(parsed);
    } else if (parsed.type === 'cosmetic') {
      if (parsed.exception) cosmeticExceptions.push(parsed);
      else cosmeticRules.push(parsed);
    } else if (parsed.type === 'scriptlet') {
      scriptletRules.push(parsed);
    }
  }

  return { networkRules, cosmeticRules, cosmeticExceptions, scriptletRules, skipped };
}

/**
 * Convert parsed network rules to DNR rules, deduplicate, and return.
 */
function buildDNRRules(networkRules) {
  const dnrRules = [];
  const seen = new Set();

  for (const parsed of networkRules) {
    const rule = networkFilterToDNR(parsed);
    if (!rule) continue;

    // Deduplicate by urlFilter+action+resourceTypes
    const key = JSON.stringify({
      uf: rule.condition.urlFilter || rule.condition.regexFilter,
      rt: rule.condition.resourceTypes,
      at: rule.action.type,
    });
    if (seen.has(key)) continue;
    seen.add(key);

    dnrRules.push(rule);
  }

  return dnrRules;
}

// ---------------------------------------------------------------------------
// Sample rules generator (for development without internet access)
// ---------------------------------------------------------------------------
function generateSampleRules(listId) {
  const SAMPLE_NETWORK_RULES = [
    { id: nextId(), priority: 1, condition: { urlFilter: '||doubleclick.net^', resourceTypes: ['script','image','xmlhttprequest'] }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||googlesyndication.com^', resourceTypes: ['script','image'] }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||googleadservices.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||adnxs.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||adsystem.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||advertising.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||tracking.com^', resourceTypes: ['xmlhttprequest', 'image'] }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||analytics.google.com^', resourceTypes: ['xmlhttprequest'] }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||facebook.com/tr*', resourceTypes: ['image','xmlhttprequest'] }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||google-analytics.com/collect*' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||pagead2.googlesyndication.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||ads.yahoo.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||quantserve.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||scorecardresearch.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||taboola.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||outbrain.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||criteo.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||rubiconproject.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||openx.net^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||pubmatic.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||33across.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||amazon-adsystem.com^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||bing.com/fd/ls/lsp.aspx' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||hotjar.com^', resourceTypes: ['script','xmlhttprequest'] }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||mixpanel.com^', resourceTypes: ['xmlhttprequest'] }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '*/beacon*', resourceTypes: ['ping','xmlhttprequest'] }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||segment.io^' }, action: { type: 'block' } },
    { id: nextId(), priority: 1, condition: { urlFilter: '||amplitude.com^', resourceTypes: ['xmlhttprequest'] }, action: { type: 'block' } },
    // HTTP→HTTPS upgrade
    { id: nextId(), priority: 1, condition: { urlFilter: 'http://' }, action: { type: 'upgradeScheme' } },
  ];

  if (listId === 'easylist') return SAMPLE_NETWORK_RULES;

  if (listId === 'easyprivacy') {
    return [
      { id: nextId(), priority: 1, condition: { urlFilter: '||graph.facebook.com/*/activities*' }, action: { type: 'block' } },
      { id: nextId(), priority: 1, condition: { urlFilter: '||pixel.twitter.com^' }, action: { type: 'block' } },
      { id: nextId(), priority: 1, condition: { urlFilter: '||connect.facebook.net/*/sdk.js' }, action: { type: 'block' } },
      { id: nextId(), priority: 1, condition: { urlFilter: '||bat.bing.com^' }, action: { type: 'block' } },
      { id: nextId(), priority: 1, condition: { urlFilter: '||tealiumiq.com^' }, action: { type: 'block' } },
      { id: nextId(), priority: 1, condition: { urlFilter: '||go.microsoft.com/fwlink/?LinkID=*&clcid=*' }, action: { type: 'block' } },
    ];
  }

  if (listId === 'annoyances') {
    return [
      { id: nextId(), priority: 1, condition: { urlFilter: '||widgets.outbrain.com^' }, action: { type: 'block' } },
      { id: nextId(), priority: 1, condition: { urlFilter: '||cdn.syndication.twimg.com^' }, action: { type: 'block' } },
    ];
  }

  if (listId === 'malware') {
    return [
      { id: nextId(), priority: 1, condition: { urlFilter: '||malware.example.com^' }, action: { type: 'block' } },
    ];
  }

  if (listId === 'ubo-filters') {
    return [
      { id: nextId(), priority: 1, condition: { urlFilter: '||cdn.jsdelivr.net/*/pubfig.min.js' }, action: { type: 'block' } },
      { id: nextId(), priority: 2, condition: { urlFilter: '||fonts.googleapis.com^' }, action: { type: 'allow' } },
    ];
  }

  if (listId === 'ubo-unbreak') {
    return [
      // Unbreak rules are mostly exceptions
      { id: nextId(), priority: 3, condition: { urlFilter: '||cdn.jsdelivr.net/npm/*' }, action: { type: 'allow' } },
    ];
  }

  if (listId === 'anti-adblock') {
    return [];  // No network rules in sample — scriptlets handle anti-adblock
  }

  return [];
}

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

  // Pass 3: subsumption — domain-only anchors subsume path-specific anchors
  const dominantDomains = new Set();
  const selected = [];

  for (const r of networkRules) {
    if (selected.length >= limit) break;

    const isDomainOnly = /^\|\|([^/*?^]+)\^?$/.exec(r.pattern);
    if (isDomainOnly && !r.exception) {
      dominantDomains.add(isDomainOnly[1]);
      selected.push(r);
      continue;
    }

    // Skip if a broader rule for this domain is already selected
    if (!r.exception && r.pattern.startsWith('||')) {
      const domainMatch = /^\|\|([^/*?^]+)/.exec(r.pattern);
      if (domainMatch && dominantDomains.has(domainMatch[1])) continue;
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

  const allCosmeticRules = generateSampleCosmeticRules();
  const allScriptletRules = generateSampleScriptletRules();

  // Define how many parts each list is split into (matching manifest.json)
  const LIST_CONFIG = {
    'easylist': { parts: 4, totalLimit: 100000 },
    'easyprivacy': { parts: 3, totalLimit: 75000 },
    'ubo-filters': { parts: 2, totalLimit: 40000 },
    'annoyances': { parts: 1, totalLimit: 30000 },
    'malware': { parts: 1, totalLimit: 30000 },
    'ubo-unbreak': { parts: 1, totalLimit: 30000 },
    'anti-adblock': { parts: 1, totalLimit: 30000 },
  };

  const MAX_PER_FILE = 25000;

  if (isSample) {
    console.log('🔧 Generating sample rules (no network fetch)...\n');

    for (const list of FILTER_LISTS) {
      const config = LIST_CONFIG[list.id] || { parts: 1, totalLimit: 30000 };
      const dnrRules = generateSampleRules(list.id);
      
      for (let i = 0; i < config.parts; i++) {
        const chunk = i === 0 ? dnrRules : []; // Only put samples in the first file
        const suffix = i === 0 ? '' : `_${i + 1}`;
        const outPath = path.join(RULES_DIR, `${list.id}${suffix}.json`);
        fs.writeFileSync(outPath, JSON.stringify(chunk, null, 2));
        console.log(`✅ ${list.id}${suffix}.json — ${chunk.length} rules`);
      }
    }
  } else {
    console.log('📡 Downloading filter lists...\n');

    for (const list of FILTER_LISTS) {
      try {
        console.log(`⬇️  Fetching ${list.description}...`);
        const text = await fetchAndExpand(list.url);
        const parsed = parseFilterList(text);

        console.log(`   Parsed: ${parsed.networkRules.length} network, ${parsed.cosmeticRules.length} cosmetic, ${parsed.scriptletRules.length} scriptlets, ${parsed.skipped} skipped`);

        const config = LIST_CONFIG[list.id] || { parts: 1, totalLimit: 30000 };
        let networkRules = parsed.networkRules;
        
        if (networkRules.length > config.totalLimit) {
          console.log(`   ⚠️  Rule count (${networkRules.length}) exceeds limit for ${list.id}. Applying smart selection to ${config.totalLimit}...`);
          networkRules = smartTruncate(networkRules, config.totalLimit);
          console.log(`   ✂️  Smart selection: ${networkRules.length} rules kept`);
        }

        const dnrRules = buildDNRRules(networkRules);
        
        // Split and write rules
        for (let i = 0; i < config.parts; i++) {
          const chunk = dnrRules.slice(i * MAX_PER_FILE, (i + 1) * MAX_PER_FILE);
          const suffix = i === 0 ? '' : `_${i + 1}`;
          const outPath = path.join(RULES_DIR, `${list.id}${suffix}.json`);
          fs.writeFileSync(outPath, JSON.stringify(chunk, null, 2));
          console.log(`✅ ${list.id}${suffix}.json — ${chunk.length} DNR rules written`);
        }
        console.log('');

        // Merge cosmetic/scriptlet rules
        for (const r of parsed.cosmeticRules) {
          if (r.domains.length === 0) {
            allCosmeticRules.generic.push(r.selector);
          } else {
            for (const d of r.domains) {
              if (!allCosmeticRules.domainSpecific[d]) allCosmeticRules.domainSpecific[d] = [];
              allCosmeticRules.domainSpecific[d].push(r.selector);
            }
          }
        }
        for (const r of parsed.scriptletRules) {
          allScriptletRules.push(r);
        }
      } catch (err) {
        console.error(`❌ Failed to process ${list.id}: ${err.message}`);
      }
    }
  }

  // Write cosmetic rules (used by content-script cosmetic engine)
  const cosmeticsPath = path.join(RULES_DIR, 'cosmetic-rules.json');
  // Deduplicate generic selectors
  allCosmeticRules.generic = [...new Set(allCosmeticRules.generic)];
  // Deduplicate domain-specific
  for (const d of Object.keys(allCosmeticRules.domainSpecific)) {
    allCosmeticRules.domainSpecific[d] = [...new Set(allCosmeticRules.domainSpecific[d])];
  }
  fs.writeFileSync(cosmeticsPath, JSON.stringify(allCosmeticRules, null, 2));
  console.log(`\n✅ cosmetic-rules.json — ${allCosmeticRules.generic.length} generic + ${Object.keys(allCosmeticRules.domainSpecific).length} domain-specific`);

  // Write scriptlet rules
  const scriptletsPath = path.join(RULES_DIR, 'scriptlet-rules.json');
  fs.writeFileSync(scriptletsPath, JSON.stringify(allScriptletRules, null, 2));
  console.log(`✅ scriptlet-rules.json — ${allScriptletRules.length} rules`);

  console.log('\n🎉 Build complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
