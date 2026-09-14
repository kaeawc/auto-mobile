#!/usr/bin/env bats
# Fixture for test/scripts/batsSerialTags.test.ts: `git rm`s a tracked file
# addressed as "$ROOT/<tracked path>" from setup(). Must be recognized.

ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

setup() {
  MANIFEST="${ROOT}/package.json"
  git -C "$ROOT" rm --cached "${MANIFEST}"
}

@test "scans without a manifest" {
  run bash "$ROOT/scripts/check-stdlib-first.sh"
  [ "$status" -ne 0 ]
}
