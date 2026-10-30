"""Tests for the CLI client (`rebate.cli`): file IO and argparse entrypoints.

The heavy processing is covered elsewhere; here we verify the client glue —
writing images, `process()` end-to-end through files, and `main()` exit codes.
"""

import contextlib
import io
import os
import sys
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rebate import cli  # noqa: E402


def _small_bgr():
    img = np.zeros((80, 120, 3), np.uint8)
    img[:] = (30, 120, 200)
    return img


class TestSaveImage(unittest.TestCase):
    def test_writes_jpeg_and_png(self):
        img = _small_bgr()
        with tempfile.TemporaryDirectory() as d:
            jpg = os.path.join(d, "a.jpg")
            png = os.path.join(d, "a.png")
            self.assertTrue(cli._save_image(jpg, img, quality=90))
            self.assertTrue(cli._save_image(png, img))
            self.assertTrue(os.path.exists(jpg))
            self.assertTrue(os.path.exists(png))
            back = cv2.imread(png, cv2.IMREAD_COLOR)
            self.assertTrue(np.array_equal(back, img))

    def test_reports_failure_on_bad_path(self):
        img = _small_bgr()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            ok = cli._save_image("/no/such/dir/a.jpg", img)
        self.assertFalse(ok)
        self.assertIn("failed to write", err.getvalue())


class TestProcess(unittest.TestCase):
    def _write_scan(self, d):
        path = os.path.join(d, "scan.jpg")
        cv2.imwrite(path, _small_bgr())
        return path

    def test_process_bordered(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write_scan(d)
            out = cli.process(path, d, 0, 0.05, 0.012, 0.015, 0.0, 0.0,
                              42, 100, 0.0, 0.0, plain=False, suffix=".bordered.jpg")
            self.assertEqual(out, os.path.join(d, "scan.bordered.jpg"))
            self.assertTrue(os.path.exists(out))

    def test_process_plain(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write_scan(d)
            out = cli.process(path, d, 0, 0.05, 0.012, 0.015, 0.0, 0.0,
                              42, 100, 0.0, 0.0, plain=True, suffix=".plain.jpg")
            self.assertEqual(out, os.path.join(d, "scan.plain.jpg"))
            self.assertTrue(os.path.exists(out))

    def test_process_debug(self):
        with tempfile.TemporaryDirectory() as d:
            path = self._write_scan(d)
            out = cli.process(path, d, 0, 0.05, 0.012, 0.015, 0.0, 0.0,
                              42, 100, 0.0, 0.0, debug=True, suffix=".x.jpg")
            self.assertEqual(out, os.path.join(d, "scan.x.jpg"))
            self.assertTrue(os.path.exists(os.path.join(d, "scan.debug.jpg")))

    def test_process_missing_file_returns_none(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            out = cli.process("/no/such/file.jpg", "/tmp", 0, 0.05, 0.012,
                              0.015, 0.0, 0.0, 42, 100, 0.0, 0.0)
        self.assertIsNone(out)
        self.assertIn("cannot read", err.getvalue())


class TestMain(unittest.TestCase):
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

    def test_main_config_list_returns_zero(self):
        with mock.patch.object(sys, "argv", ["rebate", "config", "list"]):
            self.assertEqual(cli.main(), 0)

    def test_main_rejects_offset_with_border_jitter(self):
        err = io.StringIO()
        with mock.patch.object(
            sys, "argv",
            ["rebate", "scan.jpg", "--offset-x", "5", "--border-jitter", "0.2"],
        ), contextlib.redirect_stderr(err):
            rc = cli.main()
        self.assertEqual(rc, 1)
        self.assertIn("stable crop", err.getvalue())

    def test_main_unknown_config_returns_one(self):
        err = io.StringIO()
        with mock.patch.object(
            sys, "argv", ["rebate", "scan.jpg", "--config", "nope"],
        ), contextlib.redirect_stderr(err):
            rc = cli.main()
        self.assertEqual(rc, 1)
        self.assertIn("unknown config", err.getvalue())


if __name__ == "__main__":
    unittest.main()
