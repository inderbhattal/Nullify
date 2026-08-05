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
 *   node scripts/build-rules.mjs            # Full build from the vendored snapshots
 *   node scripts/build-rules.mjs --sample   # Offline placeholder artifacts
 *
 * ---------------------------------------------------------------------------
 * DEVELOPER WORKFLOW — where the list text comes from
 * ---------------------------------------------------------------------------
 * This build does NOT touch the network. It compiles the fully-expanded list
 * snapshots committed under `scripts/filter-lists/`, and verifies each one
 * against the committed SRI lock (`scripts/filter-lists.lock.json`) first.
 *
 * To pick up upstream changes:
 *
 *   1. npm run refresh:lists     # fetch + expand upstream, rewrite the
 *                                # snapshots AND the lock together
 *   2. review `git diff scripts/filter-lists/` — this is the only moment
 *      upstream content enters the repo, and it is a reviewable text diff
 *   3. npm run build:rules       # recompile rules/ from the reviewed text
 *   4. commit snapshots + lock
 *
 * Why: the lock used to be verified against a LIVE fetch at build time, so
 * release builds raced upstream rotation — measured, 6 of 8 lists rotated
 * within ~48 h of a lock refresh, and since `rules/*.json` is gitignored every
 * tag build had to recompile from the network. The success window for a
 * release was minutes. Snapshots move that race to refresh time, which is
 * exactly when a human is looking at the diff (§4.6).
 *
 * VOLATILITY — `ubo-quick-fixes` (uAssets quick-fixes.txt) declares
 * `! Expires: 8 hours`, by far the shortest of anything we carry (the rest
 * declare 12 h–4 days and in practice rotate on the order of a day). That list
 * is where uBO lands same-day counter-moves against YouTube and Facebook, so a
 * vendored snapshot of it goes stale within a working day and a fresh
 * counter-move only reaches users on a release.
 *
 * That trade-off is deliberate, not an oversight. Vendoring costs freshness on
 * the STATIC DNR rules; fetching at build time cost releases outright (see
 * above). The mitigations are:
 *   - the cosmetic/scriptlet half of quick-fixes.txt — which is where nearly
 *     all of its YouTube machinery lives — is re-fetched by the service worker
 *     on its own 24 h update alarm (REMOTE_FILTER_LISTS), so users do get those
 *     without a release;
 *   - only the handful of network rules are release-bound;
 *   - `npm run refresh:lists` before a release keeps the snapshot within hours
 *     of upstream.
 * Anyone tempted to "fix" the staleness by reintroducing a build-time fetch
 * should read §4.6 first.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { createHash } from 'crypto';
import { fileURLToPath, domainToASCII } from 'url';
import {
  CORE_FILTER_SOURCE,
  shouldSkipDomainCosmeticSelector,
} from '../src/shared/core-filter-source.js';
import {
  splitDomainList,
  applyScriptletExceptions,
  evaluatePreprocessorCondition,
} from '../src/shared/filter-syntax.js';
import { isPublicSuffix } from '../src/shared/psl.js';

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

// Committed, fully-expanded snapshots of every upstream list. `build:rules`
// compiles from these and never fetches, so a release build cannot lose a race
// with upstream rotation (§4.6); `npm run refresh:lists` is the only thing that
// writes them, and it rewrites the SRI lock in the same pass so the two can
// never disagree.
const VENDORED_LISTS_DIR = path.join(__dirname, 'filter-lists');

function vendoredListPath(listId) {
  return path.join(VENDORED_LISTS_DIR, `${listId}.txt`);
}

function readVendoredList(listId) {
  const file = vendoredListPath(listId);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no vendored snapshot at scripts/filter-lists/${listId}.txt — run ` +
      '`npm run refresh:lists` to fetch upstream, rewrite the snapshots and the ' +
      'SRI lock, then review and commit the diff');
  }
  return fs.readFileSync(file, 'utf8');
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
  // quick-fixes.txt is ~500 lines and almost entirely cosmetic/scriptlet; it
  // has never yielded more than a few dozen DNR rules. A single shard with a
  // deliberately small ceiling keeps the declared budget honest (see the
  // effectiveListLimit note above) — if upstream ever grows it past 5000 the
  // smart-truncate log says so instead of the number quietly meaning nothing.
  'ubo-quick-fixes': { parts: 1, totalLimit: 5000 },
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
  {
    id: 'ubo-quick-fixes',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
    // Where uBO lands its same-day YouTube/Facebook counter-moves — the
    // json-prune-fetch-response / json-prune-xhr-response rules on
    // /youtubei/v1/player, the trusted-json-edit-xhr-request request shaping
    // and the trusted-prevent-dom-bypass counters. None of that is in
    // filters.txt (`ubo-filters`), so without this list we ship none of it.
    // Declares `! Expires: 8 hours` — the most volatile list we carry; see the
    // VOLATILITY note in the file header for why we vendor it anyway.
    description: 'uBO Quick Fixes — same-day YouTube/Facebook counter-moves (Expires: 8 hours)',
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
      error: 'no pinned hash in scripts/filter-lists.lock.json — run `npm run refresh:lists` to rewrite the snapshots and the lock together, review the diff, and commit it',
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
 * Only `npm run refresh:lists` calls this: the build compiles committed
 * snapshots and never fetches. SRI is computed over the RETURN VALUE of the
 * top-level call (the fully-expanded text) — verifying only the top-level
 * fetch let every !#include sub-file bypass verification entirely.
 */
async function fetchAndExpand(url, depth = 0, fetchImpl = fetchText) {
  // Both failure modes below used to fail OPEN (return '' / skip the include),
  // which quietly narrowed the very text the SRI hash covers: a persistent 404
  // on one sub-file is skipped identically when the lock is generated and when
  // the build runs, so a truncated corpus hashes consistently and ships
  // "verified". An on-path attacker who can break one sub-file URL achieves
  // silent content removal despite SRI. Fail closed instead (§5.10).
  if (depth > 5) {
    throw new Error(`!#include nesting deeper than 5 levels at ${url} — refusing to silently truncate the list`);
  }
  const text = await fetchImpl(url);
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
        lines.push(await fetchAndExpand(includeUrl, depth + 1, fetchImpl));
      } catch (e) {
        throw new Error(
          `!#include ${includeUrl} failed: ${e.message} — refusing to build from a ` +
          'truncated list, because the SRI hash would cover the truncation and ship it as verified');
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
// Strips a *matched* surrounding quote pair only. Stripping first and last
// independently mangles an argument that legitimately ends in a quote, such as
// uBO's `trusted-set, document.visibilityState, json:"visible"`.
function finalizeScriptletArg(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === "'" || first === '"') && trimmed[trimmed.length - 1] === first) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

// Must stay behaviourally identical to `parseScriptletArgs` in
// src/shared/filter-parser.js and `parse_scriptlet_args` in
// wasm-core/src/lib.rs — the parity suite asserts it. `\,` is an escaped
// comma that uBO unescapes rather than a separator, and a quote opens quoted
// mode only when a matching close exists later; getting either wrong shreds
// the shipped YouTube rules into the wrong number of arguments.
function parseScriptletArgs(str) {
  const args = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (ch === '\\') {
      if (str[i + 1] === ',') { current += ','; i++; continue; }
      current += '\\';
      continue;
    }

    if (ch === "'" || ch === '"') {
      if (quote === ch) quote = null;
      else if (quote === null && str.indexOf(ch, i + 1) !== -1) quote = ch;
      current += ch;
      continue;
    }

    if (ch === ',' && quote === null) {
      args.push(finalizeScriptletArg(current));
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) args.push(finalizeScriptletArg(current));
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

  // DNR's queryTransform.removeParams takes LITERAL parameter names. uBO's
  // other two forms mean something this pipeline cannot express, and both were
  // being emitted verbatim with dead semantics (§5.30):
  //  - `$removeparam=~keep` means "strip every parameter EXCEPT keep"; the
  //    emitted rule stripped a parameter literally named `~keep`;
  //  - `$removeparam=/re/` matches parameter NAMES by regex; the emitted rule
  //    stripped a parameter literally named `/re/`;
  //  - `$removeparam=` (empty value) means "strip everything", and with no
  //    value the removeparam branch was falsy, so the rule fell through to a
  //    hard BLOCK of the URL — broader than what was written.
  // Dropping what we cannot express is this pipeline's own rule.
  if (options.removeparam !== null) {
    if (options.removeparam === '') {
      return skip('removeparam-all: $removeparam= with no value means "strip every query parameter"; DNR removeParams needs literal names, and the fallthrough emitted a hard block instead');
    }
    if (options.removeparam.startsWith('~')) {
      return skip('removeparam-negation: $removeparam=~x means "strip everything except x" upstream; DNR removeParams can only name the parameters to strip, so the emitted rule stripped a parameter literally called "~x"');
    }
    if (options.removeparam.startsWith('/')) {
      return skip('removeparam-regex: $removeparam=/re/ matches parameter names by regex; DNR removeParams takes literal names only, so the emitted rule stripped a parameter literally called "/re/"');
    }
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
 * Normalise a `$domain=` list into what Chrome accepts for
 * `initiatorDomains` / `excludedInitiatorDomains`: lowercase, ASCII
 * (punycode), no empty entries.
 *
 * Chrome validates these at ruleset INDEXING time and rejects the whole rule
 * — so `$domain=foo.com|` (which parses to `["foo.com", ""]`), a stray
 * `$domain=Example.COM`, or `$domain=bücher.de` costs the entire filter, not
 * just the offending entry. Nothing upstream trips this today; one typo would.
 *
 * Returns `{ domains, unencodable }`. `unencodable` holds entries
 * `domainToASCII` could not encode at all; callers decide whether losing them
 * narrows the rule (fine) or widens it (drop the rule).
 */
function normalizeDomainList(domains) {
  const normalized = [];
  const unencodable = [];
  for (const raw of domains) {
    const trimmed = String(raw ?? '').trim();
    // An empty entry is pure upstream noise — dropping it changes no scope.
    if (trimmed === '') continue;
    const ascii = domainToASCII(trimmed.toLowerCase());
    if (!ascii) {
      unencodable.push(trimmed);
      continue;
    }
    if (!normalized.includes(ascii)) normalized.push(ascii);
  }
  return { domains: normalized, unencodable };
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
 *
 * Everything above these is hand-maintained or runtime:
 *   1000    system-unbreak allows (rules/system-unbreak.json)
 *   1100    system-unbreak blocks that must beat a co-matching 1000 allow
 *   100000  the user allowlist's `allowAllRequests` — above every shipped
 *           rule, so "trust this site" always wins
 * `assertStaticRulePriorityBands` enforces that on every build.
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

  // Normalise what is left to the DNR schema (§5.29), in the same two
  // directions the wildcard handling above uses:
  //  - an EXCLUSION we cannot encode would over-apply the rule → drop it;
  //  - a POSITIVE entry we cannot encode only narrows the rule, but if the
  //    whole positive list empties out the rule becomes unscoped → drop it.
  const normalizedExcluded = normalizeDomainList(options.excludedInitiatorDomains);
  if (normalizedExcluded.unencodable.length > 0) {
    reportDrop(`invalid-domain-exclusion: ~${normalizedExcluded.unencodable[0]} is not encodable as an ASCII domain; dropping the rule rather than shipping it over-applied`, pattern);
    return null;
  }
  const normalizedInitiators = normalizeDomainList(initiatorDomains);
  if (initiatorDomains.length > 0 && normalizedInitiators.domains.length === 0) {
    reportDrop('invalid-domain-only: every $domain= entry is empty or not encodable as an ASCII domain; dropping the rule rather than shipping it unscoped', pattern);
    return null;
  }
  initiatorDomains = normalizedInitiators.domains;
  const excludedInitiatorDomains = normalizedExcluded.domains;

  // `||co.uk^` with no `$domain=` scope is as broad as `||com^`. Checked here
  // rather than in convertPatternToUrlFilter because only this scope knows
  // whether the rule is site-scoped.
  if (initiatorDomains.length === 0 && isUnscopedPublicSuffixAnchor(pattern)) {
    reportDrop('urlFilter: unscoped anchor on a public suffix — would match every domain registered under it', pattern);
    return null;
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
  if (excludedInitiatorDomains.length > 0) {
    condition.excludedInitiatorDomains = excludedInitiatorDomains;
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
  // far above all of these at priority 100000, and system-unbreak at
  // 1000/1100 — see DNR_PRIORITY and assertStaticRulePriorityBands.
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

/**
 * True when the pattern is nothing but an anchor on a MULTI-label public
 * suffix (`||co.uk^`, `||com.br^`).
 *
 * The bare-TLD guard below only catches single labels, and widening it to
 * "anything whose first label is a TLD name" is what dropped 1,907 legitimate
 * filters (§4.3). Callers apply this only to rules that carry no `$domain=`
 * scope: `||cloudfront.net^$domain=a.example|b.example` is a deliberate,
 * narrow rule and there are several live ones, while an UNSCOPED block on a
 * whole public suffix matches every site under it.
 */
function isUnscopedPublicSuffixAnchor(pattern) {
  const m = /^\|\|([^|/*?^:]+)\^?$/.exec(pattern);
  if (!m) return false;
  const host = m[1].toLowerCase().replace(/\.+$/, '');
  return host.includes('.') && isPublicSuffix(host);
}

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
    // Capture the WHOLE host portion, not just its first label. The previous
    // `[^.|/*?^]+` stopped at the first dot, so any pattern whose first
    // SUBDOMAIN label collided with a TLD name (`app`, `dev`, `tv`, `cc`,
    // `co`, `me`, `in`, …) was rejected as "anchors on TLD" despite anchoring
    // on a full multi-label host: 1,907 valid filters on a live corpus,
    // including `||app.adjust.com^`, `||app.link/_r?` and 35 `@@` exceptions
    // — 16 of them in unbreak.txt, so EasyPrivacy's block shipped while the
    // exception written to unbreak it was deleted.
    // A trailing dot is the root-label spelling of the same host, so `||com.`
    // is every bit as broad as `||com^`.
    const hostMatch = /^\|\|([^|/*?^:]+)/.exec(pattern);
    const host = hostMatch ? hostMatch[1].toLowerCase().replace(/\.+$/, '') : '';
    if (host && !host.includes('.') && KNOWN_TLDS.has(host)) {
      reportDrop(`urlFilter: ||${host}^ anchors on a bare TLD — would match every .${host} domain`, original);
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
 * Scope: `badfilterKeys` may be supplied by the caller to suppress against the
 * WHOLE corpus rather than one list. This matters because the primary consumer
 * of the feature targets other lists: unbreak.txt ships 204 `$badfilter`
 * entries, **none** of which match a rule in unbreak.txt itself while 34 exactly
 * match live EasyList/EasyPrivacy rules (`||sumo.com^`, `||exoclick.com^`,
 * `/ga_setup.js`, …). Per-list scope therefore delivered ~0% of the feature to
 * the list that exists to use it. uBO scopes to the enabled lists; corpus-wide
 * is the closest static approximation and errs toward fewer broken sites.
 *
 * Always returns the list's OWN badfilter keys so a two-phase build can union
 * them across lists before the suppressing pass.
 */
function applyBadfilterSuppression(networkRules, badfilterKeys = null) {
  const listBadfilterKeys = new Set();
  const baseRules = [];
  for (const rule of networkRules) {
    if (rule.options?.badfilter) listBadfilterKeys.add(canonicalNetworkKey(rule));
    else baseRules.push(rule);
  }
  const badKeys = badfilterKeys || listBadfilterKeys;
  if (badKeys.size === 0) {
    return { rules: baseRules, suppressed: [], badfilterKeys: listBadfilterKeys };
  }

  const kept = [];
  const suppressed = [];
  for (const rule of baseRules) {
    if (badKeys.has(canonicalNetworkKey(rule))) suppressed.push(rule);
    else kept.push(rule);
  }
  return { rules: kept, suppressed, badfilterKeys: listBadfilterKeys };
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
  // rules they cancel are removed with a skip record for the log. The full
  // build then runs a second, corpus-wide pass over `networkRules` using the
  // union of every list's `badfilterKeys` (see buildFromVendoredLists).
  const {
    rules: survivingNetworkRules,
    suppressed,
    badfilterKeys,
  } = applyBadfilterSuppression(networkRules);
  for (const rule of suppressed) {
    skippedRecords.push({
      reason: 'badfilter-suppressed: cancelled by a matching $badfilter rule in this list',
      line: rule.pattern,
    });
  }

  return {
    networkRules: survivingNetworkRules,
    badfilterKeys,
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
 * Promote a fully-staged build into rules/ with a DIRECTORY-granularity swap.
 *
 * The build used to wipe rules/ up front and write into it as it went, so one
 * flaky CDN removed the previously-good rulesets and threw before writing new
 * ones — instantly breaking any loaded developer extension (Chrome silently
 * ignores missing static rulesets). Everything is now written to a staging
 * directory first; only after every list has parsed, compiled and passed
 * budget verification does this swap run.
 *
 * The swap itself used to be delete-then-rename per file in directory order
 * (§5.27): a crash mid-sequence left rules/ MIXED-GENERATION, which breaks the
 * exceptions-hoisted "every enabled prefix is self-consistent" guarantee and
 * leaves a stale ruleset-counts.json that the service worker's budget fallback
 * trusts. Everything the new generation needs — including hand-maintained
 * files carried over from the target — is assembled inside the staging
 * directory first, so promotion is two renames of whole directories. A crash
 * between them leaves the previous generation intact at `rules.old-*` and no
 * half-swapped rules/ for the SW to trust.
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

  const stagedNames = new Set(fs.readdirSync(stagingDir).map((name) => name));

  // Carry hand-maintained content (system-unbreak.json, anything a human put
  // in rules/) into the staging directory so the swapped-in generation is
  // complete. COPY rather than move: until the rename succeeds the target must
  // remain a valid previous generation. Generated files this build did not
  // regenerate are deliberately not carried, so a shrinking output set leaves
  // no phantom shards behind. `skipped/` is replaced wholesale when the build
  // produced one, and carried over otherwise.
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (stagedNames.has(entry.name)) continue;
    if (entry.isFile() && generatedFiles.has(entry.name)) continue;
    fs.cpSync(path.join(targetDir, entry.name), path.join(stagingDir, entry.name), {
      recursive: true,
    });
  }

  // Keep the directory's own permissions — the staging dir is mkdtemp'd 0700.
  try {
    fs.chmodSync(stagingDir, fs.statSync(targetDir).mode & 0o7777);
  } catch { /* best effort; a mode mismatch must not fail a good build */ }

  const retiredDir = `${targetDir}.old-${process.pid}-${Date.now()}`;
  fs.renameSync(targetDir, retiredDir);
  try {
    fs.renameSync(stagingDir, targetDir);
  } catch (err) {
    // Put the previous generation back rather than leaving no rules/ at all.
    fs.renameSync(retiredDir, targetDir);
    throw err;
  }
  fs.rmSync(retiredDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Priority bands, static vs runtime
// ---------------------------------------------------------------------------

/**
 * Priority the service worker gives its `allowAllRequests` allowlist rules.
 * Must stay in sync with `DNR_ALLOWLIST_PRIORITY` in
 * src/background/service-worker.js — the whole point is that the user's
 * "trust this site" control outranks EVERY shipped rule. It previously sat at
 * 500, below the four hand-maintained system-unbreak blocks at 1100, so
 * allowlisting a DataDome-protected site still blocked `datadome.co` and the
 * CAPTCHA loop persisted with no user-level escape (§4.5).
 */
const RUNTIME_ALLOWLIST_PRIORITY = 100000;

/** Band for hand-maintained system-unbreak rules. */
const SYSTEM_UNBREAK_PRIORITY = 1000;
/**
 * Reserved for a system-unbreak BLOCK that has to beat a co-matching
 * system-unbreak allow at 1000 (`youtubei/v1/ad_break` inside the
 * `youtubei/v1/*` allow). Nothing else may sit here: a block at this priority
 * with no allow to override is just an unreviewable magic number.
 */
const SYSTEM_UNBREAK_OVERRIDE_PRIORITY = 1100;

const ALLOW_ACTION_TYPES = new Set(['allow', 'allowAllRequests']);

/**
 * Assert the priority bands the build documents are actually true on disk.
 *
 * Two invariants:
 *  1. No static rule may carry a priority ≥ the runtime allowlist priority
 *     unless its action is an allow. A static BLOCK up there would silently
 *     override the user allowlist, which is the §4.5 failure.
 *  2. Hand-maintained system-unbreak rules stay inside their documented band,
 *     and the override slot is only used by a block that an allow in the same
 *     file would otherwise permit.
 */
function assertStaticRulePriorityBands(rulesDirOverride = null) {
  const manifestPath = path.resolve(__dirname, '../manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const resources = manifest?.declarative_net_request?.rule_resources || [];
  const projectRoot = path.resolve(__dirname, '..');
  const violations = [];

  for (const entry of resources) {
    let abs = path.resolve(projectRoot, entry.path);
    if (rulesDirOverride) {
      const staged = path.join(rulesDirOverride, path.basename(entry.path));
      if (fs.existsSync(staged)) abs = staged;
    }
    let rules;
    try {
      rules = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      continue; // verifyManifestRuleResourcePaths already covers missing files
    }
    if (!Array.isArray(rules)) continue;

    for (const rule of rules) {
      const priority = rule?.priority ?? 1;
      if (priority >= RUNTIME_ALLOWLIST_PRIORITY && !ALLOW_ACTION_TYPES.has(rule?.action?.type)) {
        violations.push(
          `  - ${entry.id} rule ${rule?.id}: priority ${priority} ≥ runtime allowlist priority ` +
          `${RUNTIME_ALLOWLIST_PRIORITY} with action "${rule?.action?.type}" — it would override the user allowlist`
        );
      }
    }

    if (entry.id !== 'system-unbreak') continue;

    const baseAllows = rules.filter((r) =>
      (r?.priority ?? 1) === SYSTEM_UNBREAK_PRIORITY && ALLOW_ACTION_TYPES.has(r?.action?.type));
    for (const rule of rules) {
      const priority = rule?.priority ?? 1;
      if (priority !== SYSTEM_UNBREAK_PRIORITY && priority !== SYSTEM_UNBREAK_OVERRIDE_PRIORITY) {
        violations.push(
          `  - system-unbreak rule ${rule?.id}: priority ${priority} is outside the documented band ` +
          `(${SYSTEM_UNBREAK_PRIORITY} = system-unbreak, ${SYSTEM_UNBREAK_OVERRIDE_PRIORITY} = override a co-matching allow)`
        );
        continue;
      }
      if (priority !== SYSTEM_UNBREAK_OVERRIDE_PRIORITY) continue;
      const urlFilter = rule?.condition?.urlFilter || '';
      const overridesAnAllow = baseAllows.some((allow) => {
        const allowFilter = (allow?.condition?.urlFilter || '').replace(/\*+$/, '');
        return allowFilter.length > 0 && urlFilter.startsWith(allowFilter);
      });
      if (!overridesAnAllow) {
        violations.push(
          `  - system-unbreak rule ${rule?.id} (${urlFilter}): priority ${SYSTEM_UNBREAK_OVERRIDE_PRIORITY} is reserved for blocks ` +
          `that must beat a co-matching allow at ${SYSTEM_UNBREAK_PRIORITY}; use ${SYSTEM_UNBREAK_PRIORITY}`
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Static rule priority band violations:\n${violations.join('\n')}\n` +
      `Static rules live in ${DNR_PRIORITY.BLOCK}–${DNR_PRIORITY.IMPORTANT_ALLOW}, system-unbreak in ` +
      `${SYSTEM_UNBREAK_PRIORITY}–${SYSTEM_UNBREAK_OVERRIDE_PRIORITY}, and the runtime allowlist at ` +
      `${RUNTIME_ALLOWLIST_PRIORITY} above everything.`
    );
  }
  log(`✅ static rule priority bands verified (runtime allowlist reserved at ${RUNTIME_ALLOWLIST_PRIORITY})`);
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
      assertStaticRulePriorityBands(stagingDir);
      commitStagedRules(stagingDir);
      verifyManifestRuleResourcePaths();
      return;
    }

    await buildFromVendoredLists(stagingDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function buildFromVendoredLists(stagingDir) {
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

  // -------------------------------------------------------------------------
  // Phase 1 — load, verify and parse every list.
  //
  // Nothing is compiled yet: `$badfilter` has to be resolved across the whole
  // corpus before any list is converted (§4.4), because the list that actually
  // uses the feature (unbreak.txt) writes its badfilters against OTHER lists'
  // rules. Parsing all eight first is also what makes the build deterministic
  // — the text comes from committed snapshots, not the network (§4.6).
  // -------------------------------------------------------------------------
  log('📂 Loading vendored filter lists...\n');

  const loadedLists = [];
  for (const list of FILTER_LISTS) {
    try {
      const text = readVendoredList(list.id);

      // SRI over the FULLY-EXPANDED text: includes carry most uBO content,
      // so hashing only the top-level file would verify almost nothing. The
      // hash now certifies that the committed snapshot is the text that was
      // reviewed when the lock was refreshed.
      const verification = verifySriHash(text, list.id);
      if (!verification.valid) {
        throw new Error(`[SRI] ${verification.error}`);
      } else if (verification.skipped) {
        console.warn(`[SRI] ${list.id}: verification skipped via --skip-sri flag`);
      } else {
        log(`[SRI] ${list.id}: snapshot verified`);
      }

      const parsed = parseFilterList(text);
      log(`   Parsed ${list.id}: ${parsed.networkRules.length} network, ${parsed.cosmeticRules.length} cosmetic, ${parsed.scriptletRules.length} scriptlets, ${parsed.skippedRecords.length} skipped`);
      loadedLists.push({ list, text, parsed });
    } catch (err) {
      failures.push(list.id);
      console.error(`❌ Failed to load ${list.id}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to load filter lists: ${failures.join(', ')}`);
  }

  const corpusBadfilterKeys = new Set();
  for (const { parsed } of loadedLists) {
    for (const key of parsed.badfilterKeys) corpusBadfilterKeys.add(key);
  }
  log(`\n🚫 ${corpusBadfilterKeys.size} distinct $badfilter directives collected corpus-wide\n`);

  // -------------------------------------------------------------------------
  // Phase 2 — suppress corpus-wide, then compile each list.
  // -------------------------------------------------------------------------
  for (const { list, text, parsed } of loadedLists) {
    try {
      const config = LIST_CONFIG[list.id] || { parts: 1, totalLimit: MAX_PER_FILE };

      // Phase-1 already removed what this list's own badfilters cancel; this
      // pass removes what every OTHER list's badfilters cancel.
      const { rules: unsuppressed, suppressed: crossListSuppressed } =
        applyBadfilterSuppression(parsed.networkRules, corpusBadfilterKeys);
      for (const rule of crossListSuppressed) {
        parsed.skippedRecords.push({
          reason: 'badfilter-suppressed-cross-list: cancelled by a matching $badfilter rule in another shipped list',
          line: rule.pattern,
        });
      }
      if (crossListSuppressed.length > 0) {
        log(`   🚫 ${list.id}: ${crossListSuppressed.length} rules cancelled by another list's $badfilter`);
      }
      let networkRules = unsuppressed;
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
    throw new Error(`Failed to compile filter lists: ${failures.join(', ')}`);
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
  // budget and priority-band checks ever replaces the previous good rules/.
  verifyDnrBudget(stagingDir);
  assertStaticRulePriorityBands(stagingDir);
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
  assertStaticRulePriorityBands,
  vendoredListPath,
  VENDORED_LISTS_DIR,
  RUNTIME_ALLOWLIST_PRIORITY,
  SYSTEM_UNBREAK_PRIORITY,
  SYSTEM_UNBREAK_OVERRIDE_PRIORITY,
  DNR_PRIORITY,
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
