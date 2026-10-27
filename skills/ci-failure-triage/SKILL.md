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
2. The `green-main` ruleset requires 22 status checks; it is the authoritative
   list (`gh api repos/kaeawc/auto-mobile/rulesets`, then
   `rulesets/<id>` and its `required_status_checks` rule). The roll-up gates
   (`IDE Plugin`, `iOS Build`, `Shell Tests`) only give a required context a
   stable name over matrix or conditionally skipped jobs; the other required
   checks are ordinary jobs that report directly, so read the failing job
   itself. Advisory means not in the ruleset (simulator, emulator,
   device-capture lanes): it never blocks a merge. The Linux unit run and its 100 ms
   budget step live in the required `Node TypeScript Build and Test
   (ubuntu-latest)` job (#10893), so a budget breach there blocks; classify it
   before rerunning (a loaded-runner overage is `RERUN-DONT-FIX`). Runs from
   before the non-required `iOS`, `Android`, `Node Tests`, and `WebRTC` roll-ups
   were removed still classify those contexts as `CHECK-UPSTREAM-FIRST` when
   only an advisory lane failed.
3. For `CHECK-UPSTREAM-FIRST`, inspect the named upstream row before retrying or
   filing work. A red aggregator is not a test diagnosis.
4. When the verdict is `INVESTIGATE` with a named test `file:line` or missing
   import path, act on that diagnosis. Treat a shard as signal-killed only
   when the output says `killed by signal`.
5. Do not re-fix `KNOWN-NONFIX` signatures. In particular, a Dependabot
   sharp/jimp bump that breaks the pinned clean-room graph is designed to be
   rejected; close or ignore that Dependabot PR instead of changing runtime
   dependencies.
6. For integration-test or runtime-graph input changes, run
   `bash scripts/prepush-integration.sh` before pushing. It runs only changed
   integration files and only runs the clean-room runtime audit when its inputs
   changed.

Use `check-ci` when the failure needs full exact-head PR-state and log analysis.
