#!/usr/bin/env bats
#
# Guards issue #3913: recorded desktop screenshot baselines fail their own
# immediate re-verification on the reference OS, and the failure is not
# diagnosable because nothing uploads the pixel diffs.
#
# ScreenshotComparator writes "<name>.diff.png" and "<name>.actual.png" into
# android/desktop-core/build/reports/screenshots/ on every mismatch, but that
# directory is discarded with the runner. Every job that can fail a screenshot
# comparison must upload it on failure:
#
#   - record-screenshot-baselines.yml, whose "verify" step re-checks the
#     baselines it just recorded (the failure reported in #3913), and
#   - desktop-core-unit-tests in pull_request.yml / merge.yml, which verify
#     committed baselines on a fresh runner.

REPORT_PATH="android/desktop-core/build/reports/screenshots/"

# Extract a job block: from its "  <job>:" line up to (but not including) the
# next top-level (2-space-indented) job key. awk, not sed -- BSD sed lacks the
# range/address forms this needs.
job_block() {
  awk -v job="$2" '
    $0 ~ "^  " job ":" { capture = 1; print; next }
    capture && /^  [A-Za-z0-9_-]+:/ { exit }
    capture { print }
  ' "$1"
}

# From a job block on stdin, print the single step block that mentions the
# screenshots report directory. A step block runs from its "      - " line up
# to the next one.
screenshot_upload_step() {
  awk -v want="$REPORT_PATH" '
    /^      - / {
      if (index(block, want)) printf "%s", block
      block = ""
    }
    { block = block $0 "\n" }
    END { if (index(block, want)) printf "%s", block }
  '
}

@test "record-screenshot-baselines uploads the screenshot diff reports" {
  step="$(job_block ".github/workflows/record-screenshot-baselines.yml" "record" | screenshot_upload_step)"
  [ -n "$step" ]
}

@test "record-screenshot-baselines diff upload uses actions/upload-artifact" {
  step="$(job_block ".github/workflows/record-screenshot-baselines.yml" "record" | screenshot_upload_step)"
  echo "$step" | grep -Eq 'uses: actions/upload-artifact@v[0-9]+'
}

@test "record-screenshot-baselines diff upload only runs on failure" {
  # Without if: failure() every successful record run would upload an empty
  # (or absent) directory and warn.
  step="$(job_block ".github/workflows/record-screenshot-baselines.yml" "record" | screenshot_upload_step)"
  echo "$step" | grep -Fq 'if: failure()'
}

@test "record-screenshot-baselines diff upload is ordered after the verify step" {
  # The diffs only exist once the verify step has run and failed, so the
  # upload must come after it in the step list.
  block="$(job_block ".github/workflows/record-screenshot-baselines.yml" "record")"
  verify_line="$(echo "$block" | grep -n 'Verify baselines pass in normal mode' | head -1 | cut -d: -f1)"
  upload_line="$(echo "$block" | grep -n "$REPORT_PATH" | head -1 | cut -d: -f1)"
  [ -n "$verify_line" ]
  [ -n "$upload_line" ]
  [ "$upload_line" -gt "$verify_line" ]
}

@test "record-screenshot-baselines diff upload includes the recorded baselines" {
  # A failing verify aborts the job before "Open PR", so the just-recorded
  # PNGs are discarded with the runner. They are the third leg of the
  # baseline/actual/diff comparison and must ship with the diffs.
  step="$(job_block ".github/workflows/record-screenshot-baselines.yml" "record" | screenshot_upload_step)"
  echo "$step" | grep -Fq 'android/desktop-core/src/test/resources/screenshots/'
}

@test "pull_request desktop-core-unit-tests uploads the screenshot diff reports on failure" {
  step="$(job_block ".github/workflows/pull_request.yml" "desktop-core-unit-tests" | screenshot_upload_step)"
  [ -n "$step" ]
  echo "$step" | grep -Eq 'uses: actions/upload-artifact@v[0-9]+'
  echo "$step" | grep -Fq 'if: failure()'
}

@test "merge desktop-core-unit-tests uploads the screenshot diff reports on failure" {
  step="$(job_block ".github/workflows/merge.yml" "desktop-core-unit-tests" | screenshot_upload_step)"
  [ -n "$step" ]
  echo "$step" | grep -Eq 'uses: actions/upload-artifact@v[0-9]+'
  echo "$step" | grep -Fq 'if: failure()'
}

@test "existing HTML test-report uploads are preserved" {
  # The screenshot upload is additive: the pre-existing test-results upload in
  # both desktop-core-unit-tests jobs must survive.
  for workflow in ".github/workflows/pull_request.yml" ".github/workflows/merge.yml"; do
    block="$(job_block "$workflow" "desktop-core-unit-tests")"
    echo "$block" | grep -Fq 'name: desktop-core-test-results'
    echo "$block" | grep -Fq 'path: android/desktop-core/build/reports/tests/test/'
  done
}

@test "screenshot diff uploads tolerate an absent report directory" {
  # These jobs fail for many reasons that are not screenshot mismatches, and
  # the report dir only exists after a mismatch. Without if-no-files-found the
  # upload warns on every unrelated failure.
  for spec in ".github/workflows/record-screenshot-baselines.yml record" \
    ".github/workflows/pull_request.yml desktop-core-unit-tests" \
    ".github/workflows/merge.yml desktop-core-unit-tests"; do
    # shellcheck disable=SC2086
    set -- $spec
    step="$(job_block "$1" "$2" | screenshot_upload_step)"
    echo "$step" | grep -Fq 'if-no-files-found: ignore'
  done
}
