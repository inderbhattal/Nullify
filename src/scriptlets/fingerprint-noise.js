/**
 * fingerprint-noise.js
 *
 * Adds a tiny, imperceptible amount of noise to Canvas and Audio API outputs.
 * This changes the browser's fingerprint, making it useless for tracking across 
 * different websites.
 */
export function fingerprintNoise() {
  // 1. Canvas Fingerprinting Protection
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
    const imageData = origGetImageData.apply(this, arguments);
    const data = imageData.data;
    
    // Add very slight noise to the last pixel
    for (let i = 0; i < data.length; i += 4096) {
      data[i] = data[i] + (Math.random() > 0.5 ? 1 : -1);
    }
    
    return imageData;
  };

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function () {
    const ctx = this.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      const imageData = ctx.getImageData(0, 0, this.width, this.height);
      ctx.putImageData(imageData, 0, 0);
    }
    return origToDataURL.apply(this, arguments);
  };

  // 2. Audio Fingerprinting Protection
  if (window.AudioBuffer) {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function () {
      const data = origGetChannelData.apply(this, arguments);
      for (let i = 0; i < data.length; i += 4096) {
        data[i] = data[i] + (Math.random() * 0.0000001);
      }
      return data;
    };
  }
}
