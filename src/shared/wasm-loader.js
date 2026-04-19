/**
 * Chrome's extension URL + `instantiateStreaming()` path has been unreliable
 * for this generated wasm-bindgen wrapper. Load bytes first and let the wrapper
 * instantiate from raw bytes instead.
 *
 * @param {(arg: { module_or_path: BufferSource }) => Promise<unknown>} initFn
 * @param {string} url
 * @returns {Promise<unknown>}
 */
export async function initWasmFromUrl(initFn, url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch WASM module: ${response.status} ${response.statusText}`);
  }

  const bytes = await response.arrayBuffer();
  return initFn({ module_or_path: bytes });
}
