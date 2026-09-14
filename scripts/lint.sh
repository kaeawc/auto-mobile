#!/usr/bin/env bash

set -euo pipefail

set +e
oxlint --fix "$@"
oxlint_status=$?
oxfmt --write "$@"
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
