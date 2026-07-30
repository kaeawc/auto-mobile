#!/usr/bin/env bash
#
# Lint fenced ```bash blocks embedded in Markdown that no other shell gate can
# reach (issue #4118).
#
# `scripts/shellcheck/validate_shell_scripts.sh` and its portability/set -e
# siblings all select files with `grep -z '\.sh$'`, so bash embedded in
# `.claude/commands/*.md` and the Codex `skills/**/SKILL.md` files is invisible
# to every shell gate in the repo. That is how `.claude/commands/check-ci.md`
# shipped `grep -oP 'runs/\K[0-9]+'` for months — GNU-only PCRE that
# `/usr/bin/grep` on macOS rejects outright (#4117). Nothing stopped the next
# one; this gate does.
#
# For every fenced ```bash block in the target Markdown files this runs:
#   * shellcheck at --severity=error, catching genuine SYNTAX errors while
#     staying quiet about the unquoted-variable / undefined-var style noise that
#     illustrative snippets are full of; and
#   * a small GNU-only footgun scan (grep -P, sed -i without a suffix,
#     readlink -f, mapfile/readarray, date -d) — the class shellcheck does not
#     flag and the exact class behind #4117.
#
# Illustrative fragments are NOT standalone scripts and must not produce false
# positives. A block is SKIPPED when it either:
#   * contains an angle-bracket placeholder token (`<PR>`, `<N>`, `<HEAD_SHA>`,
#     …) or a unicode ellipsis (…) — the markers of a copy-and-fill fragment; or
#   * carries an explicit `# md-bash-lint: skip` directive on its own line.
# Individual lines may be exempted with a trailing `# md-bash-lint-ok` comment.
#
# Usage:
#   scripts/shellcheck/validate_markdown_bash.sh                 # canonical targets
#   scripts/shellcheck/validate_markdown_bash.sh FILE_OR_DIR...  # explicit targets (tests)
set -uo pipefail

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck missing" >&2
  if [[ "${OSTYPE:-}" == "darwin"* ]]; then
    echo "Try 'brew install shellcheck'" >&2
  else
    echo "Consult your OS package manager" >&2
  fi
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
[[ -t 1 ]] || { RED=""; GREEN=""; YELLOW=""; NC=""; }

# Resolve the Markdown files to scan. With no arguments, scan the canonical
# surfaces the issue names. With arguments, treat each as a file (scanned
# directly) or a directory (all *.md within, recursively) so the BATS suite can
# aim the gate at a fixture tree.
TARGETS=()
resolve_targets() {
  if [[ "$#" -eq 0 ]]; then
    while IFS= read -r f; do TARGETS+=("$f"); done < <(
      {
        find "$PROJECT_ROOT/.claude/commands" -maxdepth 1 -name '*.md' -type f 2>/dev/null
        find "$PROJECT_ROOT/skills" -name 'SKILL.md' -type f 2>/dev/null
      } | sort
    )
    return
  fi
  local arg
  for arg in "$@"; do
    if [[ -d "$arg" ]]; then
      while IFS= read -r f; do TARGETS+=("$f"); done < <(find "$arg" -name '*.md' -type f 2>/dev/null | sort)
    elif [[ -f "$arg" ]]; then
      TARGETS+=("$arg")
    else
      echo "${RED}No such file or directory: $arg${NC}" >&2
      exit 2
    fi
  done
}
resolve_targets "$@"

violations=0
blocks_scanned=0

# A block is illustrative (skip) when it carries placeholders or an explicit
# skip directive. Placeholders: an angle-bracket token like <PR>/<HEAD_SHA> or a
# unicode ellipsis. `<<EOF`, `<(...)`, `2>&1` and bare `< file` redirections do
# not match `<WORD>` and so never mask a real block.
block_is_illustrative() {
  local content="$1"
  if printf '%s' "$content" | grep -qE '<[A-Za-z_][A-Za-z0-9_ .…-]*>'; then
    return 0
  fi
  if printf '%s' "$content" | grep -q '…'; then
    return 0
  fi
  if printf '%s' "$content" | grep -qE '^[[:space:]]*#[[:space:]]*md-bash-lint:[[:space:]]*skip[[:space:]]*$'; then
    return 0
  fi
  return 1
}

# GNU-only footgun scan over a block's lines. Skips comment-only lines and lines
# carrying `# md-bash-lint-ok`. Reports each finding relative to the Markdown
# source line. Args: FILE START_LINE TMPFILE.
scan_gnuisms() {
  local file="$1" start="$2" tmp="$3"
  local n=0 line
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    local srcline=$((start + n - 1))
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    printf '%s' "$line" | grep -q 'md-bash-lint-ok' && continue

    local label="" hint=""
    if printf '%s' "$line" | grep -qE '\bgrep\b[^|]*-[A-Za-z]*P'; then
      label="gnu-grep-P"; hint="grep -P/-oP is GNU-only PCRE; /usr/bin/grep on macOS rejects it (#4117)."
    elif printf '%s' "$line" | grep -qE '\bsed\b[^|]*[[:space:]]-i([[:space:]]|$)'; then
      label="gnu-sed-inplace"; hint="sed -i without a suffix is GNU-only; BSD/macOS needs sed -i '' or a temp file."
    elif printf '%s' "$line" | grep -qE '\breadlink\b[^|]*-[A-Za-z]*f'; then
      label="gnu-readlink-f"; hint="readlink -f is GNU-only; use a portable path resolver (cd/pwd -P)."
    elif printf '%s' "$line" | grep -qE '\b(mapfile|readarray)\b'; then
      label="bash4-mapfile"; hint="mapfile/readarray is bash 4+; /bin/bash on macOS is 3.2. Use a read loop."
    elif printf '%s' "$line" | grep -qE '\bdate\b[^|]*[[:space:]]-d([[:space:]]|$)'; then
      label="gnu-date-d"; hint="date -d is GNU-only; BSD/macOS date uses -v/-j -f."
    fi

    if [[ -n "$label" ]]; then
      printf '%s%s%s %s:%s\n    %s\n    %s→ %s%s\n' \
        "$RED" "[$label]" "$NC" "$file" "$srcline" \
        "$(printf '%s' "$line" | sed 's/^[[:space:]]*//')" "$YELLOW" "$hint" "$NC" >&2
      violations=$((violations + 1))
    fi
  done < "$tmp"
}

process_file() {
  local file="$1"
  # Split the file into fenced ```bash blocks. awk emits, per block, a header
  # line `@@ START_LINE` followed by the block body, then `@@END`. Only fences
  # opened by exactly ```bash (optionally indented, optional trailing spaces)
  # count — ```bash-inside-a-larger-info-string is not a shell block.
  local awk_out
  awk_out="$(awk '
    /^[[:space:]]*```bash[[:space:]]*$/ && !inblock { inblock=1; print "@@ " NR; next }
    /^[[:space:]]*```[[:space:]]*$/ && inblock { inblock=0; print "@@END"; next }
    inblock { print "@@L " $0 }
  ' "$file")"
  [[ -z "$awk_out" ]] && return

  local tmp start=0 have=0
  tmp="$(mktemp)"
  local content=""
  while IFS= read -r rec; do
    case "$rec" in
      "@@ "*)
        start="${rec#@@ }"; have=1; : > "$tmp"; content=""
        ;;
      "@@END")
        if [[ "$have" -eq 1 ]]; then
          blocks_scanned=$((blocks_scanned + 1))
          if block_is_illustrative "$content"; then
            have=0
            continue
          fi
          # Report only genuine errors (syntax) — not the unquoted/undefined
          # style noise illustrative snippets are full of.
          local sc_out
          if ! sc_out="$(shellcheck --shell=bash --severity=error "$tmp" 2>&1)"; then
            printf '%s[shellcheck]%s %s: fenced bash block at line %s\n' \
              "$RED" "$NC" "$file" "$start" >&2
            printf '%s\n' "$sc_out" | sed 's/^/    /' >&2
            violations=$((violations + 1))
          fi
          scan_gnuisms "$file" "$start" "$tmp"
        fi
        have=0
        ;;
      "@@L "*)
        local body="${rec#@@L }"
        printf '%s\n' "$body" >> "$tmp"
        content="${content}${body}"$'\n'
        ;;
    esac
  done <<< "$awk_out"
  rm -f "$tmp"
}

for target in ${TARGETS[@]+"${TARGETS[@]}"}; do
  process_file "$target"
done

echo ""
if [[ "$violations" -gt 0 ]]; then
  echo "${RED}Found ${violations} issue(s) in Markdown-embedded bash (scanned ${blocks_scanned} block(s)).${NC}" >&2
  echo "Fix the block, or — if it is an illustrative fragment — give it an angle-bracket" >&2
  echo "placeholder or a '# md-bash-lint: skip' directive line." >&2
  exit 1
fi
echo "${GREEN}Markdown-embedded bash is clean (${blocks_scanned} block(s) scanned).${NC}"
