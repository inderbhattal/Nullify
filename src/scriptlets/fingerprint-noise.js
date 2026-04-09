/**
 * fingerprint-noise.js
 *
 * Adds statistically sound Gaussian noise (from WASM Core) to Canvas and Audio API outputs.
 * This changes the browser's fingerprint using Differential Privacy principles, 
 * making it mathematically harder for tracking scripts to detect the noise.
 */
export function fingerprintNoise() {
  // ---------------------------------------------------------------------------
  // Noise Buffer (to avoid messaging overhead)
  // ---------------------------------------------------------------------------
  let noiseBuffer = [];
  const BUFFER_SIZE = 512;

  async function refillNoiseBuffer() {
    try {
      // Use chrome.runtime.sendMessage to fetch Gaussian noise from the WASM core in SW
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ 
          type: 'GET_NOISE', 
          payload: { mean: 0, stdDev: 0.8 } 
        }, resolve);
      });
      if (response && response.noise !== undefined) {
        noiseBuffer.push(response.noise);
        // Trim buffer if it gets too large
        if (noiseBuffer.length > BUFFER_SIZE) noiseBuffer.shift();
      }
    } catch { /* background might be sleeping */ }
  }

  // Initial fill
  for (let i = 0; i < 10; i++) refillNoiseBuffer();
  // Periodic refill
  setInterval(refillNoiseBuffer, 5000);

  function getNoise() {
    if (noiseBuffer.length > 0) {
      return noiseBuffer.pop();
    }
    return (Math.random() - 0.5) * 2; // Fast fallback
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
    const data = imageData.data;
    
    // Add statistically sound noise periodically
    for (let i = 0; i < data.length; i += 4096) {
      const n = getNoise();
      data[i] = data[i] + (n > 0 ? 1 : -1);
    }
    
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
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4096) {
          const n = getNoise();
          data[i] = data[i] + (n > 0 ? 1 : -1);
        }
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
      for (let i = 0; i < data.length; i += 4096) {
        data[i] = data[i] + (getNoise() * 0.0000001);
      }
      return data;
    };
  }
}
