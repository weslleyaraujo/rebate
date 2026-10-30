import { PARAM_GROUPS } from '../lib/params.js';
import { NumberControl, SeedControl, SelectControl, Section } from './controls.jsx';

// The visual/look params (mode, seed, crop, corners & edge). Shared between the
// roll-level panel (global params) and the per-frame panel (frame overrides).
export default function VisualParams({ params, onChange, disabled }) {
  return (
    <>
      <Section title="Mode">
        <SelectControl
          label="Output mode"
          value={params.plain ? 'plain' : 'bordered'}
          options={[
            { value: 'bordered', label: 'Bordered' },
            { value: 'plain', label: 'Plain (no border)' },
          ]}
          disabled={disabled}
          onChange={(v) => onChange('plain', v === 'plain')}
          help="Bordered = frame + film border on white. Plain = just the 3:2 photo."
        />
        <SeedControl value={params.seed} disabled={disabled} onChange={(v) => onChange('seed', v)} />
      </Section>

      {PARAM_GROUPS.map((group) => (
        <Section key={group.key} title={group.label}>
          {group.params.map((def) => (
            <NumberControl
              key={def.key}
              label={def.label}
              value={params[def.key]}
              min={def.min}
              max={def.max}
              step={def.step}
              disabled={disabled}
              onChange={(v) => onChange(def.key, v)}
              help={def.help}
            />
          ))}
        </Section>
      ))}
    </>
  );
}
