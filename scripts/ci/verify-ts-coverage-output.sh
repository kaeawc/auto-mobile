#!/usr/bin/env bash
#
# Verify Bun produced lcov output, recovering the known atomic-write temp file
# when needed.
#
# Usage:
#   scripts/ci/verify-ts-coverage-output.sh [coverage-dir]

set -euo pipefail

coverage_dir="${1:-coverage}"
lcov_file="${coverage_dir}/lcov.info"

if [[ ! -f "${lcov_file}" ]]; then
  tmp="$(find "${coverage_dir}/" -name '.lcov.info.*.tmp' 2>/dev/null | head -n 1 || true)"
  if [[ -n "${tmp}" ]]; then
    echo "Recovering coverage from temp file: ${tmp}"
    mv "${tmp}" "${lcov_file}"
  else
    echo "::error::${lcov_file} not found"
    ls -la "${coverage_dir}/" 2>/dev/null || echo "${coverage_dir}/ directory does not exist"
    exit 1
  fi
fi

echo "Coverage file size: $(wc -c < "${lcov_file}") bytes"
