#!/usr/bin/env bash
#
# Fast, hermetic TypeScript unit-test lane. Real socket, subprocess, file-system
# lifecycle, and device tests belong in `bun run test:integration`; this lane
# must remain safe to run continuously while editing.
set -euo pipefail

readonly UNIT_TEST_TIMEOUT_SECONDS="${AUTOMOBILE_UNIT_TEST_TIMEOUT_SECONDS:-15}"
readonly UNIT_TEST_WORKERS="${AUTOMOBILE_UNIT_TEST_WORKERS:-12}"
readonly UNIT_TEST_BASE_REF="${AUTOMOBILE_UNIT_TEST_BASE_REF:-origin/main}"

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

# shellcheck source=scripts/ios/run_with_timeout.sh
source scripts/ios/run_with_timeout.sh
run_with_timeout "${UNIT_TEST_TIMEOUT_SECONDS}" \
  bun test --changed="${UNIT_TEST_BASE_REF}" --parallel="${UNIT_TEST_WORKERS}" \
    --timeout 5000 --no-orphans "${ignore_args[@]}" "$@"
