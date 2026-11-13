# watchOS as its own platform, fail-closed per tool

- Kind: decision
- Date: 2026-10-28
- Source: moved from docs/decisions/watchos-platform.md (added in #15773)
- Shaped: [Device resources](../how-it-works/device-resources.md), [Session broker device reuse, reset, and capacity](../how-it-works/session-broker-device-reuse.md), [Session device requirements](../how-it-works/session-requirements.md)

Status: accepted for #14899 (part of the Apple Watch simulator epic #14895); extended to every
non-iOS Apple platform for #15886 (Apple TV epic #15884) and to Apple Vision Pro for #16848
(visionOS epic #16857).

## Decision

An Apple Watch simulator is `platform: "watchos"`, a third member of `Platform`
(`src/models/Platform.ts`), not an iOS device with a family flag. The same rule covers every
non-iOS Apple platform (`NonIosApplePlatform`). An Apple TV simulator is `platform: "tvos"`, and
everything below that says "watch" applies to it unless a section names watchOS specifically.

The `tvos` platform supports `listDevices`, `listDeviceImages`, `provisionDevice`, `deleteDevice`,
`startDevice`, `setActiveDevice`, `killDevice`, `installApp`, `uninstallApp`, `launchApp`,
`terminateApp`, `listApps`, `observe`, `tapOn`, `pressButton`, `openLink`, `getDeepLinks`,
`videoRecording` and `compareScreenshot`. Discovery and selection require an explicit
tvOS request. Boot uses simctl readiness and the simulator gate; start binds at `booted`
readiness after best-effort tvOS runner startup, without iOS keyboard, biometric or prototype setup.

The tvOS runner uses `request_hierarchy` through the iOS hierarchy converter, preserving focus
in the hierarchy and existing `focusedElement` output. The `pressButton` tool sends remote
up/down/left/right, select, menu, home and playPause. The `tapOn` tool matches visible exact text
or element identifiers with an optional index, moves focus using frame centres and re-observes
after each remote press before selecting. It accepts only the tap action; absent matches or focus,
blocked directions and a 30-move limit fail with actionable guidance. Press replies synchronize
navigation without sleeps. Touch gestures are refused with focus-navigation guidance;
long press and text input are unsupported. A tvOS handshake is required before registration.

`AUTOMOBILE_TVOS_RUNNER_XCTESTRUN` overrides artifact discovery; otherwise `TvosRunnerArtifacts`
uses local appletvsimulator products, then `TvosRunnerReleaseProvider` (a
`SimulatorRunnerReleaseProvider`), then builds the
`AutoMobileTVTest` scheme with a 120-second limit. The provider verifies the pinned
`tvos-runner-macos.zip` checksum before worker extraction, stages `Build/Products` in a secure
cache, and publishes by rename. Cache reuse requires a matching metadata SHA and an existing
template xctestrun; launch copies prefixed `automobile-runner-` are ignored. Empty pins
disable release downloads. Installed packages need no source checkout when a pinned runner is
available; absent both the release and source project, startup explains the override.

Startup uses the tvOS destination and an isolated xctestrun with `AM_PORT`; runner ownership,
release, shutdown and deletion follow the watch lifecycle. Connected observations use runner
screenshots, while observations without a runner retain the simctl screenshot-only fallback.
The `videoRecording` tool captures through the iOS simulator `simctl io recordVideo` path on
simctl's default display (`VideoRecordingPlatform`; rows store `tvos`); audio is refused. The
`compareScreenshot` tool uses the same screenshot source. Without a runner it has no point
geometry, so it compares only the full screenshot and refuses regions, and a tvOS profile is keyed
by screenshot size alone. A broker binding never reuses a TV. Unlike watchOS,
`tvos` is advertised in tool input schemas ahead of support (see the schema rule below).

An Apple Vision Pro simulator is `platform: "visionos"` (owner decision 2026-11-04, #16848), under
the same fail-closed rules. Its allowlist starts with the device lifecycle tools only
(`listDevices`, `listDeviceImages`, `provisionDevice`, `deleteDevice`, `startDevice`,
`setActiveDevice`, `killDevice`); every other tool joins once verified on a Vision Pro simulator.
No input schema names `visionos` and no inventory discovers one until the simctl lifecycle lands
(#16849). Sweeps, discovery sources and the device-image catalog report it unscanned or
unavailable, and a broker binding never reuses one.

- **Fail closed at the tool boundary.** Every device-aware tool rejects a watch or an Apple TV with
  an `ActionableError` naming the platform after device resolution and before navigation
  recording, mutation journaling, audits or the handler run. The messages are `<tool> does not
  support watchOS yet` and `<tool> does not support tvOS yet`, or `<tool> is not available on
  tvOS` for a capability the tvOS simulator runtime itself lacks, such as the status bar or
  pasteboard. The gate is in the registry's shared device dispatch, so a newly registered tool is
  covered without any change.
- **One allowlist map.** `APPLE_PLATFORM_SUPPORTED_TOOLS` (`src/server/applePlatformToolSupport.ts`)
  maps each non-iOS Apple platform to the tools that opted in for it. A tool joins a platform only
  together with that platform's behaviour and tests. The test
  `test/server/applePlatformToolSupport.test.ts` registers every tool. For each platform, it drives
  each device-aware tool not on that platform's list through the registry with a device of that
  platform, asserting the rejection.
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
  resolution replaces the requested platform with a session's own. They also refuse an unsupported
  resolved platform at the registry gate.

  Plain tools look up tvOS targets through their own
  platform-specific paths; unsupported plain tools refuse tvOS before lookup
  (`assertRequestNotTvos`). The `provisionDevice` tool uses a per-platform union with
  platform-specific spec fields, including a tvOS branch. Output schemas list non-iOS Apple
  platforms only for tools that support them.

- **Allowlisted app tools.** The `installApp`, `uninstallApp`, `listApps`, `launchApp` and
  `terminateApp` tools route a watch to `WatchAppManager` (`simctl install|uninstall|listapps|launch|
  terminate` on the watch UDID) through their executor factories; Android and iOS keep their
  executors. The `installApp` tool takes only a `.app` (bundle id from Info.plist; `upgrade` from a
  prior listing). Android-only options are refused by name, and `uninstallApp` refuses
  `keepData: true`. The `launchApp` tool reports a not-installed app without launching, and
  `coldBoot` stops a running process first. The `clearAppData` option reuses the iOS simulator wipe
  (terminate, resolve the data container confined to the watch's device-set directory, remove
  Documents, Library and tmp), and a failed wipe launches nothing. The `prototype: true` option is
  refused before any agent preparation. A `terminateApp` whose process is already gone is a success
  with `wasRunning: false`.
- **Watch, TV and Vision Pro logs.** The `getLogs` tool reuses the iOS simulator unified-log path
  (`simctl spawn <udid> log show` with the app's subsystem and process predicate) for a watch,
  Apple TV or Vision Pro UDID. No Apple platform is read as logcat.
- **Watch and TV crashes.** The `crashApp` tool reuses the iOS simulator launchctl SIGABRT path and
  host DiagnosticReports `.ips` lookup for the watch or Apple TV UDID. It signals the app's service
  in the `system` launchd domain (neither simulator has a `user/<uid>` domain). The result retains
  `platform: "watchos"` or `"tvos"`; mechanism and evidence source names use the shared iOS backend
  vocabulary.
- **Watch notifications.** `postNotification` delivers an APNs payload via `simctl push` to the watch simulator UDID and requires the watch app bundle ID as `appId`.
- **Runner-backed watch observation and actions.** The `observe` tool retains a simctl PNG. When an
  explicitly registered watch runner is connected, it also returns the hierarchy normalized
  through the iOS observation model; bounds and `screenSize` use XCTest points while
  `screenshotImageSize` uses physical pixels. The runner snapshots its app only while it is
  foreground; otherwise `app_not_foreground` produces the screenshot-only observation rather
  than a retained app hierarchy. Without a runner it returns the screenshot,
  physical `screenSize` and `hierarchyUnavailable`, with hierarchy fields absent. Advanced
  observe options (`waitFor`, `settled`, `raw`, `includeExtras`, `scope`, `layer`,
  `skipBackStack`, `crop`, `screenshotOptions`, `screenshot: "none"`, another display) are refused.
  The `project` option uses the existing full/skeleton rendering when connected and is refused
  otherwise.

  The `tapOn` tool accepts an exact identifier or text, with optional index. It sends an identifier
  directly and otherwise taps the node center. Only wholly on-screen nodes qualify. The `tapAt`
  tool accepts absolute XCTest points. The `swipeOn` tool uses directional runner swipes and
  optionally searches for exact text/identifier, bounded by `maxSwipes` (default 10, maximum 100).
  Runner swipes have no host-controlled coordinates or duration. The `pressButton` tool accepts
  home only. Other targeting, timed gestures, long press, double tap, focus, pinch, multi-touch and
  text input fail before runner commands.

- **Explicit runner ownership.** `XcodebuildWatchRunnerLauncher` takes a prebuilt xctestrun,
  watch UDID and reserved localhost port; it launches only the watch service test, forwards
  `TEST_RUNNER_AM_PORT`, and registers the device after a successful watchOS handshake and
  hierarchy read. Startup retries connection/readiness for a bounded budget. Process exit or
  the returned stop handle closes the client and removes the registration. After boot, before
  session binding, `startDevice` discovers a watchsimulator xctestrun in the configured CtrlProxy
  derived data. Then it asks `WatchRunnerReleaseProvider` for the release's pinned
  `watchos-runner-macos.zip`, and builds the `CtrlProxyWatch` scheme with `build-for-testing` only
  when both are absent.

  The provider shares `SimulatorRunnerReleaseProvider` with tvOS and visionOS. It verifies before
  extraction, uses a SHA-keyed secure cache and fails closed on a mismatch. It falls through to the
  source build only when the download itself fails or the release pins no checksum. The lookup
  searches for the project under `AUTOMOBILE_PROJECT_ROOT` (default: process working directory),
  then the daemon launch directory, then the running AutoMobile package root, because the detached
  daemon runs in the home directory. When none has it, the error lists every path checked. The
  `AUTOMOBILE_WATCH_RUNNER_XCTESTRUN` variable selects an explicit prebuilt artifact. A per-launch
  copy injects `AM_PORT` for the allocated localhost port.

  The lifecycle owner reuses a registered
  runner and attaches its own runner to the newly bound session. It stops its own handle on
  device stop/deletion, session release/unbinding and daemon shutdown/exit. A failed or cancelled
  bind stops only a runner launched by that call. Missing artifacts or failed startup warn and
  leave readiness at `booted`, with
  the reason in the response message and screenshot-only observation available.
  The WebSocket client correlates request IDs and bounds
  handshake plus command time with the injectable timer, refusing non-watchOS handshakes.

- **Explicit resolution.** A watch session resolves through the pooled-session path (readiness
  setup and keep-awake are Android-only). A sessionless call reaches a watch only with
  `platform: "watchos"`. Readiness then resolves a watch a fresh watchOS listing shows booted (by
  deviceId, else the connection's watch pin, else the only booted watch) and runs no verification,
  boot, CtrlProxy or settings step. A watch pin never decides a platform-less call.
  `setActiveDevice` selects a pooled watch only when the call names `"watchos"`.
- **Plain tools that look up a device themselves** (device management such as `killDevice`) are not
  behind the registry gate. They reach a watch only through watch inventory, so each decides
  watches explicitly. With `platform: "watchos"`, `startDevice` takes an exact UDID or exact name
  only and refuses every other option. It boots or adopts the watch under its stable lifecycle lease
  and prepares its automation runner before binding a pooled session at readiness `booted`. The
  `killDevice` tool takes a watch through the same holder checks and stops it with `simctl shutdown`.
  Both resolve the target from the watch listing, so they refuse a non-watch UDID before any simctl
  command.

  With `device.platform: "watchos"`, `provisionDevice` takes exact runtime and device-type
  identifiers from the watch catalog. This is its own branch of the request union, so Android and
  iOS validation is unchanged. Under a lifecycle lease on the name, rebound to the UDID once known,
  it adopts a watch whose name, UDID, device type and runtime all match. Otherwise it creates one
  fresh with `simctl create` (never cloned; a named UDID is never created). With `boot` it boots and
  binds like `startDevice`, and it deletes a watch it created again if boot or bind fails. It
  refuses `resources`, `enableTools` and `readiness: "automation"`; readiness defaults to `"none"`.

  With `target.platform: "watchos"`, `deleteDevice` resolves the watch by UDID from the watch
  listing (absent means already deleted) and applies `killDevice`'s caller checks under the
  `deleteDevice` name. It stops a running watch through `killDevice` before taking its teardown
  lease (`killDevice`'s own lease would otherwise wait on it). It then runs `simctl delete` and
  requires a fresh watch listing that no longer shows it.

- **Shared limits.** A watch is charged wherever a host limit counts devices. The broker's
  managed-device limit (`totalDeviceCap`) counts `watchos` bindings and running daemon-named
  watches in one total with Android and iOS devices, and the simulator boot gate admits a cold
  watch boot.
- **Broker watch bindings.** A `watchos` binding holds one unpaired watch (never `simctl pair`, no
  companion iPhone). Its requested spec is `provisionDevice`'s watch spec: exact `runtime` and
  `deviceType`, nothing else. The resolver checks it against the watch catalog before any native
  work. An unlisted runtime or device type is `spec_unsupported` naming the listed ones; a listed
  but unavailable runtime is `runtime_incompatible`; a host without simctl refuses it. The
  matcher compares runtime and device type only, never an AVD config or iOS form-factor inference.
  The reconciler creates an `ambroker-` watch through `provisionDevice`'s watch path (fresh
  `simctl create`, never cloned). It boots it through the simulator gate (a replacement reserves
  its slot against the old watch's UDID) and publishes it at readiness `booted` (`provisionDevice`'s
  `none` / `device_ready`). The automation-readiness gate accepts that for `watchos` only.

  Between executions a watch follows the iOS binding policy: the release keeps it assigned and
  booted, and the next execution ends any leftover session and reuses it with a fresh one. A spec
  change replaces the watch. Replacement, eviction and abandoned-binding cleanup delete it through
  the daemon's `deleteDevice` watch path (stop, `simctl delete`, then a fresh watch listing must not
  show it). A failed delete leaves the binding `cleanup_pending`. Legacy slot rows never held
  watches, so legacy slot retirement refuses a watch target.

- **Session-broker watch requests.** A session request names a watch exactly:
  `{ schemaVersion: 1, platform: "watchos", spec: { runtime, deviceType } }`, the spec parsed by
  `provisionDevice`'s watch schema. There are no host defaults, archetypes or OS predicates. Before
  anything is reserved, the broker checks the request against the session watch catalog (installed
  watchOS runtimes and Apple Watch device types from `WatchSimulatorInventory.readCatalog`). An
  unlisted device type is `unsupported_hardware`, and an unlisted or unavailable runtime is
  `missing_installed_runtime`, each naming the available ones. A host without simctl reports the
  catalog `not-installed` (permanent `unsupported_hardware`), and an unreadable catalog is
  transient `catalog_unavailable`. The exact profile (`platform`, `metadataState`, `runtime`,
  `deviceType`) becomes the watch binding's requested spec, and a pooled watch is reused only for
  the same runtime and device type. A ready watch receipt adds `readiness: { mode: "none", status:
  "device_ready" }`; Android and iOS receipts carry no `readiness` field. A watch session binds no
  device-mutation recorder.
- **Watch release resets follow the iOS reuse mode.** The `reuse.ios.mode` setting (and
  `reuseCleanDevices`) decides a released watch's fate as it does an iPhone's. The iOS idle TTL,
  reset-boot queue and wait-for-a-resetting-device admission apply to it too. No pool-entry
  baseline is captured for a watch.
  - `off`: destroyed.
  - `erase`: the reset stops the watch through `killDevice`, runs `simctl erase` while it is shut
    down, boots it again through the simulator boot gate and confirms it Booted with its exact
    runtime and device type. A redrive that finds it shut down erases it again.
  - `keep-booted`: the iOS cleaning replays the session's mutation journal against a pool-entry app
    baseline and probes CtrlProxy health. A watch has none of these, so the reset skips that step
    with `fallbackReason` `watchos-keep-booted-unsupported` and runs the configured fallback
    (`erase`: the watch erase, outcome `fallback:erase`; `destroy`: destroyed).
  - `minimal`: its steps need the session's journaled app installs, and its appearance,
    content-size, pasteboard and Files-fixture steps have no watchOS equivalent. Minimal never
    erases, so the watch is destroyed with `fallbackReason` `watchos-minimal-unsupported`.
- **`"either"` keeps meaning Android or iOS.** Listing `scanned` flags carry a `watchos` entry;
  until watch inventory exists it is `false`, so a watch is never treated as a freshly listed
  device.

## Alternatives checked

| Alternative                                    | Why not                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform: "ios"` plus `deviceFamily: "watch"` | Every existing `platform === "ios"` branch would accept a watch unless someone remembers to check the family. That is the failure the physical device lister already guards against. |
| Gate each tool in its own handler              | A forgotten tool would silently drive a watch as an iPhone. One gate in the registry covers new tools by default.                                                                    |
| Add `"watchos"` to every tool schema enum now  | Advertises a value every tool rejects. Schemas widen per tool when it opts in.                                                                                                       |
