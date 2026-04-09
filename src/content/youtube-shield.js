/**
 * youtube-shield.js - Hyper-Speed Omni Shield (Hardened)
 * Registered as a static MAIN-world script at document_start.
 */

import init, { clean_youtube_json, clean_youtube_binary, sanitize_youtube_experiments } from '../shared/wasm/nullify_core.js';

(function() {
  let wasmReady = false;
  const adKeys = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adClientParams'];
  // Hardened regex to catch variations in JSON formatting
  const adRegex = new RegExp(`"(${adKeys.join('|')})":\\s*(\\[|\\{)`, 'g');

  // 1. Storage Access API Trap-Defuser (STOPS "Permission denied" error)
  const grantAccess = () => Promise.resolve({ state: 'granted' });
  try {
    if (document.requestStorageAccess) document.requestStorageAccess = grantAccess;
    if (document.requestStorageAccessFor) document.requestStorageAccessFor = grantAccess;
  } catch (e) {}

  // 2. High-Speed WASM Initialization (Race-Condition Proof)
  const bootstrapWasm = (url) => {
    if (wasmReady || !url) return;
    init(url).then(() => { 
      wasmReady = true; 
      console.log('%c[Nullify] WASM God-Mode Active (High Performance)', 'color: #00ff00; font-weight: bold;');
    }).catch((err) => {
      console.error('[Nullify] WASM Shield Failed to Load:', err);
    });
  };

  const observer = new MutationObserver(() => {
    const url = document.documentElement.getAttribute('data-nullify-wasm');
    if (url) { bootstrapWasm(url); observer.disconnect(); }
  });
  observer.observe(document.documentElement, { attributes: true });
  const initialUrl = document.documentElement.getAttribute('data-nullify-wasm');
  if (initialUrl) bootstrapWasm(initialUrl);

  // 3. High-Speed Scrubber with "Micro-second Guard"
  const scrub = (data) => {
    if (!data) return data;
    try {
      if (data instanceof Uint8Array) {
        if (!wasmReady || data.length < 5000) return data;
        return clean_youtube_binary(data);
      }
      if (typeof data === 'string') {
        if (data.length < 20 || !data.includes('"ad')) return data;
        if (wasmReady) return clean_youtube_json(data);
        return data.replace(adRegex, '"disabled_$1":$2');
      }
      return data;
    } catch (e) { return data; }
  };

  // 4. Selective JSON.parse Hijack (Guarded)
  const origParse = JSON.parse;
  JSON.parse = function(text, reviver) {
    if (typeof text === 'string' && text.length > 20 && text.includes('"ad')) {
      return origParse.call(this, scrub(text), reviver);
    }
    return origParse.call(this, text, reviver);
  };

  // 5. ytcfg & Experiment Poisoning
  const poison = (cfg) => {
    if (!cfg || !cfg.EXPERIMENT_FLAGS) return;
    if (wasmReady) {
      try {
        const sanitized = JSON.parse(sanitize_youtube_experiments(JSON.stringify(cfg)));
        Object.assign(cfg.EXPERIMENT_FLAGS, sanitized.EXPERIMENT_FLAGS);
      } catch (e) {}
    } else {
      const f = cfg.EXPERIMENT_FLAGS;
      f.web_player_api_v2_server_side_ad_injection = false;
      f.web_enable_ab_wv_edu = false;
      f.web_disable_midroll_ads = true;
    }
  };

  if (window.ytcfg && window.ytcfg.set) {
    const origSet = window.ytcfg.set;
    window.ytcfg.set = function(cfg, ...args) {
      if (cfg && cfg.EXPERIMENT_FLAGS) poison(cfg);
      return origSet.apply(this, [cfg, ...args]);
    };
    if (window.ytcfg.config_) poison(window.ytcfg.config_);
  }

  // 6. Ghost Network Proxy (Identity Preserving)
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url.includes('/ad_break') || url.includes('/get_attestation')) return new Response('{}', { status: 200 });

    const res = await origFetch.call(this, input, init);
    if (!url.includes('/v1/player') && !url.includes('/get_watch')) return res;

    // Proxy the response to scrub data while keeping 'identity' context
    return new Proxy(res, {
      get(target, prop) {
        if (prop === 'text') return async () => scrub(await target.text());
        if (prop === 'json') return async () => JSON.parse(scrub(await target.text()));
        if (prop === 'arrayBuffer') return async () => scrub(new Uint8Array(await target.arrayBuffer())).buffer;
        const val = Reflect.get(target, prop);
        return typeof val === 'function' ? val.bind(target) : val;
      }
    });
  };

  // 7. Variable Shield (Deep Recursive Proxy)
  const shield = (prop) => {
    let _val = window[prop];
    Object.defineProperty(window, prop, {
      get: () => _val,
      set: (v) => { 
        if (typeof v === 'object' && v !== null) {
          _val = JSON.parse(scrub(JSON.stringify(v)));
        } else {
          _val = v;
        }
      },
      configurable: true
    });
    if (_val) _val = JSON.parse(scrub(JSON.stringify(_val)));
  };
  ['ytInitialPlayerResponse', 'playerResponse', 'ytInitialData', 'initialPlayerResponse'].forEach(shield);

  // 8. Zero-Latency Atomic Skipper
  const skip = () => {
    const player = document.querySelector('#movie_player');
    const video = player?.querySelector('video');
    if (!player || !video) return;
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
      video.muted = true;
      video.playbackRate = 16;
      if (player.skipVideoAd) player.skipVideoAd();
      if (video.duration > 0 && isFinite(video.duration)) video.currentTime = video.duration - 0.1;
    }
  };
  setInterval(skip, 150);
})();
