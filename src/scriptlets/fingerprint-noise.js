/**
 * fingerprint-noise.js
 *
 * Adds small deterministic per-document noise to Canvas and Audio API outputs.
 * This is intentionally local and lazy: no service-worker chatter, no timers.
 */
export function fingerprintNoise() {
  if (globalThis.__nullifyFingerprintNoiseApplied) return;
  globalThis.__nullifyFingerprintNoiseApplied = true;

  const seedBuffer = new Uint32Array(1);
  crypto.getRandomValues(seedBuffer);
  const seed = seedBuffer[0] || 1;

  const clampByte = (value) => Math.max(0, Math.min(255, value));
  const clampAudio = (value) => Math.max(-1, Math.min(1, value));

  const bitNoise = (salt) => {
    let x = (seed ^ salt) >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x & 1) === 0 ? -1 : 1;
  };

  const perturbPixels = (data, salt) => {
    for (let i = 0; i < data.length; i += 4096) {
      data[i] = clampByte(data[i] + bitNoise(salt + i));
    }
  };

  const perturbAudio = (data, salt) => {
    for (let i = 0; i < data.length; i += 4096) {
      data[i] = clampAudio(data[i] + (bitNoise(salt + i) * 1e-7));
    }
  };

  const getCanvasSalt = (canvas) => {
    const width = Number(canvas?.width) || 0;
    const height = Number(canvas?.height) || 0;
    return ((width << 16) ^ height) >>> 0;
  }

  // ---------------------------------------------------------------------------
  // Canvas Fingerprinting Protection
  // ---------------------------------------------------------------------------
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, options) {
    if (type === '2d') {
      options = options || {};
      options.willReadFrequently = true;
    }
    return origGetContext.call(this, type, options);
  };

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
    const imageData = origGetImageData.apply(this, arguments);
    perturbPixels(imageData.data, ((x << 24) ^ (y << 16) ^ (w << 8) ^ h) >>> 0);
    return imageData;
  };

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function () {
    try {
      const offscreen = document.createElement('canvas');
      offscreen.width = this.width;
      offscreen.height = this.height;
      const octx = offscreen.getContext('2d');
      if (octx) {
        octx.drawImage(this, 0, 0);
        const imageData = octx.getImageData(0, 0, offscreen.width, offscreen.height);
        perturbPixels(imageData.data, getCanvasSalt(this));
        octx.putImageData(imageData, 0, 0);
        return offscreen.toDataURL.apply(offscreen, arguments);
      }
    } catch (e) { }
    return origToDataURL.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // Audio Fingerprinting Protection
  // ---------------------------------------------------------------------------
  if (window.AudioBuffer) {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function () {
      const data = origGetChannelData.apply(this, arguments);
      perturbAudio(data, data.length >>> 0);
      return data;
    };
  }
}
