import ZoomableImage from './ZoomableImage.jsx';

// Preview of one merge group (the frames ticked and "merged" together).
// Shown in place of the single-frame preview while a group is selected.
export default function GroupPreview({ preview, onBack, onEditDetection, editingFrameName }) {
  const busy = preview.status === 'processing';

  return (
    <div className="flex-1 flex flex-col min-h-0 app-surface-2">
      <div className="flex items-center justify-between px-3 py-1.5 border-b app-border">
        <span className="text-xs text-neutral-400">
          Merged group preview{editingFrameName ? ` — editing ${editingFrameName}` : ''}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title="Edit the selected frame's detection (gate/crop/sprocket)"
            onClick={onEditDetection}
            className="px-2.5 h-7 text-xs rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          >
            Detect
          </button>
          <button
            type="button"
            onClick={onBack}
            className="px-2.5 h-7 text-xs rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          >
            ← Back to frames
          </button>
        </div>
      </div>

      {preview.error && (
        <div className="px-3 py-1 text-[11px] text-red-400">{preview.error}</div>
      )}

      <div className="relative flex-1 min-h-0">
        {preview.url ? (
          <ZoomableImage src={preview.url} alt="merged group" />
        ) : (
          !busy && (
            <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm">
              Waiting for a merged preview…
            </div>
          )
        )}

        {busy && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-[2px]">
            <div className="w-9 h-9 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <div className="text-sm text-neutral-200">Tiling…</div>
          </div>
        )}
      </div>
    </div>
  );
}
