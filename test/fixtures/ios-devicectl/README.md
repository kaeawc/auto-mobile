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
discovery completeness, optional `notAvailableReasons` counts by typed reason (both
current captures declare `{ "shutdown": 6 }`), and optional sorted physical/simulator
UDIDs. A row may
declare `sameStateAs` to require identical classification to another capture; tests
also pair every record of the current two captures by identifier and compare its
classification and device fields.

`complete: true` requires a recognized successful envelope and positive
classification of every record: a physical iOS device, a simulator, or an
explicitly known unavailable/non-iOS device. Unidentified records make the
listing incomplete and replay retained last-good physical devices instead of
clearing them. Both captures remain complete with zero unidentified records.

All captured simulators have an iOS platform, `reality: "simulated"`, and a
simulator-shaped hardware UDID. These three fields identify simulators before
availability filtering, including shutdown/disconnected simulators. A generic
CoreDevice `identifier` UUID or a simulator-shaped UDID alone is insufficient.
Tests label in-memory mutations as DERIVED; physical-shaped variants change
reality/udid/platform and remove simulator visibility markers; they are not
physical-device capture evidence.

To add a physical or mixed capture, drop its untouched `list-devices-*.json` file
here and add its expectation row to the manifest; no loader or test code changes
are needed. The loader enumerates every matching capture and fails for zero
captures, a missing manifest row, or a row without a capture. Capture JSON is
excluded from formatting; the manifest is formatted normally. All JSON in this
directory uses LF via `.gitattributes`.

Not captured (needs hardware):

- Physical only, including records under `properties.*` and whether `identifier` differs from the UDID
- Mixed physical + simulators
- Paired Watch / Apple TV

Not captured (needs a targeted simulator):

- `booting` / `shuttingDown` simulator records (tests use DERIVED in-memory variants).
- Real failed-command envelopes for CoreDeviceError 1000 and 1001: a captured
  `--device <duplicate name>` failure and a shut-down `device info apps` failure.
  Tests use constructed minimal objects, not captured output.
