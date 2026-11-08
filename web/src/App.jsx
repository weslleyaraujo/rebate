import { useCallback, useEffect, useRef, useState } from 'react';
import DropZone from './components/DropZone.jsx';
import Filmstrip from './components/Filmstrip.jsx';
import ParamsPanel from './components/ParamsPanel.jsx';
import FramePanel from './components/FramePanel.jsx';
import Preview from './components/Preview.jsx';
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
  objectUrlFor,
  downloadBlob,
  downloadBuffer,
  zipEntries,
  baseName,
  isZipFile,
  isImageFile,
  extractImagesFromZip,
} from './lib/imageUtil.js';
import { initWorker, processImage } from './lib/workerClient.js';

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
  const [restoredIds, setRestoredIds] = useState(() => new Set());
  const [bannerHidden, setBannerHidden] = useState(false);
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
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const seqRef = useRef(new Map());
  const debounceRef = useRef(new Map());
  const dragDepthRef = useRef(0);
  const historyRef = useRef({
    stack: [{ globalParams: DEFAULTS, overrides: {} }],
    index: 0,
  });
  const historyTimerRef = useRef(null);
  const lockedIdsRef = useRef(lockedIds);
  lockedIdsRef.current = lockedIds;
  const restoredIdsRef = useRef(restoredIds);
  restoredIdsRef.current = restoredIds;
  const editorModeRef = useRef(editorMode);
  editorModeRef.current = editorMode;
  const slideshowRef = useRef(slideshow);
  slideshowRef.current = slideshow;
  const savedOverridesRef = useRef({}); // filename -> overrides (restored on upload)
  const savedLockedRef = useRef(new Set()); // filenames locked in a previous session

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
        for (const im of images) {
          if (overrides[im.id]) overridesByFile[im.name] = overrides[im.id];
          if (lockedIds.has(im.id)) lockedByFile[im.name] = true;
        }
        localStorage.setItem(
          WORKSPACE_KEY,
          JSON.stringify({
            savedAt: Date.now(),
            globalParams,
            overridesByFile,
            lockedByFile,
          }),
        );
      } catch {
        /* storage may be unavailable */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [globalParams, overrides, images, lockedIds]);

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
      if (img) runPreview(img);
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
      setImages((prev) => [...prev, ...batch]);
      setSelectedId((prev) => prev ?? batch[0].id);
      // Re-show the restored-settings notice on any new upload (a previous ✕
      // dismiss only hides it until the next upload / refresh).
      setBannerHidden(false);

      // Restore per-file overrides / lock from a previous session (keyed by
      // filename), so re-uploading the same roll keeps its tweaks.
      const restoredOverrides = {};
      const restoredLocked = [];
      const restoredBatchIds = [];
      for (const im of batch) {
        if (savedOverridesRef.current[im.name]) {
          restoredOverrides[im.id] = savedOverridesRef.current[im.name];
          restoredBatchIds.push(im.id);
        }
        if (savedLockedRef.current.has(im.name)) restoredLocked.push(im.id);
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
    setImages(next);
    if (selectedRef.current === id) {
      setSelectedId(next[0]?.id ?? null);
    }
    setOverrides((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
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
    },
    [scheduleHistoryCommit, debouncedRePreview],
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
    setRestoredIds(new Set());
    scheduleHistoryCommit();
    for (const id of ids) debouncedRePreview(id);
  }, [scheduleHistoryCommit, debouncedRePreview]);

  const applyPreset = useCallback(
    (params) => {
      setGlobalParams({ ...DEFAULTS, ...params });
      scheduleHistoryCommit();
      rePreviewAll();
    },
    [scheduleHistoryCommit, rePreviewAll],
  );

  // ---- per-frame random look: re-roll / lock / copy / apply-to-all ----

  const onToggleLock = useCallback(
    (id) => {
      if (lockedIdsRef.current.has(id)) {
        setLockedIds((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      } else {
        // Freeze this frame's look: capture its current effective params
        // (including seed) into its override so BOTH preview and export are
        // stable and no longer follow global param changes.
        const snap = effectiveParams(id);
        setOverrides((prev) => ({ ...prev, [id]: snap }));
        setLockedIds((prev) => new Set(prev).add(id));
        scheduleHistoryCommit();
      }
    },
    [effectiveParams, scheduleHistoryCommit],
  );

  const onToggleFullRes = useCallback(() => {
    const id = selectedRef.current;
    if (!id) return;
    // Cancel any pending debounced preview and regenerate right away.
    if (debounceRef.current.has(id)) {
      clearTimeout(debounceRef.current.get(id));
      debounceRef.current.delete(id);
    }
    const img = imagesRef.current.find((im) => im.id === id);
    if (img && img.previewFactor === 1) {
      // Currently full-res -> drop back to the fast 2560px preview.
      runPreview(img, false);
    } else {
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
    } else {
      setEditorMode(true);
    }
  }, [runPreviewById]);

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
    setUserPresets((prev) => {
      const next = { ...prev, [name]: serializePreset(paramsRef.current) };
      saveUserPresets(next);
      return next;
    });
  }, []);

  const deletePreset = useCallback((name) => {
    setUserPresets((prev) => {
      const next = { ...prev };
      delete next[name];
      saveUserPresets(next);
      return next;
    });
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
    if (!imgs.length) return;
    setExporting(true);
    const entries = [];
    try {
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        setExportProgress({ done: i, total: imgs.length });
        const buf = await readFileAsArrayBuffer(img.file);
        const params = pinDetectionFromPreview(
          img,
          resolveSeed(img.id, effectiveParams(img.id)), // native, unscaled
        );
        const result = await processImage(buf, params);
        const name = baseName(img.name) + suffixFor(params);
        entries.push({ name, buffer: result.imageBuffer, mime: result.imageMime });
        if (params.debug && result.debugBuffer) {
          entries.push({
            name: baseName(img.name) + '.debug.jpg',
            buffer: result.debugBuffer,
            mime: 'image/jpeg',
          });
        }
      }
      setExportProgress({ done: imgs.length, total: imgs.length });
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
  }, [effectiveParams, resolveSeed]);

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
          ) : (
            <Preview
              image={selectedImage}
              params={selectedId ? mergeParams(globalParams, overrides[selectedId] || {}) : null}
              viewMode={viewMode}
              onViewMode={setViewMode}
              fullRes={selectedImage ? selectedImage.previewFactor === 1 : false}
              onToggleFullRes={onToggleFullRes}
              editorMode={editorMode}
              onToggleEditor={onToggleEditor}
              gateOverride={selectedId ? (overrides[selectedId]?.gate_override ?? null) : null}
              sprocketOverride={selectedId ? (overrides[selectedId]?.sprocket_override ?? null) : null}
              onGateChange={(rect) =>
                selectedId && onDetectionOverrideChange(selectedId, 'gate_override', rect)
              }
              onSprocketChange={(edges) =>
                selectedId && onDetectionOverrideChange(selectedId, 'sprocket_override', edges)
              }
              onResetDetection={() => {
                if (!selectedId) return;
                onDetectionOverrideChange(selectedId, 'gate_override', null);
                onDetectionOverrideChange(selectedId, 'sprocket_override', null);
              }}
              locked={selectedId ? lockedIds.has(selectedId) : false}
              onToggleSlideshow={onToggleSlideshow}
            />
          )}

          <Filmstrip
            images={images}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDelete={onDeleteImage}
          />
        </main>

        <aside className="w-64 shrink-0 border-l app-border app-surface">
          <FramePanel
            image={selectedImage}
            globalParams={globalParams}
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
