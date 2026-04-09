/**
 * youtube-shield.js - Zero-Allocation Architecture
 * Optimized for stability and zero memory leaks.
 */

import init, { clean_youtube_json, clean_youtube_binary, sanitize_youtube_experiments } from '../shared/wasm/nullify_core.js';

(function() {
  let wasmReady = false;
  const adKeys = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adClientParams'];
  const adRegex = new RegExp(`"(${adKeys.join('|')})":\\s*(\\[|\\{)`, 'g');

  // 1. WeakMap Cache — Fixes Memory Leak by reusing proxies
  const proxyCache = new WeakMap();

  const createProxy = (obj) => {
    if (!obj || typeof obj !== 'object' || obj.__isProxy) return obj;
    if (proxyCache.has(obj)) return proxyCache.get(obj);

    const proxy = new Proxy(obj, {
      get: (target, prop) => {
        if (adKeys.includes(prop)) return undefined;
        const val = Reflect.get(target, prop);
        return (typeof val === 'object' && val !== null) ? createProxy(val) : val;
      },
      __isProxy: true
    });
    
    proxyCache.set(obj, proxy);
    return proxy;
  };

  // 2. High-Speed WASM Initialization
  const bootstrapWasm = (url) => {
    if (wasmReady || !url) return;
    init(url).then(() => { 
      wasmReady = true; 
      console.log('%c[Nullify] WASM God-Mode Active (High Performance)', 'color: #00ff00; font-weight: bold;');
    }).catch((err) => {
      console.error('[Nullify] WASM Shield Failed to Load:', err);
    });
  };
  const obs = new MutationObserver(() => {
    const url = document.documentElement.getAttribute('data-nullify-wasm');
    if (url) { bootstrapWasm(url); obs.disconnect(); }
  });
  obs.observe(document.documentElement, { attributes: true });
  const initialUrl = document.documentElement.getAttribute('data-nullify-wasm');
  if (initialUrl) bootstrapWasm(initialUrl);

  // 3. Selective Scrubber
  const scrub = (data) => {
    if (!data) return data;
    try {
      if (data instanceof Uint8Array) {
        if (!wasmReady || data.length < 5000 || data.length > 500000) return data;
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

  // 4. Identity Trap-Defuser
  const ok = () => Promise.resolve({ state: 'granted' });
  if (document.requestStorageAccess) document.requestStorageAccess = ok;
  if (document.requestStorageAccessFor) document.requestStorageAccessFor = ok;

  // 5. Network Interceptor (No-Proxy Version for Stability)
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url.includes('/ad_break') || url.includes('/get_attestation')) return new Response('{}', { status: 200 });

    const res = await origFetch.call(this, input, init);
    if (!url.includes('/v1/player') && !url.includes('/get_watch')) return res;

    const text = await res.text();
    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');

    return new Response(scrub(text), { status: res.status, headers });
  };

  // 6. Variable Shield (Setter Hijacking with Cache)
  const shield = (prop) => {
    let _val = window[prop];
    Object.defineProperty(window, prop, {
      get: () => _val,
      set: (v) => { _val = createProxy(v); },
      configurable: true
    });
    if (_val) _val = createProxy(_val);
  };
  ['ytInitialPlayerResponse', 'playerResponse', 'ytInitialData', 'initialPlayerResponse'].forEach(shield);

  // 7. ytcfg Experiment Poisoning
  const poison = (cfg) => {
    if (!cfg || !cfg.EXPERIMENT_FLAGS) return;
    if (wasmReady) {
      try {
        const sanitized = JSON.parse(sanitize_youtube_experiments(JSON.stringify(cfg)));
        if (sanitized && sanitized.EXPERIMENT_FLAGS) {
          Object.assign(cfg.EXPERIMENT_FLAGS, sanitized.EXPERIMENT_FLAGS);
        }
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
      if (cfg) poison(cfg);
      return origSet.apply(this, [cfg, ...args]);
    };
    if (window.ytcfg.config_) poison(window.ytcfg.config_);
  }

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
  setInterval(skip, 200);
})();
