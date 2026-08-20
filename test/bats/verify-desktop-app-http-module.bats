#!/usr/bin/env bats
#
# Unit tests for scripts/ci/verify-desktop-app-http-module.sh. The jimage
# executable is injected so these tests do not require macOS or a real JDK image.

SCRIPT="scripts/ci/verify-desktop-app-http-module.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  APP="${TEST_ROOT}/AutoMobile.app"
  MODULE_IMAGE="${APP}/Contents/runtime/Contents/Home/lib/modules"
  mkdir -p "$(dirname "${MODULE_IMAGE}")"
  : >"${MODULE_IMAGE}"

  JIMAGE="${TEST_ROOT}/jimage"
  cat >"${JIMAGE}" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "list" ]; then
  echo "expected jimage list" >&2
  exit 2
fi

case "${JIMAGE_MODE:-present}" in
  present)
    printf '    java/net/http/HttpClient.class\n'
    # The class appears near the start of the real module image. Keep writing to
    # detect a grep -q regression that closes the pipe before jimage finishes.
    for _ in $(seq 1 1000); do
      printf '    java/lang/Object.class\n'
    done
    ;;
  missing) printf '    java/lang/Object.class\n' ;;
esac
FAKE
  chmod +x "${JIMAGE}"
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

@test "accepts an app runtime that contains HttpClient" {
  run env JIMAGE="${JIMAGE}" JIMAGE_MODE="present" "${SCRIPT}" "${APP}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Verified java.net.http"* ]]
}

@test "fails when the module image lacks HttpClient" {
  run env JIMAGE="${JIMAGE}" JIMAGE_MODE="missing" "${SCRIPT}" "${APP}"
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing java.net.http"* ]]
}

@test "errors when no app path is given" {
  run env JIMAGE="${JIMAGE}" "${SCRIPT}"
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage:"* ]]
}

@test "errors when the app path does not exist" {
  run env JIMAGE="${JIMAGE}" "${SCRIPT}" "${TEST_ROOT}/missing.app"
  [ "$status" -eq 2 ]
  [[ "$output" == *"app not found"* ]]
}

@test "errors when the app has no Java module image" {
  rm -f "${MODULE_IMAGE}"
  run env JIMAGE="${JIMAGE}" "${SCRIPT}" "${APP}"
  [ "$status" -eq 2 ]
  [[ "$output" == *"Java module image not found"* ]]
}

@test "errors when neither JIMAGE nor JAVA_HOME is available" {
  run env -u JIMAGE -u JAVA_HOME "${SCRIPT}" "${APP}"
  [ "$status" -eq 2 ]
  [[ "$output" == *"set JAVA_HOME or JIMAGE"* ]]
}
