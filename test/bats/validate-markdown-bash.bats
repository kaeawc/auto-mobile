#!/usr/bin/env bats
#
# Tests for scripts/shellcheck/validate_markdown_bash.sh — the gate that
# shellcheck-lints fenced ```bash blocks embedded in `.claude/commands/*.md` and
# the Codex `skills/**/SKILL.md` files (issue #4118). Each GNU-only footgun and
# a syntax error must fail; illustrative placeholder fragments must not.

SCRIPT="scripts/shellcheck/validate_markdown_bash.sh"

setup() {
  ABS="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  FIX="$(mktemp -d)"
}
teardown() {
  rm -rf "$FIX"
}

# write NAME BODY — wrap BODY in a fenced ```bash block in a fixture Markdown file.
write_block() {
  {
    printf '```bash\n'
    printf '%s\n' "$2"
    printf '```\n'
  } > "$FIX/$1.md"
}

@test "passes on the repository's own commands and skills tree" {
  run bash "$ABS"
  [ "$status" -eq 0 ]
  [[ "$output" == *"clean"* ]]
}

@test "flags a GNU-only grep -P (the #4117 class)" {
  write_block bad 'gh run list | grep -oP "runs/\K[0-9]+"'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-grep-P"* ]]
}

@test "flags a bash-4 mapfile builtin" {
  write_block bad 'mapfile -t arr < input'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"bash4-mapfile"* ]]
}

@test "flags a GNU-only date -d" {
  write_block bad 'date -d yesterday +%s'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-date-d"* ]]
}

@test "flags a GNU-only readlink -f" {
  write_block bad 'target=$(readlink -f /some/link)'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-readlink-f"* ]]
}

@test "flags a GNU-only sed -i without a suffix" {
  write_block bad 'sed -i "s/a/b/" file'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-sed-inplace"* ]]
}

@test "flags a syntax error in a fenced bash block" {
  write_block bad 'if true; then
  echo hi'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"shellcheck"* ]]
}

@test "does NOT flag an illustrative fragment with an angle-bracket placeholder" {
  # A GNU-ism inside a placeholder fragment is deliberately not linted — the
  # block is not a standalone script.
  write_block ok 'gh pr view <PR> --json state
grep -oP "x" file'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "does NOT flag a fragment carrying a unicode ellipsis" {
  write_block ok 'gh api repos/o/r/pulls/comments/replies -f body='"'"'…'"'"''
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "honors an explicit # md-bash-lint: skip directive" {
  write_block ok '# md-bash-lint: skip
mapfile -t arr < input'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "honors a per-line # md-bash-lint-ok suppression" {
  write_block ok 'readlink -f /x  # md-bash-lint-ok'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "does NOT flag a clean runnable block" {
  write_block ok 'echo hello
ls -la'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}
