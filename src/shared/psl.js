/**
 * psl.js — compact public suffix list.
 *
 * We do not ship the full publicsuffix.org list (~14k entries); this is a
 * curated set covering the long tail that matters for an ad blocker: common
 * multi-label ccTLD hierarchies (.co.uk, .com.au, .com.br, …) plus all
 * top-level suffixes reachable by ascending a hostname.
 *
 * The only invariant we need: calling `isPublicSuffix('co.uk')` returns
 * true so that allowlist/scriptlet lookups stop ascending at that level
 * rather than treating `co.uk` as a normal user-scopeable domain.
 *
 * If a hostname's remaining ancestor is a public suffix we stop — the
 * allowlist cannot meaningfully contain a rule at that level, and any
 * stored scriptlet indexed by that ancestor would blanket the entire TLD.
 */

const PUBLIC_SUFFIXES = new Set([
  // Single-label TLDs must also be treated as public suffixes. We include
  // the most commonly-hit ones so the check is a direct Set lookup rather
  // than a dot-count heuristic.
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'ai',
  'app', 'dev', 'info', 'biz', 'me', 'tv', 'xyz', 'online', 'site',
  'store', 'shop', 'tech', 'cloud', 'blog', 'news', 'art',
  // ccTLDs that are single-label.
  'uk', 'us', 'de', 'fr', 'it', 'es', 'nl', 'be', 'ch', 'at', 'se',
  'no', 'dk', 'fi', 'pl', 'cz', 'pt', 'gr', 'ie', 'au', 'nz', 'ca',
  'mx', 'br', 'ar', 'cl', 'pe', 'ru', 'ua', 'by', 'tr', 'il', 'sa',
  'ae', 'eg', 'za', 'ng', 'ke', 'ma', 'jp', 'kr', 'cn', 'hk', 'tw',
  'sg', 'my', 'id', 'th', 'vn', 'ph', 'in', 'pk', 'bd', 'lk',
  // Multi-label public suffixes (curated high-traffic hierarchy).
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'net.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx',
  'com.ar', 'org.ar', 'gob.ar', 'gov.ar',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'com.sg', 'edu.sg', 'gov.sg',
  'com.hk', 'org.hk', 'gov.hk',
  'com.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'co.il', 'org.il', 'gov.il', 'ac.il',
  'co.za', 'org.za', 'gov.za', 'ac.za',
  'com.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.ua', 'org.ua', 'gov.ua', 'edu.ua',
  'com.ru', 'org.ru', 'gov.ru',
  // Hosting/platform suffixes where user-controlled subdomains live.
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'herokuapp.com',
  'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
  's3.amazonaws.com', 'cloudfront.net',
]);

/**
 * Canonical form for every lookup in this module: lower-cased, whitespace
 * trimmed, and stripped of the leading/trailing dots a hostname may carry
 * (`bbc.co.uk.` is the fully-qualified spelling of `bbc.co.uk`).
 *
 * §5.11: the walk below used to trust its caller. Unnormalized input broke the
 * one invariant this module exists to provide — `ancestorDomains('bbc.co.uk.')`
 * walked past the suffix set to `uk.`, and `ancestorDomains('WWW.EXAMPLE.COM')`
 * walked to `COM`, because neither trailing-dot nor upper-case spelling is in
 * PUBLIC_SUFFIXES. Every service-worker call site happened to normalize first,
 * but `db.getScriptletRules` takes any string. Normalizing here makes the
 * invariant unconditional instead of a caller obligation.
 */
function canonicalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

/** Returns true if the hostname is a public suffix itself. */
export function isPublicSuffix(hostname) {
  const host = canonicalizeHost(hostname);
  if (!host) return true; // empty string = the root; never allowlist-eligible
  return PUBLIC_SUFFIXES.has(host);
}

/**
 * Walk parent domains of `hostname`, stopping before the first public suffix.
 * Yields the normalized hostname and each non-public ancestor in turn. The
 * public suffix itself is NOT yielded.
 */
export function* ancestorDomains(hostname) {
  let current = canonicalizeHost(hostname);
  while (current && !PUBLIC_SUFFIXES.has(current)) {
    yield current;
    const dotIdx = current.indexOf('.');
    if (dotIdx === -1) break;
    current = current.slice(dotIdx + 1);
  }
}

/**
 * Domains a *site-scoped* rule lookup should consult for `hostname`, most
 * specific first.
 *
 * §5.11 second half — the decision, stated explicitly because the alternative
 * is defensible too. Exact membership is honoured BEFORE the public-suffix
 * stop, mirroring what `allowlistCoversHostname` and the WASM
 * `AllowlistMatcher::check` already do (§4.8):
 *
 *   - `github.io`, `netlify.app`, `pages.dev` … are curated public suffixes
 *     *and* real browsable sites. `ancestorDomains` yields nothing for them,
 *     so a rule authored as `github.io##+js(…)` could never fire on that host.
 *     It now does.
 *   - Inheritance is deliberately NOT granted: `user.github.io` still does not
 *     pick up `github.io`-keyed rules. uBO would inherit (its cosmetic domain
 *     match is a plain suffix walk with no PSL), but inheritance is exactly
 *     the blanket-the-whole-suffix behaviour the PSL stop was added to prevent,
 *     and it cannot be granted for `github.io` without also granting it for
 *     `co.uk`. Exact-match-only buys back the self-host case at zero blast
 *     radius, which is the same trade the allowlist settled on.
 */
export function* lookupDomains(hostname) {
  const host = canonicalizeHost(hostname);
  if (!host) return;
  if (PUBLIC_SUFFIXES.has(host)) {
    yield host; // exact membership only — do not ascend into the suffix
    return;
  }
  yield* ancestorDomains(host);
}
