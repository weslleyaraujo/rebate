#!/bin/bash
# Test-image generator for rebate.py.
#
# Usage:
#   ./play.sh DIR [rebate flags...]
#
# Finds *-positive.jpg images under DIR (recursively, skipping any
# "borderless" folders), samples every STEPth frame (default 3), and runs
# rebate.py on them. Extra flags are forwarded to rebate.py.
#
# Examples:
#   ./play.sh ~/Pictures
#   ./play.sh ~/Pictures --seed 42 --size 3000
#   STEP=1 OUT=/tmp/x ./play.sh ~/Pictures --sprocket-chance 0.3
set -euo pipefail

PY="${PY:-/opt/homebrew/bin/python3.11}"
OUT="${OUT:-./out-play}"
STEP="${STEP:-3}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

scan_dir="${1:?usage: play.sh DIR [rebate flags...]}"
shift

files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find "$scan_dir" -type f -name '*-positive.jpg' -print \
         | grep -v borderless | sort \
         | awk -v s="$STEP" 'NR % s == 1 || s == 1')

if [ "${#files[@]}" -eq 0 ]; then
  echo "no *-positive.jpg found under $scan_dir" >&2
  exit 1
fi

echo "processing ${#files[@]} images -> $OUT"
exec "$PY" "$DIR/rebate.py" "${files[@]}" --out "$OUT" "$@"
