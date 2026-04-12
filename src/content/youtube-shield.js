/**
 * youtube-shield.js — Zero-Allocation Architecture
 * Optimized for sub-frame latency: MutationObserver replaces setInterval,
 * WASM automata built once via OnceLock, combined player processor avoids
 * double JS→WASM round-trip.
 */

import init, {
  process_youtube_player,
  process_youtube_player_bytes,
  sanitize_youtube_experiments,
  should_block_youtube_url,
} from '../shared/wasm/nullify_core.js';

(function() {
  let wasmReady = false;
  let wasmInitStarted = false;
  const getRuntimeWasmUrl = () => {
    try {
      return globalThis.chrome?.runtime?.getURL?.('dist/nullify_core_bg.wasm') || null;
    } catch {
      return null;
    }
  };
  const isPlayerResponseUrl = (url) => url.includes('/v1/player');
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

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
    if (result !== null && typeof result === 'object' &&
        (result.adPlacements !== undefined || result.playerAds !== undefined ||
         result.adSlots !== undefined ||
         (result.playerResponse &&
          result.playerResponse.adPlacements !== undefined))) {
      pruneAdKeys(result);
    }
    return result;
  };

  // 1b. Response hooks — cover fetch consumers using json(), text(), or arrayBuffer().
  if (window.Response?.prototype) {
    const _origResponseJson = Response.prototype.json;
    Response.prototype.json = async function(...args) {
      const result = await _origResponseJson.apply(this, args);
      if (isPlayerResponseUrl(this.url) &&
          result !== null && typeof result === 'object' &&
          (result.adPlacements !== undefined || result.playerAds !== undefined ||
           result.adSlots !== undefined)) {
        pruneAdKeys(result);
      }
      return result;
    };

    const _origResponseText = Response.prototype.text;
    Response.prototype.text = async function(...args) {
      const text = await _origResponseText.apply(this, args);
      return isPlayerResponseUrl(this.url) ? scrub(text) : text;
    };

    const _origResponseArrayBuffer = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = async function(...args) {
      const buffer = await _origResponseArrayBuffer.apply(this, args);
      if (!isPlayerResponseUrl(this.url)) return buffer;
      const bytes = new Uint8Array(buffer);
      if (wasmReady) {
        const cleaned = process_youtube_player_bytes(bytes);
        if (cleaned.length !== 0) return cleaned.buffer;
        return buffer;
      }
      const decoded = textDecoder.decode(bytes);
      const scrubbed = scrub(decoded);
      return scrubbed === decoded
        ? buffer
        : textEncoder.encode(scrubbed).buffer;
    };
  }

  // 2. WASM Initialization
  const bootstrapWasm = (url) => {
    if (wasmReady || wasmInitStarted || !url) return;
    wasmInitStarted = true;
    const initPromise = init({ module_or_path: url });
    initPromise.then(() => {
      wasmReady = true;
      console.log('%c[Nullify] WASM Active', 'color: #00ff00; font-weight: bold;');
    }).catch((err) => {
      wasmInitStarted = false;
      console.error('[Nullify] WASM init failed:', err);
    });
  };
  bootstrapWasm(getRuntimeWasmUrl());
  const attrObs = new MutationObserver(() => {
    const url = document.documentElement.getAttribute('data-nullify-wasm');
    if (url) { bootstrapWasm(url); attrObs.disconnect(); }
  });
  attrObs.observe(document.documentElement, { attributes: true });
  const initialUrl = document.documentElement.getAttribute('data-nullify-wasm');
  if (initialUrl) {
    bootstrapWasm(initialUrl);
    attrObs.disconnect();
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
    // WASM automaton check when ready; exact string fallback otherwise.
    const blocked = wasmReady
      ? should_block_youtube_url(url)
      : (url.includes('/ad_break') || url.includes('/get_attestation') || url.includes('/ad_slot_logging'));
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
      const block = wasmReady
        ? should_block_youtube_url(url)
        : (url.includes('/ad_break') || url.includes('/get_attestation') || url.includes('/ad_slot_logging'));
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
  const poison = (cfg) => {
    if (!cfg || !cfg.EXPERIMENT_FLAGS) return;
    // Synchronous baseline — always runs, no WASM dependency.
    Object.assign(cfg.EXPERIMENT_FLAGS, POISON_FLAGS);
    // WASM extends coverage to any additional flags we may have missed.
    if (wasmReady) {
      try {
        const sanitized = JSON.parse(sanitize_youtube_experiments(JSON.stringify(cfg)));
        if (sanitized?.EXPERIMENT_FLAGS) {
          Object.assign(cfg.EXPERIMENT_FLAGS, sanitized.EXPERIMENT_FLAGS);
        }
      } catch (e) {}
    }
  };

  if (window.ytcfg?.set) {
    const origSet = window.ytcfg.set;
    window.ytcfg.set = function(cfg, ...args) {
      if (cfg) poison(cfg);
      return origSet.apply(this, [cfg, ...args]);
    };
    if (window.ytcfg.config_) poison(window.ytcfg.config_);
  }

  // 8. Zero-Latency Ad Skipper — MutationObserver fires the instant YouTube
  //    adds/removes 'ad-showing' or 'ad-interrupting' on #movie_player.
  //    This replaces setInterval(fn, 200) with immediate-reaction semantics.
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

  const attachToPlayer = (player) => {
    if (player === _observedPlayer) return;
    if (_adObs) _adObs.disconnect();
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

  // Find #movie_player using a lightweight interval instead of a subtree
  // MutationObserver. A full-subtree observer on YouTube's SPA generates
  // thousands of callbacks per navigation; a 50ms poll is far cheaper and
  // fast enough — the player always appears within ~500ms of page load.
  // The interval also handles YouTube SPA navigations (yt-navigate-finish).
  const pollForPlayer = () => {
    const player = document.querySelector('#movie_player');
    if (player) attachToPlayer(player);
  };

  // Poll quickly at startup
  const initPoll = setInterval(() => {
    pollForPlayer();
    if (_observedPlayer) clearInterval(initPoll);
  }, 50);
  // Safety: stop fast poll after 10 s regardless
  setTimeout(() => clearInterval(initPoll), 10000);

  // Re-attach on YouTube SPA navigation (yt-navigate-finish fires when a new
  // video page is loaded in the same tab — the player element may be reused
  // but its class list resets, so we need a fresh MutationObserver).
  window.addEventListener('yt-navigate-finish', pollForPlayer);
  window.addEventListener('yt-page-data-updated', pollForPlayer);
})();
