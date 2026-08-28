# AGENTS.md — border-scan / rebate

Context for AI agents working on this repository.

## What this project is

`rebate.py` takes DSLR scans of 35mm film shot **"with full sprockets"** (already
positive / inverted) and produces a **bordered scan**: the real exposed frame +
its natural unexposed film border (rebate), rounded corners with a soft,
slightly irregular edge, composited on a white canvas.

The goal is to mimic a classic **Fuji Frontier** "border" scan, but built from
the *real* film border in the scan rather than a drawn frame. The key design
principle (user decision): **"just a crop"** — the border texture is the actual
film; we do **not** synthesize grain, luminance drift, dust/scratches, or any
other surface texture.

Default output is **native resolution** (no resampling), typically ~6300×4500px.

## Environment

- Interpreter: **`/opt/homebrew/bin/python3.11`** (has OpenCV + numpy).
  The default `python3` on this Mac is 3.14 and does **not** have cv2/numpy.
- The script has a `#!/opt/homebrew/bin/python3.11` shebang and is executable.
- Requires: `opencv-python-headless`, `numpy`.

## Running

```bash
./rebate.py INPUT.jpg --out ./out
./rebate.py INPUT.jpg --out ./out --debug          # also save annotated debug image
./rebate.py INPUT.jpg --out ./out --plain --suffix .plain.jpg   # no border, no canvas
/opt/homebrew/bin/python3.11 -m unittest discover -s tests -p 'test_*.py'
```

Single file, glob, or many inputs all work (`inputs` is `nargs="+"`).

## Input data layout

Positives live under `~/Pictures/`, e.g.:

```
~/Pictures/2026/08_August/2026_08_picos_de_europa/<ROLL>/<ROLL>/positives/*-positive.jpg
```

Rolls (color negative, full sprockets):

- `Leica_M7_Fuji_Superia_Preium_400_6612` (37 frames, ~5743×4912)
- `Leica_M7_Fujicolor_100_6226` (37)
- `Ricoh_TF-900_Cinestill_50D_1644` (74) — **also has a `positives-borderless/`
  folder (no sprockets); exclude it.**
- `Ricoh_TF-900_Kodak_Gold_200_5664` (37)

Others (problematic or different):

- `Leica_M7_Kodak_Ektachrome_100_6595` (slide; **most frames have no/weak
  sprockets**, ~5646×3751, in `2026_07_toronto`).
- `Leica_M7_Kodak_Vision_250D_AHU_1577` (76) — has a **known gate-clipping
  bug** (see Known issues).
- `Minolta_XD-S_Kodak_Vision_250D_AHU_0362` (1).

The repo also has `samples/input.jpg` — a downsampled **B&W** Kentmere 400
positive (1000×838) used for the README examples. Its rebate is thin, so
sprockets show even with the default gate.

## Output / CLI flags (current)

| flag | default | meaning |
|---|---|---|
| `--out` | `.` | output dir |
| `--size` | `0` | square canvas size; `0` = native res (recommended) |
| `--margin` | `0.05` | white margin around crop (fraction) |
| `--border` | `0.015` | film border kept around gate (fraction of gate height) |
| `--radius` | `0.015` | corner radius (fraction of final crop size) |
| `--radius-jitter` | `0.0` | random ± corner radius (fraction) |
| `--border-jitter` | `0.6` | random shift of black border (fraction of border thickness); keeps crop size constant |
| `--max-sprocket-border` | `0.03` | max rebate (fraction of gate height) that still shows a sprocket sliver |
| `--roughness` | `0.5` | edge irregularity in px |
| `--feather` | `3.0` | edge softness in px |
| `--sprocket-chance` | `0.7` | chance a tiny sprocket sliver shows, at most one side |
| `--seed` | random | seed for edge texture / sprocket / border randomness |
| `--quality` | `100` | JPEG quality |
| `--plain` | off | crop just the 3:2 image, no border/canvas |
| `--debug` | off | save annotated debug image |
| `--suffix` | `.bordered.jpg` | output suffix (`.png` = lossless) |

## Code structure (`rebate.py`)

Detection / geometry:

- `_sprocket_candidates(gray)` — bright blob candidates in top/bottom bands.
- `_grid_fit(xs, w)` — best periodic sprocket grid (pitch, phase).
- `_sprocket_info(gray)` — sprocket geometry (ts_bot, bs_top, center_x, pitch),
  or `None`. Tolerates one undetectable side.
- `_sprocket_band_edges(gray)` — **fallback** using row-wise p95 brightness
  profile (photo = widest bright run near center; sprocket bands = bright runs
  just outside it). Returns (ts_bot, bs_top), each possibly None.
- `_sprocket_inner_edges(gray)` — `_sprocket_info` first, fills missing sides
  from `_sprocket_band_edges`.
- `_row_activity` / `_col_activity` — median + MAD per row/col.
- `_photo_edges_in` / `_photo_edges_x` — find exposed frame by brightness/texture.
- `detect_gate(gray)` — (left, top, right, bottom) of the 36×24mm gate.
- `detect_photo_gate(gray)` — gate + small safety inset (used by `--plain`).

Crop / compose:

- `crop_with_border(gray, left, top, right, bot, border_frac, sprocket_chance,
  seed, border_jitter=0.0, max_sprocket_border=0.03)` — expand gate by
  `border_frac`, apply border jitter (shift, constant size), then optionally
  dip a tiny sprocket sliver on at most one side.
- `_rounded_mask` / `_organic_mask` — rounded-rect mask with fractal-noise
  edge perturbation (roughness) + Gaussian feather.
- `compose_on_white` — paste crop onto white canvas (native or `--size`).
- `process` — reads image, handles portrait rotation, runs detect→crop→compose.
- `main` — argparse.

Physical constants: `ASPECT = 1.5`, `GATE_H_MM = 24.0`,
`SPROCKET_PITCH_MM = 4.75`, `SPROCKET_PITCH_FALLBACK = 730` (px).

## Detection algorithm (high level)

1. Sprocket holes in the outer bands → grid-fit to the ~4.75mm pitch → learn
   scan scale (pitch in px) + the two sprocket rows.
2. Find the exposed 36×24mm gate via brightness/texture between the rows (or
   pitch-implied 3:2 geometry for dark frames).
3. No usable sprockets → brightness/texture over the whole strip, checked
   against expected 3:2 height.
4. Horizontal center from sprocket holes (top/bottom cross-checked).
5. Crop = gate + `--border` band; optional tiny sprocket sliver.
6. Rounded, slightly wavy, feathered mask → white canvas.

## Sprocket sliver — final behavior (important)

- A sliver is only shown when that side's rebate is **thin**: gate is
  `0 < rebate < max_sprocket_border * gate_h` (default `0.03` ≈ 112px at
  native). Otherwise the crop keeps a small plain border — this avoids a
  "massive" wide black band when the frame sits far from the sprockets.
- Dip amount is **tiny**: `rng.uniform(0.0005, 0.0015) * gate_h` ≈ 2–5px.
- At most **one** side, chosen randomly (50/50) when both are eligible.

Why: these full-strip scans have a thick top rebate (~350–600px on some rolls),
so dipping all the way to the far sprockets made the border huge. The user
wanted "a small part of the rebate + a tiny little bit of sprocket".

## Key decisions / gotchas (from project history)

- **"Just a crop"** — the texture is the real film rebate. No synthetic grain,
  no luminance drift, no dust/scratch/Newton-ring simulation.
- `_sprocket_band_edges` must use `above[0]` (bright run closest to the image
  **top** edge) for the top band inner edge — using `above[-1]` (closest to the
  photo) picked up a spurious bright strip at the photo edge and returned wrong
  `ts_bot` (e.g. 576 instead of ~191). Bottom correctly uses `below[0]`.
- `border_jitter` is a **shift** of the crop window relative to the fixed photo
  (crop size constant), not a resize. This makes the black rebate asymmetric on
  a random side.
- Corner radius is a fixed fraction of the crop size; `--radius-jitter`
  (default `0.0`) optionally varies it by a simple uniform ± factor. (Project
  memory mentions an older 3-way corner mixture that is NOT in the current file.)
- Portrait scans are rotated in memory to landscape for detection, then rotated
  back; the source file is never modified.

## Known issues

- **Vision 250D 1577** (esp. `-019`): pre-existing gate-clipping bug —
  `detect_gate` returns a gate outside the image (e.g. y[-5..3651]). Unrelated
  to the sprocket work.
- **Ektachrome 6595**: most frames have no/weak sprocket detection.
- **Cinestill 50D 1644**: has both `positives/` (use this) and
  `positives-borderless/` (no sprockets — do NOT use for sprocket work).

## Tests

```bash
/opt/homebrew/bin/python3.11 -m unittest discover -s tests -p 'test_*.py'
```

16 tests in `tests/test_rebate.py` cover masks, grid fitting, gate/photo
detection, portrait rotation, compose, and randomness (sprocket band edges,
border jitter, sprocket-at-most-one-side, and thick-rebate skip).

## Regenerating the README samples

The `samples/*.jpg` previews are regenerated from `samples/input.jpg` at
`--size 1600`:

- `bordered-01/02/03.jpg` — default, seeds 1/2/3
- `bordered-sprockets.jpg` — `--sprocket-chance 1 --seed 42`
- `bordered-sharp.jpg` — `--radius 0 --roughness 0 --feather 0`
- `bordered-round.jpg` — `--radius 0.06 --radius-jitter 0`
- `plain-01.jpg` — `--plain`

(These are for the README display only; normal use is native resolution.)
