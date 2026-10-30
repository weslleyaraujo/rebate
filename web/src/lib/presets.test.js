import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PRESETS,
  serializePreset,
  importPresetsFromJson,
} from './presets.js';
import { DEFAULTS } from './params.js';

describe('BUILTIN_PRESETS', () => {
  it('includes the reworked looks', () => {
    const names = BUILTIN_PRESETS.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Natural',
        'Sprockets',
        'Clean',
        'Rounded',
        'Soft',
        'Tight',
        'Full bleed',
        'Instagram',
      ]),
    );
  });

  it('full bleed sets plain mode', () => {
    const plain = BUILTIN_PRESETS.find((p) => p.name === 'Full bleed');
    expect(plain.params.plain).toBe(true);
  });

  it('instagram uses a square canvas', () => {
    const ig = BUILTIN_PRESETS.find((p) => p.name === 'Instagram');
    expect(ig.params.size).toBe(3000);
    expect(ig.params.quality).toBe(95);
    expect(ig.params.roughness).toBe(0.6);
  });
});

describe('serializePreset', () => {
  it('stores only non-default values (like CLI minimal configs)', () => {
    const out = serializePreset({ ...DEFAULTS, border: 0.04, quality: 95 });
    expect(out).toEqual({ border: 0.04, quality: 95 });
  });

  it('stores nothing for a default look', () => {
    expect(serializePreset({ ...DEFAULTS })).toEqual({});
  });
});

describe('importPresetsFromJson', () => {
  it('imports web-format presets and fills missing keys with defaults', () => {
    const out = importPresetsFromJson(JSON.stringify({ ig: { border: 0.04 } }));
    expect(out.ig.border).toBe(0.04);
    expect(out.ig.margin).toBe(DEFAULTS.margin);
  });

  it('imports CLI config format: suffix -> format', () => {
    const out = importPresetsFromJson(
      JSON.stringify({ ig: { quality: 95, border: 0.04, suffix: '.p.png' } }),
    );
    expect(out.ig.quality).toBe(95);
    expect(out.ig.border).toBe(0.04);
    expect(out.ig.format).toBe('png');
  });

  it('expands CLI offset shorthands, specific edge wins', () => {
    const out = importPresetsFromJson(
      JSON.stringify({
        roll: { offset_x: 10, offset_y: -4, offset_left: 99 },
      }),
    );
    expect(out.roll.offset_left).toBe(99); // specific beats combo
    expect(out.roll.offset_right).toBe(10);
    expect(out.roll.offset_top).toBe(-4);
    expect(out.roll.offset_bottom).toBe(-4);
  });

  it('rejects invalid JSON by throwing', () => {
    expect(() => importPresetsFromJson('{nope')).toThrow();
  });
});
