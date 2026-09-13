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

# shellcheck source=scripts/swiftformat/swiftformat_version.sh disable=SC1091
source "${project_root}/scripts/swiftformat/swiftformat_version.sh"

require_pinned_swiftformat_version

# Pre-push runs after a commit, so compare the branch to its merge-base with
# origin/main instead of relying on a dirty working tree. A local override keeps
# the command useful for a repository whose default remote uses another name.
base_ref="${PREPUSH_IOS_BASE_REF:-origin/main}"
swift_files=()
while IFS= read -r relative_path; do
  [[ -n "${relative_path}" ]] && swift_files+=("${project_root}/${relative_path}")
done < <(git diff --name-only --diff-filter=ACMR "${base_ref}...HEAD" -- 'ios/**/*.swift')

if [[ ${#swift_files[@]} -eq 0 ]]; then
  echo "No changed Swift files relative to ${base_ref}; skipping SwiftFormat and SwiftLint."
else
  swiftformat --lint ${swift_files[@]+"${swift_files[@]}"}
  # .swiftlint.yml marks force_unwrapping and force_try as errors, matching CI.
  for swift_file in ${swift_files[@]+"${swift_files[@]}"}; do
    swiftlint lint --config "${project_root}/.swiftlint.yml" --path "${swift_file}"
  done
fi

cd "${project_root}/ios/XCTestRunner"
swift build
# These XCTestRunnerTests are pure Swift/package tests. Reminders and observation
# integration tests require a live daemon or Simulator and remain CI-only.
swift test -Xswiftc -warnings-as-errors \
  --filter 'XCTestRunnerTests\.(AutoMobileEnvironmentSocketPathTests|AutoMobileVersionTests|MCPEndpointTests|RecoveryExecutorTests|RecoveryConfigAndModelTests|TachikomaPlanRecoveryHandlerTests|PlanRecoverySecretRedactionTests|PlanMetadataSecretParametersParsingTests|SecretRedactionTests|RunBlockingBoundTests|RemindersPlanContentTests|TestTimingCacheTests|WireContractGoldenTests|XCTestRunnerTests)'
