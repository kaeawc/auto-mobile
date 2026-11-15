# Device resources

Device records use the shared `DeviceDescription` projection. In the canonical shape,
static facts such as `osVersion`, `runtimeId`, and `formFactor` are top-level, while live state
such as lifecycle, readiness, session, lock, and orientation is grouped under `runtime`.
There are no legacy aliases, and unknown facts are explicit `null` values. See
[the device-description audit](device-description-audit.md).

Tools and resources share configured-image enrichment. A booted virtual device retains
its configured `display`, `capabilityInventory`, `deviceType`, `runtimeId`, and Android
`image.{path,target,basedOn}` provenance when those facts are available. Physical devices and
virtual devices started outside AutoMobile keep unavailable image-only facts as `null`.
Only the existing Android keyguard probe populates `runtime.locked`; otherwise it is
`null`. The `runtime.orientation` field comes from a bounded live orientation probe (Android) and remains
`null` where no safe read signal exists (currently iOS).

Apple Watch simulators are `platform: "watchos"` ([decision](../devlog/2026-10-28-watchos-platform.md)).
`simctl list devices` returns them beside iPhone simulators, so the iOS simulator listing skips
watchOS runtimes and no iOS resource, tool or readiness path sees a watch. Watches, installed
watchOS runtimes and Apple Watch device types appear only in
`automobile:devices/images/watchos` (`watchosCount`, a `watchos` catalog and inventory
observation); the iOS provisioning catalog excludes them. Apple TV simulators are
`platform: "tvos"` and appear in `listDevices` only when `platform: "tvos"` is requested.
`listDeviceImages` with `platform: "tvos"` and `automobile:devices/images/tvos` list configured
Apple TV simulators. The resource includes `tvosCount`, a tvOS inventory observation, installed
tvOS runtimes and Apple TV device types, with runtime compatibility derived from each device
type's version bounds. A failed listing is incomplete inventory, never evidence of absence.
The iOS listing and provisioning catalog exclude Apple TVs. `automobile:devices/images` stays
Android and iOS.

Read-only Android inventory shares successful AVD-name and display probes, plus configured
AVD listings, for `ANDROID_INVENTORY_ENRICHMENT_TTL_MS` (2,500 ms). Device enrichment keys
include the serial and the ADB list observation; a fresh list or bypass cannot reuse a prior
emulator incarnation. Unknown names and failed display reads are not cached. Readiness and
destructive identity checks retain fresh probes. The running-state overlay reads names only.

Inventory reads have separate response budgets: `BOOTED_DEVICES_RESOURCE_BUDGET_MS`
(8,000 ms), `ANDROID_PROVISIONING_CATALOG_BUDGET_MS` (9,000 ms), and
`CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS` (2,000 ms) for `listDevices` image enrichment.
Android inventory device-list reads use `ANDROID_INVENTORY_DEVICE_LIST_BUDGET_MS`
(2,000 ms); existing per-device name/model and display probes remain bounded at 2,000 ms.
A five-emulator mixed-capture fixture bounds a sequential `listDevices` -> booted
resource -> images read at 25,000 ms, each response inside a 15,000 ms client
deadline (a deterministic FakeTimer bound, not a host performance guarantee).

On budget expiry, known devices/images remain in the response. The booted resource adds
`enrichment: { complete: false, pending: string[], retryable: true, retryAfterMs: 1000, reason }`,
omits unfinished enrichment, aborts its private pending probes, and does not cache this
incomplete result. `listDevices` adds
`enrichment: { complete: false, missing: ["configuredImages"], retryable: true, retryAfterMs: 1000 }`
when its configured-image fallback times out or fails. Images report `catalogComplete: false`
and `catalogObservations.android.error: { code: "timeout", message, retryable: true,
retryAfterMs: 1000, missing: ["catalog"] }`. The `missing` list also includes `"configuredInventory"`
if that stage has not finished, and its configured-inventory observation carries equivalent
retry hints. `retryAfterMs` suggests how long to wait before retrying, not when completion is
guaranteed.

A single images background fetch continues after the read deadline, bounded by
`ANDROID_INVENTORY_BACKGROUND_CAP_MS` (30,000 ms). Its completed stage is retained for
`ANDROID_INVENTORY_STAGE_TTL_MS` (2,500 ms), so a retry shortly after completion normally
returns the full catalog without starting new children. Provenance callers wait at most
2,000 ms while one shared fetch continues for at most `ANDROID_AVD_PROVENANCE_FETCH_CAP_MS`
(30,000 ms); success is retained until AVD lifecycle invalidation and failure cools down for
`ANDROID_AVD_PROVENANCE_FAILURE_COOLDOWN_MS` (5,000 ms). Invalidation and daemon shutdown
abort these shared children. A caller cancellation abandons only that caller's wait.

`runtime.serviceStatus`, when observed, carries the complete service diagnostic: installation,
enablement, running and compatibility flags; nullable installed and expected checksums; structured
runner `version`; and nullable `supportedCommandsComplete` / `supportedFeaturesComplete` flags.
The booted resource's top-level `serviceStatus` is a resource-specific diagnostic sibling, not a
`DeviceDescription` alias. Canonical top-level `formFactor` always uses `phone`, `tablet`,
`foldable`, `tv`, `watch`, `automotive`, `xr-headset`, `xr-glasses`, or `unknown`. Android derives
`tv`, `watch`, `automotive`, `xr-headset` and `xr-glasses` from the system-image tag (`android-tv`,
`android-wear`, `android-automotive`, `google-xr`, `ai-glasses`, ...) first, then the avdmanager
profile id, then geometry.

`DeviceResource` describes observed resource state for one device. Its `resources`
property is a JSON object keyed by logical resource name. `AndroidDeviceResource`
and `AppleDeviceResource` add platform-specific keys and preserve AutoMobile's
`android` and `ios` platform identifiers.

The generic base is a shared view and extension point; its default guarantees only
the common keys. Producers of complete platform reports use `AndroidDeviceResource`
or `AppleDeviceResource`. Consumers needing platform narrowing accept their union,
`AndroidDeviceResource | AppleDeviceResource`, rather than widening to the base.

Known map fields are declared explicitly so an unchecked `Record<string, ...>`
cannot stand in for a complete platform snapshot. Compile-only contract fixtures
run through the normal TypeScript gate. These types do not validate external JSON;
a future I/O boundary must validate incoming data before constructing a report.
The interfaces use structural typing: they require the known fields but do not
strip or reject additional properties on already-assembled objects.

This contract defines reporting semantics. `setDeviceResources` and the optional
`provisionDevice.resources` field accept a separate desired configuration and
return verification evidence. Requested configuration is never treated as
observed state.

Configuration and platform detail are on these pages:

- [Configuring resources, workload profiles and disabled iOS services](device-resources-configuring.md)
- [Automation capabilities, Android controls, snapshots, preflight and audio](device-resources-android.md)

## Resource groups

| Key                  | Platform | Scope                                                                                                         |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `backgroundSync`     | Both     | OS-scheduled app background refresh/sync, excluding the platform-specific cloud/account service groups below. |
| `searchIndexing`     | Both     | OS-maintained search indexes; excludes app-owned indexes.                                                     |
| `animations`         | Both     | System UI transition animations; excludes app-rendered animation.                                             |
| `wallpaperRendering` | Both     | System wallpaper rendering; excludes widgets and Live Activities.                                             |
| `widgets`            | Both     | App and system widget refresh; excludes wallpaper and Live Activities.                                        |
| `liveActivities`     | Both     | Live Activities and Dynamic Island updates; excludes wallpaper and widgets.                                   |
| `googlePlayServices` | Android  | Google Play services background infrastructure, including account sync and push; excludes the Play Store app. |
| `icloudSync`         | iOS      | OS-managed iCloud data synchronization, including photo sync; excludes app-owned networking.                  |
| `siriAndAppIntents`  | iOS      | Siri requests, Shortcuts actions, and App Intents.                                                            |
| `speechServices`     | iOS      | Speech recognition, dictation, and Siri speech synthesis.                                                     |
| `mediaTranscoding`   | iOS      | Photos image and video conversion.                                                                            |
| `photoAnalysis`      | iOS      | On-device analysis of the system photo library; excludes photo synchronization.                               |

Groups describe separate functions even when they share infrastructure (photo sync
is `icloudSync`, local analysis is `photoAnalysis`); changing one does not establish
the other's state. Native service names and commands stay inside platform
implementations.

## Observed state

Each concrete platform interface requires its core reporting keys, including on
physical devices or images without a particular service. Additional configurable
groups are optional in platform snapshots. Key presence does not promise support.

- `enabled`: verified active and available to run; need not be consuming CPU now.
- `disabled`: verified disabled to reduce resource use.
- `unsupported`: the device cannot provide or control the resource. The optional
  `reason` can explain which limitation applies.
- `unknown`: not verified. Also use this for mixed or incomplete group evidence,
  with an optional `reason` explaining the uncertainty.

A group is `enabled` or `disabled` only when evidence covers the whole defined
group. A single inactive process, absent observation, or requested setting is
insufficient. Each producer must define its evidence coverage for each OS and
device type; it must report `unknown` when that coverage is incomplete.

Desired provisioning configuration is separate from this snapshot. There is no
named mode or profile catalog: a workload profile is only a requested resource
map, identified by the content fingerprint of that map. Callers must not infer
that a requested reduction succeeded.

### Runtime producers

`DeviceResourceObserver` is an internal read-only producer of complete Android
emulator and iOS Simulator snapshots. It shares the controllers' native inventory
and state readers without issuing writes or creating restoration receipts, and
never derives observations from requested configuration. Every catalog target
must be verified for an enabled/disabled group. Mixed or partially absent evidence
is unknown, wholly absent or unapproved read paths are unsupported, and native
read failures are logged and reported as unknown. Physical devices currently
return complete unsupported snapshots with reasons. For iOS Simulators,
`reconcileDeviceResources` exposes a snapshot together with requested-versus-observed
drift (see [Reconciling workload profiles](device-resources-configuring.md#reconciling-workload-profiles)); device
listings and MCP resources do not include it.
