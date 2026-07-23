#!/usr/bin/env bats
#
# Tests for scripts/ci/verify-release-integrity.sh
#
# The gate asserts (1) version equality across every release manifest, the
# checksum registry, and the git tag, and (2) that the iOS runner-binary SHA256
# is populated. Fixtures are built aligned to VERSION, then individually
# perturbed to prove each divergence is caught.

SCRIPT_SRC="scripts/ci/verify-release-integrity.sh"
VERSION="0.0.40"
RUNNER_SHA="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

setup() {
  TEST_ROOT="$(mktemp -d)"
  SCRIPT_ABS="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)/$(basename "$SCRIPT_SRC")"
  mkdir -p "${TEST_ROOT}/.claude-plugin" \
    "${TEST_ROOT}/android" \
    "${TEST_ROOT}/src/constants"
  write_fixtures "$VERSION" "$VERSION-SNAPSHOT" "$VERSION" "$RUNNER_SHA"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

# write_fixtures <manifest_version> <gradle_version_name> <registry_version> <runner_sha>
write_fixtures() {
  local ver="$1" gradle="$2" registry="$3" runner="$4"

  cat > "${TEST_ROOT}/package.json" <<EOF
{ "name": "@kaeawc/auto-mobile", "version": "${ver}" }
EOF

  cat > "${TEST_ROOT}/.claude-plugin/plugin.json" <<EOF
{ "name": "auto-mobile", "version": "${ver}" }
EOF

  cat > "${TEST_ROOT}/.claude-plugin/marketplace.json" <<EOF
{ "version": "1.0.0", "plugins": [ { "name": "auto-mobile", "version": "${ver}" } ] }
EOF

  cat > "${TEST_ROOT}/server.json" <<EOF
{ "version": "${ver}", "packages": [ { "identifier": "@kaeawc/auto-mobile", "version": "${ver}" } ] }
EOF

  cat > "${TEST_ROOT}/android/gradle.properties" <<EOF
GROUP=dev.jasonpearson.auto-mobile
VERSION_NAME=${gradle}
EOF

  cat > "${TEST_ROOT}/src/constants/release.ts" <<EOF
export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry[] = [
  {
    version: "${registry}",
    apkSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ipaSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    runnerSha256: "${runner}",
    runnerSha256Target: "${runner_target:-xctest}",
  },
];
export const IOS_CTRL_PROXY_APP_HASH: string = "";
EOF
}

run_gate() {
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' '$1'"
}

run_gate_ipa() {
  run bash -c "cd '${TEST_ROOT}' && bash '${SCRIPT_ABS}' '$1' '$2'"
}

@test "IPA producer hashes the CtrlProxy xctest executable" {
  grep -Fq 'RUNNER_BINARY="${SIM_DIR}/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest/CtrlProxyUITests"' \
    scripts/ios/ctrl-proxy-create-ipa.sh
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  fi
}

# make_ipa <runner-binary-content> <out.ipa> — build a zip mirroring the real
# IPA layout (a zip of Build/Products) with the CtrlProxy xctest executable at
# the expected path, and echo the sha256 of that binary's content.
make_ipa() {
  local content="$1" out="$2"
  local stage xctest_dir
  stage="$(mktemp -d)"
  xctest_dir="${stage}/Build/Products/Debug-iphonesimulator/CtrlProxyUITests-Runner.app/PlugIns/CtrlProxyUITests.xctest"
  mkdir -p "$xctest_dir"
  printf '%s' "$content" > "${xctest_dir}/CtrlProxyUITests"
  ( cd "$stage" && zip -qr "$out" Build/Products/ )
  rm -rf "$stage"
  sha256_of "$content"
}

# make_ipa_with_stub <stub-content> <xctest-content> <out.ipa> — create the
# full layout, including Xcode's generic runner stub, and return the hash of
# the CtrlProxy code executable. The values deliberately differ so a consumer
# that targets the stub cannot accidentally pass.
make_ipa_with_stub() {
  local stub_content="$1" xctest_content="$2" out="$3"
  local stage runner_dir xctest_dir
  stage="$(mktemp -d)"
  runner_dir="${stage}/Build/Products/Debug-iphonesimulator/CtrlProxyUITests-Runner.app"
  xctest_dir="${runner_dir}/PlugIns/CtrlProxyUITests.xctest"
  mkdir -p "$xctest_dir"
  printf '%s' "$stub_content" > "${runner_dir}/CtrlProxyUITests-Runner"
  printf '%s' "$xctest_content" > "${xctest_dir}/CtrlProxyUITests"
  ( cd "$stage" && zip -qr "$out" Build/Products/ )
  rm -rf "$stage"
  sha256_of "$xctest_content"
}

@test "passes when all versions align and runner sha is populated" {
  run_gate "$VERSION"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Release integrity verified"* ]]
}

@test "accepts a git tag with a leading v" {
  run_gate "v${VERSION}"
  [ "$status" -eq 0 ]
}

@test "accepts VERSION_NAME with a -SNAPSHOT suffix (base compared)" {
  write_fixtures "$VERSION" "${VERSION}-SNAPSHOT" "$VERSION" "$RUNNER_SHA"
  run_gate "$VERSION"
  [ "$status" -eq 0 ]
}

@test "fails when the git tag diverges from the manifests" {
  run_gate "0.0.41"
  [ "$status" -ne 0 ]
  [[ "$output" == *"expected '0.0.41'"* ]]
}

@test "fails when package.json version diverges" {
  python3 - "${TEST_ROOT}/package.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["version"]="0.0.99"
json.dump(d,open(p,"w"))
PY
  run_gate "$VERSION"
  [ "$status" -ne 0 ]
  [[ "$output" == *"package.json"* ]]
}

@test "fails when plugin.json version diverges" {
  python3 - "${TEST_ROOT}/.claude-plugin/plugin.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["version"]="0.0.99"
json.dump(d,open(p,"w"))
PY
  run_gate "$VERSION"
  [ "$status" -ne 0 ]
  [[ "$output" == *"plugin.json"* ]]
}

@test "fails when marketplace plugins[0].version diverges" {
  python3 - "${TEST_ROOT}/.claude-plugin/marketplace.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["plugins"][0]["version"]="0.0.99"
json.dump(d,open(p,"w"))
PY
  run_gate "$VERSION"
  [ "$status" -ne 0 ]
  [[ "$output" == *"marketplace.json"* ]]
}

@test "fails when server.json package version diverges" {
  python3 - "${TEST_ROOT}/server.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["packages"][0]["version"]="0.0.99"
json.dump(d,open(p,"w"))
PY
  run_gate "$VERSION"
  [ "$status" -ne 0 ]
  [[ "$output" == *"server.json packages"* ]]
}

@test "fails when gradle VERSION_NAME base diverges" {
  write_fixtures "$VERSION" "0.0.99-SNAPSHOT" "$VERSION" "$RUNNER_SHA"
  run_gate "$VERSION"
  [ "$status" -ne 0 ]
  [[ "$output" == *"gradle.properties"* ]]
}

@test "fails when registry[0].version diverges" {
  write_fixtures "$VERSION" "${VERSION}-SNAPSHOT" "0.0.99" "$RUNNER_SHA"
  run_gate "$VERSION"
  [ "$status" -ne 0 ]
  [[ "$output" == *"registry"* ]]
}

@test "fails when runner sha256 is empty (verification disabled)" {
  write_fixtures "$VERSION" "${VERSION}-SNAPSHOT" "$VERSION" ""
  run_gate "$VERSION"
  [ "$status" -ne 0 ]
  [[ "$output" == *"registry[0].runnerSha256"* ]]
}

@test "fails when runner sha256 is malformed" {
  write_fixtures "$VERSION" "${VERSION}-SNAPSHOT" "$VERSION" "not-a-valid-sha"
  run_gate "$VERSION"
  [ "$status" -ne 0 ]
  [[ "$output" == *"registry[0].runnerSha256"* ]]
}

@test "fails when runner sha256 target is not the CtrlProxy xctest executable" {
  runner_target="runner"
  write_fixtures "0.0.40" "0.0.40-SNAPSHOT" "0.0.40" "$RUNNER_SHA"

  run_gate "0.0.40"

  [ "$status" -ne 0 ]
  [[ "$output" == *"runnerSha256Target must be 'xctest'"* ]]
}

@test "binds recorded runner sha to the CtrlProxy executable inside the IPA (match passes)" {
  local ipa="${TEST_ROOT}/control-proxy.ipa" sha
  sha="$(make_ipa "fake-runner-binary-bytes" "$ipa")"
  write_fixtures "$VERSION" "${VERSION}-SNAPSHOT" "$VERSION" "$sha"
  run_gate_ipa "$VERSION" "$ipa"
  [ "$status" -eq 0 ]
  [[ "$output" == *"matches the CtrlProxy executable inside the IPA"* ]]
}

@test "binds recorded runner sha to the CtrlProxy xctest executable, not the XCTRunner stub" {
  local ipa="${TEST_ROOT}/control-proxy.ipa" sha
  sha="$(make_ipa_with_stub "generic-xctrunner-stub" "ctrl-proxy-code" "$ipa")"
  write_fixtures "$VERSION" "${VERSION}-SNAPSHOT" "$VERSION" "$sha"
  run_gate_ipa "$VERSION" "$ipa"
  [ "$status" -eq 0 ]
  [[ "$output" == *"matches the CtrlProxy executable inside the IPA"* ]]
}

@test "fails when recorded runner sha does not match the IPA CtrlProxy executable (substitution)" {
  local ipa="${TEST_ROOT}/control-proxy.ipa"
  make_ipa "the-real-shipped-runner" "$ipa" >/dev/null
  # Record a valid-looking but WRONG sha (as if a tampered/stale runner shipped).
  write_fixtures "$VERSION" "${VERSION}-SNAPSHOT" "$VERSION" "$RUNNER_SHA"
  run_gate_ipa "$VERSION" "$ipa"
  [ "$status" -ne 0 ]
  [[ "$output" == *"does not match the CtrlProxy executable shipped"* ]]
}

@test "fails when the IPA path is given but the file is missing" {
  write_fixtures "$VERSION" "${VERSION}-SNAPSHOT" "$VERSION" "$RUNNER_SHA"
  run_gate_ipa "$VERSION" "${TEST_ROOT}/does-not-exist.ipa"
  [ "$status" -ne 0 ]
  [[ "$output" == *"IPA not found"* ]]
}

@test "fails when the IPA lacks the CtrlProxy xctest executable" {
  local ipa="${TEST_ROOT}/empty.ipa" stage
  stage="$(mktemp -d)"
  mkdir -p "${stage}/Build/Products/Debug-iphonesimulator"
  printf 'x' > "${stage}/Build/Products/Debug-iphonesimulator/unrelated.txt"
  ( cd "$stage" && zip -qr "$ipa" Build/Products/ )
  rm -rf "$stage"
  write_fixtures "$VERSION" "${VERSION}-SNAPSHOT" "$VERSION" "$RUNNER_SHA"
  run_gate_ipa "$VERSION" "$ipa"
  [ "$status" -ne 0 ]
  [[ "$output" == *"CtrlProxyUITests not found inside"* ]]
}
