/**
 * fingerprint-noise.js
 *
 * Adds a tiny, imperceptible amount of noise to Canvas and Audio API outputs.
 * This changes the browser's fingerprint, making it useless for tracking across 
 * different websites.
 */
export function fingerprintNoise() {
  // 0. Ensure willReadFrequently is set for Canvas contexts to avoid warnings
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, options) {
    if (type === '2d') {
      options = options || {};
      options.willReadFrequently = true;
    }
    return origGetContext.call(this, type, options);
  };

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
    // To avoid modifying the original canvas and for better performance,
    // we use a temporary canvas to generate the spoofed DataURL.
    try {
      const offscreen = document.createElement('canvas');
      offscreen.width = this.width;
      offscreen.height = this.height;
      const octx = offscreen.getContext('2d');
      if (octx) {
        octx.drawImage(this, 0, 0);
        const imageData = octx.getImageData(0, 0, offscreen.width, offscreen.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4096) {
          data[i] = data[i] + (Math.random() > 0.5 ? 1 : -1);
        }
        octx.putImageData(imageData, 0, 0);
        return offscreen.toDataURL.apply(offscreen, arguments);
      }
    } catch (e) {
      // Fallback to original if anything fails (e.g., cross-origin)
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
