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

@test "an oversized javadoc jar trips the javadoc guard (#4852)" {
  local dir="$STAGE/$GROUP_PATH/auto-mobile-sdk/0.0.47"
  mkdir -p "$dir"
  head -c 100000 /dev/zero >"$dir/auto-mobile-sdk-0.0.47-javadoc.jar" # 100 KB > 51200
  local budget="$STAGE/jvd-budget.json"
  cat >"$budget" <<'JSON'
{ "perRelease": { "maxJavadocJarBytes": 51200 } }
JSON
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -eq 0 ] # advisory
  [[ "$output" == *"BUDGET WARN"* ]]
  [[ "$output" == *"javadoc-jar"* ]]
}

@test "empty javadoc jars stay within the javadoc guard (#4852)" {
  # build_release stages javadoc jars at 100 bytes, well under the guard.
  local budget="$STAGE/jvd-ok-budget.json"
  cat >"$budget" <<'JSON'
{ "perRelease": { "maxJavadocJarBytes": 51200 } }
JSON
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -eq 0 ]
  [[ "$output" == *"BUDGET OK"* ]]
}

@test "a non-integer maxJavadocJarBytes fails closed (#4852)" {
  local budget="$STAGE/jvd-bad-budget.json"
  cat >"$budget" <<'JSON'
{ "perRelease": { "maxJavadocJarBytes": 0.5 } }
JSON
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -ne 0 ]
  [[ "$output" != *"BUDGET OK"* ]]
}

@test "the committed budget policy exists and is valid JSON" {
  [ -f "$BUDGET_FILE" ]
  run jq empty "$BUDGET_FILE"
  [ "$status" -eq 0 ]
}

@test "an empty (but existing) staging directory reports zero, not a crash" {
  local empty
  empty="$(mktemp -d)"
  run bash "$SCRIPT" "$empty"
  rmdir "$empty"
  [ "$status" -eq 0 ]
  [[ "$output" == *"coordinates=0 files=0 bytes=0"* ]]
}

@test "a trailing slash on the staging path is handled" {
  run bash "$SCRIPT" "$STAGE/"
  [ "$status" -eq 0 ]
  [[ "$output" == *"files=110"* ]]
}

@test "a missing staging directory fails clearly" {
  run bash "$SCRIPT" "$STAGE/does-not-exist"
  [ "$status" -ne 0 ]
  [[ "$output" == *"staging"* ]] || [[ "$output" == *"not"* ]]
}

# --- The extracted release-CI orchestrator (maven-publication-manifest-preflight.sh) ---
# STAGING_DIR skips the Gradle staging step, so its manifest/summary wiring is
# testable against a fixture without running Gradle.

@test "preflight against a pre-staged dir emits the manifest and writes MANIFEST_OUT" {
  local preflight="$REPO_ROOT/scripts/release/maven-publication-manifest-preflight.sh"
  # MANIFEST_OUT must live OUTSIDE the staging tree (see the guard test below).
  local out
  out="$(mktemp)"
  STAGING_DIR="$STAGE" MANIFEST_OUT="$out" run bash "$preflight"
  [ "$status" -eq 0 ]
  [[ "$output" == *"files=110"* ]]
  [ -f "$out" ]
  grep -q "files=110" "$out"
  rm -f "$out"
}

@test "preflight rejects a MANIFEST_OUT inside the staging tree" {
  local preflight="$REPO_ROOT/scripts/release/maven-publication-manifest-preflight.sh"
  STAGING_DIR="$STAGE" MANIFEST_OUT="$STAGE/manifest.txt" run bash "$preflight"
  [ "$status" -ne 0 ]
  [[ "$output" == *"STAGING_DIR"* ]]
}

@test "preflight rejects a symlink MANIFEST_OUT (could redirect into staging)" {
  local preflight="$REPO_ROOT/scripts/release/maven-publication-manifest-preflight.sh"
  local link
  link="$(mktemp -d)/out.txt"
  ln -s "$STAGE/manifest.txt" "$link" # target inside staging, parent outside
  STAGING_DIR="$STAGE" MANIFEST_OUT="$link" run bash "$preflight"
  [ "$status" -ne 0 ]
  [[ "$output" == *"symlink"* ]]
  rm -rf "$(dirname "$link")"
}

@test "preflight appends a totals block to GITHUB_STEP_SUMMARY when set" {
  local preflight="$REPO_ROOT/scripts/release/maven-publication-manifest-preflight.sh"
  local summary
  summary="$(mktemp)"
  STAGING_DIR="$STAGE" GITHUB_STEP_SUMMARY="$summary" run bash "$preflight"
  [ "$status" -eq 0 ]
  [ -f "$summary" ]
  grep -q "Maven Central publication manifest" "$summary"
  grep -q "Release total" "$summary"
  # The full per-file body is NOT dumped into the summary; only totals onward.
  ! grep -q "auto-mobile-protocol-0.0.47.jar " "$summary"
  rm -f "$summary"
}

@test "preflight requires VERSION when it must stage (no STAGING_DIR)" {
  local preflight="$REPO_ROOT/scripts/release/maven-publication-manifest-preflight.sh"
  run env -u VERSION -u STAGING_DIR bash "$preflight"
  [ "$status" -ne 0 ]
  [[ "$output" == *"VERSION"* ]]
}

@test "--help prints the header only, never the executable lines" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage:"* ]]
  [[ "$output" != *"set -euo pipefail"* ]]
  [[ "$output" != *'budget_file=""'* ]]
}

@test "a symlinked staging directory is traversed, not counted as one file" {
  local link
  link="$(mktemp -d)/link"
  ln -s "$STAGE" "$link"
  run bash "$SCRIPT" "$link"
  [ "$status" -eq 0 ]
  [[ "$output" == *"files=110"* ]]
  rm -rf "$(dirname "$link")"
}

@test "a non-integer budget threshold fails closed, not a false BUDGET OK" {
  local budget="$STAGE/bad-budget.json"
  cat >"$budget" <<'JSON'
{ "perRelease": { "maxFiles": 0.5, "maxBytes": 0.5 } }
JSON
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -ne 0 ]
  [[ "$output" == *"integer"* ]]
  [[ "$output" != *"BUDGET OK"* ]]
}

@test "a boolean budget threshold fails closed (jq false-coalescing bypass)" {
  # jq's `// ""` would turn false into empty and disable the budget silently.
  local budget="$STAGE/bool-budget.json"
  cat >"$budget" <<'JSON'
{ "perRelease": { "maxFiles": false } }
JSON
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -ne 0 ]
  [[ "$output" == *"integer"* ]]
  [[ "$output" != *"BUDGET OK"* ]]
}

@test "a non-object perRelease fails closed (container-level coalescing)" {
  # `(.perRelease // {})` would turn false into {} and disable both limits.
  local budget="$STAGE/container-budget.json"
  cat >"$budget" <<'JSON'
{ "perRelease": false }
JSON
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -ne 0 ]
  [[ "$output" != *"BUDGET OK"* ]]
}

@test "an empty budget file fails closed, not silently unlimited" {
  local budget="$STAGE/empty-budget.json"
  : >"$budget"
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -ne 0 ]
  [[ "$output" != *"BUDGET OK"* ]]
}

@test "a multi-document budget file fails closed (jq stream, not one object)" {
  local budget="$STAGE/multi-budget.json"
  printf '%s\n%s\n' '{"perRelease":{"maxFiles":0}}' '{"perRelease":{"maxFiles":100}}' >"$budget"
  run bash "$SCRIPT" "$STAGE" --budget "$budget"
  [ "$status" -ne 0 ]
  [[ "$output" != *"BUDGET OK"* ]]
}

# Sum the per-coordinate `bytes=` subtotals; a field-shift bug would make this
# disagree with the release grand total (which is a bash scalar, computed
# independently of the awk aggregation).
per_coordinate_byte_sum() {
  printf '%s\n' "$1" | awk '
    /^dev[.].*files=.*bytes=/ { for (i = 1; i <= NF; i++) if ($i ~ /^bytes=/) { sub(/bytes=/, "", $i); s += $i } }
    END { print s + 0 }'
}

@test "an unexpected filename with a space keeps correct byte subtotals" {
  local dir="$STAGE/$GROUP_PATH/auto-mobile-protocol/0.0.47"
  head -c 7 /dev/zero >"$dir/stray file.jar" # space in the name
  run bash "$SCRIPT" "$STAGE"
  [ "$status" -eq 0 ]
  local oracle
  oracle="$(find "$STAGE" -type f -exec cat {} + | wc -c | tr -d ' ')"
  [[ "$output" == *"coordinates=2 files=111 bytes=$oracle"* ]]
  [ "$(per_coordinate_byte_sum "$output")" -eq "$oracle" ]
  [[ "$output" == *"stray file.jar"* ]]
}

@test "an unexpected filename with a tab keeps correct byte subtotals" {
  local dir="$STAGE/$GROUP_PATH/auto-mobile-protocol/0.0.47"
  head -c 7 /dev/zero >"$dir/$(printf 'tabbed\tfile').jar" # literal tab in the name
  run bash "$SCRIPT" "$STAGE"
  [ "$status" -eq 0 ]
  local oracle
  oracle="$(find "$STAGE" -type f -exec cat {} + | wc -c | tr -d ' ')"
  # bytes=$NF keeps the byte count correct despite the extra tab field.
  [ "$(per_coordinate_byte_sum "$output")" -eq "$oracle" ]
}

@test "a staging path with multiple trailing slashes is handled" {
  run bash "$SCRIPT" "$STAGE//" --strict
  [ "$status" -eq 0 ]
  [[ "$output" == *"files=110"* ]]
}
