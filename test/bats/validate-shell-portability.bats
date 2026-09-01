#!/usr/bin/env bats
# bats file_tags=integration
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

@test "flags a typed 'declare -a' empty-array declaration" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
declare -a extra=()
cmd=(run "${extra[@]}")
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "flags a typed 'local -a' empty-array declaration" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
f() {
  local -a extra=()
  printf '%s\n' "${extra[@]}"
}
f
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "flags an expansion after an inverse \${#arr[@]} check that guards nothing" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
extra=()
if [[ "${#extra[@]}" -eq 0 ]]; then
  echo none
fi
cmd=(run "${extra[@]}")
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "flags an expansion after a positive guard block has already closed" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
extra=()
if [[ "${#extra[@]}" -gt 0 ]]; then
  echo some
fi
cmd=(run "${extra[@]}")
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -ne 0 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "does NOT flag an expansion after an empty-array early return" {
  write_lines ok <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
f() {
  local found=()
  if [[ ${#found[@]} -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "${found[@]}"
}
f
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "does NOT flag an expansion guarded by a -n \${arr[*]-} test" {
  write_lines ok <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
only_list=()
if [[ -n "${only_list[*]-}" ]]; then
  for requested in "${only_list[@]}"; do echo "$requested"; done
fi
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

# --- Regression coverage for four fail-open gaps found in review of #4212. ---
# Every one of these made the validator report success while the bash 3.2
# crash it exists to catch went undetected. A gate that fails open is worse
# than no gate, so each gap gets a test that fails if the hole reopens.

@test "detects nounset armed via 'set -o nounset'" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -o nounset
items=()
printf '%s\n' "${items[@]}"
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 1 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "detects nounset armed via split flags 'set -e -u -o pipefail'" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -e -u -o pipefail
items=()
printf '%s\n' "${items[@]}"
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 1 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "an early-out in one function does not excuse an expansion in another" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
items=()
guard() { if [[ ${#items[@]} -eq 0 ]]; then return 0; fi; }
use() { printf '%s\n' "${items[@]}"; }
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 1 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "records an empty-array declaration carrying a trailing comment" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
items=() # optional args
printf '%s\n' "${items[@]}"
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 1 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "fails closed when the awk scanner itself errors" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
extra=()
printf '%s\n' "${extra[@]}"
FIXTURE
  FAKEBIN="$(mktemp -d)"
  printf '#!/bin/sh\nexit 2\n' > "$FAKEBIN/awk"
  chmod +x "$FAKEBIN/awk"
  PATH="$FAKEBIN:$PATH" run bash "$ABS" "$FIX"
  rm -rf "$FAKEBIN"
  # Must NOT be 0. A scanner crash is a gate failure, not a clean scan.
  [ "$status" -eq 2 ]
  [[ "$output" == *"scanner-error"* ]]
}

@test "still does NOT flag a same-function early-out (no false positive)" {
  write_lines ok <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
f() {
  local found=()
  if [[ ${#found[@]} -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "${found[@]}"
}
f
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "an else-branch exit is not an empty-array early-out" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
items=()
if [[ ${#items[@]} -eq 0 ]]; then echo none; else return 0; fi
printf '%s\n' "${items[@]}"
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 1 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "does NOT arm the rule when set -u appears only in a comment" {
  write_lines ok <<'FIXTURE'
#!/usr/bin/env bash
# mentions set -u only
items=()
printf '%s\n' "${items[@]}"
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

@test "still credits a single-line then-branch early-out (no false positive)" {
  write_lines ok <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
g() {
  local xs=()
  if [[ ${#xs[@]} -eq 0 ]]; then return 0; fi
  printf '%s\n' "${xs[@]}"
}
g
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 0 ]
}

# --- Holes 4 and 5, found in review of #4217 after it merged. ---
# Both are the same failure mode as holes 1-3: the gate reported success while
# the bash 3.2 crash it exists to catch went undetected.

@test "a loop continue is not a function-wide empty-array early-out" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
items=()
for attempt in 1 2 3; do
  if [[ ${#items[@]} -eq 0 ]]; then continue; fi
  echo "$attempt"
done
printf '%s\n' "${items[@]}"
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 1 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "a loop break is not a function-wide empty-array early-out" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
items=()
while true; do
  if [[ ${#items[@]} -eq 0 ]]; then break; fi
done
printf '%s\n' "${items[@]}"
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 1 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "records a semicolon-terminated empty-array declaration" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
items=(); printf '%s\n' "${items[@]}"
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 1 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}

@test "records a bare semicolon empty-array declaration" {
  write_lines bad <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
items=();
printf '%s\n' "${items[@]}"
FIXTURE
  run bash "$ABS" "$FIX"
  [ "$status" -eq 1 ]
  [[ "$output" == *"empty-array-set-u"* ]]
}
