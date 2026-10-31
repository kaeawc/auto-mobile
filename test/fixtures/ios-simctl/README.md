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
