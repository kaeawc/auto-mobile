# simctl output fixtures

Captured verbatim from real `xcrun simctl` runs. Nothing here is hand-written.

- `defaults-delete-absent-key-ios27.txt` (#14786): the error message the daemon's
  simctl runner raised for `simctl spawn <udid> defaults delete .GlobalPreferences
  AppleCalendar` when the key was absent. iOS 27.0 (iPhone 18 Pro simulator),
  manual-test batch 20261021e, pinned SHA 7521abbef2e0; copied from the release's
  `status.timing.reset.fallbackReason` with the `iOS reset command failed: ` wrapper
  removed.
