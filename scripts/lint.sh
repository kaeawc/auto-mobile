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

oxfmt "$oxfmt_mode" "$@"
oxfmt_status=$?
set -e

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
