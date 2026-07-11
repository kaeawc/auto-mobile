#!/usr/bin/env bats
#
# Tests for scripts/shellcheck/validate_shell_sete.sh — the set -e-suppressed
# baseline gate. Uses SHELL_SETE_CMD to inject canned shellcheck output and
# SHELL_SETE_BASELINE to point at a throwaway baseline.

SCRIPT="scripts/shellcheck/validate_shell_sete.sh"

FINDING_A='scripts/a.sh:3:4: note: This function is invoked in an '"'"'if'"'"' condition so set -e will be disabled. Invoke separately if failures should cause the script to exit. [SC2310]'
FINDING_B='scripts/b.sh:9:1: note: This function is invoked in an '"'"'if'"'"' condition so set -e will be disabled. Invoke separately if failures should cause the script to exit. [SC2310]'

setup() {
  ABS="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  BL="$(mktemp -d)/baseline.txt"
  export SHELL_SETE_BASELINE="$BL"
}
teardown() {
  rm -rf "$(dirname "$BL")"
  unset SHELL_SETE_BASELINE SHELL_SETE_CMD
}

@test "update writes a baseline of the current findings" {
  run env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n%s\n' '$FINDING_A' '$FINDING_B'" bash "$ABS" --update
  [ "$status" -eq 0 ]
  [ "$(grep -vcE '^#' "$BL")" -eq 2 ]
}

@test "check passes when current findings match the baseline" {
  env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n%s\n' '$FINDING_A' '$FINDING_B'" bash "$ABS" --update >/dev/null
  run env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n%s\n' '$FINDING_A' '$FINDING_B'" bash "$ABS"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No new set -e-suppressed findings"* ]]
}

@test "check FAILS on a finding not in the baseline" {
  env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n' '$FINDING_A'" bash "$ABS" --update >/dev/null
  run env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n%s\n' '$FINDING_A' '$FINDING_B'" bash "$ABS"
  [ "$status" -ne 0 ]
  [[ "$output" == *"New set -e-suppressed finding"* ]]
  [[ "$output" == *"scripts/b.sh"* ]]
}

@test "check passes (and nudges) when a baselined finding is fixed" {
  env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n%s\n' '$FINDING_A' '$FINDING_B'" bash "$ABS" --update >/dev/null
  run env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n' '$FINDING_A'" bash "$ABS"
  [ "$status" -eq 0 ]
  [[ "$output" == *"run --update to shrink the baseline"* ]]
}

@test "update refuses to grow the baseline without --allow-grow" {
  env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n' '$FINDING_A'" bash "$ABS" --update >/dev/null
  run env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n%s\n' '$FINDING_A' '$FINDING_B'" bash "$ABS" --update
  [ "$status" -ne 0 ]
  [[ "$output" == *"Refusing to grow"* ]]
}

@test "update --allow-grow does grow the baseline" {
  env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n' '$FINDING_A'" bash "$ABS" --update >/dev/null
  run env SHELL_SETE_BASELINE="$BL" SHELL_SETE_CMD="printf '%s\n%s\n' '$FINDING_A' '$FINDING_B'" bash "$ABS" --update --allow-grow
  [ "$status" -eq 0 ]
  [ "$(grep -vcE '^#' "$BL")" -eq 2 ]
}
