/**
 * bot-stealth.js
 *
 * Applies lightweight anti-automation hardening in MAIN world without
 * stripping page security headers or pinning obviously fake hardware data.
 */

const GPU_BY_PERSONA = {
  windows: {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  mac: {
    vendor: 'Google Inc. (Apple)',
    renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)',
  },
  linux: {
    vendor: 'Google Inc. (Intel Open Source Technology Center)',
    renderer: 'Mesa DRI Intel(R) UHD Graphics 620 (KBL GT2)',
  },
};

function defineGetter(target, key, getter) {
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      get: getter,
    });
    return true;
  } catch {
    return false;
  }
}

function defineNavigatorValue(key, value) {
  if (defineGetter(Navigator.prototype, key, () => value)) return;
  defineGetter(navigator, key, () => value);
}

// Wrappers we installed. A WeakSet is invisible to the page, unlike the old
// `__nullifyPatched` own property (`Object.keys(getParameter)` revealed it).
const patchedGetParameters = new WeakSet();

function patchWebGL(proto, gpu) {
  if (!proto?.getParameter || patchedGetParameters.has(proto.getParameter)) return;

  const original = proto.getParameter;
  const wrapped = function(parameter) {
    if (parameter === 37445) return gpu.vendor;
    if (parameter === 37446) return gpu.renderer;
    return original.apply(this, arguments);
  };
  patchedGetParameters.add(wrapped);
  wrapped.toString = () => 'function getParameter() { [native code] }';
  proto.getParameter = wrapped;
}

// Module-scope guard. A global flag was page-writable — one inline script
// setting it disabled the scriptlet — and enumerable via Object.keys(window).
let applied = false;

export function botStealth(personaId = 'default') {
  if (applied) return;
  applied = true;

  defineNavigatorValue('webdriver', false);

  if (!navigator.languages?.length) {
    defineNavigatorValue('languages', ['en-US', 'en']);
  }

  const gpu = GPU_BY_PERSONA[personaId];
  if (!gpu) return;

  patchWebGL(globalThis.WebGLRenderingContext?.prototype, gpu);
  patchWebGL(globalThis.WebGL2RenderingContext?.prototype, gpu);
}
