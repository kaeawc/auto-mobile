#!/usr/bin/env bats

setup() {
  project_dir="${BATS_TEST_TMPDIR}/control-proxy"
  script="${BATS_TEST_DIRNAME}/../../scripts/check-ctrl-proxy-project-sources.sh"
  mkdir -p "${project_dir}/Sources/CtrlProxyRewrite" "${project_dir}/CtrlProxy.xcodeproj"
  cat > "${project_dir}/project.yml" <<'YAML'
targets:
  CtrlProxyUITests:
    sources:
      - path: Sources/CtrlProxyRewrite
YAML
  printf '%s\n' 'struct Existing {}' > "${project_dir}/Sources/CtrlProxyRewrite/Existing.swift"
  cat > "${project_dir}/CtrlProxy.xcodeproj/project.pbxproj" <<'PBX'
/* Begin PBXFileReference section */
  AAA /* Existing.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Existing.swift; sourceTree = "<group>"; };
/* End PBXFileReference section */
PBX
}

@test "accepts Swift sources listed in the checked-in Xcode project" {
  run env CTRL_PROXY_PROJECT_DIR="${project_dir}" bash "${script}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"references all 1 Swift files"* ]]
}

@test "handles a backslash-heavy unterminated path promptly" {
  {
    printf '%s' '/* Begin PBXFileReference section */
  BBB = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "'
    perl -e 'print "\\" x 256'
    printf '%s\n' '; sourceTree = "<group>"; };'
    printf '%s\n' '  AAA = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "Existing.swift"; sourceTree = "<group>"; };'
    printf '%s\n' '/* End PBXFileReference section */'
  } > "${project_dir}/CtrlProxy.xcodeproj/project.pbxproj"

  run perl -e 'alarm 3; exec @ARGV or die $!' \
    env CTRL_PROXY_PROJECT_DIR="${project_dir}" bash "${script}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"references all 1 Swift files"* ]]
}

@test "rejects a Swift source whose file reference was removed" {
  printf '%s\n' '/* Begin PBXFileReference section */' '/* End PBXFileReference section */' > \
    "${project_dir}/CtrlProxy.xcodeproj/project.pbxproj"
  run env CTRL_PROXY_PROJECT_DIR="${project_dir}" bash "${script}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"missing Existing.swift: 0/1"* ]]
}

@test "rejects a new Swift source missing from the checked-in Xcode project" {
  printf '%s\n' 'struct AppSwitcherDetector {}' > "${project_dir}/Sources/CtrlProxyRewrite/AppSwitcherDetector.swift"
  run env CTRL_PROXY_PROJECT_DIR="${project_dir}" bash "${script}"
  [ "${status}" -ne 0 ]
  [[ "${output}" == *"missing AppSwitcherDetector.swift: 0/1"* ]]
}

@test "prepush iOS compiles the CtrlProxy runner for changed Sources and honors the skip flag" {
  fixture="${BATS_TEST_TMPDIR}/prepush"
  mock_bin="${BATS_TEST_TMPDIR}/bin"
  repo_root="${BATS_TEST_DIRNAME}/../.."
  mkdir -p "${fixture}/scripts/swiftformat" "${fixture}/scripts/swiftlint" \
    "${fixture}/scripts/ios" "${fixture}/ios/XCTestRunner" "${mock_bin}"
  cp "${repo_root}/scripts/prepush-ios.sh" "${fixture}/scripts/prepush-ios.sh"
  cp "${repo_root}/scripts/swiftformat/swiftformat_version.sh" "${fixture}/scripts/swiftformat/"
  cp "${repo_root}/scripts/swiftlint/swiftlint_version.sh" "${fixture}/scripts/swiftlint/"
  cp "${repo_root}/scripts/ios/swift_test_counts.sh" "${fixture}/scripts/ios/"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "${fixture}/scripts/ios/api-dump.sh"
  chmod +x "${fixture}/scripts/ios/api-dump.sh"
  cat > "${fixture}/scripts/ios/ctrl-proxy-build-for-testing.sh" <<'RUNNER'
#!/usr/bin/env bash
echo "CtrlProxy runner build invoked"
RUNNER
  chmod +x "${fixture}/scripts/ios/ctrl-proxy-build-for-testing.sh"
  cat > "${mock_bin}/git" <<'GIT'
#!/usr/bin/env bash
case " $* " in
  *" --show-toplevel "*) echo "${PREPUSH_FIXTURE}" ;;
  *" --name-only -z "*) printf '%s\0' 'ios/control-proxy/Sources/CtrlProxyRewrite/New.swift' ;;
esac
GIT
  cat > "${mock_bin}/swiftformat" <<'FORMAT'
#!/usr/bin/env bash
[[ ${1:-} == --version ]] && echo '0.54.6'
exit 0
FORMAT
  cat > "${mock_bin}/swiftlint" <<'LINT'
#!/usr/bin/env bash
exit 0
LINT
  cat > "${mock_bin}/swift" <<'SWIFT'
#!/usr/bin/env bash
if [[ ${1:-} == test && ${2:-} == list ]]; then
  echo 'XCTestRunnerTests.ExampleTests/testExample'
elif [[ ${1:-} == test ]]; then
  echo 'Executed 1 tests, with 0 failures (0 unexpected)'
fi
SWIFT
  chmod +x "${mock_bin}"/*

  run env PATH="${mock_bin}:${PATH}" PREPUSH_FIXTURE="${fixture}" \
    PREPUSH_IOS_SKIP_SWIFTLINT_VERSION_CHECK=1 bash "${fixture}/scripts/prepush-ios.sh"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"CtrlProxy runner build invoked"* ]]

  run env PATH="${mock_bin}:${PATH}" PREPUSH_FIXTURE="${fixture}" \
    PREPUSH_IOS_SKIP_SWIFTLINT_VERSION_CHECK=1 PREPUSH_IOS_SKIP_CTRL_PROXY_RUNNER_BUILD=1 \
    bash "${fixture}/scripts/prepush-ios.sh"
  [ "${status}" -eq 0 ]
  [[ "${output}" != *"CtrlProxy runner build invoked"* ]]
}
