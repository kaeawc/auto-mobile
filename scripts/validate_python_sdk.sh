#!/usr/bin/env bash
# Run the Python SDK's unit tests (sdk/python). Standard library only: no venv or install.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python="${PYTHON:-python3}"
if ! command -v "$python" >/dev/null 2>&1 || ! "$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "error: the Python SDK tests need Python 3.10 or newer; set PYTHON or install python3" >&2
  exit 2
fi
cd "$ROOT_DIR/sdk/python"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="src${PYTHONPATH:+:$PYTHONPATH}"
exec "$python" -m unittest discover -s tests -t .
