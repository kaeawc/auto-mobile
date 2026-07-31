#!/usr/bin/env bats
#
# Tests for scripts/release/maven-publication-manifest.sh (issue #4853).
#
# The preflight enumerates every file a tagged release would upload to Maven
# Central from a locally-staged Maven file repository -- no credentials, no
# remote publish. These tests exercise the generator against a hand-built
# staging tree that mirrors what a signed Gradle publication produces, so they
# stay deterministic and fast without running Gradle.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/release/maven-publication-manifest.sh"
  BUDGET_FILE="$REPO_ROOT/scripts/release/maven-usage-budget.json"
  GROUP_PATH="dev/jasonpearson/auto-mobile"
  STAGE="$(mktemp -d)"
  build_release "$STAGE"
}

teardown() {
  rm -rf "$STAGE"
}

# _sidecars <file> -- the four checksum files Gradle writes next to every artifact.
_sidecars() {
  local f="$1"
  head -c 32 /dev/zero >"$f.md5"
  head -c 40 /dev/zero >"$f.sha1"
  head -c 64 /dev/zero >"$f.sha256"
  head -c 128 /dev/zero >"$f.sha512"
}

# stage_primary <artifact> <version> <filename> <bytes>
# A signed publication file: the file itself, its four checksums, a .asc
# signature, and the signature's own four checksums (the redundant set #4851
# targets).
stage_primary() {
  local art="$1" ver="$2" name="$3" bytes="$4"
  local dir="$STAGE/$GROUP_PATH/$art/$ver"
  mkdir -p "$dir"
  head -c "$bytes" /dev/zero >"$dir/$name"
  _sidecars "$dir/$name"
  head -c 200 /dev/zero >"$dir/$name.asc"
  _sidecars "$dir/$name.asc"
}

# stage_metadata <artifact> -- maven-metadata.xml plus its four checksums
# (unsigned, one level above the version directory).
stage_metadata() {
  local art="$1"
  local dir="$STAGE/$GROUP_PATH/$art"
  mkdir -p "$dir"
  head -c 358 /dev/zero >"$dir/maven-metadata.xml"
  _sidecars "$dir/maven-metadata.xml"
}

build_release() {
  local art
  for art in auto-mobile-protocol auto-mobile-sdk; do
    stage_primary "$art" 0.0.47 "$art-0.0.47.jar" 1000
    stage_primary "$art" 0.0.47 "$art-0.0.47-sources.jar" 100
    stage_primary "$art" 0.0.47 "$art-0.0.47-javadoc.jar" 100
    stage_primary "$art" 0.0.47 "$art-0.0.47.pom" 500
    stage_primary "$art" 0.0.47 "$art-0.0.47.module" 300
    stage_metadata "$art"
  done
}

@test "manifest lists every staged coordinate" {
  run bash "$SCRIPT" "$STAGE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"dev.jasonpearson.auto-mobile:auto-mobile-protocol"* ]]
  [[ "$output" == *"dev.jasonpearson.auto-mobile:auto-mobile-sdk"* ]]
}

@test "manifest reports a per-coordinate file count and byte subtotal" {
  run bash "$SCRIPT" "$STAGE"
  [ "$status" -eq 0 ]
  # 5 signed primaries * (1 + 4 checksums + 1 sig + 4 sig checksums) = 50, plus
  # maven-metadata + its 4 checksums = 5 => 55 files per coordinate.
  [[ "$output" == *"auto-mobile-protocol"*"files=55"* ]]
  [[ "$output" == *"auto-mobile-sdk"*"files=55"* ]]
}

@test "manifest reports a release grand total, not only an aggregate" {
  run bash "$SCRIPT" "$STAGE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"coordinates=2"* ]]
  [[ "$output" == *"files=110"* ]]
  # Independent byte oracle: concatenating every file yields the total bytes.
  local expected
  expected="$(find "$STAGE" -type f -exec cat {} + | wc -c | tr -d ' ')"
  [[ "$output" == *"bytes=$expected"* ]]
}

@test "manifest classifies signature checksums distinctly (the #4851 lever)" {
  run bash "$SCRIPT" "$STAGE"
  [ "$status" -eq 0 ]
  # 5 signatures * 4 checksums * 2 coordinates = 40 signature-checksum files.
  [[ "$output" == *"signature-checksum=40"* ]]
}

@test "manifest classifies the javadoc jar distinctly (the #4852 lever)" {
  run bash "$SCRIPT" "$STAGE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"javadoc-jar=2"* ]]
}

@test "an Android library .aar primary is a known artifact, not unexpected" {
  # auto-mobile-sdk publishes an .aar (not a .jar) as its main artifact; the
  # classifier must recognize it or every release would report false positives.
  stage_primary auto-mobile-sdk 0.0.47 "auto-mobile-sdk-0.0.47.aar" 900
  run bash "$SCRIPT" "$STAGE" --strict
  [ "$status" -eq 0 ]
  [[ "$output" == *"main-aar auto-mobile-sdk-0.0.47.aar"* ]]
  [[ "$output" == *"main-aar=1"* ]]
}

@test "manifest generation is deterministic" {
  run bash "$SCRIPT" "$STAGE"
  local first="$output"
  run bash "$SCRIPT" "$STAGE"
  [ "$first" = "$output" ]
}

@test "an unexpected classifier is reported and fails under --strict" {
  local dir="$STAGE/$GROUP_PATH/auto-mobile-protocol/0.0.47"
  head -c 10 /dev/zero >"$dir/auto-mobile-protocol-0.0.47-tests.jar"
  run bash "$SCRIPT" "$STAGE"
  [ "$status" -eq 0 ] # report-only by default: never blocks a release
  [[ "$output" == *"unexpected"* ]]
  [[ "$output" == *"tests.jar"* ]]
  run bash "$SCRIPT" "$STAGE" --strict
  [ "$status" -ne 0 ]
}

@test "a stray signature-of-signature sidecar is flagged as unexpected" {
  local dir="$STAGE/$GROUP_PATH/auto-mobile-protocol/0.0.47"
  head -c 10 /dev/zero >"$dir/auto-mobile-protocol-0.0.47.jar.asc.asc"
  run bash "$SCRIPT" "$STAGE" --strict
  [ "$status" -ne 0 ]
  [[ "$output" == *"unexpected"* ]]
}

@test "budget breach warns but exits 0 by default; --strict makes it fail" {
  local budget="$STAGE/tiny-budget.json"
  cat >"$budget" <<'JSON'
{ "perRelease": { "maxFiles": 1, "maxBytes": 1 } }
JSON
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -eq 0 ]
  [[ "$output" == *"BUDGET"* ]]
  [[ "$output" == *"WARN"* ]]
  run bash "$SCRIPT" "$STAGE" --budget "$budget" --strict
  [ "$status" -ne 0 ]
}

@test "a generous budget reports OK and exits 0" {
  local budget="$STAGE/big-budget.json"
  cat >"$budget" <<'JSON'
{ "perRelease": { "maxFiles": 100000, "maxBytes": 1000000000 } }
JSON
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -eq 0 ]
  [[ "$output" == *"BUDGET OK"* ]]
}

@test "the committed budget policy exists and is valid JSON" {
  [ -f "$BUDGET_FILE" ]
  run node -e "JSON.parse(require('fs').readFileSync('$BUDGET_FILE','utf8'))"
  [ "$status" -eq 0 ]
}

@test "a missing staging directory fails clearly" {
  run bash "$SCRIPT" "$STAGE/does-not-exist"
  [ "$status" -ne 0 ]
  [[ "$output" == *"staging"* ]] || [[ "$output" == *"not"* ]]
}
