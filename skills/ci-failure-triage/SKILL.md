---
name: ci-failure-triage
description: "Classify failed pull-request workflow runs, distinguish required from advisory jobs, and avoid re-fixing documented non-fixes."
---

# CI Failure Triage

Use this for a failed `pull_request.yml` run or a red roll-up gate. It is
read-only unless the user also asks to fix a confirmed cause.

1. Run `bash scripts/ci/classify-failure.sh <run-id>` first. It lists each
   failed/cancelled job, failed step, check-run annotations, and a matching
   `scripts/ci/known-flakes.txt` verdict.
2. `pull_request.yml` keeps roll-up gates only for required checks (`IDE Plugin`,
   `iOS Build`, `Shell Tests`); every other job reports directly, so read the
   failing job itself. Advisory lanes (simulator, emulator, device-capture, and
   the Node Unit Tests 100 ms budget step, formerly the Node Unit Timing Budget
   job) are non-required and never block a merge. Runs from
   before the non-required `iOS`, `Android`, `Node Tests`, and `WebRTC` roll-ups
   were removed still classify those contexts as `CHECK-UPSTREAM-FIRST` when
   only an advisory lane failed.
3. For `CHECK-UPSTREAM-FIRST`, inspect the named upstream row before retrying or
   filing work. A red aggregator is not a test diagnosis.
4. Do not re-fix `KNOWN-NONFIX` signatures. In particular, a Dependabot
   sharp/jimp bump that breaks the pinned clean-room graph is designed to be
   rejected; close or ignore that Dependabot PR instead of changing runtime
   dependencies.
5. For integration-test or runtime-graph input changes, run
   `bash scripts/prepush-integration.sh` before pushing. It runs only changed
   integration files and only runs the clean-room runtime audit when its inputs
   changed.

Use `check-ci` when the failure needs full exact-head PR-state and log analysis.
