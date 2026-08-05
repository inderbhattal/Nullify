import { getExtraArgs, patternToRegex } from './shared-utils.js';

/**
 * replace-node-text.js — Rewrite (or blank) the text of DOM nodes whose name
 * matches, in place, as they are parsed.
 *
 * uBO ships two entry points over one core:
 *   remove-node-text  / rmnt  (nodeName, includes, ...varargs)
 *   replace-node-text / rpnt  (nodeName, pattern, replacement, ...varargs)
 *
 * §5.22: 832 `rmnt` + 5 `remove-node-text` + 250 `rpnt` + 24 trusted-spelled
 * rules named these and resolved to nothing — 8.1% of the corpus, the single
 * largest unimplemented group after `trusted-set-cookie`.
 *
 * Varargs: `includes`/`condition`, `excludes`, `sedCount`, `stay`, `quitAfter`.
 */
function replaceNodeTextCore(nodeName, pattern, replacement, extraArgs) {
  const reNodeName = patternToRegex(nodeName, 'i', true);
  const rePattern = patternToRegex(pattern, 'gms');
  if (reNodeName === null || rePattern === null) return;
  const includes = extraArgs.includes || extraArgs.condition;
  const reIncludes = includes ? patternToRegex(includes, 'ms') : null;
  const reExcludes = extraArgs.excludes ? patternToRegex(extraArgs.excludes, 'ms') : null;

  let sedCount = extraArgs.sedCount || 0;
  let observer = null;

  /** @returns {boolean} whether to keep going. */
  const handleNode = (node) => {
    const before = node.textContent;
    if (reIncludes) {
      reIncludes.lastIndex = 0;
      if (reIncludes.test(before) === false) return true;
    }
    if (reExcludes) {
      reExcludes.lastIndex = 0;
      if (reExcludes.test(before)) return true;
    }
    rePattern.lastIndex = 0;
    if (rePattern.test(before) === false) return true;
    rePattern.lastIndex = 0;
    // An empty pattern means "replace the whole text", which is how
    // remove-node-text blanks a matching <script>.
    node.textContent = pattern !== '' ? before.replace(rePattern, replacement) : replacement;
    return sedCount === 0 || (sedCount -= 1) !== 0;
  };

  const handleMutations = (mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (reNodeName.test(node.nodeName) === false) continue;
        if (handleNode(node)) continue;
        observer?.disconnect();
        observer = null;
        return;
      }
    }
  };

  const stop = () => {
    if (observer === null) return;
    handleMutations(observer.takeRecords());
    observer?.disconnect();
    observer = null;
  };

  observer = new MutationObserver(handleMutations);
  observer.observe(document, { childList: true, subtree: true });

  if (document.documentElement) {
    // SHOW_ELEMENT | SHOW_TEXT. The numeric fallback keeps the walker working
    // in a host that exposes createTreeWalker without the NodeFilter global.
    const showElementOrText = (globalThis.NodeFilter?.SHOW_ELEMENT ?? 0x1)
      | (globalThis.NodeFilter?.SHOW_TEXT ?? 0x4);
    const treeWalker = document.createTreeWalker(document.documentElement, showElementOrText);
    for (;;) {
      const node = treeWalker.nextNode();
      if (node === null) break;
      if (reNodeName.test(node.nodeName) === false) continue;
      if (node === document.currentScript) continue;
      if (handleNode(node)) continue;
      stop();
      break;
    }
  }

  if (extraArgs.stay) return;
  // uBO stops at the interactive stage: a scriptlet that rewrites every node
  // added for the tab's lifetime is a permanent cost on a live page.
  const quit = () => {
    const quitAfter = extraArgs.quitAfter || 0;
    if (quitAfter !== 0) setTimeout(stop, quitAfter);
    else stop();
  };
  if (document.readyState !== 'loading') {
    quit();
    return;
  }
  const onStateChange = () => {
    if (document.readyState === 'loading') return;
    document.removeEventListener('readystatechange', onStateChange, true);
    quit();
  };
  document.addEventListener('readystatechange', onStateChange, true);
}

/** uBO `remove-node-text` / `rmnt`. */
export function removeNodeText(nodeName, includes, ...args) {
  // uBO passes `includes` as the first vararg, so an explicit `includes`
  // vararg later in the list still wins.
  const extraArgs = { includes: includes || '', ...getExtraArgs(args, 0) };
  // Deviation from uBO, deliberately: with no `includes` needle the pattern
  // matches everything and every node of that name is blanked. Upstream
  // accepts that (its logger-only mode covers the case); here a one-token
  // typo would empty every <script> on the page. Every shipped rmnt rule
  // carries a needle, so refusing costs nothing.
  if (!extraArgs.includes && !extraArgs.condition) return;
  replaceNodeTextCore(nodeName, '', '', extraArgs);
}

/** uBO `replace-node-text` / `rpnt` / `trusted-replace-node-text` / `trusted-rpnt`. */
export function replaceNodeText(nodeName, pattern, replacement, ...args) {
  replaceNodeTextCore(nodeName, pattern, replacement ?? '', getExtraArgs(args, 0));
}
