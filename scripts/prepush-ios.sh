#!/usr/bin/env bash
# Fast, simulator-free iOS validation for a Swift change before it is pushed.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/prepush-ios.sh

Runs the pinned SwiftFormat lint, SwiftLint, XCTestRunner build, and its
simulator-free XCTestRunnerTests subset. Run it from any directory.
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

repo_root_status=0
repo_root="$(git -C "${project_root}" rev-parse --show-toplevel 2>/dev/null)" || repo_root_status=$?
if [[ ${repo_root_status} -ne 0 ]]; then
  echo "prepush-ios.sh: '${project_root}' is not inside a git checkout" >&2
  exit 1
fi

# shellcheck source=scripts/swiftformat/swiftformat_version.sh disable=SC1091
source "${project_root}/scripts/swiftformat/swiftformat_version.sh"
# shellcheck source=scripts/swiftlint/swiftlint_version.sh disable=SC1091
source "${project_root}/scripts/swiftlint/swiftlint_version.sh"
# shellcheck source=scripts/ios/swift_test_counts.sh disable=SC1091
source "${project_root}/scripts/ios/swift_test_counts.sh"

require_pinned_swiftformat_version

# Pre-push runs after a commit, so compare the branch to its merge-base with
# origin/main instead of relying on a dirty working tree. A local override keeps
# the command useful for a repository whose default remote uses another name.
base_ref="${PREPUSH_IOS_BASE_REF:-origin/main}"
base_ref_status=0
git -C "${repo_root}" rev-parse --verify "${base_ref}^{commit}" >/dev/null 2>&1 || base_ref_status=$?
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
  git -C "${repo_root}" diff --name-only -z --diff-filter=ACMR "${base_ref}...HEAD" -- 'ios/**/*.swift' \
    || printf '%s' "$?" > "${git_diff_status_file}"
)

git_diff_status=0
if [[ -s "${git_diff_status_file}" ]]; then
  git_diff_status="$(<"${git_diff_status_file}")"
fi
if [[ ${git_diff_status} -ne 0 ]]; then
  echo "prepush-ios.sh: git diff against '${base_ref}' failed" >&2
  exit 1
fi

if [[ ${#swift_files[@]} -eq 0 ]]; then
  echo "No changed Swift files relative to ${base_ref}; skipping SwiftFormat and SwiftLint."
else
  swiftformat --lint --config "${repo_root}/.swiftformat" ${swift_files[@]+"${swift_files[@]}"}
  if [[ -z "${PREPUSH_IOS_SKIP_SWIFTLINT_VERSION_CHECK:-}" ]]; then
    require_pinned_swiftlint_version
  fi
  # .swiftlint.yml marks force_unwrapping and force_try as errors, matching CI.
  for swift_file in ${swift_files[@]+"${swift_files[@]}"}; do
    swiftlint lint --config "${project_root}/.swiftlint.yml" "${swift_file}"
  done
fi

cd "${project_root}/ios/XCTestRunner"
swift build
# RemindersAddPlanTests extends RemindersIntegrationBase, which requires a
# booted Simulator and a live daemon, so it remains excluded from this run.
SIMULATOR_DEPENDENT_TEST_CLASSES=(
  RemindersAddPlanTests
)

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

test_classes=()
while IFS= read -r test_class; do
  [[ -z "${test_class}" ]] && continue
  simulator_dependent=false
  for excluded_class in "${SIMULATOR_DEPENDENT_TEST_CLASSES[@]}"; do
    if [[ "${test_class}" == "${excluded_class}" ]]; then
      simulator_dependent=true
      break
    fi
  done
  if [[ "${simulator_dependent}" == false ]]; then
    already_included=false
    for included_class in ${test_classes[@]+"${test_classes[@]}"}; do
      if [[ "${test_class}" == "${included_class}" ]]; then
        already_included=true
        break
      fi
    done
    if [[ "${already_included}" == false ]]; then
      test_classes+=("${test_class}")
    fi
  fi
done < <(
  printf '%s\n' "${swift_test_list_output}" | sed -n \
    -e 's/^XCTestRunnerTests\.\([^/]*\)\/.*/\1/p' \
    -e 's/^XCTestRunnerTests\.\([^/()]*\)()$/\1/p'
)

if [[ ${#test_classes[@]} -eq 0 ]]; then
  echo "prepush-ios.sh: swift test list produced no simulator-free XCTestRunnerTests classes after excluding the denylist; check swift test list output and SIMULATOR_DEPENDENT_TEST_CLASSES" >&2
  exit 1
fi

test_filter="XCTestRunnerTests\\.($(IFS='|'; printf '%s' "${test_classes[*]}"))"
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
