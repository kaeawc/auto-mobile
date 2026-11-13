# macOS CI capacity plan choices

- Kind: decision
- Date: 2026-10-09
- Source: moved from `how-it-works/ci/macos-capacity-plan.md`; #11010, #11011, #11012, #11029, #11580
- Shaped: [macOS CI capacity plan](../how-it-works/ci/macos-capacity-plan.md)

## Context

CircleCI runs one macOS job at a time for this organization (#11010), so PR macOS jobs were spread
across CircleCI, self-hosted Mac pools on the owner's Mac (#11011) and Namespace (#11012) in #11029.

## Options

Not recorded beyond the choices below.

## Decision

- **Small pool size 4.** Swift package builds and the desktop Gradle build are CPU-bound and each can
  use most of the cores. Four small jobs plus the heavy lane keep about one performance core per
  process plus headroom for the owner's own work. Memory (128 GiB) is not the limit.
- **XCTestRunner Simulator Tests stays on hosted `macos-26`.** It runs only on the `run-ios-sim` label
  or on changes to the layers the iOS SDK contract suite crosses. Moving it needs a dedicated runner
  user and an isolated daemon port, so it was left for an owner decision.
- **Build Xcode Projects is one job** (#11580). As two matrix legs, Playground and CtrlProxy ran one
  after the other on the heavy runner anyway and repeated the setup.
- **WHEP on Namespace.** It fires only on WebRTC changes, so it rarely waits for the trial's single
  macOS slot. The CircleCI copy was removed.

## Consequences

The CircleCI mirrors of Swift Packages, Build Xcode Projects and Build Root SPM Package were removed;
those jobs run on GitHub only. Before the move, the GitHub nightly sweeps signed when certificates were
configured; the CircleCI sweeps build unsigned.
