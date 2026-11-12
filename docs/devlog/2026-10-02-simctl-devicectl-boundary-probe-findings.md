# devicectl simulator probe findings

- Kind: concept
- Date: 2026-10-02
- Source: moved from `how-it-works/plat/ios/simctl-devicectl-boundary.md`; #8347, #8623, #8761
- Shaped: [iOS simctl and devicectl boundary](../how-it-works/plat/ios/simctl-devicectl-boundary.md)

## Provenance of the capability claims

The capability matrix comes from #8347 (Xcode 27.1 beta, CoreDevice 651.13.4) and was not
re-verified in the checkout that documented it. The shut-down-simulator findings come from #8623
(2026-10-01, devicectl 651.13.4, no physical device; not hardware-verified).

## Observations from #8623

- Shut-down simulators supported `list devices`, `device info details` and `ddiServices` (static
  properties, 7 capabilities).
- devicectl listed 8 of simctl's 18 simulators. The 10 missing were default-named, never-booted
  iOS 27.0 devices, yet a freshly created never-booted one appeared; the visibility rule was left
  undetermined.
- simctl reports the shutting-down state as "Shutting Down".

## Open verification items

- Real failed-envelope captures were still owed; the exact CoreDevice error-domain string was
  unverified.
- Whether older CoreDevice writes `--json-output -` to stdout was unverified.

## CoreDevice downgrade guard

A guard against the `xcodebuild -runFirstLaunch` CoreDevice downgrade hazard was ruled out of scope
by the owner on 2026-10-02.
