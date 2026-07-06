#!/usr/bin/env bats
#
# Tests for scripts/ios/xctestrunner-integration-tests.sh
# Runs a copied wrapper with stubbed simulator, Bun, CtrlProxy, warm-up, and Swift commands.

SCRIPT="scripts/ios/xctestrunner-integration-tests.sh"

setup() {
  WORKDIR="$(mktemp -d)"
  MOCK_BIN="${WORKDIR}/bin"
  PROJECT="${WORKDIR}/project"
  INVOCATIONS="${WORKDIR}/invocations"
  ORIG_PATH="$PATH"

  mkdir -p "${MOCK_BIN}" "${PROJECT}/scripts/ios" "${PROJECT}/scripts/ci" "${PROJECT}/ios/XCTestRunner"
  cp "$SCRIPT" "${PROJECT}/scripts/ios/xctestrunner-integration-tests.sh"

  cat > "${PROJECT}/scripts/ios/ctrl-proxy-verify-artifacts.sh" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT

  cat > "${PROJECT}/scripts/ci/warm-reminders-target-app.sh" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "warm-reminders-target-app" >> "${INVOCATIONS}"
SCRIPT

  cat > "${MOCK_BIN}/xcrun" <<'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "booted" ] && [ "$5" = "-j" ]; then
  printf '{"devices":{"iOS 18.0":[{"udid" : "BOOTED-UDID"}]}}\n'
  exit 0
fi
exit 1
SCRIPT

  cat > "${MOCK_BIN}/bun" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT

  cat > "${MOCK_BIN}/swift" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "swift \$*" >> "${INVOCATIONS}"
SCRIPT

  chmod +x \
    "${PROJECT}/scripts/ios/xctestrunner-integration-tests.sh" \
    "${PROJECT}/scripts/ios/ctrl-proxy-verify-artifacts.sh" \
    "${PROJECT}/scripts/ci/warm-reminders-target-app.sh" \
    "${MOCK_BIN}/xcrun" \
    "${MOCK_BIN}/bun" \
    "${MOCK_BIN}/swift"

  export PATH="${MOCK_BIN}:${PATH}"
}

teardown() {
  rm -rf "$WORKDIR"
  export PATH="$ORIG_PATH"
}

@test "script is executable" {
  [ -x "$SCRIPT" ]
}

@test "warms Reminders before the default launch integration test" {
  run "${PROJECT}/scripts/ios/xctestrunner-integration-tests.sh"
  [ "$status" -eq 0 ]
  [ "$(sed -n '1p' "$INVOCATIONS")" = "warm-reminders-target-app" ]
  [ "$(sed -n '2p' "$INVOCATIONS")" = "swift test --filter RemindersLaunchPlanTests" ]
}

@test "warms Reminders for explicit Reminders test filters" {
  run "${PROJECT}/scripts/ios/xctestrunner-integration-tests.sh" RemindersAddPlanTests
  [ "$status" -eq 0 ]
  grep -q '^warm-reminders-target-app$' "$INVOCATIONS"
  grep -q '^swift test --filter RemindersAddPlanTests$' "$INVOCATIONS"
}

@test "skips Reminders warm-up for unrelated filters and plans" {
  run env AUTOMOBILE_TEST_PLAN=Plans/list-devices.yaml "${PROJECT}/scripts/ios/xctestrunner-integration-tests.sh" ListDevicesPlanTests
  [ "$status" -eq 0 ]
  ! grep -q '^warm-reminders-target-app$' "$INVOCATIONS"
  grep -q '^swift test --filter ListDevicesPlanTests$' "$INVOCATIONS"
}
