---
name: ci-failure-triage
description: "Classify failed pull-request workflow runs, distinguish hard from advisory roll-ups, and avoid re-fixing documented non-fixes."
---

# CI Failure Triage

Use this for a failed `pull_request.yml` run or a red CI aggregator. It is
read-only unless the user also asks to fix a confirmed cause.

1. Run `bash scripts/ci/classify-failure.sh <run-id>` first. It lists each
   failed/cancelled job, failed step, check-run annotations, and a matching
   `scripts/ci/known-flakes.txt` verdict.
2. Treat `iOS`, `Android`, and `Node Tests` roll-ups as hard only for the
   deterministic dependencies reported by the classifier. Their simulator,
   emulator, or Node-unit advisory failures warn without blocking the roll-up.
   `WebRTC` treats `WebRTC Publisher Integration (MediaMTX)` as hard/required;
   only its Android and iOS device-capture legs are advisory. `detect-changes`
   remains hard for every roll-up.
3. For `CHECK-UPSTREAM-FIRST`, inspect the named upstream row before retrying or
   filing work. A red aggregator is not a test diagnosis.
4. Do not re-fix `KNOWN-NONFIX` signatures. In particular, a Dependabot
   sharp/jimp bump that breaks the pinned clean-room graph is designed to be
   rejected; close or ignore that Dependabot PR instead of changing runtime
   dependencies.
5. For integration-test changes, run `bash scripts/prepush-integration.sh` before
   pushing. It runs only changed integration files and only runs the clean-room
   runtime audit when its inputs changed.

Use `check-ci` when the failure needs full exact-head PR-state and log analysis.
