/**
 * youtube-shield.js — YouTube fast path
 * Optimized for sub-frame latency: eager WASM bootstrap, single-owner
 * transport/parsing interception, and short backoff polling for player attach.
 */

import init, {
  process_youtube_player,
  sanitize_youtube_experiments,
} from '../shared/wasm/nullify_core.js';

(function() {
  let wasmReady = false;
  let wasmInitStarted = false;
  let wasmInitError = null;
  let wasmSource = null;
  const getRuntimeWasmUrl = () => {
    try {
      return globalThis.chrome?.runtime?.getURL?.('dist/nullify_core_bg.wasm') || null;
    } catch {
      return null;
    }
  };
  const isPlayerResponseUrl = (url) => url.includes('/v1/player');
  const PLAYER_POLL_DELAYS = [50, 100, 200, 400, 800, 1600, 3000];

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
  const WASM_STATE_KEY = '__nullifyYoutubeWasm';
  const updateWasmState = (status) => {
    globalThis[WASM_STATE_KEY] = {
      status,
      ready: status === 'ready',
      error: wasmInitError,
      source: wasmSource,
    };
    try {
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute('data-nullify-yt-wasm', status);
      if (wasmSource) {
        root.setAttribute('data-nullify-yt-wasm-source', wasmSource);
      } else {
        root.removeAttribute('data-nullify-yt-wasm-source');
      }
    } catch {
      // Ignore page-level debug state failures.
    }
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
  function pruneAdKeys(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (let i = 0; i < AD_KEYS.length; i++) {
      const key = AD_KEYS[i];
      if (obj[key] !== undefined) {
        obj[key] = false;
      }
    }
    if (obj.playerResponse) pruneAdKeys(obj.playerResponse);
  }

  function hasAdPayload(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    for (let i = 0; i < AD_KEYS.length; i++) {
      if (obj[AD_KEYS[i]] !== undefined) return true;
    }
    return false;
  }

  function shouldPruneParsedResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    if (hasAdPayload(result)) return true;

    const nested = result.playerResponse;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return false;

    if (hasAdPayload(nested)) return true;

    // Narrow the page-global JSON.parse hook to known YouTube player-ish shapes.
    return !!(
      nested.playabilityStatus ||
      nested.streamingData ||
      nested.videoDetails ||
      nested.microformat ||
      nested.responseContext
    );
  }

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
    if (shouldPruneParsedResult(result)) {
      pruneAdKeys(result);
    }
    return result;
  };

  // 1b. Response.json hook — keep the scope narrow and let JSON.parse handle
  // text-backed consumers. The broader text()/arrayBuffer() hooks were touching
  // too much page traffic for little gain.
  if (window.Response?.prototype) {
    const _origResponseJson = Response.prototype.json;
    Response.prototype.json = async function(...args) {
      const result = await _origResponseJson.apply(this, args);
      if (isPlayerResponseUrl(this.url) && shouldPruneParsedResult(result)) {
        pruneAdKeys(result);
      }
      return result;
    };
  }

  // 2. WASM Initialization
  const bootstrapWasm = (url, source = null) => {
    if (wasmReady || wasmInitStarted || !url) return;
    wasmInitStarted = true;
    wasmInitError = null;
    wasmSource = source;
    updateWasmState('loading');
    const initPromise = init({ module_or_path: url });
    initPromise.then(() => {
      wasmReady = true;
      wasmInitError = null;
      updateWasmState('ready');
      console.info(`[Nullify] YouTube WASM ready (${wasmSource || 'unknown'})`);
      try {
        if (window.ytcfg?.config_) poison(window.ytcfg.config_);
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
  const resolveWasmModule = () => {
    const runtimeUrl = getRuntimeWasmUrl();
    if (runtimeUrl) return { url: runtimeUrl, source: 'runtime' };
    const attrUrl = document.documentElement?.getAttribute('data-nullify-wasm') || null;
    if (attrUrl) return { url: attrUrl, source: 'dom' };
    return { url: null, source: null };
  };
  const startWasmBootstrap = () => {
    const { url, source } = resolveWasmModule();
    if (!url) return false;
    bootstrapWasm(url, source);
    return true;
  };
  if (!startWasmBootstrap()) {
    const root = document.documentElement;
    if (root) {
      const attrObs = new MutationObserver(() => {
        if (!startWasmBootstrap()) return;
        attrObs.disconnect();
      });
      attrObs.observe(root, { attributes: true, attributeFilter: ['data-nullify-wasm'] });
    }
  }

  // 3. Response Scrubber
  // String scrubbers are kept for XHR/JSON-backed fallback paths. For fetch, we
  // avoid replaying `/v1/player` bodies because YouTube appears to retry when
  // the transport payload is modified, even though parse-time hooks are enough
  // to neutralize ad fields after the response is consumed by the page.
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
    } catch (e) { return data; }
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

    return origFetch.call(this, input, init);
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

    _isPlayer() {
      return this.readyState === 4 &&
             (this.responseType === '' || this.responseType === 'text') &&
             isPlayerResponseUrl(this._nUrl);
    }

    _scrubbed() {
      if (this._nCached === null) {
        let original = '';
        try {
          original = super.responseText;
          this._nCached = scrub(original);
        } catch (e) {
          this._nCached = original || super.responseText;
        }
      }
      return this._nCached;
    }

    get responseText() {
      if (this._nBlocked) return this._nCached;
      return this._isPlayer() ? this._scrubbed() : super.responseText;
    }

    get response() {
      if (this._nBlocked) {
        if (this.responseType === 'json') return JSON.parse(this._nCached);
        return this._nCached;
      }
      const r = super.response;
      return (this._isPlayer() && typeof r === 'string') ? this._scrubbed() : r;
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
    } catch (e) {}
  };

  if (window.ytcfg?.set) {
    const origSet = window.ytcfg.set;
    window.ytcfg.set = function(cfg, ...args) {
      if (cfg) poison(cfg);
      return origSet.apply(this, [cfg, ...args]);
    };
    if (window.ytcfg.config_) poison(window.ytcfg.config_);
  } else if (window.ytcfg?.config_) {
    poison(window.ytcfg.config_);
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

  const doSkip = (player) => {
    const video = player.querySelector('video');
    if (!video) return;

    // 1. Skip button (shown for skippable ads after 5 s)
    const skipBtn = player.querySelector(
      '.ytp-skip-ad-button:not([style*="display:none"]), ' +
      '.ytp-ad-skip-button-container button, ' +
      '.ytp-ad-skip-button'
    );
    if (skipBtn && skipBtn.offsetParent !== null) {
      skipBtn.click();
      return;
    }

    // 2. YouTube internal API
    if (typeof player.skipVideoAd === 'function') {
      player.skipVideoAd();
      return;
    }

    // 3. Speed-through (stays within whatever is buffered)
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

  const restorePlayback = (player) => {
    const video = player.querySelector('video');
    if (!video) return;
    if (video.muted) video.muted = false;
    if (video.playbackRate !== 1) video.playbackRate = 1;
  };

  let _adObs = null;
  let _observedPlayer = null;
  let _playerPollTimer = null;
  let _playerPollIndex = 0;

  const stopPlayerPoll = () => {
    if (_playerPollTimer) {
      clearTimeout(_playerPollTimer);
      _playerPollTimer = null;
    }
  };

  const attachToPlayer = (player) => {
    if (player === _observedPlayer) return;
    if (_adObs) _adObs.disconnect();
    stopPlayerPoll();
    _observedPlayer = player;

    _adObs = new MutationObserver(() => {
      const isAd = player.classList.contains('ad-showing') ||
                   player.classList.contains('ad-interrupting');
      if (isAd) {
        doSkip(player);
      } else {
        restorePlayback(player);
      }
    });
    _adObs.observe(player, { attributes: true, attributeFilter: ['class'] });

    // Fire immediately in case the page loaded mid-ad
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
      doSkip(player);
    }
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
})();
