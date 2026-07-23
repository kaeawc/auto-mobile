#!/usr/bin/env bats

SCRIPT="scripts/check-no-local-shell-quote.sh"

setup() {
  fixture_root="$(mktemp -d)"
  mkdir -p "$fixture_root/utils"
  FIXTURE="$fixture_root/utils/ShellQuoteBoundaryFixture.ts"
}

teardown() {
  rm -rf "$fixture_root"
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

  run env SHELL_QUOTE_SOURCE_ROOT="$fixture_root" bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ShellQuoteBoundaryFixture.ts"* ]]
}

@test "rejects a local shell-quoting class method" {
  printf '%s\n' \
    'export class Quoter { shellQuote(value: string): string { return value; } }' \
    > "$FIXTURE"

  run env SHELL_QUOTE_SOURCE_ROOT="$fixture_root" bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ShellQuoteBoundaryFixture.ts"* ]]
}

@test "rejects a local shell-quoting object property" {
  printf '%s\n' \
    'export const quoter = { quoteShellArg: (value: string): string => value };' \
    > "$FIXTURE"

  run env SHELL_QUOTE_SOURCE_ROOT="$fixture_root" bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ShellQuoteBoundaryFixture.ts"* ]]
}

@test "rejects a canonical shell-quoting implementation under a new name" {
  printf '%s\n' "export const quoteForShell = (value: string): string => \`'\${value.replace(/'/g, \"'\\\\''\")}'\`;" > "$FIXTURE"

  run env SHELL_QUOTE_SOURCE_ROOT="$fixture_root" bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ShellQuoteBoundaryFixture.ts"* ]]
}

@test "rejects a helper that returns only an escaped shell value" {
  printf '%s\n' "export function escapeShellValue(value: string): string { return value.replace(/'/g, \"'\\\"'\\\"'\"); }" > "$FIXTURE"

  run env SHELL_QUOTE_SOURCE_ROOT="$fixture_root" bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ShellQuoteBoundaryFixture.ts"* ]]
}

@test "rejects a helper that quotes an escaped temporary value" {
  printf '%s\n' \
    "export function quoteForShell(value: string): string { const escaped = value.replace(/'/g, \"'\\\\''\"); return \`'\${escaped}'\`; }" \
    > "$FIXTURE"

  run env SHELL_QUOTE_SOURCE_ROOT="$fixture_root" bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ShellQuoteBoundaryFixture.ts"* ]]
}

@test "rejects a helper that escapes a temporary inside a nested block" {
  printf '%s\n' \
    "export function quoteForShell(value: string): string { let escaped: string; if (value) { escaped = value.replace(/'/g, \"'\\\\''\"); } else { escaped = value; } return \`'\${escaped}'\`; }" \
    > "$FIXTURE"

  run env SHELL_QUOTE_SOURCE_ROOT="$fixture_root" bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"ShellQuoteBoundaryFixture.ts"* ]]
}
