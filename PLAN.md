# Plan: refactor `rebate` into a reusable Python core + WASM browser client

## Context

`rebate.py` is currently a single-file CLI: argparse + named configs + file IO
are interleaved with the actual image-processing logic (detection, crop,
compose). We want three things:

1. **Refactor** the compute into a pure, in-memory Python **core** (no file IO,
   no argparse, no config storage). The CLI becomes a thin *client* that calls
   the core.
2. **Run that core in the browser** via WASM, keeping the logic in Python
   (not rewritten in JS). A second *client* (the web app) uploads images
   locally, tweaks params, previews, and downloads.
3. **Keep the CLI byte-identical in behavior** — all 18 existing tests must
   still pass unchanged.

Key finding that de-risks the WASM step: this environment's Pyodide
(version `314.0.7`) ships **`opencv-python 4.11.0.86`, `numpy 2.4.6`,
`scipy 1.18.0`, `Pillow 12.2.0`** as official built packages. So the core can
keep using `cv2`/`numpy` as-is and still run in Pyodide — no OpenCV→scipy/Pillow
rewrite required.

## Approach

### A. Refactor into a package (pure core + CLI client)

Split the single file into a package while keeping `import rebate` fully
backward compatible (the tests do `import rebate` and call many internals):

```
rebate/
  __init__.py     # re-exports every name (core + cli) so `import rebate` works unchanged
  core.py         # PURE in-memory compute: constants, detection, crop, compose,
                  # process_image(), decode_image()/encode_image(). Imports ONLY
                  # cv2 + numpy (+ dataclasses). No os/sys/argparse/json.
  cli.py          # CLI client: argparse, configs, offset resolution, _save_image,
                  # process(), main(). Imports from core.
  __main__.py     # optional: `python -m rebate`
rebate.py         # thin executable launcher (keeps the shebang) -> rebate.cli.main()
```

Why `rebate/` package + `rebate.py` launcher can coexist: `import rebate`
resolves to the package (verified), while `./rebate.py` is only ever executed
as a script (it does `from rebate.cli import main`), so there is no conflict.

**What moves to `core.py`** (pure, in-memory — this is the browser-facing API):

- Constants: `ASPECT`, `GATE_H_MM`, `SPROCKET_PITCH_MM`, `SPROCKET_PITCH_FALLBACK`.
- Detection: `_sprocket_candidates`, `_grid_aligned`, `_grid_fit`, `_sprocket_info`,
  `_row_activity`, `_col_activity`, `_runs1d`, `_merge_runs`, `_photo_edges_in`,
  `_detect_photo_edges`, `_photo_edges_x`, `detect_gate`, `detect_photo_gate`,
  `_sprocket_centers`, `_detect_center_x`, `_sprocket_band_edges`,
  `_sprocket_inner_edges`.
- Crop/compose: `crop_with_border`, `_nudge_crop`, `_rounded_mask`, `_organic_mask`,
  `compose_on_white`.
- New `process_image(img_bgr, *, margin, border, radius, roughness, feather,
  seed, sprocket_chance, radius_jitter, square_corner_chance, border_jitter,
  max_sprocket_border, offset_*, plain, debug) -> ProcessResult`.
  `ProcessResult` carries: final BGR image, optional debug BGR image, gate rect,
  crop rect/size/ratio, plain rect — everything the CLI needs to log.
- New `decode_image(data: bytes) -> BGR` and `encode_image(bgr, ext, quality) -> bytes`
  (thin wrappers over `cv2.imdecode`/`cv2.imencode`) so CLI and browser share the
  exact same pixel↔bytes path.

**What stays in `cli.py`** (CLI client):

- `_OPTION_SPECS`, `_DEST_TO_FLAG`, `_TYPE_BY_DEST`, `_config_path`, `_load_configs`,
  `_save_configs`, `_coerce_config`, `_add_common_options`, `_explicit_option_names`,
  `config_command`.
- `_resolve_offsets`, `_offsets_active`.
- `_save_image` (file write + `core.encode_image`).
- `process(path, out_dir, ...)` — same signature as today; does `cv2.imread` →
  `core.process_image` → `_save_image` → identical prints. Returns `out_path` / `None`.
- `main()` — returns an exit code instead of calling `sys.exit()` directly.

### B. WASM / core-in-browser

Use **Pyodide** (the standard CPython→WebAssembly runtime), loaded from CDN.

- The core module (`rebate/core.py`) is **self-contained** (only `cv2`+`numpy`),
  so it can be written into Pyodide's virtual FS and imported directly.
- Load packages: `pyodide.loadPackage(['numpy', 'opencv-python'])`.
- Run Pyodide in a **Web Worker** so heavy processing never blocks the UI thread.
- Data flow (all local): uploaded `File` → `ArrayBuffer` → bytes → (worker)
  `decode_image` → `process_image` → `encode_image` → bytes → `Blob` → download.
  Passing bytes (not 28 MP numpy arrays) across the JS↔Python boundary avoids
  expensive proxy copies.
- **Preview vs export** (recommended): preview at a reduced resolution
  (detector is scale-invariant, so downscaling the *input* is safe and fast);
  export at native resolution on demand. Exact scaling of px-based params
  (`roughness`, `feather`, `offset_*`) handled by the browser client.

Known WASM risks to check during implementation (mitigations noted):
- OpenCV codecs (`imdecode`/`imencode` JPEG+PNG) present in the wasm build —
  verify with a smoke test first.
- WASM memory for several native-res (~28 MP) images — process sequentially and
  free arrays; consider a per-image memory ceiling.
- OpenCV threading in wasm — call `cv2.setNumThreads(0)` (or 1) in the worker.
- Tiny numeric differences in cv2 resize/blur between native and wasm SIMD
  builds are possible; acceptable (same look, not necessarily byte-identical).

### C. Web app (client #2)

Feature ideas to finalize (see Open Questions below):

- Drag-and-drop / multi-file upload; all processing local (privacy).
- Global params panel (auto-generated from the same option schema as the CLI),
  grouped Basic/Advanced; live preview on a selected image; batch export.
- Per-image thumbnails + processing queue + progress.
- Named presets in `localStorage` (mirroring CLI configs); import/export JSON
  so a look can move between CLI and web.
- Download individual files or all-as-ZIP (JPEG quality / PNG toggle);
  keep original filename + suffix convention.
- Before/after comparison + zoom/pan to inspect corners/edges.
- Debug overlay toggle (gate/crop rectangles) — reuse `process_image` debug.
- Optional perf optimization later: cache detection per image so tweaking
  radius/roughness/feather/seed re-runs only compose, not detection.

## Files to modify / create

- `rebate/core.py` — new (moved compute + `process_image` + decode/encode).
- `rebate/cli.py` — new (moved CLI logic; `process` delegates to core).
- `rebate/__init__.py` — new (re-export all names for `import rebate`).
- `rebate/__main__.py` — new (optional `python -m rebate`).
- `rebate.py` — replace body with a 3-line launcher (keep shebang + executable bit).
- `tests/test_rebate.py` — **unchanged** (must keep passing).
- `README.md` / `AGENTS.md` — update "Code structure" to describe the package split.
- `web/` — new static app (index.html, app.js, worker.js) — see Open Questions for stack.
- (optional) `pyproject.toml` — make the package installable/wheelable for `micropip`.

## Reuse

Everything in the current `rebate.py` is reused as-is; we are **moving**, not
rewriting, the detection/crop/compose functions. Specifically reused unchanged:
`detect_gate`, `detect_photo_gate`, `crop_with_border`, `_nudge_crop`,
`_rounded_mask`, `_organic_mask`, `compose_on_white`, `_sprocket_*`, `_grid_*`,
`_photo_edges_*`, `_row_activity`, `_col_activity`, `_runs1d`, `_merge_runs`,
and the whole config/argparse block. `_save_image` is reused and pointed at
`core.encode_image` so CLI and browser produce identical bytes.

## Steps

- [x] 1. Create `rebate/` package; move constants + detection + crop/compose into `core.py` (imports: `cv2`, `numpy`, `dataclasses`).
- [x] 2. Add `process_image()` to `core.py` extracting the in-memory body of today's `process()`; return a `ProcessResult` (image, debug image, gate/crop/plain rects + sizes for logging).
- [x] 3. Add `decode_image()` / `encode_image()` to `core.py`.
- [x] 4. Create `cli.py` with the config/argparse/offset/file-IO code; rewrite `process()` to call `core.process_image()` and reproduce the exact stdout lines; `_save_image` uses `core.encode_image()`.
- [x] 5. Write `rebate/__init__.py` re-exporting every name (including underscore internals) from `core` + `cli`; add `rebate/__main__.py`.
- [x] 6. Replace `rebate.py` with the launcher; keep shebang/executable bit.
- [x] 7. Run the full test suite — must be green with **zero test edits**.
- [x] 8. Manual CLI parity check: run `./rebate.py samples/input.jpg --out out --seed 42` and `--plain`, `--debug`, `config save/list/show`, compare outputs to pre-refactor behavior.
- [x] 9. WASM smoke test: minimal HTML+worker loading Pyodide, `loadPackage(['numpy','opencv-python'])`, import `core.py` from FS, decode a small JPEG → `process_image` → encode → verify PNG/JPEG roundtrip.
- [x] 10. Verify `cv2.setNumThreads`, codec support, and memory behavior on a native-res image in the worker.
- [x] 11. Build the web app per finalized feature set (upload, params, preview, batch, download/presets).
- [x] 12. Update README/AGENTS "Code structure" section.

## Verification

- `cd <repo> && /opt/homebrew/bin/python3.11 -m unittest discover -s tests -p 'test_*.py'` → 18/18 pass, unchanged.
- `./rebate.py samples/input.jpg --out out --seed 42` and `--seed 1/2/3`, `--plain`,
  `--debug`, `--sprocket-chance 1`, `--radius 0 --roughness 0 --feather 0` →
  same files/sizes/look as before the refactor (spot-check `out/` against pre-change run).
- `./rebate.py config save ig --quality 95 --border 0.04 && ./rebate.py config show ig && ./rebate.py config list && ./rebate.py config delete ig` → same output/exit codes.
- Browser: `python3 -m http.server` in `web/`, open localhost, upload `samples/input.jpg`,
  tweak params, preview updates, download returns a valid bordered JPEG; batch of 3+
  images exports a ZIP. No network upload occurs (confirm via devtools network tab).

## Open questions (please answer in review)

1. **MVP scope** — single image at a time, or batch (multi-upload + queue + ZIP) in v1? *(rec: batch)*
2. **Params** — expose all CLI params (Basic/Advanced grouping), or curated subset? Global params for all images, or per-image overrides? *(rec: all params, grouped; global in v1)*
3. **Tech stack** — vanilla JS + Pyodide (no build), Vite + React/Svelte, or PyScript? TypeScript or plain JS? *(rec: vanilla JS, Pyodide in a Web Worker; TS optional)*
4. **Preview vs export** — fast downscaled preview + native-res export on demand (few seconds/img), or native preview? *(rec: downscaled preview + native export)*
5. **Deployment / assets** — fully static (GitHub Pages / any host) with Pyodide from CDN (~30–60 MB first load), or self-host Pyodide assets? Is first-load size a priority to minimize?
6. **Presets** — mirror CLI named configs as browser presets in localStorage, with JSON import/export between CLI and web? *(rec: yes)*
7. **Output** — individual downloads, ZIP-all, or both? JPEG (quality slider) only, or also PNG toggle? *(rec: both + ZIP; JPEG default + PNG toggle)*
8. **Preview niceties (must-have in v1?)** — before/after comparison, zoom/pan to inspect corners/edges, debug overlay (gate/crop rectangles)? *(rec: before/after + zoom/pan yes; debug overlay can be v1.1)*
9. **Seed UX** — shared seed for all, per-image seed, or just show value + 🎲 randomize? *(rec: show value + randomize; per-image later)*
10. **Hosting target** — GitHub Pages / Netlify / Vercel / own domain? (informs build/serve setup only)
