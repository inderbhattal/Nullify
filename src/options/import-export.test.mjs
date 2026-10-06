/**
 * Regression tests for the options page's two Import buttons.
 *
 * Each button accepted the other tab's export. Run through the real WASM
 * compiler, an Allowlist export imported into My Filters became seven block
 * rules: one per trusted site (`urlFilter: "example.com"`) and one per `#`
 * header line, `urlFilter: "#"` among them. A My Filters export imported into
 * the Allowlist allowlisted every host its cosmetic, scriptlet and path rules
 * named (`shop.example.com##.ad-banner` turned off all blocking on
 * shop.example.com). Both reported "✓ Imported".
 *
 * The parsers are DOM-free (import-export.js), so they need no chrome stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAllowlist } from '../shared/hostname.js';

const {
  allowlistExportText,
  detectExportKind,
  filtersExportText,
  parseAllowlistImport,
  parseFiltersImport,
} = await import('./import-export.js');

const NOW = new Date('2026-10-06T12:00:00.000Z');

// Byte-for-byte what earlier versions wrote. The Allowlist header has not
// changed since export shipped, nor My Filters' since the first release, so
// every file a user already holds looks like one of these.
const OLD_ALLOWLIST_EXPORT =
  '# Title: Allowlist\n# Exported: 2026-04-22T10:00:00.000Z\n#\nexample.com\nbank.example.org\n';
const OLD_FILTERS_EXPORT =
  '! Title: My Filters\n! Exported: 2026-03-14T08:00:00.000Z\n!\n||ads.example.com^\nshop.example.com##.ad-banner';

// ---------------------------------------------------------------------------
// An Allowlist export handed to My Filters' Import
// ---------------------------------------------------------------------------

test('My Filters refuses an Allowlist export instead of compiling its sites into block rules', () => {
  const file = allowlistExportText(['example.com', 'bank.example.org'], NOW);
  assert.deepEqual(parseFiltersImport(file), { refused: 'allowlist' });
});

test('My Filters refuses an Allowlist export written by an earlier version', () => {
  assert.deepEqual(parseFiltersImport(OLD_ALLOWLIST_EXPORT), { refused: 'allowlist' });
});

test('the refusal survives Windows line endings and leading blank lines', () => {
  const crlf = '\r\n\r\n' + OLD_ALLOWLIST_EXPORT.replace(/\n/g, '\r\n');
  assert.deepEqual(parseFiltersImport(crlf), { refused: 'allowlist' });
});

// ---------------------------------------------------------------------------
// A My Filters export handed to the Allowlist's Import
// ---------------------------------------------------------------------------

test('the Allowlist refuses a My Filters export instead of allowlisting the sites its rules target', () => {
  const file = filtersExportText('||ads.example.com^\nshop.example.com##.ad-banner', NOW);
  assert.deepEqual(parseAllowlistImport(file), { refused: 'filters' });
  assert.deepEqual(parseAllowlistImport(OLD_FILTERS_EXPORT), { refused: 'filters' });
});

test('filter rules without our header refuse the file, and none is read as the site it names', () => {
  const rules = [
    'shop.example.com##.ad-banner',
    'news.example.org#@#.sponsored',
    'video.example.net##+js(set-constant, adsEnabled, false)',
    'forum.example.com#?#.post:has-text(Sponsored)',
    'cdn.example.io/ads/*',
    'example.com/banner.gif',
    'example.com?ad=1',
    'user@example.com',
    '||ads.example.com^',
    '@@||safe.example.com^',
    '@@example.com',
    '|https://example.com/ad',
    // A scheme does not make a rule a site.
    'https://ads.example.com/banner.js$script',
    'http://tracker.example/*',
    'https://example.com##.ad',
    // Characters a URL host allows and a hostname does not.
    'example.com$popup',
    'example.com,example.org',
    '*.example.com',
    // The URL parser deletes tabs, which would make these one hostname.
    '0.0.0.0\tads.example.com',
    'ads.example\t.com',
    '0.0.0.0 ads.example.com',
  ];
  assert.deepEqual(parseAllowlistImport(rules.join('\n')), { refused: 'not-sites', lines: rules });
});

test('one filter rule refuses the whole file, so its bare hostnames are not allowlisted either', () => {
  // In a filter list `doubleclick.net` is a block rule: importing "the sites
  // in it" would switch blocking off for the very hosts the list blocks.
  assert.deepEqual(parseAllowlistImport('example.com##.ad\ndoubleclick.net\nads.example.com'), {
    refused: 'not-sites',
    lines: ['example.com##.ad'],
  });
});

test('a page URL refuses the file instead of being widened to its whole site', () => {
  // Nullify allowlists whole sites only, and a host with a path is also a
  // path-scoped block rule (`example.com/banner.gif`), so it is listed, not guessed.
  const pages = ['example.com/login', 'https://www.bank.example/home', 'https://example.org/?q=1'];
  assert.deepEqual(parseAllowlistImport(['example.net', ...pages].join('\n')), {
    refused: 'not-sites',
    lines: pages,
  });
});

// ---------------------------------------------------------------------------
// Didn't re-break
// ---------------------------------------------------------------------------

test('an Allowlist export round-trips through the Allowlist importer', () => {
  const domains = ['example.com', 'bank.example.org', 'news.site.co.uk', '192.168.1.1', 'xn--bcher-kva.de'];
  assert.deepEqual(parseAllowlistImport(allowlistExportText(domains, NOW)), { domains });
  assert.deepEqual(parseAllowlistImport(OLD_ALLOWLIST_EXPORT), { domains: ['example.com', 'bank.example.org'] });
});

test('a My Filters export round-trips through My Filters, keeping the user\'s own comments', () => {
  const filters = [
    '! cookie banners',
    '||ads.example.com^',
    '',
    '  shop.example.com##.ad-banner  ',
    '##[class*="advertisement"]',
    '@@||safe.example.com^$document',
  ].join('\n');
  assert.deepEqual(parseFiltersImport(filtersExportText(filters, NOW)), {
    rules: [
      '! cookie banners',
      '||ads.example.com^',
      'shop.example.com##.ad-banner',
      '##[class*="advertisement"]',
      '@@||safe.example.com^$document',
    ],
  });
});

test('hand-written allowlists still store the same sites: comments, www, case, ports, IDN, site URLs', () => {
  const text = [
    '! my trusted sites',
    '# work',
    '#',
    'WWW.Example.COM',
    'example.com',
    'example.org:8443',
    'bücher.de',
    'example.net.',
    'https://news.example.co.uk/',
    'HTTP://Docs.Example.Dev',
    '//cdn.example.io',
    'bank.example.org   # trailing comments were accepted before, too',
    '',
  ].join('\n');
  // Compared as the service worker stores them (it normalizes what it is sent).
  assert.deepEqual(normalizeAllowlist(parseAllowlistImport(text).domains), [
    'example.com', 'example.org', 'xn--bcher-kva.de', 'example.net',
    'news.example.co.uk', 'docs.example.dev', 'cdn.example.io', 'bank.example.org',
  ]);
});

test('a trailing comment is cut off before the host, not sent along with it', () => {
  assert.deepEqual(parseAllowlistImport('bank.example.org   # my bank\nexample.com\t# work'), {
    domains: ['bank.example.org', 'example.com'],
  });
});

test('a trailing comment is found in linear time, so a long run of spaces cannot stall the tab', () => {
  // `/\s+#.*$/` takes ~18 s on this line and ~7 minutes on a 1 MB one.
  const line = `bank.example.org${' '.repeat(200_000)}x`;
  const started = performance.now();
  assert.deepEqual(parseAllowlistImport(`${line}\nexample.com ${' '.repeat(200_000)}# ok`), {
    refused: 'not-sites',
    lines: [line],
  });
  assert.ok(performance.now() - started < 1000, 'parsing 400 KB of spaces should take milliseconds');
});

test('a file with no header is judged by its lines: a bare hostname is a site here and a block rule there', () => {
  // A hosts-style blocklist is a legitimate My Filters import, so My Filters
  // cannot refuse bare hostnames; the export header is what tells them apart.
  assert.deepEqual(parseAllowlistImport('tracker.example.biz'), { domains: ['tracker.example.biz'] });
  assert.deepEqual(parseFiltersImport('tracker.example.biz\nads.example.com'), {
    rules: ['tracker.example.biz', 'ads.example.com'],
  });
});

test('a third-party filter list titled "Allowlist" is still a filter list', () => {
  const list = '! Title: Allowlist\n! Expires: 4 days\n@@||example.com^$document';
  assert.equal(detectExportKind(list), null);
  assert.deepEqual(parseFiltersImport(list), { rules: ['! Expires: 4 days', '@@||example.com^$document'] });
});

test('detectExportKind reads only the opening comment block, and its first title decides', () => {
  assert.equal(detectExportKind(''), null);
  assert.equal(detectExportKind(undefined), null);
  assert.equal(detectExportKind('example.com\n# Title: Allowlist'), null);
  assert.equal(detectExportKind('##.ad\n# Title: Allowlist'), null, '`##` starts a rule, not a comment');
  assert.equal(detectExportKind('! Title: EasyList\n! Title: My Filters'), null);
  assert.equal(detectExportKind('! saved on the laptop\n! Title: My Filters'), 'filters');
  // A filter export that already holds an imported allowlist is a filter export.
  assert.equal(detectExportKind(filtersExportText(OLD_ALLOWLIST_EXPORT, NOW)), 'filters');
});
