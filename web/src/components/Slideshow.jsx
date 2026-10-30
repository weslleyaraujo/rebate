import ZoomableImage from './ZoomableImage.jsx';

// Full-screen image viewer (Lightroom-style "F" view). Shows the processed
// result full-screen, navigates with ←/→ or the on-screen arrows, and closes
// with Esc / F / the ✕ button.
export default function Slideshow({ image, index, total, onPrev, onNext, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <div className="flex items-center gap-3 px-4 h-12 shrink-0 text-neutral-300">
        <span className="text-sm truncate flex-1" title={image?.name}>
          {image?.name}
        </span>
        <span className="text-[11px] text-neutral-500 tabular-nums whitespace-nowrap">
          {index + 1} / {total}
        </span>
        <span className="text-[11px] text-neutral-600 hidden sm:inline whitespace-nowrap">
          ← → navigate · F / Esc exit
        </span>
        <button
          type="button"
          title="Close (Esc)"
          onClick={onClose}
          className="w-8 h-8 rounded-full bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        <ZoomableImage src={image?.afterUrl} alt={image?.name} />

        <button
          type="button"
          title="Previous (←)"
          onClick={onPrev}
          className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/60 hover:bg-black/80 text-white text-2xl flex items-center justify-center"
        >
          ‹
        </button>
        <button
          type="button"
          title="Next (→)"
          onClick={onNext}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/60 hover:bg-black/80 text-white text-2xl flex items-center justify-center"
        >
          ›
        </button>
      </div>
    </div>
  );
}
