/**
 * youtube-shield.js — YouTube fast path
 * Optimized for sub-frame latency: eager WASM bootstrap, single-owner
 * transport/parsing interception, and short backoff polling for player attach.
 */

import init, {
  process_youtube_player,
  sanitize_youtube_experiments,
} from '../shared/wasm/nullify_core.js';
import { initWasmFromUrl } from '../shared/wasm-loader.js';

(function() {
  const SHIELD_VERSION = 3;

  // ---- Idempotency guard (REVIEW-2026-08 §4.12) ----
  //
  // This bundle is evaluated more than once per frame: registerContentScripts
  // runs it at document_start, and injectIntoOpenTabs re-injects it into
  // already-loaded tabs on install, update, allowlist change and settings
  // change. Each injection is a *separate* script evaluation in the page
  // realm, so the "already installed" marker cannot live in module scope —
  // but it must not live in a fixed-name writable global either: that made
  // `window.__nullifyYoutubeShield = { versions: [0,1,2,3,4,5] }` a one-line
  // page kill switch for every layer below, and published a
  // `{version, startedAt, updatedAt}` fingerprint on every load.
  //
  // Instead the marker is a symbol-keyed, non-enumerable, non-writable,
  // non-configurable brand on the JSON.parse wrapper this shield installs,
  // and it is honoured only when that wrapper still *behaves* like ours.
  // Page script can plant the brand, but planting it without also rewriting
  // ad payload keys to false no longer disables anything — the probe fails
  // and the shield installs over the top.
  const INSTALL_BRAND = Symbol.for('$$jsonParseHookVersion');
  const isShieldInstalled = () => {
    try {
      // Behavioural probe. The randomized payload stops a page from
      // special-casing one fixed probe string: to pass, JSON.parse has to
      // actually neutralize ad payload keys the way the hook below does.
      const probe = JSON.parse(`{"adPlacements":[${Math.random()}]}`);
      if (!probe || probe.adPlacements !== false) return false;
      const installed = JSON.parse[INSTALL_BRAND];
      // A hook that behaves but carries an older brand is a previous shield
      // generation, so let this one install over it. An unbranded hook is
      // treated as installed rather than stacking a second copy of every
      // interceptor on top of it.
      return !(typeof installed === 'number' && installed < SHIELD_VERSION);
    } catch {
      return false;
    }
  };
  if (isShieldInstalled()) return;

  let wasmReady = false;
  let wasmInitStarted = false;
  let wasmInitError = null;
  let wasmSource = null;
  const WASM_ATTR = 'data-nullify-wasm';
  const getRuntimeWasmCandidates = () => {
    try {
      const runtime = globalThis.chrome?.runtime;
      const getURL = runtime?.getURL?.bind(runtime);
      if (typeof getURL !== 'function') return [];

      const paths = [];
      const serviceWorkerPath = runtime.getManifest?.()?.background?.service_worker || '';
      if (serviceWorkerPath) {
        paths.push(serviceWorkerPath.startsWith('dist/') ? 'dist/nullify_core_bg.wasm' : 'nullify_core_bg.wasm');
      }

      // Fallbacks cover both unpacked layouts if getManifest is unavailable in MAIN world.
      paths.push('nullify_core_bg.wasm', 'dist/nullify_core_bg.wasm');

      return [...new Set(paths)].map((path) => ({
        url: getURL(path),
        source: path,
      }));
    } catch {
      return [];
    }
  };
  const getDomWasmCandidates = () => {
    try {
      const url = document.documentElement?.getAttribute(WASM_ATTR);
      return url ? [{ url, source: 'dom' }] : [];
    } catch {
      return [];
    }
  };
  // Endpoints whose bodies get the deep/scrubbed treatment.
  //
  // `/reel_watch_sequence` is the Shorts feed endpoint. uBO gates its Shorts
  // json-prune rule on exactly this URL (`propsToMatch, url:/reel_watch_sequence?`),
  // and its payload is where the `entries.[-]...adClientParams.isAd` ad reels
  // live — without it those responses only ever got the shallow parse path.
  //
  // `/get_video_info` is deliberately *not* in this list any more. YouTube
  // retired that endpoint in 2020 (it has 410'd ever since and no current
  // client calls it), so the check could never match; it is called out here
  // rather than silently dropped so nobody "restores" it later.
  const isYoutubePlayerLikeUrl = (url = '') =>
    url.includes('/v1/player') ||
    url.includes('/v1/next') ||
    url.includes('/get_watch') ||
    url.includes('/reel_watch_sequence');
  const PLAYER_POLL_DELAYS = [50, 100, 200, 400, 800, 1600, 3000];
  const PRUNE_NODE_LIMIT = 10000;

  // ---- Ad key constants ----
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adClientParams'];
  // JS-only fallback rewrites used before WASM is ready on the very first
  // player response. This avoids stalling the request behind WASM startup.
  const adRegex = new RegExp(`"(${AD_KEYS.join('|')})":\\s*(\\[|\\{)`, 'g');
  const YT_FLAG_REPLACEMENTS = [
    ['"web_player_api_v2_server_side_ad_injection":true', '"web_player_api_v2_server_side_ad_injection":false'],
    ['"web_enable_ab_wv_edu":true', '"web_enable_ab_wv_edu":false'],
    ['"web_enable_ad_signals":true', '"web_enable_ad_signals":false'],
    ['"web_player_api_v2_ad_break_heartbeat_params":true', '"web_player_api_v2_ad_break_heartbeat_params":false'],
    ['"web_disable_midroll_ads":false', '"web_disable_midroll_ads":true'],
    ['"web_enable_ab_wv_edu_v2":true', '"web_enable_ab_wv_edu_v2":false'],
    ['"web_enable_ab_wv_edu_v3":true', '"web_enable_ab_wv_edu_v3":false'],
    ['"web_player_api_v2_ads_metadata":true', '"web_player_api_v2_ads_metadata":false'],
    ['"web_enable_ad_break_heartbeat":true', '"web_enable_ad_break_heartbeat":false'],
  ];
  // WASM bootstrap diagnostics. This used to be published on
  // `globalThis.__nullifyYoutubeWasm`, which announced the extension —
  // status, readiness, error text and asset path — to every page on every
  // load (§4.12). Nothing outside this file ever read it, so the state now
  // stays in the closure.
  const wasmState = { status: 'waiting', ready: false, error: null, source: null };
  const updateWasmState = (status) => {
    wasmState.status = status;
    wasmState.ready = status === 'ready';
    wasmState.error = wasmInitError;
    wasmState.source = wasmSource;
  };
  const shouldBlockRequestUrl = (url) =>
    url.includes('/ad_break') ||
    url.includes('/get_attestation') ||
    url.includes('/ad_slot_logging');

  updateWasmState('waiting');

  // 1. Primary prevention — set ad keys to false in any parsed object.
  //
  // Setting to false is safer than deletion or renaming. It keeps the exact
  // keys YouTube's player logic expects, but disables the ads.
  function pruneAdKeys(obj, deep = false, state = null) {
    if (!obj || typeof obj !== 'object') return;
    const pruneState = state || { seen: new WeakSet(), nodes: 0 };
    if (pruneState.seen.has(obj) || pruneState.nodes >= PRUNE_NODE_LIMIT) return;
    pruneState.seen.add(obj);
    pruneState.nodes++;

    for (let i = 0; i < AD_KEYS.length; i++) {
      const key = AD_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        obj[key] = false;
      }
    }

    if (deep) {
      if (obj.playerResponse && typeof obj.playerResponse === 'object') {
        pruneAdKeys(obj.playerResponse, true, pruneState);
      }
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] === 'playerResponse') continue;
        const value = obj[keys[i]];
        if (value && typeof value === 'object') pruneAdKeys(value, true, pruneState);
      }
      return;
    }

    if (obj.playerResponse) pruneAdKeys(obj.playerResponse, false, pruneState);
  }

  function hasAdPayload(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    for (let i = 0; i < AD_KEYS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(obj, AD_KEYS[i])) return true;
    }
    return false;
  }

  // How hard to prune a parsed value. Splitting "shallow" from "deep" matters:
  // the JSON.parse hook is page-global, so an unconditional deep walk would
  // traverse every object youtube.com ever parses. Deep is only licensed once
  // the value has been positively identified as a player envelope.
  const PRUNE_NONE = 0;
  const PRUNE_SHALLOW = 1;
  const PRUNE_DEEP = 2;

  function parsedPruneMode(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return PRUNE_NONE;

    const nested = result.playerResponse;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      // Narrow the page-global JSON.parse hook to known YouTube player-ish
      // shapes — but once one matches, walk the whole envelope. The old code
      // let this gate pass and then ran the *shallow* prune, so a payload like
      // `{playerResponse:{streamingData:{}, <container>:{adPlacements:[…]}}}`
      // was recognised as a player response and then left untouched: the
      // shallow walk only looks at `result` and `result.playerResponse`.
      if (
        hasAdPayload(nested) ||
        nested.playabilityStatus ||
        nested.streamingData ||
        nested.videoDetails ||
        nested.microformat ||
        nested.responseContext
      ) {
        return PRUNE_DEEP;
      }
    }

    // Bare ad keys on some other page JSON: neutralize them in place, but do
    // not let that license a deep walk of an arbitrary object.
    return hasAdPayload(result) ? PRUNE_SHALLOW : PRUNE_NONE;
  }

  // ---- Path-targeted pruning (uBO parity) ----
  //
  // pruneAdKeys() only knows key *names*, so an entire ad surface that hides
  // behind a nested renderer chain walks straight past it: a Shorts ad reel is
  // an `entries[]` element, a feed ad is a `richItemRenderer` wrapping an
  // `adSlotRenderer`, and neither carries any AD_KEYS name at a level the
  // shallow walk visits. uBO handles these by explicit path, so we ship the
  // same paths, verbatim from its rules.
  //
  // Segment grammar (uBO's json-prune):
  //   `[]`  — recurse into every array element, leaving the array intact
  //   `[-]` — recurse into every array element and SPLICE OUT the elements for
  //           which the remainder of the path resolves
  //   anything else — a literal own key
  const AD_PATHS = [
    // Shorts ad reels. uBO:
    //   ##+js(json-prune, entries.[-].command.reelWatchEndpoint.adClientParams.isAd)
    //   ##+js(json-prune-fetch-response,
    //         reelWatchSequenceResponse.entries.[-].command.reelWatchEndpoint.adClientParams.isAd
    //         entries.[-].command.reelWatchEndpoint.adClientParams.isAd, ,
    //         propsToMatch, url:/reel_watch_sequence?)
    'entries.[-].command.reelWatchEndpoint.adClientParams.isAd',
    'reelWatchSequenceResponse.entries.[-].command.reelWatchEndpoint.adClientParams.isAd',
    // Homepage feed ad slots, inside the browse response's rich grid.
    'contents.twoColumnBrowseResultsRenderer.tabs.[].tabRenderer.content.richGridRenderer.contents.[-].richItemRenderer.content.adSlotRenderer',
    // Premium upsell nag. uBO:
    //   ##+js(json-prune, auxiliaryUi.messageRenderers.upsellDialogRenderer)
    'auxiliaryUi.messageRenderers.upsellDialogRenderer',
    // Array-wrapped player responses (batched innertube payloads), which the
    // `result.playerResponse` gate above cannot see because the root is an array.
    '[].playerResponse.adPlacements',
    '[].playerResponse.adSlots',
  ].map((path) => path.split('.'));

  const isUnsafePathKey = (key) =>
    key === '__proto__' || key === 'constructor' || key === 'prototype';

  // Existence probe for the tail of a `[-]` path — uBO's objectFindOwnerFn with
  // pruning off. Recursion depth is bounded by the (fixed, hand-written) path
  // length, so a cyclic object cannot run away here the way it could in the
  // key-based walk; breadth is what needs a ceiling, hence the shared budget.
  function pathResolves(target, parts, index, state) {
    let current = target;
    let at = index;
    for (;;) {
      if (!current || typeof current !== 'object') return false;
      if (state.nodes >= PRUNE_NODE_LIMIT) return false;
      state.nodes++;

      const part = parts[at];
      if (isUnsafePathKey(part)) return false;
      const isLast = at === parts.length - 1;

      if (part === '[]' || part === '[-]') {
        if (!Array.isArray(current)) return false;
        if (isLast) return current.length > 0;
        for (let i = 0; i < current.length; i++) {
          if (pathResolves(current[i], parts, at + 1, state)) return true;
        }
        return false;
      }

      if (isLast) return Object.prototype.hasOwnProperty.call(current, part);
      current = current[part];
      at++;
    }
  }

  function pruneAdPath(target, parts, index, state) {
    if (!target || typeof target !== 'object') return false;
    if (state.nodes >= PRUNE_NODE_LIMIT) return false;
    state.nodes++;

    const part = parts[index];
    if (isUnsafePathKey(part)) return false;
    const isLast = index === parts.length - 1;

    if (part === '[-]') {
      if (!Array.isArray(target)) return false;
      // uBO's `[-]` semantics are element *removal*, not key neutralization,
      // and we match uBO here rather than following our usual "set to false"
      // convention: a Shorts entry whose reelWatchEndpoint is flagged `isAd`,
      // or a rich-grid item whose content is an adSlotRenderer, is an ad and
      // nothing else — neutering one key would leave an empty husk occupying a
      // slot in the sequence/feed, which is exactly the artefact uBO avoids by
      // splicing. Iterate backwards so splicing does not skip elements.
      let removed = false;
      for (let i = target.length - 1; i >= 0; i--) {
        if (isLast || pathResolves(target[i], parts, index + 1, state)) {
          target.splice(i, 1);
          removed = true;
        }
      }
      return removed;
    }

    if (part === '[]') {
      if (!Array.isArray(target)) return false;
      let pruned = false;
      for (let i = 0; i < target.length; i++) {
        if (isLast) {
          target[i] = false;
          pruned = true;
        } else if (pruneAdPath(target[i], parts, index + 1, state)) {
          pruned = true;
        }
      }
      return pruned;
    }

    if (isLast) {
      if (!Object.prototype.hasOwnProperty.call(target, part)) return false;
      // Ordinary leaves keep our convention: neutralize in place so YouTube's
      // player still finds the schema it expects.
      target[part] = false;
      return true;
    }
    return pruneAdPath(target[part], parts, index + 1, state);
  }

  // Cheap root gate: every path starts with either a literal key or an array
  // wildcard, so one hasOwnProperty (or Array.isArray) test per path keeps the
  // page-global JSON.parse hook off the hot path for the overwhelming majority
  // of payloads, which carry none of these surfaces.
  function pruneAdPaths(result) {
    if (!result || typeof result !== 'object') return;
    const rootIsArray = Array.isArray(result);
    let state = null;
    for (let i = 0; i < AD_PATHS.length; i++) {
      const parts = AD_PATHS[i];
      const root = parts[0];
      if (root === '[]' || root === '[-]') {
        if (!rootIsArray) continue;
      } else if (rootIsArray || !Object.prototype.hasOwnProperty.call(result, root)) {
        continue;
      }
      if (state === null) state = { nodes: 0 };
      pruneAdPath(result, parts, 0, state);
    }
  }

  const prunePayload = (result) => {
    const mode = parsedPruneMode(result);
    if (mode !== PRUNE_NONE) pruneAdKeys(result, mode === PRUNE_DEEP);
    pruneAdPaths(result);
    return result;
  };

  // 1a. JSON.parse hook — THE critical interception layer.
  //
  // This runs synchronously at document_start before ANY YouTube code executes,
  // so it intercepts every JSON.parse call the page makes, including:
  //   • /v1/player and /get_watch API response parsing (in fetch/XHR callbacks)
  //   • /v1/next SPA navigation responses with embedded playerResponse
  //   • Any other JSON path containing ad data
  //
  // This is how uBlock Origin's json-prune scriptlet works — except here it's
  // installed synchronously in MAIN world before any async round-trip to the SW,
  // closing the timing window where ads could slip through.
  const _origJSONParse = JSON.parse;
  JSON.parse = function(text, ...rest) {
    const result = _origJSONParse.call(this, text, ...rest);
    return prunePayload(result);
  };
  // Locked idempotency brand — see isShieldInstalled() above. Non-enumerable
  // so it stays out of Object.keys/JSON output, non-writable and
  // non-configurable so a later page script cannot forge a newer generation
  // onto our own wrapper.
  try {
    Object.defineProperty(JSON.parse, INSTALL_BRAND, {
      value: SHIELD_VERSION,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch {
    // Branding is best effort; the behavioural probe still detects the hook.
  }

  // 1b. Response.json hook — keep the scope narrow and let JSON.parse handle
  // text-backed consumers. The broader text()/arrayBuffer() hooks were touching
  // too much page traffic for little gain.
  if (window.Response?.prototype) {
    const _origResponseJson = Response.prototype.json;
    Response.prototype.json = async function(...args) {
      const result = await _origResponseJson.apply(this, args);
      if (isYoutubePlayerLikeUrl(this.url)) {
        pruneAdKeys(result, true);
        pruneAdPaths(result);
        return result;
      }
      return prunePayload(result);
    };
  }

  // 2. WASM Initialization
  const bootstrapWasm = (candidates) => {
    if (wasmReady || wasmInitStarted || candidates.length === 0) return;
    wasmInitStarted = true;
    wasmInitError = null;
    updateWasmState('loading');

    const initPromise = (async () => {
      let lastError = null;
      for (const candidate of candidates) {
        wasmSource = candidate.source;
        updateWasmState('loading');
        try {
          await initWasmFromUrl(init, candidate.url);
          return candidate.source;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError || new Error('No usable WASM URL');
    })();

    initPromise.then((source) => {
      wasmReady = true;
      wasmInitError = null;
      wasmSource = source;
      updateWasmState('ready');
      console.info(`[Nullify] YouTube WASM ready (${wasmSource || 'unknown'})`);
      try {
        // Same store resolution as the synchronous belt layer (§4.25) — the
        // old `window.ytcfg?.config_` check never matched a real page, so the
        // extra flags WASM covers were never applied to the live config.
        poisonCfgStores(window.ytcfg);
      } catch {
        // Ignore late config poisoning failures.
      }
    }).catch((err) => {
      wasmInitStarted = false;
      wasmInitError = err?.message || String(err);
      updateWasmState('error');
      console.error('[Nullify] WASM init failed:', err);
    });
  };
  const startWasmBootstrap = () => {
    const candidates = getRuntimeWasmCandidates().concat(getDomWasmCandidates());
    if (candidates.length === 0) return false;
    bootstrapWasm(candidates);
    return true;
  };
  if (!startWasmBootstrap()) {
    const root = document.documentElement;
    if (root) {
      const attrObs = new MutationObserver(() => {
        if (!startWasmBootstrap()) return;
        attrObs.disconnect();
      });
      attrObs.observe(root, { attributes: true, attributeFilter: [WASM_ATTR] });
    }
  }

  // 3. Response Scrubber
  // String scrubbers run on every player-like body we can materialize — the
  // XHR responseText path and (see 3b) the fetch path.
  //
  // The previous note here argued that fetch bodies must be left alone because
  // YouTube retries when "the transport payload is modified". That rationale is
  // about *replaying a request* — re-issuing it so the response can be read
  // twice — not about rewriting a response body we are already holding. With
  // fetch left out entirely, `scrub()` had exactly one call site (the XHR text
  // path) while modern YouTube fetches `/youtubei/v1/player`, so on a real page
  // the WASM string neutralizer effectively never ran.
  //
  // JS string pre-check is still useful for XHR/responseText paths, where the
  // browser has already materialized a string.
  const _ytMutations = [
    '"adPlacements"', '"playerAds"', '"adSlots"',
    '"adBreakHeartbeatParams"', '"adClientParams"',
    '"web_player_api_v2_server_side_ad_injection":true',
    '"web_enable_ab_wv_edu":true',
    '"web_enable_ad_signals":true',
    '"web_player_api_v2_ad_break_heartbeat_params":true',
    '"web_disable_midroll_ads":false',
    '"web_enable_ab_wv_edu_v2":true',
    '"web_enable_ab_wv_edu_v3":true',
    '"web_player_api_v2_ads_metadata":true',
    '"web_enable_ad_break_heartbeat":true',
  ];
  const _hasYoutubeMutations = (text) => {
    for (let i = 0; i < _ytMutations.length; i++) {
      if (text.includes(_ytMutations[i])) return true;
    }
    return false;
  };

  const fallbackScrub = (text) => {
    let mutated = text.replace(adRegex, '"$1":false,"disabled_$1":$2');
    for (let i = 0; i < YT_FLAG_REPLACEMENTS.length; i++) {
      const [from, to] = YT_FLAG_REPLACEMENTS[i];
      if (mutated.includes(from)) mutated = mutated.replaceAll(from, to);
    }
    return mutated;
  };

  const scrub = (data) => {
    if (!data) return data;
    try {
      if (typeof data === 'string') {
        if (data.length < 20) return data;
        if (wasmReady) {
          // Fast JS pre-check: skip WASM boundary copy entirely for clean responses.
          // process_youtube_player() still handles the replacement pass when needed.
          if (!_hasYoutubeMutations(data)) return data;
          const cleaned = process_youtube_player(data);
          return cleaned || data;
        }
        if (!_hasYoutubeMutations(data)) return data;
        return fallbackScrub(data);
      }
      return data;
    } catch { return data; }
  };

  // 3b. Fetch body scrubber
  //
  // `Response.prototype.json` (1b) already deep-prunes the parsed object, so
  // the remaining hole is a player fetch whose body is read via `.text()` or
  // `.arrayBuffer()` — those never touch our parse hooks at all. Close it by
  // handing back a Response whose body is the scrubbed string.
  //
  // Deliberately narrow, so nothing outside the player path is reconstructed:
  //   • player-like URLs only,
  //   • text-like content types only, with a size ceiling,
  //   • the body is read from a `clone()`, so an unchanged payload is returned
  //     as the *original* Response with its stream still unread,
  //   • `ok`/`status`/`statusText`/`redirected`/`type`/`url` are carried over so
  //     page code branching on them cannot tell the difference.
  const PLAYER_BODY_LIMIT = 8 * 1024 * 1024;
  const TEXT_LIKE_CONTENT_TYPES = [
    'application/json', 'text/', 'application/javascript', 'application/xml',
  ];
  const isTextLikeResponse = (response) => {
    try {
      const contentType = response.headers?.get?.('content-type') || '';
      for (let i = 0; i < TEXT_LIKE_CONTENT_TYPES.length; i++) {
        if (contentType.includes(TEXT_LIKE_CONTENT_TYPES[i])) return true;
      }
    } catch {
      // An exotic/throwing headers object is treated as "not text".
    }
    return false;
  };

  const rebuildResponse = (response, body) => {
    // The rebuilt body is raw text, so the byte-level headers describing the
    // original (likely compressed) stream no longer apply to it.
    let headers = response.headers;
    try {
      headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
    } catch {
      // Fall back to the original header set.
    }

    const rebuilt = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    try {
      // `new Response` always reports ok/redirected/type/url for a synthetic
      // response; carry the real ones over so the page sees no difference.
      Object.defineProperties(rebuilt, {
        ok: { value: response.ok },
        redirected: { value: response.redirected },
        type: { value: response.type },
        url: { value: response.url },
      });
    } catch {
      // Best effort — the scrubbed body is what actually matters.
    }
    return rebuilt;
  };

  const scrubPlayerResponse = async (response) => {
    try {
      if (!response || typeof response.text !== 'function') return response;
      // Opaque and body-less responses carry nothing to scrub, and the Response
      // constructor rejects a status outside 200-599 or a body on 204/205/304.
      const status = response.status;
      if (!(status >= 200 && status <= 599)) return response;
      if (status === 204 || status === 205 || status === 304) return response;
      if (response.type === 'opaque' || response.type === 'opaqueredirect') return response;
      if (response.bodyUsed) return response;
      if (!isTextLikeResponse(response)) return response;
      const declaredLength = Number.parseInt(response.headers?.get?.('content-length') || '0', 10);
      if (declaredLength > PLAYER_BODY_LIMIT) return response;
      if (typeof response.clone !== 'function') return response;

      const text = await response.clone().text();
      if (typeof text !== 'string' || text.length > PLAYER_BODY_LIMIT) return response;
      const cleaned = scrub(text);
      // Nothing changed: hand back the untouched original, stream still unread.
      if (cleaned === text) return response;
      return rebuildResponse(response, cleaned);
    } catch {
      // Any failure leaves the original response exactly as the network gave it.
      return response;
    }
  };

  // 4. Identity Trap-Defuser
  const ok = () => Promise.resolve({ state: 'granted' });
  if (document.requestStorageAccess) document.requestStorageAccess = ok;
  if (document.requestStorageAccessFor) document.requestStorageAccessFor = ok;

  // 5. Network Interceptor — fetch
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';

    // Pre-flight block: return empty response without hitting network.
    // These are exact fixed endpoints, so crossing the JS->WASM boundary here
    // adds overhead without buying more coverage.
    const blocked = shouldBlockRequestUrl(url);
    if (blocked) {
      return new Response('{}', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    }

    const response = await origFetch.call(this, input, init);
    // The request URL can be relative and the response URL is post-redirect, so
    // check both before spending a clone on the body.
    if (isYoutubePlayerLikeUrl(url) || isYoutubePlayerLikeUrl(response?.url || '')) {
      return scrubPlayerResponse(response);
    }
    return response;
  };

  // 5b. Network Interceptor — XMLHttpRequest
  // YouTube fires player requests via XHR on SPA navigations and some player
  // paths. Without this, those responses bypass scrubbing entirely and ads
  // that slip through fetch interception still render.
  // Strategy: subclass XHR, override the response getters to return the
  // scrubbed version lazily (memoised per-request so re-reads don't re-scrub).
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends OrigXHR {
    constructor() {
      super();
      this._nUrl = '';
      this._nCached = null;
      this._nBlocked = false;
    }

    open(method, url, ...args) {
      this._nUrl = typeof url === 'string' ? url : '';
      this._nCached = null;
      this._nBlocked = false;
      return super.open(method, url, ...args);
    }

    // Pre-flight block — abort ad-only XHR requests before they reach the network.
    send(...args) {
      const url = this._nUrl;
      const block = shouldBlockRequestUrl(url);
      if (block) {
        this._nBlocked = true;
        this._nCached = '{}';
        // Synthesize a completed empty JSON response for ad-only endpoints.
        setTimeout(() => {
          this.dispatchEvent(new Event('readystatechange'));
          this.dispatchEvent(new ProgressEvent('load'));
          this.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
        return;
      }
      return super.send(...args);
    }

    _isPlayerText() {
      return this.readyState === 4 &&
             (this.responseType === '' || this.responseType === 'text') &&
             isYoutubePlayerLikeUrl(this._nUrl);
    }

    _isPlayerJson() {
      return this.readyState === 4 &&
             this.responseType === 'json' &&
             isYoutubePlayerLikeUrl(this._nUrl);
    }

    _scrubbed() {
      if (this._nCached === null) {
        let original = '';
        try {
          original = super.responseText;
          this._nCached = scrub(original);
        } catch {
          this._nCached = original || super.responseText;
        }
      }
      return this._nCached;
    }

    get responseText() {
      if (this._nBlocked) return this._nCached;
      return this._isPlayerText() ? this._scrubbed() : super.responseText;
    }

    get response() {
      if (this._nBlocked) {
        if (this.responseType === 'json') return JSON.parse(this._nCached);
        return this._nCached;
      }
      const r = super.response;
      if (this._isPlayerJson()) {
        pruneAdKeys(r, true);
        pruneAdPaths(r);
        return r;
      }
      return (this._isPlayerText() && typeof r === 'string') ? this._scrubbed() : r;
    }

    get readyState() {
      return this._nBlocked ? 4 : super.readyState;
    }

    get status() {
      return this._nBlocked ? 200 : super.status;
    }

    get statusText() {
      return this._nBlocked ? 'OK' : super.statusText;
    }

    get responseURL() {
      return this._nBlocked ? this._nUrl : super.responseURL;
    }
  };

  // 6. Variable Shield — neutralize ad fields on assignment.
  //
  // youtube-shield.js runs at document_start before YouTube's inline <script>
  // tags, so Object.defineProperty is called before YouTube's code assigns
  // ytInitialPlayerResponse. When the assignment fires, the setter pruneAdKeys
  // the object in-place before storing it — the player never sees ad data.
  //
  // Keeping the keys present but forcing them to false matches the network/WASM
  // scrubbers and avoids YouTube fallback paths that key off schema changes.
  const shield = (prop) => {
    let _val = window[prop];
    if (_val) pruneAdKeys(_val);
    Object.defineProperty(window, prop, {
      get: () => _val,
      set: (v) => { pruneAdKeys(v); _val = v; },
      configurable: true,
    });
  };
  ['ytInitialPlayerResponse', 'playerResponse', 'ytInitialData', 'initialPlayerResponse'].forEach(shield);

  // 7. ytcfg Experiment Poisoning
  //
  // Always apply the core flag overrides synchronously — no WASM dependency.
  // WASM adds coverage for additional flags when it's ready, but the five
  // critical SSAI/ad-break flags are flipped immediately so they're in place
  // before the player initializes, regardless of WASM load timing.
  const POISON_FLAGS = {
    web_player_api_v2_server_side_ad_injection: false,
    web_enable_ab_wv_edu: false,
    web_enable_ab_wv_edu_v2: false,
    web_enable_ab_wv_edu_v3: false,
    web_enable_ad_signals: false,
    web_player_api_v2_ad_break_heartbeat_params: false,
    web_disable_midroll_ads: true,
    web_player_api_v2_ads_metadata: false,
    web_enable_ad_break_heartbeat: false,
  };
  const sanitizedExperimentFlagSets = new WeakSet();
  const poison = (cfg) => {
    const flags = cfg?.EXPERIMENT_FLAGS;
    if (!flags || typeof flags !== 'object') return;
    // Synchronous baseline — always runs, no WASM dependency.
    Object.assign(flags, POISON_FLAGS);
    // WASM extends coverage to any additional flags we may have missed.
    if (!wasmReady || sanitizedExperimentFlagSets.has(flags)) return;
    try {
      const sanitized = JSON.parse(
        sanitize_youtube_experiments(JSON.stringify({ EXPERIMENT_FLAGS: flags }))
      );
      if (sanitized?.EXPERIMENT_FLAGS) {
        Object.assign(flags, sanitized.EXPERIMENT_FLAGS);
      }
      sanitizedExperimentFlagSets.add(flags);
    } catch {}
  };

  // Where the flags actually live (REVIEW-2026-08 §4.25). Real YouTube never
  // keeps the store on `ytcfg.config_`: `ytcfg.d()` returns `window.yt.config_`
  // and older/alternate builds back it with `ytcfg.data_`. Poisoning only
  // `cfg.config_` made the whole belt layer — and the WASM-ready re-poison —
  // a no-op against the real page. Collect every store shape we can see and
  // poison all of them; they are usually the same object anyway.
  const collectCfgStores = (cfg) => {
    const stores = [];
    const add = (store) => {
      if (store && typeof store === 'object' && !stores.includes(store)) stores.push(store);
    };
    try {
      if (cfg && typeof cfg === 'object') {
        add(cfg.config_);
        add(cfg.data_);
      }
    } catch {
      // A throwing accessor on the page's ytcfg must not break the hook.
    }
    try {
      add(globalThis.yt?.config_);
    } catch {
      // Same for window.yt.
    }
    return stores;
  };
  const poisonCfgStores = (cfg) => {
    const stores = collectCfgStores(cfg);
    for (let i = 0; i < stores.length; i++) poison(stores[i]);
  };

  const wrappedYtcfgSetters = new WeakSet();
  const hookYtcfg = (cfg) => {
    if (!cfg || typeof cfg !== 'object') return;
    if (typeof cfg.set === 'function' && !wrappedYtcfgSetters.has(cfg.set)) {
      const origSet = cfg.set;
      const wrappedSet = function(config, ...args) {
        if (config) poison(config);
        return origSet.apply(this, [config, ...args]);
      };
      wrappedYtcfgSetters.add(wrappedSet);
      cfg.set = wrappedSet;
    }
    poisonCfgStores(cfg);
  };

  // `window.yt.config_` is the store `ytcfg.d()` reads on the real page, and
  // the page can seed it by direct assignment without ever calling
  // `ytcfg.set` — the case the .set wrapper cannot see. Trap it the same way
  // shield() traps the player-response globals: once at the `window.yt`
  // assignment, and again at the `config_` assignment on whatever object the
  // page installs there.
  const hookYt = (yt) => {
    try {
      if (!yt || typeof yt !== 'object') return;
      let store = yt.config_;
      // Whatever is already there gets poisoned now; the trap below then
      // catches both the first seeding and any later wholesale replacement.
      if (store && typeof store === 'object') poison(store);
      const existing = Object.getOwnPropertyDescriptor(yt, 'config_');
      if (existing && !existing.configurable) return;
      Object.defineProperty(yt, 'config_', {
        get: () => store,
        set: (v) => {
          store = v;
          try {
            poison(v);
          } catch {
            // Never let poisoning failures break the page's assignment.
          }
        },
        enumerable: true,
        configurable: true,
      });
    } catch {
      // A sealed or exotic `yt` object is left alone.
    }
  };

  if (globalThis.yt) {
    hookYt(globalThis.yt);
  } else {
    let _ytValue;
    try {
      Object.defineProperty(window, 'yt', {
        get: () => _ytValue,
        set: (v) => {
          _ytValue = v;
          hookYt(v);
        },
        configurable: true,
      });
    } catch {
      // Leave a non-configurable page-owned `yt` in place.
    }
  }

  if (window.ytcfg) {
    // Late-injection path (already-loaded tab): ytcfg exists — hook it now.
    hookYtcfg(window.ytcfg);
  } else {
    // Fresh navigation: this script runs at document_start, before any page
    // script has defined ytcfg, so checking window.ytcfg once here can never
    // fire. Trap the assignment instead (same technique as shield() above):
    // the moment YouTube's inline script assigns ytcfg we wrap .set and
    // poison whatever config it already carries.
    let _ytcfgValue;
    Object.defineProperty(window, 'ytcfg', {
      get: () => _ytcfgValue,
      set: (v) => {
        _ytcfgValue = v;
        try {
          hookYtcfg(v);
        } catch {
          // Never let poisoning failures break the page's ytcfg assignment.
        }
      },
      configurable: true,
    });
  }

  // 8. Zero-Latency Ad Skipper — MutationObserver reacts immediately when
  //    YouTube toggles ad classes on #movie_player. A short backoff poll is
  //    only used to discover or rediscover the player element.
  //
  //    Skip priority:
  //      1. Click the skip button (YouTube's own UI — cleanest, no side effects)
  //      2. Call skipVideoAd() internal API
  //      3. Mute + high playback rate (stays in buffered range)
  //      4. Seek to end ONLY if that position is already buffered
  //         — avoids "Experiencing interruptions?" which is caused by seeking
  //           to an unbuffered position.

  let _playbackSnapshot = null;

  const isVisibleElement = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      (!Number.isNaN(opacity) && opacity <= 0)
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const queryVisible = (root, selector) => {
    const elements = root.querySelectorAll(selector);
    for (let i = 0; i < elements.length; i++) {
      if (isVisibleElement(elements[i])) return elements[i];
    }
    return null;
  };

  const capturePlaybackSnapshot = (video) => {
    if (_playbackSnapshot?.video === video) return;
    _playbackSnapshot = {
      video,
      muted: video.muted,
      playbackRate: video.playbackRate,
    };
  };

  const doSkip = (player) => {
    const video = player.querySelector('video');
    if (!video) return;

    // 1. Skip button (shown for skippable ads after 5 s)
    const skipBtn = queryVisible(player,
      '.ytp-skip-ad-button:not([style*="display:none"]), ' +
      '.ytp-ad-skip-button-container button, ' +
      '.ytp-ad-skip-button, ' +
      '.ytp-ad-skip-button-modern, ' +
      'button[class*="skip"][class*="ad"]'
    );
    if (skipBtn) {
      skipBtn.click();
      return;
    }

    const closeOverlay = queryVisible(player,
      '.ytp-ad-overlay-close-button, ' +
      '.ytp-ad-image-overlay-close-button'
    );
    if (closeOverlay) {
      closeOverlay.click();
    }

    // 2. YouTube internal API
    if (typeof player.skipVideoAd === 'function') {
      player.skipVideoAd();
      return;
    }

    // 3. Speed-through (stays within whatever is buffered)
    capturePlaybackSnapshot(video);
    if (!video.muted) video.muted = true;
    if (video.playbackRate < 16) video.playbackRate = 16;

    // 4. Seek only if the target position is already in the browser's buffer.
    //    Seeking to an unbuffered range triggers Chrome's stall detector and
    //    shows "Experiencing interruptions?" — so we guard on buffered.end.
    if (video.duration > 0 && isFinite(video.duration) && video.buffered.length > 0) {
      const target = video.duration - 0.5;
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      if (bufferedEnd >= target) video.currentTime = target;
    }
  };

  const isAdShowing = (player) => {
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
      return true;
    }
    return !!queryVisible(player,
      '.ad-showing, ' +
      '.ytp-ad-player-overlay, ' +
      '.ytp-ad-preview-container, ' +
      '.ytp-ad-text, ' +
      '.ytp-ad-module, ' +
      '.video-ads .ytp-ad-image-overlay, ' +
      '.ytp-ad-skip-button, ' +
      '.ytp-ad-skip-button-modern'
    );
  };

  const restorePlayback = (player) => {
    if (!_playbackSnapshot) return;
    const video = player.querySelector('video');
    if (!video) {
      _playbackSnapshot = null;
      return;
    }
    if (_playbackSnapshot.video === video) {
      if (video.muted !== _playbackSnapshot.muted) video.muted = _playbackSnapshot.muted;
      if (video.playbackRate !== _playbackSnapshot.playbackRate) {
        video.playbackRate = _playbackSnapshot.playbackRate;
      }
    }
    _playbackSnapshot = null;
  };

  let _adObs = null;
  let _observedPlayer = null;
  let _playerPollTimer = null;
  let _playerPollIndex = 0;
  let _adLoopTimer = null;
  let _adStateFrame = null;

  const stopAdLoop = () => {
    if (_adLoopTimer) {
      clearTimeout(_adLoopTimer);
      _adLoopTimer = null;
    }
    if (_adStateFrame !== null) {
      window.cancelAnimationFrame(_adStateFrame);
      _adStateFrame = null;
    }
  };

  const runAdLoop = (player) => {
    if (player !== _observedPlayer || !isAdShowing(player)) {
      stopAdLoop();
      restorePlayback(player);
      return;
    }

    doSkip(player);
    if (!_adLoopTimer) {
      _adLoopTimer = setTimeout(() => {
        _adLoopTimer = null;
        runAdLoop(player);
      }, 150);
    }
  };

  const handlePlayerAdState = (player) => {
    if (isAdShowing(player)) {
      runAdLoop(player);
    } else {
      stopAdLoop();
      restorePlayback(player);
    }
  };

  const schedulePlayerAdState = (player) => {
    if (_adStateFrame !== null) return;
    _adStateFrame = window.requestAnimationFrame(() => {
      _adStateFrame = null;
      handlePlayerAdState(player);
    });
  };

  const stopPlayerPoll = () => {
    if (_playerPollTimer) {
      clearTimeout(_playerPollTimer);
      _playerPollTimer = null;
    }
  };

  const attachToPlayer = (player) => {
    if (player === _observedPlayer) return;
    if (_adObs) _adObs.disconnect();
    stopAdLoop();
    stopPlayerPoll();
    _observedPlayer = player;

    _adObs = new MutationObserver(() => schedulePlayerAdState(player));
    _adObs.observe(player, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      childList: true,
      subtree: true,
    });

    // Fire immediately in case the page loaded mid-ad
    handlePlayerAdState(player);
  };

  // Find #movie_player using a short backoff poll instead of a fixed interval.
  // A full-subtree observer on YouTube's SPA generates thousands of callbacks
  // per navigation, and a fixed 50ms loop keeps running longer than needed.
  const pollForPlayer = () => {
    const player = document.querySelector('#movie_player');
    if (!player) return false;
    attachToPlayer(player);
    return true;
  };

  const schedulePlayerPoll = (reset = false) => {
    if (reset) {
      stopPlayerPoll();
      _playerPollIndex = 0;
    }
    if (pollForPlayer()) return;
    if (_playerPollTimer || _playerPollIndex >= PLAYER_POLL_DELAYS.length) return;
    const delay = PLAYER_POLL_DELAYS[_playerPollIndex++];
    _playerPollTimer = setTimeout(() => {
      _playerPollTimer = null;
      schedulePlayerPoll(false);
    }, delay);
  };

  schedulePlayerPoll(true);
  window.addEventListener('yt-navigate-finish', () => schedulePlayerPoll(true));
  window.addEventListener('yt-page-data-updated', () => schedulePlayerPoll(true));

  // Background tabs: the bounded chain above (~6.15 s total) can expire before
  // a hidden tab ever constructs its player, and re-arming depended only on
  // yt-navigate events — which focusing a tab does not fire. Re-arm the poll
  // when the tab becomes visible and no player is hooked yet, so the DOM
  // ad-skipper recovers instead of staying dead for the tab's lifetime.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !_observedPlayer) {
      schedulePlayerPoll(true);
    }
  });
})();
