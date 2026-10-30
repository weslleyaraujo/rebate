import { OFFSET_DEFS } from '../lib/params.js';
import { NumberControl, Section } from './controls.jsx';
import VisualParams from './VisualParams.jsx';

export default function FramePanel({
  image,
  globalParams,
  override,
  onChange,
  onReset,
  onDownload,
  onRemove,
  locked,
  onToggleLock,
  onRegenerate,
  onCopySeed,
  onApplySeedToAll,
  onOpenEditor,
}) {
  if (!image) return null;

  const hasOverride = override && Object.keys(override).length > 0;
  const effective = { ...globalParams, ...(override || {}) };
  const gateOverride = override?.gate_override || null;
  const sprocketOverride = override?.sprocket_override || null;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <Section title="Frame">
        <div className="text-xs app-text truncate" title={image.name}>
          {image.name}
        </div>
        <div className="text-[11px] app-text-muted">
          {image.status === 'done' ? 'ready' : image.status}
          {hasOverride && <span className="text-amber-400"> · overrides</span>}
          {locked && <span className="text-amber-400"> · locked</span>}
        </div>
        <div className="flex gap-1.5 mt-2">
          <button
            type="button"
            onClick={onDownload}
            className="flex-1 px-2 h-7 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
          >
            Download
          </button>
          <button
            type="button"
            onClick={onReset}
            disabled={!hasOverride && !locked}
            className="px-2 h-7 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 disabled:opacity-40"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="px-2 h-7 text-xs rounded bg-neutral-800 hover:bg-red-900/50 text-neutral-300 hover:text-red-300"
          >
            Remove
          </button>
        </div>
      </Section>

      <Section title="Random look">
        <p className="text-[11px] app-text-muted -mt-1 mb-1 leading-snug">
          Regenerate the random details for this frame, or freeze them.
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={onRegenerate}
            disabled={locked}
            className="px-2 h-8 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 disabled:opacity-40"
          >
            🎲 Regenerate
          </button>
          <button
            type="button"
            onClick={onToggleLock}
            className={`px-2 h-8 text-xs rounded ${
              locked
                ? 'bg-amber-400 text-black'
                : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
            }`}
          >
            {locked ? '🔒 Locked' : '🔓 Lock'}
          </button>
          <button
            type="button"
            onClick={onCopySeed}
            title="Copy this frame's seed to the clipboard"
            className="px-2 h-8 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
          >
            Copy seed
          </button>
          <button
            type="button"
            onClick={onApplySeedToAll}
            title="Apply this frame's seed to the whole roll"
            className="px-2 h-8 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
          >
            Seed → all
          </button>
        </div>
      </Section>

      <Section title="Offsets (this frame only)">
        <p className="text-[11px] app-text-muted -mt-1 mb-1">
          Pixels at full scan resolution. Positive reveals more, negative trims inward.
        </p>
        {OFFSET_DEFS.map((def) => (
          <NumberControl
            key={def.key}
            label={def.label}
            value={override?.[def.key] ?? globalParams[def.key]}
            min={def.min}
            max={def.max}
            step={def.step}
            unit="px"
            disabled={locked}
            onChange={(v) => onChange(def.key, v)}
            help={def.help}
          />
        ))}
      </Section>

      <Section title="Detection">
        <p className="text-[11px] app-text-muted -mt-1 mb-1 leading-snug">
          See where auto-detection drew the frame, then drag to fix it — no pixel
          math. The green gate is editable; sprocket lines (cyan) adjust the sliver.
        </p>
        <button
          type="button"
          onClick={onOpenEditor}
          className="w-full px-2 h-8 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
        >
          ✥ Edit detection visually
        </button>
        {(gateOverride || sprocketOverride) && (
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[11px] text-amber-400">manual override set</span>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                onChange('gate_override', null);
                onChange('sprocket_override', null);
              }}
              className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 hover:text-neutral-200"
            >
              reset to auto
            </button>
          </div>
        )}
      </Section>

      <Section title="Per-frame settings">
        <p className="text-[11px] app-text-muted -mt-1 mb-1 leading-snug">
          Override any roll setting just for this frame.
        </p>
        <VisualParams params={effective} onChange={onChange} disabled={locked} />
      </Section>
    </div>
  );
}
