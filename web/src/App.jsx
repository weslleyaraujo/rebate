import { useCallback, useEffect, useRef, useState } from 'react';
import DropZone from './components/DropZone.jsx';
import Filmstrip from './components/Filmstrip.jsx';
import ParamsPanel from './components/ParamsPanel.jsx';
import FramePanel from './components/FramePanel.jsx';
import Preview from './components/Preview.jsx';
import ExportBar from './components/ExportBar.jsx';
import { DEFAULTS, mergeParams, scaleParamsForPreview, suffixFor } from './lib/params.js';
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
  const [previewFullRes, setPreviewFullRes] = useState(false);
  const [editorMode, setEditorMode] = useState(false);
  const [lockedIds, setLockedIds] = useState(() => new Set());
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
  const previewFullResRef = useRef(previewFullRes);
  previewFullResRef.current = previewFullRes;
  const editorModeRef = useRef(editorMode);
  editorModeRef.current = editorMode;
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
    async (imageEntry) => {
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
        if (previewFullResRef.current) {
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

  const debouncedRePreview = useCallback(
    (id, delay = 700) => {
      if (debounceRef.current.has(id)) clearTimeout(debounceRef.current.get(id));
      const t = setTimeout(() => runPreviewById(id), delay);
      debounceRef.current.set(id, t);
    },
    [runPreviewById],
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
    if (selectedRef.current) debouncedRePreview(selectedRef.current);
  }, [debouncedRePreview]);

  const redo = useCallback(() => {
    clearTimeout(historyTimerRef.current);
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    const snap = h.stack[h.index];
    setGlobalParams(snap.globalParams);
    setOverrides(snap.overrides);
    setHistoryTick((t) => t + 1);
    if (selectedRef.current) debouncedRePreview(selectedRef.current);
  }, [debouncedRePreview]);

  const canUndo = historyRef.current.index > 0;
  const canRedo = historyRef.current.index < historyRef.current.stack.length - 1;

  // ---- upload / manage frames ----

  const onFiles = useCallback(
    (files) => {
      const batch = files.map((file) => ({
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

      // Restore per-file overrides / lock from a previous session (keyed by
      // filename), so re-uploading the same roll keeps its tweaks.
      const restoredOverrides = {};
      const restoredLocked = [];
      for (const im of batch) {
        if (savedOverridesRef.current[im.name]) {
          restoredOverrides[im.id] = savedOverridesRef.current[im.name];
        }
        if (savedLockedRef.current.has(im.name)) restoredLocked.push(im.id);
      }
      if (Object.keys(restoredOverrides).length) {
        setOverrides((prev) => ({ ...prev, ...restoredOverrides }));
      }
      if (restoredLocked.length) {
        setLockedIds((prev) => {
          const n = new Set(prev);
          for (const id of restoredLocked) n.add(id);
          return n;
        });
      }

      for (const im of batch) runPreview(im);
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

  // ---- params ----

  const onGlobalChange = useCallback(
    (key, value) => {
      setGlobalParams((prev) => ({ ...prev, [key]: value }));
      scheduleHistoryCommit();
      if (selectedRef.current) debouncedRePreview(selectedRef.current);
    },
    [scheduleHistoryCommit, debouncedRePreview],
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
      scheduleHistoryCommit();
      debouncedRePreview(imageId);
    },
    [scheduleHistoryCommit, debouncedRePreview],
  );

  const applyPreset = useCallback(
    (params) => {
      setGlobalParams({ ...DEFAULTS, ...params });
      scheduleHistoryCommit();
      if (selectedRef.current) debouncedRePreview(selectedRef.current);
    },
    [scheduleHistoryCommit, debouncedRePreview],
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
    // Flip the ref synchronously so the immediate re-preview below uses the new
    // mode (state alone would lag one render).
    const next = !previewFullResRef.current;
    previewFullResRef.current = next;
    setPreviewFullRes(next);
    const id = selectedRef.current;
    if (id) {
      // Cancel any pending debounced preview and regenerate right away, so the
      // button actually re-renders the selected frame at the new resolution.
      if (debounceRef.current.has(id)) {
        clearTimeout(debounceRef.current.get(id));
        debounceRef.current.delete(id);
      }
      runPreviewById(id);
    }
  }, [runPreviewById]);

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
        const params = resolveSeed(image.id, effectiveParams(image.id));
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
        const params = resolveSeed(img.id, effectiveParams(img.id)); // native, unscaled
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

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (selectedRef.current) onDeleteImage(selectedRef.current);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        moveSelection(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'a') setViewMode('after');
      else if (k === 'b') setViewMode('before');
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, onDeleteImage, moveSelection]);

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
        accept="image/jpeg,image/jpg,image/png,image/webp,image/tiff"
        className="hidden"
        onChange={(e) => {
          onFiles(Array.from(e.target.files || []));
          e.target.value = '';
        }}
      />

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
              fullRes={previewFullRes}
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
    </div>
  );
}
