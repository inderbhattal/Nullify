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
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import {
  CORE_FILTER_SOURCE,
  shouldSkipDomainCosmeticSelector,
} from '../src/shared/core-filter-source.js';
import {
  splitDomainList,
  applyScriptletExceptions,
  evaluatePreprocessorCondition,
} from '../src/shared/filter-syntax.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.resolve(__dirname, '../rules');
const SAMPLE_MODE = process.argv.includes('--sample');
// Skip SRI verification — use with caution, only for development
const SKIP_SRI = process.argv.includes('--skip-sri');
// DEBUG flag for development logging — set to true to enable verbose logs
const DEBUG = process.env.DEBUG === 'true' || process.argv.includes('--verbose');
const log = DEBUG ? console.log.bind(console) : () => {};

// SRI hashes for remote filter lists — loaded from the committed lock file.
// The lock lives under scripts/ (not rules/) because rules/*.json is
// gitignored: the whole point of the lock is that it is committed and
// reviewed, so a build verifies against hashes that went through review
// rather than against whatever the CDN served last time.
const LOCK_FILE_PATH = path.join(__dirname, 'filter-lists.lock.json');
let FILTER_LIST_HASHES = {};
try {
  if (fs.existsSync(LOCK_FILE_PATH)) {
    FILTER_LIST_HASHES = JSON.parse(fs.readFileSync(LOCK_FILE_PATH, 'utf8'));
  }
} catch (err) {
  console.warn('[SRI] Could not parse filter-lists.lock.json:', err.message);
}

// NOTE: totalLimit must not exceed parts * MAX_PER_FILE — the shard writer
// emits at most that many rules, so any excess would vanish silently with no
// skip-log record (single-part lists used to declare 30000 against a 25000
// write capacity). effectiveListLimit() reconciles and the build logs any
// capping, but keep the declared numbers honest too.
const LIST_CONFIG = {
  'easylist': { parts: 4, totalLimit: 100000 },
  'easyprivacy': { parts: 3, totalLimit: 75000 },
  'ubo-filters': { parts: 2, totalLimit: 40000 },
  'annoyances': { parts: 1, totalLimit: 25000 },
  'malware': { parts: 1, totalLimit: 25000 },
  'ubo-unbreak': { parts: 1, totalLimit: 25000 },
  'anti-adblock': { parts: 1, totalLimit: 25000 },
  'ubo-cookie-annoyances': { parts: 1, totalLimit: 25000 },
};

const MAX_PER_FILE = 25000;

/**
 * The number of rules a list can actually ship: the configured totalLimit,
 * clamped to what the shard writer can physically emit (parts * MAX_PER_FILE).
 */
function effectiveListLimit(config) {
  const parts = config.parts || 1;
  const capacity = parts * MAX_PER_FILE;
  return Math.min(config.totalLimit ?? capacity, capacity);
}

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
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

function fetchText(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'adblock-mv3-builder/1.0' } }, (res) => {
      if (REDIRECT_STATUS_CODES.has(res.statusCode)) {
        if (maxRedirects <= 0) return reject(new Error(`Redirect limit exceeded for ${url}`));
        const location = res.headers.location;
        // https only — a redirect that downgrades to http:// would let an
        // on-path attacker substitute list content that then gets hashed and
        // shipped. The initial URLs are all https; keep the whole chain there.
        if (!location || !location.startsWith('https://')) {
          return reject(new Error(`Invalid or non-https redirect location for ${url}`));
        }
        return fetchText(location, maxRedirects - 1).then(resolve).catch(reject);
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
 * Verify fetched content against the pinned SRI hash.
 *
 * `content` must be the FULLY-EXPANDED list text (after !#include resolution
 * and preprocessor evaluation) — uBO lists carry most of their content in
 * includes, so hashing only the top-level file would verify almost nothing.
 *
 * A missing hash is a FAILURE, not a pass: the previous behaviour returned
 * `{ valid: true }` when no hash existed, and since the hash file was
 * gitignored and absent, SRI was dead code in every real build. Sample builds
 * never fetch, so they are unaffected; `--skip-sri` remains as an explicit,
 * logged dev override.
 *
 * Returns { valid: boolean, skipped?: boolean, error?: string }
 */
function verifySriHash(content, listId, hashes = FILTER_LIST_HASHES) {
  if (SKIP_SRI) {
    return { valid: true, skipped: true };
  }

  const hashInfo = hashes[listId];
  if (!hashInfo || !hashInfo.sha384) {
    return {
      valid: false,
      error: `no pinned hash in scripts/filter-lists.lock.json — run \`node scripts/generate-sri-hashes.mjs\` to (re)generate the lock, review the diff, and commit it`,
    };
  }

  const expectedPrefix = 'sha384-';
  if (!hashInfo.sha384.startsWith(expectedPrefix)) {
    return { valid: false, error: `Invalid hash format (expected ${expectedPrefix}...)` };
  }

  const expectedHash = hashInfo.sha384.slice(expectedPrefix.length);
  const actualHash = createHash('sha384').update(content).digest('base64');

  if (actualHash !== expectedHash) {
    return {
      valid: false,
      error: `SRI hash mismatch! Expected ${expectedHash.slice(0, 24)}..., got ${actualHash.slice(0, 24)}...`,
    };
  }

  return { valid: true };
}

/**
 * Fetch a filter list and recursively resolve !#include directives.
 * uBlock Origin's filter lists are split across many sub-files.
 *
 * SRI verification happens on the RETURN VALUE of the top-level call (the
 * fully-expanded text), in `main` and in generate-sri-hashes.mjs — not here.
 * Verifying only the top-level fetch let every !#include sub-file bypass
 * verification entirely.
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
      const isTrue = evaluatePreprocessorCondition(condition);
      stack.push(isTrue && stack[stack.length - 1]);
      continue;
    }
    if (trimmed.startsWith('!#else')) {
      // Guard the empty stack the way !#endif already does: a stray !#else
      // would otherwise push `!undefined && undefined` — falsy — and silently
      // drop the entire remainder of the list.
      if (stack.length <= 1) continue;
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
  // uBO/ABP aliases. Without these the option is unrecognised, and since
  // unrecognised options now drop the rule, a missing alias costs real
  // coverage rather than silently widening the rule as it used to.
  xhr: 'xmlhttprequest',
  css: 'stylesheet',
  frame: 'sub_frame',
  doc: 'main_frame',
  beacon: 'ping',
  'object-subrequest': 'object',
};

/**
 * Options that are safe to ignore: dropping them cannot make the emitted rule
 * match anything the filter author did not intend.
 *
 * Everything not listed here and not handled explicitly in `parseOptions`
 * drops the whole rule. That direction matters — the previous default was to
 * ignore unknown options and ship the remainder, which emitted a *broader*
 * rule than was written: `$badfilter` (cancel this filter) became an active
 * block, a bare `$removeparam` (strip all query params) became a hard block of
 * the domain, and `$denyallow=` lost the exclusion that kept a CDN reachable.
 */
const IGNORABLE_OPTIONS = new Set([
  // Cannot be expressed in MV3; other options on the rule still apply.
  'inline-script',
  'inline-font',
  // Redirect-to-stub shorthands. We have no resource library, so the request
  // is blocked instead of stubbed — same direction, never broader.
  'empty',
  'mp4',
  // Widens to every resource type including the document. Ignoring it yields
  // "all types except main_frame", which is narrower.
  'all',
]);

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

function normalizeCosmeticScopeDomain(domain) {
  const normalized = String(domain || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!normalized || normalized.includes('*') || normalized.includes('/') || normalized.includes(':')) return '';
  if (!normalized.includes('.') && normalized !== 'localhost') return '';
  return normalized;
}

function extractCosmeticScopeExceptionDomains(pattern) {
  const value = String(pattern || '').trim();
  if (!value) return [];

  if (value.startsWith('||')) {
    const match = /^\|\|([^/*?^|]+)/.exec(value);
    const domain = normalizeCosmeticScopeDomain(match?.[1]);
    return domain ? [domain] : [];
  }

  if (value.startsWith('|http://') || value.startsWith('|https://')) {
    try {
      const url = new URL(value.slice(1));
      const domain = normalizeCosmeticScopeDomain(url.hostname);
      return domain ? [domain] : [];
    } catch {
      return [];
    }
  }

  const plain = value.replace(/\^$/, '');
  if (/^[a-z0-9.-]+$/i.test(plain)) {
    const domain = normalizeCosmeticScopeDomain(plain);
    return domain ? [domain] : [];
  }

  return [];
}

function dedupeDomains(domains) {
  return [...new Set((domains || []).map(normalizeCosmeticScopeDomain).filter(Boolean))];
}

/**
 * Parse a single filter line into a structured rule object.
 * Returns a rule, SKIP_SILENT (comment/blank), or `{ skip, reason }`.
 */
function parseLine(line) {
  line = line.trim();

  if (!line || line.startsWith('!') || line.startsWith('[')) return SKIP_SILENT;
  if (line.startsWith('@@#')) return SKIP_SILENT;

  // Scriptlet exception: example.com#@#+js(name). Tested before the scriptlet
  // branch — `#@#+js(` contains `#+js(`, so the ordinary scriptlet patterns
  // would otherwise claim (or, for the `#@#` cosmetic branch below, mangle) it.
  const scriptletExceptionMatch = line.match(/^([^#|/?^]*)#@#\+js\((.+)\)$/);
  if (scriptletExceptionMatch) {
    const [, domains, scriptletStr] = scriptletExceptionMatch;
    const [name] = parseScriptletArgs(scriptletStr);
    return {
      type: 'scriptlet-exception',
      ...splitDomainList(domains),
      name: (name || '').trim(),
    };
  }

  const scriptletMatch = line.match(/^([^#|/?^]*)##\+js\((.+)\)$/) ||
                         line.match(/^([^#|/?^]*)#\+js\((.+)\)$/);
  if (scriptletMatch) {
    const [, domains, scriptletStr] = scriptletMatch;
    const args = parseScriptletArgs(scriptletStr);
    const [name, ...rest] = args;
    return {
      type: 'scriptlet',
      ...splitDomainList(domains),
      name: name.trim(),
      args: rest,
    };
  }

  const abpExtMatch = line.match(/^([^#|/?^]*)#\?#(.+)$/);
  if (abpExtMatch) {
    const [, domains, selector] = abpExtMatch;
    return {
      type: 'cosmetic',
      ...splitDomainList(domains),
      selector,
      exception: false,
    };
  }

  const cosmeticMatch = line.match(/^([^#|/?^]*)##(.+)$/);
  if (cosmeticMatch) {
    const [, domains, selector] = cosmeticMatch;
    return {
      type: 'cosmetic',
      ...splitDomainList(domains),
      selector,
      exception: false,
    };
  }

  const cosmeticExceptionMatch = line.match(/^([^#|/?^]*)#@#(.+)$/);
  if (cosmeticExceptionMatch) {
    const [, domains, selector] = cosmeticExceptionMatch;
    return {
      type: 'cosmetic',
      ...splitDomainList(domains),
      selector,
      exception: true,
    };
  }

  const isException = line.startsWith('@@');
  const rawRule = isException ? line.slice(2) : line;

  let pattern = rawRule;
  let optionsStr = '';
  if (rawRule.startsWith('/') && rawRule.endsWith('/') && rawRule.length > 2) {
    // A complete /regex/ literal: any `$` inside it is a regex anchor, never
    // an option separator. `/banner[0-9]+\.gif$/` used to be split at the `$`
    // and shipped as a literal urlFilter containing regex syntax.
  } else if (rawRule.startsWith('/') && rawRule.lastIndexOf('/$') > 0) {
    // /regex/$options — for a regex literal the separator is only valid
    // after the closing slash.
    const sepIdx = rawRule.lastIndexOf('/$');
    pattern = rawRule.slice(0, sepIdx + 1);
    optionsStr = rawRule.slice(sepIdx + 2);
  } else {
    const dollarPos = rawRule.lastIndexOf('$');
    if (dollarPos !== -1 && !rawRule.endsWith('$')) {
      pattern = rawRule.slice(0, dollarPos);
      optionsStr = rawRule.slice(dollarPos + 1);
    }
  }

  if (/(^|,)csp(=|,|$)/.test(optionsStr)) {
    // Neither direction is translated. Skipping the block form is merely a
    // parity gap; the exception form previously fell through to a network
    // `allow`, which disabled all blocking on the domain instead of only
    // relaxing CSP injection there.
    return skip(isException
      ? 'csp-exception: not translated; emitting a network allow would disable all blocking on the domain'
      : 'csp-modifier: Chrome MV3 DNR cannot inject CSP response headers via a block rule; needs modifyHeaders which we do not translate yet');
  }

  const options = parseOptions(optionsStr);
  if (options === null) {
    const offending = lastUnsupportedOption;
    lastUnsupportedOption = null;
    return skip(`unsupported-option: ${offending} — dropping the rule rather than shipping it broadened`);
  }

  if (isException && options.cosmeticScopeExceptions.length > 0) {
    const domains = dedupeDomains([
      ...extractCosmeticScopeExceptionDomains(pattern),
      ...options.initiatorDomains,
    ]);
    if (domains.length === 0) {
      return skip('cosmetic-scope-exception: unsupported domain pattern');
    }
    return {
      type: 'cosmetic-scope-exception',
      domains,
      scopes: options.cosmeticScopeExceptions,
      pattern,
    };
  }

  // Backstop for the cosmetic-classification branches above. A line carrying a
  // cosmetic separator that reached this point was not recognised by any of
  // them; shipping it as a network rule produces a urlFilter containing the
  // whole filter line, which matches nothing and burns static-rule budget.
  if (pattern.includes('##') || pattern.includes('#@#')) {
    return skip('cosmetic-line-in-network-path: unrecognised cosmetic syntax, not a URL pattern');
  }

  // uBO applies `redirect-rule=` only when some OTHER filter blocks the
  // request; on its own it does nothing. DNR cannot express that
  // conditionality, and the previous conversion emitted an unconditional
  // redirect — rewriting requests that nothing would have blocked.
  if (options.redirectRule !== null) {
    return skip('redirect-rule-unsupported: uBO applies redirect-rule= only when another filter blocks; DNR cannot express the conditionality, so emitting an unconditional redirect over-applies');
  }

  // ABP $popup matches only script-opened popup windows; DNR has no popup
  // concept, so the closest conversion is a main_frame block. That is
  // acceptable for a rule anchored to a dedicated popup/ad domain, but for a
  // broad pattern (`/r.php?u=https`, `.com/smartpop/`) it turns ordinary
  // link clicks into full-page ERR_BLOCKED_BY_CLIENT. uBO Lite drops $popup
  // entirely under DNR; we keep only the ||domain^-anchored form.
  if (options.popup && !isException && !/^\|\|[a-z0-9.-]+\^?$/i.test(pattern)) {
    return skip('popup-broad-pattern: $popup only converts safely for ||domain^-anchored patterns; a broad pattern would block ordinary navigations, not just popups');
  }

  return {
    type: 'network',
    pattern,
    options,
    exception: isException,
  };
}

/**
 * Options that scope *cosmetic* filtering, mapped to their canonical name.
 *
 * uBO accepts a short spelling for each, and the lists this project fetches
 * use them heavily (unbreak.txt ships a whole `$ghide` section). Only the long
 * forms were recognised, so the short ones fell through to the network path
 * and became `allow` rules at a priority above every block — turning "do not
 * apply generic cosmetics here" into "disable all blocking on this domain".
 * Downstream matching is by canonical name, so aliases must normalise rather
 * than pass through.
 */
/** Set by `parseOptions` when it bails, so the skip reason can name the option. */
let lastUnsupportedOption = null;

const COSMETIC_SCOPE_OPTIONS = new Map([
  ['generichide', 'generichide'],
  ['ghide', 'generichide'],
  ['elemhide', 'elemhide'],
  ['ehide', 'elemhide'],
  ['specifichide', 'specifichide'],
  ['shide', 'specifichide'],
  ['genericblock', 'genericblock'],
]);

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
    redirectRule: null,
    removeparam: null,
    important: false,
    badfilter: false,
    matchCase: false,
    popup: false,
    cosmeticScopeExceptions: [],
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
    } else if (optName === 'badfilter') {
      // Pass-1 marker for the two-pass suppression in parseFilterList. The
      // rule itself must never ship; it exists to cancel its base form.
      options.badfilter = true;
    } else if (optName === 'match-case') {
      options.matchCase = !negated;
    } else if (optName.startsWith('redirect=') || optName.startsWith('redirect-rule=')) {
      // uBO resource names are usually simple, but the value side can contain
      // '=' for base64-encoded fallbacks — slice past the FIRST '=' rather
      // than splitting, which would truncate anything after a second '='.
      // redirect-rule= is kept separate: it is conditional on another filter
      // blocking, which DNR cannot express, so parseLine skips those rules.
      const eqIdx = optName.indexOf('=');
      const value = eqIdx >= 0 ? optName.slice(eqIdx + 1) : '';
      if (optName.startsWith('redirect-rule=')) options.redirectRule = value;
      else options.redirect = value;
    } else if (optName.startsWith('removeparam=')) {
      options.removeparam = optName.slice(12);
    } else if (optName === 'popup') {
      options.popup = true;
      options.resourceTypes.push('main_frame');
    } else if (optName === 'inline-script') {
      // Manifest V3 can't block inline scripts.
      // We don't skip the rule, we just ignore this specific option
      // so other options in the same rule (like $script) still apply.
    } else if (COSMETIC_SCOPE_OPTIONS.has(optName)) {
      // Cosmetic-scope exception hints — we no longer flip `important`
      // here. Setting the priority-bumped important flag used to mask real
      // cosmetic exception rules at DNR priority 5.
      options.cosmeticScopeException = true;
      if (!negated) options.cosmeticScopeExceptions.push(COSMETIC_SCOPE_OPTIONS.get(optName));
    } else if (!IGNORABLE_OPTIONS.has(optName)) {
      // Fail closed. An option we do not understand may be the one that
      // narrows the rule, so shipping the remainder over-blocks.
      lastUnsupportedOption = optName;
      return null;
    }
  }

  return options;
}

/**
 * Detect nested quantifiers that cause exponential backtracking.
 * Patterns like (a+)+, (a*)+, (a+)*, (a*)*, (a+){2,}, etc. are dangerous.
 * Returns { safe: boolean, pattern?: string } — if not safe, pattern describes the issue.
 */
function detectNestedQuantifiers(pattern) {
  // Look for quantifier followed by quantifier (possibly with intermediate chars)
  // Quantifiers: * + ? {n} {n,} {n,m}
  const quantChar = '[*+?]';
  const quantGroup = '\\{\\d+(?:,\\d*)?\\}';

  // Pattern 1: (...)X where X is a quantifier and inside has quantifiable content
  // e.g., (a+)+, (ab*)*, ([0-9]+){2,}
  const nestedQuantRe = new RegExp(
    `(\\([^()]*(${quantChar}|${quantGroup})[^()]*\\)(${quantChar}|${quantGroup}))`,
    'g'
  );
  if (nestedQuantRe.test(pattern)) {
    return { safe: false, pattern: 'nested-quantifier' };
  }

  // Pattern 2: Adjacent quantifiers on same token: a*a+, a+a*, a{2,}a*, etc.
  const adjacentQuantRe = new RegExp(
    `(${quantChar}|${quantGroup})\\s*\\w*\\s*(${quantChar}|${quantGroup})`
  );
  if (adjacentQuantRe.test(pattern)) {
    return { safe: false, pattern: 'adjacent-quantifiers' };
  }

  return { safe: true };
}

/**
 * Estimate RE2 NFA instruction cost for a regex pattern.
 *
 * RE2 compiles to a Thompson NFA and never backtracks. Character classes
 * compile to per-RANGE byte-range instructions (so `[0-9a-z]` is 2
 * instructions, not 36, and `.` is one range, not 256 alternatives), and
 * `*`/`+` add a split instruction around the body rather than unrolling it.
 * Only BOUNDED quantifiers (`{n}`, `{n,m}`) unroll — those keep their upper
 * bound as a multiplier. The previous estimator costed `.` at 256 and
 * `*`/`+` at ×10, so any pattern containing `.*` blew the 500 budget: the
 * skip logs showed ~100 valid regex rules dropped with claimed costs like
 * 25617, against only 39 kept.
 */
function estimateRegexNfaCost(pattern) {
  let cost = 0;
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === '[') {
      // Character class — cost = number of ranges, the unit RE2 compiles to.
      let j = i + 1;
      let negated = false;
      if (j < pattern.length && pattern[j] === '^') { negated = true; j++; }
      if (j < pattern.length && pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j++;
      const content = pattern.slice(i + (negated ? 2 : 1), j);
      let ranges = 0;
      for (let k = 0; k < content.length; k++) {
        if (content[k] === '\\') { ranges++; k++; continue; }
        if (k + 2 < content.length && content[k + 1] === '-') {
          ranges++;
          k += 2;
        } else { ranges++; }
      }
      // A negated class is the complement set: at most ranges + 1 ranges.
      const classCost = Math.max(1, ranges) + (negated ? 1 : 0);
      i = j + 1;
      const [mult, next] = getQuantMult(pattern, i);
      cost += classCost * mult;
      i = next;
    } else if (pattern[i] === '\\' && i + 1 < pattern.length) {
      const ch = pattern[i + 1];
      // Shorthand classes by range count: \d = 1 range, \w = 4 (0-9A-Z_a-z),
      // \s = 3 (tab-CR, space, NBSP-ish), negations approximated the same.
      const shSize = ch === 'd' || ch === 'D' ? 2
                   : ch === 'w' || ch === 'W' ? 5
                   : ch === 's' || ch === 'S' ? 4
                   : ch === 'b' || ch === 'B' ? 2 : 1;
      i += 2;
      const [mult, next] = getQuantMult(pattern, i);
      cost += shSize * mult;
      i = next;
    } else if (pattern[i] === '.') {
      // One byte-range instruction in RE2, not 256 alternatives.
      i++;
      const [mult, next] = getQuantMult(pattern, i);
      cost += mult;
      i = next;
    } else if (pattern[i] === '(' || pattern[i] === ')') {
      // Group bookkeeping (capture instructions) — cheap.
      cost++;
      i++;
    } else {
      cost++;
      const [mult, next] = getQuantMult(pattern, i + 1);
      cost += mult - 1;
      i = next;
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
  // `*` and `+` wrap the body in a split/loop pair — the body is NOT
  // unrolled by RE2, so the cost is body + O(1), modelled as ×2.
  if (pattern[i] === '+' || pattern[i] === '*') return [2, i + 1];
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
/**
 * Resource types applied to security-list rules that name no type of their own.
 * Enumerated rather than left implicit precisely because omitting the field
 * excludes `main_frame`.
 */
const SECURITY_LIST_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
];

/** Lists whose rules block malicious hosts outright, so navigations must match. */
const SECURITY_LIST_IDS = new Set(['malware']);

/**
 * DNR priority bands for statically compiled rules, lowest to highest.
 * Runtime rules sit above all of these: the user allowlist uses 500 and
 * system-unbreak 1000.
 *
 * REDIRECT sits above BLOCK because at EQUAL priority DNR resolves
 * allow > block > redirect — so a co-matching EasyList block would defeat
 * every $redirect= stub and hard-block where uBO serves a working
 * placeholder, causing exactly the breakage the redirect exists to prevent.
 * One band up, the redirect wins over plain blocks while still losing to
 * every allow. $removeparam redirects intentionally stay in the BLOCK band:
 * if a URL is both blocked and param-stripped, blocking must win.
 */
const DNR_PRIORITY = {
  BLOCK: 1,
  REDIRECT: 2,
  ALLOW: 3,
  IMPORTANT_BLOCK: 4,
  IMPORTANT_REDIRECT: 5,
  IMPORTANT_ALLOW: 6,
};

function networkFilterToDNR(parsed, conversionOptions = {}) {
  if (parsed.type !== 'network') return null;

  const { pattern, options, exception } = parsed;

  // $badfilter rules are pass-1 directives consumed by parseFilterList's
  // suppression pass; converting one would ship the very rule it cancels.
  if (options.badfilter) {
    reportDrop('badfilter-directive: consumed by two-pass suppression, never shipped as a rule', pattern);
    return null;
  }

  // Wildcard entity domains (`gmx.*`) are invalid DNR initiatorDomains —
  // Chrome rejects the whole rule at ruleset indexing. The bundled PSL is a
  // curated stop-list (membership predicate only), not an enumerable TLD set
  // suitable for entity expansion, so these entries cannot be expanded.
  // Fail closed in each direction:
  //  - a wildcard EXCLUSION cannot be honoured, and dropping just the entry
  //    would over-apply the rule on the excluded sites → drop the rule;
  //  - a wildcard POSITIVE entry is dropped (narrower); if none remain the
  //    rule would become unscoped (broader) → drop the rule.
  if (options.excludedInitiatorDomains.some((d) => d.includes('*'))) {
    reportDrop('wildcard-domain-exclusion: ~entity.* in $domain= cannot be expressed in DNR; dropping the rule rather than shipping it over-applied', pattern);
    return null;
  }
  let initiatorDomains = options.initiatorDomains;
  if (initiatorDomains.some((d) => d.includes('*'))) {
    initiatorDomains = initiatorDomains.filter((d) => !d.includes('*'));
    if (initiatorDomains.length === 0) {
      reportDrop('wildcard-domain-only: entity.* is invalid as a DNR initiatorDomain and no PSL entity expansion is available', pattern);
      return null;
    }
  }

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
    if (regexFilter.length > 256) {
      reportDrop(`regex: source length ${regexFilter.length} > 256 (Chrome RE2 2KB program budget)`, pattern);
      return null;
    }

    // Check for nested/adjacent quantifiers (exponential backtracking risk)
    const nestedQuantCheck = detectNestedQuantifiers(regexFilter);
    if (!nestedQuantCheck.safe) {
      reportDrop(`regex: ${nestedQuantCheck.pattern} — exponential backtracking risk`, pattern);
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

    const nfaCost = estimateRegexNfaCost(regexFilter);
    if (nfaCost > 500) {
      reportDrop(`regex: estimated NFA cost ${nfaCost} > 500 instructions (exceeds Chrome 2KB RE2 budget)`, pattern);
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

  // ABP/uBO filters are case-insensitive unless $match-case; DNR's historical
  // default was case-SENSITIVE (Chrome <118), so EasyList's `/adframe.` never
  // matched `.../AdFrame.js`. State it explicitly in both directions rather
  // than relying on the version-dependent default.
  condition.isUrlFilterCaseSensitive = options.matchCase === true;

  if (options.resourceTypes.length > 0) {
    condition.resourceTypes = options.resourceTypes;
  } else if (conversionOptions.coverDocuments && !exception) {
    // A DNR condition with no resourceTypes matches every type EXCEPT
    // main_frame. For a malicious-URL list that silently removes the one case
    // that matters — the user navigating to the URL — so pin the full set.
    // Only applies where the filter author named no type of their own.
    condition.resourceTypes = [...SECURITY_LIST_RESOURCE_TYPES];
  }
  if (options.excludedResourceTypes.length > 0) {
    condition.excludedResourceTypes = options.excludedResourceTypes;
  }
  if (initiatorDomains.length > 0) {
    condition.initiatorDomains = initiatorDomains;
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

  // uBO ordering: a plain exception beats a plain block, but an $important
  // block beats that exception — overriding exceptions is the whole point of
  // $important, and the anti-circumvention lists depend on it. The previous
  // scheme (block 1, important 2, exception 3) let the exception always win,
  // so $important was inert. `allowAllRequests` from the user allowlist sits
  // far above all of these at priority 500, and system-unbreak at 1000.
  // $redirect= stubs sit one band above the blocks of the same importance so
  // a co-matching block cannot defeat them (see DNR_PRIORITY); $removeparam
  // stays in the block band so a co-matching block wins the tie.
  let rulePriority;
  if (exception) {
    rulePriority = options.important ? DNR_PRIORITY.IMPORTANT_ALLOW : DNR_PRIORITY.ALLOW;
  } else if (options.redirect) {
    rulePriority = options.important ? DNR_PRIORITY.IMPORTANT_REDIRECT : DNR_PRIORITY.REDIRECT;
  } else {
    rulePriority = options.important ? DNR_PRIORITY.IMPORTANT_BLOCK : DNR_PRIORITY.BLOCK;
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

  // No percent-decoding. Chrome matches urlFilter against the canonicalized
  // URL, which is still percent-encoded, so decoding produced filters
  // containing literal spaces that could never match — and turned valid ASCII
  // patterns like %D0%B0 into non-ASCII, which the guard below then dropped.

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
 * Canonical form of a parsed network filter for $badfilter matching.
 *
 * ABP semantics: `X$badfilter` cancels the filter whose text is `X` (with the
 * badfilter option removed). Matching is done on the parsed, normalised form
 * rather than raw text so option order and `domain=` list order do not defeat
 * the comparison. The badfilter flag itself is deliberately excluded.
 */
function canonicalNetworkKey(parsed) {
  const o = parsed.options;
  return JSON.stringify({
    p: parsed.pattern,
    e: !!parsed.exception,
    rt: [...o.resourceTypes].sort(),
    ert: [...o.excludedResourceTypes].sort(),
    id: [...o.initiatorDomains].sort(),
    eid: [...o.excludedInitiatorDomains].sort(),
    rd: [...o.requestDomains].sort(),
    tp: o.thirdParty,
    r: o.redirect,
    rp: o.removeparam,
    imp: !!o.important,
    mc: o.matchCase === true,
    pop: o.popup === true,
  });
}

/**
 * Two-pass $badfilter suppression (prior review 4.1).
 *
 * Pass 1 collects the canonical forms of every `$badfilter` rule; pass 2
 * suppresses base rules whose canonical form matches. This replaces the
 * fail-closed interim behaviour (dropping `$badfilter` lines as unsupported),
 * which kept the badfilter itself from shipping as a block but left the rule
 * it was written to cancel fully active.
 *
 * Scope note: suppression is per-list — each list is parsed independently, so
 * a $badfilter in list A does not cancel a rule in list B. uBO applies it
 * corpus-wide; in practice list authors target their own list's rules.
 */
function applyBadfilterSuppression(networkRules) {
  const badKeys = new Set();
  const baseRules = [];
  for (const rule of networkRules) {
    if (rule.options?.badfilter) badKeys.add(canonicalNetworkKey(rule));
    else baseRules.push(rule);
  }
  if (badKeys.size === 0) return { rules: baseRules, suppressed: [] };

  const kept = [];
  const suppressed = [];
  for (const rule of baseRules) {
    if (badKeys.has(canonicalNetworkKey(rule))) suppressed.push(rule);
    else kept.push(rule);
  }
  return { rules: kept, suppressed };
}

/**
 * Parse a complete filter list text into categorized rule sets.
 * Also collects full skip records: every non-blank/non-comment line
 * that parseLine rejects is recorded with the reason.
 */
function parseFilterList(text) {
  const networkRules = [];
  const cosmeticRules = [];
  const cosmeticExceptions = [];
  const genericCosmeticExceptionDomains = [];
  const scriptletRules = [];
  const scriptletExceptions = [];
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
    } else if (parsed.type === 'cosmetic-scope-exception') {
      if (parsed.scopes.includes('generichide') || parsed.scopes.includes('elemhide')) {
        genericCosmeticExceptionDomains.push(...parsed.domains);
      }
    } else if (parsed.type === 'cosmetic') {
      if (parsed.exception) cosmeticExceptions.push(parsed);
      else cosmeticRules.push(parsed);
    } else if (parsed.type === 'scriptlet') {
      scriptletRules.push(parsed);
    } else if (parsed.type === 'scriptlet-exception') {
      scriptletExceptions.push(parsed);
    }
  }

  // Two-pass $badfilter suppression: badfilter rules never ship, and the base
  // rules they cancel are removed with a skip record for the log.
  const { rules: survivingNetworkRules, suppressed } = applyBadfilterSuppression(networkRules);
  for (const rule of suppressed) {
    skippedRecords.push({
      reason: 'badfilter-suppressed: cancelled by a matching $badfilter rule in this list',
      line: rule.pattern,
    });
  }

  return {
    networkRules: survivingNetworkRules,
    cosmeticRules,
    cosmeticExceptions,
    genericCosmeticExceptionDomains: dedupeDomains(genericCosmeticExceptionDomains),
    scriptletRules,
    scriptletExceptions,
    skippedRecords,
  };
}

/** Action types that carve an exception out of some other rule. */
const EXCEPTION_ACTION_TYPES = new Set(['allow', 'allowAllRequests']);

/**
 * Order rules so that every enabled prefix of shards is self-consistent.
 *
 * Filter lists put their `@@` exceptions after the blocks those exceptions
 * carve out of, and sharding slices in array order — so all 578 EasyList
 * exceptions landed in easylist_3.json, which the manifest ships disabled.
 * Whenever only the leading shards were enabled (fresh install before
 * applyRulesets completes, or the budget-constrained fallback path), the
 * result was 50,000 live block rules with none of their false-positive
 * escapes.
 *
 * Exceptions are a tiny fraction of any list, so hoisting them costs nothing.
 * Partitioning rather than sorting keeps the operation stable, which keeps
 * builds deterministic.
 */
function orderRulesForSharding(dnrRules) {
  const exceptions = [];
  const rest = [];
  for (const rule of dnrRules) {
    (EXCEPTION_ACTION_TYPES.has(rule.action?.type) ? exceptions : rest).push(rule);
  }
  return [...exceptions, ...rest];
}

/**
 * Convert parsed network rules to DNR rules, deduplicate, and return.
 * Populates `droppedRecords` with every rejection + dedup drop.
 */
function buildDNRRules(networkRules, conversionOptions = {}) {
  const dnrRules = [];
  const seen = new Set();
  const droppedRecords = [];

  const prevSink = _currentDropSink;
  _currentDropSink = droppedRecords;

  try {
    for (const parsed of networkRules) {
      const rule = networkFilterToDNR(parsed, conversionOptions);
      if (!rule) continue;

      // The key must include priority and the FULL action payload. Keying on
      // action.type alone collapsed `$removeparam=utm_source` with
      // `$removeparam=utm_medium` (both `redirect`), so only the first
      // parameter was ever stripped; omitting priority collapsed `||y.com^`
      // with `||y.com^$important`, silently discarding the important flag.
      const key = JSON.stringify({
        uf: rule.condition.urlFilter || rule.condition.regexFilter,
        rt: rule.condition.resourceTypes,
        et: rule.condition.excludedResourceTypes,
        id: rule.condition.initiatorDomains,
        eid: rule.condition.excludedInitiatorDomains,
        rd: rule.condition.requestDomains,
        dt: rule.condition.domainType,
        cs: rule.condition.isUrlFilterCaseSensitive,
        p: rule.priority,
        a: rule.action,
      });
      if (seen.has(key)) {
        droppedRecords.push({ reason: 'dedup: duplicate of another DNR rule (same condition+priority+action)', pattern: parsed.pattern });
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
  const sourceCosmetic = {
    generic: [],
    domainSpecific: {},
    exceptions: {},
    genericExcludedDomains: dedupeDomains(parsed.genericCosmeticExceptionDomains),
  };
  const addException = (domain, selector) => {
    if (!sourceCosmetic.exceptions[domain]) sourceCosmetic.exceptions[domain] = [];
    sourceCosmetic.exceptions[domain].push(selector);
  };

  const cosmeticRules = [...(parsed.cosmeticRules || []), ...(parsed.cosmeticExceptions || [])];
  for (const r of cosmeticRules) {
    // A `~domain` exclusion becomes an exception entry for that domain. Lookup
    // already collects exceptions across the ancestor walk and subtracts them,
    // which is exactly what an exclusion means — and it needs no new field in
    // the bundle, the IndexedDB schema, the WASM serializer or the content
    // engine. Without this, hoisting `~` out of `domains` would make a
    // pure-negation rule apply everywhere *including* the excluded site.
    const excluded = r.excludedDomains || [];

    if (r.domains.length === 0) {
      if (r.exception) continue;
      sourceCosmetic.generic.push(r.selector);
      // "everywhere except these".
      for (const d of excluded) addException(d, r.selector);
    } else {
      for (const d of r.domains) {
        if (shouldSkipDomainCosmeticSelector(d, r.selector)) continue;
        if (r.exception) {
          addException(d, r.selector);
        } else {
          if (!sourceCosmetic.domainSpecific[d]) sourceCosmetic.domainSpecific[d] = [];
          sourceCosmetic.domainSpecific[d].push(r.selector);
        }
      }
      // Scoped rules carry their exclusions too: the lookup walk reaches the
      // excluded subdomain through its parent, so the exception cancels it.
      if (!r.exception) {
        for (const d of excluded) addException(d, r.selector);
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
    scriptlets: applyScriptletExceptions(sourceScriptlets, parsed.scriptletExceptions),
  };
}

function createEmptySourceBundle() {
  return {
    cosmetic: { generic: [], domainSpecific: {}, exceptions: {}, genericExcludedDomains: [] },
    scriptlets: [],
  };
}

function mergeParsedCosmeticScopeExceptions(sourceBundle, parsed) {
  const cosmetic = sourceBundle?.cosmetic;
  if (!cosmetic) return sourceBundle;
  cosmetic.genericExcludedDomains = dedupeDomains([
    ...(cosmetic.genericExcludedDomains || []),
    ...(parsed.genericCosmeticExceptionDomains || []),
  ]);
  return sourceBundle;
}

function pruneDeniedCosmeticSelectors(sourceBundle) {
  const cosmetic = sourceBundle?.cosmetic;
  if (!cosmetic) return sourceBundle;

  for (const bucketName of ['domainSpecific', 'exceptions']) {
    const bucket = cosmetic[bucketName] || {};
    for (const [domain, selectors] of Object.entries(bucket)) {
      bucket[domain] = (selectors || [])
        .filter((selector) => !shouldSkipDomainCosmeticSelector(domain, selector));
      if (bucket[domain].length === 0) delete bucket[domain];
    }
  }

  return sourceBundle;
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
function writeSkipLog(listId, { parseSkips, dnrDrops, truncatedCount }, outDir = RULES_DIR) {
  const skipLogDir = path.join(outDir, 'skipped');
  fs.mkdirSync(skipLogDir, { recursive: true });
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

  const outPath = path.join(skipLogDir, `${listId}.log`);
  fs.writeFileSync(outPath, lines.join('\n'));
}

function printSkipSummary(listId, parseSkips, dnrDrops, truncatedCount) {
  if (parseSkips.length === 0 && dnrDrops.length === 0 && truncatedCount === 0) return;
  log(`   📝 Skip summary for ${listId} (full log: rules/skipped/${listId}.log)`);
}

/**
 * Atomically-ish promote a fully-staged build into rules/.
 *
 * The build used to wipe rules/ up front and write into it as it went, so one
 * flaky CDN removed the previously-good rulesets and threw before writing new
 * ones — instantly breaking any loaded developer extension (Chrome silently
 * ignores missing static rulesets). Everything is now written to a staging
 * directory first; only after every list has fetched, parsed, compiled and
 * passed budget verification does this swap run. A failed build leaves
 * rules/ exactly as it was.
 */
function commitStagedRules(stagingDir, targetDir = RULES_DIR) {
  fs.mkdirSync(targetDir, { recursive: true });

  const generatedFiles = new Set([
    ...collectExpectedRulesetFiles(),
    'ruleset-counts.json',
    'cosmetic-rules.json',
    'scriptlet-rules.json',
    'filter-sources.json',
  ]);

  const stagedFiles = fs.readdirSync(stagingDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  const stagedSet = new Set(stagedFiles);

  // Remove stale generated files this build did not regenerate, so a
  // shrinking output set leaves no phantom shards behind. Hand-maintained
  // files (system-unbreak.json) are never touched.
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === 'system-unbreak.json') continue;
    if (!generatedFiles.has(entry.name)) continue;
    if (stagedSet.has(entry.name)) continue;
    fs.rmSync(path.join(targetDir, entry.name), { force: true });
  }

  for (const name of stagedFiles) {
    fs.renameSync(path.join(stagingDir, name), path.join(targetDir, name));
  }

  // Skip logs: replace wholesale so a shrinking skip set doesn't leave
  // phantom entries behind from a previous build.
  const stagedSkipDir = path.join(stagingDir, 'skipped');
  if (fs.existsSync(stagedSkipDir)) {
    const targetSkipDir = path.join(targetDir, 'skipped');
    fs.mkdirSync(targetSkipDir, { recursive: true });
    for (const entry of fs.readdirSync(targetSkipDir)) {
      if (entry.endsWith('.log')) fs.rmSync(path.join(targetSkipDir, entry), { force: true });
    }
    for (const entry of fs.readdirSync(stagedSkipDir)) {
      fs.renameSync(path.join(stagedSkipDir, entry), path.join(targetSkipDir, entry));
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
  log(`✅ manifest rule_resources verified (${resources.length} paths)`);
}

// Chrome MV3 DNR static-ruleset limits. Sourced from
// https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#property-MAX_NUMBER_OF_STATIC_RULES_PER_RULESET
// These are absolute caps; exceeding them causes the entire ruleset to be
// silently rejected on extension load. Assert at build time so we fail the
// CI build instead of shipping a broken extension.
const DNR_LIMITS = {
  RULES_PER_RULESET: 30000,
  REGEX_RULES_PER_RULESET: 1000,
  GUARANTEED_MINIMUM_ENABLED: 30000,
};

function verifyDnrBudget(rulesDirOverride = null) {
  const manifestPath = path.resolve(__dirname, '../manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const resources = manifest?.declarative_net_request?.rule_resources || [];
  const projectRoot = path.resolve(__dirname, '..');

  // Hard violations cause a build failure — these are absolute Chrome caps
  // that, when exceeded, result in silent ruleset rejection at install.
  const hardViolations = [];
  // Soft warnings are surfaced but do not fail the build. The enabled-sum
  // exceeding GUARANTEED_MINIMUM_STATIC_RULES is informational: the guarantee
  // is a floor every extension receives unconditionally, not a ceiling. The
  // actual ceiling is GLOBAL_STATIC_RULE_LIMIT (reported at runtime via
  // chrome.declarativeNetRequest.getAvailableStaticRuleCount()), which on
  // current Chrome is high enough that extensions routinely ship enabled-sum
  // well above the guaranteed minimum without issue.
  const warnings = [];
  let enabledSum = 0;
  let enabledRegexSum = 0;
  const lines = [];

  for (const entry of resources) {
    let abs = path.resolve(projectRoot, entry.path);
    // When verifying a staged (not yet committed) build, prefer the staged
    // copy of each ruleset; hand-maintained files fall back to the repo copy.
    if (rulesDirOverride) {
      const staged = path.join(rulesDirOverride, path.basename(entry.path));
      if (fs.existsSync(staged)) abs = staged;
    }
    let rules = [];
    try {
      rules = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (!Array.isArray(rules)) rules = [];
    } catch {
      // verifyManifestRuleResourcePaths already covers missing files; skip
      continue;
    }
    const regexCount = rules.filter((r) => r?.condition?.regexFilter).length;
    if (rules.length > DNR_LIMITS.RULES_PER_RULESET) {
      hardViolations.push(
        `  - ${entry.id}: ${rules.length} rules > ${DNR_LIMITS.RULES_PER_RULESET} per-ruleset cap`
      );
    }
    if (regexCount > DNR_LIMITS.REGEX_RULES_PER_RULESET) {
      hardViolations.push(
        `  - ${entry.id}: ${regexCount} regex rules > ${DNR_LIMITS.REGEX_RULES_PER_RULESET} per-ruleset cap`
      );
    }
    if (entry.enabled) {
      enabledSum += rules.length;
      enabledRegexSum += regexCount;
    }
    lines.push(`     ${entry.enabled ? '●' : '○'} ${entry.id.padEnd(24)} ${String(rules.length).padStart(6)} rules / ${String(regexCount).padStart(4)} regex`);
  }

  if (enabledSum > DNR_LIMITS.GUARANTEED_MINIMUM_ENABLED) {
    warnings.push(
      `enabled-by-default sum (${enabledSum}) exceeds GUARANTEED_MINIMUM_STATIC_RULES (${DNR_LIMITS.GUARANTEED_MINIMUM_ENABLED}). ` +
      `On a constrained Chrome profile (no global pool headroom), some rulesets may be silently dropped. ` +
      `Run chrome.declarativeNetRequest.getAvailableStaticRuleCount() in the SW inspector to confirm headroom on target machines.`
    );
  }

  log('\n📊 DNR rule budget:');
  for (const line of lines) log(line);
  log(`     ─ enabled-by-default total: ${enabledSum} rules / ${enabledRegexSum} regex (per-ruleset caps: ${DNR_LIMITS.RULES_PER_RULESET} / ${DNR_LIMITS.REGEX_RULES_PER_RULESET})`);

  if (hardViolations.length > 0) {
    throw new Error(
      `DNR budget violations detected — Chrome will silently drop these rulesets at install:\n${hardViolations.join('\n')}\n` +
      `Fix by sharding into more files or tightening per-list limits in LIST_CONFIG.`
    );
  }
  for (const w of warnings) log(`⚠️  ${w}`);
  log('✅ DNR per-ruleset budget verified');
}

function writeBuildOutputs({ rulesetOutputs, cosmeticRules, scriptletRules, filterSources }, outDir = RULES_DIR) {
  fs.mkdirSync(outDir, { recursive: true });

  // Per-ruleset rule counts — previously hardcoded in service-worker.js and
  // drifted from reality after every filter-list refresh. Emit the actual
  // compiled counts so the SW can load them at runtime instead of guessing.
  const rulesetCounts = {};
  for (const [filename, rules] of Object.entries(rulesetOutputs)) {
    const outPath = path.join(outDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(rules, null, 2));
    log(`✅ ${filename} — ${rules.length} DNR rules written`);
    const rulesetId = filename.replace(/\.json$/, '');
    rulesetCounts[rulesetId] = rules.length;
  }

  // system-unbreak.json is hand-maintained, not generated, but its count
  // belongs in ruleset-counts.json too so the SW never has to guess it.
  try {
    const systemUnbreak = JSON.parse(fs.readFileSync(path.join(RULES_DIR, 'system-unbreak.json'), 'utf8'));
    if (Array.isArray(systemUnbreak)) rulesetCounts['system-unbreak'] = systemUnbreak.length;
  } catch { /* optional — absent in exotic layouts */ }

  const countsPath = path.join(outDir, 'ruleset-counts.json');
  fs.writeFileSync(countsPath, JSON.stringify(rulesetCounts, null, 2));
  log(`✅ ruleset-counts.json — ${Object.keys(rulesetCounts).length} entries`);

  const cosmeticsPath = path.join(outDir, 'cosmetic-rules.json');
  fs.writeFileSync(cosmeticsPath, JSON.stringify(cosmeticRules, null, 2));
  log(`\n✅ cosmetic-rules.json — ${cosmeticRules.generic.length} generic + ${Object.keys(cosmeticRules.domainSpecific).length} domain-specific`);

  const scriptletsPath = path.join(outDir, 'scriptlet-rules.json');
  fs.writeFileSync(scriptletsPath, JSON.stringify(scriptletRules, null, 2));
  log(`✅ scriptlet-rules.json — ${scriptletRules.length} rules`);

  const filterSourcesPath = path.join(outDir, 'filter-sources.json');
  fs.writeFileSync(filterSourcesPath, JSON.stringify(filterSources, null, 2));
  log(`✅ filter-sources.json — ${Object.keys(filterSources).length} list sources`);
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

function writeSampleOutputs(outDir = RULES_DIR) {
  log('🧪 Generating sample rule artifacts (offline mode)...\n');

  writeBuildOutputs({
    rulesetOutputs: buildSampleRulesetOutputs(),
    cosmeticRules: generateSampleCosmeticRules(),
    scriptletRules: generateSampleScriptletRules(),
    filterSources: buildSampleFilterSources(),
  }, outDir);

  log('\n🎉 Sample build complete!');
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
    genericExcludedDomains: [],
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
  log(`   🔍 After early dedup: ${networkRules.length} rules`);

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

  const domainSetFor = (rule) => {
    const domains = rule.options?.initiatorDomains || [];
    const reqDomains = rule.options?.requestDomains || [];
    if (domains.length === 0 && reqDomains.length === 0) return null;
    return new Set([...domains, ...reqDomains]);
  };

  const broaderCoversNarrower = (broaderTypes, narrowerTypes) => {
    // Broader has no resourceTypes constraint → matches all types → always covers.
    if (broaderTypes === null) return true;
    // Narrower has no constraint but broader does → broader is NOT a superset.
    if (narrowerTypes === null) return false;
    for (const t of narrowerTypes) if (!broaderTypes.has(t)) return false;
    return true;
  };

  const broaderDomainsCoverNarrower = (broaderDomains, narrowerDomains) => {
    // Broader has no domain restriction → covers everything.
    if (broaderDomains === null) return true;
    // Narrower has no restriction but broader does → broader does NOT cover.
    if (narrowerDomains === null) return false;
    for (const d of narrowerDomains) if (!broaderDomains.has(d)) return false;
    return true;
  };

  for (const r of networkRules) {
    if (selected.length >= limit) break;

    const isDomainOnly = /^\|\|([^/*?^]+)\^?$/.exec(r.pattern);
    if (isDomainOnly && !r.exception) {
      const existing = dominantDomains.get(isDomainOnly[1]);
      const incomingTypes = typeSetFor(r);
      const incomingDomains = domainSetFor(r);
      // Track the broadest rule per domain — null wins for each dimension.
      if (!existing) {
        dominantDomains.set(isDomainOnly[1], {
          types: incomingTypes === null ? null : new Set(incomingTypes),
          domains: incomingDomains === null ? null : new Set(incomingDomains),
        });
      } else {
        if (incomingTypes === null) {
          existing.types = null;
        } else if (existing.types !== null) {
          for (const t of incomingTypes) existing.types.add(t);
        }
        if (incomingDomains === null) {
          existing.domains = null;
        } else if (existing.domains !== null) {
          for (const d of incomingDomains) existing.domains.add(d);
        }
      }
      selected.push(r);
      continue;
    }

    if (!r.exception && r.pattern.startsWith('||')) {
      const domainMatch = /^\|\|([^/*?^]+)/.exec(r.pattern);
      if (domainMatch && dominantDomains.has(domainMatch[1])) {
        const broaderEntry = dominantDomains.get(domainMatch[1]);
        const broaderTypes = broaderEntry.types;
        const broaderDomains = broaderEntry.domains;
        const narrowerTypes = typeSetFor(r);
        const narrowerDomains = domainSetFor(r);
        if (broaderCoversNarrower(broaderTypes, narrowerTypes) &&
            broaderDomainsCoverNarrower(broaderDomains, narrowerDomains)) {
          continue;
        }
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

  // Stage everything into a sibling temp dir and swap only on success — a
  // failed fetch/parse/verify leaves the previous good rules/ untouched
  // (§5.48). Same parent dir so renameSync never crosses a filesystem.
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(RULES_DIR), '.rules-staging-'));

  try {
    if (SAMPLE_MODE) {
      writeSampleOutputs(stagingDir);
      commitStagedRules(stagingDir);
      verifyManifestRuleResourcePaths();
      return;
    }

    await buildFromNetwork(stagingDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function buildFromNetwork(stagingDir) {
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

  log('📡 Downloading filter lists...\n');

  for (const list of FILTER_LISTS) {
    try {
      log(`⬇️  Fetching ${list.description}...`);
      const text = await fetchAndExpand(list.url);

      // SRI over the FULLY-EXPANDED text: includes carry most uBO content,
      // so hashing only the top-level file would verify almost nothing.
      const verification = verifySriHash(text, list.id);
      if (!verification.valid) {
        throw new Error(`[SRI] ${verification.error}`);
      } else if (verification.skipped) {
        console.warn(`[SRI] ${list.id}: verification skipped via --skip-sri flag`);
      } else {
        log(`[SRI] ${list.id}: hash verified`);
      }

      const parsed = parseFilterList(text, list.id);

      log(`   Parsed: ${parsed.networkRules.length} network, ${parsed.cosmeticRules.length} cosmetic, ${parsed.scriptletRules.length} scriptlets, ${parsed.skippedRecords.length} skipped`);
      const config = LIST_CONFIG[list.id] || { parts: 1, totalLimit: MAX_PER_FILE };
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
      sourceBundle = mergeParsedCosmeticScopeExceptions(sourceBundle, parsed);
      sourceBundle = pruneDeniedCosmeticSelectors(sourceBundle);

      // Clamp the configured limit to what the shards can physically hold —
      // a totalLimit above parts*MAX_PER_FILE used to let up to 5,000 rules
      // vanish at the shard writer with no skip-log record (§5.47).
      const limit = effectiveListLimit(config);
      if ((config.totalLimit ?? limit) > limit) {
        console.warn(`   ⚠️  ${list.id}: totalLimit ${config.totalLimit} exceeds shard capacity ${limit} (${config.parts || 1} × ${MAX_PER_FILE}); using ${limit}`);
      }

      let truncatedCount = 0;
      if (networkRules.length > limit) {
        const before = networkRules.length;
        log(`   ⚠️  Rule count (${before}) exceeds limit for ${list.id}. Applying smart selection to ${limit}...`);
        networkRules = smartTruncate(networkRules, limit);
        truncatedCount = before - networkRules.length;
        log(`   ✂️  Smart selection: ${networkRules.length} rules kept (${truncatedCount} trimmed by smartTruncate)`);
      }

      const { dnrRules, droppedRecords } = buildDNRRules(networkRules, {
        coverDocuments: SECURITY_LIST_IDS.has(list.id),
      });

      // A security list that cannot block a navigation is not doing its job.
      // Fail the build rather than shipping one silently, the way the malware
      // ruleset shipped 5,888 rules that could only match subresources.
      if (SECURITY_LIST_IDS.has(list.id) && dnrRules.length > 0) {
        const blocksNavigation = dnrRules.some((r) =>
          r.action.type === 'block' && r.condition.resourceTypes?.includes('main_frame'));
        if (!blocksNavigation) {
          throw new Error(
            `${list.id}: security ruleset has ${dnrRules.length} rules but none block main_frame — ` +
            'navigations to listed malicious URLs would not be stopped');
        }
      }

      // Split and stage rules for a single final write. Exceptions first —
      // see orderRulesForSharding.
      const shardable = orderRulesForSharding(dnrRules);

      // Belt and braces for §5.47: anything beyond shard capacity would
      // vanish at the writer, so record it rather than losing it silently.
      // (Unreachable while the pre-conversion clamp above holds.)
      const capacityOverflow = Math.max(0, shardable.length - (config.parts || 1) * MAX_PER_FILE);
      if (capacityOverflow > 0) {
        console.warn(`   ⚠️  ${list.id}: ${capacityOverflow} rules exceed shard capacity and will be dropped`);
      }

      writeSkipLog(list.id, {
        parseSkips: parsed.skippedRecords,
        dnrDrops: droppedRecords,
        truncatedCount: truncatedCount + capacityOverflow,
      }, stagingDir);
      printSkipSummary(list.id, parsed.skippedRecords, droppedRecords, truncatedCount);

      for (let i = 0; i < config.parts; i++) {
        const chunk = shardable.slice(i * MAX_PER_FILE, (i + 1) * MAX_PER_FILE);
        const suffix = i === 0 ? '' : `_${i + 1}`;
        rulesetOutputs[`${list.id}${suffix}.json`] = chunk;
        log(`✅ ${list.id}${suffix}.json — ${chunk.length} DNR rules staged`);
      }
      log('');

      filterSources[list.id] = sourceBundle;

      // Merge cosmetic/scriptlet rules
      for (const selector of sourceBundle.cosmetic?.generic || []) {
        allCosmeticRules.generic.push(selector);
      }
      for (const [domain, selectors] of Object.entries(sourceBundle.cosmetic?.domainSpecific || {})) {
        if (!allCosmeticRules.domainSpecific[domain]) allCosmeticRules.domainSpecific[domain] = [];
        allCosmeticRules.domainSpecific[domain].push(...selectors);
      }
      if (!allCosmeticRules.genericExcludedDomains) allCosmeticRules.genericExcludedDomains = [];
      allCosmeticRules.genericExcludedDomains.push(...(sourceBundle.cosmetic?.genericExcludedDomains || []));
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
  allCosmeticRules.genericExcludedDomains = dedupeDomains(allCosmeticRules.genericExcludedDomains);

  writeBuildOutputs({
    rulesetOutputs,
    cosmeticRules: allCosmeticRules,
    scriptletRules: allScriptletRules,
    filterSources,
  }, stagingDir);

  // Verify the STAGED build before promoting it; only a build that passes
  // budget checks ever replaces the previous good rules/.
  verifyDnrBudget(stagingDir);
  commitStagedRules(stagingDir);
  verifyManifestRuleResourcePaths();

  log('\n🎉 Build complete!');
}

export {
  parseLine,
  networkFilterToDNR,
  buildSourceBundleFallback,
  orderRulesForSharding,
  parseFilterList,
  applyBadfilterSuppression,
  buildDNRRules,
  verifySriHash,
  fetchAndExpand,
  effectiveListLimit,
  commitStagedRules,
  FILTER_LISTS,
  LIST_CONFIG,
  MAX_PER_FILE,
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}
