#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python=python3
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  if command -v uv >/dev/null 2>&1; then
    if ! python="$(uv python find '>=3.11')"; then
      if ! uv python install 3.11 >&2 || ! python="$(uv python find 3.11)"; then
        echo 'error: Python 3.11 or newer is required; provide python3 >=3.11 or uv with a managed interpreter' >&2
        exit 2
      fi
    fi
  else
    echo 'error: Python 3.11 or newer is required; provide python3 >=3.11 or uv with a managed interpreter' >&2
    exit 2
  fi
fi
# Hermetic callers may override the batch directory with an absolute existing directory only.
batch_dir="${MANUAL_TEST_PYTHON_BATCH_DIR:-$ROOT_DIR/scratch/manual-test-python}"
if [[ -n "${MANUAL_TEST_PYTHON_BATCH_DIR:-}" ]]; then
  if [[ "$batch_dir" != /* || ! -d "$batch_dir" ]]; then
    echo 'error: MANUAL_TEST_PYTHON_BATCH_DIR must be an absolute existing directory' >&2
    exit 2
  fi
else
  mkdir -p "$batch_dir"
fi
python="$(bash "$ROOT_DIR/scripts/manual-test/python/setup-venv.sh" --batch-dir "$batch_dir" --python "$python")"
cd "$ROOT_DIR"
export PYTHONDONTWRITEBYTECODE=1
exec "$python" -m unittest discover -s scripts/manual-test/python/tests -t scripts/manual-test/python
