# Xcode 27.2 advisory lane as its own workflow

- Kind: decision
- Date: 2026-11-15
- Source: #18363
- Shaped: [macOS CI capacity plan](../how-it-works/ci/macos-capacity-plan.md)

## Context

CI built only with Xcode 26.6 (26.5 for the watchOS and visionOS runners). Hosted `macos-26`
tops out at 26.6; the hosted `xcode-27` preview image has Xcode 27.2, with 27.1 as its default.
The issue asked for an advisory Xcode 27.2 lane for the iOS packages, runner and apps, and for
the tvOS, watchOS and visionOS runner builds, that cannot block a merge.

## Options

1. Add an `Xcode 27.2` entry to the `ios-swift-packages` and `ios-xcode-build` matrices in
   `pull_request.yml`.
2. Run the 27.2 builds in a separate workflow on `xcode-27`.

## Decision

Option 2, `.github/workflows/ios-xcode-27-2.yml`. The two matrix jobs are needs of the required
`iOS Build` roll-up, so a matrix leg would make the gate wait for a preview runner, and a red leg
would need `continue-on-error` to keep the gate green. The matrix jobs also route owner PRs to
the self-hosted Macs, which have no Xcode 27.2. A separate workflow has its own check names
outside the ruleset, runs only on hosted `xcode-27`, and builds unsigned.

## Consequences

The 26.6 jobs and the required checks are unchanged. The 27.2 workflow runs on pull requests and
pushes to main that touch iOS paths, nightly and on dispatch, and selects 27.2 explicitly. The
release artifact workflows stay on 26.6 or 26.5 until a follow-up moves them.
