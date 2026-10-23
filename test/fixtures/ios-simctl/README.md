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
