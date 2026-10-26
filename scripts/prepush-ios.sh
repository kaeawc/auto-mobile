#!/usr/bin/env bash
# Fast, simulator-free iOS validation for a Swift change before it is pushed.
# PREPUSH_IOS_SKIP_CTRL_PROXY_RUNNER_BUILD=1 skips the CtrlProxy Xcode runner
# compile for ios/control-proxy/Sources changes when a local Xcode build is unavailable.
# PREPUSH_IOS_SKIP_PROTOVIEWER=1 skips ProtoViewer tests/build without the iphonesimulator SDK.
set -euo pipefail

usage() {
  cat << 'EOF'
Usage: scripts/prepush-ios.sh

Runs the pinned SwiftFormat lint, SwiftLint, XCTestRunner build, and its
simulator-free XCTestRunnerTests subset. CtrlProxy source changes also compile
the Xcode UI test runner. ProtoViewer package or build-script changes also run
simulator-free prototype-agent tests and compile the app. Run it from any directory.
PREPUSH_IOS_SKIP_PROTOVIEWER=1 skips both ProtoViewer checks (partial attestation)
for hosts without the iphonesimulator SDK.
EOF
}

if [[ $# -gt 0 ]]; then
  if [[ $# -eq 1 && $1 == "--help" ]]; then
    usage
    exit 0
  fi
  usage >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"
# shellcheck source=scripts/lib/spotlight-exclude.sh
source "${project_root}/scripts/lib/spotlight-exclude.sh"

attestation_head=""
if [[ -e "${project_root}/.git" ]]; then
  attestation_head="$(git -C "${project_root}" rev-parse HEAD 2>/dev/null || true)"
elif [[ -d "${project_root}/.jj" ]]; then
  attestation_head="$(jj -R "${project_root}" log -r @- --no-graph -T commit_id 2>/dev/null || true)"
fi
# Failure to capture initial cleanliness must suppress the attestation.
attestation_start="$(bun "${project_root}/scripts/ci/produce-attestations.ts" --print-dirty-at-start --lane ios 2>/dev/null || true)"
attestation_options=(--expected-head "$attestation_head")
if [[ "$attestation_start" != clean ]]; then
  attestation_options+=(--started-dirty)
fi

repo_root_status=0
repo_root="$(git -C "${project_root}" rev-parse --show-toplevel 2> /dev/null)" || repo_root_status=$?
if [[ ${repo_root_status} -ne 0 ]]; then
  echo "prepush-ios.sh: '${project_root}' is not inside a git checkout" >&2
  exit 1
fi

# shellcheck source=scripts/swiftformat/swiftformat_version.sh
source "${project_root}/scripts/swiftformat/swiftformat_version.sh"
# shellcheck source=scripts/swiftlint/swiftlint_version.sh
source "${project_root}/scripts/swiftlint/swiftlint_version.sh"
# shellcheck source=scripts/ios/swift_test_counts.sh
source "${project_root}/scripts/ios/swift_test_counts.sh"

if [[ ! -f "${project_root}/scripts/ios/xctestrunner_test_filter.sh" ]]; then
  echo "prepush-ios.sh: missing helper scripts/ios/xctestrunner_test_filter.sh (copy it alongside prepush-ios.sh in fixtures)" >&2
  exit 1
fi
# shellcheck source=scripts/ios/xctestrunner_test_filter.sh
source "${project_root}/scripts/ios/xctestrunner_test_filter.sh"

require_pinned_swiftformat_version

# Pre-push runs after a commit, so compare the branch to its merge-base with
# origin/main instead of relying on a dirty working tree. A local override keeps
# the command useful for a repository whose default remote uses another name.
base_ref="${PREPUSH_IOS_BASE_REF:-origin/main}"
base_ref_status=0
git -C "${repo_root}" rev-parse --verify "${base_ref}^{commit}" > /dev/null 2>&1 || base_ref_status=$?
if [[ ${base_ref_status} -ne 0 ]]; then
  echo "prepush-ios.sh: base ref '${base_ref}' not found; set PREPUSH_IOS_BASE_REF to a valid ref" >&2
  exit 1
fi

git_diff_status_file="$(mktemp)"
trap 'rm -f "${git_diff_status_file}"' EXIT

swift_files=()
while IFS= read -r -d '' relative_path; do
  [[ -n "${relative_path}" ]] && swift_files+=("${project_root}/${relative_path}")
done < <(
  git -C "${repo_root}" diff --name-only -z --diff-filter=ACMR "${base_ref}...HEAD" -- 'ios/**/*.swift' 'ios/*.swift' \
    || printf '%s' "$?" > "${git_diff_status_file}"
)

git_diff_status=0
if [[ -s "${git_diff_status_file}" ]]; then
  git_diff_status="$(< "${git_diff_status_file}")"
fi
if [[ ${git_diff_status} -ne 0 ]]; then
  echo "prepush-ios.sh: git diff against '${base_ref}' failed" >&2
  exit 1
fi

protoviewer_changed=false
while IFS= read -r -d '' relative_path; do
  case "${relative_path}" in
    ios/prototype-agent/*|scripts/ios/protoviewer-build.sh) protoviewer_changed=true ;;
  esac
done < <(
  git -C "${repo_root}" diff --name-only -z "${base_ref}...HEAD" -- ios/prototype-agent/ scripts/ios/protoviewer-build.sh \
    || printf '%s' "$?" > "${git_diff_status_file}"
)
if [[ -s "${git_diff_status_file}" ]]; then
  echo "prepush-ios.sh: git diff against '${base_ref}' failed" >&2
  exit 1
fi

ctrl_proxy_sources_changed=false
for swift_file in ${swift_files[@]+"${swift_files[@]}"}; do
  if [[ "${swift_file}" == "${project_root}/ios/control-proxy/Sources/"* ]]; then
    ctrl_proxy_sources_changed=true
    break
  fi
done

attestation_scope=full
attestation_note=""
attestation_lint=pass
attestation_runner=skip
attestation_protoviewer=skip
if [[ "${PREPUSH_IOS_SKIP_CTRL_PROXY_RUNNER_BUILD:-0}" == 1 ]]; then
  attestation_scope=partial
  attestation_note="CtrlProxy runner build disabled"
fi
if [[ "${PREPUSH_IOS_SKIP_PROTOVIEWER:-0}" == 1 ]]; then
  attestation_scope=partial
  attestation_note="${attestation_note:+${attestation_note}; }ProtoViewer build/tests disabled"
fi
if [[ ${#swift_files[@]} -eq 0 ]]; then
  attestation_scope=partial
  attestation_note="no changed Swift files; lint skipped; ${attestation_note}"
  attestation_lint=skip
  echo "No changed Swift files relative to ${base_ref}; skipping SwiftFormat and SwiftLint."
else
  swiftformat --lint --config "${repo_root}/.swiftformat" ${swift_files[@]+"${swift_files[@]}"}
  if [[ -z "${PREPUSH_IOS_SKIP_SWIFTLINT_VERSION_CHECK:-}" ]]; then
    require_pinned_swiftlint_version
  fi
  # CI (scripts/swiftlint/validate_swiftlint.sh) lints the WHOLE ios/ tree, not just the
  # branch's diff, so a violation already on main (or in a file this branch did not touch)
  # fails the PR's SwiftLint job. Lint the same tree here with the same config; error-severity
  # rules (force_unwrapping, force_try, ...) make swiftlint exit non-zero.
  swiftlint lint --config "${project_root}/.swiftlint.yml" --quiet "${project_root}/ios"
fi

echo "Checking iOS SDK public API baseline"
bash "${project_root}/scripts/ios/api-dump.sh" --check

cd "${project_root}/ios/XCTestRunner"
swift build
swift_test_list_status=0
if swift_test_list_output="$(swift test list 2>&1)"; then
  :
else
  swift_test_list_status=$?
fi
if [[ ${swift_test_list_status} -ne 0 ]]; then
  echo "${swift_test_list_output}" >&2
  echo "prepush-ios.sh: swift test list failed" >&2
  exit 1
fi

xctestrunner_build_test_filter "${swift_test_list_output}"
test_filter="${XCTESTRUNNER_TEST_FILTER}"
if test_output="$(swift test -Xswiftc -warnings-as-errors \
  --filter "${test_filter}" \
  2>&1)"; then
  test_rc=0
else
  test_rc=$?
fi
echo "${test_output}"
executed_test_count "${test_output}"

if [[ ${test_rc} -ne 0 ]]; then
  exit "${test_rc}"
fi
if [[ ${EXECUTED_TESTS} -eq 0 ]]; then
  echo "prepush-ios.sh: XCTestRunnerTests filter executed 0 tests; check the --filter expression" >&2
  exit 1
fi

if [[ "${ctrl_proxy_sources_changed}" == true && "${PREPUSH_IOS_SKIP_CTRL_PROXY_RUNNER_BUILD:-0}" != 1 ]]; then
  attestation_runner=pass
  echo "Compiling CtrlProxy iOS UI test runner for changed Sources"
  mkdir_spotlight_excluded_within "${project_root}" "${AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA:-${project_root}/scratch/ctrl-proxy-prepush-derived-data}"
  AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA="${AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA:-${project_root}/scratch/ctrl-proxy-prepush-derived-data}" \
    "${project_root}/scripts/ios/ctrl-proxy-build-for-testing.sh"
fi
if [[ "${protoviewer_changed}" == true && "${PREPUSH_IOS_SKIP_PROTOVIEWER:-0}" != 1 ]]; then
  echo "Testing prototype-agent and building ProtoViewer for changed package/build script"
  if test_output="$(cd "${project_root}/ios/prototype-agent" && swift test -Xswiftc -warnings-as-errors 2>&1)"; then
    test_rc=0
  else
    test_rc=$?
  fi
  echo "${test_output}"
  executed_test_count "${test_output}"
  if [[ ${test_rc} -ne 0 ]]; then
    exit "${test_rc}"
  fi
  if [[ ${EXECUTED_TESTS} -eq 0 ]]; then
    echo "prepush-ios.sh: prototype-agent executed 0 tests" >&2
    exit 1
  fi
  bun "${project_root}/scripts/ios/protoviewer-notices.ts" --check
  bun "${project_root}/scripts/ios/check-privacy-manifests.ts"
  "${project_root}/scripts/ios/protoviewer-build.sh" "${project_root}/scratch/protoviewer-prepush"
  attestation_protoviewer=pass
fi
"${project_root}/scripts/ci/record-attestations.sh" ios "${attestation_options[@]}" --scope "$attestation_scope" --scope-note "$attestation_note" "SwiftFormat=${attestation_lint}:0" "SwiftLint=${attestation_lint}:0" "CtrlProxy runner build=${attestation_runner}:0" "ProtoViewer build/tests=${attestation_protoviewer}:0" 'XCTestRunner build/tests and API baseline=pass:0' || true
