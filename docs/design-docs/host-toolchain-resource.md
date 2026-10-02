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
host state. Its CoreDevice diagnostic reads existing simulator state. Doctor and readiness gating remain separate
and are unaffected.

The `devicectl` entry's `coreDevice` payload reports `simulatorBootState` as
`{ status: "available", booted, shutdown, unknown }`, or `unavailable` with a
reason. Counts include transitional states as unknown and have fixed payload
size. A one-second cached/coalesced simctl listing bounds repeat reads; fresh
boot checks bypass this diagnostic cache and simctl's stale fallback.

`capabilities` contains `status` (`not probed` or `probed`) and at most 64
`entries`, each with simulator-type `scope`, `command`, `status` (`supported`
or `unsupported`), and `featureId` when captured. Success captures do not
contain a feature ID, so supported commands retain their command name. An
unobserved command is not probed. Unsupported feature IDs and learned command
links each use a 64-entry FIFO bound. Type/runtime scope prevents a non-Duo hinge
failure disabling a Duo; unknown types fall back to the device ID.

Reading this resource or running the CoreDevice doctor check performs the existing
bounded `devicectl --version` availability read every time. The measured result
seeds the injected process-owned probe, so a later `checkSimulatorCommand` reuses
it without a second version invocation. Concurrent version reads share an in-flight
invocation. Capability commands stay lazy: diagnostic reads never spawn them.
There is currently no production simulator command caller; the existing
simulator tools use simctl. No new tool is introduced.

The downgrade guard is out of scope per the owner decision on 2026-10-02 and is
not reported.
