#!/usr/bin/env bash
# Select which Android modules need `lintDebug` for a set of changed files.
#
# Shared by scripts/prepush-android.sh and the PR Detekt job so the selection
# cannot drift. Reads changed repo-relative paths on stdin (one per line) and
# prints either the single word `all` or one Gradle task per line
# (`:control-proxy:lintDebug`). Prints nothing when no module needs linting.
#
#   sources, resources, manifests, lint baselines -> the owning Android module
#   build-logic, Gradle wiring, a module build script, the lint gate scripts or
#   the workflows that run lint                    -> all
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: git diff --name-only <base>...HEAD | scripts/android/select-lint-modules.sh

Run from the repository root. Prints `all`, or the `:module:lintDebug` tasks for
the Android modules that own the changed files (nothing if none do).
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

lint_all=false
tasks=()
while IFS= read -r changed_file; do
  [[ -n "$changed_file" ]] || continue
  case "$changed_file" in
    scripts/android/check-lint-baseline-shrink.sh|scripts/android/select-lint-modules.sh|scripts/prepush-android.sh|.github/workflows/pull_request.yml|.github/workflows/merge.yml|.github/actions/gradle-task-run/*)
      lint_all=true
      ;;
    android/build-logic/*|android/build.gradle.kts|android/settings.gradle.kts|android/gradle.properties|android/gradle/*|android/gradlew|android/gradlew.bat)
      lint_all=true
      ;;
    android/**/build.gradle.kts|android/**/gradle.properties)
      lint_all=true
      ;;
    android/**/src/*|android/**/lint-baseline.xml)
      module_dir="$(dirname "$changed_file")"
      while [[ "$module_dir" != android && ! -f "$module_dir/build.gradle.kts" ]]; do
        module_dir="$(dirname "$module_dir")"
      done
      if [[ "$module_dir" != android ]] && grep -Eq 'alias\(libs\.plugins\.android\.(application|library)\)|id\("automobile\.android-(library|application)"\)' "$module_dir/build.gradle.kts"; then
        module_path=":${module_dir#android/}"
        tasks+=("${module_path//\//:}:lintDebug")
      fi
      ;;
  esac
done

if [[ "$lint_all" == true ]]; then
  echo all
elif [[ "${#tasks[@]}" -gt 0 ]]; then
  printf '%s\n' ${tasks[@]+"${tasks[@]}"} | sort -u
fi
