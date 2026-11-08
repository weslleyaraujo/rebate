import { useCallback, useRef, useState } from 'react';
import { isImageFile, isZipFile } from '../lib/imageUtil.js';

export default function DropZone({ onFiles, disabled }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const handleFiles = useCallback(
    (list) => {
      const files = Array.from(list || []).filter((f) => isImageFile(f) || isZipFile(f));
      if (files.length) onFiles(files);
    },
    [onFiles],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!disabled) handleFiles(e.dataTransfer.files);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`flex-1 w-full min-h-[320px] flex flex-col items-center justify-center cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition ${
        dragOver
          ? 'border-amber-400 bg-amber-400/10'
          : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/40'
      } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/jpg,image/png,image/webp,image/tiff,.zip,application/zip"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="text-5xl mb-3">⬇</div>
      <div className="text-xl font-medium">Drop a roll of frames</div>
      <div className="text-sm text-neutral-500 mt-2">
        or click to browse — .jpg / .png / .webp / .tif / .zip
      </div>
      <div className="text-xs text-neutral-600 mt-1">
        You can also paste (⌘V) an image copied from another tab.
      </div>
      <div className="text-xs text-neutral-600 mt-6">
        All processing stays in your browser. Nothing is uploaded.
      </div>
    </div>
  );
}
