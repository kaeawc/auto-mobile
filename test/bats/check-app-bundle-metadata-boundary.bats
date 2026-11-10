#!/usr/bin/env bats
# bats file_tags=serial
# Writes fixtures into the real source tree and scans it, so this file cannot
# run concurrently with the rest of the suite. scripts/ci/run-bats.sh runs all
# serial-tagged files in a dedicated serial pass (scripts/ci/run-bats.sh);
# the tag is enforced by test/scripts/batsSerialTags.test.ts.
#
# A full-tree scan parses every file under src/ (~3s on CI), and this file runs
# in the serial pass, so it scans twice instead of once per case (#17778):
# setup_file scans the clean tree, then writes one uniquely named fixture per
# case and scans again. The scanner reports every violating file, so each test
# asserts only that its own fixtures were flagged.

SCRIPT="scripts/check-app-bundle-metadata-boundary.ts"
FIXTURE_DIR="src/utils"
FIXTURE_PREFIX="CodesignBoundaryFixture"
FIXTURE_SLUGS=(
  Direct Variable Template AbsolutePath Xcrun BunSpawn Concatenated
)

write_fixture() {
  local fixture="src/utils/${FIXTURE_PREFIX}$1.ts"
  printf '%s\n' "$2" > "$fixture"
}

remove_fixtures() {
  local slug fixture
  for slug in "${FIXTURE_SLUGS[@]}"; do
    fixture="src/utils/${FIXTURE_PREFIX}${slug}.ts"
    rm -f "$fixture"
  done
}

scan_into() {
  local name="$1" scan_status=0
  bun "$SCRIPT" > "$BATS_FILE_TMPDIR/$name.out" 2>&1 || scan_status=$?
  printf '%s\n' "$scan_status" > "$BATS_FILE_TMPDIR/$name.status"
}

setup_file() {
  remove_fixtures
  scan_into clean

  write_fixture Direct 'hostExec("codesign", ["-d", appPath]);'
  write_fixture Variable 'const tool = "codesign"; hostExec(tool, ["-d", appPath]);'
  write_fixture Template 'hostExec(`codesign`, ["-d", appPath]);'
  write_fixture AbsolutePath 'execFile("/usr/bin/codesign", ["-d", appPath]);'
  write_fixture Xcrun 'execFile("xcrun", ["codesign", "-d", appPath]);'
  write_fixture BunSpawn 'Bun.spawn(["codesign", "-d", appPath]);'
  write_fixture Concatenated 'const tool = "code" + "sign"; hostExec(tool, ["-d", appPath]);'

  scan_into fixtures
  remove_fixtures
}

teardown_file() {
  remove_fixtures
}

assert_flagged() {
  [ "$(cat "$BATS_FILE_TMPDIR/fixtures.status")" -eq 1 ]
  local slug
  for slug in "$@"; do
    grep -qF "${FIXTURE_PREFIX}${slug}.ts" "$BATS_FILE_TMPDIR/fixtures.out"
  done
}

@test "allows AppBundleMetadataClient to own codesign execution" {
  [ "$(cat "$BATS_FILE_TMPDIR/clean.status")" -eq 0 ]
  grep -qF "no direct production codesign invocations" "$BATS_FILE_TMPDIR/clean.out"
}

@test "the fixture scan reports only the fixtures" {
  run cat "$BATS_FILE_TMPDIR/fixtures.out"
  [ "${lines[0]}" = "error: codesign execution must use AppBundleMetadataClient:" ]
  [ "${#lines[@]}" -eq $((${#FIXTURE_SLUGS[@]} + 1)) ]
  local location
  for location in "${lines[@]:1}"; do
    [[ "$location" == "${FIXTURE_DIR}/${FIXTURE_PREFIX}"* ]]
  done
}

@test "rejects direct codesign execution outside the owner" {
  assert_flagged Direct
}

@test "rejects a codesign path stored in a variable" {
  assert_flagged Variable
}

@test "rejects no-substitution template and absolute-path codesign invocations" {
  assert_flagged Template AbsolutePath
}

@test "rejects xcrun, Bun.spawn, and concatenated aliases" {
  assert_flagged Xcrun BunSpawn Concatenated
}
