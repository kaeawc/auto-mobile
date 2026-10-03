#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/android/gradlew_task.sh <gradle-task-or-flag>...

Runs ./gradlew from android/ with all arguments passed through unchanged.
Combined stdout and stderr are shown and saved under scratch/.
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
