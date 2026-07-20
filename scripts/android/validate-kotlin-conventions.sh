#!/usr/bin/env bash
#
# Enforce a small set of Kotlin reuse conventions that have caused real duplication.
# This is intentionally narrow: general Kotlin style belongs to ktfmt and code review.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
ONLY_CHANGED_SINCE_SHA="${ONLY_CHANGED_SINCE_SHA:-}"

# shellcheck source=scripts/lib/file-selection.sh disable=SC1091
source "$PROJECT_ROOT/scripts/lib/file-selection.sh"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command '$1' is not available." >&2
    exit 1
  fi
}

require_command git
require_command rg

readonly KOTLIN_FILE_REGEX='^.*\.kt$'
readonly SHARED_VALIDATOR="$PROJECT_ROOT/android/test-plan-validation/src/main/kotlin/dev/jasonpearson/automobile/validation/TestPlanValidator.kt"
readonly SHARED_URI_BUILDER="$PROJECT_ROOT/android/desktop-core/src/main/kotlin/dev/jasonpearson/automobile/desktop/core/daemon/ResourceUriBuilder.kt"
readonly RUNNER_TIMING_CACHE="$PROJECT_ROOT/android/junit-runner/src/main/kotlin/dev/jasonpearson/automobile/junit/TestTimingCache.kt"

declare -a files_to_check=()

load_changed_files() {
  local file_list
  file_list="$(mktemp)"

  if [[ -n "$ONLY_CHANGED_SINCE_SHA" ]]; then
    if ! collect_changed_since_sha "$PROJECT_ROOT" "$ONLY_CHANGED_SINCE_SHA" "$KOTLIN_FILE_REGEX" >"$file_list"; then
      echo "Unable to collect Kotlin files changed since $ONLY_CHANGED_SINCE_SHA." >&2
      exit 1
    fi
  else
    if ! collect_touched_files "$PROJECT_ROOT" "$KOTLIN_FILE_REGEX" >"$file_list"; then
      echo "Unable to collect touched Kotlin files." >&2
      exit 1
    fi
    git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -- '*.kt' \
      | while IFS= read -r file; do printf '%s/%s\n' "$PROJECT_ROOT" "$file"; done >>"$file_list"
  fi

  while IFS= read -r file; do
    [[ -n "$file" ]] && files_to_check+=("$file")
  done < <(sort -u "$file_list")
  rm -f "$file_list"
}

failures=0

report_failure() {
  echo "$1" >&2
  failures=1
}

load_changed_files

# A utility file hides ownership and makes it easy to bypass a purpose-built or
# standard API. Existing code has no *Util.kt files, so this is safe to gate.
for file in "${files_to_check[@]}"; do
  if [[ "$(basename "$file")" == *Util.kt ]]; then
    report_failure "Kotlin convention violation: avoid new generic utility files: ${file#"$PROJECT_ROOT"/}"
  fi
done

# The IDE plugin must consume the shared validator rather than grow a second
# parser/schema implementation. A filesystem check catches an accidental copy
# even when it is not part of the changed-file selection.
validator_files=()
while IFS= read -r file; do
  validator_files+=("$file")
done < <(find "$PROJECT_ROOT/android" -path '*/build' -prune -o -name TestPlanValidator.kt -print | sort)
if [[ "${#validator_files[@]}" -ne 1 || "${validator_files[0]:-}" != "$SHARED_VALIDATOR" ]]; then
  report_failure "Kotlin convention violation: TestPlanValidator must exist only in :test-plan-validation."
  printf 'Found:\n%s\n' "${validator_files[@]:-<none>}" >&2
fi

# Keep form-style query encoding in one desktop-core implementation. The
# junit-runner exception is deliberately allowed because it cannot depend on
# desktop-core without reversing the module graph.
encoder_files=()
while IFS= read -r file; do
  encoder_files+=("$file")
done < <(rg -l --glob '*.kt' 'URLEncoder\.encode' "$PROJECT_ROOT/android" | sort)
expected_encoders=("$SHARED_URI_BUILDER" "$RUNNER_TIMING_CACHE")
if [[ "${encoder_files[*]}" != "${expected_encoders[*]}" ]]; then
  report_failure "Kotlin convention violation: query parameter encoding must use ResourceUriBuilder outside junit-runner."
  printf 'Found:\n%s\n' "${encoder_files[@]:-<none>}" >&2
fi

if [[ "$failures" -ne 0 ]]; then
  exit 1
fi

echo "Kotlin convention checks passed."
