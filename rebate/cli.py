"""rebate — command-line client.

This module is a thin client over `rebate.core`: it owns everything that is
CLI-specific (argparse, named config/presets, offset shorthand resolution,
file IO) and delegates the actual image processing to `rebate.core`.

The web app (`web/`) is a second client that drives the same core.
"""

import argparse
import json
import os
import sys

import cv2

from . import core

# ---------------------------------------------------------------------------
# Named configs (presets)
#
# A config is a small JSON object of non-default flag values stored per-user
# in ~/.config/rebate/configs.json (override the path with REBATE_CONFIG_FILE).
# They let you reuse a fixed combination of options, e.g. the exact look used
# for Instagram, without re-typing them every time.
# ---------------------------------------------------------------------------

# (dest, flag, type, default, help)
_OPTION_SPECS = [
    ("size", "--size", int, 0,
     "canvas size (square); 0 = native resolution, no resampling (default 0)"),
    ("margin", "--margin", float, 0.05,
     "white margin around crop (fraction; default 0.05)"),
    ("border", "--border", float, 0.025,
     "film border to include around the gate as fraction of gate height "
     "(default 0.025)"),
    ("radius", "--radius", float, 0.015,
     "corner radius as fraction of the final crop size (default 0.015)"),
    ("radius_jitter", "--radius-jitter", float, 0.0,
     "random +/- variation of the corner radius, as a fraction (0 = fixed "
     "corners; default 0)"),
    ("square_corner_chance", "--square-corner-chance", float, 0.2,
     "probability (0-1) that one corner, or two corners on the same side, "
     "are squared off instead of rounded (default 0.2)"),
    ("border_jitter", "--border-jitter", float, 0.6,
     "random shift of the black film border, as a fraction of the border "
     "thickness (0 = perfectly even; default 0.6). Forced to 0 when any "
     "--offset-* is used"),
    ("max_sprocket_border", "--max-sprocket-border", float, 0.03,
     "max rebate (fraction of gate height) that still shows a sprocket "
     "sliver; beyond it the crop keeps a small plain border (default 0.03)"),
    ("offset_left", "--offset-left", float, 0.0,
     "manual nudge of the crop's left edge, in pixels at full scan "
     "resolution; positive reveals more of the left side (moves the edge "
     "outward), negative trims inward. Applied to the final crop, so it "
     "only ever touches this one edge; --border-jitter is forced to 0 "
     "whenever an offset is used (default 0)"),
    ("offset_right", "--offset-right", float, 0.0,
     "manual nudge of the crop's right edge, in pixels; positive reveals "
     "more of the right side, negative trims inward (default 0)"),
    ("offset_top", "--offset-top", float, 0.0,
     "manual nudge of the crop's top edge, in pixels; positive reveals more "
     "of the top, negative trims inward (default 0)"),
    ("offset_bottom", "--offset-bottom", float, 0.0,
     "manual nudge of the crop's bottom edge, in pixels; positive reveals "
     "more of the bottom, negative trims inward (default 0)"),
    ("offset_x", "--offset-x", float, None,
     "set BOTH left and right crop offsets at once, in pixels at full scan "
     "resolution; positive reveals more, negative trims inward. A specific "
     "--offset-left/--offset-right wins if also given (default: unset)"),
    ("offset_y", "--offset-y", float, None,
     "set BOTH top and bottom crop offsets at once, in pixels at full scan "
     "resolution; positive reveals more, negative trims inward. A specific "
     "--offset-top/--offset-bottom wins if also given (default: unset)"),
    ("roughness", "--roughness", float, 1.0,
     "edge irregularity in px (0 = perfectly straight; default 1.0)"),
    ("feather", "--feather", float, 3.0,
     "edge softness in px (default 3.0)"),
    ("seed", "--seed", int, None,
     "random seed for edge texture (default: random)"),
    ("quality", "--quality", int, 100,
     "JPEG quality 1-100 (default 100)"),
    ("sprocket_chance", "--sprocket-chance", float, 0.7,
     "probability (0-1) that a tiny sliver of sprocket holes is visible on "
     "at most one side (top or bottom) (default 0.7)"),
    ("plain", "--plain", bool, False,
     "crop just the 3:2 image with no border and no white canvas"),
    ("debug", "--debug", bool, False,
     "also save an annotated debug image"),
    ("suffix", "--suffix", str, ".bordered.jpg",
     "output filename suffix (default .bordered.jpg)"),
]

_DEST_TO_FLAG = {dest: flag for dest, flag, _, _, _ in _OPTION_SPECS}
_TYPE_BY_DEST = {dest: typ for dest, _, typ, _, _ in _OPTION_SPECS}


def _config_path():
    if os.environ.get("REBATE_CONFIG_FILE"):
        return os.environ["REBATE_CONFIG_FILE"]
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config")
    return os.path.join(xdg, "rebate", "configs.json")


def _load_configs():
    path = _config_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        print(f"!! cannot read config file {path}", file=sys.stderr)
        return {}
    return data if isinstance(data, dict) else {}


def _save_configs(configs):
    path = _config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(configs, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def _coerce_config(cfg):
    """Coerce stored JSON values to the option types (JSON is loosely typed)."""
    out = {}
    for key, value in cfg.items():
        if key not in _TYPE_BY_DEST:
            continue
        typ = _TYPE_BY_DEST[key]
        try:
            if typ is bool:
                out[key] = bool(value)
            elif typ is int:
                out[key] = int(value)
            elif typ is float:
                out[key] = float(value)
            else:
                out[key] = str(value)
        except (TypeError, ValueError):
            print(f"!! invalid config value for {key}: {value!r} (ignored)",
                  file=sys.stderr)
    return out


def _add_common_options(parser, defaults):
    """Add the shared visual/processing flags, seeded from `defaults`."""
    for dest, flag, typ, dflt, help_ in _OPTION_SPECS:
        default = defaults.get(dest, dflt)
        if typ is bool:
            parser.add_argument(flag, action="store_true",
                                default=bool(default), help=help_)
        else:
            parser.add_argument(flag, type=typ, default=default, help=help_)


def _explicit_option_names(argv):
    """Return option dest names explicitly present in the raw argv tokens."""
    names = set()
    for dest, flag, _, _, _ in _OPTION_SPECS:
        if any(tok == flag or tok.startswith(flag + "=") for tok in argv):
            names.add(dest)
    return names


def config_command(argv):
    ap = argparse.ArgumentParser(
        prog="rebate config",
        description="manage named rebate presets (configs)")
    sub = ap.add_subparsers(dest="action", required=True)

    p_list = sub.add_parser("list", help="list saved configs")

    p_show = sub.add_parser("show", help="print one config")
    p_show.add_argument("name")

    p_save = sub.add_parser("save",
                            help="save options as a config (later flags "
                                 "override saved values)")
    p_save.add_argument("name")
    _add_common_options(p_save, {})

    p_delete = sub.add_parser("delete", help="delete a config")
    p_delete.add_argument("name")

    p_rename = sub.add_parser("rename", help="rename a config")
    p_rename.add_argument("old")
    p_rename.add_argument("new")

    args = ap.parse_args(argv)
    configs = _load_configs()

    if args.action == "list":
        if not configs:
            print("no saved configs")
        else:
            for name in sorted(configs):
                print(name)

    elif args.action == "show":
        cfg = configs.get(args.name)
        if cfg is None:
            print(f"!! unknown config: {args.name}", file=sys.stderr)
            return 1
        if not isinstance(cfg, dict):
            print(f"!! invalid config: {args.name}", file=sys.stderr)
            return 1
        print(f"[{args.name}]")
        for key in sorted(cfg):
            print(f"  {_DEST_TO_FLAG.get(key, key)} = {cfg[key]!r}")

    elif args.action == "save":
        # Store only the options the user actually wrote on the command line,
        # so the config stays a minimal "combination" that merges over future
        # defaults rather than freezing every setting.
        names = _explicit_option_names(argv)
        if not names:
            print("!! no options given; nothing to save", file=sys.stderr)
            return 1
        cfg = {name: getattr(args, name) for name in names}
        configs[args.name] = cfg
        _save_configs(configs)
        print(f"saved config '{args.name}':")
        for key in sorted(cfg):
            print(f"  {_DEST_TO_FLAG.get(key, key)} = {cfg[key]!r}")

    elif args.action == "delete":
        if configs.pop(args.name, None) is None:
            print(f"!! unknown config: {args.name}", file=sys.stderr)
            return 1
        _save_configs(configs)
        print(f"deleted config '{args.name}'")

    elif args.action == "rename":
        if args.old not in configs:
            print(f"!! unknown config: {args.old}", file=sys.stderr)
            return 1
        configs[args.new] = configs.pop(args.old)
        _save_configs(configs)
        print(f"renamed '{args.old}' -> '{args.new}'")

    return 0


def _resolve_offsets(args, explicit):
    """Resolve --offset-x / --offset-y shorthand into the four edge offsets.

    Returns (left, right, top, bottom). A specific edge flag (--offset-left,
    ...) wins over the combo, so you can nudge both sides at once and then
    tweak just one edge.
    """
    left = args.offset_left
    right = args.offset_right
    top = args.offset_top
    bottom = args.offset_bottom
    if args.offset_x is not None:
        if "offset_left" not in explicit:
            left = args.offset_x
        if "offset_right" not in explicit:
            right = args.offset_x
    if args.offset_y is not None:
        if "offset_top" not in explicit:
            top = args.offset_y
        if "offset_bottom" not in explicit:
            bottom = args.offset_y
    return left, right, top, bottom


def _offsets_active(args, explicit, left, right, top, bottom):
    """True if any offset is in effect (or was explicitly requested)."""
    return (left != 0 or right != 0 or top != 0 or bottom != 0
            or args.offset_x is not None or args.offset_y is not None
            or "offset_left" in explicit or "offset_right" in explicit
            or "offset_top" in explicit or "offset_bottom" in explicit
            or "offset_x" in explicit or "offset_y" in explicit)


def _save_image(path, img, quality=None):
    """Write img to path, overwriting any existing file.

    Uses the core's encoder so the CLI and the browser produce identical
    bytes. We check the result and report failures to stderr — otherwise a
    locked/read-only target would look like a successful overwrite while
    leaving the old file untouched.
    """
    ext = os.path.splitext(path)[1]
    try:
        data = core.encode_image(img, ext, quality)
    except (ValueError, cv2.error):
        print(f"!! failed to write {path}", file=sys.stderr)
        return False
    try:
        with open(path, "wb") as f:
            f.write(data)
    except OSError:
        print(f"!! failed to write {path}", file=sys.stderr)
        return False
    return True


def process(path, out_dir, size, margin_frac, border_frac, radius_frac,
            roughness, feather, seed, quality, sprocket_chance,
            radius_jitter, square_corner_chance=0.0, border_jitter=0.0,
            max_sprocket_border=0.03, offset_left=0.0, offset_right=0.0,
            offset_top=0.0, offset_bottom=0.0, plain=False, debug=False,
            suffix=".bordered.jpg"):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        print(f"!! cannot read {path}", file=sys.stderr)
        return None

    result = core.process_image(
        img, size=size, margin=margin_frac, border=border_frac,
        radius=radius_frac, roughness=roughness, feather=feather, seed=seed,
        sprocket_chance=sprocket_chance, radius_jitter=radius_jitter,
        square_corner_chance=square_corner_chance,
        border_jitter=border_jitter, max_sprocket_border=max_sprocket_border,
        offset_left=offset_left, offset_right=offset_right,
        offset_top=offset_top, offset_bottom=offset_bottom,
        plain=plain, debug=debug,
    )

    if plain:
        cl, ct, cr, cb = result.plain_rect
        out_name = os.path.splitext(os.path.basename(path))[0] + suffix
        out_path = os.path.join(out_dir, out_name)
        _save_image(out_path, result.image, quality)
        print(f"  {os.path.basename(path)}")
        print(f"    photo x[{cl}..{cr}] y[{ct}..{cb}] "
              f"({cr-cl}x{cb-ct}, ratio {(cr-cl)/(cb-ct):.2f}) -> {out_path}")
        return out_path

    left, top, right, bot = result.gate_rect
    cl, ct, cr, cb = result.crop_rect

    if debug and result.debug_image is not None:
        out_dbg = os.path.join(out_dir,
                               os.path.splitext(os.path.basename(path))[0]
                               + ".debug.jpg")
        _save_image(out_dbg, result.debug_image)
        print(f"    debug -> {out_dbg}")

    out_name = os.path.splitext(os.path.basename(path))[0] + suffix
    out_path = os.path.join(out_dir, out_name)
    _save_image(out_path, result.image, quality)

    gate_w = right - left
    gate_h = bot - top
    print(f"  {os.path.basename(path)}")
    print(f"    gate  x[{left:.0f}..{right:.0f}] y[{top:.0f}..{bot:.0f}] "
          f"({gate_w:.0f}x{gate_h:.0f}, ratio {gate_w/gate_h:.2f})")
    print(f"    crop  x[{cl}..{cr}] y[{ct}..{cb}] -> {out_path}")
    return out_path


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "config":
        return config_command(sys.argv[2:])

    configs = _load_configs()

    # Read --config up front so its values become the parser defaults and can
    # be overridden by explicit flags (e.g. `--config instagram --size 3000`).
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--config", default=None)
    pre_args, remaining = pre.parse_known_args(sys.argv[1:])

    cfg = {}
    if pre_args.config:
        stored = configs.get(pre_args.config)
        if stored is None:
            print(f"!! unknown config: {pre_args.config}", file=sys.stderr)
            return 1
        if not isinstance(stored, dict):
            print(f"!! invalid config: {pre_args.config}", file=sys.stderr)
            return 1
        cfg = _coerce_config(stored)

    ap = argparse.ArgumentParser(description="rebate — film border cropper")
    ap.add_argument("inputs", nargs="+", help="input image files")
    ap.add_argument("--out", default=".", help="output directory")
    ap.add_argument("--config", default=pre_args.config,
                    help="named config/preset to apply; manage with "
                         "'rebate config save/list/show/delete/rename'")
    _add_common_options(ap, cfg)
    args = ap.parse_args(remaining)

    # Resolve the --offset-x / --offset-y shorthand into the four edge
    # offsets (a specific edge flag wins over the combo).
    explicit = _explicit_option_names(remaining)
    offset_left, offset_right, offset_top, offset_bottom = _resolve_offsets(
        args, explicit)

    # Offsets are deterministic nudges, so they need a fixed base crop. If
    # any offset is in effect, force --border-jitter to 0 (when the user did
    # not set it explicitly), and refuse an explicit non-zero jitter — that
    # combination would keep shifting the edges out from under the offset.
    if _offsets_active(args, explicit, offset_left, offset_right,
                       offset_top, offset_bottom):
        if "border_jitter" in explicit and args.border_jitter != 0:
            print("!! --offset-* needs a stable crop; pass --border-jitter 0 "
                  "(or omit --border-jitter) when using offsets",
                  file=sys.stderr)
            return 1
        args.border_jitter = 0.0

    os.makedirs(args.out, exist_ok=True)

    for path in args.inputs:
        process(path, args.out, args.size, args.margin, args.border,
                args.radius, args.roughness, args.feather, args.seed,
                args.quality, args.sprocket_chance, args.radius_jitter,
                args.square_corner_chance, args.border_jitter,
                args.max_sprocket_border, offset_left, offset_right,
                offset_top, offset_bottom, args.plain, args.debug,
                args.suffix)
    return 0


if __name__ == "__main__":
    sys.exit(main())
