import { useEffect, useRef, useState } from 'react';

function FrameThumb({
  img,
  selected,
  onSelect,
  onDelete,
  index,
  dragging,
  onDragStart,
  onDragEnd,
  draggable = true,
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (selected && ref.current) {
      ref.current.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }, [selected]);

  const url = img.afterUrl || img.beforeUrl;
  const isDragging = dragging === index;

  return (
    <div
      ref={ref}
      data-testid="frame-thumb"
      data-frame-id={img.id}
      draggable={draggable}
      onDragStart={(e) => draggable && onDragStart(e, index)}
      onDragEnd={onDragEnd}
      className={`relative shrink-0 w-24 group cursor-pointer rounded-md overflow-hidden border ${
        selected ? 'border-amber-400' : 'border-neutral-700'
      } ${isDragging ? 'opacity-40' : ''}`}
      onClick={() => onSelect(img.id)}
    >
      {url ? (
        <img
          src={url}
          alt={img.name}
          draggable={false}
          className="w-full h-20 object-cover block pointer-events-none"
        />
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
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center pointer-events-none">
          <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {img.status === 'error' && (
        <div className="absolute inset-0 bg-red-900/60 flex items-center justify-center text-red-200 text-[10px] pointer-events-none">
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

function GroupThumb({ group, preview, onSelect, onRemove }) {
  const url = preview?.url;
  const busy = preview?.status === 'processing';

  return (
    <div
      data-testid="merge-group-thumb"
      data-merge-group-id={group.id}
      onClick={() => onSelect(group.id)}
      className="relative shrink-0 w-24 cursor-pointer rounded-md overflow-hidden border border-amber-400/70 bg-neutral-900/60"
    >
      {url ? (
        <img
          src={url}
          alt={`group of ${group.frameIds.length}`}
          draggable={false}
          className="w-full h-20 object-cover block pointer-events-none"
        />
      ) : (
        <div className="w-full h-20 bg-neutral-800 flex items-center justify-center text-neutral-500 text-[10px]">
          {busy ? 'tiling…' : 'group'}
        </div>
      )}
      <div className="px-1.5 py-1 bg-neutral-900/80 flex items-center justify-between">
        <span className="text-[10px] text-amber-300 truncate">
          Group ({group.frameIds.length})
        </span>
        <button
          type="button"
          title="Ungroup"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(group.id);
          }}
          className="w-4 h-4 rounded-full text-neutral-400 hover:text-red-400 flex items-center justify-center text-xs"
        >
          ×
        </button>
      </div>
      {busy && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center pointer-events-none">
          <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
}

export default function Filmstrip({
  images,
  groups,
  mergePreviews,
  activeGroupId,
  selectedId,
  onSelect,
  onSelectMember,
  onSelectGroup,
  onBackGroup,
  onRemoveGroup,
  onDelete,
  onMove,
  onMerge,
}) {
  const [dragging, setDragging] = useState(null); // frame index being dragged
  const hintElRef = useRef(null); // frame element currently showing a drop hint

  const clearHint = () => {
    if (hintElRef.current) {
      hintElRef.current.classList.remove(
        'drop-hint-before',
        'drop-hint-merge',
        'drop-hint-after',
      );
      hintElRef.current = null;
    }
  };

  const applyHint = (el, zone) => {
    if (hintElRef.current !== el) clearHint();
    el.classList.remove('drop-hint-before', 'drop-hint-merge', 'drop-hint-after');
    el.classList.add(
      zone === 'before'
        ? 'drop-hint-before'
        : zone === 'after'
          ? 'drop-hint-after'
          : 'drop-hint-merge',
    );
    hintElRef.current = el;
  };

  const reset = () => {
    clearHint();
    setDragging(null);
  };

  const handleDragStart = (e, index) => {
    setDragging(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    if (dragging == null) return;
    const frameEl = e.target.closest('[data-frame-id]');
    if (frameEl) {
      const r = frameEl.getBoundingClientRect();
      const x = e.clientX - r.left;
      const w = r.width || 1;
      const zone = x < w * 0.3 ? 'before' : x > w * 0.7 ? 'after' : 'merge';
      applyHint(frameEl, zone);
    } else {
      clearHint();
    }
  };

  // Single drop handler on the container: decide from the cursor position.
  const handleContainerDrop = (e) => {
    e.preventDefault();
    if (dragging == null) {
      reset();
      return;
    }
    const fromId = images[dragging]?.id;
    if (!fromId) {
      reset();
      return;
    }

    // Dropped onto a group -> add the frame to that group.
    const groupEl = e.target.closest('[data-merge-group-id]');
    if (groupEl) {
      onMerge(fromId, groupEl.dataset.mergeGroupId);
      reset();
      return;
    }

    // Dropped onto a frame: edges = reorder before/after, middle = merge.
    const frameEl = e.target.closest('[data-frame-id]');
    if (frameEl) {
      const targetId = frameEl.dataset.frameId;
      if (targetId !== fromId) {
        const r = frameEl.getBoundingClientRect();
        const x = e.clientX - r.left;
        const w = r.width || 1;
        if (x < w * 0.3) onMove(fromId, targetId, 'before');
        else if (x > w * 0.7) onMove(fromId, targetId, 'after');
        else onMerge(fromId, targetId);
      }
      reset();
      return;
    }

    // Dropped in a gap: reorder to the nearest position.
    const thumbs = Array.from(
      e.currentTarget.querySelectorAll('[data-frame-id]'),
    );
    const x = e.clientX;
    let targetId = null;
    let placement = 'before';
    for (const el of thumbs) {
      const r = el.getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        targetId = el.dataset.frameId;
        placement = 'before';
        break;
      }
    }
    if (!targetId && thumbs.length) {
      targetId = thumbs[thumbs.length - 1].dataset.frameId;
      placement = 'after';
    }
    if (targetId && targetId !== fromId) onMove(fromId, targetId, placement);
    reset();
  };

  // Drilled into a merge group: show its member frames for individual tweaking.
  if (activeGroupId) {
    const group = groups.find((g) => g.id === activeGroupId);
    const members = (group?.frameIds || [])
      .map((id) => images.find((im) => im.id === id))
      .filter(Boolean);

    return (
      <div className="px-3 py-2 border-b app-border">
        <div className="flex items-center gap-2 mb-1.5">
          <button
            type="button"
            onClick={onBackGroup}
            className="px-2 h-6 text-xs rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
          >
            ← Back
          </button>
          <h3 className="text-[11px] uppercase tracking-widest app-text-muted">
            Merge group — pick a frame to tweak
          </h3>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {members.map((img) => (
            <FrameThumb
              key={img.id}
              img={img}
              selected={img.id === selectedId}
              onSelect={onSelectMember}
              onDelete={onDelete}
              index={-1}
              dragging={null}
              onDragStart={() => {}}
              onDragEnd={() => {}}
              draggable={false}
            />
          ))}
        </div>
      </div>
    );
  }

  // Main view: group entries + individual frames.
  return (
    <div className="px-3 py-2 border-b app-border">
      <h3 className="text-[11px] uppercase tracking-widest app-text-muted mb-1.5">
        Frames ({images.length}){' '}
        <span className="normal-case tracking-normal text-neutral-600">
          · drag to reorder — drop one frame onto another to merge
        </span>
      </h3>
      <div
        className="flex gap-2 overflow-x-auto pb-1"
        onDragOver={handleDragOver}
        onDrop={handleContainerDrop}
      >
        {groups.map((g) => (
          <GroupThumb
            key={g.id}
            group={g}
            preview={mergePreviews[g.id]}
            onSelect={onSelectGroup}
            onRemove={onRemoveGroup}
          />
        ))}
        {images.map((img, i) => (
          <FrameThumb
            key={img.id}
            img={img}
            selected={img.id === selectedId}
            onSelect={onSelect}
            onDelete={onDelete}
            index={i}
            dragging={dragging}
            onDragStart={handleDragStart}
            onDragEnd={reset}
          />
        ))}
      </div>
    </div>
  );
}
