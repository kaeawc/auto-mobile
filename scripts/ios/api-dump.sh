#!/usr/bin/env bash
# Extracts all public declarations from the AutoMobile iOS SDK Swift sources
# into a stable, sorted, diffable API surface file.
#
# Usage: scripts/ios/api-dump.sh [--check]
#   --check  Compare output against checked-in api file; exit 1 on diff.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_SOURCES="$REPO_ROOT/ios/auto-mobile-sdk/Sources/AutoMobileSDK"
API_FILE="$REPO_ROOT/ios/auto-mobile-sdk/api/auto-mobile-sdk.api"

if [[ ! -d "$SDK_SOURCES" ]]; then
  echo "error: SDK sources not found at $SDK_SOURCES" >&2
  exit 1
fi

# Count net open parens in a string: ( adds 1, ) subtracts 1
count_paren_depth() {
  local s="$1"
  local opens="${s//[^(]/}"
  local closes="${s//[^)]/}"
  echo $(( ${#opens} - ${#closes} ))
}

# Build the API dump from Swift source files.
generate_api() {
  local current_file=""

  # Emit a file header comment when entering a new source file.
  emit_file_header() {
    local rel="$1"
    if [[ "$current_file" != "$rel" ]]; then
      if [[ -n "$current_file" ]]; then echo ""; fi
      echo "// $rel"
      current_file="$rel"
    fi
  }

  while IFS= read -r swift_file; do
    local rel_path="${swift_file#"$SDK_SOURCES/"}"
    local collecting_multiline=false
    local multiline_buffer=""
    local paren_depth=0

    while IFS= read -r line; do
      local stripped="${line#"${line%%[![:space:]]*}"}"

      # Skip blank lines and comments
      if [[ -z "$stripped" ]] || [[ "$stripped" == //* ]] || [[ "$stripped" == \** ]]; then
        continue
      fi

      # If collecting a multi-line declaration, append
      if [[ "$collecting_multiline" == true ]]; then
        multiline_buffer="$multiline_buffer $stripped"
        paren_depth=$(( paren_depth + $(count_paren_depth "$stripped") ))

        # Declaration complete when parens are balanced (depth <= 0)
        if [[ $paren_depth -le 0 ]]; then
          collecting_multiline=false
          local clean="${multiline_buffer%%\{*}"
          clean="${clean%"${clean##*[![:space:]]}"}"
          emit_file_header "$rel_path"
          echo "  $clean"
        fi
        continue
      fi

      # Detect top-level public type declarations
      if [[ "$stripped" =~ ^public[[:space:]]+(final[[:space:]]+)?(class|struct|enum|protocol)[[:space:]] ]]; then
        local clean="${stripped%%\{*}"
        clean="${clean%"${clean##*[![:space:]]}"}"
        emit_file_header "$rel_path"
        echo "$clean"
        continue
      fi

      # Detect public extension declarations
      if [[ "$stripped" =~ ^public[[:space:]]+extension[[:space:]] ]]; then
        local clean="${stripped%%\{*}"
        clean="${clean%"${clean##*[![:space:]]}"}"
        emit_file_header "$rel_path"
        echo "$clean"
        continue
      fi

      # Detect public members
      if [[ "$stripped" =~ ^(@discardableResult[[:space:]]+)?public[[:space:]] ]]; then
        # Skip type/extension declarations already handled
        if [[ "$stripped" =~ ^public[[:space:]]+(final[[:space:]]+)?(class|struct|enum|protocol|extension)[[:space:]] ]]; then
          continue
        fi

        # Check if this is a multi-line declaration (unbalanced parens)
        paren_depth=$(count_paren_depth "$stripped")
        if [[ $paren_depth -gt 0 ]]; then
          collecting_multiline=true
          multiline_buffer="$stripped"
          continue
        fi

        local member="${stripped%%\{*}"
        member="${member%"${member##*[![:space:]]}"}"
        emit_file_header "$rel_path"
        echo "  $member"
      fi
    done < "$swift_file"
  done < <(find "$SDK_SOURCES" -name "*.swift" -not -name "PrivacyInfo*" | sort)
}

output="$(generate_api)"

if [[ "${1:-}" == "--check" ]]; then
  if [[ ! -f "$API_FILE" ]]; then
    echo "error: API file not found at $API_FILE" >&2
    echo "Run 'scripts/ios/api-dump.sh' to generate it." >&2
    exit 1
  fi
  if ! diff_output="$(diff -u "$API_FILE" <(echo "$output"))"; then
    echo "iOS API surface has changed! Diff:" >&2
    echo "$diff_output" >&2
    echo "" >&2
    echo "To update, run: scripts/ios/api-dump.sh > ios/auto-mobile-sdk/api/auto-mobile-sdk.api" >&2
    exit 1
  fi
  echo "iOS API surface is up to date."
else
  echo "$output"
fi
