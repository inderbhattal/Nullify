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

/** Returns true if the hostname is a public suffix itself. */
export function isPublicSuffix(hostname) {
  if (!hostname) return true; // empty string = the root; never allowlist-eligible
  return PUBLIC_SUFFIXES.has(hostname);
}

/**
 * Walk parent domains of `hostname`, stopping before the first public suffix.
 * Yields the original hostname and each non-public ancestor in turn. The
 * public suffix itself is NOT yielded.
 */
export function* ancestorDomains(hostname) {
  let current = hostname;
  while (current && !isPublicSuffix(current)) {
    yield current;
    const dotIdx = current.indexOf('.');
    if (dotIdx === -1) break;
    current = current.slice(dotIdx + 1);
  }
}
