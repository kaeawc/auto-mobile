#!/usr/bin/env bats

setup() {
  script="$(pwd)/scripts/ios/shutdown-main-simulator.sh"
  stub_bin="${BATS_TEST_TMPDIR}/bin"
  calls="${BATS_TEST_TMPDIR}/simctl-calls"
  mkdir -p "${stub_bin}"
  : > "${calls}"
  cat > "${stub_bin}/xcrun" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SIMCTL_CALLS"
case "$*" in
  'simctl shutdown '*)
    if [[ "${REQUEST_MODE:-}" == timeout ]]; then
      sleep "${REQUEST_SLEEP:-0}"
      exit 124
    fi
    ;;
  'simctl list devices --json')
    sleep "${POLL_SLEEP:-0}"
    printf '%s\n' "${SIMULATOR_STATE:-Shutdown}"
    ;;
  *) exit 2 ;;
esac
EOF
  cat > "${stub_bin}/jq" <<'EOF'
#!/usr/bin/env bash
# Parsing may finish after the bounded xcrun poll and the shared deadline.
sleep "${POLL_PARSE_SLEEP:-0}"
cat
EOF
  cat > "${stub_bin}/timeout" <<'EOF'
#!/usr/bin/env bash
# The xcrun fixture supplies the request's 124 status; keep the timeout wrapper
# free of real delays so tests exercise the script's shared deadline quickly.
shift 2 # -k 2
shift   # seconds
"$@"
EOF
  chmod +x "${stub_bin}/xcrun" "${stub_bin}/jq" "${stub_bin}/timeout"
  udid="12345678-1234-1234-1234-123456789abc"
}

@test "immediate shutdown request and state observation succeed" {
  run env PATH="${stub_bin}:${PATH}" SIMCTL_CALLS="${calls}" \
    bash "${script}" "${udid}" 3
  [ "$status" -eq 0 ]
  [ "$(wc -l < "${calls}")" -eq 2 ]
  grep -q '^simctl shutdown ' "${calls}"
  grep -q '^simctl list devices --json$' "${calls}"
}

@test "timed-out shutdown request can settle within the shared deadline" {
  run env PATH="${stub_bin}:${PATH}" SIMCTL_CALLS="${calls}" \
    REQUEST_MODE=timeout REQUEST_SLEEP=1 SIMULATOR_STATE=Shutdown \
    bash "${script}" "${udid}" 4
  [ "$status" -eq 0 ]
  [[ "$output" == *"shutdown request timed out or failed"* ]]
  grep -q '^simctl list devices --json$' "${calls}"
}

@test "request time is included in the shared deadline" {
  run env PATH="${stub_bin}:${PATH}" SIMCTL_CALLS="${calls}" \
    REQUEST_MODE=timeout REQUEST_SLEEP=2 SIMULATOR_STATE=Shutdown \
    bash "${script}" "${udid}" 1
  [ "$status" -eq 1 ]
  [[ "$output" == *"did not reach Shutdown within 1 seconds"* ]]
  [ "$(wc -l < "${calls}")" -eq 1 ]
}

@test "last poll observing Shutdown at or after deadline still succeeds" {
  # The deadline uses whole-second SECONDS, so a 1s window can expire during
  # the request on a loaded runner and skip the poll entirely. A 2s window
  # always admits one poll; the 3s parse still finishes past the deadline.
  run env PATH="${stub_bin}:${PATH}" SIMCTL_CALLS="${calls}" \
    POLL_PARSE_SLEEP=3 SIMULATOR_STATE=Shutdown \
    bash "${script}" "${udid}" 2
  [ "$status" -eq 0 ]
  grep -q '^simctl list devices --json$' "${calls}"
}

@test "state that never reaches Shutdown fails" {
  run env PATH="${stub_bin}:${PATH}" SIMCTL_CALLS="${calls}" \
    SIMULATOR_STATE=Booted bash "${script}" "${udid}" 1
  [ "$status" -eq 1 ]
  [[ "$output" == *"did not reach Shutdown within 1 seconds"* ]]
}
