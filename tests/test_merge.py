"""Tests for multi-image merge (tiling several bordered crops on one canvas)."""

import os
import sys
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import rebate  # noqa: E402


def _solid_crop(w=300, h=200, v=80):
    return np.full((h, w, 3), v, np.uint8)


def _make_scan(w=1449, h=1214, pitch=183, gate_top=155, gate_bot=1100, tag=0):
    """Small full-sprocket positive scan (scale-invariant detector)."""
    img = np.full((h, w), 15, np.uint8)
    for x in range(0, w, pitch):
        cv2.ellipse(img, (x + pitch // 2, 88), (40, 40), 0, 0, 360, 255, -1)
        cv2.ellipse(img, (x + pitch // 2, 1160), (40, 40), 0, 0, 360, 255, -1)
    rng = np.random.default_rng(tag)
    img[gate_top:gate_bot, :] = (180 + rng.integers(
        -20, 21, size=(gate_bot - gate_top, w))).clip(0, 255)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


class TestParseLayout(unittest.TestCase):
    def test_horizontal_vertical(self):
        self.assertEqual(rebate._parse_layout("horizontal", 3), (1, 3))
        self.assertEqual(rebate._parse_layout("vertical", 3), (3, 1))
        self.assertEqual(rebate._parse_layout("h", 2), (1, 2))
        self.assertEqual(rebate._parse_layout("v", 2), (2, 1))

    def test_grid_defaults_to_two_columns(self):
        self.assertEqual(rebate._parse_layout("grid", 5), (3, 2))
        self.assertEqual(rebate._parse_layout("grid", 4), (2, 2))

    def test_grid_explicit_dims(self):
        self.assertEqual(rebate._parse_layout("grid:2x3", 5), (2, 3))
        # Too few cells for the tiles -> rows grow to fit.
        self.assertEqual(rebate._parse_layout("grid:1x2", 5), (3, 2))

    def test_unknown_layout_defaults_to_horizontal(self):
        self.assertEqual(rebate._parse_layout("garbage", 3), (1, 3))
        self.assertEqual(rebate._parse_layout("", 3), (1, 3))


class TestComposeMerge(unittest.TestCase):
    def _kw(self, **over):
        kw = dict(size=0, margin_frac=0.05, gap_frac=0.03,
                  layout="horizontal", radius_frac=0.015, roughness=0.0,
                  feather=0.0, seed=42)
        kw.update(over)
        return kw

    def test_horizontal_native_dims_and_white_margin(self):
        crops = [_solid_crop(v=80), _solid_crop(v=120)]
        out = rebate.compose_merge_on_white(crops, **self._kw())
        # Native merge is scaled so its longest side equals a single frame's
        # native output (crop 300 + 2*0.05 margin = 330).
        self.assertEqual(out.shape[1], 330)
        self.assertLess(out.shape[0], 330)
        self.assertEqual(out[0, 0].tolist(), [255, 255, 255])
        self.assertEqual(out[out.shape[0] - 1, 329].tolist(), [255, 255, 255])

    def test_horizontal_gap_is_white(self):
        crops = [_solid_crop(v=80), _solid_crop(v=120)]
        out = rebate.compose_merge_on_white(crops, **self._kw())
        # There is a fully-white vertical strip (gap between the two tiles)
        # near the horizontal middle.
        w = out.shape[1]
        mid = w // 2
        white_cols = [
            x for x in range(mid - 25, mid + 25)
            if (out[:, x] == 255).all()
        ]
        self.assertTrue(white_cols)

    def test_vertical_native_dims(self):
        crops = [_solid_crop(v=80), _solid_crop(v=120)]
        out = rebate.compose_merge_on_white(crops, **self._kw(layout="vertical"))
        # Native merge canvas == a single frame's native output (330 x 230).
        self.assertEqual(out.shape, (230, 330, 3))

    def test_grid_dims(self):
        crops = [_solid_crop(v=80) for _ in range(4)]
        out = rebate.compose_merge_on_white(
            crops, **self._kw(layout="grid:2x2"))
        # Grid native merge: longest side (width) == single native output.
        self.assertEqual(out.shape[1], 330)
        self.assertLess(out.shape[0], 330)

    def test_size_is_longest_side(self):
        crops = [_solid_crop(v=80), _solid_crop(v=120)]
        out = rebate.compose_merge_on_white(crops, **self._kw(size=1000))
        self.assertEqual(out.shape[1], 1000)  # horizontal: width is longest
        out_v = rebate.compose_merge_on_white(
            crops, **self._kw(size=1000, layout="vertical"))
        self.assertEqual(out_v.shape[0], 1000)  # vertical: height is longest

    def test_single_crop_delegates_to_compose_on_white(self):
        crop = _solid_crop(v=80)
        merged = rebate.compose_merge_on_white([crop], **self._kw(size=600))
        single = rebate.compose_on_white(crop, 600, 0.05, 0.015, 0.0, 0.0,
                                         42, 0.0, 0.0)
        self.assertTrue(np.array_equal(merged, single))

    def test_deterministic_with_fixed_seed(self):
        crops = [_solid_crop(v=80), _solid_crop(v=120)]
        kw = self._kw(size=800, roughness=1.0, feather=2.0, seed=7)
        a = rebate.compose_merge_on_white(crops, **kw)
        b = rebate.compose_merge_on_white(crops, **kw)
        self.assertTrue(np.array_equal(a, b))

    def test_each_tile_gets_its_own_edge_seed(self):
        crops = [_solid_crop(v=80), _solid_crop(v=80)]
        out = rebate.compose_merge_on_white(
            crops, **self._kw(size=800, roughness=1.0, feather=2.0))
        # Two identical crops with different per-tile seeds must differ.
        mid = out.shape[1] // 2
        self.assertFalse(np.array_equal(out[:, :mid, :], out[:, mid:, :]))


class TestProcessMerge(unittest.TestCase):
    def _kw(self, **over):
        kw = dict(size=1000, margin=0.05, border=0.012, radius=0.015,
                  roughness=0.0, feather=0.0, seed=42, sprocket_chance=0.0,
                  gap=0.03, layout="horizontal")
        kw.update(over)
        return kw

    def test_horizontal_layout_square_canvas(self):
        imgs = [_make_scan(tag=0), _make_scan(tag=1)]
        out = rebate.process_merge(imgs, **self._kw())
        self.assertEqual(out.ndim, 3)
        # Explicit size -> square canvas (same as a single image's canvas).
        self.assertEqual(out.shape, (1000, 1000, 3))

    def test_vertical_layout_square_canvas(self):
        imgs = [_make_scan(tag=0), _make_scan(tag=1)]
        out = rebate.process_merge(imgs, **self._kw(layout="vertical"))
        self.assertEqual(out.shape, (1000, 1000, 3))

    def test_deterministic(self):
        imgs = [_make_scan(tag=0), _make_scan(tag=1)]
        kw = self._kw(roughness=1.0, feather=2.0, seed=7,
                      sprocket_chance=1.0)
        a = rebate.process_merge(imgs, **kw)
        b = rebate.process_merge(imgs, **kw)
        self.assertTrue(np.array_equal(a, b))


class TestCliMerge(unittest.TestCase):
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

    def test_process_merge_files_writes_one_output(self):
        with tempfile.TemporaryDirectory() as d:
            a = os.path.join(d, "a.jpg")
            b = os.path.join(d, "b.jpg")
            cv2.imwrite(a, _solid_crop(v=80))
            cv2.imwrite(b, _solid_crop(v=120))
            out = rebate.process_merge_files(
                [a, b], d, size=400, margin_frac=0.05, border_frac=0.012,
                radius_frac=0.015, roughness=0.0, feather=0.0, seed=42,
                quality=100, sprocket_chance=0.0, radius_jitter=0.0,
                square_corner_chance=0.0, border_jitter=0.0,
                max_sprocket_border=0.03, gap=0.03, layout="horizontal",
                suffix=".m.jpg")
            self.assertEqual(out, os.path.join(d, "a_b.m.jpg"))
            self.assertTrue(os.path.exists(out))

    def test_main_merge_requires_two_inputs(self):
        import contextlib, io
        err = io.StringIO()
        with mock.patch.object(
            sys, "argv", ["rebate", "a.jpg", "--merge", "--out", "/tmp"]
        ), contextlib.redirect_stderr(err):
            rc = rebate.main()
        self.assertEqual(rc, 1)
        self.assertIn("at least two", err.getvalue())

    def test_main_merge_rejects_plain(self):
        import contextlib, io
        err = io.StringIO()
        with mock.patch.object(
            sys, "argv",
            ["rebate", "a.jpg", "b.jpg", "--merge", "--plain", "--out", "/tmp"]
        ), contextlib.redirect_stderr(err):
            rc = rebate.main()
        self.assertEqual(rc, 1)
        self.assertIn("cannot be combined", err.getvalue())


if __name__ == "__main__":
    unittest.main()
