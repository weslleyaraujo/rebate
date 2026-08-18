#!/opt/homebrew/bin/python3.11
"""
Film border scanner.

Takes DSLR scans of 35mm film shot "with full sprockets" (already-positive,
i.e. inverted) and crops the real film frame together with its natural film
border (rebate), rounds the corners slightly, and composites the result onto
a white canvas.

Why "natural": instead of drawing a fake border, we use the actual unexposed
film border that is already present in the scan.

Usage:
    python3 border_crop.py INPUT... [--out DIR] [options]

Examples:
    python3 border_crop.py SAMPLE.jpg
    python3 border_crop.py Leica_*.jpg --out ./out --size 3000 --border 0.015
"""

import argparse
import os
import sys

import cv2
import numpy as np

# 35mm full-frame is 36 x 24 mm -> 3:2 aspect ratio.
ASPECT = 1.5
# Sprocket hole pitch for 35mm film (4.75 mm). We learn it in pixels per image.
SPROCKET_PITCH_FALLBACK = 730


def _row_hstd(gray, scale=10):
    """Horizontal std per row on a downscaled copy (sprocket bands have high
    horizontal variance; the thin uniform rebate at the gate edge has low)."""
    h, w = gray.shape
    small = cv2.resize(gray, (max(1, w // scale), max(1, h // scale)),
                       interpolation=cv2.INTER_AREA)
    hstd = small.std(axis=1).astype(np.float64)
    hstd = np.convolve(hstd, np.ones(3) / 3, mode="same")
    return hstd, scale


def _refine_row(gray, y0, radius=60):
    """Refine a gate edge estimate at full resolution by minimising row std."""
    h, _ = gray.shape
    lo, hi = max(0, y0 - radius), min(h, y0 + radius)
    best, best_v = y0, float("inf")
    for y in range(lo, hi):
        v = float(gray[y, :].std())
        if v < best_v:
            best_v, best = v, y
    return best


def _sprocket_candidates(gray):
    """Return (top_holes, bottom_holes) candidate sprocket holes.

    Sprocket holes are bright, medium-sized, roughly oval blobs. They live at
    the very top and bottom of the film strip (outside the 24mm gate area).
    We look only in those two horizontal bands and use an adaptive brightness
    threshold so dark scans still work.
    """
    h, w = gray.shape
    top, bot = [], []
    # 35mm film: the 24mm gate occupies the middle ~69% of the 35mm strip,
    # sprocket holes sit in the outer ~10% on each edge.
    for is_top, (y_lo, y_hi) in ((True, (0, int(h * 0.16))),
                                 (False, (int(h * 0.88), h))):
        band = gray[y_lo:y_hi, :]
        if band.size == 0:
            continue
        # Adaptive threshold: sprocket holes are the bright tail of the band.
        thresh = float(np.percentile(band, 99.0))
        thresh = max(50.0, min(140.0, thresh * 0.6))
        bright = (band > thresh).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(bright, 8)
        for i in range(1, n):
            x, y, cw, ch, area = stats[i]
            if area < 3000 or area > 250000:
                continue
            if cw < 150 or cw > 650 or ch < 250 or ch > 700:
                continue
            if ch < cw * 0.6:
                continue
            hl = {"cx": x + cw // 2, "cy": y_lo + y + ch // 2,
                  "y": int(y_lo + y), "ch": int(ch), "cw": int(cw)}
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


def _gate_from_sprockets(gray):
    """Detect gate top/bottom/center from the periodic sprocket holes.

    Returns (top, bottom, center_x) or None if undetectable.
    """
    top_cand, bot_cand = _sprocket_candidates(gray)
    if len(top_cand) < 3 or len(bot_cand) < 3:
        return None

    top_aligned = _grid_aligned(top_cand)
    bot_aligned = _grid_aligned(bot_cand)
    if len(top_aligned) < 3 or len(bot_aligned) < 3:
        return None

    top = max(hl["y"] + hl["ch"] for hl in top_aligned)
    bot = min(hl["y"] for hl in bot_aligned)

    # Horizontal centre: midpoint of the detected hole run is robust to a few
    # missed holes (the median is not). Use top/bottom independently and pick
    # the one closest to the (roughly centred) image centre.
    h, w = gray.shape
    cx_top = (min(h["cx"] for h in top_aligned)
              + max(h["cx"] for h in top_aligned)) / 2.0
    cx_bot = (min(h["cx"] for h in bot_aligned)
              + max(h["cx"] for h in bot_aligned)) / 2.0
    center_x = min((cx_top, cx_bot), key=lambda c: abs(c - w / 2.0))
    return top, bot, center_x


def _gate_from_hstd(gray):
    """Fallback gate detection using the horizontal-std dip at the gate edge."""
    h, w = gray.shape
    hstd, scale = _row_hstd(gray)
    t0, t1 = int(h * 0.05), int(h * 0.25)
    b0, b1 = int(h * 0.75), int(h * 0.95)
    top = t0 + int(np.argmin(hstd[t0 // scale:t1 // scale])) * scale
    bot = b0 + int(np.argmin(hstd[b0 // scale:b1 // scale])) * scale
    top = _refine_row(gray, top)
    bot = _refine_row(gray, bot)
    return top, bot


def detect_gate(gray):
    """Return (left, top, right, bottom) of the exposed film frame (gate)."""
    h, w = gray.shape

    # Primary: geometry from the periodic sprocket holes.
    sprocket = _gate_from_sprockets(gray)
    if sprocket is not None:
        top, bot, center_x = sprocket
        gate_h = bot - top
        # Sanity: a 35mm full-frame gate is 3:2 and its height is consistent.
        if 3200 <= gate_h <= 4200 and w * 0.45 <= center_x <= w * 0.55:
            gate_w = gate_h * ASPECT
            left = center_x - gate_w / 2.0
            right = center_x + gate_w / 2.0
            return left, top, right, bot

    # Fallback: hstd dip for top/bottom, sprocket grid for centre.
    top, bot = _gate_from_hstd(gray)
    gate_h = bot - top
    gate_w = gate_h * ASPECT
    center_x = _detect_center_x(gray, top, bot)
    left = center_x - gate_w / 2.0
    right = center_x + gate_w / 2.0
    return left, top, right, bot


def _row_profile(gray, y0, y1):
    """Median and median-absolute-deviation per row (robust to sprocket dots)."""
    meds = []
    mads = []
    for y in range(y0, y1):
        row = gray[y, :].astype(np.float32)
        med = float(np.median(row))
        meds.append(med)
        mads.append(float(np.median(np.abs(row - med))))
    return np.array(meds), np.array(mads)


def _photo_edge_top(gray, ts_bot):
    """Find the actual photo top edge just below the top sprocket holes."""
    h, w = gray.shape
    t0 = int(ts_bot) + 2
    t1 = min(h, t0 + 130)
    if t1 - t0 < 25:
        return None
    meds, mads = _row_profile(gray, t0, t1)
    med_base = float(np.percentile(meds, 15))
    mad_base = float(np.percentile(mads, 15))
    med_thr = med_base + max(6.0, 0.5 * med_base)
    mad_thr = mad_base + max(3.0, 0.8 * mad_base)
    idx = np.where((meds > med_thr) | (mads > mad_thr))[0]
    if len(idx) == 0 or idx[0] > 110:
        return None
    return t0 + int(idx[0])


def _photo_edge_bot(gray, bs_top):
    """Find the actual photo bottom edge just above the bottom sprocket holes."""
    h, w = gray.shape
    b1 = int(bs_top) - 2
    b0 = max(0, b1 - 130)
    if b1 - b0 < 25:
        return None
    meds, mads = _row_profile(gray, b0, b1)
    med_base = float(np.percentile(meds, 15))
    mad_base = float(np.percentile(mads, 15))
    med_thr = med_base + max(6.0, 0.5 * med_base)
    mad_thr = mad_base + max(3.0, 0.8 * mad_base)
    idx = np.where((meds > med_thr) | (mads > mad_thr))[0]
    if len(idx) == 0 or (len(meds) - 1 - idx[-1]) > 110:
        return None
    return b0 + int(idx[-1])


def detect_photo_gate(gray):
    """Return (left, top, right, bottom) of the actual photo (no rebate).

    Finds the real exposed-image boundary (brightness/texture step) and then
    trims a small safety margin inside it so no unexposed film border remains.
    """
    h, w = gray.shape
    ts_bot, bs_top = _sprocket_inner_edges(gray)

    if ts_bot is not None and bs_top is not None:
        top = _photo_edge_top(gray, ts_bot)
        bot = _photo_edge_bot(gray, bs_top)
        # Calibrated fallback: the unexposed border between sprockets and gate
        # is ~44-70px in this rig. Err toward over-cropping (no border).
        if top is None:
            top = ts_bot + 60
        if bot is None:
            bot = bs_top - 64
        inset = 15
    else:
        # Sprocket detection failed (very dark scan): use the hstd edges with
        # a generous inset so the unexposed border is definitely removed.
        top, bot = _gate_from_hstd(gray)
        inset = 40

    if (bot - top) < 3400:
        return detect_gate(gray)

    top += inset
    bot -= inset

    gate_h = bot - top
    gate_w = gate_h * ASPECT
    center_x = _detect_center_x(gray, top, bot)
    left = center_x - gate_w / 2.0 + inset
    right = center_x + gate_w / 2.0 - inset
    return left, top, right, bot


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

    aligned = _grid_aligned([{"cx": x} for x in holes])
    if len(aligned) < 6:
        return w / 2.0

    cx = float(np.median([h["cx"] for h in aligned]))
    if w * 0.47 <= cx <= w * 0.53:
        return cx
    return w / 2.0


def _sprocket_inner_edges(gray):
    """Return (top_sprocket_bottom, bottom_sprocket_top) from the grid-aligned
    sprocket holes, or (None, None) if undetectable."""
    res = _gate_from_sprockets(gray)
    if res is None:
        return None, None
    ts_bot, bs_top, _ = res
    return ts_bot, bs_top


def crop_with_border(gray, left, top, right, bot, border_frac,
                     sprocket_chance, seed):
    """Expand the gate by border_frac * gate_height.

    On top and bottom independently, the crop randomly either stops just
    inside the sprocket holes (clean) or dips a small, random amount into them
    so a tiny sliver of sprocket is sometimes visible on that side.
    """
    h, w = gray.shape
    gate_h = bot - top
    pad = border_frac * gate_h

    crop_top = max(0, int(round(top - pad)))
    crop_bot = min(h, int(round(bot + pad)))
    crop_left = max(0, int(round(left - pad)))
    crop_right = min(w, int(round(right + pad)))

    ts_bot, bs_top = _sprocket_inner_edges(gray)
    rng = np.random.default_rng(seed)

    if ts_bot is not None:
        if rng.random() < sprocket_chance:
            dip = rng.uniform(0.002, 0.012) * gate_h
            crop_top = max(0, int(round(ts_bot - dip)))
        else:
            crop_top = max(crop_top, int(ts_bot) + 4)

    if bs_top is not None:
        if rng.random() < sprocket_chance:
            dip = rng.uniform(0.002, 0.012) * gate_h
            crop_bot = min(h, int(round(bs_top + dip)))
        else:
            crop_bot = min(crop_bot, int(bs_top) - 4)

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
                     feather, seed, radius_jitter=0.25):
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
    mask = _organic_mask(dw, dh, radius, roughness, feather, seed)

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
            radius_jitter, plain=False, debug=False, suffix=".bordered.jpg"):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        print(f"!! cannot read {path}", file=sys.stderr)
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    if plain:
        left, top, right, bot = detect_photo_gate(gray)
        cl = max(0, int(round(left)))
        cr = min(img.shape[1], int(round(right)))
        ct = max(0, int(round(top)))
        cb = min(img.shape[0], int(round(bot)))
        crop = img[ct:cb, cl:cr]
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
                                      sprocket_chance, crop_seed)

    if debug:
        dbg = img.copy()
        cv2.rectangle(dbg, (int(left), int(top)), (int(right), int(bot)),
                      (0, 255, 0), 6)
        cv2.rectangle(dbg, (cl, ct), (cr, cb), (0, 0, 255), 6)
        out_dbg = os.path.join(out_dir,
                               os.path.splitext(os.path.basename(path))[0]
                               + ".debug.jpg")
        cv2.imwrite(out_dbg, dbg)
        print(f"    debug -> {out_dbg}")

    crop = img[ct:cb, cl:cr]
    result = compose_on_white(crop, size, margin_frac, radius_frac, roughness,
                              feather, seed, radius_jitter)

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
    ap = argparse.ArgumentParser(description="Film border cropper")
    ap.add_argument("inputs", nargs="+", help="input image files")
    ap.add_argument("--out", default=".", help="output directory")
    ap.add_argument("--size", type=int, default=0,
                    help="canvas size (square); 0 = native resolution, no "
                         "resampling (default 0)")
    ap.add_argument("--margin", type=float, default=0.05,
                    help="white margin around crop (fraction; default 0.05)")
    ap.add_argument("--border", type=float, default=0.012,
                    help="film border to include around the gate as fraction "
                         "of gate height (default 0.012)")
    ap.add_argument("--radius", type=float, default=0.015,
                    help="corner radius as fraction of the final crop size "
                         "(default 0.015)")
    ap.add_argument("--radius-jitter", type=float, default=0.25,
                    help="random +/- variation of the corner radius, as a "
                         "fraction (default 0.25)")
    ap.add_argument("--roughness", type=float, default=0.5,
                    help="edge irregularity in px (0 = perfectly straight; "
                         "default 0.5)")
    ap.add_argument("--feather", type=float, default=2.5,
                    help="edge softness in px (default 2.5)")
    ap.add_argument("--seed", type=int, default=None,
                    help="random seed for edge texture (default: random)")
    ap.add_argument("--quality", type=int, default=98,
                    help="JPEG quality 1-100 (default 98)")
    ap.add_argument("--sprocket-chance", type=float, default=0.5,
                    help="probability (0-1) that a tiny sliver of sprocket "
                         "holes is visible, per side (top/bottom) "
                         "(default 0.5)")
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
                args.plain, args.debug, args.suffix)


if __name__ == "__main__":
    main()
