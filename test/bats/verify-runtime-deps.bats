#!/usr/bin/env bats
#
# Tests for scripts/ci/verify-runtime-deps.sh

SCRIPT="scripts/ci/verify-runtime-deps.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  # Resolve absolute paths for tools we need inside PATH-restricted tests
  CHMOD="$(command -v chmod)"
  RM="$(command -v rm)"
}

teardown() {
  "$RM" -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

create_mock_command() {
  printf '#!/bin/sh\nexit 0\n' > "${MOCK_BIN}/$1"
  "$CHMOD" +x "${MOCK_BIN}/$1"
}

@test "passes when all dependencies are present" {
  # All the tools should exist on the dev machine
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"All runtime dependencies verified."* ]]
}

@test "fails when bun is missing" {
  # Provide everything except bun — keep /usr/bin for bash/coreutils
  for cmd in bunx ffmpeg shellcheck jq rg; do
    create_mock_command "$cmd"
  done
  export PATH="${MOCK_BIN}:/usr/bin:/bin"
  export HOME="/nonexistent"

  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Missing runtime dependencies"* ]]
  [[ "$output" == *"bun"* ]]
}

@test "fails when multiple tools are missing" {
  # Only provide bun and bunx
  create_mock_command "bun"
  create_mock_command "bunx"
  export PATH="${MOCK_BIN}:/usr/bin:/bin"
  export HOME="/nonexistent"

  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Missing runtime dependencies"* ]]
  [[ "$output" == *"ffmpeg"* ]]
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}
