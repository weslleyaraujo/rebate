import { useState } from 'react';
import { BUILTIN_PRESETS } from '../lib/presets.js';
import { Toggle, Section } from './controls.jsx';
import VisualParams from './VisualParams.jsx';

export default function ParamsPanel({
  params,
  onChange,
  disabled,
  disabledReason,
  userPresets,
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  onImportPresets,
  onExportPresets,
}) {
  const [saveName, setSaveName] = useState('');

  const userEntries = Object.entries(userPresets);

  return (
    <div className="flex flex-col h-full">
      {disabled && (
        <div className="px-3 py-2 text-[11px] text-amber-600 bg-amber-400/10 border-b app-border">
          {disabledReason || 'Editing is disabled.'}
        </div>
      )}

      <div
        className={`flex flex-col h-full overflow-y-auto ${
          disabled ? 'opacity-50 pointer-events-none' : ''
        }`}
      >
        <Section title="Preset">
          <div className="text-[10px] uppercase tracking-widest app-text-muted">Default</div>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {BUILTIN_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                title={p.description || p.name}
                onClick={() => onApplyPreset(p.params)}
                className="px-2.5 h-7 text-xs rounded-full bg-neutral-800 hover:bg-neutral-700 text-neutral-100"
              >
                {p.name}
              </button>
            ))}
          </div>

          {userEntries.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-widest app-text-muted mt-3">
                Saved
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {userEntries.map(([name, p]) => (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    onClick={() => onApplyPreset(p)}
                    className="px-2.5 h-7 text-xs rounded-full bg-amber-400/10 hover:bg-amber-400/20 text-amber-600 flex items-center gap-1"
                  >
                    {name}
                    <span
                      title="Delete preset"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeletePreset(name);
                      }}
                      className="text-neutral-500 hover:text-red-400"
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="flex gap-1.5 mt-2">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Save current as…"
              className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-neutral-200 focus:outline-none focus:border-amber-400"
            />
            <button
              type="button"
              onClick={() => {
                if (saveName.trim()) {
                  onSavePreset(saveName.trim());
                  setSaveName('');
                }
              }}
              className="px-2.5 h-7 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
            >
              Save
            </button>
          </div>
          <div className="flex gap-1.5 mt-2">
            <button
              type="button"
              onClick={onExportPresets}
              className="flex-1 px-2 h-7 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
            >
              Export JSON
            </button>
            <button
              type="button"
              onClick={() => document.getElementById('preset-import').click()}
              title="Accepts web presets or the CLI's ~/.config/rebate/configs.json"
              className="flex-1 px-2 h-7 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
            >
              Import JSON
            </button>
            <input
              id="preset-import"
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  const r = new FileReader();
                  r.onload = () => onImportPresets(String(r.result));
                  r.readAsText(f);
                }
                e.target.value = '';
              }}
            />
          </div>
          <div className="text-[11px] app-text-muted mt-1.5 leading-snug">
            Import accepts the CLI's <span className="app-text">configs.json</span> or a
            web presets file.
          </div>
        </Section>

        <VisualParams params={params} onChange={onChange} />

        <Section title="Debug">
          <Toggle
            label="Include debug image in export"
            checked={!!params.debug}
            onChange={(v) => onChange('debug', v)}
            help="Export an annotated .debug.jpg showing the detected gate (green) and crop (red)."
          />
        </Section>
      </div>
    </div>
  );
}
