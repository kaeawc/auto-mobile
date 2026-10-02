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

`complete: true` requires a recognized successful envelope. A record that cannot
be positively classified is skipped: it contributes no device and does not make
the listing incomplete. Both captures contain zero unidentified records.

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

- `device info displays --json-output` JSON for a booted iPhone Duo simulator (both postures); the
  captured display is a non-Duo iPhone 18 Pro, see below.
- A successful and a failed `device capture screenshot` run, including the failure envelope.
- The CoreDevice minimum version for simulator `device capture screenshot`.
- `booting` / `shuttingDown` simulator records (tests use DERIVED in-memory variants).
- Real failed-command envelope for CoreDeviceError 1000 (a `--device <duplicate name>` failure)
  and `device info apps` on a shut-down simulator. Tests use constructed minimal objects for 1000.
- A successful `device info apps` capture exists but is deliberately NOT committed: its app `url`
  values embed the capturing user's home directory, and these fixtures are verbatim (no redaction).

Captured 2026-10-02 (Xcode 26.6 / CoreDevice 651.13.4; host-only help, no device targeted):

- `capture-screenshot-help.txt`: `xcrun devicectl help device capture screenshot`
- `info-displays-help.txt`: `xcrun devicectl help device info displays`

Captured 2026-10-02 against a simulator (iPhone 18 Pro, iOS 27.0, non-Duo, UDID
1CBBDFF1-96B4-479E-85D2-489FFAC3BC3E) with `devicectl` from the Xcode 27.1 beta developer
directory, CoreDevice 651.13.4, jsonVersion 5. Each `.json` is the `--json-output` file and each
`.txt` the terminal output of the same run. All are verbatim: the `info.arguments` still name the
original `booted-*`/`shutdown-*` output file, and the `.txt` files show `?` where devicectl printed
non-ASCII quotes. Capture JSON is excluded from formatting (`.oxfmtrc.json`); `manifest.json` stays
list-devices-only, so these are not manifest rows.

- `info-displays-booted-simulator.{json,txt}`: `device info displays --device <udid>` on the booted
  simulator: success, one display (`displayId` 1, `uniqueId`, `primary: true`, `bounds`, `nativeSize`,
  `pointScale`, `type.integrated`, per-display `backlightState`, `currentOrientation`) plus top-level
  `backlightState` and `orientation`. A Duo capture must still confirm how two panels appear.
- `info-lockstate-booted-simulator-1001.{json,txt}`, `info-lockstate-shutdown-simulator-1001.{json,txt}`:
  `device info lockState`, booted and shut down: both 1001 with feature
  `com.apple.coredevice.feature.getlockstate`; a shut-down simulator gives the same envelope as a
  booted one.
- `info-files-appdatacontainer-booted-simulator-1001.{json,txt}`:
  `device info files --domain-type appDataContainer --domain-identifier <bundle id>` on the booted
  simulator: 1001, feature `com.apple.coredevice.feature.listFiles`.
- `motion-hinge-angle-shutdown-simulator-1001.{json,txt}`: `device motion hinge-angle` on the shut-down
  simulator: 1001, feature `com.apple.coredevice.feature.monitormotion`, has `DeviceIdentifier`.
- `motion-hinge-angle-booted-nonduo-simulator-1001.{json,txt}`: the same command on the booted non-Duo
  simulator: 1001, same feature id, different `NSLocalizedDescription`, no `DeviceIdentifier`; the
  stable key is `error.userInfo.CapabilityFeatureIdentifier.string`, not the localized text.
