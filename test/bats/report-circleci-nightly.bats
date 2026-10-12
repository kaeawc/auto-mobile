#!/usr/bin/env bats
#
# CircleCI nightly visibility (#11615): one tracking issue, commented on while open. gh and curl
# are fakes: gh logs its argv and answers `issue list` from a file; curl serves JSON fixtures
# chosen by URL and reports an HTTP status (200 unless STATUS_FILE says otherwise).

SCRIPT="scripts/ci/report-circleci-nightly.sh"

setup() {
  CALLS="${BATS_TEST_TMPDIR}/calls.log"
  OPEN_FILE="${BATS_TEST_TMPDIR}/open-number"
  FIX="${BATS_TEST_TMPDIR}/fix"
  STATUS_FILE="${BATS_TEST_TMPDIR}/status"
  mkdir -p "${FIX}"
  cat > "${BATS_TEST_TMPDIR}/gh" <<'FAKE_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CALLS}"
if [[ "$1 $2" == "issue list" ]]; then
  cat "${OPEN_FILE}" 2> /dev/null || true
fi
FAKE_EOF
  cat > "${BATS_TEST_TMPDIR}/curl" <<'FAKE_EOF'
#!/usr/bin/env bash
out=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w | -H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "${url}" in
  */artifacts) fixture="${FIX}/artifacts-$(basename "$(dirname "${url}")").json" ;;
  */pipeline\?*) fixture="${FIX}/pipelines.json" ;;
  */workflow) fixture="${FIX}/workflows-$(basename "$(dirname "${url}")").json" ;;
  */job) fixture="${FIX}/jobs-$(basename "$(dirname "${url}")").json" ;;
esac
cat "${fixture}" > "${out}"
cat "${STATUS_FILE}" 2> /dev/null || printf 200
FAKE_EOF
  chmod +x "${BATS_TEST_TMPDIR}/gh" "${BATS_TEST_TMPDIR}/curl"
  export CALLS OPEN_FILE FIX STATUS_FILE
  export ALERT_GH="${BATS_TEST_TMPDIR}/gh" ALERT_CURL="${BATS_TEST_TMPDIR}/curl"
  export CIRCLECI_TOKEN="test-token"
  export ALERT_NOW_EPOCH=1791715200 # 2026-10-11T10:40:00Z

  # One in-window nightly pipeline (p1), one stale pipeline outside the 36h window.
  cat > "${FIX}/pipelines.json" <<'JSON'
{"items":[
  {"id":"p1","number":501,"created_at":"2026-10-11T00:00:07.412Z"},
  {"id":"p0","number":400,"created_at":"2026-10-08T00:00:05.000Z"}
],"next_page_token":null}
JSON
  cat > "${FIX}/workflows-p1.json" <<'JSON'
{"items":[{"id":"w1","name":"nightly-macos"},{"id":"w9","name":"other"}]}
JSON
  cat > "${FIX}/jobs-w1.json" <<'JSON'
{"items":[
  {"name":"macOS BATS Shell Tests","status":"failed","job_number":9001},
  {"name":"XCTestRunner Thread Sanitizer","status":"success","job_number":9002}
]}
JSON
  cat > "${FIX}/artifacts-9001.json" <<'JSON'
{"items":[{"path":"bats-unit-joblog/bats-unit-joblog-durations.tsv"},{"path":"bats-unit-joblog/bats-unit-joblog.tsv"}]}
JSON
}

@test "no token skips quietly" {
  unset CIRCLECI_TOKEN
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"not configured"* ]]
  [ ! -e "${CALLS}" ]
}

@test "a refused token skips with a notice and files nothing" {
  printf 404 > "${STATUS_FILE}"
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"HTTP 404"* ]]
  [ ! -e "${CALLS}" ]
}

@test "a green nightly does nothing" {
  cat > "${FIX}/jobs-w1.json" <<'JSON'
{"items":[{"name":"macOS BATS Shell Tests","status":"success","job_number":9001}]}
JSON
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"no red"* ]]
  [ ! -e "${CALLS}" ]
}

@test "no nightly workflow in the window does nothing" {
  cat > "${FIX}/workflows-p1.json" <<'JSON'
{"items":[{"id":"w9","name":"other"}]}
JSON
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  [[ "${output}" == *"no nightly-macos workflow"* ]]
  [ ! -e "${CALLS}" ]
}

@test "a red job with no open issue creates one with the job URL and artifact names" {
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  grep -q '^issue create ' "${CALLS}"
  ! grep -q '^issue comment ' "${CALLS}"
  grep -qF -- '--label circleci-nightly-macos' "${CALLS}"
  grep -qF 'macOS BATS Shell Tests: failed' "${CALLS}"
  grep -qF 'https://app.circleci.com/pipelines/github/kaeawc/auto-mobile/501/workflows/w1/jobs/9001' "${CALLS}"
  grep -qF 'bats-unit-joblog/bats-unit-joblog-durations.tsv' "${CALLS}"
  ! grep -qF 'Thread Sanitizer: ' "${CALLS}"
  ! grep -qF 'jobs/400' "${CALLS}"
}

@test "a red job with an open issue comments on it instead of creating another" {
  printf '4242\n' > "${OPEN_FILE}"
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  grep -q '^issue comment 4242 ' "${CALLS}"
  ! grep -q '^issue create ' "${CALLS}"
}

@test "a red job with no uploaded artifacts says so" {
  printf '{"items":[]}' > "${FIX}/artifacts-9001.json"
  run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  grep -qF 'none uploaded' "${CALLS}"
}
