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

# --- empty-array-set-u (#4212) --------------------------------------------
# These fixtures need more than one line (a `set -u`, an empty array init and
# an expansion), so they use a stdin heredoc rather than the `write` helper.
write_lines() { cat > "$FIX/$1.sh"; }

@test "flags a bare empty-array expansion under set -u" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
extra=()
cmd=(run)
cmd+=("${extra[@]}")
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "flags an empty-array expansion in a for loop under set -u" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
items=()
for i in "${items[@]}"; do echo "$i"; done
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "does NOT flag the \${arr[@]+\"\${arr[@]}\"} bash 3.2 safe form" {
  write_lines ok <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
extra=()
cmd=(run)
cmd+=(${extra[@]+"${extra[@]}"})
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "does NOT flag an expansion guarded by a nearby \${#arr[@]} check" {
  write_lines ok <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
extra=()
cmd=(run)
if [ "${#extra[@]}" -gt 0 ]; then
  cmd+=("${extra[@]}")
fi
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "does NOT flag an empty-array expansion when set -u is not enabled" {
  write_lines ok <<'FIXTURE'
#!/usr/bin/env bash
set -eo pipefail
extra=()
cmd=(run)
cmd+=("${extra[@]}")
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "respects a # portability-ok suppression on an empty-array expansion" {
  write_lines ok <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
extra=()
cmd=(run)
cmd+=("${extra[@]}") # portability-ok
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}
