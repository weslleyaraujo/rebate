import { useEffect, useRef } from 'react';

function Thumb({ img, selected, onSelect, onDelete }) {
  const ref = useRef(null);

  // Keep the selected frame visible in the horizontally-scrolling filmstrip,
  // including when the selection changes via the ←/→ keyboard shortcuts.
  useEffect(() => {
    if (selected && ref.current) {
      ref.current.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }, [selected]);

  const url = img.afterUrl || img.beforeUrl;
  return (
    <div
      ref={ref}
      data-testid="frame-thumb"
      className={`relative shrink-0 w-24 group cursor-pointer rounded-md overflow-hidden border ${
        selected ? 'border-amber-400' : 'border-neutral-700'
      }`}
      onClick={() => onSelect(img.id)}
    >
      {url ? (
        <img src={url} alt={img.name} className="w-full h-20 object-cover block" />
      ) : (
        <div className="w-full h-20 bg-neutral-800 flex items-center justify-center text-neutral-600 text-[10px]">
          …
        </div>
      )}
      <div className="px-1.5 py-1 bg-neutral-900/80">
        <div className="text-[10px] text-neutral-400 truncate" title={img.name}>
          {img.name}
        </div>
      </div>
      {img.status === 'processing' && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
          <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {img.status === 'error' && (
        <div className="absolute inset-0 bg-red-900/60 flex items-center justify-center text-red-200 text-[10px]">
          !
        </div>
      )}
      <button
        type="button"
        title="Remove frame (⌫)"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(img.id);
        }}
        className="absolute top-1 right-1 flex w-5 h-5 bg-neutral-900/80 text-neutral-300 hover:text-red-400 hover:bg-neutral-900 rounded-full items-center justify-center text-xs opacity-80 group-hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

export default function Filmstrip({ images, selectedId, onSelect, onDelete }) {
  if (!images.length) return null;

  return (
    <div className="px-3 py-2 border-b app-border">
      <h3 className="text-[11px] uppercase tracking-widest app-text-muted mb-1.5">
        Frames ({images.length})
      </h3>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {images.map((img) => (
          <Thumb
            key={img.id}
            img={img}
            selected={img.id === selectedId}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}
