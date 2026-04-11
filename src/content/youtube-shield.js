/**
 * youtube-shield.js — Zero-Allocation Architecture
 * Optimized for sub-frame latency: MutationObserver replaces setInterval,
 * WASM automata built once via OnceLock, combined player processor avoids
 * double JS→WASM round-trip.
 */

import init, {
  process_youtube_player,
  clean_youtube_binary,
  sanitize_youtube_experiments,
  should_block_youtube_url,
} from '../shared/wasm/nullify_core.js';

(function() {
  let wasmReady = false;
  // Cold-start gate: resolves when WASM is ready (or on a safety timeout).
  // The fetch scrubber awaits this for /v1/player responses so the first
  // player request uses the full WASM path instead of the incomplete regex
  // fallback — which would otherwise cause YouTube to retry/stall.
  let _wasmResolve;
  const wasmReadyPromise = new Promise((resolve) => {
    _wasmResolve = resolve;
    // Safety: never block a response longer than 1500ms if WASM fails to load.
    setTimeout(resolve, 1500);
  });

  // ---- Ad key constants ----
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adClientParams'];
  // JS-only fallback regex (used before WASM is ready in the text scrubber)
  const adRegex = new RegExp(`"(${AD_KEYS.join('|')})":\\s*(\\[|\\{)`, 'g');

  // 1. Primary prevention — delete ad keys from any parsed object.
  //
  // Deletion is PERMANENT and UNDETECTABLE: YouTube cannot recover the data via
  // property reads, 'in' checks, Object.keys, destructuring, or any other means.
  // This is categorically stronger than the previous Proxy approach, which only
  // blocked property reads while leaving the key present (detectable via 'in').
  //
  // Also recurses into .playerResponse: /v1/next (SPA navigation) embeds a full
  // player response as a nested object alongside the page/browse data.
  function pruneAdKeys(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (let i = 0; i < AD_KEYS.length; i++) delete obj[AD_KEYS[i]];
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

  // 1b. Response.prototype.json hook — covers fetch().then(r => r.json()) paths.
  if (window.Response?.prototype) {
    const _origResponseJson = Response.prototype.json;
    Response.prototype.json = async function(...args) {
      const result = await _origResponseJson.apply(this, args);
      if (result !== null && typeof result === 'object' &&
          (result.adPlacements !== undefined || result.playerAds !== undefined ||
           result.adSlots !== undefined)) {
        pruneAdKeys(result);
      }
      return result;
    };
  }

  // 2. WASM Initialization
  const bootstrapWasm = (url) => {
    if (wasmReady || !url) return;
    init({ module_or_path: url }).then(() => {
      wasmReady = true;
      _wasmResolve();
      console.log('%c[Nullify] WASM Active', 'color: #00ff00; font-weight: bold;');
    }).catch((err) => {
      // Release the gate so responses don't stall on WASM load failure;
      // scrub() will degrade to the regex fallback path.
      _wasmResolve();
      console.error('[Nullify] WASM init failed:', err);
    });
  };
  const attrObs = new MutationObserver(() => {
    const url = document.documentElement.getAttribute('data-nullify-wasm');
    if (url) { bootstrapWasm(url); attrObs.disconnect(); }
  });
  attrObs.observe(document.documentElement, { attributes: true });
  const initialUrl = document.documentElement.getAttribute('data-nullify-wasm');
  if (initialUrl) bootstrapWasm(initialUrl);

  // 3. Response Scrubber
  // For player responses: use combined process_youtube_player (one WASM call).
  // For binary: use clean_youtube_binary.
  // Fallback: JS regex when WASM not yet ready.
  //
  // JS pre-check: String.prototype.includes() runs in-place (SIMD, zero allocation)
  // and avoids the full JS→WASM string copy for clean responses entirely.
  // For 60+ min videos the player JSON can be 1–2 MB; skipping the WASM boundary
  // copy when there are no ad markers saves ~100–400 ms per intercepted request.
  const _adMarkers = [
    '"adPlacements"', '"playerAds"', '"adSlots"',
    '"adBreakHeartbeatParams"', '"adClientParams"',
    '"web_disable_midroll_ads":false',
  ];
  const _hasAdContent = (text) => {
    for (let i = 0; i < _adMarkers.length; i++) {
      if (text.includes(_adMarkers[i])) return true;
    }
    return false;
  };

  const scrub = (data) => {
    if (!data) return data;
    try {
      if (data instanceof Uint8Array) {
        if (!wasmReady || data.length < 5000 || data.length > 500000) return data;
        return clean_youtube_binary(data);
      }
      if (typeof data === 'string') {
        if (data.length < 20) return data;
        if (wasmReady) {
          // Fast JS pre-check: skip WASM boundary copy entirely for clean responses.
          // process_youtube_player() still handles the replacement pass when needed.
          if (!_hasAdContent(data)) return data;
          const cleaned = process_youtube_player(data);
          return cleaned || data;
        }
        if (!data.includes('"ad')) return data;
        return data.replace(adRegex, '"disabled_$1":$2');
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
    if (blocked) return new Response('{}', { status: 200 });

    // Only intercept player/watch responses — everything else passes through untouched.
    if (!url.includes('/v1/player') && !url.includes('/get_watch')) {
      return origFetch.call(this, input, init);
    }

    const res = await origFetch.call(this, input, init);
    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');

    // Stream the body through a scrubbing TransformStream so the response body
    // is only held once in memory (avoids the res.text() double-allocation for
    // 200–500 KB player responses). Chunks accumulate in `acc`; scrubbing fires
    // in flush() the instant the last byte arrives — identical wall-clock latency
    // to await res.text() but half the peak heap usage.
    if (res.body) {
      // Store raw Uint8Array chunks — no per-chunk decode overhead.
      // Single decode in flush() handles multi-byte sequences that span chunk
      // boundaries correctly (no streaming decoder state needed).
      // For clean responses scrub() returns the same string reference, so we
      // pass the original merged bytes through without re-encoding.
      let rawChunks = [];
      let rawTotal = 0;
      const { readable, writable } = new TransformStream({
        transform(chunk) { rawChunks.push(chunk); rawTotal += chunk.byteLength; },
        async flush(controller) {
          // Cold-start gate: on the first /v1/player request after page load,
          // WASM is often still compiling. Await the ready promise (capped at
          // 1500ms) so the first response uses the full WASM scrubber instead
          // of the partial regex fallback — which otherwise causes YouTube to
          // see inconsistent ad state and trigger retry/stall paths.
          if (!wasmReady) await wasmReadyPromise;
          const merged = new Uint8Array(rawTotal);
          let off = 0;
          for (const c of rawChunks) { merged.set(c, off); off += c.byteLength; }
          rawChunks = null;
          const text = new TextDecoder().decode(merged);
          const scrubbed = scrub(text);
          // Same reference → nothing changed → send original bytes, skip re-encode.
          controller.enqueue(scrubbed === text ? merged : new TextEncoder().encode(scrubbed));
        },
      });
      res.body.pipeTo(writable).catch(() => {});
      return new Response(readable, { status: res.status, headers });
    }

    // Fallback: body streaming unavailable (rare). Same cold-start gate applies.
    if (!wasmReady) await wasmReadyPromise;
    return new Response(scrub(await res.text()), { status: res.status, headers });
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
      this._nUrl    = '';
      this._nCached = null;
    }

    open(method, url, ...args) {
      this._nUrl    = typeof url === 'string' ? url : '';
      this._nCached = null;
      return super.open(method, url, ...args);
    }

    // Pre-flight block — abort ad-only XHR requests before they reach the network.
    send(...args) {
      const url = this._nUrl;
      const block = wasmReady
        ? should_block_youtube_url(url)
        : (url.includes('/ad_break') || url.includes('/get_attestation') || url.includes('/ad_slot_logging'));
      if (block) {
        // Synthesise an empty successful response so callers don't hang.
        setTimeout(() => {
          this.dispatchEvent(new ProgressEvent('load'));
          this.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
        return;
      }
      // Cold-start gate: defer the network send for player URLs until WASM
      // is ready so the lazy scrub on responseText uses the full WASM path.
      // The lazy scrub is synchronous (invoked from a getter) so we can't
      // await inside it — we must gate the request itself instead.
      if (!wasmReady && (url.includes('/v1/player') || url.includes('/get_watch'))) {
        wasmReadyPromise.then(() => super.send(...args));
        return;
      }
      return super.send(...args);
    }

    _isPlayer() {
      return this.readyState === 4 &&
             (this.responseType === '' || this.responseType === 'text') &&
             (this._nUrl.includes('/v1/player') || this._nUrl.includes('/get_watch'));
    }

    _scrubbed() {
      if (this._nCached === null) {
        try { this._nCached = scrub(super.responseText); }
        catch (e) { this._nCached = super.responseText; }
      }
      return this._nCached;
    }

    get responseText() {
      return this._isPlayer() ? this._scrubbed() : super.responseText;
    }

    get response() {
      const r = super.response;
      return (this._isPlayer() && typeof r === 'string') ? this._scrubbed() : r;
    }
  };

  // 6. Variable Shield — direct deletion on assignment.
  //
  // youtube-shield.js runs at document_start before YouTube's inline <script>
  // tags, so Object.defineProperty is called before YouTube's code assigns
  // ytInitialPlayerResponse. When the assignment fires, the setter pruneAdKeys
  // the object in-place before storing it — the player never sees ad data.
  //
  // Direct deletion is strictly better than the previous Proxy approach:
  //   Proxy: hides reads but keys remain present — detectable via 'in', Object.keys
  //   Delete: keys are gone entirely — no recovery path exists
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
