---
name: ios-swift-ci
description: "Use this workflow skill to triage an AutoMobile iOS or Swift CI failure from the exact job evidence, distinguish required checks from advisory simulator failures, and run the fast local Swift validation."
---

# iOS/Swift CI Triage

Use this for `SwiftLint`, `Swift Code Coverage`, `iOS Build`, Swift package,
WHEP, or `XCTestRunner Simulator Tests` failures.

1. Resolve the exact PR head and current main base. Do not trust a prior green
   head after a rebase or merge queue update.
2. Identify whether the check is required. `XCTestRunner Simulator Tests` and
   the `iOS` roll-up are advisory; the required iOS checks are `SwiftLint`,
   `Swift Code Coverage`, and `iOS Build`.
3. Read the failed job by run and job ID with
   `gh run view <run-id> --job <job-id> --log-failed`. If it is incomplete,
   retrieve the job log or failure artifact before assigning a cause.
4. Classify the failure as PR-caused (with a local command), PR-caused without
   a local command, stale-base/main-red, runner infrastructure, test flake, or
   advisory roll-up fan-out. Do not retry merely because a simulator job is red.
5. For simulator jobs, preserve ownership: one explicit simulator UDID per job,
   used serially. Never share a simulator between parallel jobs/runners.
6. Recognize this week's known simulator signatures: five-minute CtrlProxy UI
   test timeout; CtrlProxy surviving forced teardown; video recording `simctl
list` state timeout; hierarchy UI test over 90 seconds. Gather new evidence
   before treating any of them as the same bug.
7. For a Swift change, run `scripts/prepush-ios.sh`. It checks the pinned
   SwiftFormat 0.54.6, SwiftLint's error rules, `swift build` in XCTestRunner,
   and only simulator-free XCTestRunner tests.
8. Before merge, refresh the exact head on latest main; a stale base can hide a
   main-red period.
