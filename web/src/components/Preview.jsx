import { useEffect, useRef, useState } from 'react';
import DetectionEditor from './DetectionEditor.jsx';

function ZoomableImage({ src, alt }) {
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef(null);
  const containerRef = useRef(null);

  // Attach a NON-passive wheel listener so preventDefault() actually stops the
  // page from zooming/pinching while we zoom the image instead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setT((prev) => ({
        ...prev,
        s: Math.min(12, Math.max(0.2, prev.s * factor)),
      }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e) => {
    drag.current = { px: e.clientX, py: e.clientY, x: t.x, y: t.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const nx = d.x + (e.clientX - d.px);
    const ny = d.y + (e.clientY - d.py);
    setT((prev) => ({ ...prev, x: nx, y: ny }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  // Double-click toggles between fit (1x) and a 3x zoom for inspecting detail.
  const onDoubleClick = () => {
    setT((prev) => (prev.s >= 1.5 ? { s: 1, x: 0, y: 0 } : { s: 3, x: 0, y: 0 }));
  };

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center overflow-hidden touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="max-w-full max-h-full object-contain select-none"
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`,
          cursor: drag.current ? 'grabbing' : 'grab',
        }}
      />
    </div>
  );
}

export default function Preview({
  image,
  params,
  viewMode,
  onViewMode,
  fullRes,
  onToggleFullRes,
  editorMode,
  onToggleEditor,
  gateOverride,
  sprocketOverride,
  onGateChange,
  onSprocketChange,
  onResetDetection,
  locked,
}) {
  if (!image) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-600 text-sm">
        Select a frame to preview
      </div>
    );
  }

  const beforeUrl = image.beforeUrl;
  const afterUrl = image.afterUrl;

  const modeButtons = [
    { v: 'after', label: 'After' },
    { v: 'before', label: 'Before' },
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0 app-surface-2">
      <div className="flex items-center justify-between px-3 py-1.5 border-b app-border">
        <div className="flex gap-1">
          {!editorMode &&
            modeButtons.map((b) => (
              <button
                key={b.v}
                type="button"
                onClick={() => onViewMode(b.v)}
                className={`px-2.5 h-7 text-xs rounded ${
                  viewMode === b.v
                    ? 'bg-white text-black'
                    : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                {b.label}
              </button>
            ))}
          <button
            type="button"
            title="Show the detected frame and drag to fix it"
            onClick={onToggleEditor}
            className={`px-2.5 h-7 text-xs rounded ${
              editorMode
                ? 'bg-amber-400 text-black'
                : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
            }`}
          >
            Detect
          </button>
        </div>
        <div className="flex items-center gap-2">
          {!editorMode && (
            <>
              <span className="text-[10px] text-neutral-600 hidden lg:inline">
                scroll zoom · drag pan · double-click zoom
              </span>
              <button
                type="button"
                title="Preview at native resolution (slower — a few seconds per preview)"
                onClick={onToggleFullRes}
                className={`px-2.5 h-7 text-xs rounded ${
                  fullRes ? 'bg-amber-400 text-black' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                Full-res
              </button>
            </>
          )}
          {editorMode && (
            <>
              <span className="text-[10px] text-neutral-500 hidden lg:inline">
                gate green · crop red · sprockets cyan
              </span>
              <button
                type="button"
                onClick={onToggleEditor}
                className="px-3 h-7 text-xs rounded bg-amber-400 text-black font-medium hover:bg-amber-300"
              >
                Done
              </button>
            </>
          )}
        </div>
      </div>

      {image.status === 'error' && (
        <div className="px-3 py-1 text-[11px] text-red-400">{image.error || 'error'}</div>
      )}

      <div className="relative flex-1 min-h-0">
        {image.status === 'processing' && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-[2px]">
            <div className="w-9 h-9 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <div className="text-sm text-neutral-200">Regenerating…</div>
          </div>
        )}

        {editorMode ? (
          <DetectionEditor
            image={image}
            params={params}
            gateOverride={gateOverride}
            sprocketOverride={sprocketOverride}
            locked={locked}
            onGateChange={onGateChange}
            onSprocketChange={onSprocketChange}
            onReset={onResetDetection}
          />
        ) : (
          <ZoomableImage
            src={viewMode === 'before' ? beforeUrl : afterUrl}
            alt={image.name}
          />
        )}
      </div>
    </div>
  );
}
