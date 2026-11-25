"""rebate — pure, in-memory film border scanner core.

This module contains the entire image-processing pipeline: sprocket/gate
detection, crop-with-border, rounded/soft mask generation, and compositing.

It is deliberately free of file IO, argparse, and config storage, so the same
code can be driven by the CLI client (`rebate/cli.py`) or a browser client
(Pyodide / WebAssembly). The only third-party dependencies are `numpy` and
`opencv-python`.
"""

import cv2
import numpy as np

from dataclasses import dataclass
from typing import Optional

# 35mm full-frame is 36 x 24 mm -> 3:2 aspect ratio.
ASPECT = 1.5
# Physical 35mm still-film dimensions (mm). These are the scale-invariant
# anchors: whatever the scan resolution, the gate is 24 mm tall and the
# sprocket pitch is 4.75 mm (the 36 mm width follows from the 3:2 aspect).
GATE_H_MM = 24.0
SPROCKET_PITCH_MM = 4.75
# Fallback sprocket pitch in pixels (only used by _grid_aligned).
SPROCKET_PITCH_FALLBACK = 730
# Per-image RNG stream stride for multi-image merges. Each tile reserves a
# block this wide so its crop / mask / corner streams never collide with
# another tile's streams (the single-image pipeline uses fixed offsets of
# 100000 and 200000 within the base seed).
MERGE_SEED_STRIDE = 500000


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

def _sprocket_candidates(gray):
    """Return (top_holes, bottom_holes) candidate sprocket holes.

    Sprocket holes are bright, medium-sized blobs in the outer bands of the
    film strip (outside the 24mm gate). Size ranges are expressed relative to
    the expected sprocket pitch (about w / 7.58 for a full-width 35mm frame)
    so the same code works at any scan resolution while still rejecting the
    small irregular fragments of photo content and dust.
    """
    h, w = gray.shape
    pitch_est = w / 7.58  # 36mm frame ~= 7.58 sprocket pitches across the width
    cw_lo, cw_hi = 0.38 * pitch_est, 0.90 * pitch_est
    ch_lo, ch_hi = 0.28 * pitch_est, 0.85 * pitch_est
    top, bot = [], []
    for is_top, (y_lo, y_hi) in ((True, (0, int(h * 0.16))),
                                 (False, (int(h * 0.88), h))):
        band = gray[y_lo:y_hi, :]
        if band.size == 0:
            continue
        # Adaptive threshold: sprocket holes are the bright tail of the band.
        thresh = float(np.percentile(band, 99.0))
        thresh = max(30.0, min(150.0, thresh * 0.6))
        bright = (band > thresh).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(bright, 8)
        for i in range(1, n):
            x, y, cw, ch, area = stats[i]
            if not (cw_lo <= cw <= cw_hi and ch_lo <= ch <= ch_hi):
                continue
            if ch < cw * 0.4:
                continue
            hl = {"cx": x + cw // 2, "cy": y_lo + y + ch // 2,
                  "y": int(y_lo + y), "ch": int(ch), "cw": int(cw),
                  "area": int(area)}
            (top if is_top else bot).append(hl)
    return top, bot


def _grid_aligned(holes, pitch=SPROCKET_PITCH_FALLBACK, tol=100):
    """Return the subset of holes consistent with a periodic x-grid."""
    if len(holes) < 4:
        return []
    xs = sorted(set(h["cx"] for h in holes))
    best_count, best_phase = 0, 0.0
    for seed in xs:
        phase = seed % pitch
        cnt = sum(
            1 for x in xs
            if min((x - phase) % pitch, pitch - (x - phase) % pitch) <= tol)
        if cnt > best_count:
            best_count, best_phase = cnt, phase
    aligned_x = {x for x in xs
                 if min((x - best_phase) % pitch,
                        pitch - (x - best_phase) % pitch) <= tol}
    return [h for h in holes if h["cx"] in aligned_x]


def _grid_fit(xs, w):
    """Return (pitch, phase, count) of the best periodic grid for x-centers.

    Scale-invariant: the pitch is searched over a wide range relative to the
    image width. Among pitches that align the same number of blobs we prefer
    the largest, because a sub-multiple of the true pitch (e.g. pitch/2) also
    aligns perfectly spaced holes while the true pitch is the largest period
    that does.
    """
    xs = np.array(sorted(set(int(round(x)) for x in xs)), dtype=np.float64)
    if len(xs) < 4:
        return None
    lo = max(20, int(w * 0.02))
    hi = int(w * 0.35)
    best = None
    for seed in xs[:3]:
        for pitch in range(lo, hi, 4):
            d = np.abs((xs - seed) % pitch)
            d = np.minimum(d, pitch - d)
            cnt = int((d <= max(6, pitch * 0.06)).sum())
            if best is None or cnt > best[2] or (cnt == best[2] and pitch > best[0]):
                best = (float(pitch), float(seed % pitch), cnt)
    return best


def _sprocket_info(gray):
    """Sprocket geometry, tolerating one undetectable side.

    Returns (ts_bot, bs_top, center_x, pitch); ts_bot/bs_top may be None if
    that side's holes can't be resolved (e.g. an underexposed frame). Returns
    None if no usable periodic grid is found.
    """
    top_cand, bot_cand = _sprocket_candidates(gray)
    if len(top_cand) + len(bot_cand) < 4:
        return None

    w = gray.shape[1]
    fit = _grid_fit([h["cx"] for h in top_cand + bot_cand], w)
    if fit is None:
        return None
    pitch, phase, _ = fit

    # Sanity: the pitch implies a 24mm gate height; that must be a plausible
    # fraction of the strip height. A full-strip scan shows the 24mm gate at
    # roughly 0.69-0.85 of the strip height, so the lower bound must be close
    # to that. Too loose a bound lets a few spurious blobs win a sub-multiple
    # pitch (e.g. 422px instead of the true ~760px, or pitch/2), which would
    # shrink the gate to ~0.44 of the strip and mis-crop the frame.
    gate_h_px = pitch * (GATE_H_MM / SPROCKET_PITCH_MM)
    h = gray.shape[0]
    if not (0.6 * h <= gate_h_px <= 0.9 * h):
        return None

    tol = max(6, int(pitch * 0.10))

    def aligned(holes):
        return [h for h in holes
                if min((h["cx"] - phase) % pitch,
                       pitch - (h["cx"] - phase) % pitch) <= tol]

    top_aligned = aligned(top_cand)
    bot_aligned = aligned(bot_cand)
    ts_bot = max(hl["y"] + hl["ch"] for hl in top_aligned) if len(top_aligned) >= 2 else None
    bs_top = min(hl["y"] for hl in bot_aligned) if len(bot_aligned) >= 2 else None
    if ts_bot is None and bs_top is None:
        return None

    # Horizontal centre: midpoint of the detected hole run is robust to a few
    # missed holes (the median is not). Use top/bottom independently and pick
    # the one closest to the (roughly centred) image centre.
    cx_candidates = []
    if len(top_aligned) >= 2:
        cx_candidates.append((min(h["cx"] for h in top_aligned)
                              + max(h["cx"] for h in top_aligned)) / 2.0)
    if len(bot_aligned) >= 2:
        cx_candidates.append((min(h["cx"] for h in bot_aligned)
                              + max(h["cx"] for h in bot_aligned)) / 2.0)
    center_x = min(cx_candidates, key=lambda c: abs(c - w / 2.0))
    # A fixed holder centres the frame in the scan. Only trust a sprocket-
    # derived centre when it lands near the image centre; a hole run that is
    # missing holes on one side gives a badly biased midpoint.
    if not (w * 0.45 <= center_x <= w * 0.55):
        center_x = w / 2.0
    return ts_bot, bs_top, center_x, pitch


def _row_activity(gray):
    """Median and median-absolute-deviation (MAD) per row.

    Width is downsampled for speed but vertical resolution is kept, so the
    returned profiles are one value per source row. The exposed photo (gate)
    is bright and/or textured (high median or high MAD); the unexposed film
    border (rebate) is uniformly dark and flat (low median *and* low MAD);
    sprocket holes are bright but sparse, so they leave the median dark.
    """
    h, w = gray.shape
    target_w = 400
    if w > target_w:
        small = cv2.resize(gray, (target_w, h),
                           interpolation=cv2.INTER_AREA).astype(np.float32)
    else:
        small = gray.astype(np.float32)
    med = np.median(small, axis=1)
    mad = np.median(np.abs(small - med[:, None]), axis=1)
    return med, mad


def _col_activity(gray):
    """Median and MAD per column (transpose of _row_activity)."""
    h, w = gray.shape
    target_h = 400
    if h > target_h:
        small = cv2.resize(gray, (w, target_h),
                           interpolation=cv2.INTER_AREA).astype(np.float32)
    else:
        small = gray.astype(np.float32)
    med = np.median(small, axis=0)
    mad = np.median(np.abs(small - med[None, :]), axis=0)
    return med, mad


def _runs1d(mask):
    """Contiguous True runs in a 1-D boolean array, as [(start, end)]."""
    mask = np.asarray(mask, dtype=bool)
    runs = []
    start = None
    for i in range(len(mask) + 1):
        v = bool(mask[i]) if i < len(mask) else False
        if v and start is None:
            start = i
        if not v and start is not None:
            runs.append((start, i - 1))
            start = None
    return runs


def _merge_runs(runs, gap):
    """Merge runs separated by at most `gap` indices."""
    if not runs:
        return []
    merged = []
    cur_s, cur_e = runs[0]
    for s, e in runs[1:]:
        if s - cur_e - 1 <= gap:
            cur_e = e
        else:
            merged.append((cur_s, cur_e))
            cur_s, cur_e = s, e
    merged.append((cur_s, cur_e))
    return merged


def _photo_edges_in(gray, y_lo, y_hi):
    """Find the photo (top, bottom) within a row range, or None.

    The rebate is dark and the photo is brighter, so the median brightness is
    the discriminator. MAD is deliberately NOT used to extend the edges: a
    fogged/light-leaked rebate can be textured (high MAD) yet dark, which
    would otherwise drag the border out over the sprockets. Dark patches
    *inside* the photo are bridged by the gap-merge below.
    """
    med, mad = _row_activity(gray)
    med = med[y_lo:y_hi]
    mad = mad[y_lo:y_hi]
    if len(med) == 0:
        return None
    # Smooth so a single-row transient (dust line, fog streak) can't create a
    # false edge; a ~0.1% window is a few rows at typical scan sizes.
    k = max(3, len(med) // 1000)
    med = np.convolve(med, np.ones(k) / k, mode="same")
    med_base = float(np.percentile(med, 2))
    med_thr = med_base + max(12.0, 0.5 * med_base)
    photo = med > med_thr
    # Bridge small dark patches inside the photo (e.g. shadows) up to ~3% of
    # the range so a single dark area can't split the frame in two.
    gap = max(1, int(round((y_hi - y_lo) * 0.03)))
    runs = _merge_runs(_runs1d(photo), gap)
    if not runs:
        return None
    top, bot = max(runs, key=lambda r: r[1] - r[0])
    return top + y_lo, bot + y_lo


def _detect_photo_edges(gray):
    """Return (top, bottom) of the exposed photo frame, or None."""
    return _photo_edges_in(gray, 0, gray.shape[0])


def _photo_edges_x(gray, x_lo, x_hi):
    """Return (left, right) of the exposed photo frame, or None.

    The frame's horizontal extent is bounded by the dark inter-frame gaps, so
    it's detected with the same brightness/texture step as the vertical edges
    (there are no sprocket holes on the left/right to interfere).
    """
    med, mad = _col_activity(gray)
    med = med[x_lo:x_hi]
    mad = mad[x_lo:x_hi]
    if len(med) == 0:
        return None
    med_base = float(np.percentile(med, 2))
    mad_base = float(np.percentile(mad, 2))
    med_thr = med_base + max(12.0, 0.5 * med_base)
    mad_thr = mad_base + max(5.0, 0.8 * mad_base)
    photo = (med > med_thr) | (mad > mad_thr)
    gap = max(1, int(round((x_hi - x_lo) * 0.03)))
    runs = _merge_runs(_runs1d(photo), gap)
    if not runs:
        return None
    left, right = max(runs, key=lambda r: r[1] - r[0])
    return left + x_lo, right + x_lo


def detect_gate(gray):
    """Return (left, top, right, bottom) of the exposed film frame (gate)."""
    h, w = gray.shape

    info = _sprocket_info(gray)
    if info is not None:
        ts_bot, bs_top, center_x, pitch = info
        gate_h_px = pitch * (GATE_H_MM / SPROCKET_PITCH_MM)

        if ts_bot is not None and bs_top is not None:
            # Both sprocket rows known: refine with the brightness/texture step
            # inside the inter-sprocket band (the bright holes are excluded).
            edges = _photo_edges_in(gray, int(ts_bot), int(bs_top))
            if edges is not None and 0.85 * gate_h_px <= edges[1] - edges[0] <= 1.15 * gate_h_px:
                top, bot = edges
            else:
                mid = (ts_bot + bs_top) / 2.0
                top = mid - gate_h_px / 2.0
                bot = mid + gate_h_px / 2.0
        else:
            # Only one sprocket row is detectable. Prefer the brightness/texture
            # step (more precise); fall back to placing the 3:2 gate off the
            # known row when the photo is too dark to detect.
            edges = _photo_edges_in(gray, int(0.05 * h), int(0.95 * h))
            if edges is not None and 0.85 * gate_h_px <= edges[1] - edges[0] <= 1.15 * gate_h_px:
                top, bot = edges
            elif ts_bot is not None:
                top = ts_bot + 0.08 * pitch
                bot = top + gate_h_px
            else:
                bot = bs_top - 0.08 * pitch
                top = bot - gate_h_px
    else:
        # No usable sprockets (e.g. holes cropped off): brightness/texture over
        # the middle of the strip (the outer ~5% is excluded so the bright
        # sprocket slivers at the film edges aren't mistaken for photo).
        edges = _photo_edges_in(gray, int(0.05 * h), int(0.95 * h))
        expected_h = w / ASPECT
        if edges is not None and 0.85 * expected_h <= edges[1] - edges[0] <= 1.08 * expected_h:
            top, bot = edges
        else:
            top = (h - expected_h) / 2.0
            bot = top + expected_h
        center_x = _detect_center_x(gray, top, bot)

    gate_h = bot - top
    gate_w = gate_h * ASPECT

    # Refine the horizontal centre from the dark inter-frame gaps (handles
    # scans where the frame isn't perfectly centred). The width stays 3:2;
    # only the centre is shifted. We only trust a horizontal estimate that is
    # consistent with the 3:2 width AND lands near the image centre (a dark
    # edge inside the photo can otherwise bias it).
    h_edges = _photo_edges_x(gray, 0, w)
    if h_edges is not None:
        h_cx = (h_edges[0] + h_edges[1]) / 2.0
        if (0.90 * gate_w <= h_edges[1] - h_edges[0] <= 1.10 * gate_w
                and w * 0.47 <= h_cx <= w * 0.53):
            center_x = h_cx

    left = center_x - gate_w / 2.0
    right = center_x + gate_w / 2.0
    return left, top, right, bot


def detect_photo_gate(gray):
    """Return (left, top, right, bottom) of the actual photo (no rebate).

    Finds the real exposed-image boundary and then trims a small safety
    margin inside it so no unexposed film border remains.
    """
    left, top, right, bot = detect_gate(gray)
    gate_h = bot - top
    inset = max(8, int(round(gate_h * 0.004)))
    return left + inset, top + inset, right - inset, bot - inset


def _sprocket_centers(gray, top, bot):
    """Return candidate x-centers of sprocket holes above/below the gate."""
    top_cand, bot_cand = _sprocket_candidates(gray)
    holes = [h["cx"] for h in top_cand + bot_cand
             if h["cy"] < top - 20 or h["cy"] > bot + 20]
    return sorted(set(holes))


def _detect_center_x(gray, top, bot):
    h, w = gray.shape
    holes = _sprocket_centers(gray, top, bot)
    if len(holes) < 6:
        return w / 2.0

    fit = _grid_fit(holes, w)
    if fit is None:
        return w / 2.0
    pitch, phase, _ = fit
    tol = max(6, int(pitch * 0.10))
    aligned = [x for x in holes
               if min((x - phase) % pitch, pitch - (x - phase) % pitch) <= tol]
    if len(aligned) < 6:
        return w / 2.0

    cx = float(np.median(aligned))
    if w * 0.47 <= cx <= w * 0.53:
        return cx
    return w / 2.0


def _sprocket_band_edges(gray):
    """Fallback sprocket inner edges from the row brightness profile.

    Used when the hole-grid detection fails (e.g. fragmented holes on the new
    2026 positives). Each row's 95th percentile separates the dark rebate
    (low) from sprocket holes and the photo (high). The photo is the widest
    bright run around the strip centre; the sprocket bands are the bright runs
    just outside it. Returns (ts_bot, bs_top), each possibly None.
    """
    h, w = gray.shape
    prof = np.percentile(gray, 95, axis=1).astype(np.float32)
    k = max(3, h // 1000)
    prof = np.convolve(prof, np.ones(k) / k, mode="same")
    base = float(np.percentile(prof, 5))
    thr = base + 30.0
    if float(prof.max()) - base < 30.0:
        return None, None
    bright = prof > thr
    runs = _merge_runs(_runs1d(bright), max(1, h // 200))
    if not runs:
        return None, None

    mid = h // 2
    mid_runs = [r for r in runs if r[0] <= mid <= r[1]]
    if mid_runs:
        photo = max(mid_runs, key=lambda r: r[1] - r[0])
    else:
        photo = max(runs, key=lambda r: r[1] - r[0])

    ts_bot = bs_top = None
    # The sprocket band on each side is the bright run closest to that image
    # edge (top / bottom), not the run closest to the photo: a bright strip at
    # the photo's own edge is common and must not be mistaken for sprockets.
    above = [r for r in runs if r[1] < photo[0]]
    if above:
        ts_bot = above[0][1]
    below = [r for r in runs if r[0] > photo[1]]
    if below:
        bs_top = below[0][0]
    return ts_bot, bs_top


def _sprocket_inner_edges(gray):
    """Return (top_sprocket_bottom, bottom_sprocket_top).

    Prefers the grid-aligned hole detection; fills any side that can't be
    resolved (e.g. fragmented holes) from the row-profile fallback.
    """
    info = _sprocket_info(gray)
    if info is None:
        return _sprocket_band_edges(gray)
    ts_bot, bs_top, _, _ = info
    if ts_bot is None or bs_top is None:
        fb_ts, fb_bs = _sprocket_band_edges(gray)
        if ts_bot is None:
            ts_bot = fb_ts
        if bs_top is None:
            bs_top = fb_bs
    return ts_bot, bs_top


# ---------------------------------------------------------------------------
# Crop / compose
# ---------------------------------------------------------------------------

def crop_with_border(gray, left, top, right, bot, border_frac,
                     sprocket_chance, seed, border_jitter=0.0,
                     max_sprocket_border=0.03, sprocket_override=None):
    """Expand the gate by border_frac * gate_height, with two sources of
    randomness so no two crops look alike:

    - border_jitter: the whole crop window is shifted relative to the fixed
      photo (size unchanged), so the black rebate is bigger on a random side
      while the photo stays put.
    - sprocket sliver: on at most ONE side (top or bottom), the crop dips a
      small, random amount into the sprocket holes. Only used when the rebate
      between the photo and that sprocket band is thin.

    sprocket_override, when given, is the (top_sprocket_bottom,
    bottom_sprocket_top) tuple to use instead of auto-detection.
    """
    h, w = gray.shape
    gate_h = bot - top
    pad = border_frac * gate_h
    rng = np.random.default_rng(seed)

    if border_jitter > 0:
        shift_x = float(rng.uniform(-border_jitter, border_jitter)) * pad
        shift_y = float(rng.uniform(-border_jitter, border_jitter)) * pad
    else:
        shift_x = shift_y = 0.0

    # Shift the window but keep its size constant (border asymmetry, not a
    # resize). Integer coords are derived from one corner so the crop size is
    # identical regardless of the shift.
    crop_w = int(round((right - left) + 2.0 * pad))
    crop_h = int(round(gate_h + 2.0 * pad))
    crop_left = int(round(left - pad + shift_x))
    crop_top = int(round(top - pad + shift_y))
    crop_left = max(0, min(crop_left, w - crop_w))
    crop_top = max(0, min(crop_top, h - crop_h))
    crop_right = crop_left + crop_w
    crop_bot = crop_top + crop_h

    if sprocket_override is not None:
        ts_bot, bs_top = sprocket_override
    else:
        ts_bot, bs_top = _sprocket_inner_edges(gray)

    # Only show sprockets when the rebate between the photo and that band is
    # small; otherwise dipping would drag a wide black rebate into the crop.
    max_border = max_sprocket_border * gate_h
    top_avail = ts_bot is not None and 0 < top - ts_bot < max_border
    bot_avail = bs_top is not None and 0 < bs_top - bot < max_border

    # Clean-clamp each side with detected sprockets so the normal border never
    # accidentally reaches the holes...
    if top_avail:
        crop_top = max(crop_top, int(ts_bot) + 4)
    if bot_avail:
        crop_bot = min(crop_bot, int(bs_top) - 4)

    # ...then optionally dip at most ONE eligible side into the holes, chosen
    # randomly when both are close enough.
    if top_avail or bot_avail:
        if rng.random() < sprocket_chance:
            dip = rng.uniform(0.0005, 0.0015) * gate_h
            if top_avail and bot_avail:
                dip_top = rng.random() < 0.5
            else:
                dip_top = top_avail
            if dip_top:
                crop_top = max(0, int(round(ts_bot - dip)))
            else:
                crop_bot = min(h, int(round(bs_top + dip)))

    return crop_left, crop_top, crop_right, crop_bot


def _nudge_crop(cl, ct, cr, cb, offset_left, offset_top, offset_right,
                offset_bottom, w, h):
    """Nudge each crop edge independently by its offset (px, + = reveal more).

    Applied to the final crop window so one flag touches exactly one edge and
    nothing else — fully deterministic, independent of --seed or
    --border-jitter. Result is clamped to the image bounds.
    """
    cl = max(0, int(round(cl - offset_left)))
    cr = min(w, int(round(cr + offset_right)))
    ct = max(0, int(round(ct - offset_top)))
    cb = min(h, int(round(cb + offset_bottom)))
    if cl >= cr:
        cl = cr - 1
    if ct >= cb:
        ct = cb - 1
    return cl, ct, cr, cb


def _rounded_mask(w, h, radius, inset=0, square_corners=None):
    """Rounded-rectangle mask, optionally inset from the image boundary.

    square_corners: iterable of corner names ('tl', 'tr', 'bl', 'br') that
    should be left squared off instead of rounded.
    """
    inset = max(0, int(inset))
    if inset * 2 >= w or inset * 2 >= h:
        return np.zeros((h, w), np.uint8)
    mask = np.zeros((h, w), np.uint8)
    r = max(0, min(int(radius), (w - 2 * inset) // 2, (h - 2 * inset) // 2))
    x0, y0 = inset, inset
    x1, y1 = w - inset - 1, h - inset - 1
    if r <= 0:
        cv2.rectangle(mask, (x0, y0), (x1, y1), 255, -1)
        return mask
    square = set(square_corners or ())
    cv2.rectangle(mask, (x0 + r, y0), (x1 - r, y1), 255, -1)
    cv2.rectangle(mask, (x0, y0 + r), (x1, y1 - r), 255, -1)
    circles = {
        'tl': (x0 + r, y0 + r),
        'tr': (x1 - r, y0 + r),
        'bl': (x0 + r, y1 - r),
        'br': (x1 - r, y1 - r),
    }
    squares = {
        'tl': (x0, y0, x0 + r, y0 + r),
        'tr': (x1 - r, y0, x1, y0 + r),
        'bl': (x0, y1 - r, x0 + r, y1),
        'br': (x1 - r, y1 - r, x1, y1),
    }
    for name in ('tl', 'tr', 'bl', 'br'):
        if name in square:
            rx0, ry0, rx1, ry1 = squares[name]
            cv2.rectangle(mask, (rx0, ry0), (rx1, ry1), 255, -1)
        else:
            cx, cy = circles[name]
            cv2.circle(mask, (cx, cy), r, 255, -1)
    return mask


def _organic_mask(w, h, radius, roughness, feather, seed, square_corners=None,
                  waviness=0.0, edge_asymmetry=0.0):
    """Rounded-rect mask with a slightly irregular, anti-aliased edge.

    The rounded rect is computed as an analytic signed-distance field (instead
    of a rasterized circle), perturbed by high-frequency fractal noise for a
    subtle, straight film-gate edge (roughness, px), plus a low-frequency
    undulation (`waviness`, px) for the slow bow/drift of a real film gate,
    and converted to a soft alpha with a `feather`-px falloff. `edge_asymmetry`
    (0-1) lets each of the four edges have its own roughness/waviness amplitude
    so the mask reads as an actual, slightly uneven lab mask rather than a
    symmetric machined frame.

    The noise is generated on a FIXED reference grid (not on the mask's own
    resolution) so the same seed produces the same normalized edge texture at
    any output size — important so a downscaled preview and a native export
    look identical.
    """
    square = set(square_corners or ())
    inset = int(round(2.0 * (roughness + waviness) + feather)) + 2

    # Hard, binary mask when all edge effects are disabled (sharp look).
    if roughness <= 0 and waviness <= 0 and feather <= 0:
        return _rounded_mask(w, h, radius, inset, square)

    rng = np.random.default_rng(seed)
    if inset * 2 >= w or inset * 2 >= h:
        return np.zeros((h, w), np.uint8)

    # Analytic signed distance to a rounded rectangle (smooth, no rasterized
    # circle aliasing). Coordinates are pixel centers.
    x0, x1 = inset, w - inset - 1
    y0, y1 = inset, h - inset - 1
    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0
    hw = (x1 - x0) / 2.0
    hh = (y1 - y0) / 2.0
    r = max(0.0, min(float(radius), hw, hh))

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    qx = np.abs(xx - cx) - (hw - r)
    qy = np.abs(yy - cy) - (hh - r)
    sdf = np.minimum(np.maximum(qx, qy), 0.0) + np.sqrt(
        np.maximum(qx, 0.0) ** 2 + np.maximum(qy, 0.0) ** 2
    ) - r

    # Squared corners: union with a small corner square so those corners stay
    # sharp instead of rounded.
    if square and r > 0:
        for name in ('tl', 'tr', 'bl', 'br'):
            if name not in square:
                continue
            if name == 'tl':
                px0, py0 = x0, y0
            elif name == 'tr':
                px0, py0 = x1 - r, y0
            elif name == 'bl':
                px0, py0 = x0, y1 - r
            else:  # br
                px0, py0 = x1 - r, y1 - r
            pcx = px0 + r / 2.0
            pcy = py0 + r / 2.0
            sx = np.abs(xx - pcx) - r / 2.0
            sy = np.abs(yy - pcy) - r / 2.0
            patch = np.minimum(np.maximum(sx, sy), 0.0) + np.sqrt(
                np.maximum(sx, 0.0) ** 2 + np.maximum(sy, 0.0) ** 2
            )
            sdf = np.minimum(sdf, patch)

    if roughness > 0 or waviness > 0:
        perturb = np.zeros((h, w), np.float32)

        # High-frequency fractal noise on a FIXED reference grid, then upscaled.
        # In-place normalization/scaling keeps the full-res footprint to a
        # single accumulator (important for ~28MP native frames in Pyodide).
        if roughness > 0:
            ref = 2048
            fine = np.zeros((h, w), np.float32)
            amp, scale = 1.0, 1
            for _ in range(4):
                nw = max(2, ref // scale)
                nh = max(2, ref // scale)
                n = rng.standard_normal((nh, nw)).astype(np.float32)
                n = cv2.resize(n, (w, h), interpolation=cv2.INTER_LINEAR)
                n *= amp
                fine += n
                amp *= 0.5
                scale *= 2  # 1, 2, 4, 8 px
            cv2.GaussianBlur(fine, (0, 0), 0.8, dst=fine)
            s = float(fine.std())
            if s > 1e-6:
                fine -= float(fine.mean())
                fine /= s
            fine *= roughness
            perturb += fine

        # Low-frequency undulation on a coarse grid: normalize the small grid
        # BEFORE the upscale so we never allocate full-res normalization
        # temporaries. This was the slow path the user hit — the previous
        # version built several full-res float32 arrays at native resolution.
        if waviness > 0:
            cells = 12
            nw = max(2, cells)
            nh = max(2, int(round(cells * h / max(1, w))))
            coarse = rng.standard_normal((nh, nw)).astype(np.float32)
            s = float(coarse.std())
            if s > 1e-6:
                coarse -= float(coarse.mean())
                coarse /= s
            coarse = cv2.resize(coarse, (w, h), interpolation=cv2.INTER_CUBIC)
            coarse *= waviness
            perturb += coarse

        # Per-edge amplitude, computed on a TINY grid (the falloffs are smooth)
        # and upscaled once, so it adds just one full-res temporary.
        if edge_asymmetry > 0:
            amps = 1.0 + edge_asymmetry * rng.uniform(-1.0, 1.0, 4)
            gw = 64
            gh = max(2, int(round(64 * h / max(1, w))))
            wy = np.linspace(0.0, 1.0, gh, dtype=np.float32)
            wx = np.linspace(0.0, 1.0, gw, dtype=np.float32)
            wtop = np.clip(1.0 - wy / 0.6, 0.0, 1.0)
            wbot = np.clip(wy / 0.6, 0.0, 1.0)
            wleft = np.clip(1.0 - wx / 0.6, 0.0, 1.0)
            wright = np.clip(wx / 0.6, 0.0, 1.0)
            denom = (wtop + wbot)[:, None] + (wleft + wright)[None, :] + 1e-6
            wfield = ((amps[0] * wtop + amps[1] * wbot)[:, None]
                      + (amps[2] * wleft + amps[3] * wright)[None, :]) / denom
            wfield = cv2.resize(wfield, (w, h), interpolation=cv2.INTER_LINEAR)
            perturb *= wfield

        sdf += perturb

    # Soft alpha falloff; `feather` is the edge width in pixels. A smoothstep
    # keeps the centre of the transition crisp (like a real film gate) while
    # retaining anti-aliasing at the tails.
    t = np.clip(0.5 - sdf / max(float(feather), 1e-3), 0.0, 1.0)
    alpha = t * t * (3.0 - 2.0 * t)
    mask = (alpha * 255.0 + 0.5).astype(np.uint8)
    return mask


# ---------------------------------------------------------------------------


def _masked_tile(crop, dw, dh, radius_frac, roughness, feather, seed,
                 scale=1.0, radius_jitter=0.0, square_corner_chance=0.0,
                 waviness=0.0, edge_asymmetry=0.0):
    """Resize `crop` to (dw, dh) and return (resized_bgr, float alpha).

    Pixel-sized edge params (roughness, feather, waviness) are scaled by
    `scale` so a downscaled tile looks identical to its native export. This is
    the shared per-tile step used by both `compose_on_white` and
    `compose_merge_on_white`.
    """
    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
    resized = cv2.resize(crop, (dw, dh), interpolation=interp)
    if resized.ndim == 2:
        resized = cv2.cvtColor(resized, cv2.COLOR_GRAY2BGR)

    base_radius = radius_frac * min(dw, dh)
    rng = np.random.default_rng(None if seed is None else seed + 200000)
    if radius_jitter > 0:
        factor = rng.uniform(1.0 - radius_jitter, 1.0 + radius_jitter)
    else:
        factor = 1.0
    radius = max(0, int(round(base_radius * factor)))

    # Sometimes one or two corners are left squared off (not rounded). When
    # two, they are always on the same side (left/right/top/bottom) so the
    # squared corners read as a deliberate, film-lab-like variation.
    square_corners = set()
    if square_corner_chance > 0 and rng.random() < square_corner_chance:
        if rng.random() < 0.5:
            side = rng.choice(['left', 'right', 'top', 'bottom'])
            if side == 'left':
                square_corners = {'tl', 'bl'}
            elif side == 'right':
                square_corners = {'tr', 'br'}
            elif side == 'top':
                square_corners = {'tl', 'tr'}
            else:
                square_corners = {'bl', 'br'}
        else:
            square_corners = {rng.choice(['tl', 'tr', 'bl', 'br'])}

    # roughness/feather/waviness are defined at native scale; scale them so a
    # downscaled output looks the same as native rather than proportionally
    # softer. edge_asymmetry is a ratio, so it is not scaled.
    mask = _organic_mask(dw, dh, radius, roughness * scale, feather * scale,
                         seed, square_corners, waviness * scale,
                         edge_asymmetry)
    alpha = (mask.astype(np.float32) / 255.0)[..., None]
    return resized, alpha


def compose_on_white(crop, size, margin_frac, radius_frac, roughness,
                     feather, seed, radius_jitter=0.0,
                     square_corner_chance=0.0, waviness=0.0,
                     edge_asymmetry=0.0):
    """Place crop on a white canvas.

    size > 0: square `size x size` canvas, crop scaled to fit.
    size == 0: native resolution (no resampling) with a proportional margin.
    """
    ch, cw = crop.shape[:2]
    longest = max(ch, cw)

    if size and size > 0:
        scale = (size * (1.0 - 2.0 * margin_frac)) / longest
        dw = max(1, int(round(cw * scale)))
        dh = max(1, int(round(ch * scale)))
        canvas_w = canvas_h = size
    else:
        scale = 1.0
        dw, dh = cw, ch
        margin_px = int(round(margin_frac * longest))
        canvas_w = dw + 2 * margin_px
        canvas_h = dh + 2 * margin_px

    resized, alpha = _masked_tile(crop, dw, dh, radius_frac, roughness,
                                  feather, seed, scale=scale,
                                  radius_jitter=radius_jitter,
                                  square_corner_chance=square_corner_chance,
                                  waviness=waviness,
                                  edge_asymmetry=edge_asymmetry)

    canvas = np.full((canvas_h, canvas_w, 3), 255, np.uint8)
    ox = (canvas_w - dw) // 2
    oy = (canvas_h - dh) // 2

    roi = canvas[oy:oy + dh, ox:ox + dw]
    blended = resized.astype(np.float32) * alpha + 255.0 * (1.0 - alpha)
    roi[:] = blended.astype(np.uint8)
    return canvas


def _parse_layout(layout, n):
    """Return (rows, cols) for a merge layout string.

    Accepted: 'horizontal'/'h' (1 x n), 'vertical'/'v' (n x 1),
    'grid'/'g' (2 columns), or 'grid:ROWSxCOLS'. Unknown values default to a
    single horizontal row.
    """
    layout = (layout or "horizontal").strip().lower()
    if layout in ("horizontal", "h", "row", "rows"):
        return 1, n
    if layout in ("vertical", "v", "column", "columns", "col", "cols"):
        return n, 1
    if layout in ("grid", "g"):
        cols = 2
        rows = max(1, (n + cols - 1) // cols)
        return rows, cols
    if layout.startswith("grid:") or layout.startswith("g:"):
        spec = layout.split(":", 1)[1]
        if "x" in spec:
            try:
                a, b = spec.split("x", 1)
                rows, cols = int(a), int(b)
            except ValueError:
                rows, cols = 1, n
            rows, cols = max(1, rows), max(1, cols)
            # Grow the grid to fit the tiles if the user asked for too few cells.
            if rows * cols < n:
                rows = (n + cols - 1) // cols
            return rows, cols
    return 1, n


def compose_merge_on_white(crops, *, size, margin_frac, gap_frac, layout,
                           radius_frac, roughness, feather, seed,
                           radius_jitter=0.0, square_corner_chance=0.0,
                           waviness=0.0, edge_asymmetry=0.0,
                           canvas_size=None, tile_params=None):
    """Tile multiple crops onto a single white canvas.

    Each crop is an already-detected/cropped tile (as returned by the per-image
    detect -> crop_with_border step). They are normalized to a common reference
    size so they tile cleanly, then each gets its own organic mask (with a
    per-tile seed) and is pasted with an outer white margin and inner gaps.

    size > 0: the whole collage is scaled so its longest side is `size`.
    size == 0: native — the collage is scaled so its longest side equals a
        single tile's longest side (a merged export matches one image's
        footprint), and is never upscaled.
    gap_frac: spacing between tiles, as a fraction of the common tile size.
    layout: 'horizontal', 'vertical', 'grid', or 'grid:ROWSxCOLS'.
    """
    crops = [c for c in crops if c is not None]
    n = len(crops)
    if tile_params is None:
        tile_params = [{} for _ in range(n)]
    else:
        tile_params = [tp or {} for tp in tile_params]
    if n == 0:
        return np.full((1, 1, 3), 255, np.uint8)
    if n == 1:
        tp0 = tile_params[0]
        return compose_on_white(
            crops[0], size, margin_frac,
            tp0.get('radius_frac', radius_frac),
            tp0.get('roughness', roughness), tp0.get('feather', feather),
            seed, tp0.get('radius_jitter', radius_jitter),
            tp0.get('square_corner_chance', square_corner_chance),
            waviness=tp0.get('waviness', waviness),
            edge_asymmetry=tp0.get('edge_asymmetry', edge_asymmetry))

    rows, cols = _parse_layout(layout, n)
    heights = [c.shape[0] for c in crops]
    widths = [c.shape[1] for c in crops]

    # Reference dimension: the smallest crop extent, so no tile is ever
    # upscaled at --size 0. For a horizontal strip it's the common tile height;
    # for a vertical strip the common width; for a grid the cell height.
    if rows == 1:
        ref = min(heights)
    elif cols == 1:
        ref = min(widths)
    else:
        ref = min(heights)

    gap_px = gap_frac * ref
    margin_px = margin_frac * ref

    # Lay out tiles at reference scale: each tile's (dw, dh) and the overall
    # inner extents. Horizontal/vertical strips vary one dimension; a grid uses
    # uniform cells and contain-fits each tile (contact-sheet look).
    if rows == 1:
        tile_dims = [(int(round(ref * (w / h))), ref)
                     for w, h in zip(widths, heights)]
        inner_w = sum(t[0] for t in tile_dims) + (n - 1) * gap_px
        inner_h = ref
        cell_w = cell_h = None
    elif cols == 1:
        tile_dims = [(ref, int(round(ref * (h / w))))
                     for w, h in zip(widths, heights)]
        inner_w = ref
        inner_h = sum(t[1] for t in tile_dims) + (n - 1) * gap_px
        cell_w = cell_h = None
    else:
        mean_ar = float(np.mean([w / h for w, h in zip(widths, heights)]))
        cell_w = int(round(ref * mean_ar))
        cell_h = int(round(ref))
        inner_w = cols * cell_w + (cols - 1) * gap_px
        inner_h = rows * cell_h + (rows - 1) * gap_px
        tile_dims = []
        for w, h in zip(widths, heights):
            s = min(cell_w / w, cell_h / h)
            tile_dims.append((max(1, int(round(w * s))),
                              max(1, int(round(h * s)))))

    canvas_w0 = inner_w + 2.0 * margin_px
    canvas_h0 = inner_h + 2.0 * margin_px

    # The merged output uses the SAME canvas dimensions as a single export.
    # `canvas_size=(w, h)` (from the caller) wins; otherwise an explicit
    # `size` means a `size x size` square; otherwise (native) the smallest
    # single tile's crop+margin canvas is used. The collage is scaled to fit
    # inside (contain) and centred, so a merged image and a single image are
    # interchangeable in size.
    if canvas_size is not None:
        canvas_w = max(1, int(round(canvas_size[0])))
        canvas_h = max(1, int(round(canvas_size[1])))
        upscale = True
    elif size and size > 0:
        canvas_w = canvas_h = int(size)
        upscale = True
    else:
        ref_crop = min(crops, key=lambda c: max(c.shape[0], c.shape[1]))
        cw_ref, ch_ref = ref_crop.shape[1], ref_crop.shape[0]
        m = margin_frac * max(cw_ref, ch_ref)
        canvas_w = max(1, int(round(cw_ref + 2.0 * m)))
        canvas_h = max(1, int(round(ch_ref + 2.0 * m)))
        upscale = False

    S = min(canvas_w / canvas_w0, canvas_h / canvas_h0)
    if not upscale:
        S = min(1.0, S)  # native fallback never upscales

    # Centre the scaled collage within the target canvas.
    off_x = (canvas_w - canvas_w0 * S) / 2.0
    off_y = (canvas_h - canvas_h0 * S) / 2.0

    canvas = np.full((canvas_h, canvas_w, 3), 255, np.uint8)

    margin_s = margin_px * S
    gap_s = gap_px * S

    # Final per-tile dimensions (rounded once, so placement stays consistent).
    final_dims = [(max(1, int(round(dw * S))), max(1, int(round(dh * S))))
                  for dw, dh in tile_dims]

    def _paste(crop, dw, dh, ox, oy, seed_i, tp):
        r = tp.get('radius_frac', radius_frac)
        ro = tp.get('roughness', roughness)
        fe = tp.get('feather', feather)
        rj = tp.get('radius_jitter', radius_jitter)
        sc = tp.get('square_corner_chance', square_corner_chance)
        wv = tp.get('waviness', waviness)
        ea = tp.get('edge_asymmetry', edge_asymmetry)
        scale = dw / crop.shape[1] if crop.shape[1] else 1.0
        resized, alpha = _masked_tile(crop, dw, dh, r, ro, fe, seed_i,
                                      scale=scale, radius_jitter=rj,
                                      square_corner_chance=sc, waviness=wv,
                                      edge_asymmetry=ea)
        x0, y0 = max(0, ox), max(0, oy)
        x1, y1 = min(canvas_w, ox + dw), min(canvas_h, oy + dh)
        if x1 <= x0 or y1 <= y0:
            return
        pw, ph = x1 - x0, y1 - y0
        roi = canvas[y0:y1, x0:x1]
        res = resized[0:ph, 0:pw]
        al = alpha[0:ph, 0:pw]
        roi[:] = (res.astype(np.float32) * al
                  + 255.0 * (1.0 - al)).astype(np.uint8)

    if rows == 1 or cols == 1:
        pos = off_x + margin_s if rows == 1 else off_y + margin_s
        for i, crop in enumerate(crops):
            dw, dh = final_dims[i]
            if rows == 1:
                ox, oy = int(round(pos)), int(round(off_y + margin_s))
            else:
                ox, oy = int(round(off_x + margin_s)), int(round(pos))
            seed_i = None if seed is None else seed + i * MERGE_SEED_STRIDE
            _paste(crop, dw, dh, ox, oy, seed_i, tile_params[i])
            pos += (dw if rows == 1 else dh) + gap_s
    else:
        for i, crop in enumerate(crops):
            col, row = i % cols, i // cols
            cell_x = off_x + margin_s + col * (cell_w * S + gap_s)
            cell_y = off_y + margin_s + row * (cell_h * S + gap_s)
            dw, dh = final_dims[i]
            ox = int(round(cell_x + (cell_w * S - dw) / 2.0))
            oy = int(round(cell_y + (cell_h * S - dh) / 2.0))
            seed_i = None if seed is None else seed + i * MERGE_SEED_STRIDE
            _paste(crop, dw, dh, ox, oy, seed_i, tile_params[i])

    return canvas


def process_merge(images, *, size, margin, border, radius, roughness, feather,
                  seed, sprocket_chance, gap=0.03, layout="vertical",
                  radius_jitter=0.0, square_corner_chance=0.0,
                  border_jitter=0.0, max_sprocket_border=0.03,
                  waviness=0.0, edge_asymmetry=0.0,
                  canvas_size=None, per_image=None):
    """Run the full pipeline on several images, tiled onto one white canvas.

    `per_image` optionally lists per-tile overrides (same length as `images`):
    dicts whose keys override the global params for that tile (border, radius,
    roughness, feather, seed, sprocket_chance, radius_jitter,
    square_corner_chance, border_jitter, max_sprocket_border, offsets, and
    gate/sprocket overrides). This lets each tile in a merge be tweaked
    independently. Returns the final BGR canvas.
    """
    if per_image is None:
        per_image = [{} for _ in images]
    tiles = []
    tile_params = []
    for i, img in enumerate(images):
        if img is None:
            continue
        ov = per_image[i] if i < len(per_image) and per_image[i] else {}
        portrait = img.shape[0] > img.shape[1]
        if portrait:
            img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        left, top, right, bot = (ov['gate_override'] if ov.get('gate_override')
                                 is not None else detect_gate(gray))
        seed_i = ov.get('seed', seed)
        crop_seed = None if seed_i is None else (
            seed_i + i * MERGE_SEED_STRIDE + 100000)
        sprocket_edges = (ov['sprocket_override']
                          if ov.get('sprocket_override') is not None
                          else _sprocket_inner_edges(gray))
        cl, ct, cr, cb = crop_with_border(
            gray, left, top, right, bot,
            ov.get('border', border),
            ov.get('sprocket_chance', sprocket_chance),
            crop_seed,
            ov.get('border_jitter', border_jitter),
            ov.get('max_sprocket_border', max_sprocket_border),
            sprocket_override=sprocket_edges)
        cl, ct, cr, cb = _nudge_crop(
            cl, ct, cr, cb,
            ov.get('offset_left', 0.0), ov.get('offset_top', 0.0),
            ov.get('offset_right', 0.0), ov.get('offset_bottom', 0.0),
            img.shape[1], img.shape[0])
        tile = img[ct:cb, cl:cr]
        if portrait:
            tile = cv2.rotate(tile, cv2.ROTATE_90_COUNTERCLOCKWISE)
        tiles.append(tile)
        tile_params.append({
            'radius_frac': ov.get('radius', radius),
            'roughness': ov.get('roughness', roughness),
            'feather': ov.get('feather', feather),
            'radius_jitter': ov.get('radius_jitter', radius_jitter),
            'square_corner_chance': ov.get('square_corner_chance',
                                           square_corner_chance),
            'waviness': ov.get('waviness', waviness),
            'edge_asymmetry': ov.get('edge_asymmetry', edge_asymmetry),
        })

    return compose_merge_on_white(
        tiles, size=size, margin_frac=margin, gap_frac=gap, layout=layout,
        radius_frac=radius, roughness=roughness, feather=feather, seed=seed,
        radius_jitter=radius_jitter,
        square_corner_chance=square_corner_chance,
        waviness=waviness, edge_asymmetry=edge_asymmetry,
        canvas_size=canvas_size, tile_params=tile_params)


# ---------------------------------------------------------------------------
# In-memory processing (shared by the CLI client and the browser client)
# ---------------------------------------------------------------------------

@dataclass
class ProcessResult:
    """Result of process_image().

    `image` is always in the *original* orientation (portrait scans are
    rotated back to portrait). `debug_image` is optional and likewise already
    rotated back. Rectangles are expressed in landscape (pre-rotation)
    coordinates, matching the CLI's historical log output.
    """
    image: np.ndarray
    debug_image: Optional[np.ndarray] = None
    gate_rect: Optional[tuple] = None    # (left, top, right, bottom)
    crop_rect: Optional[tuple] = None    # (cl, ct, cr, cb)
    plain_rect: Optional[tuple] = None   # (cl, ct, cr, cb) for --plain
    sprocket_edges: Optional[tuple] = None  # (top_sprocket_bottom, bottom_sprocket_top)


def process_image(img, *, size, margin, border, radius, roughness, feather,
                  seed, sprocket_chance, radius_jitter=0.0,
                  square_corner_chance=0.0, border_jitter=0.0,
                  max_sprocket_border=0.03, offset_left=0.0, offset_right=0.0,
                  offset_top=0.0, offset_bottom=0.0, plain=False, debug=False,
                  waviness=0.0, edge_asymmetry=0.0,
                  gate_override=None, sprocket_override=None):
    """Run the full pipeline on an in-memory BGR image.

    This is the entire body of the CLI's `process()` minus file IO and
    printing. It is what both the CLI client and the browser client call.
    """
    # Portrait scans are the same film strip rotated 90 degrees. The detector
    # expects a landscape strip (sprocket holes along the top/bottom), so we
    # rotate in memory, process as usual, then rotate the output back.
    portrait = img.shape[0] > img.shape[1]
    if portrait:
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    if plain:
        if gate_override is not None:
            left, top, right, bot = gate_override
            gate_h = bot - top
            inset = max(8, int(round(gate_h * 0.004)))
            left, top, right, bot = (left + inset, top + inset,
                                     right - inset, bot - inset)
        else:
            left, top, right, bot = detect_photo_gate(gray)
        cl = max(0, int(round(left)))
        cr = min(img.shape[1], int(round(right)))
        ct = max(0, int(round(top)))
        cb = min(img.shape[0], int(round(bot)))
        cl, ct, cr, cb = _nudge_crop(cl, ct, cr, cb, offset_left, offset_top,
                                     offset_right, offset_bottom,
                                     img.shape[1], img.shape[0])
        crop = img[ct:cb, cl:cr]
        if portrait:
            crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
        return ProcessResult(image=crop, plain_rect=(cl, ct, cr, cb))

    left, top, right, bot = (gate_override if gate_override is not None
                             else detect_gate(gray))
    crop_seed = None if seed is None else seed + 100000
    sprocket_edges = (sprocket_override if sprocket_override is not None
                      else _sprocket_inner_edges(gray))
    cl, ct, cr, cb = crop_with_border(gray, left, top, right, bot, border,
                                      sprocket_chance, crop_seed, border_jitter,
                                      max_sprocket_border,
                                      sprocket_override=sprocket_edges)

    # Manual per-side nudge, applied to the FINAL crop window (after the
    # border / jitter / sprocket logic), so each flag moves exactly one edge
    # and nothing else — fully deterministic, unaffected by --seed or
    # --border-jitter. Positive reveals more, negative trims inward.
    cl, ct, cr, cb = _nudge_crop(cl, ct, cr, cb, offset_left, offset_top,
                                 offset_right, offset_bottom,
                                 img.shape[1], img.shape[0])

    debug_image = None
    if debug:
        dbg = img.copy()
        cv2.rectangle(dbg, (int(left), int(top)), (int(right), int(bot)),
                      (0, 255, 0), 6)
        cv2.rectangle(dbg, (cl, ct), (cr, cb), (0, 0, 255), 6)
        if portrait:
            dbg = cv2.rotate(dbg, cv2.ROTATE_90_COUNTERCLOCKWISE)
        debug_image = dbg

    crop = img[ct:cb, cl:cr]
    result = compose_on_white(crop, size, margin, radius, roughness,
                              feather, seed, radius_jitter,
                              square_corner_chance, waviness, edge_asymmetry)
    if portrait:
        result = cv2.rotate(result, cv2.ROTATE_90_COUNTERCLOCKWISE)

    return ProcessResult(image=result, debug_image=debug_image,
                         gate_rect=(left, top, right, bot),
                         crop_rect=(cl, ct, cr, cb),
                         sprocket_edges=sprocket_edges)


# ---------------------------------------------------------------------------
# Pixel <-> bytes (shared encode/decode path for CLI and browser)
# ---------------------------------------------------------------------------

def decode_image(data):
    """Decode an encoded image (JPEG/PNG/...) into a BGR numpy array."""
    buf = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("cannot decode image data")
    return img


def encode_image(img, ext, quality=None):
    """Encode a BGR numpy array to bytes (JPEG honours `quality`).

    ext is the file extension including the dot (e.g. '.jpg', '.png').
    """
    if quality is None or ext.lower() in (".png", ".bmp", ".tif", ".tiff"):
        ok, buf = cv2.imencode(ext, img)
    else:
        ok, buf = cv2.imencode(ext, img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise ValueError(f"cannot encode image as {ext}")
    return buf.tobytes()
