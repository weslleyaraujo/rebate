"""Core tests for rebate (film border scanner).

Run with:
    /opt/homebrew/bin/python3.11 -m unittest discover -s tests -p 'test_*.py'
"""

import argparse
import os
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import rebate  # noqa: E402


def make_scan(w=5795, h=4854, pitch=730, gate_top=620, gate_bot=4400):
    """Synthesize a full-sprocket positive scan.

    Dark film base, bright sprocket holes top/bottom, and a bright textured
    photo (the gate) in the middle.
    """
    img = np.full((h, w), 15, np.uint8)
    for x in range(0, w, pitch):
        cv2.ellipse(img, (x + pitch // 2, 350), (160, 160), 0, 0, 360, 255, -1)
        cv2.ellipse(img, (x + pitch // 2, 4640), (160, 160), 0, 0, 360, 255, -1)
    rng = np.random.default_rng(0)
    img[gate_top:gate_bot, :] = (180 + rng.integers(-20, 21,
                                                    size=(gate_bot - gate_top, w))).clip(0, 255)
    return img


class TestMasks(unittest.TestCase):
    def test_rounded_mask_shape_and_corners(self):
        m = rebate._rounded_mask(100, 80, 10)
        self.assertEqual(m.shape, (80, 100))
        self.assertEqual(m.dtype, np.uint8)
        self.assertEqual(int(m[0, 0]), 0)       # corner cut away
        self.assertEqual(int(m[40, 50]), 255)   # centre opaque

    def test_rounded_mask_inset(self):
        m = rebate._rounded_mask(100, 80, 10, inset=5)
        self.assertEqual(int(m[2, 2]), 0)       # outside the inset
        self.assertEqual(int(m[50, 50]), 255)   # still opaque inside

    def test_rounded_mask_squared_corners(self):
        m = rebate._rounded_mask(100, 80, 10, square_corners={'tl'})
        self.assertEqual(int(m[0, 0]), 255)       # squared, not cut away
        self.assertEqual(int(m[79, 99]), 0)       # other corners still rounded
        self.assertEqual(int(m[0, 99]), 0)
        self.assertEqual(int(m[79, 0]), 0)
        m2 = rebate._rounded_mask(100, 80, 10, square_corners={'tl', 'bl'})
        self.assertEqual(int(m2[0, 0]), 255)
        self.assertEqual(int(m2[79, 0]), 255)      # bottom-left also squared
        self.assertEqual(int(m2[0, 99]), 0)        # right corners still rounded
        self.assertEqual(int(m2[79, 99]), 0)

    def test_organic_mask_deterministic(self):
        a = rebate._organic_mask(200, 150, 20, 2.0, 1.0, 42)
        b = rebate._organic_mask(200, 150, 20, 2.0, 1.0, 42)
        self.assertTrue(np.array_equal(a, b))

    def test_organic_mask_soft_edges(self):
        m = rebate._organic_mask(200, 150, 20, 0.0, 2.0, 42)
        self.assertGreater(len(np.unique(m)), 2)  # has anti-aliased values

    def test_organic_mask_binary_when_disabled(self):
        m = rebate._organic_mask(200, 150, 20, 0.0, 0.0, 42)
        self.assertTrue(set(np.unique(m).tolist()) <= {0, 255})


class TestGrid(unittest.TestCase):
    def test_grid_aligned_drops_outliers(self):
        pitch = 730
        on_grid = [100 + i * pitch for i in range(8)]
        holes = [{"cx": x} for x in on_grid + [450, 2740]]  # two clearly off-grid
        aligned = rebate._grid_aligned(holes)
        xs = sorted(h["cx"] for h in aligned)
        self.assertNotIn(450, xs)
        self.assertNotIn(2740, xs)
        self.assertGreaterEqual(len(xs), 6)


class TestDetection(unittest.TestCase):
    def test_detect_gate_ratio_and_center(self):
        img = make_scan()
        left, top, right, bot = rebate.detect_gate(img)
        ratio = (right - left) / (bot - top)
        self.assertAlmostEqual(ratio, 1.5, delta=0.05)
        center = (left + right) / 2.0
        self.assertAlmostEqual(center, img.shape[1] / 2.0, delta=200)

    def test_detect_photo_gate_edges(self):
        img = make_scan()
        left, top, right, bot = rebate.detect_photo_gate(img)
        # The photo gate is 620..4400; a small safety inset is applied.
        self.assertGreaterEqual(top, 620)
        self.assertLessEqual(top, 660)
        self.assertLessEqual(bot, 4400)
        self.assertGreaterEqual(bot, 4340)


class TestPortrait(unittest.TestCase):
    @staticmethod
    def _center_crop(g, frac=0.5):
        h, w = g.shape
        ch, cw = int(h * frac), int(w * frac)
        return g[(h - ch) // 2:(h - ch) // 2 + ch,
                 (w - cw) // 2:(w - cw) // 2 + cw]

    @staticmethod
    def _ncc(a, b):
        a = a.astype(np.float32)
        b = b.astype(np.float32)
        a -= a.mean()
        b -= b.mean()
        denom = float(np.sqrt((a * a).sum() * (b * b).sum()))
        return float((a * b).sum() / denom) if denom > 1e-9 else 0.0

    @staticmethod
    def _make_gradient_scan():
        """Like make_scan, but the gate is a strong vertical gradient so the
        orientation is unambiguous (noise alone doesn't survive resize)."""
        w, h, pitch, gate_top, gate_bot = 5795, 4854, 730, 620, 4400
        img = np.full((h, w), 15, np.uint8)
        for x in range(0, w, pitch):
            cv2.ellipse(img, (x + pitch // 2, 350), (160, 160), 0, 0, 360, 255, -1)
            cv2.ellipse(img, (x + pitch // 2, 4640), (160, 160), 0, 0, 360, 255, -1)
        rows = np.arange(gate_top, gate_bot, dtype=np.float32)
        ramp = (50 + 200 * (rows - gate_top) / (gate_bot - gate_top)).astype(np.uint8)
        img[gate_top:gate_bot, :] = ramp[:, None]
        return img

    def test_portrait_scan_rotated_back(self):
        import tempfile
        scan = self._make_gradient_scan()
        # Simulate a scan the user already flipped into portrait (90 deg CW).
        portrait = cv2.rotate(scan, cv2.ROTATE_90_CLOCKWISE)
        portrait_bgr = cv2.cvtColor(portrait, cv2.COLOR_GRAY2BGR)
        with tempfile.TemporaryDirectory() as d:
            in_path = os.path.join(d, "in.jpg")
            cv2.imwrite(in_path, portrait_bgr)
            out_path = rebate.process(in_path, d, 0, 0.05, 0.012, 0.015,
                                      0.0, 0.0, 42, 100, 0.0, 0.0, 0.0, 0.03,
                                      plain=True, debug=False)
            self.assertIsNotNone(out_path)
            out = cv2.imread(out_path, cv2.IMREAD_GRAYSCALE)
            # Output should be portrait again, matching the input orientation.
            self.assertGreater(out.shape[0], out.shape[1])

            p = cv2.cvtColor(portrait_bgr, cv2.COLOR_BGR2GRAY)
            p = self._center_crop(p)
            o = self._center_crop(out)
            o = cv2.resize(o, (p.shape[1], p.shape[0]))
            self.assertGreater(self._ncc(p, o),
                               self._ncc(p, cv2.rotate(o, cv2.ROTATE_180)))


class TestCompose(unittest.TestCase):
    def test_compose_square_canvas_and_white_corners(self):
        crop = np.full((300, 450, 3), 80, np.uint8)
        out = rebate.compose_on_white(crop, 600, 0.05, 0.015, 0.5, 3.0, 42, 0.25)
        self.assertEqual(out.shape, (600, 600, 3))
        self.assertEqual(out[0, 0].tolist(), [255, 255, 255])
        self.assertEqual(out[599, 599].tolist(), [255, 255, 255])

    def test_compose_native_is_larger_than_crop(self):
        crop = np.full((200, 300, 3), 80, np.uint8)
        out = rebate.compose_on_white(crop, 0, 0.05, 0.015, 0.5, 3.0, 42, 0.25)
        self.assertGreater(out.shape[1], 300)
        self.assertGreater(out.shape[0], 200)

    def test_square_corner_chance_one_or_two_same_side(self):
        crop = np.full((300, 450, 3), 80, np.uint8)
        size, margin, radius_frac = 600, 0.05, 0.015
        scale = size * (1.0 - 2.0 * margin) / 450.0
        dw, dh = int(round(450 * scale)), int(round(300 * scale))
        ox, oy = (size - dw) // 2, (size - dh) // 2
        inset = 2  # _organic_mask inset when roughness == feather == 0
        pts = {
            'tl': (oy + inset, ox + inset),
            'tr': (oy + inset, ox + dw - 1 - inset),
            'bl': (oy + dh - 1 - inset, ox + inset),
            'br': (oy + dh - 1 - inset, ox + dw - 1 - inset),
        }
        for seed in range(100):
            out = rebate.compose_on_white(crop, size, margin, radius_frac,
                                          0.0, 0.0, seed, 0.0, 1.0)
            square = {k: out[y, x].tolist() == [80, 80, 80]
                      for k, (y, x) in pts.items()}
            n = sum(square.values())
            self.assertIn(n, (1, 2))
            if n == 2:
                sq = set(k for k, v in square.items() if v)
                self.assertTrue(
                    sq in ({'tl', 'bl'}, {'tr', 'br'}, {'tl', 'tr'},
                           {'bl', 'br'}),
                    f'seed {seed}: two squared corners must share a side, got {sq}')


class TestRandomness(unittest.TestCase):
    def test_sprocket_band_edges(self):
        h, w = 1200, 1800
        img = np.full((h, w), 10, np.uint8)
        img[0:100, :] = 220
        img[300:900, :] = 180
        img[1100:1200, :] = 220
        ts_bot, bs_top = rebate._sprocket_band_edges(img)
        self.assertIsNotNone(ts_bot)
        self.assertIsNotNone(bs_top)
        self.assertTrue(90 <= ts_bot <= 110)
        self.assertTrue(1090 <= bs_top <= 1110)

    def test_sprocket_band_edges_ignores_photo_edge_strip(self):
        # A bright strip right at the photo's top edge must not be mistaken for
        # the top sprocket band (regression: it made the top rebate look thin
        # and biased the sprocket sliver to the bottom).
        h, w = 1200, 1800
        img = np.full((h, w), 10, np.uint8)
        img[0:100, :] = 220       # top sprocket band
        img[280:300, :] = 220     # spurious bright strip at photo edge
        img[300:900, :] = 180     # photo
        img[1100:1200, :] = 220   # bottom sprocket band
        ts_bot, bs_top = rebate._sprocket_band_edges(img)
        self.assertTrue(90 <= ts_bot <= 110)
        self.assertTrue(1090 <= bs_top <= 1110)

    def _sprocket_scan(self):
        h, w = 1200, 1800
        img = np.full((h, w), 10, np.uint8)
        img[0:350, :] = 220      # top sprocket band
        img[400:1000, :] = 180   # photo (gate)
        img[1050:1200, :] = 220  # bottom sprocket band
        return img

    def test_border_jitter_constant_size_and_variation(self):
        # No sprocket bands: border jitter alone keeps the crop size constant
        # while shifting the window (asymmetric border).
        h, w = 1200, 1800
        img = np.full((h, w), 10, np.uint8)
        img[400:1000, :] = 180
        left, top, right, bot = 450, 400, 1350, 1000
        widths, heights, tops = set(), set(), set()
        for seed in range(30):
            cl, ct, cr, cb = rebate.crop_with_border(
                img, left, top, right, bot, 0.05, 0.0, seed, 0.6)
            widths.add(cr - cl)
            heights.add(cb - ct)
            tops.add(ct)
            self.assertLessEqual(cl, left)
            self.assertGreaterEqual(cr, right)
            self.assertLessEqual(ct, top)
            self.assertGreaterEqual(cb, bot)
        self.assertEqual(len(widths), 1)
        self.assertEqual(len(heights), 1)
        self.assertGreater(len(tops), 1)  # the shift actually moves the window

    def test_sprocket_at_most_one_side(self):
        img = self._sprocket_scan()
        left, top, right, bot = 450, 400, 1350, 1000
        ts_bot, bs_top = rebate._sprocket_inner_edges(img)
        self.assertIsNotNone(ts_bot)
        self.assertIsNotNone(bs_top)
        for seed in range(60):
            cl, ct, cr, cb = rebate.crop_with_border(
                img, left, top, right, bot, 0.05, 1.0, seed, 0.0, 0.1)
            top_dipped = ct < int(ts_bot)
            bot_dipped = cb > int(bs_top)
            self.assertFalse(top_dipped and bot_dipped)

    def test_sprocket_skipped_when_rebate_too_thick(self):
        # A wide black rebate between the photo and the sprockets must NOT be
        # dragged into the crop (it would make the border massive).
        h, w = 1200, 1800
        img = np.full((h, w), 10, np.uint8)
        img[0:350, :] = 220       # top sprocket band
        img[500:1000, :] = 180    # photo (gate)
        img[1150:1200, :] = 220   # bottom sprocket band
        left, top, right, bot = 450, 500, 1350, 1000
        ts_bot, bs_top = rebate._sprocket_inner_edges(img)
        self.assertIsNotNone(ts_bot)
        self.assertIsNotNone(bs_top)
        for seed in range(60):
            cl, ct, cr, cb = rebate.crop_with_border(
                img, left, top, right, bot, 0.05, 1.0, seed, 0.0, 0.03)
            self.assertGreaterEqual(ct, int(ts_bot))
            self.assertLessEqual(cb, int(bs_top))


class TestOffsets(unittest.TestCase):
    def test_offset_nudges_crop_edges(self):
        """Per-side offsets reveal/trim the crop without touching detection."""
        import tempfile
        scan = cv2.cvtColor(make_scan(), cv2.COLOR_GRAY2BGR)
        with tempfile.TemporaryDirectory() as d:
            in_path = os.path.join(d, "in.jpg")
            cv2.imwrite(in_path, scan)
            base = rebate.process(in_path, d, 0, 0.05, 0.012, 0.015,
                                  0.0, 0.0, 42, 100, 0.0, 0.0, 0.0, 0.03,
                                  plain=True, suffix=".base.jpg")
            off = rebate.process(in_path, d, 0, 0.05, 0.012, 0.015,
                                 0.0, 0.0, 42, 100, 0.0, 0.0, 0.0, 0.03,
                                 offset_left=40.0, offset_right=20.0,
                                 offset_top=10.0, offset_bottom=5.0,
                                 plain=True, suffix=".off.jpg")
            self.assertIsNotNone(base)
            self.assertIsNotNone(off)
            b = cv2.imread(base, cv2.IMREAD_GRAYSCALE)
            o = cv2.imread(off, cv2.IMREAD_GRAYSCALE)
            # positive offsets reveal more on that side: width +60 (40+20),
            # height +15 (10+5). Tolerate +-1 for float rounding.
            self.assertAlmostEqual(o.shape[1] - b.shape[1], 60, delta=1)
            self.assertAlmostEqual(o.shape[0] - b.shape[0], 15, delta=1)

    def test_negative_offset_trims_crop(self):
        import tempfile
        scan = cv2.cvtColor(make_scan(), cv2.COLOR_GRAY2BGR)
        with tempfile.TemporaryDirectory() as d:
            in_path = os.path.join(d, "in.jpg")
            cv2.imwrite(in_path, scan)
            base = rebate.process(in_path, d, 0, 0.05, 0.012, 0.015,
                                  0.0, 0.0, 42, 100, 0.0, 0.0, 0.0, 0.03,
                                  plain=True, suffix=".base.jpg")
            off = rebate.process(in_path, d, 0, 0.05, 0.012, 0.015,
                                 0.0, 0.0, 42, 100, 0.0, 0.0, 0.0, 0.03,
                                 offset_left=-30.0, offset_top=-10.0,
                                 plain=True, suffix=".off.jpg")
            b = cv2.imread(base, cv2.IMREAD_GRAYSCALE)
            o = cv2.imread(off, cv2.IMREAD_GRAYSCALE)
            self.assertAlmostEqual(o.shape[1] - b.shape[1], -30, delta=1)
            self.assertAlmostEqual(o.shape[0] - b.shape[0], -10, delta=1)

    def test_nudge_crop_moves_only_its_own_edge(self):
        """Each offset flag nudges exactly one crop edge, deterministic."""
        base = (100, 50, 200, 150)
        n = rebate._nudge_crop
        # + reveals more (edge moves outward), the other three edges untouched.
        self.assertEqual(n(*base, 10, 0, 0, 0, 1000, 1000), (90, 50, 200, 150))
        self.assertEqual(n(*base, 0, 0, 10, 0, 1000, 1000), (100, 50, 210, 150))
        self.assertEqual(n(*base, 0, 10, 0, 0, 1000, 1000), (100, 40, 200, 150))
        self.assertEqual(n(*base, 0, 0, 0, 10, 1000, 1000), (100, 50, 200, 160))
        # - trims inward.
        self.assertEqual(n(*base, -10, 0, 0, 0, 1000, 1000), (110, 50, 200, 150))
        # clamped to image bounds, and never inverted.
        self.assertEqual(n(5, 5, 10, 10, 100, 100, 100, 100, 1000, 1000),
                         (0, 0, 110, 110))


class TestConfigs(unittest.TestCase):
    """Named config (preset) storage and application."""

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        self.tmp.close()
        os.unlink(self.tmp.name)
        self._old = os.environ.get("REBATE_CONFIG_FILE")
        os.environ["REBATE_CONFIG_FILE"] = self.tmp.name

    def tearDown(self):
        if self._old is None:
            os.environ.pop("REBATE_CONFIG_FILE", None)
        else:
            os.environ["REBATE_CONFIG_FILE"] = self._old
        if os.path.exists(self.tmp.name):
            os.unlink(self.tmp.name)

    def test_save_stores_only_explicit_options(self):
        self.assertEqual(
            rebate.config_command(["save", "ig", "--quality", "95",
                                   "--border", "0.04"]), 0)
        configs = rebate._load_configs()
        self.assertEqual(configs, {"ig": {"quality": 95, "border": 0.04}})

    def test_save_list_show_delete_rename(self):
        rebate.config_command(["save", "ig", "--quality", "95"])
        rebate.config_command(["save", "plainish", "--plain", "--suffix", ".p.png"])
        self.assertEqual(rebate._load_configs(), {
            "ig": {"quality": 95},
            "plainish": {"plain": True, "suffix": ".p.png"},
        })

        # show returns 0 for a known config and 1 for an unknown one.
        self.assertEqual(rebate.config_command(["show", "ig"]), 0)
        self.assertEqual(rebate.config_command(["show", "nope"]), 1)

        self.assertEqual(rebate.config_command(["rename", "ig", "insta"]), 0)
        self.assertNotIn("ig", rebate._load_configs())
        self.assertIn("insta", rebate._load_configs())

        self.assertEqual(rebate.config_command(["delete", "insta"]), 0)
        self.assertNotIn("insta", rebate._load_configs())
        self.assertEqual(rebate.config_command(["delete", "insta"]), 1)

    def test_save_requires_an_option(self):
        self.assertEqual(rebate.config_command(["save", "empty"]), 1)
        self.assertEqual(rebate._load_configs(), {})

    def test_explicit_option_names(self):
        names = rebate._explicit_option_names(
            ["--quality", "100", "--border", "0.035", "--plain",
             "--size=3000"])
        self.assertIn("quality", names)
        self.assertIn("border", names)
        self.assertIn("plain", names)
        self.assertIn("size", names)
        self.assertNotIn("margin", names)

    def test_coerce_config_types(self):
        self.assertEqual(
            rebate._coerce_config({"quality": "100", "border": "0.04",
                                   "plain": True, "suffix": 123}),
            {"quality": 100, "border": 0.04, "plain": True, "suffix": "123"})
        # Bad values are dropped rather than crashing the run.
        self.assertEqual(rebate._coerce_config({"quality": "abc"}), {})

    def test_add_common_options_seeds_defaults_and_overrides(self):
        p = argparse.ArgumentParser(add_help=False)
        rebate._add_common_options(p, {"quality": 88, "plain": True})
        args = p.parse_args([])
        self.assertEqual(args.quality, 88)
        self.assertTrue(args.plain)
        self.assertEqual(args.size, 0)  # untouched built-in default
        over = p.parse_args(["--quality", "91"])
        self.assertEqual(over.quality, 91)


class TestOffsetFlags(unittest.TestCase):
    """--offset-x / --offset-y combos and the offset/jitter conflict rules."""

    def _ns(self, **kw):
        defaults = dict(offset_left=0.0, offset_right=0.0, offset_top=0.0,
                        offset_bottom=0.0, offset_x=None, offset_y=None)
        defaults.update(kw)
        return argparse.Namespace(**defaults)

    def test_resolve_offsets_specifics_passthrough(self):
        args = self._ns(offset_left=10.0, offset_right=20.0,
                        offset_top=30.0, offset_bottom=40.0)
        self.assertEqual(rebate._resolve_offsets(args, set()),
                         (10.0, 20.0, 30.0, 40.0))

    def test_resolve_offset_x_combo(self):
        args = self._ns(offset_x=15.0)
        self.assertEqual(rebate._resolve_offsets(args, {"offset_x"}),
                         (15.0, 15.0, 0.0, 0.0))

    def test_resolve_specific_beats_combo(self):
        args = self._ns(offset_x=15.0, offset_y=25.0,
                        offset_left=99.0, offset_bottom=-5.0)
        explicit = {"offset_x", "offset_y", "offset_left", "offset_bottom"}
        self.assertEqual(rebate._resolve_offsets(args, explicit),
                         (99.0, 15.0, 25.0, -5.0))

    def test_offsets_active(self):
        ns = self._ns
        # Nothing set -> inactive.
        self.assertFalse(rebate._offsets_active(ns(), set(), 0, 0, 0, 0))
        # A non-zero edge value activates.
        self.assertTrue(rebate._offsets_active(ns(), set(), 5, 0, 0, 0))
        # A combo flag activates even if the resolved value is what triggers.
        self.assertTrue(rebate._offsets_active(ns(offset_x=1.0),
                                               {"offset_x"}, 1.0, 1.0, 0, 0))
        # Explicitly passing an offset (even zero) counts as "using" it.
        self.assertTrue(rebate._offsets_active(ns(), {"offset_top"},
                                               0, 0, 0, 0))


if __name__ == "__main__":
    unittest.main()
