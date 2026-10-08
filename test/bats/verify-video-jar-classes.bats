#!/usr/bin/env bats

SCRIPT="scripts/ci/verify-video-jar-classes.sh"

# Build a fake DEX jar whose classes.dex holds the given type descriptors.
make_jar() {
  local jar="$1"
  shift
  local dir="$BATS_TEST_TMPDIR/jar-src"
  rm -rf "$dir"
  mkdir -p "$dir"
  : >"$dir/classes.dex"
  local cls
  for cls in "$@"; do
    printf 'xx\0Ldev/jasonpearson/automobile/video/%s;\0yy' "$cls" >>"$dir/classes.dex"
  done
  (cd "$dir" && zip -q "$jar" classes.dex)
}

@test "passes when both required classes are present" {
  make_jar "$BATS_TEST_TMPDIR/ok.jar" VideoServer VideoStatsAccumulator
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/ok.jar"
  [ "$status" -eq 0 ]
  [[ "$output" == *"VideoStatsAccumulator present"* ]]
}

@test "fails naming VideoStatsAccumulator when it is missing" {
  make_jar "$BATS_TEST_TMPDIR/stale.jar" VideoServer
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/stale.jar"
  [ "$status" -eq 1 ]
  [[ "$output" == *"VideoStatsAccumulator missing"* ]]
}

@test "fails when the main entry class is missing" {
  make_jar "$BATS_TEST_TMPDIR/nomain.jar" VideoStatsAccumulator
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/nomain.jar"
  [ "$status" -eq 1 ]
  [[ "$output" == *"VideoServer missing"* ]]
}

@test "fails when the jar has no classes.dex" {
  mkdir -p "$BATS_TEST_TMPDIR/empty-src"
  echo hi >"$BATS_TEST_TMPDIR/empty-src/readme.txt"
  (cd "$BATS_TEST_TMPDIR/empty-src" && zip -q "$BATS_TEST_TMPDIR/nodex.jar" readme.txt)
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/nodex.jar"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no classes.dex"* ]]
}

@test "fails when the jar is missing or not a zip" {
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/absent.jar"
  [ "$status" -eq 1 ]
  echo notzip >"$BATS_TEST_TMPDIR/bad.jar"
  run bash "$SCRIPT" "$BATS_TEST_TMPDIR/bad.jar"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not a readable zip"* ]]
}
