#!/usr/bin/env bats
#
# Tests for scripts/versioning/bump-versions.sh
#
# The version bump script intentionally writes plain semver to runtime/package
# identity surfaces and writes -SNAPSHOT to Android Gradle dev/Maven coordinates.

SCRIPT_SRC="scripts/versioning/bump-versions.sh"
VERSION="1.2.3"

setup() {
  TEST_ROOT="$(mktemp -d)"
  SCRIPT_ABS="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)/$(basename "$SCRIPT_SRC")"
  BIN_DIR="${TEST_ROOT}/bin"
  mkdir -p "${TEST_ROOT}/.claude-plugin" \
    "${TEST_ROOT}/android/junit-runner" \
    "${TEST_ROOT}/android/playground/app" \
    "${TEST_ROOT}/ios/XCTestRunner/Sources/XCTestRunner" \
    "$BIN_DIR"
  write_fake_rg
  write_fixtures
  PATH="${BIN_DIR}:$PATH"
  export PATH
}

teardown() {
  rm -rf "$TEST_ROOT"
}

write_fake_rg() {
  cat > "${BIN_DIR}/rg" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

find android -name build.gradle.kts -type f -print0
EOF
  chmod +x "${BIN_DIR}/rg"
}

write_fixtures() {
  cat > "${TEST_ROOT}/package.json" <<'EOF'
{ "name": "@kaeawc/auto-mobile", "version": "0.0.1" }
EOF

  cat > "${TEST_ROOT}/.claude-plugin/plugin.json" <<'EOF'
{ "name": "auto-mobile", "version": "0.0.1" }
EOF

  cat > "${TEST_ROOT}/.claude-plugin/marketplace.json" <<'EOF'
{ "plugins": [ { "name": "auto-mobile", "version": "0.0.1" } ] }
EOF

  cat > "${TEST_ROOT}/server.json" <<'EOF'
{ "version": "0.0.1", "packages": [ { "identifier": "@kaeawc/auto-mobile", "version": "0.0.1" } ] }
EOF

  cat > "${TEST_ROOT}/android/gradle.properties" <<'EOF'
GROUP=dev.jasonpearson.auto-mobile
VERSION_NAME=0.0.1-SNAPSHOT
EOF

  cat > "${TEST_ROOT}/android/junit-runner/build.gradle.kts" <<'EOF'
version = "0.0.1-SNAPSHOT"
EOF

  cat > "${TEST_ROOT}/android/playground/app/build.gradle.kts" <<'EOF'
android {
  defaultConfig {
    versionName = "0.0.1-SNAPSHOT"
  }
}
EOF

  cat > "${TEST_ROOT}/ios/XCTestRunner/Sources/XCTestRunner/AutoMobileVersion.swift" <<'EOF'
enum AutoMobileVersion {
  public static let current = "0.0.1"
}
EOF
}

json_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
print(eval(sys.argv[2]))
PY
}

run_bump() {
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' --new-version '${VERSION}'"
}

@test "writes plain semver to package/runtime surfaces and SNAPSHOT to Android dev coordinates" {
  run_bump
  [ "$status" -eq 0 ]

  [ "$(json_field "${TEST_ROOT}/package.json" 'data["version"]')" = "$VERSION" ]
  [ "$(json_field "${TEST_ROOT}/.claude-plugin/plugin.json" 'data["version"]')" = "$VERSION" ]
  [ "$(json_field "${TEST_ROOT}/.claude-plugin/marketplace.json" 'data["plugins"][0]["version"]')" = "$VERSION" ]
  [ "$(json_field "${TEST_ROOT}/server.json" 'data["version"]')" = "$VERSION" ]
  [ "$(json_field "${TEST_ROOT}/server.json" 'data["packages"][0]["version"]')" = "$VERSION" ]

  grep -q "^VERSION_NAME=${VERSION}-SNAPSHOT$" "${TEST_ROOT}/android/gradle.properties"
  grep -q "^version = \"${VERSION}-SNAPSHOT\"$" "${TEST_ROOT}/android/junit-runner/build.gradle.kts"
  grep -q "versionName = \"${VERSION}-SNAPSHOT\"" "${TEST_ROOT}/android/playground/app/build.gradle.kts"
  grep -q "public static let current = \"${VERSION}\"" \
    "${TEST_ROOT}/ios/XCTestRunner/Sources/XCTestRunner/AutoMobileVersion.swift"
}

@test "dry-run output names SNAPSHOT as the Android dev/Maven coordinate policy" {
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' --new-version '${VERSION}' --dry-run"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Package/runtime version -> ${VERSION}"* ]]
  [[ "$output" == *"Android dev/Maven coordinate -> ${VERSION}-SNAPSHOT"* ]]
}
