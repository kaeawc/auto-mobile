#!/usr/bin/env bats
#
# The nightly failure alert (#11368): one tracking issue, commented on while open, never one per
# night. gh is replaced by a fake that logs its argv and answers `issue list` from a file.

SCRIPT="scripts/ci/open-live-idle-release-alert.sh"

setup() {
  CALLS="${BATS_TEST_TMPDIR}/calls.log"
  OPEN_FILE="${BATS_TEST_TMPDIR}/open-number"
  FAKE="${BATS_TEST_TMPDIR}/gh"
  cat > "${FAKE}" <<'FAKE_EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CALLS}"
if [[ "$1 $2" == "issue list" ]]; then
  cat "${OPEN_FILE}" 2> /dev/null || true
fi
FAKE_EOF
  chmod +x "${FAKE}"
  export CALLS OPEN_FILE
  export ALERT_GH="${FAKE}"
  export ALERT_RUN_URL="https://example.test/runs/7"
  export ALERT_EVIDENCE_DIR="${BATS_TEST_TMPDIR}/evidence"
  mkdir -p "${ALERT_EVIDENCE_DIR}"
}

@test "a successful job does nothing" {
  ALERT_JOB_STATUS=success run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  [ ! -e "${CALLS}" ]
}

@test "a failure with no open tracking issue creates one naming the scenarios and the run" {
  printf 'idle\nstream\n' > "${ALERT_EVIDENCE_DIR}/failed-scenarios.txt"
  ALERT_JOB_STATUS=failure run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  grep -q '^issue create ' "${CALLS}"
  ! grep -q '^issue comment ' "${CALLS}"
  grep -qF 'Failed scenarios: idle, stream' "${CALLS}"
  grep -qF 'https://example.test/runs/7' "${CALLS}"
  grep -qF -- '--label live-idle-release-nightly' "${CALLS}"
}

@test "a failure with an open tracking issue comments on it instead of creating another" {
  printf '4242\n' > "${OPEN_FILE}"
  ALERT_JOB_STATUS=failure run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  grep -q '^issue comment 4242 ' "${CALLS}"
  ! grep -q '^issue create ' "${CALLS}"
}

@test "a failure without a scenario list still alerts and says the scenarios are unknown" {
  ALERT_JOB_STATUS=failure run bash "${SCRIPT}"
  [ "${status}" -eq 0 ]
  grep -qF 'Failed scenarios: unknown' "${CALLS}"
}

@test "a failure without a run URL is refused" {
  unset ALERT_RUN_URL
  ALERT_JOB_STATUS=failure run bash "${SCRIPT}"
  [ "${status}" -ne 0 ]
  [ ! -e "${CALLS}" ]
}

@test "the workflow alerts on failure with issues:write scoped to the check job" {
  wf=".github/workflows/live-idle-release.yml"
  grep -qF 'if: failure()' "${wf}"
  grep -qF 'bash scripts/ci/open-live-idle-release-alert.sh' "${wf}"
  [ "$(grep -c 'issues: write' "${wf}")" = "1" ]
  # The only issues:write sits inside the check job, after its job header.
  awk '/^  live-idle-release:/{j=1} j && /issues: write/{f=1} END{exit !f}' "${wf}"
}
