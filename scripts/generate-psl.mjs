#!/usr/bin/env node
/**
 * generate-psl.mjs
 *
 * Builds the public-suffix tables that `src/shared/psl.js` and
 * `wasm-core/src/psl_generated.rs` ship, from the vendored Public Suffix List
 * in `scripts/psl-source/`. Both outputs are written from the same parse, so
 * the JS and Rust sides cannot drift (REVIEW-2026-09 §5.12).
 *
 * Usage:
 *   node scripts/generate-psl.mjs
 *
 * The emit is a pure function of the vendored bytes plus the curated PRIVATE
 * block below, so running it twice yields no diff. `src/shared/psl.test.mjs`
 * pins that by re-rendering and comparing against the committed files, which
 * also catches a hand-edit of either generated file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { domainToASCII, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAT_PATH = path.resolve(HERE, 'psl-source/public_suffix_list.dat');
const LOCK_PATH = path.resolve(HERE, 'psl-source/public_suffix_list.lock.json');
const PSL_JS_PATH = path.resolve(HERE, '../src/shared/psl.js');
const PSL_RS_PATH = path.resolve(HERE, '../wasm-core/src/psl_generated.rs');

/**
 * Entries taken from the list's PRIVATE section, one deliberate decision each.
 *
 * The ICANN section is taken whole; the PRIVATE section is not. A private
 * entry makes its name unallowlistable, so the wrong one is a regression in
 * the opposite direction to §5.12 — a user who legitimately wants to allowlist
 * the site at that name can no longer do it. The bar applied here is: the name
 * is a registry for third-party subdomains AND its apex is not itself a site a
 * user would allowlist. Names below these suffixes stay allowlistable
 * (`mybucket.s3.amazonaws.com`, `myblog.blogspot.com`), which is the whole
 * point of the suffix.
 *
 * Every entry must exist in the vendored PRIVATE section; the generator fails
 * if one disappears upstream, so a quarterly refresh cannot silently drop one.
 */
const CURATED_PRIVATE_SUFFIXES = [
  // Static-site and app hosting: one third-party site per subdomain, apex is
  // not browsable. These eleven are the set `psl.js` already shipped.
  'github.io',
  'gitlab.io',
  'netlify.app',
  'vercel.app',
  'herokuapp.com',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  's3.amazonaws.com',
  'cloudfront.net',
  // `.ru` second-level hierarchy. These read like ICANN ccTLD suffixes and are
  // exactly §5.12's shape, but the list files them under PRIVATE (they are run
  // by a registrar, not by the ccTLD). The curated table already carried them;
  // dropping them would re-open the finding for `.ru`.
  'com.ru',
  'org.ru',
  'gov.ru',
  // Blogger. `<blog>.blogspot.com` is one third-party blog per subdomain and
  // the apex redirects to blogger.com, so nothing is lost by making it a
  // suffix. Named by REMEDIATION-2026-09 §2.7.
  'blogspot.com',
  // NOT included, though §2.7 names it: `wordpress.com`. It is in no section
  // of the Public Suffix List — not ICANN, not PRIVATE — so there is nothing
  // upstream to validate it against, and unlike every entry above, its apex is
  // a real browsable site (dashboard, login, marketing) that a user may want
  // to allowlist. Blocking that is the regression this list exists to avoid.
];

/**
 * Read the vendored list with a reader that cannot hide content (§9.26).
 *
 * A single NUL byte made a whole document invisible to `grep` this release,
 * and two independent checks believed the empty result. This file is build
 * input for a security-relevant table, so it is read as bytes and checked
 * before it is decoded: a NUL byte or a sequence that does not survive a UTF-8
 * round trip means the file is not what it claims to be, and the generator
 * stops rather than emitting a quietly truncated table.
 */
function readVendoredList() {
  const bytes = fs.readFileSync(DAT_PATH);
  if (bytes.includes(0)) {
    throw new Error(`${DAT_PATH}: contains a NUL byte — refusing to parse (§9.26)`);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${DAT_PATH}: not valid UTF-8 — refusing to parse (§9.26)`);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new Error(`${DAT_PATH}: starts with a byte-order mark — refusing to parse`);
  }

  // The lock is the other half of that check: it pins the exact bytes upstream
  // published, so an edited or half-downloaded list is caught here rather than
  // showing up as a table that is subtly short.
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')).public_suffix_list;
  const digest = `sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}`;
  if (digest !== lock.sha384) {
    throw new Error(`${DAT_PATH}: sha384 is ${digest}, lock says ${lock.sha384}`);
  }

  const version = /^\/\/ VERSION: (.+)$/m.exec(text);
  const commit = /^\/\/ COMMIT: (.+)$/m.exec(text);
  if (!version || !commit) throw new Error(`${DAT_PATH}: no VERSION/COMMIT header lines`);
  if (version[1] !== lock.version || commit[1] !== lock.commit) {
    throw new Error(`${DAT_PATH}: header says ${version[1]}/${commit[1]}, lock says ${lock.version}/${lock.commit}`);
  }

  return { text, version: version[1], commit: commit[1] };
}

/** Rules between two section markers, comments and blank lines removed. */
function section(lines, name) {
  const begin = lines.indexOf(`// ===BEGIN ${name} DOMAINS===`);
  const end = lines.indexOf(`// ===END ${name} DOMAINS===`);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`public_suffix_list.dat: ${name} section markers missing or out of order`);
  }
  const rules = lines.slice(begin + 1, end).map((line) => line.trim()).filter((line) => line && !line.startsWith('//'));
  if (rules.length === 0) throw new Error(`public_suffix_list.dat: ${name} section parsed as empty`);
  return rules;
}

/**
 * The list writes internationalised rules as U-labels (`公司.cn`); every
 * hostname this codebase ever tests is an A-label, because `normalizeHostname`
 * runs its input through `new URL()` and `isValidAllowlistDomain` refuses
 * anything outside `[a-z0-9.-]`. So the tables hold punycode and nothing else:
 * a U-label entry would be dead weight that can never match.
 */
function toAscii(rule) {
  // A rule's `*.`/`!` marker is not part of the name, and feeding it to the
  // URL parser would mangle it.
  const prefix = rule.startsWith('*.') ? '*.' : rule.startsWith('!') ? '!' : '';
  const name = rule.slice(prefix.length);
  if (!/[^\x00-\x7f]/.test(name)) return rule;
  const ascii = domainToASCII(name);
  if (!ascii || /[^\x00-\x7f]/.test(ascii)) {
    throw new Error(`public_suffix_list.dat: cannot punycode rule ${JSON.stringify(rule)}`);
  }
  return prefix + ascii;
}

/** Parse the vendored list into the three tables both outputs carry. */
export function buildTables() {
  const { text, version, commit } = readVendoredList();
  const lines = text.split('\n').map((line) => line.trim());

  const icann = section(lines, 'ICANN').map(toAscii);
  const privateRules = new Set(section(lines, 'PRIVATE').map(toAscii));

  const suffixes = new Set();
  const wildcards = new Set();
  const exceptions = new Set();

  for (const rule of icann) {
    if (rule.startsWith('!')) {
      exceptions.add(rule.slice(1));
      continue;
    }
    if (rule.startsWith('*.')) {
      const base = rule.slice(2);
      wildcards.add(base);
      // The base of a wildcard rule is a registry boundary, never an ordinary
      // registrable name: `*.ck` exists precisely because `.ck` sells nothing
      // at the second level. The strict algorithm would let the parent rule
      // prevail and call `sch.uk` registrable, which would make `||sch.uk^`
      // allowlistable — the §5.12 shape, and a regression against the curated
      // table, which listed `sch.uk`. Emitting the base as a plain suffix
      // keeps both tables in agreement without an algorithm change.
      suffixes.add(base);
      continue;
    }
    if (rule.includes('*')) {
      throw new Error(`public_suffix_list.dat: unsupported embedded wildcard in ${JSON.stringify(rule)}`);
    }
    suffixes.add(rule);
  }

  // The list's implicit `*` rule makes every top-level domain a public suffix
  // even when it has no rule of its own — `za` has second-level rules but no
  // `za` line. Adding the TLD of every rule expresses that as table data, so
  // the JS and Rust sides get it from the same place.
  for (const rule of [...suffixes, ...wildcards, ...exceptions]) {
    suffixes.add(rule.slice(rule.lastIndexOf('.') + 1));
  }

  for (const entry of CURATED_PRIVATE_SUFFIXES) {
    if (!privateRules.has(entry)) {
      throw new Error(`curated PRIVATE entry ${JSON.stringify(entry)} is no longer in the vendored list`);
    }
    suffixes.add(entry);
  }

  for (const entry of exceptions) {
    if (suffixes.has(entry)) {
      throw new Error(`exception ${JSON.stringify(entry)} is also a plain suffix — tables would contradict`);
    }
  }

  const sorted = (set) => [...set].sort();
  return {
    version,
    commit,
    icannRules: icann.length,
    suffixes: sorted(suffixes),
    wildcards: sorted(wildcards),
    exceptions: sorted(exceptions),
  };
}

/** Header both outputs carry, so a reader of either knows where it came from. */
function provenance(tables, comment) {
  return [
    `${comment} Generated by scripts/generate-psl.mjs — DO NOT EDIT BY HAND.`,
    `${comment} Source: scripts/psl-source/public_suffix_list.dat`,
    `${comment}   VERSION ${tables.version}`,
    `${comment}   COMMIT  ${tables.commit}`,
    `${comment} ${tables.icannRules} ICANN rules + a curated PRIVATE block; see the generator.`,
  ].join('\n');
}

export function renderJs(tables) {
  return `${provenance(tables, '//')}
/**
 * psl.js — public suffix tables and the three rules that read them.
 *
 * The tables are the Public Suffix List's ICANN section in full, plus a small
 * curated set of PRIVATE entries (\`github.io\`, \`blogspot.com\`, …) chosen one
 * by one in the generator. §5.12: the hand-curated list this replaced omitted
 * common second-level ccTLD suffixes (\`co.th\`, \`com.my\`, …), so a typo or an
 * imported allowlist line yielded \`||co.th^\` + allowAllRequests across the
 * whole hierarchy while the UI still said "Protected".
 *
 * The only invariant this module owes its callers: \`isPublicSuffix('co.uk')\`
 * is true, so allowlist and scriptlet lookups stop ascending at that level
 * rather than treating \`co.uk\` as a normal user-scopeable domain.
 *
 * If a hostname's remaining ancestor is a public suffix we stop — the
 * allowlist cannot meaningfully contain a rule at that level, and any stored
 * scriptlet indexed by that ancestor would blanket the entire TLD.
 */

const PUBLIC_SUFFIX_DATA = \`
${tables.suffixes.join('\n')}
\`;

/** \`*.ck\` — every \`<label>.ck\` is a suffix. Bases are in PUBLIC_SUFFIX_DATA too. */
const WILDCARD_SUFFIX_DATA = \`
${tables.wildcards.join('\n')}
\`;

/** \`!www.ck\` — names a wildcard would cover that the list excepts back out. */
const SUFFIX_EXCEPTION_DATA = \`
${tables.exceptions.join('\n')}
\`;

const WILDCARD_SUFFIXES = new Set(WILDCARD_SUFFIX_DATA.trim().split('\\n'));
const EXCEPTIONS = new Set(SUFFIX_EXCEPTION_DATA.trim().split('\\n'));

/**
 * The full table is built on first use, not at module load.
 *
 * §4.12: every bundle imports this module — the content script reaches it
 * through \`normalizeHostname\` — but the content script only consults the PSL
 * when a hostname actually starts with \`www.\`, which most do not. Deferring
 * the Set keeps the per-page cost of the bigger table at zero on those pages.
 */
let publicSuffixSet = null;

function publicSuffixes() {
  if (publicSuffixSet === null) {
    publicSuffixSet = new Set(PUBLIC_SUFFIX_DATA.trim().split('\\n'));
  }
  return publicSuffixSet;
}

/**
 * Canonical form for every lookup in this module: lower-cased, whitespace
 * trimmed, and stripped of the leading/trailing dots a hostname may carry
 * (\`bbc.co.uk.\` is the fully-qualified spelling of \`bbc.co.uk\`).
 *
 * §5.11: the walk below used to trust its caller. Unnormalized input broke the
 * one invariant this module exists to provide — \`ancestorDomains('bbc.co.uk.')\`
 * walked past the suffix set to \`uk.\`, and \`ancestorDomains('WWW.EXAMPLE.COM')\`
 * walked to \`COM\`, because neither trailing-dot nor upper-case spelling is in
 * the table. Every service-worker call site happened to normalize first, but
 * \`db.getScriptletRules\` takes any string. Normalizing here makes the
 * invariant unconditional instead of a caller obligation.
 */
function canonicalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\\.+|\\.+$/g, '');
}

/**
 * The list's matching rules, in the order the list defines them (§5.12):
 * an exception wins outright, then a plain rule, then a wildcard — which is
 * one label deep, so \`*.ck\` makes \`foo.ck\` a suffix and leaves
 * \`deep.foo.ck\` an ordinary name below it.
 */
function matchesRule(host) {
  if (EXCEPTIONS.has(host)) return false;
  if (publicSuffixes().has(host)) return true;
  const dotIdx = host.indexOf('.');
  return dotIdx !== -1 && WILDCARD_SUFFIXES.has(host.slice(dotIdx + 1));
}

/** Returns true if the hostname is a public suffix itself. */
export function isPublicSuffix(hostname) {
  const host = canonicalizeHost(hostname);
  if (!host) return true; // empty string = the root; never allowlist-eligible
  return matchesRule(host);
}

/**
 * Walk parent domains of \`hostname\`, stopping before the first public suffix.
 * Yields the normalized hostname and each non-public ancestor in turn. The
 * public suffix itself is NOT yielded.
 */
export function* ancestorDomains(hostname) {
  let current = canonicalizeHost(hostname);
  while (current && !matchesRule(current)) {
    yield current;
    const dotIdx = current.indexOf('.');
    if (dotIdx === -1) break;
    current = current.slice(dotIdx + 1);
  }
}

/**
 * Domains a *site-scoped* rule lookup should consult for \`hostname\`, most
 * specific first.
 *
 * §5.11 second half — the decision, stated explicitly because the alternative
 * is defensible too. Exact membership is honoured BEFORE the public-suffix
 * stop, mirroring what \`allowlistCoversHostname\` and the WASM
 * \`AllowlistMatcher::check\` already do (§4.8):
 *
 *   - \`github.io\`, \`netlify.app\`, \`pages.dev\` … are curated public suffixes
 *     *and* real browsable sites. \`ancestorDomains\` yields nothing for them,
 *     so a rule authored as \`github.io##+js(…)\` could never fire on that host.
 *     It now does.
 *   - Inheritance is deliberately NOT granted: \`user.github.io\` still does not
 *     pick up \`github.io\`-keyed rules. uBO would inherit (its cosmetic domain
 *     match is a plain suffix walk with no PSL), but inheritance is exactly
 *     the blanket-the-whole-suffix behaviour the PSL stop was added to prevent,
 *     and it cannot be granted for \`github.io\` without also granting it for
 *     \`co.uk\`. Exact-match-only buys back the self-host case at zero blast
 *     radius, which is the same trade the allowlist settled on.
 */
export function* lookupDomains(hostname) {
  const host = canonicalizeHost(hostname);
  if (!host) return;
  if (matchesRule(host)) {
    yield host; // exact membership only — do not ascend into the suffix
    return;
  }
  yield* ancestorDomains(host);
}
`;
}

export function renderRust(tables) {
  return `${provenance(tables, '//')}

use std::collections::HashSet;
use std::sync::OnceLock;

const PUBLIC_SUFFIX_DATA: &str = "\\
${tables.suffixes.join('\n')}
";

/// \`*.ck\` — every \`<label>.ck\` is a suffix. Bases are in PUBLIC_SUFFIX_DATA too.
const WILDCARD_SUFFIX_DATA: &str = "\\
${tables.wildcards.join('\n')}
";

/// \`!www.ck\` — names a wildcard would cover that the list excepts back out.
const SUFFIX_EXCEPTION_DATA: &str = "\\
${tables.exceptions.join('\n')}
";

/// Public suffix set — the list's ICANN section plus the curated PRIVATE block.
pub fn public_suffixes_generated() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| PUBLIC_SUFFIX_DATA.lines().collect())
}

/// Wildcard bases (\`*.ck\` is stored as \`ck\`).
///
/// Not yet read by \`lib.rs\`: \`is_public_suffix\` is Track B's to change, and
/// B3 is the ten-line edit that teaches it these two rules (REMEDIATION §2.7).
/// Until it lands, the Rust side answers from membership alone, which differs
/// from the JS side only for names under one of the 16 wildcard bases.
#[allow(dead_code)]
pub fn wildcard_suffixes_generated() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| WILDCARD_SUFFIX_DATA.lines().collect())
}

/// Exception rules (\`!www.ck\` is stored as \`www.ck\`). See above for B3.
#[allow(dead_code)]
pub fn suffix_exceptions_generated() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| SUFFIX_EXCEPTION_DATA.lines().collect())
}
`;
}

function main() {
  const tables = buildTables();
  fs.writeFileSync(PSL_JS_PATH, renderJs(tables));
  fs.writeFileSync(PSL_RS_PATH, renderRust(tables));
  console.log(`[PSL] ${tables.version} (${tables.commit.slice(0, 8)}): ${tables.icannRules} ICANN rules`);
  console.log(`[PSL] ${tables.suffixes.length} suffixes, ${tables.wildcards.length} wildcards, ${tables.exceptions.length} exceptions`);
  console.log(`[PSL] wrote ${PSL_JS_PATH}`);
  console.log(`[PSL] wrote ${PSL_RS_PATH}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
