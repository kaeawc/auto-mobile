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
#
# merge.yml's desktop-core-unit-tests is currently `if: ${{ false }}`, so its
# step is inert today. It is kept and pinned so the two workflows do not
# silently diverge if that job is re-enabled.

REPORT_PATH="android/desktop-core/build/reports/screenshots/"
BASELINE_PATH="android/desktop-core/src/test/resources/screenshots/"

# Extract a job block: from its "  <job>:" line up to (but not including) the
# next top-level (2-space-indented) job key. Capture only starts after the
# top-level "jobs:" key, so a same-named key under "on:" cannot match. awk,
# not sed -- BSD sed lacks the range/address forms this needs.
job_block() {
  awk -v job="$2" '
    /^jobs:/ { in_jobs = 1; next }
    !in_jobs { next }
    $0 ~ "^  " job ":" { capture = 1; print; next }
    capture && /^  [A-Za-z0-9_-]+:/ { exit }
    capture { print }
  ' "$1"
}

# From a job block on stdin, print the single step block that mentions the
# screenshots report directory.
#
# Both "      - " (step start) and "      #" (a comment at step indent) close
# the current block. Without the comment boundary, comment lines trailing a
# step fold into *that step's* block, so a comment mentioning the report path
# would make the preceding step match and satisfy every assertion below.
screenshot_upload_step() {
  awk -v want="$REPORT_PATH" '
    /^      [-#]/ {
      if (index(block, want)) printf "%s", block
      block = ""
    }
    { block = block $0 "\n" }
    END { if (index(block, want)) printf "%s", block }
  '
}

# Every workflow/job pair that must carry the upload.
upload_sites() {
  echo ".github/workflows/record-screenshot-baselines.yml record"
  echo ".github/workflows/pull_request.yml desktop-core-unit-tests"
  echo ".github/workflows/merge.yml desktop-core-unit-tests"
}

record_step() {
  job_block ".github/workflows/record-screenshot-baselines.yml" "record" | screenshot_upload_step
}

@test "record-screenshot-baselines uploads the screenshot diff reports" {
  step="$(record_step)"
  [ -n "$step" ]
}

@test "record-screenshot-baselines diff upload uses actions/upload-artifact" {
  step="$(record_step)"
  [ -n "$step" ]
  [[ "$step" =~ uses:\ actions/upload-artifact@v[0-9]+ ]]
}

@test "record-screenshot-baselines diff upload only runs on failure" {
  # Without if: failure() every successful record run would upload an empty
  # (or absent) directory and warn.
  step="$(record_step)"
  [ -n "$step" ]
  [[ "$step" == *"if: failure()"* ]]
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
  step="$(record_step)"
  [ -n "$step" ]
  [[ "$step" == *"$BASELINE_PATH"* ]]
}

@test "record-screenshot-baselines still opens the baselines PR after the upload" {
  # The upload is inserted directly above "Open PR with recorded baselines";
  # guard that it displaced rather than replaced it.
  block="$(job_block ".github/workflows/record-screenshot-baselines.yml" "record")"
  upload_line="$(echo "$block" | grep -n "$REPORT_PATH" | head -1 | cut -d: -f1)"
  pr_line="$(echo "$block" | grep -n 'Open PR with recorded baselines' | head -1 | cut -d: -f1)"
  [ -n "$upload_line" ]
  [ -n "$pr_line" ]
  [ "$pr_line" -gt "$upload_line" ]
}

@test "pull_request desktop-core-unit-tests uploads the screenshot diff reports on failure" {
  step="$(job_block ".github/workflows/pull_request.yml" "desktop-core-unit-tests" | screenshot_upload_step)"
  [ -n "$step" ]
  [[ "$step" =~ uses:\ actions/upload-artifact@v[0-9]+ ]]
  [[ "$step" == *"if: failure()"* ]]
}

@test "merge desktop-core-unit-tests uploads the screenshot diff reports on failure" {
  step="$(job_block ".github/workflows/merge.yml" "desktop-core-unit-tests" | screenshot_upload_step)"
  [ -n "$step" ]
  [[ "$step" =~ uses:\ actions/upload-artifact@v[0-9]+ ]]
  [[ "$step" == *"if: failure()"* ]]
}

@test "existing HTML test-report uploads are preserved" {
  # The screenshot upload is additive: the pre-existing test-results upload in
  # both desktop-core-unit-tests jobs must survive.
  for workflow in ".github/workflows/pull_request.yml" ".github/workflows/merge.yml"; do
    block="$(job_block "$workflow" "desktop-core-unit-tests")"
    [ -n "$block" ]
    [[ "$block" == *"name: desktop-core-test-results"* ]]
    [[ "$block" == *"path: android/desktop-core/build/reports/tests/test/"* ]]
  done
}

@test "screenshot and test-report artifact names differ within a job" {
  # Both uploads sit in the same job under the same if: failure() condition.
  # upload-artifact@v4+ errors on two uploads sharing a name in one run, so a
  # collision here would turn every failing run into a second, opaque failure.
  for workflow in ".github/workflows/pull_request.yml" ".github/workflows/merge.yml"; do
    step="$(job_block "$workflow" "desktop-core-unit-tests" | screenshot_upload_step)"
    [ -n "$step" ]
    [[ "$step" != *"name: desktop-core-test-results"* ]]
    [[ "$step" == *"name: desktop-core-screenshot-diffs"* ]]
  done
}

@test "screenshot diff uploads tolerate an absent report directory" {
  # These jobs fail for many reasons that are not screenshot mismatches, and
  # the report dir only exists after a mismatch. Without if-no-files-found the
  # upload warns on every unrelated failure.
  while read -r workflow job; do
    step="$(job_block "$workflow" "$job" | screenshot_upload_step)"
    [ -n "$step" ]
    [[ "$step" == *"if-no-files-found: ignore"* ]]
  done < <(upload_sites)
}

@test "screenshot diff uploads expire on the short diagnostic retention" {
  # Failure-diagnostic output has a short useful life; the repo's other
  # diagnostic uploads use 7 days rather than the 90-day default.
  while read -r workflow job; do
    step="$(job_block "$workflow" "$job" | screenshot_upload_step)"
    [ -n "$step" ]
    [[ "$step" == *"retention-days: 7"* ]]
  done < <(upload_sites)
}
