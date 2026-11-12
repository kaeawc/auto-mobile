# Lean profile and template clone defaults

- Kind: decision
- Date: 2026-10-24
- Source: moved from `how-it-works/plat/ios/simulator-load-reduction.md`; #15097, #15219, #15222,
  #15236, #15287, #15216, #15327, #15328, #15371
- Shaped: [iOS simulator first-boot load](../how-it-works/plat/ios/simulator-load-reduction.md)

## Context

[Measurements](2026-10-24-simulator-load-reduction-measurements.md) showed a settled-template clone
saves 46 percent of first-boot CPU-seconds, a pre-boot lean profile 43 to 61 percent depending on
labels, and both together 65 to 72 percent, with the basic driving surface intact.

## Options

#15097 recommended doing both, clone first:

1. Provision new iOS simulators from a settled template clone, one template per runtime and device type, kept
   shut down: minus 46 percent CPU-seconds, about 3 seconds to clone, plus the one-off template settle.
2. Apply a CPU-lean launchd profile before the first boot of every simulator AutoMobile creates or clones,
   and re-apply it per device id. The measured profiles are `catalog-cpu` (23 labels, minus 50 percent alone) and
   `cpu-plus` (45 labels, minus 61 percent alone). The smallest useful default is likely the shipped wallpaper
   rendering and widgets resources (minus 25 and 23 percent on their own, roughly minus 48 percent combined by
   addition, not measured together or alongside a clone); speech/Siri and the other `cpu-plus` daemons are an
   opt-in extra. Do not offer a disable-all preset.
3. Clone plus `catalog-cpu` or `cpu-plus` measured minus 69 and minus 72 percent CPU-seconds (789 to 245 and 222)
   with the basic driving surface intact. Time-to-quiet fell from 200 to 122 to 130 seconds (the first quiet
   60 second window), so boot gating stays, at roughly a third of the CPU cost and about 60 to 65 percent of
   the quiet time.

## Decision

Owner decision 2026-10-24 (#15287):

- `AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE` defaults to `minimal`: minus 43 percent CPU-seconds in the harness (minus 37
  percent in the product path) and 100 seconds off the time-to-quiet in the harness (10 seconds in the product path),
  with no breakage cost attributable to it. Idle was not shown to differ (two drift runs per condition; the product
  last-120-second mean was higher with `minimal`, 7.3 against 3.8 percent, unexplained). `catalog-cpu` bought about
  7 more points in #15097 (minus 50 against a 789 baseline; not re-measured here) while removing Health, Apple
  Intelligence and search, and stays opt-in with speech/Siri.
- `AUTOMOBILE_IOS_TEMPLATE_CLONE` was made default on and then flipped back to off for this release (owner decision
  2026-10-25, see Consequences); opt in with `1`/`true`. Measurements: a clone alone is minus 46 percent (harness only); clone + `minimal`
  is minus 65 percent in the harness and the product path, and minus 62 to 63 percent with two and four simultaneous
  boots, at about 3 seconds per clone. Costs: the first creation per runtime, device type and profile is a normal one,
  a background template build of about 13 minutes occupies a boot slot, and each template needs a disk copy. Re-check
  the aged-clone Safari tap on the next manual test first.
- Size boot concurrency by CPU-seconds: a first boot is about 775 CPU-seconds, 442 with `minimal`, 273 as a clone
  with `minimal`, and k simultaneous boots cost slightly more than k times that.

## Consequences

Owner decision 2026-10-25 (#15328): `AUTOMOBILE_IOS_TEMPLATE_CLONE` went back to default off for the
release (introduced by #15236, flipped on by #15287); `AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE` stayed
`minimal`. Round 9 of the manual test found that a clone shared Safari and other system-app data with
its template, so state written in one clone (tabs, history, cookies, website data) leaked to the
template and to other clones (#15327, a sub-issue of #15216).

Cause: the LaunchServices store (`var/db/lsd/*.csstore`, about 1090 container URLs on iOS 26.5) and
about 130 other files and ten symlinks (`Library/Logs`, `Library/Shortcuts/ToolKit/Tools-active`, the
MobileAsset `atomic_instance_latest.locker` links) recorded the template's UDID, so MobileSafari and the
daemons around it opened the template's files and `simctl get_app_container <clone>` returned the
template path.

`SimulatorCloneRelocator` (#15371) rewrites the UDID before first boot. Measured on iOS 26.5, iPhone 17,
a 2 GB template data directory: 3 to 10 s to relocate, and afterwards a Safari launch plus `openurl` in
a clone left the template's data directory byte-identical (10063 entries, zero diff), held no file
descriptors under the template, and a second clone showed no residue of the first. The default stays
off until a manual test confirms this on a release candidate.
