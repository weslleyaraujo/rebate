# rebate — web client

A browser client for the same `rebate` core as the CLI. Images are processed
**entirely in your browser** (Pyodide + OpenCV compiled to WebAssembly); nothing
is ever uploaded to a server.

The UX is modeled on [capa.cx](https://www.capa.cx): drop a roll of frames, see a
filmstrip, apply a preset, tweak per-frame offsets, and export.

## Stack

- **React 19 + Vite + Tailwind CSS v4** (static SPA, deploys to GitHub Pages).
- **Pyodide 314.x** loaded from jsDelivr, running in a **Web Worker**.
- The worker loads `opencv-python` + `numpy`, then imports the *same*
  `../rebate/core.py` used by the CLI (inlined at build time via `?raw`).

## Develop

```bash
cd web
npm install
npm run dev
```

## Tests

```bash
npm test           # Vitest unit tests (params, presets, zip)
npm run test:e2e   # Playwright E2E (headless Chrome: upload → preview → export)
```

`test:e2e` builds the app, serves it via `vite preview`, and drives a real
(headless) Chrome — it uses your locally-installed Chrome
(`channel: 'chrome'`), so no browser download is needed.

## Keyboard shortcuts

- `⌘/Ctrl Z` — undo param / offset change
- `⌘/Ctrl ⇧ Z` (or `⌘/Ctrl Y`) — redo
- `←` / `→` — previous / next frame (filmstrip auto-scrolls to keep it visible)
- `F` — enter / exit full-screen slideshow
- `Esc` — exit slideshow
- `Delete` / `Backspace` — remove selected frame
- `B` / `A` — before / after view
- Preview: **scroll** to zoom, **drag** to pan, **double-click** to toggle 1×/3×
- Sliders: hold **Shift** while dragging for a 10× coarser jump

## Build / deploy

```bash
cd web
npm run build      # outputs static site to web/dist
npm run preview    # serve the built site locally
```

Deploy `web/dist/` to any static host. `base: './'` is already set in
`vite.config.js`, so it works under a GitHub Pages project path
(e.g. `https://user.github.io/rebate/`) without extra configuration.

> First load downloads the Pyodide runtime + `opencv-python` + `numpy` wheels
> (~30–60 MB, cached by the browser afterwards). The app itself is ~90 KB gz.

## How it works

1. **Upload** — frames are read locally and previewed immediately.
2. **Preview** — a fast 2560px preview renders by default; **Full-res** toggles
   native resolution for the selected frame. Pixel-sized params (offsets,
   roughness/feather, detection overrides) are scaled so the preview matches
   the native export. Changes are debounced (~700 ms; detection drags re-run
   faster).
3. **Tweak** — global (roll) params apply to every frame; the **Frame** panel
   can override any visual param (mode, seed, crop, corners & edge, offsets)
   for a single frame, and a frame can be **locked** to freeze its look.
   **Detect** (or *Edit detection visually*) opens a visual editor over the
   full scan — drag the green gate (move/corners/edges) or the cyan sprocket
   lines instead of typing pixel numbers; the red crop overlay follows
   automatically. **Done** applies and regenerates. Presets are stored in
   `localStorage` and can be exported/imported as JSON.
4. **Export** — **Download** re-runs every frame at native resolution and
   bundles the results into a timestamped ZIP (or download a single frame from
   the Frame panel). If "debug" is enabled, each frame also emits a
   `.debug.jpg` with gate/crop rectangles. A **Slideshow** button (or `F`) opens
   a full-screen viewer — navigate with `←`/`→`, close with `Esc`/`F`.

## Params ↔ CLI

The defaults in `src/lib/params.js` mirror `rebate/cli.py`'s `_OPTION_SPECS`.
The browser always passes every value explicitly to `core.process_image`, so it
does not rely on Python-level function defaults (which differ from CLI defaults
for a few params such as `border_jitter`).
