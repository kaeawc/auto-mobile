#!/usr/bin/env bash
#
# Fast, hermetic TypeScript unit-test lane. Real socket, subprocess, file-system
# lifecycle, and device tests belong in `bun run test:integration`; this lane
# must remain safe to run continuously while editing.
set -euo pipefail

if [[ "${RUNNER_OS:-}" == "macOS" ]]; then
  default_timeout_seconds=720
  per_test_timeout_ms=20000
else
  default_timeout_seconds=720
  per_test_timeout_ms=5000
fi

readonly UNIT_TEST_TIMEOUT_SECONDS="${AUTOMOBILE_UNIT_TEST_TIMEOUT_SECONDS:-${default_timeout_seconds}}"
readonly UNIT_TEST_WORKERS="${AUTOMOBILE_UNIT_TEST_WORKERS:-12}"

changed_base_ref=""
remaining_args=()
has_remaining_args=false
for arg in "$@"; do
  case "$arg" in
    --changed=*)
      changed_base_ref="${arg#--changed=}"
      ;;
    *)
      remaining_args+=("$arg")
      has_remaining_args=true
      ;;
  esac
done

readonly -a integration_paths=(
  "test/contracts/runAll.test.ts"
  "test/daemon/daemonClient*.test.ts"
  "test/daemon/daemonManagerReadiness.test.ts"
  "test/daemon/socketServer*.test.ts"
  "test/daemon/socketServer/BaseSocketServerOwnership.test.ts"
  "test/daemon/videoStreamSocketServer.test.ts"
  "test/db/database*Migration*.test.ts"
  "test/features/video/FfmpegVideoProcessingBackend.test.ts"
  "test/integration/*.test.ts"
  "test/package/webrtcRuntimeMetadata.test.ts"
  "test/scripts/xcodegenDriftCheck.test.ts"
  "test/stress/*.test.ts"
  "test/utils/ios/IOSHostPortAvailabilityChecker.test.ts"
)

ignore_args=()
for path in "${integration_paths[@]}"; do
  ignore_args+=(--path-ignore-patterns "${path}")
done

test_args=(bun test --timeout "${per_test_timeout_ms}" --no-orphans)
if [[ "${RUNNER_OS:-}" != "Windows" ]]; then
  test_args+=(--parallel="${UNIT_TEST_WORKERS}")
fi
test_args+=(${ignore_args[@]+"${ignore_args[@]}"})

if [[ -n "$changed_base_ref" ]]; then
  base_commit="$(git merge-base "$changed_base_ref" HEAD)"
  changed_tests=()
  has_changed_tests=false
  while IFS= read -r path; do
    case "$path" in
      test/*.test.ts)
        changed_tests+=("$path")
        has_changed_tests=true
        ;;
    esac
  done < <(git diff --name-only "${base_commit}...HEAD" -- test)
  if [[ "$has_changed_tests" == "false" && "$has_remaining_args" == "false" ]]; then
    echo "No changed TypeScript tests relative to ${changed_base_ref}."
    exit 0
  fi
  if [[ "$has_changed_tests" == "true" ]]; then
    test_args+=("${changed_tests[@]}")
  fi
fi

# The validation wrapper passes scripts independently, so ShellCheck cannot follow this path.
# shellcheck disable=SC1091
source scripts/ios/run_with_timeout.sh
if [[ "$has_remaining_args" == "true" ]]; then
  run_with_timeout "${UNIT_TEST_TIMEOUT_SECONDS}" \
    "${test_args[@]}" "${remaining_args[@]}"
else
  run_with_timeout "${UNIT_TEST_TIMEOUT_SECONDS}" "${test_args[@]}"
fi
