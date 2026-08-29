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
    "${TEST_ROOT}/docs/using" \
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

  cat > "${TEST_ROOT}/docs/index.md" <<'EOF'
https://github.com/kaeawc/auto-mobile/releases/download/0.0.1/AutoMobile-0.0.1-macos.dmg
EOF
  cat > "${TEST_ROOT}/docs/using/ui-tests.md" <<'EOF'
testImplementation("dev.jasonpearson.auto-mobile:auto-mobile-junit-runner:0.0.1")
export AUTOMOBILE_VERSION=0.0.1
Replace `0.0.1` with the version used by your test runner dependency.
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
  grep -q "releases/download/${VERSION}/AutoMobile-${VERSION}-macos.dmg" \
    "${TEST_ROOT}/docs/index.md"
  grep -q "auto-mobile-junit-runner:${VERSION}" "${TEST_ROOT}/docs/using/ui-tests.md"
  grep -q "AUTOMOBILE_VERSION=${VERSION}" "${TEST_ROOT}/docs/using/ui-tests.md"
  grep -q "Replace \`${VERSION}\` with the version used by your test runner dependency" \
    "${TEST_ROOT}/docs/using/ui-tests.md"
  # The Swift constant must be *regenerated* (not regex-edited in place): assert
  # the generator's output markers so a regression back to an in-place edit fails.
  grep -q "public static let current = \"${VERSION}\"" \
    "${TEST_ROOT}/ios/XCTestRunner/Sources/XCTestRunner/AutoMobileVersion.swift"
  grep -q "GENERATED FILE — DO NOT EDIT" \
    "${TEST_ROOT}/ios/XCTestRunner/Sources/XCTestRunner/AutoMobileVersion.swift"
  grep -q "public enum AutoMobileVersion" \
    "${TEST_ROOT}/ios/XCTestRunner/Sources/XCTestRunner/AutoMobileVersion.swift"
}

@test "rejects a non-semver --new-version before writing anything" {
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' --new-version 'not-a-version'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid --new-version"* ]]
  # package.json must be untouched (no partial write).
  [ "$(json_field "${TEST_ROOT}/package.json" 'data["version"]')" = "0.0.1" ]
}

@test "dry-run output names SNAPSHOT as the Android dev/Maven coordinate policy" {
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' --new-version '${VERSION}' --dry-run"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Package/runtime version -> ${VERSION}"* ]]
  [[ "$output" == *"Android dev/Maven coordinate -> ${VERSION}-SNAPSHOT"* ]]
}

@test "rejects a semver whose pre-release/build has invalid characters (#3653)" {
  # A '/' (or '\', '&') in the build segment would break the downstream
  # sed/re.sub substitutions; the old `([-+].*)?` allowed it.
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' --new-version '1.2.3+a/b'"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Invalid --new-version"* ]]
}

@test "accepts a valid semver pre-release (#3653)" {
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' --new-version '1.2.3-beta.1' --dry-run"
  [ "$status" -eq 0 ]
}

@test "--print-managed-paths lists patterns without requiring a version or writing files (#5008)" {
  local marker="${TEST_ROOT}/.print-managed-paths-started"
  touch "$marker"
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' --print-managed-paths"
  [ "$status" -eq 0 ]
  [[ "$output" == *"package.json"* ]]
  [[ "$output" == *"android/*/build.gradle.kts"* ]]
  # No fixture file may be modified by a print-only invocation.
  ! find "${TEST_ROOT}" -type f -newer "$marker" \
    ! -path "$marker" -print -quit | grep -q .
}

@test "every file the bump rewrites matches a managed path pattern (#5008)" {
  # The prepare-release guard allow-lists exactly the patterns from
  # --print-managed-paths; a bump that writes an unlisted file would fail the
  # next release run, so catch the drift here instead.
  local marker="${TEST_ROOT}/.bump-started"
  touch "$marker"
  run_bump
  [ "$status" -eq 0 ]

  local patterns=()
  while IFS= read -r pattern; do
    patterns+=("$pattern")
  done < <(bash "${SCRIPT_ABS}" --print-managed-paths)
  (("${#patterns[@]}" > 0))

  local file rel pattern matched rewritten_count=0
  while IFS= read -r file; do
    rel="${file#"${TEST_ROOT}"/}"
    [[ "$rel" == bin/* ]] && continue
    rewritten_count=$((rewritten_count + 1))
    matched=false
    for pattern in "${patterns[@]}"; do
      # shellcheck disable=SC2053  # unquoted RHS: patterns must glob-match
      if [[ "$rel" == $pattern ]]; then
        matched=true
        break
      fi
    done
    if [[ "$matched" == false ]]; then
      echo "bump rewrote unmanaged file: $rel" >&2
      return 1
    fi
  done < <(find "${TEST_ROOT}" -type f -newer "$marker" ! -name "$(basename "$marker")")

  # Guard against a vacuous pass: the bump must have visibly rewritten files.
  (("$rewritten_count" > 0))
}

@test "bumping a version preserves the surrounding JSON formatting (#5743)" {
  # Reserializing with json.dump re-indents the whole file, exploding short
  # arrays onto one line per element. oxfmt collapses them back, so every
  # release commit landed a formatter failure on main.
  cat > "${TEST_ROOT}/package.json" <<'JSON'
{
  "name": "@kaeawc/auto-mobile",
  "version": "0.0.1",
  "keywords": ["mobile", "android", "ios"]
}
JSON

  cat > "${TEST_ROOT}/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "auto-mobile",
  "version": "0.0.1",
  "commands": ["./skills/"]
}
JSON

  cat > "${TEST_ROOT}/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "auto-mobile",
  "version": "1.0.0",
  "plugins": [
    {
      "name": "auto-mobile",
      "version": "0.0.1",
      "tags": ["android", "ios"]
    }
  ]
}
JSON

  cat > "${TEST_ROOT}/server.json" <<'JSON'
{
  "version": "0.0.1",
  "packages": [{ "identifier": "@kaeawc/auto-mobile", "version": "0.0.1" }]
}
JSON

  run_bump
  [ "$status" -eq 0 ]

  grep -qF '"keywords": ["mobile", "android", "ios"]' "${TEST_ROOT}/package.json"
  grep -qF '"commands": ["./skills/"]' "${TEST_ROOT}/.claude-plugin/plugin.json"
  grep -qF '"tags": ["android", "ios"]' "${TEST_ROOT}/.claude-plugin/marketplace.json"
  grep -qF '"packages": [{ "identifier": "@kaeawc/auto-mobile", "version": "1.2.3" }]' \
    "${TEST_ROOT}/server.json"

  # The marketplace *schema* version is not the plugin version and must not move.
  [ "$(json_field "${TEST_ROOT}/.claude-plugin/marketplace.json" 'data["version"]')" = "1.0.0" ]
  [ "$(json_field "${TEST_ROOT}/.claude-plugin/marketplace.json" 'data["plugins"][0]["version"]')" = "$VERSION" ]
  [ "$(json_field "${TEST_ROOT}/package.json" 'data["version"]')" = "$VERSION" ]
  [ "$(json_field "${TEST_ROOT}/.claude-plugin/plugin.json" 'data["version"]')" = "$VERSION" ]
  [ "$(json_field "${TEST_ROOT}/server.json" 'data["version"]')" = "$VERSION" ]
}

@test "syncs a diverged server.json packages[] version (#5743)" {
  # server.json's packages[] entries are named pointers, so a diverged entry is
  # brought back in line exactly as the old reserializing writer did.
  cat > "${TEST_ROOT}/server.json" <<'JSON'
{
  "version": "0.0.1",
  "packages": [{ "identifier": "@kaeawc/auto-mobile", "version": "0.0.0" }]
}
JSON

  run_bump
  [ "$status" -eq 0 ]
  [ "$(json_field "${TEST_ROOT}/server.json" 'data["version"]')" = "$VERSION" ]
  [ "$(json_field "${TEST_ROOT}/server.json" 'data["packages"][0]["version"]')" = "$VERSION" ]
}

@test "bumps only the pointed-at version when a sibling key shares its value (#5743)" {
  # marketplace.json's own schema version is a fixed "1.0.0". Once the plugin
  # reaches 1.0.0 the two values collide, and a value-matching rewrite would
  # drag the schema version along with the plugin version.
  cat > "${TEST_ROOT}/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "auto-mobile",
  "version": "1.0.0",
  "plugins": [{ "name": "auto-mobile", "version": "1.0.0" }]
}
JSON

  run_bump
  [ "$status" -eq 0 ]
  [ "$(json_field "${TEST_ROOT}/.claude-plugin/marketplace.json" 'data["version"]')" = "1.0.0" ]
  [ "$(json_field "${TEST_ROOT}/.claude-plugin/marketplace.json" 'data["plugins"][0]["version"]')" = "$VERSION" ]
}

@test "bumps only the AutoMobile marketplace entry, not a sibling plugin (#5743)" {
  # marketplace.json may list other, independently versioned plugins; the bump
  # owns plugins[0] only. server.json's packages[] entries are different — they
  # all describe this package, so they are all synced.
  cat > "${TEST_ROOT}/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "auto-mobile",
  "version": "1.0.0",
  "plugins": [
    { "name": "auto-mobile", "version": "0.0.1" },
    { "name": "somebody-elses-plugin", "version": "7.8.9" }
  ]
}
JSON

  run_bump
  [ "$status" -eq 0 ]
  [ "$(json_field "${TEST_ROOT}/.claude-plugin/marketplace.json" 'data["plugins"][0]["version"]')" = "$VERSION" ]
  [ "$(json_field "${TEST_ROOT}/.claude-plugin/marketplace.json" 'data["plugins"][1]["version"]')" = "7.8.9" ]
}
