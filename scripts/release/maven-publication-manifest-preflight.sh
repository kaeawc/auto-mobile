#!/usr/bin/env bash
#
# Release-CI orchestration for the Maven Central publication manifest preflight
# (issue #4853). Extracted from release.yml so it can be run and linted on its
# own. It stages every publishable module to the local `centralManifest` Maven
# repository, runs the manifest generator with the advisory budget, writes the
# full manifest to a file, and appends a totals block to the job summary.
#
# It never publishes remotely and never blocks a release: the budget is advisory
# (the generator is run without --strict, so it always exits 0).
#
# Environment:
#   VERSION               release version for -PVERSION_NAME. Required unless
#                         STAGING_DIR is set.
#   STAGING_DIR           use this already-staged local Maven repo and SKIP the
#                         Gradle staging step. For local re-runs and tests.
#   MANIFEST_OUT          also write the full manifest here (default: stdout only).
#   GITHUB_STEP_SUMMARY   if set (GitHub Actions sets it), append the totals block.
#   ANDROID_DIR           Gradle project directory (default: <repo>/android).
#
# Usage:
#   VERSION=0.0.47 scripts/release/maven-publication-manifest-preflight.sh
#   STAGING_DIR=android/build/central-manifest \
#     scripts/release/maven-publication-manifest-preflight.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
android_dir="${ANDROID_DIR:-$repo_root/android}"
budget="$here/maven-usage-budget.json"
generator="$here/maven-publication-manifest.sh"

# The four published Maven coordinates. Kept here (not in the workflow) so the
# staging command is versioned, linted, and runnable on its own.
modules=(
  ":protocol"
  ":test-plan-validation"
  ":junit-runner"
  ":auto-mobile-sdk"
)

if [ -n "${STAGING_DIR:-}" ]; then
  staging_dir="$STAGING_DIR"
else
  : "${VERSION:?VERSION is required to stage the publication (or set STAGING_DIR)}"
  staging_dir="$android_dir/build/central-manifest"
  tasks=()
  for m in "${modules[@]}"; do
    tasks+=("$m:publishAllPublicationsToCentralManifestRepository")
  done
  (
    cd "$android_dir"
    rm -rf build/central-manifest
    ./gradlew ${tasks[@]+"${tasks[@]}"} -PVERSION_NAME="$VERSION" --no-configuration-cache
  )
fi

# Advisory only: no --strict, so the generator exits 0 even over budget or with
# unexpected files. The full manifest and the WARN lines still surface below.
manifest="$("$generator" "$staging_dir" --budget "$budget")"

printf '%s\n' "$manifest"

if [ -n "${MANIFEST_OUT:-}" ]; then
  printf '%s\n' "$manifest" >"$MANIFEST_OUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Maven Central publication manifest"
    echo ""
    echo '```'
    # Totals only in the summary; the full per-file manifest is MANIFEST_OUT.
    printf '%s\n' "$manifest" | sed -n '/## Per-coordinate totals/,$p'
    echo '```'
  } >>"$GITHUB_STEP_SUMMARY"
fi
