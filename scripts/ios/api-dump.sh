#!/usr/bin/env bash
# Extracts all public declarations from the AutoMobile iOS SDK Swift sources
# into a stable, sorted, diffable API surface file.
#
# Usage: scripts/ios/api-dump.sh [--check]
#   --check  Compare output against checked-in api file; exit 1 on diff.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_SOURCES="${AUTOMOBILE_IOS_API_SOURCES:-$REPO_ROOT/ios/auto-mobile-sdk/Sources/AutoMobileSDK}"
API_FILE="${AUTOMOBILE_IOS_API_FILE:-$REPO_ROOT/ios/auto-mobile-sdk/api/auto-mobile-sdk.api}"

if [[ ! -d "$SDK_SOURCES" ]]; then
  echo "error: SDK sources not found at $SDK_SOURCES" >&2
  exit 1
fi

# Count net open parens in a string into paren_delta, without a subshell.
count_paren_depth() {
  local s="$1"
  local opens="${s//[^(]/}"
  local closes="${s//[^)]/}"
  paren_delta=$(( ${#opens} - ${#closes} ))
}

# Strip the function body's opening brace from a declaration string.
# Unlike ${var%%\{*}, this preserves braces inside default closure values
# (e.g., `timerFactory: @escaping () -> any TimerScheduling = { GCDTimer() }`)
# by finding the last `{` at brace-depth 0—the body opener—and stripping
# from there. Balanced closure defaults like `= { GCDTimer() }` are skipped
# because their `{` is closed by a `}` before the body brace.
# The result is assigned to stripped_signature to avoid a per-member subshell.
strip_body_brace() {
  local s="$1"
  local depth=0
  local i=0
  local len=${#s}
  local last_open_at=-1
  while (( i < len )); do
    local ch="${s:i:1}"
    if [[ "$ch" == "{" ]]; then
      if (( depth == 0 )); then
        last_open_at=$i
      fi
      depth=$((depth + 1))
    elif [[ "$ch" == "}" ]]; then
      depth=$((depth - 1))
    fi
    i=$((i + 1))
  done
  if (( last_open_at >= 0 )); then
    stripped_signature="${s:0:last_open_at}"
  else
    stripped_signature="$s"
  fi
}

# Remove comments and string contents for scope tracking only; emitted signatures
# still use the original text. This is a source scanner, not a Swift parser:
# nested block comments, string interpolation and custom raw-string delimiters
# are not interpreted. Ordinary escaped strings and triple-quoted strings cover
# the SDK's current sources. Conditional-compilation branches are all scanned.
scan_scope_code() {
  local rest="$1" token prefix
  local token_pattern='("""|"([^"\\]|\\.)*"|//.*|/\*)'
  scope_code=""
  while [[ -n "$rest" ]]; do
    if [[ "$in_block_comment" == true ]]; then
      if [[ "$rest" != *\*/* ]]; then
        break
      fi
      rest="${rest#*\*/}"
      in_block_comment=false
    elif [[ "$in_multiline_string" == true ]]; then
      if [[ "$rest" != *\"\"\"* ]]; then
        break
      fi
      rest="${rest#*\"\"\"}"
      in_multiline_string=false
    elif [[ "$rest" =~ $token_pattern ]]; then
      token="${BASH_REMATCH[0]}"
      prefix="${rest%%"$token"*}"
      scope_code="$scope_code$prefix "
      rest="${rest#*"$token"}"
      case "$token" in
        //*) break ;;
        '/*') in_block_comment=true ;;
        '"""') in_multiline_string=true ;;
      esac
    else
      scope_code="$scope_code$rest"
      break
    fi
  done
}

# Build the API dump from Swift source files.
generate_api() {
  local current_file=""
  local paren_delta=0 stripped_signature=""

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
    local brace_depth=0 context_count=0
    local context_depths=() context_kinds=() context_public=()
    local pending_kind="" pending_public=false pending_depth=0
    local scope_code="" in_block_comment=false in_multiline_string=false
    local type_pattern='^((public|open|private|fileprivate|internal)[[:space:]]+)?((final|indirect)[[:space:]]+)?(class|struct|enum|protocol|extension|actor)[[:space:]]'
    local attribute_pattern='^@[[:alnum:]_.]+(\([^)]*\))?[[:space:]]*'
    local member_pattern='^((static|class|mutating|nonmutating|optional|override|final|convenience|required|nonisolated|indirect)[[:space:]]+)*(func|var|let|init[?!]?|subscript|associatedtype|typealias)([[:space:](<]|$)'
    local class_member_pattern='^((public|open|private|fileprivate|internal)[[:space:]]+)?class[[:space:]]+(func|var|subscript)([[:space:](]|$)'

    while IFS= read -r line; do
      local stripped="${line#"${line%%[![:space:]]*}"}"
      # Fast path: most source lines contain no lexical tokens to remove.
      if [[ "$in_block_comment" == true || "$in_multiline_string" == true || "$line" == *\"* || "$line" == */* ]]; then
        scan_scope_code "$line"
      else
        scope_code="$line"
      fi
      local declaration="${scope_code#"${scope_code%%[![:space:]]*}"}"
      if [[ -z "$stripped" || "$stripped" == //* || ( -z "$declaration" && "$collecting_multiline" == false ) ]]; then
        continue
      fi
      while [[ "$declaration" == @* && "$declaration" =~ $attribute_pattern ]]; do
        declaration="${declaration#"${BASH_REMATCH[0]}"}"
      done

      local kind="" visible=false at_type_depth=false
      if (( context_count > 0 )); then
        local parent=$((context_count - 1))
        if (( brace_depth == context_depths[parent] )); then
          at_type_depth=true
          kind="${context_kinds[parent]}"
          visible="${context_public[parent]}"
        fi
      fi

      # Track non-public types too: a public enum nested in an internal type
      # does not expose its cases. A pending context allows a next-line '{'.
      if [[ "$collecting_multiline" == false && ( "$brace_depth" == 0 || "$at_type_depth" == true ) && ! "$declaration" =~ $class_member_pattern && "$declaration" =~ $type_pattern ]]; then
        pending_kind="${BASH_REMATCH[5]}"
        local access="${BASH_REMATCH[2]}"
        pending_depth=$brace_depth
        pending_public=false
        if [[ "$access" == public || "$access" == open || ( -z "$access" && "$kind" == extension && "$visible" == true ) ]]; then
          if (( brace_depth == 0 )) || [[ "$at_type_depth" == true && "$visible" == true ]]; then
            pending_public=true
          fi
        fi
      fi

      # If collecting a multi-line declaration, append
      local signature="" indent="  "
      if [[ "$collecting_multiline" == true ]]; then
        multiline_buffer="$multiline_buffer $stripped"
        count_paren_depth "$stripped"
        paren_depth=$(( paren_depth + paren_delta ))
        # Declaration complete when parens are balanced (depth <= 0)
        if [[ $paren_depth -le 0 ]]; then
          collecting_multiline=false
          signature="$multiline_buffer"
        fi
      elif [[ "$stripped" =~ ^public[[:space:]]+((final|indirect)[[:space:]]+)?(class|struct|enum|protocol|extension)[[:space:]] ]]; then
        # Preserve the existing type headers and member formatting verbatim.
        signature="$stripped"
        indent=""
      else
        local record=false
        if [[ "$stripped" =~ ^(@discardableResult[[:space:]]+)?public[[:space:]] ]]; then
          record=true
        elif [[ "$at_type_depth" == true && "$visible" == true ]]; then
          if [[ "$kind" == enum && "$declaration" =~ ^(indirect[[:space:]]+)?case[[:space:]] ]]; then
            record=true
          elif [[ ( "$kind" == protocol || "$kind" == extension ) && "$declaration" =~ $member_pattern ]]; then
            record=true
          elif [[ "$kind" == extension && "$declaration" =~ $type_pattern && -z "${BASH_REMATCH[2]}" ]]; then
            record=true
          fi
        fi
        if [[ "$record" == true ]]; then
          count_paren_depth "$stripped"
          paren_depth=$paren_delta
          if [[ $paren_depth -gt 0 ]]; then
            collecting_multiline=true
            multiline_buffer="$stripped"
          else
            signature="$stripped"
          fi
        fi
      fi

      if [[ -n "$signature" ]]; then
        local member
        strip_body_brace "$signature"
        member="$stripped_signature"
        member="${member%"${member##*[![:space:]]}"}"
        emit_file_header "$rel_path"
        echo "$indent$member"
      fi

      local opens="${scope_code//[^\{]/}" closes="${scope_code//[^\}]/}"
      if [[ -n "$pending_kind" && -n "$opens" ]]; then
        context_depths[context_count]=$((pending_depth + 1))
        context_kinds[context_count]="$pending_kind"
        context_public[context_count]="$pending_public"
        context_count=$((context_count + 1))
        pending_kind=""
      fi
      brace_depth=$((brace_depth + ${#opens} - ${#closes}))
      # Bash 3.2 evaluates array subscripts even in an arithmetic && branch
      # that would short-circuit; never form index -1 for an empty stack.
      while (( context_count > 0 )); do
        local last_context=$((context_count - 1))
        if (( brace_depth >= context_depths[last_context] )); then
          break
        fi
        context_count=$((context_count - 1))
      done
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
