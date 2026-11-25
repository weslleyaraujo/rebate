import { useCallback, useEffect, useRef, useState } from 'react';
import DropZone from './components/DropZone.jsx';
import Filmstrip from './components/Filmstrip.jsx';
import ParamsPanel from './components/ParamsPanel.jsx';
import FramePanel from './components/FramePanel.jsx';
import Preview from './components/Preview.jsx';
import MergeBar from './components/MergeBar.jsx';
import GroupPreview from './components/GroupPreview.jsx';
import Slideshow from './components/Slideshow.jsx';
import ExportBar from './components/ExportBar.jsx';
import { DEFAULTS, mergeParams, scaleParamsForPreview, suffixFor } from './lib/params.js';
import { pinDetectionFromPreview } from './lib/detection.js';
import {
  loadUserPresets,
  saveUserPresets,
  serializePreset,
  importPresetsFromJson,
} from './lib/presets.js';
import {
  readFileAsArrayBuffer,
  blobToArrayBuffer,
  downscaleFile,
  downscaleFileToFactor,
  loadImage,
  objectUrlFor,
  downloadBlob,
  downloadBuffer,
  zipEntries,
  baseName,
  isZipFile,
  isImageFile,
  extractImagesFromZip,
} from './lib/imageUtil.js';
import { initWorker, processImage, processMerge } from './lib/workerClient.js';

const PREVIEW_MAX_SIDE = 2560;
const WORKSPACE_KEY = 'rebate.workspace.v1';
const WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const THEME_KEY = 'rebate.theme';
let idCounter = 0;

const hasFiles = (e) => {
  const dt = e.dataTransfer;
  return !!(dt && dt.types && Array.from(dt.types).includes('Files'));
};

// Mime type -> file extension for pasted clipboard images (no real filename).
const PASTE_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'image/tif': 'tif',
};

const nameForPasted = (mime, i) => {
  const ext = PASTE_EXT[mime] || 'png';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `pasted-${stamp}${i > 0 ? `-${i + 1}` : ''}.${ext}`;
};

export default function App() {
  const [images, setImages] = useState([]);
  const [globalParams, setGlobalParams] = useState(DEFAULTS);
  const [overrides, setOverrides] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [userPresets, setUserPresets] = useState(() => loadUserPresets());
  const [workerStatus, setWorkerStatus] = useState('starting');
  const [viewMode, setViewMode] = useState('after');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(null);
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editorMode, setEditorMode] = useState(false);
  const [slideshow, setSlideshow] = useState(false);
  const [lockedIds, setLockedIds] = useState(() => new Set());
  const [lockedSnapshots, setLockedSnapshots] = useState({});
  const [restoredIds, setRestoredIds] = useState(() => new Set());
  const [activePreset, setActivePreset] = useState(null); // { name, params } | null
  const [fullResIds, setFullResIds] = useState(() => new Set());
  const [bannerHidden, setBannerHidden] = useState(false);
  const [groups, setGroups] = useState([]);
  const [mergePreviews, setMergePreviews] = useState({});
  const [activeGroupId, setActiveGroupId] = useState(null);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) || 'system';
    } catch {
      return 'system';
    }
  });
  const [, setHistoryTick] = useState(0);

  // Refs so async worker callbacks always read the latest state.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const paramsRef = useRef(globalParams);
  paramsRef.current = globalParams;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const mergePreviewsRef = useRef(mergePreviews);
  mergePreviewsRef.current = mergePreviews;
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const seqRef = useRef(new Map());
  const debounceRef = useRef(new Map());
  const mergePreviewSeqRef = useRef(0);
  const dragDepthRef = useRef(0);
  const historyRef = useRef({
    stack: [{ globalParams: DEFAULTS, overrides: {} }],
    index: 0,
  });
  const historyTimerRef = useRef(null);
  const lockedIdsRef = useRef(lockedIds);
  lockedIdsRef.current = lockedIds;
  const lockedSnapshotsRef = useRef(lockedSnapshots);
  lockedSnapshotsRef.current = lockedSnapshots;
  const restoredIdsRef = useRef(restoredIds);
  restoredIdsRef.current = restoredIds;
  const editorModeRef = useRef(editorMode);
  editorModeRef.current = editorMode;
  const slideshowRef = useRef(slideshow);
  slideshowRef.current = slideshow;
  const fullResIdsRef = useRef(fullResIds);
  fullResIdsRef.current = fullResIds;
  const savedOverridesRef = useRef({}); // filename -> overrides (restored on upload)
  const savedLockedRef = useRef(new Set()); // filenames locked in a previous session
  const savedLockedSnapshotsRef = useRef({}); // filename -> locked param snapshot
  const savedOrderRef = useRef([]); // filenames in the last saved order

  useEffect(() => {
    initWorker({
      onStatus: (m) => setWorkerStatus(m),
      onError: (m) => setWorkerStatus(`error: ${m}`),
    });
  }, []);

  // Restore the previous session's params / per-file overrides (if not expired).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_KEY);
      if (!raw) return;
      const ws = JSON.parse(raw);
      if (!ws || typeof ws !== 'object') return;
      if (ws.savedAt && Date.now() - ws.savedAt > WORKSPACE_RETENTION_MS) return;
      if (ws.globalParams && typeof ws.globalParams === 'object') {
        setGlobalParams({ ...DEFAULTS, ...ws.globalParams });
      }
      if (ws.overridesByFile && typeof ws.overridesByFile === 'object') {
        savedOverridesRef.current = ws.overridesByFile;
      }
      if (ws.lockedByFile && typeof ws.lockedByFile === 'object') {
        savedLockedRef.current = new Set(
          Object.keys(ws.lockedByFile).filter((k) => ws.lockedByFile[k]),
        );
      }
      if (ws.lockedSnapshotsByFile && typeof ws.lockedSnapshotsByFile === 'object') {
        savedLockedSnapshotsRef.current = ws.lockedSnapshotsByFile;
      }
      if (Array.isArray(ws.order)) {
        savedOrderRef.current = ws.order;
      }
    } catch {
      /* ignore corrupt workspace */
    }
  }, []);

  // Persist params / per-file overrides / locks (debounced) so a refresh is safe.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const overridesByFile = {};
        const lockedByFile = {};
        const lockedSnapshotsByFile = {};
        for (const im of images) {
          if (overrides[im.id]) overridesByFile[im.name] = overrides[im.id];
          if (lockedIds.has(im.id)) lockedByFile[im.name] = true;
          if (lockedSnapshots[im.id]) lockedSnapshotsByFile[im.name] = lockedSnapshots[im.id];
        }
        localStorage.setItem(
          WORKSPACE_KEY,
          JSON.stringify({
            savedAt: Date.now(),
            globalParams,
            overridesByFile,
            lockedByFile,
            lockedSnapshotsByFile,
            order: images.map((im) => im.name),
          }),
        );
      } catch {
        /* storage may be unavailable */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [globalParams, overrides, images, lockedIds, lockedSnapshots]);

  // Warn before leaving while there's unsaved work in the session.
  useEffect(() => {
    const handler = (e) => {
      if (imagesRef.current.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // Theme: light / dark / system (auto-follows the OS).
  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  const effectiveParams = useCallback((id) => {
    // A locked frame is frozen to the exact snapshot captured when it was
    // locked (it no longer follows global param changes). Otherwise it's the
    // roll params plus any per-frame overrides.
    if (lockedIdsRef.current.has(id) && lockedSnapshotsRef.current[id]) {
      return lockedSnapshotsRef.current[id];
    }
    return mergeParams(paramsRef.current, overridesRef.current[id]);
  }, []);

  const updateImage = useCallback((id, patch) => {
    setImages((prev) => prev.map((im) => (im.id === id ? { ...im, ...patch } : im)));
  }, []);

  // Resolve a `null` (random) seed into a concrete integer and pin it on the
  // frame, so the preview and every subsequent download use the SAME random
  // choices (border shift, sprocket side, corner rounding, edge texture).
  const resolveSeed = useCallback((id, params) => {
    if (params.seed != null) return params;
    const seed = Math.floor(Math.random() * 2 ** 31);
    setOverrides((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), seed } }));
    return { ...params, seed };
  }, []);

  // ---- merge (pick frames to tile together) ----

  // Target canvas for a merged group: when Canvas size > 0 it's a size x size
  // square; when 0 (native) it's the average width/height of every uploaded
  // frame (so a merge matches a single frame's footprint). `factor` scales it
  // for a downscaled preview.
  const mergeCanvasSizeFor = useCallback(async (factor = 1) => {
    const size = paramsRef.current.size;
    if (size && size > 0) {
      return [
        Math.max(1, Math.round(size * factor)),
        Math.max(1, Math.round(size * factor)),
      ];
    }
    const imgs = imagesRef.current;
    if (!imgs.length) return null;
    let sumW = 0;
    let sumH = 0;
    for (const im of imgs) {
      const { img, url } = await loadImage(im.file);
      sumW += img.naturalWidth;
      sumH += img.naturalHeight;
      URL.revokeObjectURL(url);
    }
    const n = imgs.length;
    return [
      Math.max(1, Math.round((sumW / n) * factor)),
      Math.max(1, Math.round((sumH / n) * factor)),
    ];
  }, []);

  // Per-tile params for a merge: each frame keeps its own effective params
  // (roll params + per-frame overrides), so tiles can be tweaked independently.
  const buildPerImage = useCallback(
    (frames, factor, pin) => {
      return frames.map((f) => {
        let p = effectiveParams(f.id);
        if (pin) p = pinDetectionFromPreview(f, p);
        p = resolveSeed(f.id, p);
        return scaleParamsForPreview(p, factor);
      });
    },
    [effectiveParams, resolveSeed],
  );

  // Generate a fast, downscaled merged preview for one group.
  const generateMergePreview = useCallback(async (groupId, frameIds) => {
    const seq = mergePreviewSeqRef.current + 1;
    mergePreviewSeqRef.current = seq;

    setMergePreviews((prev) => ({
      ...prev,
      [groupId]: {
        url: prev[groupId]?.url ?? null,
        status: 'processing',
        error: null,
      },
    }));

    try {
      const imgs = imagesRef.current;
      const frames = frameIds
        .map((id) => imgs.find((im) => im.id === id))
        .filter(Boolean);
      if (frames.length < 2) return;

      // One common downscale factor for every frame in the group.
      let globalMax = 1;
      for (const f of frames) {
        const { img, url } = await loadImage(f.file);
        globalMax = Math.max(globalMax, img.naturalWidth, img.naturalHeight);
        URL.revokeObjectURL(url);
      }
      const factor = globalMax > PREVIEW_MAX_SIDE ? PREVIEW_MAX_SIDE / globalMax : 1;

      const buffers = [];
      for (const f of frames) {
        const { buffer } = await downscaleFileToFactor(f.file, factor);
        buffers.push(buffer);
      }

      let params = { ...paramsRef.current };
      params = scaleParamsForPreview(params, factor);
      params.size = params.size > 0 ? Math.round(params.size * factor) : 0;
      params.quality = 100;
      params.debug = false;
      const canvasSize = await mergeCanvasSizeFor(factor);
      if (canvasSize) params.canvas_size = canvasSize;
      params.per_image = buildPerImage(frames, factor, false);

      const result = await processMerge(buffers, params);
      if (mergePreviewSeqRef.current !== seq) return; // stale result

      setMergePreviews((prev) => {
        if (prev[groupId]?.url) URL.revokeObjectURL(prev[groupId].url);
        return {
          ...prev,
          [groupId]: {
            url: objectUrlFor(result.imageBuffer, result.imageMime),
            status: 'done',
            error: null,
          },
        };
      });
    } catch (e) {
      if (mergePreviewSeqRef.current === seq) {
        setMergePreviews((prev) => ({
          ...prev,
          [groupId]: { ...(prev[groupId] || {}), status: 'error', error: e.message },
        }));
      }
    }
  }, [mergeCanvasSizeFor, buildPerImage]);

  // Merge two frames (or add a frame to an existing group) via drag-drop.
  const mergeFrames = useCallback(
    (sourceId, targetId) => {
      const imgs = imagesRef.current;
      const src = imgs.find((im) => im.id === sourceId);
      if (!src) return;

      const existing = groupsRef.current.find((g) => g.id === targetId);
      let members = existing ? [...existing.frameIds] : [sourceId];
      if (!members.includes(sourceId)) members.push(sourceId);
      if (!existing && targetId && imgs.find((im) => im.id === targetId)) {
        members.push(targetId);
      }

      // Dedupe + keep filmstrip order.
      const order = new Map(imgs.map((im, i) => [im.id, i]));
      const sorted = [...new Set(members)].sort(
        (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
      );
      if (sorted.length < 2) return;

      const gid = existing ? existing.id : `g-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setGroups((prev) => {
        // A frame lives in at most one group: drop it from the others first.
        const others = prev
          .filter((g) => g.id !== gid)
          .map((g) => ({ ...g, frameIds: g.frameIds.filter((id) => id !== sourceId) }))
          .filter((g) => g.frameIds.length >= 2);
        return [...others, { id: gid, frameIds: sorted }];
      });
      setActiveGroupId(gid);
      setSelectedId(sourceId);
      setEditorMode(false);
      generateMergePreview(gid, sorted);
    },
    [generateMergePreview],
  );

  const selectGroup = useCallback(
    (id) => {
      setActiveGroupId(id);
      setEditorMode(false);
      const g = groupsRef.current.find((gr) => gr.id === id);
      if (g) {
        setSelectedId(g.frameIds[0] ?? null);
        if (!mergePreviewsRef.current[id]?.url) {
          generateMergePreview(id, g.frameIds);
        }
      }
    },
    [generateMergePreview],
  );

  const removeMergeGroup = useCallback((id) => {
    setGroups((prev) => prev.filter((g) => g.id !== id));
    setMergePreviews((prev) => {
      const n = { ...prev };
      if (n[id]?.url) URL.revokeObjectURL(n[id].url);
      delete n[id];
      return n;
    });
    if (activeGroupIdRef.current === id) setActiveGroupId(null);
  }, []);

  const runPreview = useCallback(
    async (imageEntry, forceFullRes = false) => {
      const id = imageEntry.id;
      const seq = (seqRef.current.get(id) || 0) + 1;
      seqRef.current.set(id, seq);
      updateImage(id, { status: 'processing' });

      try {
        // Pin the seed first so this generation is reproducible on export.
        const resolved = resolveSeed(id, effectiveParams(id));
        let buf;
        let factor;
        let params;
        if (forceFullRes) {
          // High-res preview: native resolution (exact export detail).
          buf = await readFileAsArrayBuffer(imageEntry.file);
          factor = 1;
          params = { ...resolved };
        } else {
          // Fast preview: a downscaled copy, with pixel params scaled to match
          // the native result.
          const { blob, factor: f } = await downscaleFile(imageEntry.file, PREVIEW_MAX_SIDE);
          buf = await blobToArrayBuffer(blob);
          factor = f;
          params = scaleParamsForPreview(resolved, f);
          params.size = params.size > 0 ? Math.round(params.size * f) : 0;
          params.quality = 100;
        }
        // The preview doesn't need the debug overlay (export debug is separate).
        params.debug = false;

        const result = await processImage(buf, params);
        if (seqRef.current.get(id) !== seq) return; // stale result

        const old = imagesRef.current.find((im) => im.id === id);
        if (old?.afterUrl) URL.revokeObjectURL(old.afterUrl);
        if (old?.debugUrl) URL.revokeObjectURL(old.debugUrl);

        const afterUrl = objectUrlFor(result.imageBuffer, result.imageMime);
        const debugUrl = result.debugBuffer
          ? objectUrlFor(result.debugBuffer, result.debugMime)
          : null;
        updateImage(id, {
          afterUrl,
          debugUrl,
          rects: result.meta,
          previewFactor: factor,
          status: 'done',
        });
      } catch (e) {
        if (seqRef.current.get(id) === seq) {
          updateImage(id, { status: 'error', error: e.message });
        }
      }
    },
    [effectiveParams, resolveSeed, updateImage],
  );

  const runPreviewById = useCallback(
    (id) => {
      if (lockedIdsRef.current.has(id)) return;
      const img = imagesRef.current.find((im) => im.id === id);
      if (img) runPreview(img, fullResIdsRef.current.has(id));
    },
    [runPreview],
  );

  // Native-resolution preview for a single frame, used by the slideshow. Does
  // NOT skip locked frames: a locked frame keeps its frozen params, but its
  // resolution can still be upgraded to full-res for display.
  const runFullResById = useCallback(
    (id) => {
      const img = imagesRef.current.find((im) => im.id === id);
      if (img) runPreview(img, true);
    },
    [runPreview],
  );

  // Make sure a frame's current preview is native resolution (factor === 1).
  const ensureFullRes = useCallback(
    (id) => {
      const img = imagesRef.current.find((im) => im.id === id);
      if (img && img.previewFactor !== 1) runFullResById(id);
    },
    [runFullResById],
  );

  const debouncedRePreview = useCallback(
    (id, delay = 700) => {
      if (debounceRef.current.has(id)) clearTimeout(debounceRef.current.get(id));
      const t = setTimeout(() => runPreviewById(id), delay);
      debounceRef.current.set(id, t);
    },
    [runPreviewById],
  );

  // Regenerate every unlocked frame (the selected one a touch sooner so the
  // visible preview stays responsive). Used when a GLOBAL param changes, since
  // that affects the whole roll, not just the selected frame.
  const rePreviewAll = useCallback(
    (selectedDelay = 120, otherDelay = 700) => {
      const selected = selectedRef.current;
      for (const im of imagesRef.current) {
        if (lockedIdsRef.current.has(im.id)) continue;
        debouncedRePreview(im.id, im.id === selected ? selectedDelay : otherDelay);
      }
    },
    [debouncedRePreview],
  );

  // ---- undo / redo (params + per-frame overrides) ----

  const scheduleHistoryCommit = useCallback(() => {
    clearTimeout(historyTimerRef.current);
    historyTimerRef.current = setTimeout(() => {
      const snap = { globalParams: paramsRef.current, overrides: overridesRef.current };
      const h = historyRef.current;
      const top = h.stack[h.index];
      if (JSON.stringify(top) !== JSON.stringify(snap)) {
        h.stack = h.stack.slice(0, h.index + 1);
        h.stack.push(snap);
        h.index = h.stack.length - 1;
        setHistoryTick((t) => t + 1);
      }
    }, 400);
  }, []);

  const undo = useCallback(() => {
    clearTimeout(historyTimerRef.current);
    const h = historyRef.current;
    if (h.index <= 0) return;
    h.index -= 1;
    const snap = h.stack[h.index];
    setGlobalParams(snap.globalParams);
    setOverrides(snap.overrides);
    setHistoryTick((t) => t + 1);
    rePreviewAll();
  }, [rePreviewAll]);

  const redo = useCallback(() => {
    clearTimeout(historyTimerRef.current);
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    const snap = h.stack[h.index];
    setGlobalParams(snap.globalParams);
    setOverrides(snap.overrides);
    setHistoryTick((t) => t + 1);
    rePreviewAll();
  }, [rePreviewAll]);

  const canUndo = historyRef.current.index > 0;
  const canRedo = historyRef.current.index < historyRef.current.stack.length - 1;

  // ---- upload / manage frames ----

  const onFiles = useCallback(
    async (files) => {
      const incoming = Array.from(files || []);
      if (!incoming.length) return;

      setImporting(true);
      try {
        // Expand ZIP archives (nested dirs included) and keep only image files.
        const images = [];
        for (const f of incoming) {
          if (isZipFile(f)) {
            try {
              images.push(...(await extractImagesFromZip(f)));
            } catch (e) {
              window.alert(`Couldn't open ${f.name}: ${e.message}`);
            }
          } else if (isImageFile(f)) {
            images.push(f);
          }
        }
        if (!images.length) return;

        const batch = images.map((file) => ({
        id: `img-${++idCounter}-${Date.now()}`,
        name: file.name,
        file,
        beforeUrl: URL.createObjectURL(file),
        afterUrl: null,
        debugUrl: null,
        previewFactor: 1,
        rects: null,
        status: 'processing',
        error: null,
      }));

      // Restore a previously-saved order (stable sort; unknown filenames keep
      // their upload order and are appended after known ones).
      const savedOrder = savedOrderRef.current;
      if (Array.isArray(savedOrder) && savedOrder.length) {
        const idx = new Map(savedOrder.map((n, i) => [n, i]));
        batch.sort((a, b) => {
          const ia = idx.has(a.name) ? idx.get(a.name) : Number.MAX_SAFE_INTEGER;
          const ib = idx.has(b.name) ? idx.get(b.name) : Number.MAX_SAFE_INTEGER;
          return ia - ib;
        });
      }
      setImages((prev) => [...prev, ...batch]);
      savedOrderRef.current = [
        ...imagesRef.current.map((im) => im.name),
        ...batch.map((im) => im.name),
      ];
      setSelectedId((prev) => prev ?? batch[0].id);
      // Re-show the restored-settings notice on any new upload (a previous ✕
      // dismiss only hides it until the next upload / refresh).
      setBannerHidden(false);

      // Restore per-file overrides / lock from a previous session (keyed by
      // filename), so re-uploading the same roll keeps its tweaks.
      const restoredOverrides = {};
      const restoredLocked = [];
      const restoredSnapshots = {};
      const restoredBatchIds = [];
      for (const im of batch) {
        if (savedOverridesRef.current[im.name]) {
          restoredOverrides[im.id] = savedOverridesRef.current[im.name];
          restoredBatchIds.push(im.id);
        }
        if (savedLockedRef.current.has(im.name)) restoredLocked.push(im.id);
        if (savedLockedSnapshotsRef.current[im.name]) {
          restoredSnapshots[im.id] = savedLockedSnapshotsRef.current[im.name];
        }
      }
      if (Object.keys(restoredOverrides).length) {
        // Update the ref synchronously so the immediate runPreview below sees
        // the restored overrides (and preserved seed) instead of pinning a new
        // random seed / dropping the saved offsets & detection fix.
        const merged = { ...overridesRef.current, ...restoredOverrides };
        overridesRef.current = merged;
        setOverrides(merged);
        setRestoredIds((prev) => {
          const n = new Set(prev);
          for (const id of restoredBatchIds) n.add(id);
          return n;
        });
      }
      if (restoredLocked.length) {
        setLockedIds((prev) => {
          const n = new Set(prev);
          for (const id of restoredLocked) n.add(id);
          return n;
        });
      }
      if (Object.keys(restoredSnapshots).length) {
        setLockedSnapshots((prev) => ({ ...prev, ...restoredSnapshots }));
      }

        for (const im of batch) runPreview(im);
      } finally {
        setImporting(false);
      }
    },
    [runPreview],
  );

  const onDeleteImage = useCallback((id) => {
    const img = imagesRef.current.find((im) => im.id === id);
    if (img) {
      if (img.beforeUrl) URL.revokeObjectURL(img.beforeUrl);
      if (img.afterUrl) URL.revokeObjectURL(img.afterUrl);
      if (img.debugUrl) URL.revokeObjectURL(img.debugUrl);
    }
    const next = imagesRef.current.filter((im) => im.id !== id);
    savedOrderRef.current = next.map((im) => im.name);
    setImages(next);
    setFullResIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    if (selectedRef.current === id) {
      setSelectedId(next[0]?.id ?? null);
    }
    setOverrides((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    // Remove the frame from any merge group it belonged to.
    setGroups((prev) =>
      prev
        .map((g) => ({ ...g, frameIds: g.frameIds.filter((fid) => fid !== id) }))
        .filter((g) => g.frameIds.length >= 2),
    );
  }, []);

  // Move a frame before/after another frame in the filmstrip order.
  const onMove = useCallback((fromId, targetId, placement) => {
    setImages((prev) => {
      const arr = [...prev];
      const from = arr.findIndex((im) => im.id === fromId);
      if (from < 0) return prev;
      const [moved] = arr.splice(from, 1);
      const idx = arr.findIndex((im) => im.id === targetId);
      if (idx < 0) {
        arr.splice(from, 0, moved);
      } else {
        arr.splice(placement === 'before' ? idx : idx + 1, 0, moved);
      }
      savedOrderRef.current = arr.map((im) => im.name);
      return arr;
    });
  }, []);

  const moveSelection = useCallback((dir) => {
    const imgs = imagesRef.current;
    if (!imgs.length) return;
    const idx = imgs.findIndex((im) => im.id === selectedRef.current);
    const next = imgs[(idx + dir + imgs.length) % imgs.length];
    if (next) setSelectedId(next.id);
  }, []);

  // Slideshow navigation: select the next/prev frame AND make sure it renders
  // at native resolution before showing it.
  const slideshowNav = useCallback(
    (dir) => {
      const imgs = imagesRef.current;
      if (!imgs.length) return;
      const idx = imgs.findIndex((im) => im.id === selectedRef.current);
      const next = imgs[(idx + dir + imgs.length) % imgs.length];
      if (next) {
        setSelectedId(next.id);
        ensureFullRes(next.id);
      }
    },
    [ensureFullRes],
  );

  // ---- params ----

  const onGlobalChange = useCallback(
    (key, value) => {
      setGlobalParams((prev) => ({ ...prev, [key]: value }));
      scheduleHistoryCommit();
      rePreviewAll();
    },
    [scheduleHistoryCommit, rePreviewAll],
  );

  const onOverrideChange = useCallback(
    (imageId, key, value) => {
      setOverrides((prev) => ({
        ...prev,
        [imageId]: { ...(prev[imageId] || {}), [key]: value },
      }));
      scheduleHistoryCommit();
      debouncedRePreview(imageId);
      // If we're inside a merge group, refresh its merged preview too.
      const gid = activeGroupIdRef.current;
      if (gid) {
        const g = groupsRef.current.find((gr) => gr.id === gid);
        if (g) generateMergePreview(gid, g.frameIds);
      }
    },
    [scheduleHistoryCommit, debouncedRePreview, generateMergePreview],
  );

  // Detection gate/sprocket changes from the visual editor only update the
  // override state; the pipeline is NOT re-run until the user presses Done.
  const onDetectionOverrideChange = useCallback(
    (imageId, key, value) => {
      setOverrides((prev) => ({
        ...prev,
        [imageId]: { ...(prev[imageId] || {}), [key]: value },
      }));
      scheduleHistoryCommit();
    },
    [scheduleHistoryCommit],
  );

  const onResetOverride = useCallback(
    (imageId) => {
      setOverrides((prev) => {
        const n = { ...prev };
        delete n[imageId];
        return n;
      });
      setLockedIds((prev) => {
        const n = new Set(prev);
        n.delete(imageId);
        return n;
      });
      setLockedSnapshots((prev) => {
        const n = { ...prev };
        delete n[imageId];
        return n;
      });
      setRestoredIds((prev) => {
        const n = new Set(prev);
        n.delete(imageId);
        return n;
      });
      scheduleHistoryCommit();
      debouncedRePreview(imageId);
    },
    [scheduleHistoryCommit, debouncedRePreview],
  );

  const resetAllRestored = useCallback(() => {
    const ids = [...restoredIdsRef.current];
    if (!ids.length) return;
    setOverrides((prev) => {
      const n = { ...prev };
      for (const id of ids) delete n[id];
      return n;
    });
    setLockedIds((prev) => {
      const n = new Set(prev);
      for (const id of ids) n.delete(id);
      return n;
    });
    setLockedSnapshots((prev) => {
      const n = { ...prev };
      for (const id of ids) delete n[id];
      return n;
    });
    setRestoredIds(new Set());
    scheduleHistoryCommit();
    for (const id of ids) debouncedRePreview(id);
  }, [scheduleHistoryCommit, debouncedRePreview]);

  const applyPreset = useCallback(
    (params, name) => {
      const next = { ...DEFAULTS, ...params };
      setGlobalParams(next);
      if (name) setActivePreset({ name, params: next });
      scheduleHistoryCommit();
      rePreviewAll();
    },
    [scheduleHistoryCommit, rePreviewAll],
  );

  // ---- per-frame random look: re-roll / lock / copy / apply-to-all ----

  const onToggleLock = useCallback(
    (id) => {
      if (lockedIdsRef.current.has(id)) {
        // Unlock: drop the frozen snapshot so the frame follows the roll
        // params again (while keeping its per-frame overrides), then
        // regenerate. This is what makes a canvas-size (or any global) change
        // made while locked take effect as soon as the frame is unlocked.
        setLockedSnapshots((prev) => {
          const n = { ...prev };
          delete n[id];
          return n;
        });
        setLockedIds((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
        scheduleHistoryCommit();
        debouncedRePreview(id);
      } else {
        // Freeze this frame's look: snapshot its current effective params
        // (including the pinned seed) separately from the per-frame override,
        // so preview + export stay stable and no longer follow global changes.
        const snap = effectiveParams(id);
        setLockedSnapshots((prev) => ({ ...prev, [id]: snap }));
        setLockedIds((prev) => new Set(prev).add(id));
        scheduleHistoryCommit();
      }
    },
    [effectiveParams, scheduleHistoryCommit, debouncedRePreview],
  );

  const onToggleFullRes = useCallback(() => {
    const id = selectedRef.current;
    if (!id) return;
    // Cancel any pending debounced preview and regenerate right away.
    if (debounceRef.current.has(id)) {
      clearTimeout(debounceRef.current.get(id));
      debounceRef.current.delete(id);
    }
    if (fullResIdsRef.current.has(id)) {
      // Currently full-res -> drop back to the fast 2560px preview and stop
      // forcing full-res on subsequent param changes.
      setFullResIds((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
      const img = imagesRef.current.find((im) => im.id === id);
      if (img) runPreview(img, false);
    } else {
      // Remember this frame stays at native resolution across future edits.
      setFullResIds((prev) => new Set(prev).add(id));
      runFullResById(id);
    }
  }, [runPreview, runFullResById]);

  const onToggleEditor = useCallback(() => {
    if (editorModeRef.current) {
      // Closing: apply any pending detection changes right away and regenerate,
      // so the "After" view reflects the final gate/sprocket immediately.
      setEditorMode(false);
      const id = selectedRef.current;
      if (!id) return;
      if (debounceRef.current.has(id)) {
        clearTimeout(debounceRef.current.get(id));
        debounceRef.current.delete(id);
      }
      runPreviewById(id);
      // If we were editing a frame inside a merge group, refresh the merged view.
      const gid = activeGroupIdRef.current;
      if (gid) {
        const g = groupsRef.current.find((gr) => gr.id === gid);
        if (g) generateMergePreview(gid, g.frameIds);
      }
    } else {
      setEditorMode(true);
    }
  }, [runPreviewById, generateMergePreview]);

  const onOpenEditor = useCallback(() => {
    setEditorMode(true);
  }, []);

  const onToggleSlideshow = useCallback(() => {
    const opening = !slideshowRef.current;
    setSlideshow(opening);
    if (opening && selectedRef.current) {
      ensureFullRes(selectedRef.current);
    }
  }, [ensureFullRes]);

  const onRegenerate = useCallback(
    (id) => {
      const seed = Math.floor(Math.random() * 2 ** 31);
      setOverrides((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), seed } }));
      scheduleHistoryCommit();
      debouncedRePreview(id);
    },
    [scheduleHistoryCommit, debouncedRePreview],
  );

  const onCopySeed = useCallback(
    async (id) => {
      let seed = overridesRef.current[id]?.seed ?? paramsRef.current.seed;
      if (seed == null) {
        seed = Math.floor(Math.random() * 2 ** 31);
        setOverrides((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), seed } }));
        scheduleHistoryCommit();
        debouncedRePreview(id);
      }
      try {
        await navigator.clipboard.writeText(String(seed));
      } catch {
        /* clipboard may be blocked */
      }
    },
    [scheduleHistoryCommit, debouncedRePreview],
  );

  const onApplySeedToAll = useCallback(
    (id) => {
      let seed = overridesRef.current[id]?.seed ?? paramsRef.current.seed;
      if (seed == null) seed = Math.floor(Math.random() * 2 ** 31);
      setGlobalParams((prev) => ({ ...prev, seed }));
      setOverrides((prev) => {
        const n = {};
        for (const [k, o] of Object.entries(prev)) {
          const rest = { ...o };
          delete rest.seed;
          if (Object.keys(rest).length) n[k] = rest;
        }
        return n;
      });
      scheduleHistoryCommit();
      for (const im of imagesRef.current) debouncedRePreview(im.id);
    },
    [scheduleHistoryCommit, debouncedRePreview],
  );

  const savePreset = useCallback((name) => {
    const current = { ...paramsRef.current };
    setUserPresets((prev) => {
      const next = { ...prev, [name]: serializePreset(current) };
      saveUserPresets(next);
      return next;
    });
    setActivePreset({ name, params: current });
  }, []);

  const deletePreset = useCallback((name) => {
    setUserPresets((prev) => {
      const next = { ...prev };
      delete next[name];
      saveUserPresets(next);
      return next;
    });
    setActivePreset((prev) => (prev && prev.name === name ? null : prev));
  }, []);

  const exportPresets = useCallback(() => {
    const blob = new Blob([JSON.stringify(userPresets, null, 2)], {
      type: 'application/json',
    });
    downloadBlob(blob, 'rebate-presets.json');
  }, [userPresets]);

  const importPresets = useCallback((text) => {
    try {
      const imported = importPresetsFromJson(text);
      setUserPresets((prev) => {
        const next = { ...prev, ...imported };
        saveUserPresets(next);
        return next;
      });
    } catch {
      window.alert('Invalid presets JSON');
    }
  }, []);

  // ---- download / export ----

  const onDownloadImage = useCallback(
    async (image) => {
      if (!image) return;
      try {
        const buf = await readFileAsArrayBuffer(image.file);
        const params = pinDetectionFromPreview(
          image,
          resolveSeed(image.id, effectiveParams(image.id)),
        );
        const result = await processImage(buf, params);
        const name = baseName(image.name) + suffixFor(params);
        downloadBuffer(result.imageBuffer, result.imageMime, name);
      } catch (e) {
        window.alert(`Download failed: ${e.message}`);
      }
    },
    [effectiveParams, resolveSeed],
  );

  const onExport = useCallback(async () => {
    const imgs = imagesRef.current;
    const groups = groupsRef.current;
    if (!imgs.length) return;
    setExporting(true);
    const entries = [];
    try {
      // Export EVERY frame individually, plus one merged image per merge group.
      const total = imgs.length + groups.length;
      let done = 0;

      // 1. Individual frames (single-frame path, for every frame).
      for (const img of imgs) {
        setExportProgress({ done, total });
        const buf = await readFileAsArrayBuffer(img.file);
        const params = pinDetectionFromPreview(
          img,
          resolveSeed(img.id, effectiveParams(img.id)), // native, unscaled
        );
        const result = await processImage(buf, params);
        entries.push({
          name: baseName(img.name) + suffixFor(params),
          buffer: result.imageBuffer,
          mime: result.imageMime,
        });
        if (params.debug && result.debugBuffer) {
          entries.push({
            name: baseName(img.name) + '.debug.jpg',
            buffer: result.debugBuffer,
            mime: 'image/jpeg',
          });
        }
        done += 1;
      }

      // 2. Each merge group -> one merged image.
      const canvasSize = await mergeCanvasSizeFor(1);
      for (const g of groups) {
        setExportProgress({ done, total });
        const frames = g.frameIds
          .map((id) => imgs.find((im) => im.id === id))
          .filter(Boolean);
        if (frames.length >= 2) {
          const buffers = [];
          for (const f of frames) buffers.push(await readFileAsArrayBuffer(f.file));
          const params = { ...paramsRef.current };
          if (canvasSize) params.canvas_size = canvasSize;
          params.per_image = buildPerImage(frames, 1, true);
          const result = await processMerge(buffers, params);
          const ext = params.format === 'png' ? '.png' : '.jpg';
          entries.push({
            name: `merge-${done - imgs.length + 1}${ext}`,
            buffer: result.imageBuffer,
            mime: result.imageMime,
          });
        }
        done += 1;
      }

      setExportProgress({ done: total, total });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const zipName =
        `rebate-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
      downloadBlob(zipEntries(entries), zipName);
    } catch (e) {
      window.alert(`Export failed: ${e.message}`);
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  }, [effectiveParams, resolveSeed, mergeCanvasSizeFor, buildPerImage]);

  // ---- paste (⌘/Ctrl+V an image copied from another tab, e.g. Google Photos) ----

  const onPaste = useCallback(
    (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        if (!/^image\/(jpeg|jpg|png|webp|tiff?)$/i.test(item.type)) continue;
        const f = item.getAsFile();
        if (f) files.push(new File([f], nameForPasted(item.type, files.length), { type: item.type }));
      }
      if (files.length) {
        e.preventDefault();
        onFiles(files);
      }
    },
    [onFiles],
  );

  useEffect(() => {
    const handler = (e) => {
      // Don't hijack paste while typing in an input/textarea/select/contenteditable.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      onPaste(e);
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, [onPaste]);

  // ---- window drag & drop (add more frames at any time) ----

  const onDragEnter = useCallback((e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (imagesRef.current.length > 0) {
      dragDepthRef.current += 1;
      setDropActive(true);
    }
  }, []);

  const onDragOver = useCallback((e) => {
    if (hasFiles(e)) e.preventDefault();
  }, []);

  const onDragLeave = useCallback((e) => {
    if (!hasFiles(e)) return;
    if (imagesRef.current.length > 0) {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDropActive(false);
    }
  }, []);

  const onWindowDrop = useCallback(
    (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDropActive(false);
      if (imagesRef.current.length > 0) {
        onFiles(Array.from(e.dataTransfer.files));
      }
    },
    [onFiles],
  );

  // ---- keyboard shortcuts ----

  useEffect(() => {
    const isTyping = (t) =>
      t &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (isTyping(e.target)) return;

      if (e.key === 'Escape') {
        if (slideshowRef.current) {
          e.preventDefault();
          setSlideshow(false);
        }
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (selectedRef.current) onDeleteImage(selectedRef.current);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (slideshowRef.current) {
          slideshowNav(e.key === 'ArrowRight' ? 1 : -1);
        } else {
          moveSelection(e.key === 'ArrowRight' ? 1 : -1);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'f') {
        e.preventDefault();
        setSlideshow((v) => !v);
      } else if (k === 'a') setViewMode('after');
      else if (k === 'b') setViewMode('before');
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, onDeleteImage, moveSelection, slideshowNav]);

  const selectedImage = images.find((im) => im.id === selectedId) || null;
  const selectedOverride = selectedId ? overrides[selectedId] || {} : {};
  const selectedFrameLocked = selectedId ? lockedIds.has(selectedId) : false;
  const selectedEffective = selectedId
    ? selectedFrameLocked && lockedSnapshots[selectedId]
      ? lockedSnapshots[selectedId]
      : mergeParams(globalParams, selectedOverride)
    : null;
  const activePresetName = activePreset?.name ?? null;
  const presetDirty = activePreset
    ? JSON.stringify(globalParams) !== JSON.stringify(activePreset.params)
    : false;
  const paramsDisabled = images.length === 0 || selectedFrameLocked;
  const paramsDisabledReason = images.length === 0
    ? 'Add frames to start editing.'
    : selectedFrameLocked
      ? 'This frame is locked — unlock it to edit the roll.'
      : null;

  return (
    <div
      data-testid="app-root"
      className="relative h-screen flex flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onWindowDrop}
    >
      <header className="flex items-center gap-2 px-4 h-14 border-b app-border shrink-0">
        <h1
          className="text-xl tracking-tight app-text"
          style={{ fontFamily: '"Vidaloka", ui-serif, Georgia, serif' }}
        >
          rebate
        </h1>
        <span
          className="text-sm app-text-muted -ml-1"
          style={{ fontFamily: '"Reenie Beanie", cursive' }}
        >
          film border scanner
        </span>
        <span className="text-[11px] app-text-muted truncate ml-1">{workerStatus}</span>

        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            title="Theme"
            className="h-8 px-1.5 text-xs rounded bg-neutral-800 border border-neutral-700 text-neutral-200 focus:outline-none focus:border-amber-400"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <button
            type="button"
            title="Undo (⌘Z)"
            onClick={undo}
            disabled={!canUndo}
            className="w-8 h-8 rounded-full bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm disabled:opacity-30"
          >
            ↶
          </button>
          <button
            type="button"
            title="Redo (⌘⇧Z)"
            onClick={redo}
            disabled={!canRedo}
            className="w-8 h-8 rounded-full bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm disabled:opacity-30"
          >
            ↷
          </button>
          <button
            type="button"
            onClick={() => document.getElementById('upload-trigger').click()}
            className="px-3 h-8 rounded-full bg-[#E6C21F] text-black text-sm font-medium ml-1"
          >
            Add frames
          </button>
        </div>
      </header>

      <input
        id="upload-trigger"
        type="file"
        multiple
        accept="image/jpeg,image/jpg,image/png,image/webp,image/tiff,.zip,application/zip"
        className="hidden"
        onChange={(e) => {
          onFiles(Array.from(e.target.files || []));
          e.target.value = '';
        }}
      />

      {restoredIds.size > 0 && !bannerHidden && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-amber-400/10 border-b border-amber-400/30 text-[12px] text-amber-300 shrink-0">
          <button
            type="button"
            title="Hide this notice"
            onClick={() => setBannerHidden(true)}
            className="w-6 h-6 rounded-full flex items-center justify-center text-amber-300/80 hover:text-white hover:bg-amber-400/20 shrink-0"
          >
            ✕
          </button>
          <span>↩ Restored saved settings for {restoredIds.size} frame{restoredIds.size === 1 ? '' : 's'}.</span>
          <button
            type="button"
            onClick={resetAllRestored}
            className="ml-auto px-2 h-6 text-xs rounded bg-amber-400/15 hover:bg-amber-400/25 text-amber-300"
          >
            Reset restored
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <aside className="w-72 shrink-0 border-r app-border app-surface">
          <ParamsPanel
            params={globalParams}
            onChange={onGlobalChange}
            disabled={paramsDisabled}
            disabledReason={paramsDisabledReason}
            userPresets={userPresets}
            onApplyPreset={applyPreset}
            onSavePreset={savePreset}
            onDeletePreset={deletePreset}
            onImportPresets={importPresets}
            onExportPresets={exportPresets}
            activePresetName={activePresetName}
            presetDirty={presetDirty}
            onUpdatePreset={savePreset}
          />
        </aside>

        <main className="flex-1 flex flex-col min-w-0">
          <ExportBar
            params={globalParams}
            onChange={onGlobalChange}
            exporting={exporting}
            progress={exportProgress}
            onExport={onExport}
            disabled={exporting || images.length === 0}
          />

          {images.length === 0 ? (
            <div className="flex-1 flex flex-col p-6">
              <DropZone onFiles={onFiles} />
            </div>
          ) : activeGroupId && !editorMode && mergePreviews[activeGroupId] ? (
            <GroupPreview
              preview={mergePreviews[activeGroupId]}
              onBack={() => {
                setActiveGroupId(null);
                setEditorMode(false);
              }}
              onEditDetection={() => setEditorMode(true)}
              editingFrameName={selectedImage ? selectedImage.name : null}
            />
          ) : (
            <Preview
              image={selectedImage}
              params={selectedEffective}
              viewMode={viewMode}
              onViewMode={setViewMode}
              fullRes={selectedImage ? fullResIds.has(selectedImage.id) : false}
              onToggleFullRes={onToggleFullRes}
              editorMode={editorMode}
              onToggleEditor={onToggleEditor}
              gateOverride={selectedId ? (overrides[selectedId]?.gate_override ?? null) : null}
              onGateChange={(rect) =>
                selectedId && onDetectionOverrideChange(selectedId, 'gate_override', rect)
              }
              onResetDetection={() => {
                if (!selectedId) return;
                onDetectionOverrideChange(selectedId, 'gate_override', null);
              }}
              locked={selectedId ? lockedIds.has(selectedId) : false}
              onToggleSlideshow={onToggleSlideshow}
            />
          )}

          <MergeBar
            layout={globalParams.layout}
            gap={globalParams.gap}
            onChange={onGlobalChange}
          />

          <Filmstrip
            images={images}
            groups={groups}
            mergePreviews={mergePreviews}
            activeGroupId={activeGroupId}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setActiveGroupId(null);
              setEditorMode(false);
            }}
            onSelectMember={(id) => setSelectedId(id)}
            onSelectGroup={selectGroup}
            onBackGroup={() => setActiveGroupId(null)}
            onRemoveGroup={removeMergeGroup}
            onDelete={onDeleteImage}
            onMove={onMove}
            onMerge={mergeFrames}
          />
        </main>

        <aside className="w-64 shrink-0 border-l app-border app-surface">
          <FramePanel
            image={selectedImage}
            effective={selectedEffective}
            override={selectedOverride}
            onChange={(key, value) => onOverrideChange(selectedId, key, value)}
            onReset={() => onResetOverride(selectedId)}
            onDownload={() => onDownloadImage(selectedImage)}
            onRemove={() => onDeleteImage(selectedId)}
            locked={selectedId ? lockedIds.has(selectedId) : false}
            restored={selectedId ? restoredIds.has(selectedId) : false}
            onToggleLock={() => onToggleLock(selectedId)}
            onRegenerate={() => onRegenerate(selectedId)}
            onCopySeed={() => onCopySeed(selectedId)}
            onApplySeedToAll={() => onApplySeedToAll(selectedId)}
            onOpenEditor={onOpenEditor}
          />
        </aside>
      </div>

      {dropActive && images.length > 0 && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-amber-400 bg-neutral-900/80 px-16 py-12 text-center">
            <div className="text-4xl mb-2">⬇</div>
            <div className="text-lg font-medium text-amber-300">Drop frames to add</div>
            <div className="text-xs text-neutral-400 mt-1">they'll join the current roll</div>
          </div>
        </div>
      )}

      {importing && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none">
          <div className="rounded-2xl border border-neutral-700 bg-neutral-900/90 px-10 py-8 text-center">
            <div className="w-9 h-9 mx-auto mb-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <div className="text-lg font-medium text-neutral-100">Unzipping…</div>
            <div className="text-xs text-neutral-400 mt-1">importing your frames</div>
          </div>
        </div>
      )}

      {slideshow && selectedImage && (
        <Slideshow
          image={selectedImage}
          index={Math.max(0, images.findIndex((im) => im.id === selectedId))}
          total={images.length}
          onPrev={() => slideshowNav(-1)}
          onNext={() => slideshowNav(1)}
          onClose={onToggleSlideshow}
        />
      )}
    </div>
  );
}
