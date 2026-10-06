/**
 * import-export.js — the files My Filters and the Allowlist export, and the
 * parsers their Import buttons read files back with.
 *
 * Each Import button used to accept the other tab's export, and the two
 * formats overlap exactly where that does damage. A bare hostname is a site to
 * trust in an allowlist and a block rule in My Filters. A cosmetic, scriptlet
 * or path rule (`shop.example##.ad`) parses as a URL whose host is the site
 * the rule was written for. So an Allowlist export imported into My Filters
 * compiled every trusted site into a block rule, plus one more per `#` header
 * line (no compiler reads `#` as a comment). A My Filters export
 * imported into the Allowlist turned off all blocking on every site its
 * cosmetic, scriptlet and path rules named. Both reported success.
 *
 * Every export either tab has ever written opens with its title line, so the
 * file says which tab it belongs to. Each parser reads that first and refuses
 * the other tab's file. The allowlist parser also refuses a file in which any
 * line is not a site. A filter list without our header holds rules, and its
 * bare hostnames are block rules too, so importing "the sites in it" would
 * still allowlist ad servers. My Filters cannot do the same: a list of bare
 * hostnames is a valid blocklist, and only the header tells the two apart.
 *
 * DOM-free and chrome-free, like status-format.js, so the tests drive it
 * directly (`import-export.test.mjs`).
 */

import { normalizeHostname } from '../shared/hostname.js';

const FILTERS_TITLE = '! Title: My Filters';
const ALLOWLIST_TITLE = '# Title: Allowlist';

// Header comments: `!` in filter syntax, `#` (then a space, or nothing) in the
// allowlist's. `##.ad` is a rule, not a comment, and ends the header.
const HEADER_COMMENT = /^(?:!|#(?:\s|$))/;
const TITLE_LINE = /^[!#]\s*Title:/i;
const FILTERS_TITLE_LINE = /^!\s*Title:\s*My Filters$/i;
const ALLOWLIST_TITLE_LINE = /^#\s*Title:\s*Allowlist$/i;
// Lines My Filters' export adds above the user's own text.
const FILTERS_HEADER_LINE = /^!\s*(?:Title|Exported):/i;
// normalizeHostname's own test for "already has a scheme".
const URL_WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// The URL parser drops tabs and newlines anywhere and C0 controls at the ends,
// so `ads.example<TAB>.com` would parse as ads.example.com.
const SPACE_OR_CONTROL = /[\s\p{Cc}]/u;
// What the service worker stores (isValidAllowlistDomain's charset). The URL
// parser also lets `$ , * = ~` through in a host: `example.com$popup`.
const HOSTNAME_CHARS = /^[a-z0-9.-]+$/;
// Where `example.com  # my bank` starts its comment. Filter syntax never puts
// whitespace before its `#` markers, so this cannot turn `shop.example##.ad`
// into a site. Searched for, not stripped with `/\s+#.*$/`: that backtracks
// quadratically over a long run of spaces, and a 1 MB import can be one line.
const TRAILING_COMMENT_START = /\s#/;

/** The file My Filters' Export button writes. */
export function filtersExportText(filters, now = new Date()) {
  return `${FILTERS_TITLE}\n! Exported: ${now.toISOString()}\n!\n${filters}`;
}

/** The file the Allowlist's Export button writes. */
export function allowlistExportText(domains, now = new Date()) {
  return `${ALLOWLIST_TITLE}\n# Exported: ${now.toISOString()}\n#\n${domains.join('\n')}\n`;
}

/**
 * Which tab exported `text`: 'filters', 'allowlist', or null for anything
 * else (a hand-written file, another tool's list). Only the comment block the
 * file opens with is read, and the first title in it decides. A filter list
 * that merely carries an allowlist further down, or a third-party list titled
 * "Allowlist" in filter syntax (`! Title: …`), is not an Allowlist export.
 */
export function detectExportKind(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!HEADER_COMMENT.test(line)) return null;
    if (!TITLE_LINE.test(line)) continue;
    if (FILTERS_TITLE_LINE.test(line)) return 'filters';
    if (ALLOWLIST_TITLE_LINE.test(line)) return 'allowlist';
    return null;
  }
  return null;
}

/**
 * Read a file chosen with My Filters' Import button.
 *
 * An Allowlist export comes back as `{refused: 'allowlist'}` and must not be
 * merged. Anything else is `{rules}`: every non-blank line, trimmed, less the
 * header lines My Filters' own export adds. Other comments are the user's and
 * are kept.
 */
export function parseFiltersImport(text) {
  if (detectExportKind(text) === 'allowlist') return { refused: 'allowlist' };
  const rules = String(text ?? '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== '!' && !FILTERS_HEADER_LINE.test(line));
  return { rules };
}

/**
 * The site `entry` names, or '' when it is not a site. It must parse as a URL
 * (with `http://` assumed when it has no scheme) that is nothing but a host,
 * optionally with a port: no path, query, fragment or user. That refuses every
 * filter shape that carries a host (`shop.example##.ad`, `#@#`, `##+js(…)`,
 * `cdn.example/ads/*`, `https://ads.example/x.js$script`, `@@example.com`);
 * `||…^` and `@@||…^` do not parse at all. It also refuses a page URL rather
 * than widen it to the whole site: a host with a path can be a block rule.
 * A bare hostname still passes, and only the file's header can say whether it
 * was meant as a site to trust or as a block rule.
 */
function siteHost(entry) {
  if (SPACE_OR_CONTROL.test(entry)) return '';
  let url;
  try {
    url = new URL(URL_WITH_SCHEME.test(entry) ? entry : `http://${entry}`);
  } catch {
    return '';
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
  const host = normalizeHostname(entry);
  return HOSTNAME_CHARS.test(host) ? host : '';
}

/**
 * Read a file chosen with the Allowlist's Import button. Returns one of:
 *   `{refused: 'filters'}`              a My Filters export;
 *   `{refused: 'not-sites', lines}`     some line is not a site, so nothing is
 *                                       imported, and `lines` lists them all;
 *   `{domains}`                         the sites, normalized and deduplicated.
 * Lines starting with `!` or `#` are comments, and so is a `#` after
 * whitespace at the end of a line.
 */
export function parseAllowlistImport(text) {
  if (detectExportKind(text) === 'filters') return { refused: 'filters' };
  const domains = new Set();
  const lines = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('#')) continue;
    const commentAt = line.search(TRAILING_COMMENT_START);
    const host = siteHost(commentAt === -1 ? line : line.slice(0, commentAt).trimEnd());
    if (host) {
      domains.add(host);
    } else {
      lines.push(line);
    }
  }
  return lines.length > 0 ? { refused: 'not-sites', lines } : { domains: [...domains] };
}
