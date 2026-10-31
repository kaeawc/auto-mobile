#!/usr/bin/env bats
# bats file_tags=parallel-within-file

setup() {
  REAL_BASH="$(type -P bash)"
  export REAL_BASH
  repo_root="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  mock_bin="${BATS_TEST_TMPDIR}/bin"
  command_log="${BATS_TEST_TMPDIR}/commands.log"
  mkdir -p "${mock_bin}"
  export PREPUSH_IOS_MOCK_REPO_ROOT="${repo_root}"

  # Avoid repeated real API dumps; test/bats/ios-api-dump.bats covers that script.
  cat > "${mock_bin}/bash" <<'MOCK'
#!/bin/bash
if [[ ${1:-} == */scripts/ios/api-dump.sh ]]; then
  echo "iOS API surface is up to date."
  exit 0
fi
exec "${REAL_BASH}" "$@"
MOCK
  chmod +x "${mock_bin}/bash"

  for tool in swiftformat swiftlint swift git bun; do
    cat > "${mock_bin}/${tool}" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "${PREPUSH_IOS_COMMAND_LOG}"
if [[ $(basename "$0") == bun ]]; then echo clean; exit 0; fi
if [[ $(basename "$0") == swiftformat && ${1:-} == --version ]]; then
  echo "0.54.6"
fi
if [[ $(basename "$0") == swiftlint && ${1:-} == version ]]; then
  echo "0.57.0"
fi
if [[ $(basename "$0") == swiftlint && " $* " == *" --path "* ]]; then
  echo "mock swiftlint: unsupported flag --path" >&2
  exit 2
fi
if [[ ${PREPUSH_IOS_FAIL_TOOL:-} == $(basename "$0") ]]; then
  exit "${PREPUSH_IOS_FAIL_CODE:-1}"
fi
if [[ $(basename "$0") == git ]]; then
  if [[ $* == *"--show-toplevel"* ]]; then
    echo "${PREPUSH_IOS_MOCK_REPO_ROOT}"
  elif [[ $* == *"rev-parse --verify"* ]]; then
    :
  elif [[ $* == *"--name-only -z"* ]]; then
    if [[ -n ${PREPUSH_IOS_CHANGED_PATH:-} ]]; then
      printf '%s\0' "${PREPUSH_IOS_CHANGED_PATH}"
    else
      printf '%s\0' "ios/XCTestRunner/Sources/XCTestRunnerTests/AutoMobileVersionTests.swift"
    fi
  else
    echo "ios/XCTestRunner/Sources/XCTestRunnerTests/AutoMobileVersionTests.swift"
  fi
fi
if [[ $(basename "$0") == swift && ${1:-} == test && ${2:-} == list ]]; then
  if [[ ${PREPUSH_IOS_SWIFT_TEST_LIST_DENYLIST_ONLY:-} == 1 ]]; then
    echo "XCTestRunnerTests.RemindersAddPlanTests/testExample"
  elif [[ ${PREPUSH_IOS_SWIFT_TEST_LIST_PARAMETERIZED_TOP_LEVEL:-} == 1 ]]; then
    echo "XCTestRunnerTests.plain()"
    echo "XCTestRunnerTests.param(_:)"
  elif [[ ${PREPUSH_IOS_SWIFT_TEST_LIST_BUILD_NOISE:-} == 1 ]]; then
    echo "Building for debugging..."
    echo "XCTestRunnerTests.AutoMobileVersionTests/testExample"
    echo "XCTestRunnerTests.topLevelExample()"
    echo "Build complete! (2.34s)"
  elif [[ ${PREPUSH_IOS_SWIFT_TEST_LIST_TOP_LEVEL_ONLY:-} == 1 ]]; then
    echo "XCTestRunnerTests.soloTopLevelExample()"
  elif [[ ${PREPUSH_IOS_SWIFT_TEST_LIST_TOP_LEVEL:-} == 1 ]]; then
    echo "XCTestRunnerTests.AutoMobileVersionTests/testExample"
    echo "XCTestRunnerTests.topLevelExample()"
  elif [[ ${PREPUSH_IOS_SWIFT_TEST_LIST_NON_ASCII:-} == 1 ]]; then
    echo "XCTestRunnerTests.CaféTests/testExample"
    echo "XCTestRunnerTests.PlainTests/testExample"
  else
    echo "XCTestRunnerTests.AutoMobileVersionTests/testExample"
    echo "XCTestRunnerTests.NewFeatureTests/testExample"
  fi
elif [[ $(basename "$0") == swift && ${1:-} == test ]]; then
  if [[ "$PWD" == */prototype-agent ]]; then
    echo "prototype-agent swift $*" >> "${PREPUSH_IOS_COMMAND_LOG}"
    if [[ -n ${PROTOVIEWER_TEST_FAILURE:-} ]]; then exit "$PROTOVIEWER_TEST_FAILURE"; fi
    if [[ ${PROTOVIEWER_ZERO_TESTS:-0} == 1 ]]; then
      echo "Executed 0 tests, with 0 failures"
      exit 0
    fi
  fi
  if [[ ${PREPUSH_IOS_SWIFT_TEST_ZERO:-} == 1 ]]; then
    echo "Executed 0 tests, with 0 failures (0 unexpected)"
  else
    echo "Executed 1 test, with 0 failures (0 unexpected)"
  fi
fi
MOCK
    chmod +x "${mock_bin}/${tool}"
  done
}

create_real_git_fixture() {
  fixture_root="${BATS_TEST_TMPDIR}/fixture-${BATS_TEST_NUMBER}"
  fixture_bin="${BATS_TEST_TMPDIR}/fixture-bin-${BATS_TEST_NUMBER}"
  mkdir -p "${fixture_root}/scripts/swiftformat" "${fixture_root}/scripts/swiftlint" "${fixture_root}/scripts/ios" "${fixture_root}/ios/XCTestRunner" "${fixture_root}/ios/Nested" "${fixture_bin}"
  fixture_root="$(cd "${fixture_root}" && pwd -P)"
  mkdir -p "${fixture_root}/scripts/lib"
  cp "${repo_root}/scripts/lib/spotlight-exclude.sh" "${fixture_root}/scripts/lib/"
  cp "${repo_root}/scripts/prepush-ios.sh" "${fixture_root}/scripts/prepush-ios.sh"
  cp "${repo_root}/scripts/swiftformat/swiftformat_version.sh" "${fixture_root}/scripts/swiftformat/swiftformat_version.sh"
  cp "${repo_root}/scripts/swiftlint/swiftlint_version.sh" "${fixture_root}/scripts/swiftlint/swiftlint_version.sh"
  cp "${repo_root}/scripts/ios/swift_test_counts.sh" "${fixture_root}/scripts/ios/swift_test_counts.sh"
  cp "${repo_root}/scripts/ios/xctestrunner_test_filter.sh" "${fixture_root}/scripts/ios/xctestrunner_test_filter.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "${fixture_root}/scripts/ios/api-dump.sh"
  for tool in swiftformat swiftlint swift bun; do
    cp "${mock_bin}/${tool}" "${fixture_bin}/${tool}"
  done

  git -C "${fixture_root}" init -q
  git -C "${fixture_root}" config user.email test@example.com
  git -C "${fixture_root}" config user.name Bats
  printf '%s\n' 'struct Foo {}' > "${fixture_root}/ios/Foo.swift"
  git -C "${fixture_root}" add .
  git -C "${fixture_root}" commit -qm base
  fixture_base_ref="$(git -C "${fixture_root}" rev-parse HEAD)"
}

commit_changed_swift_file() {
  printf '%s\n' 'struct Bar {}' > "${fixture_root}/ios/Nested/Bar.swift"
  git -C "${fixture_root}" add ios/Nested/Bar.swift
  git -C "${fixture_root}" commit -qm changed
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
  [[ "$output" == *"swiftformat --lint --config ${repo_root}/.swiftformat ${repo_root}/ios/XCTestRunner/Sources/XCTestRunnerTests/AutoMobileVersionTests.swift"* ]]
  [[ "$output" == *"swiftlint lint --config ${repo_root}/.swiftlint.yml --quiet ${repo_root}/ios"* ]]
  [[ "$output" == *"swift build"* ]]
  [[ "$output" == *"swift test -Xswiftc -warnings-as-errors --filter"* ]]
}

@test "returns the first tool failure without running later checks" {
  run env PATH="${mock_bin}:${PATH}" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    PREPUSH_IOS_FAIL_TOOL=swiftlint PREPUSH_IOS_FAIL_CODE=17 \
    PREPUSH_IOS_SKIP_SWIFTLINT_VERSION_CHECK=1 \
    bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 17 ]
  run cat "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"swiftlint lint"* ]]
  [[ "$output" != *"swift build"* ]]
}

@test "fails when the XCTestRunner filter executes zero tests" {
  run env PATH="${mock_bin}:${PATH}" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    PREPUSH_IOS_SWIFT_TEST_ZERO=1 bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"executed 0 tests"* ]]
  [[ "$output" == *"XCTestRunnerTests filter"* ]]
}

@test "finds a changed Swift file when invoked from a nested directory" {
  create_real_git_fixture
  commit_changed_swift_file

  run bash -c 'cd "$1" && env PATH="$2:$PATH" PREPUSH_IOS_BASE_REF="$3" PREPUSH_IOS_COMMAND_LOG="$4" bash "$5/scripts/prepush-ios.sh"' \
    bash "${fixture_root}/ios/Nested" "${fixture_bin}" "${fixture_base_ref}" "${command_log}" "${fixture_root}"

  [ "$status" -eq 0 ]
  run cat "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"swiftformat --lint --config ${fixture_root}/.swiftformat ${fixture_root}/ios/Nested/Bar.swift"* ]]
  [[ "$output" == *"swiftlint lint --config ${fixture_root}/.swiftlint.yml --quiet ${fixture_root}/ios"* ]]
  [[ "$output" != *"No changed Swift files"* ]]
}

@test "finds changed Swift files directly under ios and in nested directories" {
  create_real_git_fixture
  printf '%s\n' 'struct ChangedFoo {}' > "${fixture_root}/ios/Foo.swift"
  printf '%s\n' 'struct Bar {}' > "${fixture_root}/ios/Nested/Bar.swift"
  git -C "${fixture_root}" add ios/Foo.swift ios/Nested/Bar.swift
  git -C "${fixture_root}" commit -qm changed-top-level-and-nested

  run env PATH="${fixture_bin}:$PATH" PREPUSH_IOS_BASE_REF="${fixture_base_ref}" \
    PREPUSH_IOS_COMMAND_LOG="${command_log}" bash "${fixture_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 0 ]
  run cat "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"swiftformat --lint --config ${fixture_root}/.swiftformat ${fixture_root}/ios/Foo.swift ${fixture_root}/ios/Nested/Bar.swift"* ]]
  [[ "$output" == *"swiftlint lint --config ${fixture_root}/.swiftlint.yml --quiet ${fixture_root}/ios"* ]]
}

@test "finds a changed Swift file with a non-ASCII filename" {
  create_real_git_fixture
  printf '%s\n' 'struct Cafe {}' > "${fixture_root}/ios/Nested/Café.swift"
  git -C "${fixture_root}" add "ios/Nested/Café.swift"
  git -C "${fixture_root}" commit -qm changed-non-ascii

  run env PATH="${fixture_bin}:$PATH" PREPUSH_IOS_BASE_REF="${fixture_base_ref}" \
    PREPUSH_IOS_COMMAND_LOG="${command_log}" bash "${fixture_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 0 ]
  run cat "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"swiftformat --lint --config ${fixture_root}/.swiftformat ${fixture_root}/ios/Nested/Café.swift"* ]]
}

@test "derives the XCTestRunner filter from swift test list" {
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 0 ]
  run grep 'swift test -Xswiftc -warnings-as-errors --filter' "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"NewFeatureTests"* ]]
}

@test "includes non-ASCII XCTestRunner class names in the filter" {
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    PREPUSH_IOS_SWIFT_TEST_LIST_NON_ASCII=1 bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 0 ]
  run grep 'swift test -Xswiftc -warnings-as-errors --filter' "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CaféTests"* ]]
  [[ "$output" == *"PlainTests"* ]]
}

@test "includes top-level Swift Testing tests in the filter" {
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    PREPUSH_IOS_SWIFT_TEST_LIST_TOP_LEVEL=1 bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 0 ]
  run grep 'swift test -Xswiftc -warnings-as-errors --filter' "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"topLevelExample"* ]]
}

@test "excludes swift test list build noise from the XCTestRunner filter" {
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    PREPUSH_IOS_SWIFT_TEST_LIST_BUILD_NOISE=1 bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 0 ]
  run grep 'swift test -Xswiftc -warnings-as-errors --filter' "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" != *"Building for debugging"* ]]
  [[ "$output" != *"Build complete"* ]]
  [ "$(grep -o 'AutoMobileVersionTests' <<<"$output" | wc -l | tr -d ' ')" -eq 1 ]
  [ "$(grep -o 'topLevelExample' <<<"$output" | wc -l | tr -d ' ')" -eq 1 ]
}

@test "runs a list containing only a top-level Swift Testing test" {
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    PREPUSH_IOS_SWIFT_TEST_LIST_TOP_LEVEL_ONLY=1 bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 0 ]
  run grep 'swift test -Xswiftc -warnings-as-errors --filter' "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"soloTopLevelExample"* ]]
}

@test "includes parameterized top-level Swift Testing tests in the filter" {
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    PREPUSH_IOS_SWIFT_TEST_LIST_PARAMETERIZED_TOP_LEVEL=1 bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 0 ]
  run grep 'swift test -Xswiftc -warnings-as-errors --filter' "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"plain"* ]]
  [[ "$output" == *"param"* ]]
  [[ "$output" != *"param(_:)"* ]]
}

@test "fails when swift test list has only simulator-dependent classes" {
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    PREPUSH_IOS_SWIFT_TEST_LIST_DENYLIST_ONLY=1 bash "${repo_root}/scripts/prepush-ios.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"no simulator-free XCTestRunnerTests classes"* ]]
  run grep 'swift test -Xswiftc -warnings-as-errors --filter' "${command_log}"
  [ "$status" -ne 0 ]
}

@test "exits non-zero when the base ref does not exist" {
  create_real_git_fixture

  run env PATH="${fixture_bin}:${PATH}" PREPUSH_IOS_BASE_REF=refs/does/not/exist-at-all-xyz \
    PREPUSH_IOS_COMMAND_LOG="${command_log}" bash "${fixture_root}/scripts/prepush-ios.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"base ref"* ]]
  [[ "$output" == *"refs/does/not/exist-at-all-xyz"* ]]
}

@test "exits non-zero when not inside a git checkout" {
  outside_root="$(mktemp -d /tmp/prepush-ios-not-git.XXXXXX)"
  outside_bin="${BATS_TEST_TMPDIR}/outside-bin-${BATS_TEST_NUMBER}"
  mkdir -p "${outside_root}/scripts/swiftformat" "${outside_root}/scripts/ios" "${outside_root}/ios/XCTestRunner"
  mkdir -p "${outside_bin}"
  mkdir -p "${outside_root}/scripts/lib"
  cp "${repo_root}/scripts/lib/spotlight-exclude.sh" "${outside_root}/scripts/lib/"
  cp "${repo_root}/scripts/prepush-ios.sh" "${outside_root}/scripts/prepush-ios.sh"
  cp "${repo_root}/scripts/swiftformat/swiftformat_version.sh" "${outside_root}/scripts/swiftformat/swiftformat_version.sh"
  cp "${repo_root}/scripts/ios/swift_test_counts.sh" "${outside_root}/scripts/ios/swift_test_counts.sh"
  cp "${repo_root}/scripts/ios/xctestrunner_test_filter.sh" "${outside_root}/scripts/ios/xctestrunner_test_filter.sh"
  for tool in swiftformat swiftlint swift; do
    cp "${mock_bin}/${tool}" "${outside_bin}/${tool}"
  done

  run env PATH="${outside_bin}:${PATH}" PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    bash "${outside_root}/scripts/prepush-ios.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"not inside a git checkout"* ]]
}

@test "exits with a clear message when the test filter helper is missing" {
  create_real_git_fixture
  rm "${fixture_root}/scripts/ios/xctestrunner_test_filter.sh"

  run env PATH="${mock_bin}:${PATH}" PREPUSH_IOS_MOCK_REPO_ROOT="${fixture_root}" \
    PREPUSH_IOS_COMMAND_LOG="${command_log}" bash "${fixture_root}/scripts/prepush-ios.sh"

  [ "$status" -eq 1 ]
  [[ "$output" == "prepush-ios.sh: missing helper scripts/ios/xctestrunner_test_filter.sh (copy it alongside prepush-ios.sh in fixtures)" ]]
  run cat "${command_log}"
  [ "$status" -eq 0 ]
  [[ "$output" != *"swiftformat"* ]]
  [[ "$output" != *"swiftlint"* ]]
  [[ "$output" != *"swift "* ]]
}

install_attestation_recorder() {
  mkdir -p "${fixture_root}/scripts/ci"
  cat > "${fixture_root}/scripts/ci/record-attestations.sh" <<'SCRIPT'
#!/bin/bash
printf 'attestation %s\n' "$*" >> "${PREPUSH_IOS_COMMAND_LOG}"
SCRIPT
  chmod +x "${fixture_root}/scripts/ci/record-attestations.sh"
}

@test "attests partial scope and skipped lint when no Swift files changed" {
  create_real_git_fixture
  install_attestation_recorder
  run env PATH="${fixture_bin}:${PATH}" PREPUSH_IOS_BASE_REF="${fixture_base_ref}" \
    PREPUSH_IOS_COMMAND_LOG="${command_log}" /bin/bash "${fixture_root}/scripts/prepush-ios.sh"
  [ "$status" -eq 0 ]
  grep -F -- '--scope partial' "${command_log}"
  grep -F 'SwiftFormat=skip:0 SwiftLint=skip:0 CtrlProxy runner build=skip:0 ProtoViewer build/tests=skip:0' "${command_log}"
}

@test "attests full scope after lint and simulator-free tests" {
  create_real_git_fixture
  commit_changed_swift_file
  install_attestation_recorder
  run env PATH="${fixture_bin}:${PATH}" PREPUSH_IOS_BASE_REF="${fixture_base_ref}" \
    PREPUSH_IOS_COMMAND_LOG="${command_log}" /bin/bash "${fixture_root}/scripts/prepush-ios.sh"
  [ "$status" -eq 0 ]
  grep -F -- '--scope full' "${command_log}"
  grep -F 'SwiftFormat=pass:0 SwiftLint=pass:0' "${command_log}"
}

@test "runner build opt-out always marks iOS attestation partial" {
  create_real_git_fixture
  commit_changed_swift_file
  install_attestation_recorder
  run env PATH="${fixture_bin}:${PATH}" PREPUSH_IOS_BASE_REF="${fixture_base_ref}" \
    PREPUSH_IOS_SKIP_CTRL_PROXY_RUNNER_BUILD=1 PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    /bin/bash "${fixture_root}/scripts/prepush-ios.sh"
  [ "$status" -eq 0 ]
  grep -F -- '--scope partial --scope-note CtrlProxy runner build disabled' "${command_log}"
  grep -F 'CtrlProxy runner build=skip:0' "${command_log}"
}

setup_protoviewer_fixture() {
  create_real_git_fixture
  mkdir -p "${fixture_root}/ios/prototype-agent"
  install_attestation_recorder
  cat > "${fixture_root}/scripts/ios/protoviewer-build.sh" <<'SCRIPT'
#!/bin/bash
printf 'protoviewer-build %s\n' "$*" >> "${PREPUSH_IOS_COMMAND_LOG}"
exit "${PROTOVIEWER_BUILD_FAILURE:-0}"
SCRIPT
  chmod +x "${fixture_root}/scripts/ios/protoviewer-build.sh"
}

@test "ProtoViewer package changes run warnings-as-errors tests and app build" {
  setup_protoviewer_fixture
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_MOCK_REPO_ROOT="${fixture_root}" \
    PREPUSH_IOS_CHANGED_PATH=ios/prototype-agent/Package.swift PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    bash "${fixture_root}/scripts/prepush-ios.sh"
  [ "$status" -eq 0 ]
  grep -Fx 'prototype-agent swift test -Xswiftc -warnings-as-errors' "${command_log}"
  grep -Fx "protoviewer-build ${fixture_root}/scratch/protoviewer-prepush" "${command_log}"
  grep -F 'ProtoViewer build/tests=pass:0' "${command_log}"
}

@test "ProtoViewer build script changes select tests and build" {
  setup_protoviewer_fixture
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_MOCK_REPO_ROOT="${fixture_root}" \
    PREPUSH_IOS_CHANGED_PATH=scripts/ios/protoviewer-build.sh PREPUSH_IOS_COMMAND_LOG="${command_log}" \
    bash "${fixture_root}/scripts/prepush-ios.sh"
  [ "$status" -eq 0 ]
  grep -F 'prototype-agent swift test' "${command_log}"
  grep -F 'ProtoViewer build/tests=pass:0' "${command_log}"
}

@test "ProtoViewer opt-out skips tests and build and attests partial scope" {
  setup_protoviewer_fixture
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_MOCK_REPO_ROOT="${fixture_root}" \
    PREPUSH_IOS_CHANGED_PATH=ios/prototype-agent/Package.swift PREPUSH_IOS_SKIP_PROTOVIEWER=1 \
    PREPUSH_IOS_COMMAND_LOG="${command_log}" bash "${fixture_root}/scripts/prepush-ios.sh"
  [ "$status" -eq 0 ]
  run grep -F 'prototype-agent swift test' "${command_log}"
  [ "$status" -ne 0 ]
  run grep -F 'protoviewer-build ' "${command_log}"
  [ "$status" -ne 0 ]
  grep -F -- '--scope partial' "${command_log}"
  grep -F 'ProtoViewer build/tests disabled' "${command_log}"
  grep -F 'ProtoViewer build/tests=skip:0' "${command_log}"
}

@test "ProtoViewer zero executed tests fail before app build" {
  setup_protoviewer_fixture
  run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_MOCK_REPO_ROOT="${fixture_root}" \
    PREPUSH_IOS_CHANGED_PATH=ios/prototype-agent/Tests/Test.swift PROTOVIEWER_ZERO_TESTS=1 \
    PREPUSH_IOS_COMMAND_LOG="${command_log}" bash "${fixture_root}/scripts/prepush-ios.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *'prototype-agent executed 0 tests'* ]]
  run grep -F 'protoviewer-build ' "${command_log}"
  [ "$status" -ne 0 ]
}

@test "ProtoViewer test and build failures propagate without attesting success" {
  setup_protoviewer_fixture
  for failure in PROTOVIEWER_TEST_FAILURE PROTOVIEWER_BUILD_FAILURE; do
    : > "${command_log}"
    run env PATH="${mock_bin}:$PATH" PREPUSH_IOS_MOCK_REPO_ROOT="${fixture_root}" \
      PREPUSH_IOS_CHANGED_PATH=ios/prototype-agent/Package.swift "$failure=19" \
      PREPUSH_IOS_COMMAND_LOG="${command_log}" bash "${fixture_root}/scripts/prepush-ios.sh"
    [ "$status" -eq 19 ]
    run grep -F 'attestation ' "${command_log}"
    [ "$status" -ne 0 ]
  done
}
