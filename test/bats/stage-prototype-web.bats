#!/usr/bin/env bats
#
# Guards scripts/release/stage-prototype-web.sh (#16455): release.yml publishes
# @kaeawc/auto-mobile-prototype-web from its stage, so the stage must carry the
# release version and exactly the built entries and declarations, and building
# it must leave the checkout untouched.

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/release/stage-prototype-web.sh"
  STAGE="$BATS_TEST_TMPDIR/stage"
  export npm_config_cache="$BATS_TEST_TMPDIR/npm-cache"
}

# Writes a build stub that creates the given files under the dist directory it
# is handed.
stub_build() {
  local stub="$BATS_TEST_TMPDIR/build"
  {
    echo '#!/usr/bin/env bash'
    echo 'mkdir -p "$1"'
    for file in "$@"; do
      printf 'echo "export {};" > "$1/%s"\n' "$file"
    done
  } > "$stub"
  chmod +x "$stub"
  export PROTOTYPE_WEB_BUILD="$stub"
}

@test "stages the release version with exactly the built entries and declarations" {
  stub_build index.js element.js
  run --separate-stderr "$SCRIPT" 1.2.3 "$STAGE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Staged @kaeawc/auto-mobile-prototype-web 1.2.3"* ]]
  [ "$(node -p 'require(process.argv[1]).version' "$STAGE/package.json")" = "1.2.3" ]
}

@test "refuses a stage whose tarball would ship an extra file" {
  stub_build index.js element.js index.js.map
  run --separate-stderr "$SCRIPT" 1.2.3 "$STAGE"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"would not hold exactly"* ]]
  [[ "$stderr" == *"> dist/index.js.map"* ]]
}

@test "refuses a stage missing a built entry" {
  stub_build index.js
  run --separate-stderr "$SCRIPT" 1.2.3 "$STAGE"
  [ "$status" -ne 0 ]
  [[ "$stderr" == *"< dist/element.js"* ]]
}

@test "refuses a version that is not a release version" {
  stub_build index.js element.js
  run --separate-stderr "$SCRIPT" "1.2" "$STAGE"
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"not a release version"* ]]
  [ ! -e "$STAGE" ]
}

@test "refuses an existing stage directory rather than packing into it" {
  stub_build index.js element.js
  mkdir -p "$STAGE"
  run --separate-stderr "$SCRIPT" 1.2.3 "$STAGE"
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"already exists"* ]]
}
