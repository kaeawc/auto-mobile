#!/usr/bin/env bash
#
# validate_workflow_assertion_triggers.sh
#
# Guard the CI trigger contract for workflow-structure tests.
#
# Swift tests run by the `ios-swift-packages` job can assert the structure of
# workflow YAML via loadRepositoryFile(".github/..."). That job is
# gated on the `ios` paths-filter in .github/workflows/pull_request.yml. If an
# asserted .github path is NOT covered by that filter, a change to the workflow
# does not run the tests that validate it, so the drift only surfaces on nightly
# (this is exactly how #3850 broke nightly — see #3862).
#
# This check fails when any .github path asserted by a Swift test is not covered
# by the `ios` filter, forcing the trigger and the assertions to stay in sync.
#
# Scope: this verifies membership in the `ios` filter only. It assumes — but does
# NOT verify — the downstream wiring (`ios` filter -> ios_should_run step ->
# ios-swift-packages job -> the assertion tests). A refactor that renames the
# filter, repoints ios_should_run, or moves the tests to a differently-gated job
# is out of scope and would not be caught here.
#
# Usage:
#   ./scripts/ci/validate_workflow_assertion_triggers.sh
#
# Exit codes:
#   0 - every asserted .github path is covered by the ios filter
#   1 - an asserted .github path is missing from the ios filter
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Scan targets default to the real repo; overridable so tests can point the guard
# at fixtures instead of mutating the tracked workflow / test sources.
SWIFT_TEST_DIR="${WORKFLOW_ASSERTION_SWIFT_DIR:-$PROJECT_ROOT/ios/XCTestRunner/Sources/XCTestRunnerTests}"
WORKFLOW_FILE="${WORKFLOW_ASSERTION_WORKFLOW_FILE:-$PROJECT_ROOT/.github/workflows/pull_request.yml}"

if [[ ! -d "$SWIFT_TEST_DIR" ]]; then
  echo "[ERROR] Swift test directory not found: $SWIFT_TEST_DIR" >&2
  exit 1
fi
if [[ ! -f "$WORKFLOW_FILE" ]]; then
  echo "[ERROR] Workflow file not found: $WORKFLOW_FILE" >&2
  exit 1
fi

# Collect every .github/* path asserted via loadRepositoryFile("...").
asserted_paths=()
while IFS= read -r path; do
  [[ -n "$path" ]] && asserted_paths+=("$path")
done < <(
  grep -rhoE 'loadRepositoryFile\("[^"]+"\)' "$SWIFT_TEST_DIR" 2>/dev/null \
    | sed -E 's/^loadRepositoryFile\("(.*)"\)$/\1/' \
    | grep -E '^\.github/' \
    | sort -u
)

if [[ ${#asserted_paths[@]} -eq 0 ]]; then
  echo "[INFO] No .github paths asserted by Swift tests; nothing to enforce."
  exit 0
fi

# Extract the entries of the `ios:` paths-filter as a newline-separated list.
# The block is the contiguous run of list items / comments indented under the
# `ios:` key inside the filter-ios step; it ends at the first blank line or a
# line dedented to (or past) the `ios:` key. awk (2-arg match, portable across
# BSD/GNU) isolates the block; grep/sed pull the single-quoted glob out of each
# list item.
filter_block="$(
  awk '
    match($0, /^[[:space:]]*ios:[[:space:]]*$/) {
      collecting = 1
      ios_indent = match($0, /[^[:space:]]/)
      next
    }
    collecting {
      if ($0 ~ /^[[:space:]]*$/) { collecting = 0; next }
      first = match($0, /[^[:space:]]/)
      if (first > 0 && first <= ios_indent && substr($0, first, 1) != "-" && substr($0, first, 1) != "#") {
        collecting = 0
        next
      }
      print
    }
  ' "$WORKFLOW_FILE"
)"

filter_entries="$(
  printf '%s\n' "$filter_block" \
    | sed -nE "s/^[[:space:]]*-[[:space:]]*'([^']+)'.*/\1/p"
)"

# A dorny/paths-filter entry covers a path when it matches verbatim, or is a
# `dir/**` glob whose prefix is the path or an ancestor, or a single-level `dir/*`
# glob and the path sits directly under that dir. Inlined (rather than a helper
# invoked in an `if`) so `set -e` stays armed and no SC2310 suppression is added.
missing=()
for path in ${asserted_paths[@]+"${asserted_paths[@]}"}; do
  covered=0
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    if [[ "$entry" == "$path" ]]; then
      covered=1
      break
    elif [[ "$entry" == *"/**" ]]; then
      prefix="${entry%/**}"
      if [[ "$path" == "$prefix" || "$path" == "$prefix"/* ]]; then
        covered=1
        break
      fi
    elif [[ "$entry" == *"/*" ]]; then
      prefix="${entry%/*}"
      if [[ "$path" == "$prefix"/* && "${path#"$prefix"/}" != */* ]]; then
        covered=1
        break
      fi
    fi
  done <<< "$filter_entries"
  [[ "$covered" -eq 0 ]] && missing+=("$path")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  {
    echo "[ERROR] Swift tests assert these .github paths, but the 'ios' paths-filter"
    echo "        in .github/workflows/pull_request.yml does not cover them, so a change"
    echo "        to the file would not run the ios-swift-packages tests that validate it:"
    for path in "${missing[@]}"; do
      echo "          - $path"
    done
    echo
    echo "        Add each path (or a covering glob) to the 'ios:' filter, or drop the"
    echo "        loadRepositoryFile assertion. See #3862 for why this drift is dangerous."
  } >&2
  exit 1
fi

echo "[INFO] All ${#asserted_paths[@]} asserted .github path(s) are covered by the ios filter."
