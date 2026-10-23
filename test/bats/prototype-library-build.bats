#!/usr/bin/env bats
# Exercise build orchestration with fake Apple tools; no simulator is booted.
setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  FIXTURE="${BATS_TEST_TMPDIR}/repo space"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${FIXTURE}/scripts/ios" "${FIXTURE}/scripts/lib" \
    "${FIXTURE}/ios/prototype-agent/Fixtures/EmbedConsumer" "${MOCK_BIN}"
  cp "${REPO_ROOT}/scripts/ios/prototype-library-build.sh" \
    "${REPO_ROOT}/scripts/ios/local-sim-build-args.sh" "${FIXTURE}/scripts/ios/"
  cp "${REPO_ROOT}/scripts/lib/shell-core.sh" "${FIXTURE}/scripts/lib/"
  cp "${REPO_ROOT}/scripts/lib/spotlight-exclude.sh" "${FIXTURE}/scripts/lib/"
  SCRIPT="${FIXTURE}/scripts/ios/prototype-library-build.sh"
  export BUILD_LOG="${BATS_TEST_TMPDIR}/build.log"
  export AUTOMOBILE_SPOTLIGHT_EXCLUDE_FORCE=1
  unset AUTOMOBILE_SPOTLIGHT_EXCLUDE
  unset CI
  cat > "${MOCK_BIN}/uname" <<'SCRIPT'
#!/usr/bin/env bash
echo "${MOCK_ARCH:-arm64}"
SCRIPT
  cat > "${MOCK_BIN}/xcodebuild" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=%s\n' "$PWD" >> "$BUILD_LOG"
printf '<%s>\n' "$@" >> "$BUILD_LOG"
[[ "$1" == build && "$2" == -scheme && "$4" == -destination ]]
[[ "$5" == 'generic/platform=iOS Simulator' && "$6" == -derivedDataPath ]]
if [[ "$3" == "${FAIL_SCHEME:-}" ]]; then
  echo "build failed: $3" >&2
  exit 42
fi
SCRIPT
  chmod +x "${MOCK_BIN}/uname" "${MOCK_BIN}/xcodebuild"
  export PATH="${MOCK_BIN}:${PATH}"
}

@test "builds library then external consumer from their package roots with separate scratch output" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "${FIXTURE}/scratch/prototype-library/.metadata_never_index" ]
  [ "$(grep '^cwd=' "$BUILD_LOG")" = "$(printf 'cwd=%s\ncwd=%s' "$FIXTURE" "$FIXTURE/ios/prototype-agent/Fixtures/EmbedConsumer")" ]
  [ "$(grep -E '^<(AutoMobilePrototype|EmbedConsumer)>$' "$BUILD_LOG")" = $'<AutoMobilePrototype>\n<EmbedConsumer>' ]
  grep -Fx "<${FIXTURE}/scratch/prototype-library/library>" "$BUILD_LOG"
  grep -Fx "<${FIXTURE}/scratch/prototype-library/consumer>" "$BUILD_LOG"
  [ "$(grep -c '<ARCHS=arm64>' "$BUILD_LOG")" -eq 2 ]
  [ "$(grep -c '<COMPILER_INDEX_STORE_ENABLE=NO>' "$BUILD_LOG")" -eq 2 ]
}

@test "resolves a relative output from the caller and preserves spaces" {
  mkdir -p "${BATS_TEST_TMPDIR}/caller"
  run bash -c 'cd "$1" && bash "$2" "output space"' _ "${BATS_TEST_TMPDIR}/caller" "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -Fx "<${BATS_TEST_TMPDIR}/caller/output space/library>" "$BUILD_LOG"
  grep -Fx "<${BATS_TEST_TMPDIR}/caller/output space/consumer>" "$BUILD_LOG"
}

@test "keeps universal simulator settings on CI and Intel hosts" {
  for mode in ci intel; do
    rm -f "$BUILD_LOG"
    if [[ "$mode" == ci ]]; then
      CI=true run bash "$SCRIPT"
    else
      MOCK_ARCH=x86_64 run bash "$SCRIPT"
    fi
    [ "$status" -eq 0 ]
    ! grep -Eq '<(ARCHS|ONLY_ACTIVE_ARCH|COMPILER_INDEX_STORE_ENABLE)=' "$BUILD_LOG"
  done
}

@test "stops on library failure without attempting the consumer" {
  FAIL_SCHEME=AutoMobilePrototype run bash "$SCRIPT"
  [ "$status" -eq 42 ]
  [ "$(grep -c '^cwd=' "$BUILD_LOG")" -eq 1 ]
  [[ "$output" == *'build failed: AutoMobilePrototype'* ]]
}

@test "propagates consumer build failure" {
  FAIL_SCHEME=EmbedConsumer run bash "$SCRIPT"
  [ "$status" -eq 42 ]
  [ "$(grep -c '^cwd=' "$BUILD_LOG")" -eq 2 ]
  [[ "$output" == *'build failed: EmbedConsumer'* ]]
}
