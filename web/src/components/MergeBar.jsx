const LAYOUTS = [
  { value: 'vertical', label: 'Vertical' },
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'grid', label: 'Grid (2 cols)' },
  { value: 'grid:2x2', label: '2×2' },
  { value: 'grid:3x2', label: '3×2' },
];

// Merge settings bar: layout + gap. (Groups are made by dragging one frame onto
// another in the filmstrip.)
export default function MergeBar({ layout, gap, onChange }) {
  return (
    <div className="px-3 py-2 border-b app-border app-surface">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="text-[11px] uppercase tracking-widest app-text-muted shrink-0">
          Merge
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {LAYOUTS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange('layout', o.value)}
              className={`px-2.5 h-7 text-xs rounded ${
                layout === o.value
                  ? 'bg-white text-black'
                  : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-neutral-400">
          Gap
          <input
            type="number"
            value={gap ?? ''}
            min={0}
            max={0.2}
            step={0.005}
            onChange={(e) =>
              onChange('gap', e.target.value === '' ? null : Number(e.target.value))
            }
            className="w-16 bg-neutral-800 border border-neutral-700 rounded px-1.5 py-0.5 text-right text-xs text-neutral-200 focus:outline-none focus:border-amber-400"
          />
        </label>

        <span className="text-[11px] text-neutral-500">
          drag one frame onto another to merge them
        </span>
      </div>
    </div>
  );
}
