#!/usr/bin/env bash

set -euo pipefail

oxfmt_mode=--write
# Only these CI values enable read-only checks; unset/empty/false stay local.
set +e
case "${CI:-}" in
  true | 1)
    oxlint "$@"
    oxlint_status=$?
    oxfmt_mode=--check
    ;;
  *)
    oxlint --fix "$@"
    oxlint_status=$?
    ;;
esac

runner_os="${RUNNER_OS:-}"
if [[ "$oxfmt_mode" == --check && -z "$runner_os" ]]; then
  case "$(uname -s 2> /dev/null || true)" in
    Darwin) runner_os="macOS" ;;
    MINGW* | MSYS* | CYGWIN*) runner_os="Windows" ;;
  esac
fi

oxfmt_status=0
if [[ "$oxfmt_mode" == --check && "$runner_os" == Windows ]]; then
  echo "format is gated on Linux (format-check job); skipped on Windows: CRLF checkout" >&2
else
  oxfmt "$oxfmt_mode" "$@"
  oxfmt_status=$?
fi
set -e

if [[ "$oxfmt_mode" == --check ]] && [[ "$oxlint_status" -ne 0 || "$oxfmt_status" -ne 0 ]]; then
  echo "CI lint check failed: run 'bun run lint' locally (without CI set) to apply fixes, or 'bun run format' for formatting." >&2
fi

if [[ "$oxlint_status" -ne 0 ]]; then
  # Baseline and boundary checks require an oxlint-clean tree, so skip them on failure.
  echo "oxlint failed; skipping baseline and boundary checks." >&2
  exit "$oxlint_status"
fi

if [[ "$oxfmt_status" -ne 0 ]]; then
  exit "$oxfmt_status"
fi

bash scripts/oxlint-baseline.sh
bash scripts/check-boundaries.sh

bash scripts/check-element-resolution-ratchet.sh
