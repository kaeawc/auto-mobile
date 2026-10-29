# watchOS as its own platform, fail-closed per tool

Status: accepted for #14899 (part of the Apple Watch simulator epic #14895).

## Decision

An Apple Watch simulator is `platform: "watchos"`, a third member of `Platform`
(`src/models/Platform.ts`), not an iOS device with a family flag.

- **Fail closed at the tool boundary.** Every device-aware tool rejects a watch with an
  `ActionableError` (`<tool> does not support watchOS yet`) after device resolution and before
  navigation recording, mutation journaling, audits or the handler run. The gate is in the
  registry's shared device dispatch, so a newly registered tool is covered without any change.
- **One allowlist.** `WATCHOS_SUPPORTED_TOOLS` (`src/server/watchOsToolSupport.ts`) names the tools
  that opted in. A tool joins it only together with its watchOS behaviour and tests.
  `test/server/watchOsToolSupport.test.ts` registers every tool and drives each device-aware tool
  not on the list through the registry with a watch device, asserting the rejection.
- **Platform branches decide explicitly.** Code that dispatches on platform narrows with
  `requireAndroidOrIosPlatform(platform, operation)` (throws for a watch) or
  `isAndroidOrIosPlatform` (skips a watch in background loops). A watch never falls through to an
  Android `else` or an iPhone branch. Maps from platform to an implementation are keyed by
  `AndroidOrIosPlatform`. Bookkeeping that only records a device's platform (bindings,
  reservations, sessions) holds the full `Platform`.
- **Schemas advertise watchOS only where it works.** MCP tool input and output schemas keep
  `["android", "ios"]` until a tool supports watchOS, so agents are not offered a value the tool
  rejects. A tool that opts in gets its own platform enum (the shared `platformSchema` stays
  Android/iOS).
- **Allowlisted app tools.** `installApp`, `uninstallApp` and `listApps` route a watch to
  `WatchAppManager` (`simctl install|uninstall|listapps` on the watch UDID) through their executor
  factories; Android and iOS keep their executors. `installApp` takes only a `.app` (bundle id from
  Info.plist; `upgrade` from a prior listing) and refuses Android-only options by name;
  `uninstallApp` refuses `keepData: true`.
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
  and binds a pooled session at readiness `booted`; no automation runner step runs. `killDevice`
  takes a watch through the same holder checks and stops it with `simctl shutdown`. Both resolve
  the target from the watch listing, so a non-watch UDID is refused before any simctl command.
- **`"either"` keeps meaning Android or iOS.** Listing `scanned` flags carry a `watchos` entry;
  until watch inventory exists it is `false`, so a watch is never treated as a freshly listed
  device.

## Alternatives checked

| Alternative                                    | Why not                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform: "ios"` plus `deviceFamily: "watch"` | Every existing `platform === "ios"` branch would accept a watch unless someone remembers to check the family. That is the failure the physical device lister already guards against. |
| Gate each tool in its own handler              | A forgotten tool would silently drive a watch as an iPhone. One gate in the registry covers new tools by default.                                                                    |
| Add `"watchos"` to every tool schema enum now  | Advertises a value every tool rejects. Schemas widen per tool when it opts in.                                                                                                       |
