#!/usr/bin/env bats
# Offline coverage for the docs-deploy coverage badge lookup (#11467).
# Fixtures are trimmed real captures from the GitHub REST API
# (test/fixtures/ci/coverage-badge/).

SCRIPT="scripts/ci/resolve-coverage-badge-run.sh"
FIX="test/fixtures/ci/coverage-badge"

setup() {
  TEST_ROOT="$(mktemp -d)"
  PAGES="${TEST_ROOT}/pages"
  mkdir -p "$PAGES"
  export GITHUB_OUTPUT="${TEST_ROOT}/out"
  export GITHUB_REPOSITORY="kaeawc/auto-mobile"
  export FAKE_PAGES="$PAGES"
  export FAKE_RUN_FIXTURE="${PWD}/${FIX}/run-merge-success.json"
  export GH_BIN="${TEST_ROOT}/gh"
  export CURL_BIN="${TEST_ROOT}/curl"
  : > "$GITHUB_OUTPUT"

  # Fake gh: serves pages/<N>.json for the artifact listing (empty page past the
  # last fixture), the run fixture for any run lookup, and fails on demand.
  cat > "$GH_BIN" <<'FAKE'
#!/usr/bin/env bash
[[ "${FAKE_GH_FAIL:-}" != 1 ]] || exit 1
[[ "$1" == api ]] || exit 90
case "$2" in
  repos/kaeawc/auto-mobile/actions/artifacts\?name=*)
    page="${2##*page=}"
    if [[ -f "$FAKE_PAGES/$page.json" ]]; then cat "$FAKE_PAGES/$page.json"; else echo '{"total_count":0,"artifacts":[]}'; fi ;;
  repos/kaeawc/auto-mobile/actions/runs/*) cat "$FAKE_RUN_FIXTURE" ;;
  *) exit 91 ;;
esac
FAKE
  chmod +x "$GH_BIN"

  # Fake curl: copies FAKE_CURL_BODY to the -o target, or fails.
  cat > "$CURL_BIN" <<'FAKE'
#!/usr/bin/env bash
out=''
while [[ $# -gt 0 ]]; do
  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac
done
[[ -n "${FAKE_CURL_BODY:-}" ]] || exit 22
cp "$FAKE_CURL_BODY" "$out"
FAKE
  chmod +x "$CURL_BIN"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

@test "badge in the first page: picks that main run" {
  cp "${FIX}/artifacts-main-badge.json" "${PAGES}/1.json"
  run bash "$SCRIPT" resolve swift-coverage-badge
  [ "$status" -eq 0 ]
  [ "$(cat "$GITHUB_OUTPUT")" = "run-id=36655614924" ]
}

@test "badge only on a later page: pages past branch-only artifacts" {
  cp "${FIX}/artifacts-branch-only.json" "${PAGES}/1.json"
  cp "${FIX}/artifacts-branch-only.json" "${PAGES}/2.json"
  cp "${FIX}/artifacts-main-badge.json" "${PAGES}/3.json"
  run bash "$SCRIPT" resolve swift-coverage-badge
  [ "$status" -eq 0 ]
  [ "$(cat "$GITHUB_OUTPUT")" = "run-id=36655614924" ]
}

@test "expired main badge is ignored" {
  jq '.artifacts[0].expired = true' "${FIX}/artifacts-main-badge.json" > "${PAGES}/1.json"
  run bash "$SCRIPT" resolve swift-coverage-badge
  [ "$status" -eq 0 ]
  [ "$(cat "$GITHUB_OUTPUT")" = "run-id=" ]
}

@test "no badge at all: warns, exits 0, run-id empty" {
  cp "${FIX}/artifacts-branch-only.json" "${PAGES}/1.json"
  run bash "$SCRIPT" resolve swift-coverage-badge
  [ "$status" -eq 0 ]
  [[ "$output" == *"::warning::"* ]]
  [ "$(cat "$GITHUB_OUTPUT")" = "run-id=" ]
}

@test "run that did not succeed is skipped" {
  cp "${FIX}/artifacts-main-badge.json" "${PAGES}/1.json"
  jq '.conclusion = "failure"' "${FIX}/run-merge-success.json" > "${TEST_ROOT}/run.json"
  export FAKE_RUN_FIXTURE="${TEST_ROOT}/run.json"
  run bash "$SCRIPT" resolve swift-coverage-badge
  [ "$status" -eq 0 ]
  [[ "$output" == *"::warning::"* ]]
  [ "$(cat "$GITHUB_OUTPUT")" = "run-id=" ]
}

@test "gh failure is a real error" {
  export FAKE_GH_FAIL=1
  run bash "$SCRIPT" resolve swift-coverage-badge
  [ "$status" -ne 0 ]
  [[ "$output" == *"::error::"* ]]
  [ ! -s "$GITHUB_OUTPUT" ]
}

@test "keep-published copies the live badge without overwriting on failure" {
  export FAKE_CURL_BODY="${TEST_ROOT}/badge.json"
  echo '{"schemaVersion":1,"label":"Swift coverage","message":"42%","color":"green"}' > "$FAKE_CURL_BODY"
  run bash "$SCRIPT" keep-published "${TEST_ROOT}/site" swift-coverage-badge.json https://example.test/b.json
  [ "$status" -eq 0 ]
  jq -e '.message == "42%"' "${TEST_ROOT}/site/swift-coverage-badge.json"

  unset FAKE_CURL_BODY
  run bash "$SCRIPT" keep-published "${TEST_ROOT}/site" swift-coverage-badge.json https://example.test/b.json
  [ "$status" -eq 0 ]
  [[ "$output" == *"::warning::"* ]]
  jq -e '.message == "42%"' "${TEST_ROOT}/site/swift-coverage-badge.json"
}

@test "docs workflow uses the resolver for both badges and guards the downloads" {
  run grep -c "resolve-coverage-badge-run.sh resolve" .github/workflows/docs.yml
  [ "$output" = "2" ]
  run grep -c "outputs.run-id != ''" .github/workflows/docs.yml
  [ "$output" = "2" ]
}
