#!/usr/bin/env bats
#
# Guards issue #11626: scripts/ios/swift-test.sh is the simulator-free "Test
# Swift Packages" step, but it ran every XCTestRunner test. RemindersAddPlanTests
# skips itself only when no simulator is booted and no daemon answers, so on a
# self-hosted Mac (which has both) it drove the machine's resident daemon and a
# simulator that belonged to another job, and failed the required iOS Build
# roll-up. The script must run XCTestRunner with the shared simulator-free class
# list. `swift` is stubbed; nothing is compiled and no simulator is touched.

setup() {
  repo_root="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  fixture="${BATS_TEST_TMPDIR}/repo"
  stubs="${BATS_TEST_TMPDIR}/stubs"
  mkdir -p "${fixture}/scripts/ios" "${fixture}/ios/XCTestRunner" "${fixture}/ios/highlight-core" "${stubs}"
  cp "${repo_root}/scripts/ios/"{swift-test,swift_test_counts,xctestrunner_test_filter}.sh "${fixture}/scripts/ios/"
  printf '%s\n' '.testTarget(name: "XCTestRunnerTests")' > "${fixture}/ios/XCTestRunner/Package.swift"
  printf '%s\n' '.testTarget(name: "HighlightCoreTests")' > "${fixture}/ios/highlight-core/Package.swift"
  export STUB_LOG="${BATS_TEST_TMPDIR}/swift.log"
  export STUB_LIST_MODE=ok
  : > "${STUB_LOG}"

  cat > "${stubs}/swift" << 'STUB'
#!/usr/bin/env bash
if [[ $1 == --version ]]; then
  echo "Apple Swift version stub"
  exit 0
fi
echo "$(basename "${PWD}"): swift $*" >> "${STUB_LOG}"
if [[ $1 == test && $2 == list ]]; then
  case "${STUB_LIST_MODE}" in
    fails)
      echo "error: no such module" >&2
      exit 1
      ;;
    only-simulator) echo 'XCTestRunnerTests.RemindersAddPlanTests/testAddReminderPlan' ;;
    *)
      echo 'XCTestRunnerTests.RemindersAddPlanTests/testAddReminderPlan'
      echo 'XCTestRunnerTests.RemindersLaunchPlanTests/testLaunchRemindersPlan'
      echo 'XCTestRunnerTests.PlanLoaderTests/testLoadsBundledPlan'
      ;;
  esac
  exit 0
fi
echo '	 Executed 2 tests, with 0 failures (0 unexpected) in 0.010 (0.011) seconds'
STUB
  chmod +x "${stubs}/swift"
  export PATH="${stubs}:${PATH}"
}

@test "XCTestRunner runs only the simulator-free classes" {
  run bash "${fixture}/scripts/ios/swift-test.sh"
  [ "${status}" -eq 0 ]
  [[ ${output} == *"XCTestRunner tests passed"* ]]
  test_line="$(grep '^XCTestRunner: swift test -Xswiftc' "${STUB_LOG}")"
  [[ ${test_line} == *'--filter XCTestRunnerTests\.(RemindersLaunchPlanTests|PlanLoaderTests)' ]]
  [[ ${test_line} != *RemindersAddPlanTests* ]]
  [ "$(grep -c '^XCTestRunner: swift test' "${STUB_LOG}")" -eq 2 ]
}

@test "discovery compiles with the same flags as the test run, so the build is reused" {
  run bash "${fixture}/scripts/ios/swift-test.sh"
  [ "${status}" -eq 0 ]
  grep -q '^XCTestRunner: swift test list -Xswiftc -warnings-as-errors$' "${STUB_LOG}"
}

@test "other packages still run their whole suite, unfiltered" {
  run bash "${fixture}/scripts/ios/swift-test.sh"
  [ "${status}" -eq 0 ]
  grep -q '^highlight-core: swift test -Xswiftc -warnings-as-errors$' "${STUB_LOG}"
  ! grep -q '^highlight-core: swift test list' "${STUB_LOG}"
}

@test "a failed discovery fails the package instead of running everything" {
  export STUB_LIST_MODE=fails
  run bash "${fixture}/scripts/ios/swift-test.sh"
  [ "${status}" -eq 1 ]
  [[ ${output} == *"error: no such module"* ]]
  [[ ${output} == *"XCTestRunner simulator-free test discovery failed"* ]]
  ! grep -q '^XCTestRunner: swift test -Xswiftc' "${STUB_LOG}"
  # The remaining packages are still tested and reported.
  [[ ${output} == *"highlight-core tests passed"* ]]
}

@test "a list holding only simulator-dependent classes fails rather than running none" {
  export STUB_LIST_MODE=only-simulator
  run bash "${fixture}/scripts/ios/swift-test.sh"
  [ "${status}" -eq 1 ]
  [[ ${output} == *"swift-test.sh: swift test list produced no simulator-free XCTestRunnerTests classes"* ]]
  ! grep -q '^XCTestRunner: swift test -Xswiftc' "${STUB_LOG}"
}
