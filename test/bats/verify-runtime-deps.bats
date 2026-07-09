#!/usr/bin/env bats
#
# Tests for scripts/ci/verify-runtime-deps.sh

# shellcheck disable=SC2030,SC2031

SCRIPT="scripts/ci/verify-runtime-deps.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  TEST_HOME="$(mktemp -d)"
  ORIG_PATH="$PATH"
  # Resolve absolute paths for tools we need inside PATH-restricted tests
  CHMOD="$(command -v chmod)"
  MKDIR="$(command -v mkdir)"
  RM="$(command -v rm)"
}

teardown() {
  "$RM" -rf "$MOCK_BIN"
  "$RM" -rf "$TEST_HOME"
  export PATH="$ORIG_PATH"
}

create_mock_command() {
  printf '#!/bin/sh\nexit 0\n' > "${MOCK_BIN}/$1"
  "$CHMOD" +x "${MOCK_BIN}/$1"
}

@test "passes when all dependencies are present" {
  # Skip on CI runners that may not have all tools installed
  for cmd in bun bunx ffmpeg shellcheck jq rg; do
    command -v "$cmd" >/dev/null 2>&1 || skip "missing $cmd — not a full dev environment"
  done

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"All runtime dependencies verified."* ]]
}

@test "fails when bun is missing" {
  # Provide everything except bun — keep /usr/bin for bash/coreutils
  for cmd in bunx ffmpeg shellcheck jq rg; do
    create_mock_command "$cmd"
  done
  printf '#!/bin/sh\nprintf "Linux\\n"\n' > "${MOCK_BIN}/uname"
  "$CHMOD" +x "${MOCK_BIN}/uname"
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
  printf '#!/bin/sh\nprintf "Linux\\n"\n' > "${MOCK_BIN}/uname"
  "$CHMOD" +x "${MOCK_BIN}/uname"
  export PATH="${MOCK_BIN}:/usr/bin:/bin"
  export HOME="/nonexistent"

  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Missing runtime dependencies"* ]]
  [[ "$output" == *"ffmpeg"* ]]
}

@test "macOS refreshes PATH from Homebrew prefix before verifying dependencies" {
  homebrew_prefix="${TEST_HOME}/homebrew"
  "$MKDIR" -p "${homebrew_prefix}/bin"

  printf '#!/bin/sh\nprintf "Darwin\\n"\n' > "${MOCK_BIN}/uname"
  "$CHMOD" +x "${MOCK_BIN}/uname"
  cat > "${MOCK_BIN}/brew" <<'STUB'
#!/bin/sh
printf '%s\n' "${FAKE_HOMEBREW_PREFIX:?}"
STUB
  "$CHMOD" +x "${MOCK_BIN}/brew"

  for cmd in bun bunx ffmpeg shellcheck jq rg yq swiftformat swiftlint iproxy; do
    printf '#!/bin/sh\nexit 0\n' > "${homebrew_prefix}/bin/${cmd}"
    "$CHMOD" +x "${homebrew_prefix}/bin/${cmd}"
  done

  export PATH="${MOCK_BIN}:/usr/bin:/bin"
  export HOME="${TEST_HOME}"
  export FAKE_HOMEBREW_PREFIX="${homebrew_prefix}"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"All runtime dependencies verified."* ]]
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "script has bash shebang" {
  head -1 "$SCRIPT" | grep -q "bash"
}
