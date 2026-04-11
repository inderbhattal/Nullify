/**
 * bot-stealth.js
 *
 * Spoofs GPU signatures and hides automation flags to bypass bot detection.
 */

export function botStealth() {
  // 1. Hide navigator.webdriver
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  } catch (e) {}

  // 2. WebGL GPU Spoofing (mimic NVIDIA GeForce RTX 3080)
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      // 0x9245 = UNMASKED_VENDOR_WEBGL, 0x9246 = UNMASKED_RENDERER_WEBGL
      if (parameter === 37445) return 'Google Inc. (NVIDIA)';
      if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return getParameter.apply(this, arguments);
    };
    // Ensure .toString() looks native
    WebGLRenderingContext.prototype.getParameter.toString = () => 'function getParameter() { [native code] }';
  } catch (e) {}

  // 3. Hardware Consistency
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  } catch (e) {}
}
