#!/usr/bin/env bash
#
# Portability & footgun lint for scripts/**/*.sh.
#
# Catches a curated set of high-confidence shell bug classes that shellcheck
# does not flag, most of them found during the bash bug hunt (issues
# #3637–#3658). Each rule is deliberately low-false-positive; add
# `# portability-ok` on a line to suppress a genuine exception.
#
# Rules:
#   gnu-sed-bre        GNU BRE quantifiers (\+, \?) in a non -E/-r sed — literal
#                      on BSD/macOS sed. Use ERE (sed -E). (#3646)
#   command-v-negated  `$(! command -v X ...)` captures stdout (always empty),
#                      so the guard is always false. Test the exit status. (#3642)
#   command-v-multiarg `command -v X Y` treats Y as a second command name and
#                      never checks the subcommand. (#3652)
#   curl-no-fail       `curl … -o/-O/--output` without -f/--fail saves a 404
#                      error page as the "download". (#3641, #3649)
#   append-then-stderr `>> file >&2` sends output to stderr, not the file, because
#                      the last redirect wins. (#3648)
#   bare-python        A bare `python` invocation (not python3) — absent on
#                      ubuntu-latest / modern macOS. (#3657)
#
# Usage: scripts/shellcheck/validate_shell_portability.sh [dir ...]
set -uo pipefail

ROOTS=("$@")
[ "${#ROOTS[@]}" -eq 0 ] && ROOTS=("scripts")

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
[ -t 1 ] || { RED=""; GREEN=""; YELLOW=""; NC=""; }

violations=0

# report LABEL FILE LINENO TEXT HINT
report() {
  printf '%s%s%s %s:%s\n    %s\n    %s→ %s%s\n' \
    "$RED" "[$1]" "$NC" "$2" "$3" "$4" "$YELLOW" "$5" "$NC"
  violations=$((violations + 1))
}

# scan LABEL PATTERN HINT [inverse_filter]
# Emits a report for every non-comment, non-suppressed line matching PATTERN.
# If inverse_filter is given, a line only counts when it does NOT match it.
scan() {
  local label="$1" pattern="$2" hint="$3" inverse="${4:-}"
  local file lineno text
  while IFS= read -r file; do
    while IFS=: read -r lineno text; do
      [ -z "$lineno" ] && continue
      # skip comment-only lines and lines with an explicit suppression
      printf '%s' "$text" | grep -qE '^[[:space:]]*#' && continue
      printf '%s' "$text" | grep -q 'portability-ok' && continue
      if [ -n "$inverse" ]; then
        printf '%s' "$text" | grep -qE "$inverse" && continue
      fi
      report "$label" "$file" "$lineno" "$(printf '%s' "$text" | sed 's/^[[:space:]]*//')" "$hint"
    done < <(grep -nE "$pattern" "$file" 2>/dev/null || true)
    # Skip this linter itself — its rule definitions contain the very patterns
    # it searches for.
  done < <(find "${ROOTS[@]}" -name '*.sh' -type f ! -name 'validate_shell_portability.sh' 2>/dev/null | sort)
}

scan "gnu-sed-bre" \
  "sed( -[nr]*| )[^|]*'[^']*\\\\[+?]" \
  "GNU BRE \\+/\\? is literal on BSD sed — use ERE (sed -E)."

scan "command-v-negated" \
  '\$\([[:space:]]*![[:space:]]*command -v' \
  'This captures stdout (always empty) so the guard is always false — test the exit status directly.'

scan "command-v-multiarg" \
  'command -v +[A-Za-z0-9_./-]+ +[A-Za-z0-9_./-]+' \
  'command -v takes one name — probe the subcommand directly.'

scan "curl-no-fail" \
  'curl .*(-o |-O |--output|--remote-name)' \
  'Add -f/--fail so an HTTP error is not saved as the download.' \
  '(--fail|-[[:alnum:]]*f)'

scan "append-then-stderr" \
  '>>[^>|]*>&2' \
  'Redirect order: this writes to stderr, not the file. Drop >&2 or use tee -a.'

scan "bare-python" \
  '(^|[;&|(]|\$\()[[:space:]]*python([[:space:]]|$)' \
  'Use python3 — bare python is absent on ubuntu-latest / modern macOS.'

echo ""
if [ "$violations" -gt 0 ]; then
  echo "${RED}Found ${violations} shell-portability issue(s).${NC}" >&2
  echo "Fix them, or add '# portability-ok' on the line if it is a genuine exception." >&2
  exit 1
fi
echo "${GREEN}No shell-portability issues found.${NC}"
