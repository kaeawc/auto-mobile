#!/usr/bin/env bats

SCRIPT="scripts/ios/boot-simulator.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  export PATH="${MOCK_BIN}:${PATH}"
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

@test "script is an executable bash adapter" {
  [ -x "$SCRIPT" ]
  head -1 "$SCRIPT" | grep -q bash
}

@test "uses the non-erasing product command locally and preserves the 300s budget" {
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$BUN_ARGS_FILE"
printf '%s\n' '{"deviceId":"CI-UDID","name":"AutoMobile CI iPhone"}'
MOCK
  cat > "${MOCK_BIN}/xcrun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '26.5'
MOCK
  chmod +x "${MOCK_BIN}/bun"
  chmod +x "${MOCK_BIN}/xcrun"
  output_file="$(mktemp)"
  args_file="$(mktemp)"
  # GitHub Actions exports these globally; clear them so this case covers the
  # public local adapter rather than the private CI recovery path.
  # shellcheck disable=SC2016 # $1 expands in the child bash process.
  run env CI= GITHUB_ACTIONS= GITHUB_OUTPUT="$output_file" BUN_ARGS_FILE="$args_file" bash -c 'cd /tmp && "$1" --ios-version 26.5' _ "$(pwd)/$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" = "CI-UDID" ]
  [ "$(<"$output_file")" = "simulator_udid=CI-UDID" ]
  [[ "$(<"$args_file")" == *"src/index.ts"* ]]
  [[ "$(<"$args_file")" == *"--timeout-ms"* ]]
  [[ "$(<"$args_file")" == *"300000"* ]]
  [[ "$(<"$args_file")" == *"--min-os-version"* ]]
  [[ "$(<"$args_file")" == *"--max-os-version"* ]]
  rm -f "$output_file" "$args_file"
}

@test "uses the CI-only recovery command in GitHub Actions" {
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$BUN_ARGS_FILE"
printf '%s\n' '{"deviceId":"CI-UDID"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"
  args_file="$(mktemp)"
  run env CI=true GITHUB_ACTIONS=true BUN_ARGS_FILE="$args_file" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$(<"$args_file")" == *"src/ci/bootIosSimulatorCli.ts"* ]]
  [[ "$(<"$args_file")" == *"300000"* ]]
  rm -f "$args_file"
}

@test "fails when the CI product command does not return a deviceId" {
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '{}'
MOCK
  chmod +x "${MOCK_BIN}/bun"
  # Pin CI/GITHUB_ACTIONS instead of inheriting the runner's: under real GitHub
  # Actions an unpinned case silently exercises whichever branch the runner's
  # environment selects (#4212).
  run env CI=true GITHUB_ACTIONS=true bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"returned no deviceId"* ]]
}

@test "fails when the local product command does not return a deviceId" {
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '{}'
MOCK
  cat > "${MOCK_BIN}/xcrun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' '26.5'
MOCK
  chmod +x "${MOCK_BIN}/bun"
  chmod +x "${MOCK_BIN}/xcrun"
  run env CI= GITHUB_ACTIONS= bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"returned no deviceId"* ]]
}

@test "CI branch survives an empty optional-arg array on bash 3.2" {
  # /bin/bash is 3.2 on macOS (and on the macos-latest runner), where an empty
  # "${arr[@]}" under set -u aborts with "unbound variable". Bash 4.4+
  # special-cases it, so this regression is invisible on the ubuntu legs.
  if ! /bin/bash -c 'set -u; a=(); b=(x "${a[@]}")' 2>/dev/null; then
    :
  else
    skip "/bin/bash already special-cases empty array expansion (bash >= 4.4)"
  fi
  cat > "${MOCK_BIN}/bun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$BUN_ARGS_FILE"
printf '%s\n' '{"deviceId":"CI-UDID"}'
MOCK
  chmod +x "${MOCK_BIN}/bun"
  args_file="$(mktemp)"
  run env CI=true GITHUB_ACTIONS=true BUN_ARGS_FILE="$args_file" /bin/bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$output" = "CI-UDID" ]
  [[ "$(<"$args_file")" == *"src/ci/bootIosSimulatorCli.ts"* ]]
  rm -f "$args_file"
}
