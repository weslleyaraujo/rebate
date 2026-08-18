"""Core tests for rebate (film border scanner).

Run with:
    /opt/homebrew/bin/python3.11 -m unittest discover -s tests -p 'test_*.py'
"""

import os
import sys
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


if __name__ == "__main__":
    unittest.main()
