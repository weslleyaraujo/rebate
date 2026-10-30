// Parameter schema + defaults for the web client.
//
// This mirrors the CLI's `_OPTION_SPECS` (rebate/cli.py) but adds UI metadata
// (labels, ranges, steps, groups). The values here MUST stay in sync with the
// CLI defaults; the browser client passes every value explicitly to
// `core.process_image` so function-level defaults are never relied upon.

export const DEFAULTS = {
  size: 0, // 0 = native resolution
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
  gate_override: null, // [left, top, right, bottom] in landscape px; null = auto
  sprocket_override: null, // [top_sprocket_bottom, bottom_sprocket_top]; null = auto
  seed: null, // null = random (like omitting --seed on the CLI)
  quality: 100,
  plain: false,
  debug: false,
  format: 'jpg', // 'jpg' | 'png'
};

// Ordered groups for the UI. Each entry is { key, label, params: [def] }.
// A def is { key, label, min, max, step, unit, help, advanced, kind }.
export const PARAM_GROUPS = [
  {
    key: 'crop',
    label: 'Crop',
    params: [
      { key: 'border', label: 'Border', min: 0, max: 0.2, step: 0.002, help: 'Film border kept around the gate (fraction of gate height). Higher = a thicker black rebate around the photo.' },
      { key: 'margin', label: 'Margin', min: 0, max: 0.25, step: 0.002, help: 'White margin around the crop on the final canvas (fraction).' },
      { key: 'sprocket_chance', label: 'Sprocket chance', min: 0, max: 1, step: 0.01, help: 'Probability (0–1) that a tiny sliver of sprocket holes shows on at most one side. Only when the rebate is thin enough.' },
      { key: 'max_sprocket_border', label: 'Max sprocket border', min: 0, max: 0.15, step: 0.002, advanced: true, help: 'The largest rebate (fraction of gate height) that still shows a sprocket sliver; beyond it the crop keeps a plain border.' },
      { key: 'border_jitter', label: 'Border jitter', min: 0, max: 1, step: 0.01, help: 'Random shift of the black border (fraction of border thickness). 0 = perfectly even; higher = the photo sits off-center on a random side.' },
    ],
  },
  {
    key: 'edge',
    label: 'Corners & edge',
    params: [
      { key: 'radius', label: 'Corner radius', min: 0, max: 0.15, step: 0.001, help: 'Corner rounding (fraction of the final crop size). 0 = sharp square corners.' },
      { key: 'radius_jitter', label: 'Radius jitter', min: 0, max: 0.5, step: 0.005, advanced: true, help: 'Random ± variation of the corner radius, as a fraction. 0 = all corners identical.' },
      { key: 'square_corner_chance', label: 'Square corner chance', min: 0, max: 1, step: 0.01, help: 'Probability (0–1) that one corner, or two corners on the same side, are left squared off instead of rounded.' },
      { key: 'roughness', label: 'Roughness (px)', min: 0, max: 20, step: 0.1, help: 'Edge irregularity in pixels. 0 = perfectly straight edges; higher = more wavy, hand-cut look.' },
      { key: 'feather', label: 'Feather (px)', min: 0, max: 30, step: 0.1, help: 'Edge softness in pixels. 0 = hard edge; higher = a softer, feathered transition to white.' },
    ],
  },
];

// Offsets are presented as a single "Offsets" group but are conceptually
// per-image nudges. They live in DEFAULTS so they flow through the same
// merge/scale logic.
export const OFFSET_DEFS = [
  { key: 'offset_left', label: 'Left (px)', min: -3000, max: 3000, step: 1, help: 'Positive reveals more of the left side, negative trims inward. Pixels at full scan resolution.' },
  { key: 'offset_right', label: 'Right (px)', min: -3000, max: 3000, step: 1, help: 'Positive reveals more of the right side, negative trims inward. Pixels at full scan resolution.' },
  { key: 'offset_top', label: 'Top (px)', min: -3000, max: 3000, step: 1, help: 'Positive reveals more of the top, negative trims inward. Pixels at full scan resolution.' },
  { key: 'offset_bottom', label: 'Bottom (px)', min: -3000, max: 3000, step: 1, help: 'Positive reveals more of the bottom, negative trims inward. Pixels at full scan resolution.' },
];

export const ALL_PARAM_KEYS = [
  ...PARAM_GROUPS.flatMap((g) => g.params.map((p) => p.key)),
  ...OFFSET_DEFS.map((p) => p.key),
];

export function isAdvanced(key) {
  for (const g of PARAM_GROUPS) {
    const p = g.params.find((d) => d.key === key);
    if (p) return !!p.advanced;
  }
  return false;
}

export function mergeParams(base, override) {
  return { ...base, ...(override || {}) };
}

// The CLI's offsets are defined "in pixels at full scan resolution". When the
// browser previews on a downscaled copy, pixel-sized params (offsets,
// roughness, feather) must be scaled by the same factor so the preview matches
// the eventual native export. Fraction params are scale-free.
const PX_PARAMS = new Set(['offset_left', 'offset_right', 'offset_top', 'offset_bottom', 'roughness', 'feather']);

export function scaleParamsForPreview(params, factor) {
  const out = { ...params };
  for (const k of PX_PARAMS) {
    if (typeof out[k] === 'number') out[k] = out[k] * factor;
  }
  // Manual detection overrides are also in landscape px. Sprocket overrides
  // may legitimately contain `null` for an undetectable side — preserve those
  // rather than coercing them to 0 (which would change the preview's sliver).
  for (const k of ['gate_override', 'sprocket_override']) {
    if (Array.isArray(out[k])) out[k] = out[k].map((v) => (v == null ? null : v * factor));
  }
  return out;
}

export function suffixFor(params) {
  const ext = params.format === 'png' ? '.png' : '.jpg';
  return params.plain ? `.plain${ext}` : `.bordered${ext}`;
}
