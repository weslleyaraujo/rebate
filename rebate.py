#!/opt/homebrew/bin/python3.11
"""
rebate — film border scanner.

Takes DSLR scans of 35mm film shot "with full sprockets" (already-positive,
i.e. inverted) and crops the real film frame together with its natural film
border (the rebate), rounds the corners slightly, and composites the result
onto a white canvas.

Why "natural": instead of drawing a fake border, we use the actual unexposed
film border that is already present in the scan.

Usage:
    python3 rebate.py INPUT... [--out DIR] [options]

Examples:
    python3 rebate.py SAMPLE.jpg
    python3 rebate.py Leica_*.jpg --out ./out --size 3000 --border 0.015
"""

import argparse
import os
import sys

import cv2
import numpy as np

# 35mm full-frame is 36 x 24 mm -> 3:2 aspect ratio.
ASPECT = 1.5
# Physical 35mm still-film dimensions (mm). These are the scale-invariant
# anchors: whatever the scan resolution, the gate is 24 mm tall and the
# sprocket pitch is 4.75 mm (the 36 mm width follows from the 3:2 aspect).
GATE_H_MM = 24.0
SPROCKET_PITCH_MM = 4.75
# Fallback sprocket pitch in pixels (only used by _grid_aligned).
SPROCKET_PITCH_FALLBACK = 730


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
    # fraction of the strip height. Rejects pitch aliasing (e.g. pitch/2).
    gate_h_px = pitch * (GATE_H_MM / SPROCKET_PITCH_MM)
    h = gray.shape[0]
    if not (0.4 * h <= gate_h_px <= 0.9 * h):
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
    above = [r for r in runs if r[1] < photo[0]]
    if above:
        ts_bot = above[-1][1]
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


def crop_with_border(gray, left, top, right, bot, border_frac,
                     sprocket_chance, seed, border_jitter=0.0):
    """Expand the gate by border_frac * gate_height, with two sources of
    randomness so no two crops look alike:

    - border_jitter: the whole crop window is shifted relative to the fixed
      photo (size unchanged), so the black rebate is bigger on a random side
      while the photo stays put.
    - sprocket sliver: on at most ONE side (top or bottom), the crop dips a
      small, random amount into the sprocket holes. Only used when the rebate
      between the photo and that sprocket band is thin.
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

    ts_bot, bs_top = _sprocket_inner_edges(gray)

    top_ok = ts_bot is not None and 0 < top - ts_bot < 0.04 * gate_h
    bot_ok = bs_top is not None and 0 < bs_top - bot < 0.04 * gate_h

    # Clean-clamp each eligible side to just inside its sprocket band first...
    if top_ok:
        crop_top = max(crop_top, int(ts_bot) + 4)
    if bot_ok:
        crop_bot = min(crop_bot, int(bs_top) - 4)

    # ...then dip at most ONE eligible side into the holes.
    if top_ok or bot_ok:
        if rng.random() < sprocket_chance:
            dip = rng.uniform(0.0002, 0.001) * gate_h
            if top_ok and bot_ok:
                dip_top = rng.random() < 0.5
            else:
                dip_top = top_ok
            if dip_top:
                crop_top = max(0, int(round(ts_bot - dip)))
            else:
                crop_bot = min(h, int(round(bs_top + dip)))

    return crop_left, crop_top, crop_right, crop_bot


def _rounded_mask(w, h, radius, inset=0):
    """Rounded-rectangle mask, optionally inset from the image boundary."""
    inset = max(0, int(inset))
    if inset * 2 >= w or inset * 2 >= h:
        return np.zeros((h, w), np.uint8)
    mask = np.zeros((h, w), np.uint8)
    r = max(0, min(int(radius), (w - 2 * inset) // 2, (h - 2 * inset) // 2))
    x0, y0 = inset, inset
    x1, y1 = w - inset - 1, h - inset - 1
    if r <= 0:
        cv2.rectangle(mask, (x0, y0), (x1, y1), 255, -1)
    else:
        cv2.rectangle(mask, (x0 + r, y0), (x1 - r, y1), 255, -1)
        cv2.rectangle(mask, (x0, y0 + r), (x1, y1 - r), 255, -1)
        cv2.circle(mask, (x0 + r, y0 + r), r, 255, -1)
        cv2.circle(mask, (x1 - r, y0 + r), r, 255, -1)
        cv2.circle(mask, (x0 + r, y1 - r), r, 255, -1)
        cv2.circle(mask, (x1 - r, y1 - r), r, 255, -1)
    return mask


def _organic_mask(w, h, radius, roughness, feather, seed):
    """Rounded-rect mask with slightly irregular, soft edges.

    The mask is inset a few pixels and its outline is perturbed by
    low-frequency noise (roughness, px) and then feathered (px), so edges are
    soft and slightly wavy rather than perfectly straight, like a real scanned
    film edge.
    """
    inset = int(round(2.0 * roughness + feather)) + 2
    base = _rounded_mask(w, h, radius, inset)
    mask = base.astype(np.float32)

    if roughness > 0:
        rng = np.random.default_rng(seed)
        # Fractal noise (a few octaves) looks organic, not digital.
        total = np.zeros((h, w), np.float32)
        amp, scale = 1.0, 20
        for _ in range(3):
            nw, nh = max(2, w // scale), max(2, h // scale)
            n = rng.standard_normal((nh, nw)).astype(np.float32)
            n = cv2.resize(n, (w, h), interpolation=cv2.INTER_LINEAR)
            total += amp * n
            amp *= 0.5
            scale *= 2
        total = cv2.GaussianBlur(total, (0, 0), 1.0)
        if float(total.std()) > 1e-6:
            total = (total - total.mean()) / total.std()
        total = np.clip(total, -2.0, 2.0)
        dist_in = cv2.distanceTransform(base, cv2.DIST_L2, 5)
        dist_out = cv2.distanceTransform(255 - base, cv2.DIST_L2, 5)
        signed = dist_in - dist_out
        signed = signed + roughness * total
        mask = (signed > 0).astype(np.float32) * 255.0

    if feather > 0:
        mask = cv2.GaussianBlur(mask, (0, 0), feather)
    return mask.astype(np.uint8)


def compose_on_white(crop, size, margin_frac, radius_frac, roughness,
                     feather, seed, radius_jitter=0.0):
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
    # roughness/feather are defined at native scale; scale them so a downscaled
    # output looks the same as native rather than proportionally softer.
    mask = _organic_mask(dw, dh, radius, roughness * scale, feather * scale,
                         seed)

    canvas = np.full((canvas_h, canvas_w, 3), 255, np.uint8)
    ox = (canvas_w - dw) // 2
    oy = (canvas_h - dh) // 2

    alpha = (mask.astype(np.float32) / 255.0)[..., None]
    roi = canvas[oy:oy + dh, ox:ox + dw]
    blended = resized.astype(np.float32) * alpha + 255.0 * (1.0 - alpha)
    roi[:] = blended.astype(np.uint8)
    return canvas


def process(path, out_dir, size, margin_frac, border_frac, radius_frac,
            roughness, feather, seed, quality, sprocket_chance,
            radius_jitter, border_jitter, plain=False, debug=False,
            suffix=".bordered.jpg"):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        print(f"!! cannot read {path}", file=sys.stderr)
        return None

    # Portrait scans are the same film strip rotated 90 degrees. The detector
    # expects a landscape strip (sprocket holes along the top/bottom), so we
    # rotate in memory, process as usual, then rotate the output back. The
    # source file is never modified.
    portrait = img.shape[0] > img.shape[1]
    if portrait:
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    if plain:
        left, top, right, bot = detect_photo_gate(gray)
        cl = max(0, int(round(left)))
        cr = min(img.shape[1], int(round(right)))
        ct = max(0, int(round(top)))
        cb = min(img.shape[0], int(round(bot)))
        crop = img[ct:cb, cl:cr]
        if portrait:
            crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
        out_name = os.path.splitext(os.path.basename(path))[0] + suffix
        out_path = os.path.join(out_dir, out_name)
        if out_name.lower().endswith(".png"):
            cv2.imwrite(out_path, crop)
        else:
            cv2.imwrite(out_path, crop, [cv2.IMWRITE_JPEG_QUALITY, quality])
        print(f"  {os.path.basename(path)}")
        print(f"    photo x[{cl}..{cr}] y[{ct}..{cb}] "
              f"({cr-cl}x{cb-ct}, ratio {(cr-cl)/(cb-ct):.2f}) -> {out_path}")
        return out_path

    left, top, right, bot = detect_gate(gray)
    crop_seed = None if seed is None else seed + 100000
    cl, ct, cr, cb = crop_with_border(gray, left, top, right, bot, border_frac,
                                      sprocket_chance, crop_seed, border_jitter)

    if debug:
        dbg = img.copy()
        cv2.rectangle(dbg, (int(left), int(top)), (int(right), int(bot)),
                      (0, 255, 0), 6)
        cv2.rectangle(dbg, (cl, ct), (cr, cb), (0, 0, 255), 6)
        if portrait:
            dbg = cv2.rotate(dbg, cv2.ROTATE_90_COUNTERCLOCKWISE)
        out_dbg = os.path.join(out_dir,
                               os.path.splitext(os.path.basename(path))[0]
                               + ".debug.jpg")
        cv2.imwrite(out_dbg, dbg)
        print(f"    debug -> {out_dbg}")

    crop = img[ct:cb, cl:cr]
    result = compose_on_white(crop, size, margin_frac, radius_frac, roughness,
                              feather, seed, radius_jitter)
    if portrait:
        result = cv2.rotate(result, cv2.ROTATE_90_COUNTERCLOCKWISE)

    out_name = os.path.splitext(os.path.basename(path))[0] + suffix
    out_path = os.path.join(out_dir, out_name)
    if out_name.lower().endswith(".png"):
        cv2.imwrite(out_path, result)
    else:
        cv2.imwrite(out_path, result, [cv2.IMWRITE_JPEG_QUALITY, quality])

    gate_w = right - left
    gate_h = bot - top
    print(f"  {os.path.basename(path)}")
    print(f"    gate  x[{left:.0f}..{right:.0f}] y[{top:.0f}..{bot:.0f}] "
          f"({gate_w:.0f}x{gate_h:.0f}, ratio {gate_w/gate_h:.2f})")
    print(f"    crop  x[{cl}..{cr}] y[{ct}..{cb}] -> {out_path}")
    return out_path


def main():
    ap = argparse.ArgumentParser(description="rebate — film border cropper")
    ap.add_argument("inputs", nargs="+", help="input image files")
    ap.add_argument("--out", default=".", help="output directory")
    ap.add_argument("--size", type=int, default=0,
                    help="canvas size (square); 0 = native resolution, no "
                         "resampling (default 0)")
    ap.add_argument("--margin", type=float, default=0.05,
                    help="white margin around crop (fraction; default 0.05)")
    ap.add_argument("--border", type=float, default=0.015,
                    help="film border to include around the gate as fraction "
                         "of gate height (default 0.015)")
    ap.add_argument("--radius", type=float, default=0.015,
                    help="corner radius as fraction of the final crop size "
                         "(default 0.015)")
    ap.add_argument("--radius-jitter", type=float, default=0.0,
                    help="random +/- variation of the corner radius, as a "
                         "fraction (0 = fixed corners; default 0)")
    ap.add_argument("--border-jitter", type=float, default=0.6,
                    help="random shift of the black film border, as a "
                         "fraction of the border thickness (0 = perfectly "
                         "even; default 0.6)")
    ap.add_argument("--roughness", type=float, default=0.5,
                    help="edge irregularity in px (0 = perfectly straight; "
                         "default 0.5)")
    ap.add_argument("--feather", type=float, default=3.0,
                    help="edge softness in px (default 3.0)")
    ap.add_argument("--seed", type=int, default=None,
                    help="random seed for edge texture (default: random)")
    ap.add_argument("--quality", type=int, default=100,
                    help="JPEG quality 1-100 (default 100)")
    ap.add_argument("--sprocket-chance", type=float, default=0.7,
                    help="probability (0-1) that a tiny sliver of sprocket "
                         "holes is visible on at most one side (top or "
                         "bottom) (default 0.7)")
    ap.add_argument("--plain", action="store_true",
                    help="crop just the 3:2 image with no border and no white "
                         "canvas")
    ap.add_argument("--debug", action="store_true",
                    help="also save an annotated debug image")
    ap.add_argument("--suffix", default=".bordered.jpg",
                    help="output filename suffix (default .bordered.jpg)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    for path in args.inputs:
        process(path, args.out, args.size, args.margin, args.border,
                args.radius, args.roughness, args.feather, args.seed,
                args.quality, args.sprocket_chance, args.radius_jitter,
                args.border_jitter, args.plain, args.debug, args.suffix)


if __name__ == "__main__":
    main()
