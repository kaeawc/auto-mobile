#!/usr/bin/env bash
# Generate Dokka HTML API documentation for the Android SDK.
#
# Usage:
#   scripts/android/generate-dokka.sh [--output-dir <dir>]
#
# Default output: android/auto-mobile-sdk/build/dokka/html/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

echo "Generating Dokka HTML docs..."
"${REPO_ROOT}/android/gradlew" -p "${REPO_ROOT}/android" \
  :auto-mobile-sdk:dokkaGeneratePublicationHtml

DOKKA_OUTPUT="${REPO_ROOT}/android/auto-mobile-sdk/build/dokka/html"

if [[ ! -d "$DOKKA_OUTPUT" ]]; then
  echo "ERROR: Dokka output not found at $DOKKA_OUTPUT" >&2
  exit 1
fi

echo "Dokka HTML generated at: $DOKKA_OUTPUT"

if [[ -n "$OUTPUT_DIR" ]]; then
  mkdir -p "$OUTPUT_DIR"
  cp -r "$DOKKA_OUTPUT"/* "$OUTPUT_DIR"/
  echo "Copied to: $OUTPUT_DIR"
fi
