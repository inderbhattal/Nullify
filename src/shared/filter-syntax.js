/**
 * filter-syntax.js
 *
 * Primitives shared by every ABP-syntax parser in the project.
 *
 * Nullify parses filter syntax in three places (build script, service worker,
 * Rust core). Each divergence between them is a silent behaviour change, so
 * anything subtle enough to be got wrong twice lives here and is asserted by
 * tests/parser-parity.test.mjs.
 */

/**
 * Split a comma-separated domain list into the domains a rule applies to and
 * the domains it must not apply to.
 *
 * A `~`-prefixed entry is an *exclusion*. Every parser previously kept it as a
 * literal positive domain, which inverts its meaning twice over:
 *
 *   youtube.com,~music.youtube.com##+js(...)
 *     stored under both 'youtube.com' and '~music.youtube.com'. The lookup
 *     walks ancestors, so music.youtube.com matches via 'youtube.com' and runs
 *     the scriptlet the list author explicitly excluded there.
 *
 *   ~example.com##.ad
 *     means "everywhere except example.com". Keyed under the literal
 *     '~example.com', which equals no hostname, so it applied nowhere.
 *
 * @param {string} raw comma-separated list, e.g. "a.com,~sub.a.com"
 * @returns {{domains: string[], excludedDomains: string[]}}
 */
/**
 * Preprocessor symbols that are true for this extension.
 *
 * Everything absent is false, including capabilities we genuinely lack —
 * `cap_html_filtering` sections, for instance, carry `##^script:has-text(...)`
 * rules that are meaningless under MV3 and become garbage selectors if pulled
 * in. Defaulting unknown symbols to false under-includes, which is the
 * recoverable direction.
 */
const PREPROCESSOR_DEFINES = new Set([
  'env_chromium',
  'env_chrome',
  'env_mv3',
  'cap_dnr',
  'ublock',
  'ext_ublock',
]);

/**
 * Evaluate an `!#if` condition.
 *
 * Supports the grammar the filter lists actually use: symbols, `!`, `&&`,
 * `||` and parentheses. The previous substring heuristic
 *
 *   condition.includes('env_chromium') || condition.includes('cap_dnr')
 *     || !condition.includes('env_')
 *
 * got both directions wrong. `!#if !env_chromium` *contains* `env_chromium`,
 * so Firefox-only sections were included on Chrome; and `!#if !env_mobile`
 * contains `env_` without `env_chromium`, so desktop-applicable sections were
 * excluded. Both forms are live in the uAssets lists this project fetches.
 *
 * Returns false for anything malformed — an unparsable condition must not
 * silently pull a section in.
 */
export function evaluatePreprocessorCondition(condition, defines = PREPROCESSOR_DEFINES) {
  const tokens = String(condition ?? '').match(/\(|\)|&&|\|\||!|[A-Za-z0-9_]+/g);
  if (!tokens?.length) return false;

  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  // or := and ('||' and)*
  const parseOr = () => {
    let value = parseAnd();
    while (peek() === '||') {
      consume();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };

  // and := unary ('&&' unary)*
  const parseAnd = () => {
    let value = parseUnary();
    while (peek() === '&&') {
      consume();
      const right = parseUnary();
      value = value && right;
    }
    return value;
  };

  // unary := '!' unary | '(' or ')' | symbol
  const parseUnary = () => {
    const token = peek();
    if (token === undefined) throw new Error('unexpected end of condition');

    if (token === '!') {
      consume();
      return !parseUnary();
    }
    if (token === '(') {
      consume();
      const value = parseOr();
      if (consume() !== ')') throw new Error('unbalanced parenthesis');
      return value;
    }
    if (token === ')' || token === '&&' || token === '||') {
      throw new Error(`unexpected token ${token}`);
    }

    consume();
    return defines.has(token);
  };

  try {
    const value = parseOr();
    if (pos !== tokens.length) return false; // trailing junk
    return value;
  } catch {
    return false;
  }
}

/**
 * Apply `#@#+js(name)` exceptions to a set of scriptlet rules.
 *
 * A scriptlet exception disables one named scriptlet on the domains it lists —
 * uAssets ships them to turn off a scriptlet that breaks a specific site while
 * leaving it active everywhere else. A domain-less exception disables the
 * scriptlet outright.
 *
 * @param {Array<{name: string, domains: string[], excludedDomains?: string[]}>} scriptletRules
 * @param {Array<{name: string, domains: string[]}>} scriptletExceptions
 */
export function applyScriptletExceptions(scriptletRules, scriptletExceptions) {
  if (!scriptletExceptions?.length) return scriptletRules;

  // name -> excepted domains. An entry with no domains excepts everywhere.
  const globalKills = new Set();
  const perDomain = new Map();

  for (const exception of scriptletExceptions) {
    const name = exception?.name;
    if (!name) continue;

    if (!exception.domains?.length) {
      globalKills.add(name);
      continue;
    }
    if (!perDomain.has(name)) perDomain.set(name, []);
    perDomain.get(name).push(...exception.domains);
  }

  const out = [];
  for (const rule of scriptletRules) {
    if (globalKills.has(rule.name)) continue;

    const excepted = perDomain.get(rule.name);
    if (!excepted?.length) {
      out.push(rule);
      continue;
    }

    // Expressed as an exclusion on the rule so the ordinary lookup-time
    // exclusion filter cancels it — no separate subtraction path to keep in
    // sync, and it composes with any `~domain` the rule already carried.
    out.push({
      ...rule,
      excludedDomains: [...new Set([...(rule.excludedDomains || []), ...excepted])],
    });
  }

  return out;
}

/**
 * Split a cosmetic rule's domain prefix into included and excluded lists.
 *
 * Tokens are case-folded (§5.14b): hostnames are case-insensitive, lookups key
 * on a lowercased hostname, and the Rust engine already folds. Keeping the
 * author's case here meant `EXAMPLE.com##.Ad` was stored under a key no
 * hostname can equal — dead in the JS engines, live in Rust, for the same
 * line.
 */
export function splitDomainList(raw) {
  const domains = [];
  const excludedDomains = [];

  for (const part of String(raw || '').split(',')) {
    const token = part.trim().toLowerCase();
    if (!token) continue;

    if (token.startsWith('~')) {
      const excluded = token.slice(1).trim();
      if (excluded) excludedDomains.push(excluded);
    } else {
      domains.push(token);
    }
  }

  return { domains, excludedDomains };
}
