# android-avdmanager fixtures

Captured output, not hand-written.

- `list-device.txt`: verbatim stdout of `avdmanager list device`, captured 2026-09-30
  on macOS from `~/Library/Android/sdk/cmdline-tools/latest/bin/avdmanager`
  (Android SDK Command-line Tools, Pkg.Revision=23.0). 96 profiles, including
  quoted aliases with spaces, dots and parentheses (e.g. `id: 83 or "3.7in WVGA (Nexus One)"`).

- `avdmanager-list-device-wear.txt`: verbatim Wear profile capture supplied for #16823.
- `sdkmanager-list-installed-wear.txt`: verbatim installed Wear image row supplied for #16823;
  the capture omits the section header, which tests prepend before parsing.
- `avdmanager-list-avd.txt`: verbatim AVD inventory supplied for #16823 (handheld AVDs).
