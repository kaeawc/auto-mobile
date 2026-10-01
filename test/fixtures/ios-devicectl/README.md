# devicectl captured output

Verbatim host captures (no device or simulator targeted), 2026-10-01.
Xcode 26.6 (17F113), CoreDevice 651.13.4.

- `version.txt`: `xcrun devicectl --version`
- `help.txt`: `xcrun devicectl help`
- `device-help.txt`: `xcrun devicectl device --help`
- `list-help.txt`: `xcrun devicectl list --help`
- `list-devices-simulators-only.json`: `xcrun devicectl list devices --json-output <file> --quiet`
- `list-devices-simulators-only-omit-deprecated.json`: `xcrun devicectl list devices --json-output <file> --quiet --omit-deprecated-fields-in-json`

Both listing captures were taken on 2026-10-01 with devicectl 651.13.4 / jsonVersion 5.
Each contains 8 simulator records: 2 booted+connected, 6 shutdown+disconnected;
no physical devices. Files are verbatim, including simulator names and UDIDs.

`manifest.json` is hand-authored expectation metadata, not a capture. It declares
physical, available simulator, not-available, and unidentified counts, expected
discovery completeness, and optional sorted physical/simulator UDIDs. A row may
declare `sameStateAs` to require identical classification to another capture.

To add a physical or mixed capture, drop its untouched `list-devices-*.json` file
here and add its expectation row to the manifest; no loader or test code changes
are needed. The loader enumerates every matching capture and fails for zero
captures, a missing manifest row, or a row without a capture. Capture JSON is
excluded from formatting; the manifest is formatted normally. All JSON in this
directory uses LF via `.gitattributes`.

Not captured (needs hardware):

- Physical only
- Mixed physical + simulators
- Paired Watch / Apple TV

Not captured (needs a targeted simulator): a real CoreDeviceError 1001
"not supported by this device" failure and the shut-down-simulator failure.
