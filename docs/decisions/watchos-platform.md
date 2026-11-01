# watchOS as its own platform, fail-closed per tool

Status: accepted for #14899 (part of the Apple Watch simulator epic #14895); extended to every
non-iOS Apple platform for #15886 (Apple TV epic #15884).

## Decision

An Apple Watch simulator is `platform: "watchos"`, a third member of `Platform`
(`src/models/Platform.ts`), not an iOS device with a family flag. The same rule covers every
non-iOS Apple platform (`NonIosApplePlatform`): an Apple TV simulator is `platform: "tvos"`, and
everything below that says "watch" applies to it unless a section names watchOS specifically.
`tvos` supports `listDevices`, `listDeviceImages`, `provisionDevice`, `deleteDevice`,
`startDevice`, `setActiveDevice`, `killDevice`, `installApp`, `uninstallApp`, `launchApp`,
`terminateApp` and `listApps`. Discovery and selection require an explicit
tvOS request. Boot uses simctl readiness and the simulator gate; start binds at `booted`
readiness without an automation runner, keyboard, biometric or prototype setup. A broker binding
never reuses a TV. Unlike watchOS,
`tvos` is advertised in tool input schemas ahead of support (see the schema rule below).

- **Fail closed at the tool boundary.** Every device-aware tool rejects a watch or an Apple TV with
  an `ActionableError` naming the platform (`<tool> does not support watchOS yet`, `<tool> does
  not support tvOS yet`) after device resolution and before
  navigation recording, mutation journaling, audits or the handler run. The gate is in the
  registry's shared device dispatch, so a newly registered tool is covered without any change.
- **One allowlist map.** `APPLE_PLATFORM_SUPPORTED_TOOLS` (`src/server/applePlatformToolSupport.ts`)
  maps each non-iOS Apple platform to the tools that opted in for it. A tool joins a platform only
  together with that platform's behaviour and tests.
  `test/server/applePlatformToolSupport.test.ts` registers every tool and, for each platform, drives each device-aware tool
  not on that platform's list through the registry with a device of that platform, asserting the
  rejection.
- **Platform branches decide explicitly.** Code that dispatches on platform narrows with
  `requireAndroidOrIosPlatform(platform, operation)` (throws for a watch) or
  `isAndroidOrIosPlatform` (skips a watch in background loops). A watch never falls through to an
  Android `else` or an iPhone branch. Maps from platform to an implementation are keyed by
  `AndroidOrIosPlatform`. Bookkeeping that only records a device's platform (bindings,
  reservations, sessions) holds the full `Platform`.
- **Schemas advertise watchOS only where it works; tvOS everywhere.** A tool's input `platform`
  enum lists `watchos` only when the tool supports a watch, so agents are not offered a watch value
  the tool rejects; such a tool gets its own enum. Every input `platform` enum lists `tvos`,
  including the shared `platformSchema` (owner decision 2026-10-31, #15886), so clients can name an
  Apple TV explicitly. Device-aware tools refuse a requested non-iOS Apple platform they
  have not opted in to before resolving a target (`assertRequestedPlatformSupported`), because
  resolution replaces the requested platform with a session's own, and refuse an unsupported
  resolved platform at the registry gate. Plain tools look up tvOS targets through their own
  platform-specific paths; unsupported plain tools refuse tvOS before lookup
  (`assertRequestNotTvos`). `provisionDevice` uses a per-platform union with platform-specific
  spec fields, including a tvOS branch. Output schemas list `tvos` only where they already list `watchos`.
- **Allowlisted app tools.** `installApp`, `uninstallApp`, `listApps`, `launchApp` and
  `terminateApp` route a watch to `WatchAppManager` (`simctl install|uninstall|listapps|launch|
  terminate` on the watch UDID) through their executor factories; Android and iOS keep their
  executors. `installApp` takes only a `.app` (bundle id from Info.plist; `upgrade` from a prior
  listing). Android-only options are refused by name; `uninstallApp` refuses `keepData: true`.
  `launchApp` reports a not-installed app without launching; `coldBoot` stops a running process
  first; `clearAppData` reuses the iOS simulator wipe (terminate, resolve the data container
  confined to the watch's device-set directory, remove Documents, Library and tmp), and a failed
  wipe launches nothing. `prototype: true` is refused before any agent preparation. A
  `terminateApp` whose process is already gone is a success with `wasRunning: false`.
- **Runner-backed watch observation and actions.** `observe` retains a simctl PNG. When an
  explicitly registered watch runner is connected, it also returns the hierarchy normalized
  through the iOS observation model; bounds and `screenSize` use XCTest points while
  `screenshotImageSize` uses physical pixels. Without a runner it returns the screenshot,
  physical `screenSize` and `hierarchyUnavailable`, with hierarchy fields absent. Advanced
  observe options (`waitFor`, `settled`, `raw`, `includeExtras`, `scope`, `layer`,
  `skipBackStack`, `crop`, `screenshotOptions`, `screenshot: "none"`, another display) are refused.
  `project` uses the existing full/skeleton rendering when connected and is refused otherwise.
  `tapOn` accepts an exact identifier or text, with optional index; an identifier is sent directly,
  otherwise the node center is tapped. Only wholly on-screen nodes qualify. `tapAt` accepts
  absolute XCTest points. `swipeOn` uses directional runner swipes and optionally searches for
  exact text/identifier, bounded by `maxSwipes` (default 10, maximum 100). Runner swipes have no
  host-controlled coordinates or duration. `pressButton` accepts home only. Other targeting,
  timed gestures, long press, double tap, focus, pinch, multi-touch and text input fail before
  runner commands.
- **Explicit runner ownership.** `XcodebuildWatchRunnerLauncher` takes a prebuilt xctestrun,
  watch UDID and reserved localhost port; it launches only the watch service test, forwards
  `TEST_RUNNER_AM_PORT`, and registers the device after a successful watchOS handshake and
  hierarchy read. Startup retries connection/readiness for a bounded budget. Process exit or
  the returned stop handle closes the client and removes the registration. After boot, before session
  binding, `startDevice` discovers a watchsimulator xctestrun in the configured CtrlProxy derived
  data, building the `CtrlProxyWatch` scheme with `build-for-testing` if absent.
  `AUTOMOBILE_WATCH_RUNNER_XCTESTRUN` selects an explicit prebuilt artifact. A per-launch copy
  injects `AM_PORT` for the allocated localhost port. The lifecycle owner reuses a registered
  runner and attaches its own runner to the newly bound session. It stops its own handle on
  device stop/deletion, session release/unbinding and daemon shutdown/exit. A failed or cancelled
  bind stops only a runner launched by that call. Missing artifacts or failed startup warn and
  leave readiness at `booted`, with
  the reason in the response message and screenshot-only observation available.
  The WebSocket client correlates request IDs and bounds
  handshake plus command time with the injectable timer, refusing non-watchOS handshakes.
- **Explicit resolution.** A watch session resolves through the pooled-session path (readiness
  setup and keep-awake are Android-only). A sessionless call reaches a watch only with
  `platform: "watchos"`: readiness then resolves a watch a fresh watchOS listing shows booted (by
  deviceId, else the connection's watch pin, else the only booted watch) and runs no verification,
  boot, CtrlProxy or settings step. A watch pin never decides a platform-less call.
  `setActiveDevice` selects a pooled watch only when the call names `"watchos"`.
- **Plain tools that look up a device themselves** (device management such as `killDevice`) are not
  behind the registry gate. They reach a watch only through watch inventory, so each decides
  watches explicitly. `startDevice` with `platform: "watchos"` takes an exact UDID or exact name
  only (every other option is refused), boots or adopts the watch under its stable lifecycle lease
  and prepares its automation runner before binding a pooled session at readiness `booted`. `killDevice`
  takes a watch through the same holder checks and stops it with `simctl shutdown`. Both resolve
  the target from the watch listing, so a non-watch UDID is refused before any simctl command.
  `provisionDevice` with `device.platform: "watchos"` (its own branch of the request union, so
  Android and iOS validation is unchanged) takes exact runtime and device-type identifiers from the
  watch catalog. Under a lifecycle lease on the name, rebound to the UDID once known, it adopts a
  watch whose name, UDID, device type and runtime all match, or creates one fresh with
  `simctl create` (never cloned; a named UDID is never created). With `boot` it boots and binds
  like `startDevice`, and a watch it created is deleted again if boot or bind fails. `resources`,
  `enableTools` and `readiness: "automation"` are refused; readiness defaults to `"none"`.
  `deleteDevice` with `target.platform: "watchos"` resolves the watch by UDID from the watch
  listing (absent means already deleted), applies killDevice's caller checks under the
  `deleteDevice` name, stops a running watch through killDevice before taking its teardown lease
  (killDevice's own lease would otherwise wait on it), then runs `simctl delete` and requires a
  fresh watch listing that no longer shows it.
- **Shared limits.** A watch is charged wherever a host limit counts devices: the broker's
  managed-device limit (`totalDeviceCap`) counts `watchos` bindings and running daemon-named
  watches in one total with Android and iOS devices, and a cold watch boot is admitted through the
  simulator boot gate.
- **Broker watch bindings.** A `watchos` binding holds one unpaired watch (never `simctl pair`, no
  companion iPhone). Its requested spec is provisionDevice's watch spec: exact `runtime` and
  `deviceType`, nothing else. The resolver checks it against the watch catalog before any native
  work (an unlisted runtime or device type is `spec_unsupported` naming the listed ones; a listed
  but unavailable runtime is `runtime_incompatible`; a host without simctl refuses it). The
  matcher compares runtime and device type only, never an AVD config or iOS form-factor inference.
  The reconciler creates an `ambroker-` watch through provisionDevice's watch path (fresh
  `simctl create`, never cloned), boots it through the simulator gate (a replacement reserves its
  slot against the old watch's UDID), and publishes it at readiness `booted` (provisionDevice's
  `none` / `device_ready`): the automation-readiness gate accepts that for `watchos` only. Between
  executions a watch follows the iOS binding policy: the release keeps it assigned and booted, and
  the next execution ends any leftover session and reuses it with a fresh one. A spec change
  replaces the watch; replacement,
  eviction and abandoned-binding cleanup delete it through the daemon's deleteDevice watch path
  (stop, `simctl delete`, then a fresh watch listing must not show it), and a failed delete
  leaves the binding `cleanup_pending`. Legacy slot rows never held watches, so legacy slot
  retirement refuses a watch target.
- **Session-broker watch requests.** A session request names a watch exactly:
  `{ schemaVersion: 1, platform: "watchos", spec: { runtime, deviceType } }`, the spec parsed by
  provisionDevice's watch schema. There are no host defaults, archetypes or OS predicates. Before
  anything is reserved, the request is checked against the session watch catalog (installed
  watchOS runtimes and Apple Watch device types from `WatchSimulatorInventory.readCatalog`): an
  unlisted device type is `unsupported_hardware`, an unlisted or unavailable runtime is
  `missing_installed_runtime`, each naming the available ones; a host without simctl reports the
  catalog `not-installed` (permanent `unsupported_hardware`), and an unreadable catalog is
  transient `catalog_unavailable`. The exact profile (`platform`, `metadataState`, `runtime`,
  `deviceType`) becomes the watch binding's requested spec, and a pooled watch is reused only for
  the same runtime and device type. A ready watch receipt adds `readiness: { mode: "none", status:
  "device_ready" }`; Android and iOS receipts carry no `readiness` field. A watch session binds no
  device-mutation recorder.
- **Watch release resets follow the iOS reuse mode.** `reuse.ios.mode` (and
  `reuseCleanDevices`) decide a released watch's fate as they do an iPhone's; the iOS idle TTL,
  reset-boot queue and wait-for-a-resetting-device admission apply to it too. `off`: destroyed. `erase`: the watch is stopped through
  killDevice, `simctl erase`d while shut down, booted again through the simulator boot gate and
  confirmed Booted with its exact runtime and device type; a redrive that finds it shut down
  erases it again. `keep-booted`: the iOS cleaning replays the session's mutation journal against
  a pool-entry app baseline and probes CtrlProxy health; a watch has none of these, so that step
  is skipped with `fallbackReason` `watchos-keep-booted-unsupported` and the configured fallback
  runs (`erase`: the watch erase, outcome `fallback:erase`; `destroy`: destroyed). `minimal`: its
  steps need the session's journaled app installs, and its appearance, content-size, pasteboard and
  Files-fixture steps have no watchOS equivalent; minimal never erases, so the watch is destroyed
  with `fallbackReason` `watchos-minimal-unsupported`. No pool-entry baseline is captured for a
  watch.
- **`"either"` keeps meaning Android or iOS.** Listing `scanned` flags carry a `watchos` entry;
  until watch inventory exists it is `false`, so a watch is never treated as a freshly listed
  device.

## Alternatives checked

| Alternative                                    | Why not                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform: "ios"` plus `deviceFamily: "watch"` | Every existing `platform === "ios"` branch would accept a watch unless someone remembers to check the family. That is the failure the physical device lister already guards against. |
| Gate each tool in its own handler              | A forgotten tool would silently drive a watch as an iPhone. One gate in the registry covers new tools by default.                                                                    |
| Add `"watchos"` to every tool schema enum now  | Advertises a value every tool rejects. Schemas widen per tool when it opts in.                                                                                                       |
