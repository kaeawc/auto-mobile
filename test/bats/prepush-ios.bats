#!/usr/bin/env bats

setup() {
  repo_root="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  mock_bin="${BATS_TEST_TMPDIR}/bin"
  command_log="${BATS_TEST_TMPDIR}/commands.log"
  mkdir -p "${mock_bin}"

  for tool in swiftformat swiftlint swift git; do
    cat > "${mock_bin}/${tool}" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "${PREPUSH_IOS_COMMAND_LOG}"
if [[ $(basename "$0") == swiftformat && ${1:-} == --version ]]; then
  echo "0.54.6"
fi
if [[ ${PREPUSH_IOS_FAIL_TOOL:-} == $(basename "$0") ]]; then
  exit "${PREPUSH_IOS_FAIL_CODE:-1}"
fi
if [[ $(basename "$0") == git ]]; then
  echo "ios/XCTestRunner/Sources/XCTestRunnerTests/AutoMobileVersionTests.swift"
fi
MOCK
    chmod +x "${mock_bin}/${tool}"
  done
}

@test "prints usage without invoking tools" {
  run env PATH="${mock_bin}:${PATH}" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    bash "${repo_root}/scripts/prepush-ios.sh" --help

  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: scripts/prepush-ios.sh"* ]]
  [ ! -e "${command_log}" ]
}

@test "runs the pinned formatter, lint, build, and pure XCTestRunner subset" {
  run env PATH="${mock_bin}:${PATH}" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 0 ]
  run cat "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"swiftformat --version"* ]]
  [[ "$output" == *"swiftformat --lint ${repo_root}/ios/XCTestRunner/Sources/XCTestRunnerTests/AutoMobileVersionTests.swift"* ]]
  [[ "$output" == *"swiftlint lint --config ${repo_root}/.swiftlint.yml --path ${repo_root}/ios/XCTestRunner/Sources/XCTestRunnerTests/AutoMobileVersionTests.swift"* ]]
  [[ "$output" == *"swift build"* ]]
  [[ "$output" == *"swift test -Xswiftc -warnings-as-errors --filter"* ]]
}

@test "returns the first tool failure without running later checks" {
  run env PATH="${mock_bin}:${PATH}" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    PREPUSH_IOS_FAIL_TOOL=swiftlint PREPUSH_IOS_FAIL_CODE=17 \
    bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 17 ]
  run cat "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"swiftlint lint"* ]]
  [[ "$output" != *"swift build"* ]]
}
