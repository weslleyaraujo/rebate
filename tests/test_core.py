"""Tests for the pure, in-memory core (`rebate.core`).

These exercise the exact API the browser client (Pyodide worker) uses, in
isolation from the CLI (no file IO, no argparse): `process_image`,
`decode_image`, `encode_image`, and the detection/compose helpers.
"""

import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rebate import core  # noqa: E402


def make_scan(w=1449, h=1214, pitch=183, gate_top=155, gate_bot=1100):
    """Small full-sprocket positive scan (scale-invariant detector)."""
    img = np.full((h, w), 15, np.uint8)
    for x in range(0, w, pitch):
        cv2.ellipse(img, (x + pitch // 2, 88), (40, 40), 0, 0, 360, 255, -1)
        cv2.ellipse(img, (x + pitch // 2, 1160), (40, 40), 0, 0, 360, 255, -1)
    rng = np.random.default_rng(0)
    img[gate_top:gate_bot, :] = (180 + rng.integers(
        -20, 21, size=(gate_bot - gate_top, w))).clip(0, 255)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


class TestCodec(unittest.TestCase):
    def test_jpeg_roundtrip(self):
        img = np.zeros((40, 60, 3), np.uint8)
        img[:] = (10, 200, 30)
        data = core.encode_image(img, ".jpg", 90)
        self.assertIsInstance(data, bytes)
        back = core.decode_image(data)
        self.assertEqual(back.shape, img.shape)
        self.assertEqual(back.dtype, np.uint8)

    def test_png_roundtrip_is_lossless(self):
        rng = np.random.default_rng(0)
        img = rng.integers(0, 256, (32, 48, 3), dtype=np.uint8)
        data = core.encode_image(img, ".png")
        back = core.decode_image(data)
        self.assertTrue(np.array_equal(back, img))

    def test_decode_invalid_raises(self):
        with self.assertRaises(ValueError):
            core.decode_image(b"not an image")


class TestProcessImage(unittest.TestCase):
    def test_plain_returns_3x2_crop_with_no_canvas(self):
        img = make_scan()
        res = core.process_image(img, size=0, margin=0.05, border=0.012,
                                 radius=0.015, roughness=0.0, feather=0.0,
                                 seed=42, sprocket_chance=0.0, plain=True)
        self.assertIsNotNone(res.image)
        self.assertIsNotNone(res.plain_rect)
        self.assertIsNone(res.gate_rect)
        cl, ct, cr, cb = res.plain_rect
        self.assertAlmostEqual((cr - cl) / (cb - ct), 1.5, delta=0.1)

    def test_bordered_returns_canvas_and_rects(self):
        img = make_scan()
        res = core.process_image(img, size=0, margin=0.05, border=0.012,
                                 radius=0.015, roughness=0.0, feather=0.0,
                                 seed=42, sprocket_chance=0.0)
        self.assertEqual(res.image.ndim, 3)
        self.assertIsNotNone(res.gate_rect)
        self.assertIsNotNone(res.crop_rect)
        self.assertIsNone(res.debug_image)

    def test_debug_image_matches_input_orientation(self):
        img = make_scan()
        res = core.process_image(img, size=0, margin=0.05, border=0.012,
                                 radius=0.015, roughness=0.0, feather=0.0,
                                 seed=42, sprocket_chance=0.0, debug=True)
        self.assertIsNotNone(res.debug_image)
        self.assertEqual(res.debug_image.shape[:2], img.shape[:2])

    def test_portrait_input_is_rotated_back(self):
        img = make_scan()
        portrait = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        res = core.process_image(portrait, size=0, margin=0.05, border=0.012,
                                 radius=0.015, roughness=0.0, feather=0.0,
                                 seed=42, sprocket_chance=0.0, plain=True)
        self.assertGreater(res.image.shape[0], res.image.shape[1])

    def test_seed_is_deterministic(self):
        img = make_scan()
        kw = dict(size=0, margin=0.05, border=0.012, radius=0.015,
                  roughness=1.0, feather=2.0, seed=7, sprocket_chance=1.0)
        a = core.process_image(img, **kw)
        b = core.process_image(img, **kw)
        self.assertTrue(np.array_equal(a.image, b.image))

    def test_none_seed_produces_valid_image(self):
        img = make_scan()
        res = core.process_image(img, size=0, margin=0.05, border=0.012,
                                 radius=0.015, roughness=1.0, feather=2.0,
                                 seed=None, sprocket_chance=0.7)
        self.assertEqual(res.image.ndim, 3)
        self.assertGreater(res.image.size, 0)


class TestManualOverride(unittest.TestCase):
    def test_gate_override_is_used(self):
        img = make_scan()
        gate = (100.0, 200.0, 1300.0, 1000.0)  # 1200x800 (3:2)
        res = core.process_image(img, size=0, margin=0.05, border=0.012,
                                 radius=0.015, roughness=0.0, feather=0.0,
                                 seed=42, sprocket_chance=0.0,
                                 gate_override=gate)
        self.assertIsNotNone(res.gate_rect)
        self.assertAlmostEqual(res.gate_rect[0], 100.0)
        self.assertAlmostEqual(res.gate_rect[1], 200.0)
        self.assertAlmostEqual(res.gate_rect[2], 1300.0)
        self.assertAlmostEqual(res.gate_rect[3], 1000.0)
        self.assertIsNotNone(res.crop_rect)

    def test_sprocket_override_is_reported(self):
        img = make_scan()
        gate = (100.0, 300.0, 1300.0, 1100.0)
        res = core.process_image(img, size=0, margin=0.05, border=0.01,
                                 radius=0.015, roughness=0.0, feather=0.0,
                                 seed=42, sprocket_chance=1.0,
                                 max_sprocket_border=0.1,
                                 gate_override=gate,
                                 sprocket_override=(250.0, 1150.0))
        self.assertIsNotNone(res.sprocket_edges)
        self.assertAlmostEqual(res.sprocket_edges[0], 250.0)
        self.assertAlmostEqual(res.sprocket_edges[1], 1150.0)

    def test_crop_with_border_accepts_sprocket_override(self):
        h, w = 1200, 1800
        img = np.full((h, w), 10, np.uint8)
        img[400:1000, :] = 180
        left, top, right, bot = 450, 400, 1350, 1000
        cl, ct, cr, cb = core.crop_with_border(
            img, left, top, right, bot, 0.05, 1.0, 42, 0.0, 0.1,
            sprocket_override=(300, 1100))
        self.assertEqual(cr - cl, int(round(900 + 2.0 * 30)))
        self.assertEqual(cb - ct, int(round(600 + 2.0 * 30)))


if __name__ == "__main__":
    unittest.main()
