export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Normalize raw brightness (0..1) into 0..1 based on thresholds.
 * - raw <= minThreshold => 0
 * - raw >= maxThreshold => 1
 * - otherwise linear interpolation
 */
export function normalizeBrightness(raw: number, minThreshold: number, maxThreshold: number): number {
  const r = clamp01(raw);
  if (maxThreshold <= minThreshold) return r;
  const t = (r - minThreshold) / (maxThreshold - minThreshold);
  return clamp01(t);
}

export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const s = (hex || '').trim().replace(/^#/, '');
  const v = s.length === 3
    ? s.split('').map((c) => c + c).join('')
    : s;
  if (!/^[0-9a-fA-F]{6}$/.test(v)) {
    return { r: 255, g: 255, b: 255 };
  }
  const n = parseInt(v, 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpColor(minHex: string, maxHex: string, t: number): string {
  const a = parseHexColor(minHex);
  const b = parseHexColor(maxHex);
  const tt = clamp01(t);
  const r = Math.round(lerp(a.r, b.r, tt));
  const g = Math.round(lerp(a.g, b.g, tt));
  const bb = Math.round(lerp(a.b, b.b, tt));
  return `rgb(${r}, ${g}, ${bb})`;
}
