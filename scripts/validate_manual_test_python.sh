#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  if [[ "${1:-}" == --skip-unavailable ]]; then
    echo 'notice: manual-test-python skipped: changed-file runner has no Python 3.11+; Fast Validation runs the check with Python 3.11'
    exit 0
  fi
  echo 'error: Python 3.11 or newer is required for manual-test-python' >&2
  exit 2
fi
mkdir -p "$ROOT_DIR/scratch/manual-test-python"
python="$(bash "$ROOT_DIR/scripts/manual-test/python/setup-venv.sh" --batch-dir "$ROOT_DIR/scratch/manual-test-python")"
cd "$ROOT_DIR"
export PYTHONDONTWRITEBYTECODE=1
exec "$python" -m unittest discover -s scripts/manual-test/python/tests -t scripts/manual-test/python
