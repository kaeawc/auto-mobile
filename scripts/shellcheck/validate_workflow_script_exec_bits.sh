#!/usr/bin/env bash
#
# Verify that workflow and composite-action steps invoking repository shell
# scripts directly use executable Git index modes.
#
# Usage: scripts/shellcheck/validate_workflow_script_exec_bits.sh [dir ...]
# shellcheck disable=SC2094 # The scanner reads each file while its helper only queries Git metadata.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT_ROOT="${WORKFLOW_EXEC_BITS_PROJECT_ROOT:-$DEFAULT_PROJECT_ROOT}"

ROOTS=("$@")
if [ "${#ROOTS[@]}" -eq 0 ]; then
  ROOTS=(".github/workflows" ".github/actions")
fi

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
[ -t 1 ] || { RED=""; GREEN=""; YELLOW=""; NC=""; }

violations=0
scanner_errors=0
TEMPLATE_MARKER="\${{"

report_violation() {
  printf '%s[workflow-script-exec-bits]%s %s:%s\n    Directly invoked non-executable script: %s\n    %sFix it with: git update-index --chmod=+x %s%s\n' \
    "$RED" "$NC" "$1" "$2" "$3" "$YELLOW" "$3" "$NC"
  violations=$((violations + 1))
}

check_script_path() {
  local file="$1" line_number="$2" script_path="$3"
  local git_output git_status mode

  script_path="${script_path#./}"
  case "$script_path" in
    *"$TEMPLATE_MARKER"*) return 0 ;;
  esac

  git_output="$(git -C "$PROJECT_ROOT" ls-files -s -- "$script_path" 2>&1)"
  git_status=$?
  if [ "$git_status" -ne 0 ]; then
    printf '%s[scanner-error]%s git ls-files failed for %s while scanning %s:%s\n%s\n' \
      "$RED" "$NC" "$script_path" "$file" "$line_number" "$git_output" >&2
    scanner_errors=$((scanner_errors + 1))
    return 0
  fi
  [ -z "$git_output" ] && return 0

  mode="${git_output%% *}"
  [ "$mode" = "100644" ] && report_violation "$file" "$line_number" "$script_path"
}

scan_file() {
  local file="$1" line line_number=0 trimmed indent run_indent=0 in_block=0
  local command script_path block_scalar_re='^[|>][+-]?[[:space:]]*$'

  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))

    if [ "$in_block" -eq 1 ]; then
      if [[ "$line" =~ ^[[:space:]]*$ ]]; then
        continue
      fi
      indent="${line%%[![:space:]]*}"
      if [ "${#indent}" -gt "$run_indent" ]; then
        trimmed="${line:${#indent}}"
        if [[ "$trimmed" =~ ^(\./)?(scripts/[^[:space:]]+\.sh)([[:space:]]|$) ]]; then
          script_path="${BASH_REMATCH[2]}"
          check_script_path "$file" "$line_number" "$script_path"
        fi
        continue
      fi
      in_block=0
    fi

    if [[ "$line" =~ ^([[:space:]]*)(-[[:space:]]+)?run:[[:space:]]*(.*)$ ]]; then
      indent="${BASH_REMATCH[1]}"
      command="${BASH_REMATCH[3]}"
      run_indent="${#indent}"
      if [[ "$command" =~ $block_scalar_re ]]; then
        in_block=1
      elif [[ "$command" =~ ^(\./)?(scripts/[^[:space:]]+\.sh)([[:space:]]|$) ]]; then
        script_path="${BASH_REMATCH[2]}"
        check_script_path "$file" "$line_number" "$script_path"
      fi
    fi
  done < "$file"
}

while IFS= read -r file; do
  [ -n "$file" ] || continue
  scan_file "$file"
done < <(
  for root in ${ROOTS[@]+"${ROOTS[@]}"}; do
    case "$(basename "$root")" in
      workflows) find "$root" -type f -name '*.yml' 2>/dev/null ;;
      actions) find "$root" -type f -name 'action.yml' 2>/dev/null ;;
      *) find "$root" -type f \( -name '*.yml' -o -name 'action.yml' \) 2>/dev/null ;;
    esac
  done | sort
)

if [ "$scanner_errors" -gt 0 ]; then
  printf '%sThe workflow-script-exec-bits scanner failed on %s path(s).%s\n' \
    "$RED" "$scanner_errors" "$NC" >&2
  exit 2
fi
if [ "$violations" -gt 0 ]; then
  printf '%sFound %s workflow-script-exec-bit issue(s).%s\n' "$RED" "$violations" "$NC" >&2
  exit 1
fi

printf '%sNo workflow-script-exec-bit issues found.%s\n' "$GREEN" "$NC"
