#!/usr/bin/env bats
#
# Tests for scripts/android/start-emulator-wtf-session.sh
#
# Regression guard for #3651: the real ew-cli invocation used
#   --adb "${device_args[@]}"
# which, with no --device (empty device_args) under `set -u` on bash < 4.4
# (macOS default 3.2), aborts with "unbound variable" — while the dry-run path
# is guarded. The invocation must expand an empty array to nothing.

SCRIPT="scripts/android/start-emulator-wtf-session.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  STUB_DIR="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"

  # ew-cli: no-op session process.
  printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_DIR/ew-cli"
  # adb: report one connected device so the wait loop exits immediately.
  cat > "$STUB_DIR/adb" <<'EOF'
#!/usr/bin/env bash
echo "List of devices attached"
echo "emulator-5554	device"
EOF
  chmod +x "$STUB_DIR/ew-cli" "$STUB_DIR/adb"
}

teardown() {
  rm -rf "$STUB_DIR" "$WORK_DIR"
}

@test "starts a session with no --device without an unbound-variable abort" {
  # The bug only manifests on bash < 4.4; skip on newer bash (e.g. Linux CI).
  local major minor
  major="$(/bin/bash -c 'echo "${BASH_VERSINFO[0]}"')"
  minor="$(/bin/bash -c 'echo "${BASH_VERSINFO[1]}"')"
  if [[ "$major" -gt 4 || ( "$major" -eq 4 && "$minor" -ge 4 ) ]]; then
    skip "/bin/bash $major.$minor handles empty arrays under set -u"
  fi

  run env PATH="$STUB_DIR:$PATH" EW_API_TOKEN="dummy" \
    /bin/bash "$ABS_SCRIPT" --session-log "$WORK_DIR/session.log" --timeout 4 --poll-interval 1

  [ "$status" -eq 0 ]
  [[ "$output" == *"adb device connected"* ]]
  [[ "$output" != *"unbound variable"* ]]
}
