#!/usr/bin/env bash
#
# Resolve the narrowest set of detekt Gradle tasks that still covers a change.
#
# detekt with type resolution has to compile a module's classpath before it can
# analyze it, so running the whole tree costs ~7 minutes of CI. Most PRs touch
# one or two modules, so this maps changed Kotlin sources back to the Gradle
# modules that own them and emits only those modules' detekt tasks.
#
# Usage:
#   scripts/android/detekt_scope.sh --since <base-sha>
#   ONLY_CHANGED_SINCE_SHA=<base-sha> scripts/android/detekt_scope.sh
#
# Emits a space-separated Gradle task list on stdout, e.g.
#   :protocol:detektMain :protocol:detektTest
# or the empty string when no Kotlin source changed and there is nothing to run.
# Callers must treat empty output as "skip detekt entirely".
#
# Fails *open* (emits the full-tree task list) whenever scoping cannot be proven
# safe: no base SHA, an unresolvable base SHA, a root build file change, or a
# module directory that is not an included Gradle project. A needlessly-full run
# is slow; a wrongly-narrow run lets a violation reach main.
#
# Scoping is deliberately per-module and does NOT walk down to dependent
# modules: a change to :protocol will not re-run detekt on the modules that
# consume it. detekt rules are almost entirely file-local, and merge.yml runs
# the full tree post-merge as the backstop for the residual risk.

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
ANDROID_DIR="android"

# Every detekt task in the project, used when scoping cannot be proven safe.
FULL_SCOPE="detektMain detektTest"

BASE_SHA="${ONLY_CHANGED_SINCE_SHA:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      BASE_SHA="${2:-}"
      shift 2
      ;;
    *)
      echo "detekt_scope.sh: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

# Walk up from a changed file to the nearest ancestor that owns a build file --
# that directory is the Gradle module. Stops at android/ so a stray file outside
# any module cannot escape upward into the repo root. Emits the module directory
# relative to android/, or nothing when the file belongs to no module (e.g. the
# whole module was deleted in this diff).
module_dir_for() {
  local file="$1"
  local dir
  dir="$(dirname "$file")"

  while [[ "$dir" != "." && "$dir" != "/" ]]; do
    if [[ "$dir" == "$ANDROID_DIR" ]]; then
      return 0
    fi
    if [[ -f "$PROJECT_ROOT/$dir/build.gradle.kts" ]]; then
      printf '%s\n' "${dir#"$ANDROID_DIR"/}"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
}

SETTINGS_FILE="$PROJECT_ROOT/$ANDROID_DIR/settings.gradle.kts"

# Predicates are inlined as `case`/`grep` at their call sites rather than
# extracted into helper functions: a function called in an `if`/`!`/`||`
# condition disables `set -e` inside it (SC2310), which this repo gates on.
if ! command -v git > /dev/null 2>&1; then
  echo "detekt_scope.sh: git is required" >&2
  exit 1
fi

# No base to diff against -- cannot scope, so run everything.
if [[ -z "$BASE_SHA" ]]; then
  printf '%s\n' "$FULL_SCOPE"
  exit 0
fi

if ! git -C "$PROJECT_ROOT" rev-parse --verify --quiet "$BASE_SHA^{commit}" > /dev/null; then
  echo "detekt_scope.sh: base SHA '$BASE_SHA' does not resolve; running full scope" >&2
  printf '%s\n' "$FULL_SCOPE"
  exit 0
fi

# No --diff-filter here: a *deleted* Kotlin file still changes what its module
# analyzes, so the module must be re-run. The module-dir walk above already
# drops files whose module no longer exists.
changed_files="$(git -C "$PROJECT_ROOT" diff --name-only "$BASE_SHA...HEAD" -- "$ANDROID_DIR")"

modules=()
saw_kotlin=false

while read -r file; do
  [[ -n "$file" ]] || continue

  # Root build files change the analysis config or every module's classpath, so
  # a scoped run would not be representative. detekt.yml is in here because
  # enabling a rule set must re-analyze everything, not just the diff.
  case "$file" in
    "$ANDROID_DIR"/settings.gradle.kts | \
      "$ANDROID_DIR"/build.gradle.kts | \
      "$ANDROID_DIR"/gradle.properties | \
      "$ANDROID_DIR"/gradle/libs.versions.toml | \
      "$ANDROID_DIR"/gradle/wrapper/* | \
      "$ANDROID_DIR"/config/detekt/*)
      printf '%s\n' "$FULL_SCOPE"
      exit 0
      ;;
  esac

  case "$file" in
    *.kt | *.kts) ;;
    *) continue ;;
  esac
  saw_kotlin=true

  module_dir="$(module_dir_for "$file")"
  [[ -n "$module_dir" ]] || continue

  # android/playground/design/system -> :playground:design:system
  gradle_path=":${module_dir//\//:}"

  # Confirm the derived path is a real Gradle project before handing it to
  # gradlew: a directory with a build.gradle.kts that settings.gradle.kts never
  # includes would fail the build on an otherwise-unrelated PR. Fixed-string
  # match on the include() call, not a parse of the Kotlin.
  if ! grep -qF "include(\"$gradle_path\")" "$SETTINGS_FILE"; then
    echo "detekt_scope.sh: '$gradle_path' is not an included project; running full scope" >&2
    printf '%s\n' "$FULL_SCOPE"
    exit 0
  fi

  modules+=("$gradle_path")
done <<< "$changed_files"

# Kotlin changed but every file resolved to a deleted module: nothing to analyze
# there, but do not silently pass on a diff we could not place.
if [[ "$saw_kotlin" == "true" && ${#modules[@]} -eq 0 ]]; then
  printf '%s\n' "$FULL_SCOPE"
  exit 0
fi

if [[ ${#modules[@]} -eq 0 ]]; then
  exit 0
fi

tasks=()
while read -r gradle_path; do
  [[ -n "$gradle_path" ]] || continue
  tasks+=("$gradle_path:detektMain" "$gradle_path:detektTest")
done <<< "$(printf '%s\n' "${modules[@]}" | sort -u)"

printf '%s\n' "${tasks[*]}"
