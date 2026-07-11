#!/usr/bin/env bats
#
# Tests for scripts/shellcheck/validate_shell_portability.sh — the portability
# footgun lint. Each rule must flag its bad pattern and the current tree must
# be clean.

SCRIPT="scripts/shellcheck/validate_shell_portability.sh"

setup() {
  ABS="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  FIX="$(mktemp -d)"
}
teardown() {
  rm -rf "$FIX"
}

write() { printf '%s\n' "$2" > "$FIX/$1.sh"; }

@test "passes on the repository's own scripts/ tree" {
  run bash "$ABS" scripts
  [ "$status" -eq 0 ]
}

@test "flags a GNU BRE sed quantifier" {
  write bad "x=\$(echo y | sed -n 's/\\([0-9]\\+\\)/x/p')"
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gnu-sed-bre"* ]]
}

@test "flags a negated command -v inside a substitution" {
  write bad 'if [[ $(! command -v foo) ]]; then :; fi'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"command-v-negated"* ]]
}

@test "does NOT flag a legitimate \$(command -v foo) path lookup" {
  write ok 'p=$(command -v foo); echo "$p"'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "flags a multi-arg command -v" {
  write bad 'if command -v xcrun simctl; then :; fi'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"command-v-multiarg"* ]]
}

@test "flags a curl download without --fail" {
  write bad 'curl -sL "$u" -o out'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"curl-no-fail"* ]]
}

@test "does NOT flag curl -fL -o (has --fail)" {
  write ok 'curl -fL -o out "$u"'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "flags an append-then-stderr redirect" {
  write bad 'echo hi >> "$f" >&2'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"append-then-stderr"* ]]
}

@test "flags a bare python invocation" {
  write bad 'python script.py'
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"bare-python"* ]]
}

@test "does NOT flag python3" {
  write ok 'python3 script.py'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "respects a # portability-ok suppression" {
  write bad 'curl -sL "$u" -o out # portability-ok'
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}
