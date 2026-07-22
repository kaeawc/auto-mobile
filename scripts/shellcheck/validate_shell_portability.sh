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
#   empty-array-set-u  `"${arr[@]}"` for an array that can be empty, under
#                      `set -u`. Bash 3.2 (/bin/bash on macos-latest) aborts
#                      with "unbound variable"; 4.4+ special-cases it, so the
#                      bug is invisible on Linux and locally. Use
#                      `${arr[@]+"${arr[@]}"}` or an explicit
#                      `[ ${#arr[@]} -gt 0 ]` guard. (#3651, #4212)
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

# The empty-array rule needs whole-file context (which arrays are initialized
# empty, and whether a nearby `${#arr[@]}` guard covers the expansion), so it
# cannot reuse the line-oriented `scan` helper above.
# shellcheck disable=SC2016 # awk program: $0/$NR are awk fields, not shell.
EMPTY_ARRAY_AWK='
{ lines[NR] = $0 }
/set -[a-z]*u/ { setu = 1 }
# Empty-array declarations, including the typed forms: `arr=()`,
# `local arr=()`, `local -a arr=()`, `declare -A arr=()`, `typeset -a arr=()`.
match($0, /^[ \t]*((local|declare|typeset)[ \t]+(-[aAgilnrtux]+[ \t]+)*)?[A-Za-z_][A-Za-z0-9_]*=\(\)[ \t]*$/) {
  decl = $0
  sub(/^[ \t]*/, "", decl)
  sub(/^(local|declare|typeset)[ \t]+/, "", decl)
  while (decl ~ /^-[aAgilnrtux]+[ \t]+/) { sub(/^-[aAgilnrtux]+[ \t]+/, "", decl) }
  sub(/=\(\)[ \t]*$/, "", decl)
  arrays[decl] = 1
}

# A `${#arr[@]}` mention only counts as a guard when it is a positive-sense
# length test that opens a block — an `-eq 0` early-out or a bare count in a
# message guards nothing.
function is_positive_length_guard(line, name) {
  if (index(line, "${#" name "[@]}")) {
    if (line ~ /-eq[ \t]+0/ || line ~ /-lt[ \t]+1/ || line ~ /==[ \t]*0/) { return 0 }
    if (line !~ /(^|[ \t;])(if|elif|while|until)[ \t]/ && line !~ /&&/) { return 0 }
    if (line ~ /-gt[ \t]+0/ || line ~ /-ge[ \t]+1/ || line ~ /-ne[ \t]+0/) { return 1 }
    if (line ~ /\(\([^)]*\$\{#/) { return 1 }
    return 0
  }
  # `[[ -n "${arr[*]-}" ]]` is the other non-empty test used in this repo.
  if (line ~ /-n[ \t]+"?\$\{/ && (index(line, "${" name "[*]-}") || index(line, "${" name "[@]-}"))) {
    return 1
  }
  return 0
}

# `if [ ${#arr[@]} -eq 0 ]; then return; fi` is an early-out: everything after
# it is reached only when the array is non-empty. Returns 1 when line k opens
# such a block and it leaves the scope within the next few lines.
function is_empty_early_out(lines, nlines, k, name,   j) {
  if (!index(lines[k], "${#" name "[@]}")) { return 0 }
  if (lines[k] !~ /-eq[ \t]+0/ && lines[k] !~ /-lt[ \t]+1/ && lines[k] !~ /==[ \t]*0/) { return 0 }
  if (lines[k] !~ /(^|[ \t;])(if|elif)[ \t]/ && lines[k] !~ /&&/) { return 0 }
  for (j = k; j <= k + 3 && j <= nlines; j++) {
    if (lines[j] ~ /(^|[ \t;])(return|exit|continue|break)([ \t;]|$)/) { return 1 }
  }
  return 0
}
END {
  if (!setu) { exit }
  for (n = 1; n <= NR; n++) {
    line = lines[n]
    if (line ~ /^[ \t]*#/) { continue }
    if (index(line, "portability-ok")) { continue }
    for (name in arrays) {
      unsafe = "${" name "[@]}"
      if (!index(line, unsafe)) { continue }
      if (index(line, "${" name "[@]+")) { continue }
      guarded = 0
      for (k = n - 9; k < n; k++) {
        if (k < 1) { continue }
        # A block terminator between the guard and the expansion means the
        # guard has already closed and no longer covers this line.
        if (lines[k] ~ /^[ \t]*(fi|else|elif|done|esac|\})([ \t]|;|$)/) { guarded = 0; continue }
        if (is_positive_length_guard(lines[k], name)) { guarded = 1 }
      }
      # An empty-array early-out anywhere above in the same scope also covers it.
      for (k = 1; k < n && !guarded; k++) {
        if (is_empty_early_out(lines, NR, k, name)) { guarded = 1 }
      }
      if (guarded) { continue }
      text = line
      sub(/^[ \t]*/, "", text)
      printf "%d:%s\n", n, text
    }
  }
}
'

while IFS= read -r file; do
  while IFS=: read -r lineno text; do
    [ -z "$lineno" ] && continue
    # shellcheck disable=SC2016 # literal hint text, not a shell expansion.
    report "empty-array-set-u" "$file" "$lineno" "$text" \
      'Bash 3.2 aborts on an empty "${arr[@]}" under set -u — use ${arr[@]+"${arr[@]}"}.'
  done < <(awk "$EMPTY_ARRAY_AWK" "$file" 2>/dev/null || true)
done < <(find "${ROOTS[@]}" -name '*.sh' -type f ! -name 'validate_shell_portability.sh' 2>/dev/null | sort)

echo ""
if [ "$violations" -gt 0 ]; then
  echo "${RED}Found ${violations} shell-portability issue(s).${NC}" >&2
  echo "Fix them, or add '# portability-ok' on the line if it is a genuine exception." >&2
  exit 1
fi
echo "${GREEN}No shell-portability issues found.${NC}"
