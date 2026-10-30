import { useEffect, useRef, useState } from 'react';

// Fullscreen-friendly image viewer: scroll to zoom, drag to pan, double-click
// to toggle between fit (1x) and a 3x zoom for inspecting detail.
export default function ZoomableImage({ src, alt }) {
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
      {src ? (
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
      ) : (
        <div className="text-neutral-600 text-sm">processing…</div>
      )}
    </div>
  );
}
