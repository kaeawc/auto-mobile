#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPRO_SOURCE="${PROJECT_ROOT}/docs/reproductions/sharp-bun-035"
SCRATCH_DIR="${PROJECT_ROOT}/scratch/sharp-bun-0.35-repro"
RUN_DIR="${SCRATCH_DIR}/run"
OUTPUT_FILE="${SCRATCH_DIR}/validate-output.txt"

print_status() {
    printf '[INFO] %s\n' "$1"
}

fail() {
    printf '[ERROR] %s\n' "$1" >&2
    exit 1
}

if [[ ! -d "$REPRO_SOURCE" ]]; then
    fail "Repro directory not found: $REPRO_SOURCE"
fi

if ! command -v bun >/dev/null 2>&1; then
    fail "bun is required to validate the sharp Bun repro"
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR" "$SCRATCH_DIR"
cp "$REPRO_SOURCE"/package.json "$REPRO_SOURCE"/bun.lock "$REPRO_SOURCE"/index.ts "$RUN_DIR"/

print_status "Installing sharp Bun repro dependencies in scratch..."
(
    cd "$RUN_DIR"
    bun install --frozen-lockfile
) > "$OUTPUT_FILE" 2>&1

print_status "Running sharp Bun repro..."
(
    cd "$RUN_DIR"
    bun run repro
) >> "$OUTPUT_FILE" 2>&1

grep -q '"sharp": "0.35.3"' "$OUTPUT_FILE" || fail "Expected sharp 0.35.3 in runtime output"
grep -q '"format": "webp"' "$OUTPUT_FILE" || fail "Expected WebP metadata in repro output"
grep -q '"lossy": [1-9][0-9]*' "$OUTPUT_FILE" || fail "Expected nonzero lossy WebP size"
grep -q '"lossless": [1-9][0-9]*' "$OUTPUT_FILE" || fail "Expected nonzero lossless WebP size"
grep -q '"nearLossless": [1-9][0-9]*' "$OUTPUT_FILE" || fail "Expected nonzero near-lossless WebP size"
grep -q '^ok$' "$OUTPUT_FILE" || fail "Expected final ok marker"

print_status "Sharp Bun repro passed. Output: $OUTPUT_FILE"
