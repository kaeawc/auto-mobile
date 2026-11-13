# Apple simulator sessions

This page covers device ownership rules specific to Apple simulators. For the
general rules, see [Device ownership](device-ownership.md).

- **Apple TV:** see [Apple TV simulators](apple-tv.md).
- **Apple Vision Pro:** see [Apple Vision Pro simulator](visionos-simulator.md).
  Name `platform: "visionos"` or a Vision Pro session. `installApp`,
  `uninstallApp`, `launchApp`, `terminateApp` and `listApps` work; `launchApp`
  refuses `prototype: true`. With the runner active, `observe` includes
  ornaments, and `tapOn` taps an element by a unique accessibility identifier.
- **Apple Watch:** see [Apple Watch simulators](apple-watch.md) and the session
  rules below.

## Apple Watch sessions

A call reaches a watch only by naming it: `platform: "watchos"`, or the
`sessionUuid` of a watch session. A call without a platform never lands on a
watch, even after one was selected.

- `setActiveDevice` selects a watch only with `platform: "watchos"`; a bare
  watch `deviceId` is not found. With a `sessionUuid` it binds the watch to that
  session. Otherwise it makes the watch the connection's active watch, which only
  calls naming `platform: "watchos"` use.
- `startDevice` with `platform: "watchos"` boots the watch, starts its runner,
  then binds a session. If the session ends before runner startup completes, the
  call fails; retry `startDevice`. A second start reuses a connected runner.
  Ending the owning session or stopping the daemon also stops the runner.
- `launchApp` on a watch returns the app's `pid` and refuses `intent`,
  `activityName`, `userId` and `prototype: true`. An app that is not installed
  fails with `App is not installed`.
- `installApp` refuses `.ipa`, `.apk` and the Android-only options by name.
- `provisionDevice` refuses a near match, an unknown identifier, or a `deviceId`
  that names no watch. With `boot` (the default) it returns a `sessionId`. If booting a watch it created fails, it deletes the watch
  again. `readiness` is always `"none"`.
- Unsupported device tools refuse a watch with
  `<tool> does not support watchOS yet`.

A session request (`--session-config` / `AUTOMOBILE_SESSION_CONFIG`) asks for a
watch with `device: { "schemaVersion": 1, "platform": "watchos", "spec": {
"runtime": "...", "deviceType": "..." } }`. Use the exact watchOS runtime and
Apple Watch device type identifiers, as for `provisionDevice`. A watch counts
against the same device limit as every other device.

| Result                                                                  | When                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `readiness: { "mode": "none", "status": "device_ready" }` and `profile` | Ready: the watch is booted, with no automation runner                    |
| `unsupported_hardware`                                                  | Unknown device type (names the available ones), or the host is not a Mac |
| `missing_installed_runtime`                                             | Unknown or unavailable runtime; names the available ones                 |
| `catalog_unavailable` (retryable)                                       | The simulator catalog is unreadable                                      |

On release, the host's iOS reuse mode decides what happens to the watch:

| Reuse mode        | On release                                                                       |
| ----------------- | -------------------------------------------------------------------------------- |
| `erase`           | Erases and reboots it for the next request with the same runtime and device type |
| `keep-booted`     | Erases it, or destroys it when its fallback is `destroy`                         |
| `minimal` or none | Deletes it                                                                       |
