#!/usr/bin/env bats
# bats file_tags=serial
# Writes a fixture into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.

SCRIPT="scripts/check-archive-extraction-boundary.ts"
FIXTURE="src/utils/ArchiveExtractionBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows ArchiveExtractor to own tar extraction" {
  run bun "$SCRIPT"

  [ "$status" -eq 0 ]
  [ "$output" = "archive-extraction-boundary: no direct production tar extraction." ]
}

@test "rejects tar extraction outside the owner with the per-file message" {
  printf '%s\n' 'import { spawn } from "node:child_process"; spawn("tar", ["-xzf", "a.tgz"]);' > "$FIXTURE"

  run bun "$SCRIPT"

  [ "$status" -eq 1 ]
  [ "${lines[0]}" = "error: tar extraction must use src/utils/ArchiveExtractor.ts:" ]
  [ "${lines[1]}" = "$FIXTURE directly runs tar extraction; route it through src/utils/ArchiveExtractor.ts instead." ]
}

@test "refuses a scan that saw too few source files (#13219)" {
  local root="$BATS_TEST_TMPDIR/tree"
  mkdir -p "$root/src"
  printf '%s\n' 'export const a = 1;' > "$root/src/a.ts"
  printf '%s\n' 'export const b = 2;' > "$root/src/b.ts"

  run bash -c 'cd "$1" && bun "$2"' _ "$root" "$PWD/$SCRIPT"

  [ "$status" -eq 1 ]
  [ "$output" = "error: archive-extraction-boundary scanned only 2 files under src; expected the full source tree." ]
}
