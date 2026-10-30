import { describe, it, expect } from 'vitest';
import {
  DEFAULTS,
  mergeParams,
  scaleParamsForPreview,
  suffixFor,
  PARAM_GROUPS,
  OFFSET_DEFS,
} from './params.js';

describe('DEFAULTS', () => {
  it('mirrors the CLI defaults', () => {
    expect(DEFAULTS).toMatchObject({
      size: 0,
      margin: 0.05,
      border: 0.025,
      radius: 0.015,
      radius_jitter: 0.0,
      square_corner_chance: 0.2,
      border_jitter: 0.6,
      max_sprocket_border: 0.03,
      roughness: 1.0,
      feather: 3.0,
      sprocket_chance: 0.7,
      offset_left: 0,
      offset_right: 0,
      offset_top: 0,
      offset_bottom: 0,
      seed: null,
      quality: 100,
      plain: false,
      debug: false,
      format: 'jpg',
    });
  });
});

describe('mergeParams', () => {
  it('lets overrides win over the base', () => {
    const out = mergeParams(DEFAULTS, { border: 0.09, seed: 7 });
    expect(out.border).toBe(0.09);
    expect(out.seed).toBe(7);
    expect(out.margin).toBe(DEFAULTS.margin);
  });
});

describe('scaleParamsForPreview', () => {
  it('scales pixel-sized params and leaves fractions untouched', () => {
    const out = scaleParamsForPreview(
      { ...DEFAULTS, offset_left: 40, roughness: 2, feather: 6, border: 0.025 },
      0.5,
    );
    expect(out.offset_left).toBe(20);
    expect(out.roughness).toBe(1);
    expect(out.feather).toBe(3);
    expect(out.border).toBe(0.025); // fraction, scale-free
    expect(out.margin).toBe(0.05);
  });

  it('never touches null seed', () => {
    const out = scaleParamsForPreview({ ...DEFAULTS, seed: null }, 0.5);
    expect(out.seed).toBeNull();
  });

  it('scales detection overrides but preserves null sprocket sides', () => {
    const out = scaleParamsForPreview(
      {
        ...DEFAULTS,
        gate_override: [100, 200, 300, 400],
        sprocket_override: [null, 800],
      },
      0.5,
    );
    expect(out.gate_override).toEqual([50, 100, 150, 200]);
    expect(out.sprocket_override).toEqual([null, 400]);
  });
});

describe('suffixFor', () => {
  it('returns jpg bordered suffix by default', () => {
    expect(suffixFor(DEFAULTS)).toBe('.bordered.jpg');
  });
  it('returns png suffix for png format', () => {
    expect(suffixFor({ ...DEFAULTS, format: 'png' })).toBe('.bordered.png');
  });
  it('returns plain suffix for plain mode', () => {
    expect(suffixFor({ ...DEFAULTS, plain: true })).toBe('.plain.jpg');
    expect(suffixFor({ ...DEFAULTS, plain: true, format: 'png' })).toBe('.plain.png');
  });
});

describe('schema shape', () => {
  it('every param group param is in DEFAULTS', () => {
    for (const g of PARAM_GROUPS) {
      for (const p of g.params) {
        expect(p.key in DEFAULTS).toBe(true);
      }
    }
  });
  it('every offset def is in DEFAULTS', () => {
    for (const p of OFFSET_DEFS) {
      expect(p.key in DEFAULTS).toBe(true);
    }
  });
});
