# Host toolchain resource

`automobile:host/toolchain` is a read-only diagnostic MCP resource. It reports
host-tool availability for `adb`, `emulator`, `sdkmanager`, `avdmanager`,
`xcodebuild`, `xcode-select`, `xcrun`, `simctl`, and `devicectl`.

Its JSON content has a `lastUpdated` ISO-8601 timestamp and an `entries` array.
Each entry has a canonical `name` and `available` boolean. `version` and
`location` are included when known; an unavailable entry includes `error` when
there is a specific probe failure.

`version` and `location` are advisory information and must not gate automation.
`available` for `adb`, and for at least one Apple developer-tooling entry, is
an operational requirement for the corresponding AutoMobile device automation.
This resource itself is diagnostic only: it does not gate any tool call, change
host state, or enumerate devices. Doctor and readiness gating remain separate
and are unaffected.
