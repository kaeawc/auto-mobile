#!/usr/bin/env bats
#
# Guards the ProtoViewer Google Play pipeline (#14147):
# - scripts/release/protoviewer-play.sh builds the fastlane `supply` argument lists, and a promotion
#   never uploads a binary;
# - publish-protoviewer-play.yml builds the AAB exactly once and only promotes afterwards;
# - PLAY_SERVICE_ACCOUNT_JSON is read only in jobs of the protected Play environments.

SCRIPT="scripts/release/protoviewer-play.sh"
WORKFLOW=".github/workflows/publish-protoviewer-play.yml"
BUILD_WORKFLOW=".github/workflows/build-protoviewer-apk.yml"

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  cd "$REPO_ROOT"
  export SUPPLY_CALLS="$BATS_TEST_TMPDIR/supply.calls"
  export FASTLANE_BIN="$BATS_TEST_TMPDIR/fastlane"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$SUPPLY_CALLS"\n' >"$FASTLANE_BIN"
  chmod +x "$FASTLANE_BIN"
  export SUPPLY_JSON_KEY_DATA='{"type":"service_account"}'
  export PROTOVIEWER_METADATA_DIR="$BATS_TEST_TMPDIR/metadata"
  mkdir -p "$PROTOVIEWER_METADATA_DIR/en-US/changelogs" "$PROTOVIEWER_METADATA_DIR/de-DE/changelogs"
  echo "Release notes" >"$PROTOVIEWER_METADATA_DIR/en-US/changelogs/1002003.txt"
  echo "Versionshinweise" >"$PROTOVIEWER_METADATA_DIR/de-DE/changelogs/1002003.txt"
  AAB="$BATS_TEST_TMPDIR/app.aab"
  : >"$AAB"
  unset PLAY_CLOSED_TRACK
}

# Workflow YAML as JSON, with either yq flavour (mikefarah on runners, python-yq locally).
workflow_json() {
  command -v yq >/dev/null 2>&1 || {
    [[ -z "${CI:-}" ]] || { echo "yq is required in CI" >&2; return 1; }
    skip "yq not installed"
  }
  yq -o=json '.' "$1" 2>/dev/null || yq '.' "$1"
}

# --- script: versions ----------------------------------------------------------------------------

@test "version-code matches ProtoViewerVersioning (major*1e6 + minor*1e3 + patch)" {
  [ "$(bash "$SCRIPT" version-code 0.0.89)" = "89" ]
  [ "$(bash "$SCRIPT" version-code 1.2.3)" = "1002003" ]
  [ "$(bash "$SCRIPT" version-code 2099.999.999)" = "2099999999" ]
}

@test "version-code rejects suffixes, leading zeros and out-of-range fields" {
  local bad
  for bad in 1.0.0-rc.1 1.0.0-SNAPSHOT 01.0.0 1.0 v1.0.0 2100.0.0 1.1000.0 1.0.1000 ""; do
    run bash "$SCRIPT" version-code "$bad"
    [ "$status" -eq 2 ]
  done
}

@test "tag-version accepts only protoviewer/MAJOR.MINOR.PATCH" {
  [ "$(bash "$SCRIPT" tag-version protoviewer/1.2.3)" = "1.2.3" ]
  run bash "$SCRIPT" tag-version 1.2.3
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" tag-version protoviewer/v1.2.3
  [ "$status" -eq 2 ]
}

# --- script: release notes -----------------------------------------------------------------------

@test "check-changelog needs a non-blank <versionCode>.txt in every locale" {
  run bash "$SCRIPT" check-changelog 1002003
  [ "$status" -eq 0 ]
  printf '  \n' >"$PROTOVIEWER_METADATA_DIR/de-DE/changelogs/1002003.txt"
  run bash "$SCRIPT" check-changelog 1002003
  [ "$status" -eq 1 ]
  [[ "$output" == *"de-DE/changelogs/1002003.txt"* ]]
}

@test "check-changelog does not accept default.txt in place of the versioned notes" {
  echo "Generic" >"$PROTOVIEWER_METADATA_DIR/en-US/changelogs/default.txt"
  run bash "$SCRIPT" check-changelog 1002004
  [ "$status" -eq 1 ]
}

# --- script: supply argument lists ---------------------------------------------------------------

@test "upload-internal uploads the AAB to internal with its changelog and nothing else" {
  run bash "$SCRIPT" upload-internal --aab "$AAB" --version-code 1002003
  [ "$status" -eq 0 ]
  local call
  call="$(cat "$SUPPLY_CALLS")"
  [[ "$call" == "supply --package_name dev.jasonpearson.automobile.protoviewer --track internal --aab $AAB --version_code 1002003 --release_status completed "* ]]
  [[ "$call" == *"--skip_upload_apk true"* ]]
  [[ "$call" == *"--skip_upload_metadata true"* ]]
  [[ "$call" != *"skip_upload_changelogs"* ]]
}

@test "upload-internal refuses without versioned release notes or with a bad status" {
  run bash "$SCRIPT" upload-internal --aab "$AAB" --version-code 1002004
  [ "$status" -eq 1 ]
  run bash "$SCRIPT" upload-internal --aab "$AAB" --version-code 1002003 --release-status inProgress
  [ "$status" -eq 2 ]
  [ ! -e "$SUPPLY_CALLS" ]
}

@test "promotions move the versionCode between tracks and never upload a binary" {
  run bash "$SCRIPT" operate promote-closed --version-code 1002003
  [ "$status" -eq 0 ]
  run bash "$SCRIPT" operate promote-production --version-code 1002003 --fraction 0.1
  [ "$status" -eq 0 ]
  local closed production
  closed="$(sed -n 1p "$SUPPLY_CALLS")"
  production="$(sed -n 2p "$SUPPLY_CALLS")"
  [[ "$closed" == *"--track internal --track_promote_to alpha --track_promote_release_status completed --version_code 1002003 "* ]]
  [[ "$closed" != *"--rollout"* ]]
  [[ "$production" == *"--track alpha --track_promote_to production "*"--rollout 0.1 "* ]]
  local call
  while IFS= read -r call; do
    [[ "$call" != *"--aab"* && "$call" != *"--apk"* ]]
    [[ "$call" == *"--skip_upload_aab true"* && "$call" == *"--skip_upload_apk true"* ]]
    [[ "$call" == *"--skip_upload_changelogs true"* ]]
  done <"$SUPPLY_CALLS"
}

@test "PLAY_CLOSED_TRACK selects the closed track and cannot name internal or production" {
  PLAY_CLOSED_TRACK=beta run bash "$SCRIPT" operate promote-closed --version-code 1002003
  [ "$status" -eq 0 ]
  [[ "$(cat "$SUPPLY_CALLS")" == *"--track_promote_to beta "* ]]
  PLAY_CLOSED_TRACK=production run bash "$SCRIPT" operate promote-closed --version-code 1002003
  [ "$status" -eq 2 ]
}

@test "rollout and halt update the production release of that versionCode" {
  run bash "$SCRIPT" operate rollout --version-code 1002003 --fraction 0.5
  [ "$status" -eq 0 ]
  run bash "$SCRIPT" operate halt --version-code 1002003 --fraction 0.5
  [ "$status" -eq 0 ]
  [[ "$(sed -n 1p "$SUPPLY_CALLS")" == *"--track production --version_code 1002003 --rollout 0.5 --skip_upload_apk true"* ]]
  [[ "$(sed -n 2p "$SUPPLY_CALLS")" == *"--track production --version_code 1002003 --rollout 0.5 --release_status halted "* ]]
}

@test "fractions outside (0, 1] are rejected before fastlane runs" {
  local bad
  for bad in 0 0.0 1.5 -0.1 10% abc ""; do
    run bash "$SCRIPT" operate rollout --version-code 1002003 --fraction "$bad"
    [ "$status" -eq 2 ]
  done
  run bash "$SCRIPT" operate promote-production --version-code 1002003
  [ "$status" -eq 2 ]
  [ ! -e "$SUPPLY_CALLS" ]
}

@test "Play operations refuse to run without the service-account key" {
  unset SUPPLY_JSON_KEY_DATA
  run bash "$SCRIPT" operate promote-closed --version-code 1002003
  [ "$status" -eq 2 ]
  [[ "$output" == *"SUPPLY_JSON_KEY_DATA is not set"* ]]
  [ ! -e "$SUPPLY_CALLS" ]
}

# --- workflow: no rebuild between tracks ---------------------------------------------------------

@test "the workflow builds the AAB in exactly one job, through the reusable build" {
  local json
  json="$(workflow_json "$WORKFLOW")"
  [ "$(jq -r '[.jobs[] | select(.uses == "./.github/workflows/build-protoviewer-apk.yml")] | length' <<<"$json")" = "1" ]
  [ "$(jq -r '.jobs.build.with["build-aab"]' <<<"$json")" = "true" ]
  # No other job compiles: no gradle action, no gradlew, no bundle task.
  run jq -r '[.jobs | to_entries[] | select(.key != "build") | .value.steps[]?
    | select(((.uses // "") | test("gradle")) or ((.run // "") | test("gradlew|bundleRelease|assembleRelease")))] | length' <<<"$json"
  [ "$output" = "0" ]
}

@test "only the internal upload consumes the AAB; promotion jobs only call operate" {
  local json
  json="$(workflow_json "$WORKFLOW")"
  [ "$(jq -r '[.jobs | to_entries[] | select(any(.value.steps[]?; (.uses // "") | startswith("actions/download-artifact"))) | .key] | join(",")' <<<"$json")" = "upload-internal" ]
  [ "$(jq -r '[.jobs | to_entries[] | select(any(.value.steps[]?; (.run // "") | test("upload-internal"))) | .key] | join(",")' <<<"$json")" = "upload-internal" ]
  local job
  for job in promote-closed promote-production operate; do
    [ "$(jq -r --arg j "$job" '[.jobs[$j].steps[] | select((.run // "") | test("protoviewer-play.sh"))] | length' <<<"$json")" = "1" ]
    jq -e --arg j "$job" '.jobs[$j].steps[] | select((.run // "") | test("protoviewer-play.sh")) | .run | test("operate")' <<<"$json" >/dev/null
  done
}

@test "the build workflow uploads the AAB it hashed, only when asked" {
  local json
  json="$(workflow_json "$BUILD_WORKFLOW")"
  [ "$(jq -r '.on.workflow_call.inputs["build-aab"].default' <<<"$json")" = "false" ]
  jq -e '.jobs.build.steps[] | select(.name == "Upload ProtoViewer AAB") | .if | test("inputs.build-aab")' <<<"$json" >/dev/null
  [ "$(jq -r '.jobs.build.steps[] | select(.name == "Upload ProtoViewer AAB") | .with.path' <<<"$json")" = "/tmp/automobile-protoviewer.aab" ]
  jq -e '.jobs.build.steps[] | select(.id == "aab_checksum") | .run | test("cp \"\\$AAB_PATH\" /tmp/automobile-protoviewer.aab")' <<<"$json" >/dev/null
}

# --- workflow: secret scoping --------------------------------------------------------------------

@test "PLAY_SERVICE_ACCOUNT_JSON is referenced only by the Play publishing workflow" {
  run grep -rlF 'PLAY_SERVICE_ACCOUNT_JSON' .github
  [ "$status" -eq 0 ]
  [ "$output" = "$WORKFLOW" ]
}

@test "the service-account secret is read only in step env of jobs in the protected environments" {
  local json
  json="$(workflow_json "$WORKFLOW")"
  # Not at workflow level, job level, or in any with:/run: body.
  [ "$(jq -r '.env // {} | tostring | test("PLAY_SERVICE_ACCOUNT_JSON")' <<<"$json")" = "false" ]
  [ "$(jq -r '[.jobs[] | (.env // {}), (.with // {}), (.secrets // {}), ((.steps // [])[] | (.with // {}), (.run // ""))]
    | tostring | test("PLAY_SERVICE_ACCOUNT_JSON")' <<<"$json")" = "false" ]
  # Every job that reads it is in a Play environment, and each Play job reads it in exactly one step.
  local users
  users="$(jq -r '.jobs | to_entries[] | select(any(.value.steps[]?; (.env // {}) | tostring | test("secrets.PLAY_SERVICE_ACCOUNT_JSON"))) | "\(.key)=\(.value.environment)"' <<<"$json" | sort | tr '\n' ' ')"
  [ "$users" = "operate=google-play-release promote-closed=google-play-release promote-production=google-play-release upload-internal=google-play-internal " ]
}

@test "the workflow does not pass secrets wholesale or widen permissions" {
  local json
  json="$(workflow_json "$WORKFLOW")"
  run grep -nE 'secrets: *inherit' "$WORKFLOW"
  [ "$status" -eq 1 ]
  [ "$(jq -c '.permissions' <<<"$json")" = '{"contents":"read"}' ]
  [ "$(jq -r '[.jobs[] | select(.permissions != null)] | length' <<<"$json")" = "0" ]
}

@test "the internal upload runs only on tag pushes; promotions wait on the previous track" {
  local json
  json="$(workflow_json "$WORKFLOW")"
  [ "$(jq -r '.on.push.tags | join(",")' <<<"$json")" = "protoviewer/*" ]
  [ "$(jq -r '.jobs["upload-internal"].if' <<<"$json")" = "github.event_name == 'push'" ]
  [ "$(jq -r '.jobs["promote-closed"].needs | join(",")' <<<"$json")" = "resolve,upload-internal" ]
  [ "$(jq -r '.jobs["promote-production"].needs | join(",")' <<<"$json")" = "resolve,promote-closed" ]
  [ "$(jq -r '.jobs.operate.if' <<<"$json")" = "github.event_name == 'workflow_dispatch'" ]
}
