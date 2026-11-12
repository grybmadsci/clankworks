/**
 * Render quality tier. Software adapters (e.g. SwiftShader when no GPU is exposed to the browser)
 * get cheaper shading, a single fluid slice, no post-processing and a lower pixel ratio.
 * Override with `?quality=low` or `?quality=high`.
 */
export const quality = { low: false };

export function chooseQuality(adapter: GPUAdapter | null) {
  const forced = new URLSearchParams(location.search).get('quality');
  const info = adapter?.info as (GPUAdapterInfo & { isFallbackAdapter?: boolean }) | undefined;
  quality.low = forced ? forced === 'low' : !!info?.isFallbackAdapter;
  return quality.low;
}
