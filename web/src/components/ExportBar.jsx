import { SelectControl, NumberControl } from './controls.jsx';

export default function ExportBar({
  params,
  onChange,
  exporting,
  progress,
  onExport,
  disabled,
}) {
  return (
    <div className="px-3 py-2.5 border-t app-border app-surface">
      <div className="flex items-end gap-4 flex-wrap">
        <div className="w-28">
          <SelectControl
            label="Format"
            value={params.format}
            options={[
              { value: 'jpg', label: 'JPG' },
              { value: 'png', label: 'PNG' },
            ]}
            onChange={(v) => onChange('format', v)}
          />
        </div>
        {params.format === 'jpg' && (
          <div className="w-40">
            <NumberControl
              label="JPEG quality"
              value={params.quality}
              min={1}
              max={100}
              step={1}
              onChange={(v) => onChange('quality', v)}
            />
          </div>
        )}
        <div className="w-40">
          <NumberControl
            label="Canvas size (px)"
            value={params.size}
            min={0}
            max={10000}
            step={100}
            unit="0 = native"
            onChange={(v) => onChange('size', v)}
            help="Square canvas size; 0 = native resolution (no resampling)."
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {exporting && progress && (
            <span className="text-xs text-neutral-400 tabular-nums">
              exporting {progress.done}/{progress.total}…
            </span>
          )}
          <button
            type="button"
            data-testid="export-download"
            onClick={onExport}
            disabled={disabled || exporting}
            className="px-4 h-9 rounded-full bg-[#E6C21F] text-black text-sm font-medium flex items-center gap-2 disabled:opacity-40"
          >
            {exporting ? 'Exporting…' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  );
}
