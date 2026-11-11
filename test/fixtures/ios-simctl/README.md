# simctl output fixtures

Captured verbatim from real `xcrun simctl` runs. Nothing here is hand-written.

- `defaults-delete-absent-key-ios27.txt` (#14786): the error message the daemon's
  simctl runner raised for `simctl spawn <udid> defaults delete .GlobalPreferences
  AppleCalendar` when the key was absent. iOS 27.0 (iPhone 18 Pro simulator),
  manual-test batch 20261021e, pinned SHA 7521abbef2e0; copied from the release's
  `status.timing.reset.fallbackReason` with the `iOS reset command failed: ` wrapper
  removed.
- `residue-*` (keep-booted residue guard): captured 2026-10-22 from real iOS 27.0 / 26.5
  simulators on this host. `residue-dcim-files.txt` is `find . -type f` under
  `<data>/Media/DCIM`; `residue-documents-entries.txt` is `ls -A <data>/Documents`;
  `residue-safari-container.txt` is `simctl get_app_container <udid> com.apple.mobilesafari
  data` (host user path replaced by `/Users/runner`); `residue-get-app-container-missing.txt`
  is the stderr of that command for an uninstalled bundle; `residue-preferences-clean.plist`
  is `simctl spawn <udid> defaults export com.apple.Preferences -` on an untouched
  simulator; `residue-preferences-keyboard-planted.plist` is `defaults export` of a
  domain after `defaults write KeyboardAutocorrection -bool NO` (the planted key from
  manual-test batch 20261022b).
- `residue-accessibility-*.xml` (#15017): `simctl spawn <udid> defaults export
  com.apple.Accessibility -` captured 2026-10-22 on a freshly created iOS 27.0 (iPhone 18
  Pro) simulator: `-clean` before any contrast change, `-increase-contrast-enabled` after
  `simctl ui <udid> increase_contrast enabled`, and `-increase-contrast-disabled` after
  turning it back off (`DarkenSystemColors` and `PointerIncreasedContrastEnabled` stay at 0).
- `log-show-compact-mobilesafari-ios27.txt` (#15329): the five newest lines of
  `simctl spawn <udid> log show --last 30s --style compact --predicate 'subsystem ==
  "com.apple.mobilesafari" OR … OR process == "MobileSafari"'`, taken from the `getLogs`
  result of the 0.0.88 all-tools smoke run (2026-10-25, iOS 27.0 iPhone 18 Pro simulator,
  MCP session output `6b9563fa-0c3f-4466-a559-647de176f8c0`). Unlike the other files here this is
  reconstructed from the parsed result, not raw stdout: each line is the captured
  timestamp and message joined by one space (the parser strips the column padding). The
  120 s / 300 s windows of the same app emitted 3.9 MB / 4.8 MB (26k lines) of this shape,
  which overflowed the buffered `execFile` stdout; tests replay these lines to that volume.
- `list-all-appletv-26-5.json`: verbatim `xcrun simctl list -j` on this host,
  captured 2026-10-31, containing the tvOS 26.5 runtime with Apple TV simulators,
  plus iOS, watchOS and visionOS rows used as test negatives.
- `log-show-compact-acceptwatch-watchos26-5.txt` (#17547): the head of `xcrun simctl spawn
  <udid> log show --last 2m --style compact --predicate 'process == "AcceptWatch"'` on a
  watchOS 26.5 Apple Watch Series 11 46mm simulator, quoted verbatim in #17547 from the
  #16836 acceptance run (2026-11-08). Unlike iOS output, it starts with a
  `getpwuid_r did not find a match for uid 501` line before the header.
- `log-show-compact-crashtv-tvos26-5.txt` and `crash-report-crashtv-tvos26-5.ips`
  (#16723): verbatim captures from a tvOS 26.5 Apple TV 4K (3rd generation) simulator,
  captured 2026-11-11. The app was built from a 25-line UIKit fixture that logs then
  indexes an empty array. The compact log starts with a `getpwuid_r` preamble; the
  EXC_BREAKPOINT/SIGTRAP report has header `platform: 8` and its simulator UDID in
  `procPath`. Reports are written to `~/Library/Logs/DiagnosticReports`, as on iOS.
- `launchctl-list-crashtv-tvos26-5.txt` (#16723): the verbatim app-service line
  from `simctl spawn <udid> launchctl list` supplied by the tvOS 26.5 device run.
  The service is in the `system` domain; this simulator has no `user/501` domain.
- `log-show-compact-dogfoodvision-visionos26-5.txt` (#18011): verbatim stdout of
  `log show --style compact` with the app's subsystem predicate on a visionOS 26.5 Apple
  Vision Pro 4K simulator, quoted in the issue from the #16854 dogfood run (2026-11-11).
  The app logs with `Logger(subsystem: "dev.dogfood.vision", category: "ui")`; the output
  starts with the same `getpwuid_r` preamble as watchOS and tvOS.
