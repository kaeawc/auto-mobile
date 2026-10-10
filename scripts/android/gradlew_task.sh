#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/android/gradlew_task.sh <gradle-task-or-flag>...

Runs ./gradlew from android/ with all arguments passed through unchanged.
Combined stdout and stderr are shown and saved under scratch/.

When build-brief is on PATH, CI is unset or empty, and
AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF is unset or empty, runs
`build-brief -- <args>` instead: its summary goes to stdout and the raw log
goes under scratch/ (BUILD_BRIEF_LOG_DIR). Set
AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF=1 to force plain ./gradlew.
EOF
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

case "$1" in
  -h|--help)
    usage
    exit 0
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [[ ! -f "$repo_root/android/gradlew" || ! -x "$repo_root/android/gradlew" ]]; then
  echo "error: $repo_root/android/gradlew is missing or not executable" >&2
  exit 2
fi

mkdir -p "$repo_root/scratch"

use_build_brief=0
if [[ -z "${CI:-}" && -z "${AUTOMOBILE_GRADLEW_NO_BUILD_BRIEF:-}" ]] \
  && command -v build-brief >/dev/null 2>&1; then
  use_build_brief=1
fi

if [[ "$use_build_brief" -eq 1 ]]; then
  # Documented option: BUILD_BRIEF_LOG_DIR (same as --log-dir). build-brief
  # prints its summary and the raw log path; no tee here so the summary is
  # what reaches stdout. Everything after `--` is forwarded to Gradle.
  export BUILD_BRIEF_LOG_DIR="$repo_root/scratch"
  cd "$repo_root/android"
  set +e
  build-brief -- "$@"
  gradle_exit=$?
  set -e
  if [[ "$gradle_exit" -ne 0 ]]; then
    echo "gradlew failed (exit $gradle_exit); build-brief raw log is under: $BUILD_BRIEF_LOG_DIR" >&2
  fi
  exit "$gradle_exit"
fi
log_path="$repo_root/scratch/gradlew-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
cd "$repo_root/android"
echo "gradlew log: $log_path" >&2

# Capture Gradle's status before another command overwrites PIPESTATUS, and
# allow failures to reach the final log-path message despite errexit/pipefail.
set +e
./gradlew "$@" 2>&1 | tee "$log_path"
gradle_exit=${PIPESTATUS[0]}
set -e

echo "gradlew log: $log_path" >&2
exit "$gradle_exit"
