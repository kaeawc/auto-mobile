#!/usr/bin/env bash
# Task list for the Python SDK (sdk/python), run through uv against the committed uv.lock.
#
# Usage: scripts/validate_python_sdk.sh [task...]
#   lint          ruff check
#   format-check  ruff format --check
#   format        ruff format (rewrites files)
#   typecheck     mypy (strict)
#   test          unittest suite
#   all           lint, format-check, typecheck and test (the default)
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v uv >/dev/null 2>&1; then
  echo 'error: uv is required for the Python SDK tasks; install it from https://docs.astral.sh/uv/' >&2
  exit 2
fi

cd "$ROOT_DIR/sdk/python"
export PYTHONDONTWRITEBYTECODE=1

run_task() {
  case "$1" in
    lint) uv run --locked ruff check ;;
    format-check) uv run --locked ruff format --check ;;
    format) uv run --locked ruff format ;;
    typecheck) uv run --locked mypy ;;
    test) uv run --locked python -m unittest discover -s tests -t . ;;
    all)
      run_task lint
      run_task format-check
      run_task typecheck
      run_task test
      ;;
    *)
      echo "error: unknown task '$1' (lint, format-check, format, typecheck, test, all)" >&2
      return 2
      ;;
  esac
}

uv sync --locked --quiet
if [[ $# -eq 0 ]]; then
  set -- all
fi
for task in "$@"; do
  echo "==> python-sdk ${task}"
  run_task "$task"
done
