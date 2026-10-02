#!/usr/bin/env bats

# Bun's built-in YAML parser avoids an extra dependency for this workflow guard.
# Override NIGHTLY_WORKFLOW to check a saved workflow revision.
@test "foldable posture job isolates its database under scratch/foldable-lane" {
  # shellcheck disable=SC2016 # GitHub expressions must stay literal in the parser input.
  run bun -e '
    import { strict as assert } from "node:assert";
    import { posix } from "node:path";

    const path = process.env.NIGHTLY_WORKFLOW ?? ".github/workflows/nightly.yml";
    const workflow = Bun.YAML.parse(await Bun.file(path).text());
    const dbDir = workflow.jobs?.["foldable-posture-tests"]?.env?.AUTOMOBILE_DB_DIR;

    assert.equal(typeof dbDir, "string", "foldable-posture-tests job env must define AUTOMOBILE_DB_DIR");
    assert.ok(dbDir.trim().length > 0, "AUTOMOBILE_DB_DIR must be non-empty");
    const laneRoot = "${{ github.workspace }}/scratch/foldable-lane/";
    assert.ok(
      posix.normalize(dbDir).startsWith(laneRoot),
      "AUTOMOBILE_DB_DIR must be under the workspace scratch/foldable-lane directory",
    );
  '
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}
