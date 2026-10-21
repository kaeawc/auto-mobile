# Android startup-timing fixtures

Output shapes for `measureStartup` (#14112): `am start -W`, `cmd package resolve-activity --brief`
and `logcat -v epoch` activity-manager lines.

These were written from the AOSP output format (`ActivityManagerShellCommand` for `am start -W`,
`ActivityMetricsLogger` for `Displayed` / `Fully drawn`), not captured from a device. Replace
them with verbatim emulator captures (as `test/fixtures/android-am-start/` holds) when one is
taken; the parser tests read only these files, so a capture is a drop-in swap.
