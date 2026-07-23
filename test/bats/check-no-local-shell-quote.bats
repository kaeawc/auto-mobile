#!/usr/bin/env bats

SCRIPT="scripts/check-no-local-shell-quote.sh"
FIXTURE="src/utils/ShellQuoteBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows only the canonical shellQuote module to define a shell-quoting helper" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no local production shell-quoting helpers"* ]]
}

@test "rejects a local shell-quoting helper" {
  printf '%s\n' \
    'export const quoteShell = (value: string): string => value;' \
    > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ShellQuoteBoundaryFixture.ts"* ]]
}
