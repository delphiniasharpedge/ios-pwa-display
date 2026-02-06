import { describe, expect, it } from 'vitest';

import { clamp01, lerpColor, normalizeBrightness } from './brightness';

describe('brightness utils', () => {
  it('clamp01 clamps to [0,1]', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
  });

  it('normalizeBrightness maps thresholds to 0..1', () => {
    expect(normalizeBrightness(0.0, 0.2, 0.5)).toBe(0);
    expect(normalizeBrightness(0.2, 0.2, 0.5)).toBe(0);
    expect(normalizeBrightness(0.35, 0.2, 0.5)).toBeCloseTo(0.5, 5);
    expect(normalizeBrightness(0.5, 0.2, 0.5)).toBe(1);
    expect(normalizeBrightness(1.0, 0.2, 0.5)).toBe(1);
  });

  it('normalizeBrightness falls back when max<=min', () => {
    expect(normalizeBrightness(0.7, 0.8, 0.2)).toBeCloseTo(0.7, 5);
  });

  it('lerpColor interpolates between colors', () => {
    expect(lerpColor('#000000', '#ffffff', 0)).toBe('rgb(0, 0, 0)');
    expect(lerpColor('#000000', '#ffffff', 1)).toBe('rgb(255, 255, 255)');
  });
});
