import { DEFAULTS } from './params.js';

const STORAGE_KEY = 'rebate.presets.v1';

// Built-in looks. Each is just a combination of the real params — the core is
// still "just a crop" (no synthetic grain/color), so these vary border, corner,
// edge, and canvas character.
export const BUILTIN_PRESETS = [
  {
    name: 'Natural',
    description: 'The classic rebate: real film border, soft corners, slightly wavy edges.',
    params: { ...DEFAULTS },
  },
  {
    name: 'Sprockets',
    description: 'Forces a tiny sprocket sliver on one side when the rebate is thin enough.',
    params: { ...DEFAULTS, sprocket_chance: 1 },
  },
  {
    name: 'Clean',
    description: 'Perfectly straight, hard edges with square corners.',
    params: { ...DEFAULTS, radius: 0, roughness: 0, feather: 0, square_corner_chance: 1 },
  },
  {
    name: 'Rounded',
    description: 'Generous, even corner radius.',
    params: { ...DEFAULTS, radius: 0.06, radius_jitter: 0, square_corner_chance: 0 },
  },
  {
    name: 'Soft',
    description: 'A soft, feathered, dreamy edge.',
    params: { ...DEFAULTS, radius: 0.02, roughness: 0.5, feather: 8, square_corner_chance: 0 },
  },
  {
    name: 'Tight',
    description: 'A very thin border, cropped close to the gate.',
    params: { ...DEFAULTS, border: 0.006, margin: 0.02, radius: 0.008 },
  },
  {
    name: 'Full bleed',
    description: 'Just the 3:2 photo — no border, no canvas.',
    params: { ...DEFAULTS, plain: true },
  },
  {
    name: 'Instagram',
    description: 'Square 3000px canvas with a comfortable margin, quality 95.',
    params: { ...DEFAULTS, size: 3000, margin: 0.06, border: 0.035, roughness: 0.6, quality: 95 },
  },
];

export function loadUserPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveUserPresets(presets) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function serializePreset(params) {
  // Only store non-default values, mirroring the CLI's minimal configs.
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== DEFAULTS[k]) out[k] = v;
  }
  return out;
}

/**
 * Import presets from JSON. Accepts both:
 *  - the web format: { name: { ...web params } }
 *  - the CLI config format (~/.config/rebate/configs.json): { name: { dest flags } }
 *
 * CLI-only dest keys are translated: `suffix` -> format, and the
 * `offset_x` / `offset_y` shorthands are expanded into the four edges
 * (a specific edge flag still wins over the combo, like the CLI).
 */
export function importPresetsFromJson(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('invalid presets file');
  }

  const out = {};
  for (const [name, cfg] of Object.entries(data)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;

    const p = { ...DEFAULTS };

    // Shorthands first, so specific keys below can override them.
    if ('offset_x' in cfg) {
      p.offset_left = Number(cfg.offset_x);
      p.offset_right = Number(cfg.offset_x);
    }
    if ('offset_y' in cfg) {
      p.offset_top = Number(cfg.offset_y);
      p.offset_bottom = Number(cfg.offset_y);
    }
    if ('suffix' in cfg) {
      p.format = String(cfg.suffix).toLowerCase().endsWith('.png') ? 'png' : 'jpg';
    }

    for (const [k, v] of Object.entries(cfg)) {
      if (k in DEFAULTS) p[k] = v;
    }

    out[name] = p;
  }
  return out;
}
