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

export function splitDomainList(raw) {
  const domains = [];
  const excludedDomains = [];

  for (const part of String(raw || '').split(',')) {
    const token = part.trim();
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
