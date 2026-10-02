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

# Recognize an accessor list with a small token state machine. Attributes and
# source order are retained; whitespace is normalized for either spelling.
# Invalid/body-like groups fall back to emitting just the declaration.
normalize_accessors() {
  local rest="$1" word attribute last_accessor="" waiting=false seen=false
  local i depth ch
  accessor_list_valid=false
  accessor_text=""
  while [[ -n "$rest" ]]; do
    rest="${rest#"${rest%%[![:space:]]*}"}"
    [[ -n "$rest" ]] || break
    if [[ "$rest" == @* && "$rest" =~ $attribute_pattern ]]; then
      attribute="${BASH_REMATCH[0]}"
      rest="${rest#"$attribute"}"
      attribute="${attribute%"${attribute##*[![:space:]]}"}"
      accessor_text="${accessor_text:+$accessor_text }$attribute"
      waiting=true
      continue
    fi
    if [[ "$rest" == throws\(* ]]; then
      # Keep the complete type verbatim, including spaces in generic arguments
      # and nested parentheses, rather than splitting it into whitespace tokens.
      i=6
      depth=0
      while (( i < ${#rest} )); do
        ch="${rest:i:1}"
        case "$ch" in
          '(') depth=$((depth + 1)) ;;
          ')') depth=$((depth - 1)) ;;
        esac
        i=$((i + 1))
        (( depth > 0 )) || break
      done
      (( depth == 0 )) || return 0
      word="${rest:0:i}"
      rest="${rest:i}"
      [[ -z "$rest" || "$rest" == [[:space:]]* ]] || return 0
    else
      word="${rest%%[[:space:]]*}"
      rest="${rest#"$word"}"
    fi
    accessor_text="${accessor_text:+$accessor_text }$word"
    case "$word" in
      mutating|nonmutating) waiting=true; last_accessor="" ;;
      get|set|_read|_modify|willSet|didSet)
        last_accessor="$word"; waiting=false; seen=true ;;
      async|throws|throws\(*\)) [[ "$last_accessor" == get && "$waiting" == false ]] || return 0 ;;
      *) return 0 ;;
    esac
  done
  if [[ "$seen" == true && "$waiting" == false ]]; then
    accessor_list_valid=true
  fi
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
  local group_close_at=-1
  while (( i < len )); do
    local ch="${s:i:1}"
    if [[ "$ch" == "{" ]]; then
      if (( depth == 0 )); then
        last_open_at=$i
        group_close_at=-1
      fi
      depth=$((depth + 1))
    elif [[ "$ch" == "}" ]]; then
      depth=$((depth - 1))
      if (( depth == 0 )); then
        group_close_at=$i
      fi
    fi
    i=$((i + 1))
  done
  if (( last_open_at >= 0 )); then
    stripped_signature="${s:0:last_open_at}"
    # Protocol accessor requirements use the same normalization as collected
    # multi-line blocks; computed-property bodies remain declaration-only.
    if [[ "${2:-}" == protocol ]] && (( group_close_at > last_open_at )); then
      # Shadow the caller's scanner state: only this brace group's comments
      # are removed, and strings in attributes retain their original contents.
      local in_block_comment=false in_multiline_string=false
      local scope_code="" signature_code=""
      scan_scope_code "${s:last_open_at+1:group_close_at-last_open_at-1}"
      normalize_accessors "$signature_code"
      if [[ "$accessor_list_valid" == true ]]; then
        stripped_signature="${stripped_signature%"${stripped_signature##*[![:space:]]}"} { $accessor_text }${s:group_close_at+1}"
      fi
    fi
  else
    stripped_signature="$s"
  fi
}

# Remove comments and string contents for scope tracking only; emitted signatures
# still use the original text. signature_code also removes comments but keeps
# ordinary quoted strings for accessor attributes. This is a source scanner,
# not a Swift parser:
# nested block comments, string interpolation and custom raw-string delimiters
# are not interpreted. Ordinary escaped strings and triple-quoted strings cover
# the SDK's current sources. Conditional-compilation branches are all scanned.
scan_scope_code() {
  local rest="$1" token prefix
  local token_pattern='("""|"([^"\\]|\\.)*"|//.*|/\*)'
  scope_code=""
  signature_code=""
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
      signature_code="$signature_code$prefix"
      rest="${rest#*"$token"}"
      case "$token" in
        //*) break ;;
        '/*') in_block_comment=true; signature_code="$signature_code " ;;
        '"""') in_multiline_string=true ;;
        *) signature_code="$signature_code$token" ;;
      esac
    else
      scope_code="$scope_code$rest"
      signature_code="$signature_code$rest"
      break
    fi
  done
}

# Build the API dump from Swift source files.
generate_api() {
  local current_file=""
  local paren_delta=0 stripped_signature=""
  local accessor_list_valid=false accessor_text=""
  local type_pattern='^((public|open|private|fileprivate|internal)[[:space:]]+)?((final|indirect)[[:space:]]+)?(class|struct|enum|protocol|extension|actor)[[:space:]]'
  local type_name_pattern='^([[:alnum:]_]+)([[:space:]<{:]|$)'
  local attribute_pattern='^@[[:alnum:]_.]+(\([^)]*\))?[[:space:]]*'
  local public_types=" " swift_files
  # Files are sorted by relative path in C-locale byte order. Declarations
  # within each file stay in source order, under a '// <relpath>' header.
  swift_files="$(find "$SDK_SOURCES" -name "*.swift" -not -name "PrivacyInfo*" | LC_ALL=C sort)"

  # First pass: collect only public/open top-level type names module-wide.
  # Reuse lexical handling so comments, strings and nested types cannot add
  # names. No declaration/context machinery is needed in this cheap pass.
  while IFS= read -r swift_file; do
    [[ -n "$swift_file" ]] || continue
    local brace_depth=0 scope_code="" signature_code=""
    local in_block_comment=false in_multiline_string=false
    while IFS= read -r line; do
      local stripped="${line#"${line%%[![:space:]]*}"}"
      if [[ "$in_block_comment" == true || "$in_multiline_string" == true || "$line" == *\"* || "$line" == */* ]]; then
        scan_scope_code "$stripped"
      else
        scope_code="$stripped"
      fi
      if (( brace_depth == 0 )); then
        local declaration="${scope_code#"${scope_code%%[![:space:]]*}"}"
        while [[ "$declaration" == @* && "$declaration" =~ $attribute_pattern ]]; do
          declaration="${declaration#"${BASH_REMATCH[0]}"}"
        done
        if [[ "$declaration" =~ $type_pattern ]]; then
          local access="${BASH_REMATCH[2]}" type_kind="${BASH_REMATCH[5]}"
          local type_name="${declaration#"${BASH_REMATCH[0]}"}"
          if [[ ( "$access" == public || "$access" == open ) && "$type_kind" != extension && "$type_name" =~ $type_name_pattern ]]; then
            public_types="$public_types${BASH_REMATCH[1]} "
          fi
        fi
      fi
      local opens="${scope_code//[^\{]/}" closes="${scope_code//[^\}]/}"
      brace_depth=$((brace_depth + ${#opens} - ${#closes}))
    done < "$swift_file"
  done <<< "$swift_files"

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
    [[ -n "$swift_file" ]] || continue
    local rel_path="${swift_file#"$SDK_SOURCES/"}"
    local collecting_multiline=false
    local collecting_case=false
    local multiline_buffer=""
    local paren_depth=0
    local brace_depth=0 context_count=0
    local context_depths=() context_kinds=() context_public=() context_default_public=()
    local pending_kind="" pending_public=false pending_depth=0
    local pending_default_public=false
    local pending_attributes=""
    local held_member="" held_indent=""
    local scope_code="" signature_code="" in_block_comment=false in_multiline_string=false
    local accessor_pending=false collecting_accessors=false accessor_depth=0
    local accessor_buffer="" requirement_accessors=false
    local member_pattern='^((static|class|mutating|nonmutating|optional|override|final|convenience|required|nonisolated|indirect)[[:space:]]+)*(func|var|let|init[?!]?|subscript|associatedtype|typealias)([[:space:](<]|$)'
    local class_member_pattern='^((public|open|private|fileprivate|internal)[[:space:]]+)?class[[:space:]]+(func|var|subscript)([[:space:](]|$)'

    while IFS= read -r line; do
      local stripped="${line#"${line%%[![:space:]]*}"}"
      if [[ "$stripped" =~ ^(@discardableResult[[:space:]]+)?override[[:space:]]+public[[:space:]]+(.*)$ ]]; then
        stripped="${BASH_REMATCH[1]}public override ${BASH_REMATCH[2]}"
      fi
      # Fast path: most source lines contain no lexical tokens to remove.
      if [[ "$in_block_comment" == true || "$in_multiline_string" == true || "$line" == *\"* || "$line" == */* ]]; then
        scan_scope_code "$stripped"
      else
        scope_code="$stripped"
        signature_code="$stripped"
      fi
      local declaration="${scope_code#"${scope_code%%[![:space:]]*}"}"
      if [[ -z "$stripped" || "$stripped" == //* || ( -z "$declaration" && "$collecting_multiline" == false ) ]]; then
        continue
      fi
      local opens="${scope_code//[^\{]/}" closes="${scope_code//[^\}]/}"
      local accessor_line_consumed=false
      if [[ "$accessor_pending" == true ]]; then
        accessor_pending=false
        if [[ "$declaration" == \{* ]]; then
          collecting_accessors=true
          accessor_depth=$((brace_depth + 1))
          local accessor_line="${signature_code#"${signature_code%%[![:space:]]*}"}"
          accessor_buffer="${accessor_line#\{}"
          accessor_line_consumed=true
          if (( brace_depth + ${#opens} - ${#closes} < accessor_depth )); then
            strip_body_brace "$held_member $accessor_line" protocol
            held_member="$stripped_signature"
            collecting_accessors=false
          fi
        fi
      elif [[ "$collecting_accessors" == true ]]; then
        accessor_line_consumed=true
        if (( brace_depth + ${#opens} - ${#closes} < accessor_depth )); then
          accessor_buffer="$accessor_buffer ${signature_code%%\}*}"
          normalize_accessors "$accessor_buffer"
          if [[ "$accessor_list_valid" == true ]]; then
            held_member="$held_member { $accessor_text }"
          fi
          collecting_accessors=false
        else
          accessor_buffer="$accessor_buffer $signature_code"
        fi
      fi
      # Accessor lines bypass declaration emission but still reach the shared
      # brace/context update below, including a next-line opening brace.
      if [[ "$accessor_line_consumed" == false ]]; then
        # Hold each completed signature until the next non-empty code line so
        # a following where clause can join it. Flush before any other code.
        local where_continuation=false
        if [[ -n "$held_member" ]]; then
          if [[ "$declaration" =~ ^where([[:space:]]|$) ]]; then
            strip_body_brace "$stripped"
            local where_words=()
            read -r -a where_words <<< "$stripped_signature"
            held_member="$held_member ${where_words[*]}"
            where_continuation=true
          fi
          emit_file_header "$rel_path"
          echo "$held_indent$held_member"
          held_member=""
        fi
        while [[ "$declaration" == @* && "$declaration" =~ $attribute_pattern ]]; do
          declaration="${declaration#"${BASH_REMATCH[0]}"}"
        done
        if [[ -z "$declaration" && "$stripped" == @* ]]; then
          pending_attributes="${pending_attributes:+$pending_attributes }${stripped%"${stripped##*[![:space:]]}"}"
          continue
        fi

        local kind="" visible=false at_type_depth=false default_public=false
        if (( context_count > 0 )); then
          local parent=$((context_count - 1))
          if (( brace_depth == context_depths[parent] )); then
            at_type_depth=true
            kind="${context_kinds[parent]}"
            visible="${context_public[parent]}"
            default_public="${context_default_public[parent]}"
          fi
        fi

        # Track non-public types too: a public enum nested in an internal type
        # does not expose its cases. A pending context allows a next-line '{'.
        if [[ "$collecting_multiline" == false && ( "$brace_depth" == 0 || "$at_type_depth" == true ) && ! "$declaration" =~ $class_member_pattern && "$declaration" =~ $type_pattern ]]; then
          pending_kind="${BASH_REMATCH[5]}"
          local access="${BASH_REMATCH[2]}"
          local type_name="${declaration#"${BASH_REMATCH[0]}"}"
          if [[ "$type_name" =~ $type_name_pattern ]]; then
            type_name="${BASH_REMATCH[1]}"
          else
            type_name=""
          fi
          pending_depth=$brace_depth
          pending_public=false
          pending_default_public=false
          if [[ "$access" == public || "$access" == open || ( -z "$access" && "$kind" == extension && "$default_public" == true ) ]]; then
            if (( brace_depth == 0 )) || [[ "$at_type_depth" == true && "$visible" == true ]]; then
              pending_public=true
              pending_default_public=true
            fi
          fi
          # Module-wide top-level visibility is known before emitting any file.
          # Unqualified extensions still give no default public member access.
          if (( brace_depth == 0 )) && [[ -n "$type_name" && "$pending_kind" == extension && -z "$access" && "$public_types" == *" $type_name "* ]]; then
            pending_public=true
          fi
        fi

        # If collecting a multi-line declaration, append
        local signature="" indent="  "
        if [[ "$where_continuation" == true ]]; then
          :
        elif [[ "$collecting_multiline" == true ]]; then
          multiline_buffer="$multiline_buffer $stripped"
          count_paren_depth "$scope_code"
          paren_depth=$(( paren_depth + paren_delta ))
          local continuation_code="${scope_code%"${scope_code##*[![:space:]]}"}"
          # Cases also continue across a trailing comma after balanced parens.
          if [[ $paren_depth -le 0 && ( "$collecting_case" == false || "$continuation_code" != *, ) ]]; then
            collecting_multiline=false
            collecting_case=false
            signature="$multiline_buffer"
          fi
        elif [[ "$declaration" =~ ^public[[:space:]]+((final|indirect)[[:space:]]+)?(class|struct|enum|protocol|extension)[[:space:]] ]]; then
          # Preserve the existing type headers and member formatting verbatim.
          signature="$stripped"
          indent=""
          requirement_accessors=false
        else
          local record=false
          if [[ "$declaration" =~ ^public[[:space:]] ]]; then
            record=true
          elif [[ "$at_type_depth" == true && "$visible" == true ]]; then
            if [[ "$kind" == enum && "$declaration" =~ ^(indirect[[:space:]]+)?case[[:space:]] ]]; then
              record=true
            elif [[ ( "$kind" == protocol || ( "$kind" == extension && "$default_public" == true ) ) && "$declaration" =~ $member_pattern ]]; then
              record=true
            elif [[ "$kind" == extension && "$default_public" == true && "$declaration" =~ $type_pattern && -z "${BASH_REMATCH[2]}" ]]; then
              record=true
            fi
          fi
          if [[ "$record" == true ]]; then
            requirement_accessors=false
            if [[ "$kind" == protocol && "$declaration" =~ $member_pattern && ( "${BASH_REMATCH[3]}" == var || "${BASH_REMATCH[3]}" == subscript ) ]]; then
              requirement_accessors=true
            fi
            count_paren_depth "$scope_code"
            paren_depth=$paren_delta
            collecting_case=false
            if [[ "$kind" == enum && "$declaration" =~ ^(indirect[[:space:]]+)?case[[:space:]] ]]; then
              collecting_case=true
            fi
            local case_code="${scope_code%"${scope_code##*[![:space:]]}"}"
            if [[ $paren_depth -gt 0 || ( "$collecting_case" == true && "$case_code" == *, ) ]]; then
              collecting_multiline=true
              multiline_buffer="$stripped"
            else
              signature="$stripped"
            fi
          fi
        fi

        if [[ -n "$pending_attributes" ]]; then
          if [[ -n "$signature" ]]; then
            signature="$pending_attributes $signature"
          elif [[ "$collecting_multiline" == true ]]; then
            multiline_buffer="$pending_attributes $multiline_buffer"
          fi
          pending_attributes=""
        fi

        if [[ -n "$signature" ]]; then
          local member
          strip_body_brace "$signature" "$kind"
          member="$stripped_signature"
          member="${member%"${member##*[![:space:]]}"}"
          held_member="$member"
          held_indent="$indent"
          if [[ "$requirement_accessors" == true ]]; then
            local ending="${scope_code%"${scope_code##*[![:space:]]}"}"
            if [[ "$ending" == *\{ ]]; then
              collecting_accessors=true
              accessor_depth=$((brace_depth + 1))
              accessor_buffer=""
            elif [[ -z "$opens" ]]; then
              accessor_pending=true
            fi
          fi
        fi
      fi

      if [[ -n "$pending_kind" && -n "$opens" ]]; then
        context_depths[context_count]=$((pending_depth + 1))
        context_kinds[context_count]="$pending_kind"
        context_public[context_count]="$pending_public"
        context_default_public[context_count]="$pending_default_public"
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
    # EOF also flushes before the next file's header (including the last file).
    if [[ -n "$held_member" ]]; then
      emit_file_header "$rel_path"
      echo "$held_indent$held_member"
    fi
  done <<< "$swift_files"
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
