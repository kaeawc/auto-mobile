# Host toolchain resource

`automobile:host/toolchain` is a read-only diagnostic MCP resource. It reports
host-tool availability for `adb`, `emulator`, `sdkmanager`, `avdmanager`,
`xcodebuild`, `xcode-select`, `xcrun`, `simctl`, and `devicectl`.

Its JSON content has a `lastUpdated` ISO-8601 timestamp and an `entries` array.
Each entry has a canonical `name` and `available` boolean. `version` and
`location` are included when known; an unavailable entry includes `error` when
there is a specific probe failure.

`location` is reported only when the probe returned an absolute path (POSIX or
Windows drive-letter); a bare command name such as `adb` is omitted.

Every probe races the doctor check against `DOCTOR_EXEC_TIMEOUT_MS`. When the
deadline wins, the entry reports the timeout and the resource aborts the losing
check through the `DoctorProbeOptions` signal, so the commands it spawned (for
example `emulator -list-avds` or an `adb` path probe) are killed rather than
accumulating across repeated reads (#7008).

`version` and `location` are advisory information and must not gate automation.
`available` for `adb`, and for at least one Apple developer-tooling entry, is
an operational requirement for the corresponding AutoMobile device automation.
This resource itself is diagnostic only: it does not gate any tool call, change
host state, or enumerate devices. Doctor and readiness gating remain separate
and are unaffected.
