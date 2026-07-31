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

# --- regression cases for the three P2 review threads on PR #4801 ---

@test "flags a GNUism split across a trailing-backslash line-continuation" {
  # `grep` and its `-P` sit on different physical lines; a single-line scan
  # would miss it. The logical-line join must catch it.
  write_block bad 'gh run list \
  | grep -P "runs/[0-9]+"'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-grep-P"* ]]
}

@test "a literal double-backslash line-end is not treated as a continuation" {
  # An even run of trailing backslashes is a literal backslash, not a
  # continuation, so the following line is scanned in its own right.
  write_block bad 'printf "a\\\\"
date -d yesterday'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-date-d"* ]]
}

@test "closes a block opened with 3 backticks on a longer 4-backtick fence" {
  # CommonMark allows a longer closing fence. If the extractor only matched an
  # exact 3-backtick close it would swallow everything below as one block; here
  # the fenced GNUism must still be flagged and the close must be honored.
  printf '````bash\ngrep -P "x" file\n````\n' > "$FIX/fence.md"
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-grep-P"* ]]
}

@test "a longer closing fence ends the block (does not swallow later content)" {
  printf '````bash\necho ok\n````\n\ntext\n\n```bash\ndate -d x\n```\n' > "$FIX/two.md"
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  # The GNUism lives in the SECOND block; catching it proves the first block
  # closed on its 4-backtick fence.
  [[ "$output" == *"gnu-date-d"* ]]
  [[ "$output" == *"2 block(s)"* ]]
}

@test "flags the long-option grep --perl-regexp" {
  write_block bad 'gh run list | grep --perl-regexp "runs/[0-9]+"'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-grep-P"* ]]
}

@test "flags grep --perl-regexp=VALUE (attached value form)" {
  write_block bad 'gh run list | grep --perl-regexp="runs/[0-9]+" file'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-grep-P"* ]]
}

# --- regression cases for the five P2 review threads on PR #4801 ---

@test "flags the long-option date --date=STRING" {
  write_block bad 'date --date=yesterday +%s'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-date-d"* ]]
}

@test "flags an attached short date -dSTRING" {
  write_block bad 'date -dyesterday +%s'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-date-d"* ]]
}

@test "does NOT flag a portable date +FORMAT that contains -d" {
  # The `-d` in the +%Y-%m-%d format string must not read as the -d option.
  write_block ok 'stamp=$(date +%Y-%m-%d)'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "does NOT flag the portable sed -i '' empty-suffix form" {
  # This is the exact BSD/macOS spelling the gnu-sed-inplace hint recommends;
  # flagging it would punish the correction it asks for.
  write_block ok "sed -i '' 's/a/b/' file"
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "still flags a suffixless sed -i <script>" {
  write_block bad "sed -i 's/a/b/' file"
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-sed-inplace"* ]]
}

@test "does NOT flag a GNUism name that only appears inside a string literal" {
  write_block ok 'echo "grep -P is unavailable on stock macOS grep"'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "does NOT flag a GNUism name in a trailing inline comment" {
  write_block ok 'echo ok  # remember: date -d is GNU-only'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "flags a GNUism in a fence that runs to EOF with no closing fence" {
  # CommonMark ends the block at EOF; the extractor must still scan it.
  printf '```bash\ngrep -P "x" file\n' > "$FIX/eof.md"
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-grep-P"* ]]
}

@test "flags a token split mid-word across a continuation (grep -\\ then P)" {
  # bash removes the backslash-newline with no inserted space, so `grep -` and a
  # following unindented `P` rejoin as `grep -P`. The join must not insert a space.
  write_block bad 'grep -\
P "x" file'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-grep-P"* ]]
}
