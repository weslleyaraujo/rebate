#!/opt/homebrew/bin/python3.11
"""Launcher for the rebate CLI.

The actual CLI lives in `rebate/cli.py` and delegates image processing to the
pure core in `rebate/core.py` (which is also used by the browser client).
"""

import sys

from rebate.cli import main

if __name__ == "__main__":
    sys.exit(main())
