# Device resources

Device records use the shared `DeviceDescription` projection. In the canonical shape,
static facts such as `osVersion`, `runtimeId`, and `formFactor` are top-level, while live state
such as lifecycle, readiness, session, lock, and orientation is grouped under `runtime`.
Legacy aliases were removed in phase 3, and unknown facts are explicit `null` values. See
[the device-description audit](device-description-audit.md).

Configured-image enrichment is shared by tools and resources. A booted virtual device retains
its configured `display`, `capabilityInventory`, `deviceType`, `runtimeId`, and Android
`image.{path,target,basedOn}` provenance when those facts are available. Physical devices and
virtual devices started outside AutoMobile keep unavailable image-only facts as `null`.
`runtime.locked` is populated only by the existing Android keyguard probe; otherwise it is
`null`. `runtime.orientation` comes from a bounded live orientation probe (Android) and remains
`null` where no safe read signal exists (currently iOS).

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
The five-emulator mixed-capture fixture verifies a sequential `listDevices` → booted resource
→ images resource bound of 25,000 ms, with every individual response before a 15,000 ms
client deadline. The review-fix run completes in 23,200 FakeTimer ms (6,200 ms for
`listDevices`, 8,000 ms for the booted resource, 9,000 ms for images). This is a
deterministic workload bound, not a host performance guarantee.

On budget expiry, known devices/images remain in the response. The booted resource adds
`enrichment: { complete: false, pending: string[], retryable: true, retryAfterMs: 1000, reason }`,
omits unfinished enrichment, aborts its private pending probes, and does not cache this
incomplete result. `listDevices` adds
`enrichment: { complete: false, missing: ["configuredImages"], retryable: true, retryAfterMs: 1000 }`
when its configured-image fallback times out or fails. Images report `catalogComplete: false`
and `catalogObservations.android.error: { code: "timeout", message, retryable: true,
retryAfterMs: 1000, missing: ["catalog"] }`; `missing` also includes `"configuredInventory"`
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
`foldable`, or `unknown`.

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
| `photoAnalysis`      | iOS      | On-device analysis of the system photo library; excludes photo synchronization.                               |

The groups describe separate functions even when they share infrastructure. For
example, photo sync belongs to `icloudSync`, while local photo analysis belongs to
`photoAnalysis`. Common background scheduling and platform-specific account
services may share dependencies; changing one does not establish the other's state.
Native service names and commands stay inside platform implementations.

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
must be verified for an enabled/disabled group; mixed or partially absent evidence
is unknown, wholly absent or unapproved read paths are unsupported, and native
read failures are logged and reported as unknown. Physical devices currently
return complete unsupported snapshots with reasons. For iOS Simulators,
`reconcileDeviceResources` exposes a snapshot together with requested-versus-observed
drift (see [Reconciling workload profiles](#reconciling-workload-profiles)); device
listings and MCP resources do not include it.

## Configuring resources

`setDeviceResources` is disabled by default. Enable it for the MCP session with
`setToolEnabled` using `{"toolName":"setDeviceResources","enabled":true}`, or
start AutoMobile with `--enable-tool setDeviceResources`. Tool names are
case-sensitive. The optional `provisionDevice.resources` field does not require
enabling the standalone tool.

Both tools accept the same partial map of resource names to `enabled` or
`disabled`. Omitted entries remain untouched; an empty map, raw service names,
unknown keys, and profile names are rejected. Ordinary provisioning without
`resources` preserves existing behavior.

```json
{
  "resources": {
    "wallpaperRendering": "disabled",
    "widgets": "enabled",
    "liveActivities": "enabled",
    "healthServices": "disabled",
    "fitnessServices": "disabled"
  }
}
```

Pass this map to `setDeviceResources` with the usual session/device targeting,
or add it alongside `device` in `provisionDevice`. Provisioning requires
`boot: true` when resources are supplied and applies settings before automation
readiness. Every provision call runs its own lifecycle, so a retry re-reads and
reconciles resource state.

`setDeviceResources.timeoutMs` defaults to 300,000 milliseconds for requests
that configure many services. Provisioning uses its existing shared deadline
for creation, boot, resource configuration, and automation readiness.
Within that deadline, resource configuration reserves time for readiness and
session binding. It cannot consume the whole remaining provisioning budget.

The iOS Simulator implementation controls narrow, disjoint service groups.
Wallpaper, widgets, and Live Activities are three independent controls: disabling
wallpaper never disables widget updates or Live Activities. No resource is disabled
by default. Settings can affect optional system features; they are choices for the
test workload, not a claim that every app remains fully functional with every
resource disabled.

| Controls                                                                   | Scope and tradeoff                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallpaperRendering`, `widgets`, `liveActivities`                          | Separate wallpaper rendering, widget refresh, and Live Activity updates. App widgets need `widgets` enabled.                                                                                                                     |
| `healthServices`, `homeServices`, `fitnessServices`                        | HealthKit/Health, HomeKit, and Fitness background services. Apps using those integrations need them enabled.                                                                                                                     |
| `familyServices`, `screenTime`                                             | Family approvals/parental controls and Screen Time/usage tracking. Keep enabled for restriction tests.                                                                                                                           |
| `newsServices`, `weatherServices`, `tipsServices`, `gameServices`          | Apple content apps and Game Center/save sync; controller input remains untouched.                                                                                                                                                |
| `mapsSync`                                                                 | Maps synchronization and suggested destinations; MapKit rendering and general location services remain untouched.                                                                                                                |
| `advertising`, `diagnosticReporting`                                       | Promoted Apple content and selected diagnostic reporting. Ad privacy, DeviceCheck, setup state, and feature configuration remain untouched. Disabling reporting reduces diagnostic evidence.                                     |
| `photoAnalysis`                                                            | Only background Photos analysis. Library access, cloud transfers, and shared media-analysis services remain untouched. Photo search and recognition can degrade.                                                                 |
| `assistantSuggestions`, `appleIntelligence`                                | Selected Siri suggestion and Apple Intelligence background services. Speech, system voices, shared language/model services, and runtime-gated intelligence workflows remain untouched. System intelligence features may degrade. |
| `searchIndexing`                                                           | System search and app-provided Spotlight indexes; excludes an app's own search service. Settings/Spotlight search may fail.                                                                                                      |
| `appStoreServices`, `appleMediaSync`                                       | App Store installation/update services and Apple media-library/subscription services; push, generic audio/video transport, and StoreKit payment daemons remain untouched by these controls.                                      |
| `mailServices`, `calendarServices`, `reminderServices`, `personalDataSync` | Local Mail, Calendar, Reminders, and Exchange/CalDAV/CardDAV sync. Local Contacts access remains untouched. These are separate from apps' server-side calendars and reminders.                                                   |
| `safariSync`, `icloudSettingsSync`                                         | Safari history/bookmark sync and selected system-settings sync/storage recommendations. Associated domains, shared credentials, browsing protection, Apple accounts, CloudKit, Drive, and Photos transfers remain untouched.     |
| `messagingMaintenance`                                                     | Apple Messages history cleanup/attachment transfer and FaceTime message storage; database XPC helpers, identity, CallKit, and VoIP infrastructure remain untouched.                                                              |
| `watchConnectivity`, `carPlay`, `tvRemote`, `findMy`, `continuity`         | Separate companion/device services. Continuity affects cross-device workflows; system share sheets, keyboard stickers, and avatars remain untouched.                                                                             |
| `walletServices`, `businessServices`                                       | Wallet/payment/digital-identity services and Apple business messaging. Disabling Wallet can also prevent dependent StoreKit payment sheets; keep it enabled for payment tests.                                                   |

App-hosted XPC helpers and the runtime-gated intelligence workflow engine remain
under OS control; these are not standalone service definitions to force-load.

The shared schema is defined by `src/models/deviceResourceDescriptions.ts`; native
labels are scoped in `src/utils/iosDeviceResourceCatalog.ts`. Callers cannot supply
raw launchd labels, shell commands, or arbitrary service paths. Every group is
preflighted against the exact booted runtime before writing. Missing labels are
reported individually and excluded from that runtime's group; a group with no
installed services is unsupported. A mismatched, default-disabled, or conditional
definition makes the whole group unsupported without mutations. Native read
failures are unknown, not evidence that a service is absent.

For compatible definitions the controller changes the launchd override, unloads
or restores the exact job without rebooting, then verifies both the override and
job registration. Runtime discovery is shared within a request. Group membership
does not overlap, so enabling one resource cannot silently restore another.

Every native command is argv-based and bounded by both the request deadline and
`IOS_RESOURCE_COMMAND_TIMEOUT_MS` (30,000 ms). Idempotent inventory and
`launchctl print-disabled` reads retry at most twice with a 100/400 ms backoff when
the deadline allows; writes are never retried, because the post-write verification
re-reads state and a retry of the whole request reconciles any partial change.
Resource operations hold the device's lifecycle lease, so they serialize per device
with boot, shutdown, teardown and other configuration, and the device-aware tool
path enforces session ownership.

Broad `backgroundSync` and `icloudSync` remain unsupported. Physical iOS devices
remain unsupported. Android controls are described below; requests can apply
supported entries and report unsupported entries in the same result.

After mutation, `setDeviceResources` and `provisionDevice.resources` also return
an independent `observed` platform snapshot alongside `requested`. This read-only
snapshot covers the full platform resource map, including unrequested groups;
missing read paths report `unsupported` with a reason, and failed reads report
`unknown`. The existing `resources`, `services`, `changed`, `verification`, and
`restore` mutation evidence is preserved. An explicitly opposite enabled/disabled
observation sets `success: false` and lists the resource names in
`observationContradictions`; unknown/unsupported observations do not add failures.
Observation uses the mutation's same deadline and abort signal, including the
readiness reserve during provisioning and fresh observation on a repeated call. A non-abort
observation failure is logged and omits `observed`, preserving mutation results;
cancellation still propagates through the existing tool failure handling.

Results contain `requested`, a `resources` map of observed states for requested
entries, `services` with per-daemon evidence, `changed` (resource groups with
acknowledged native writes), `verification: "current_boot"`,
and `success`. Only a full match of every requested entry is successful. Native
failures or incomplete evidence produce `unknown`, never a guessed enabled or
disabled state. Group success requires every installed compatible service to
match; runtime-absent services remain visible as unsupported in `services`.
Retrying reconciles partial changes. Overrides may survive a
reboot depending on the runtime, but these tools verify only the current boot.

For `setDeviceResources`, an incomplete result is an MCP tool error with the
evidence intact.

`provisionDevice.resources` is all-or-nothing on an iOS Simulator (owner decision
2026-10-09, #6695). After the write and the independent re-read, every requested
entry must be proven; an entry that is contradicted (`missingRequested`),
`unsupported`, or has unknown or missing evidence (`commandFailure`) fails
provisioning with the typed error code `resource_profile_unproven`. The error is
non-retryable and its `resourceDrift` lists the unproven entries in the same shape
as `reconcileDeviceResources` drift; the message names them too, so a replayed
operation keeps them. Failure happens before CtrlProxy readiness and session
binding, so no session is bound, a replayed session is released, the lifecycle
lease is released, and a simulator created by this operation is rolled back by the
normal failed-provision cleanup. On an adopted simulator the overrides that were
already written are deliberately not reverted: they stay in effect and remain
recorded as AutoMobile-owned, because a compensating write could itself fail and
would hide which state the device is really in. Use `reconcileDeviceResources`
(`repair`, optionally `releaseOwnedExtras`) or `setDeviceResources` to converge or
undo them. Android and physical iOS targets keep the earlier behavior: the result
is returned under `resources`, the response is marked as an error, and the
provisioned device identity and session are retained. Booted provisioning
responses expose the session as a top-level `sessionId` field, with no
`sessionUuid` alias, including replayed operations. With `boot: false`, no
top-level session field is present.

## Reconciling workload profiles

After a verified write, the iOS controller records which services AutoMobile
changed to `disabled` in `device_resource_applications`, keyed by the simulator
incarnation: UDID, runtime identifier and device type together, never the UDID
alone. Only resources AutoMobile changed are recorded; a service that was already
disabled is never claimed. Re-enabling a resource removes it. The record is
ownership of an override, not of the simulator. Recording is best effort and never
changes the mutation result.

`reconcileDeviceResources` (opt-in, like `setDeviceResources`) compares a requested
map with an independent observation and returns typed drift:

| Kind               | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `missingRequested` | A requested state is explicitly contradicted.                                |
| `ownedExtra`       | A recorded AutoMobile override outside the requested map is still in effect. |
| `unsupported`      | The runtime cannot provide or control the requested resource.                |
| `commandFailure`   | Native evidence is unknown, mixed or missing; never a guessed state.         |

The default is report only, with no writes. `repair: true` passes only the drifted
`missingRequested` and `commandFailure` entries to the controller, then re-reads every
resource; `releaseOwnedExtras: true` also re-enables owned extras. A second run with
no drift issues no commands. `success` is true only when the final observation proves
every requested entry and no owned extra remains, so unsupported resources fail
closed. After an erase the overrides are gone: requested entries report
`missingRequested`, recorded entries observed enabled are neither extras nor kept,
and a repair reapplies them. A recreated simulator or a replaced runtime is a new
incarnation without a record. Physical devices, Android targets and simulators that
are not booted are rejected before any command runs.

`provisionDevice.resources` already applies resources after boot and before
automation readiness under the provisioning lifecycle lease; its writes are recorded
the same way, so a later reconciliation recognizes them. On an iOS Simulator it
fails closed when the profile cannot be proven (see above).

## Automation capabilities

Resource state does not establish whether screenshots, interaction, notifications,
purchases, or other automation capabilities work. Continue to report capabilities
separately using AutoMobile's existing supported/partial/unavailable/unsupported
conventions. Only mark a capability unavailable because of a disabled resource
when its dependency is known for the device and app context.

## Android controls

Android emulator controls are independent and opt-in. Optional-app groups disable
only installed system packages in a fixed catalog for the current Android user.
They preserve ContactsProvider, CalendarProvider, MediaProvider, DocumentsUI,
SystemUI, the launcher, credentials, networking and automation packages. Active
apps, default role holders, the selected keyboard and enabled accessibility
services are protected. If role inspection is unavailable, package disablement
fails closed; older Android versions can still support individual settings.

- `animations` sets the three system animation scales to zero or one.
- `screensavers` controls dream activation, separately from wallpaper and widgets.
- `backup` controls Backup Manager for the current user.
- `mailApp`, `calendarApp`, `contactsApp`, `mapsApp`, `videoApp`, `musicApp`,
  `photosApp`, `assistantApp`, `digitalWellbeing`, `printing`, `accessibilityApps`,
  `textToSpeech`, and `wallpaperApps` control optional applications. Disabling an
  app removes its integrations and intent handlers. Wallpaper picker removal
  is not equivalent to disabling wallpaper rendering.
- `healthConnect`, `adServices`, `onDevicePersonalization`, `storeApp`,
  `dialerApp`, `messagesApp`, `googlePlayServices` and `googleServicesFramework`
  are explicit feature tradeoffs. Shared Google infrastructure must remain
  enabled for workloads that depend on its notifications or authentication.
  Mainline/APEX containers are never removed.

An Android response can include a `restore` receipt. Pass it back as
`setDeviceResources({restore: receipt, ...deviceTargeting})`, without `resources`,
to restore the exact previous overrides. Receipts are restricted to the same
emulator serial, boot ID and user. This prevents accidental restoration onto a
recycled emulator. They preserve default package state and absent settings;
`enabled` is an explicit enable operation, not a substitute for restoration.
Default override restoration may report observed state `unknown` while returning
`success: true`: the original override was verified, but the runtime's effective
default was not inferred. Save the receipt from partial-error responses too.
A request cancelled before returning a response may have made partial changes;
inspect/reconcile state rather than assuming rollback. Receipts are not a durable
transaction journal and do not promise restoration across reboot or lost responses.

Android `changed` records targets for which a native write was attempted. Each
successful target is re-read; failed or ignored writes produce an error result.
No package availability observation proves it consumes CPU, and no resource
configuration result promises measured performance gains.

## Android provisioning hardware

`provisionDevice.device.spec.configuration` accepts `memoryMb`, `cpuCores`,
`gpuMode`, `screenWidth`, `screenHeight`, `screenDensity`, `cameraFront`,
`cameraBack`, `audioInput`, and `audioOutput`. These persist in the AVD configuration
before boot. GPU modes are `auto`, `host`, `software`, `swiftshader`, `lavapipe`,
and `swangle`; actual backend availability depends on the installed emulator and
host. Camera values are `none` or `emulated`. Existing modern Play-image minimum
memory checks remain in effect. Replay can reconcile hardware only while the
AVD is stopped; a mismatched running device is an identity conflict.

Headless launch controls the window independently of audio.
`AUTOMOBILE_EMULATOR_AUDIO=false` passes `-no-audio`; otherwise the emulator and
AVD audio settings apply. `AUTOMOBILE_EMULATOR_HEADLESS` retains its existing
platform defaults. This changes the old implicit headless-audio-off behavior.
Audio-dependent workflows can now run headless.

Further Android work and the measurement protocol are tracked in
[Android emulator optimization](android-emulator-optimization.md).

Provisioned Android transport retirement uses a process-wide fence in `src/utils`.
Its store contract lives beside the fence; the DB layer constructs the durable
default with `ProvisionedDeviceTransportTombstoneRepository`. Daemon construction,
MCP tool registration (including direct/stdio startup), and CLI tool registration
install it before device-session use. Installation preserves an existing fence
and does not open the DB until use, retaining startup ownership and migration
ordering. An unwired production holder throws; only tests default/reset to an
in-memory fence. Durable tombstones survive process restart and prevent a retired
emulator transport from identifying a later device.

## VM snapshot incarnation lifecycle

An Android VM restore advances the pooled incarnation and synchronously calls
the registry's reconnect primitive to retire the old `deviceSessionUuid` and
mint its successor before any post-load incarnation listener runs. Same or
older incarnation inputs return the current record, so a later readiness
callback cannot mint twice or move identity backwards. The owning tool
`sessionUuid` and serial assignment survive; direct mode and pooled devices
without a live registry epoch mint nothing during restore.

The `deviceSnapshot` restore result includes the new `deviceSessionUuid` when
one exists. The old epoch's ended frame carries `successorSessionUuid` and the
typed reason `superseded-by-restore`; reconnect/disconnect frames retain their
existing shape. All-device subscribers see ended/started; old-UUID subscribers
see ended and must subscribe again to the successor. Frames pushed for the
restored serial are stamped with the new UUID. Restore-retired UUIDs fail
validated stream requests with `DEVICE_SESSION_SUPERSEDED_BY_RESTORE` and
recovery instructions shared through the device-session resolver. Device-control
replay rejects the old epoch through its existing typed transport failure and
uses the same restore-specific message.

The registry keeps at most 256 restore tombstones (UUID, serial, immediate
successor, reason), evicting oldest first and clearing a serial's tombstones on
disconnect. Tombstones diagnose retirement; they never resolve as live and an
immediate successor may itself later retire, so clients must discover the
current UUID from the result, started frame, session listing, or device runtime.
Definitive pre-load failures leave identity untouched. Once load succeeds, a
readiness failure still re-mints because the guest has already rewound; an
ambiguous load failure retains the existing conservative invalidation policy.

Per-device host-state owners register a `DeviceIncarnationListener`.
`prepareForIncarnationChange(deviceId)` runs before the VM load;
`onDeviceIncarnationChanged(deviceId)` invalidates caches immediately after loading.
The optional `onIncarnationChangeSettled(deviceId, { ready })` hook runs once on
all exits after preparation, including preparation, load, and readiness failures.
`ready: true` means the restore provider's guest readiness wait resolved. All
three phases are independently best-effort, and rejected listeners are logged.

Installed-app owners invalidate in-memory and persisted caches after load, but
send their resource-updated notification only at ready settlement. Subscribers
interpret this notification as an invitation to re-read; load/readiness failures
therefore invalidate without notifying, so an unready guest cannot supply a
fresh-looking empty app list in response to the notification.

Recording preparation fences new starts for that device before listing or
stopping existing recordings. Settlement releases the fence on success or
failure, after the readiness wait. A replaceable, injected Timer expiry defaults
to ten minutes (well above the default 30-second load plus 30-second readiness
budgets) to recover from abandoned restore flows. Custom restores longer than
that bound may outlive the fence. A start already reserved before preparation
can still finish after the active-recording inventory was taken; the fence
rejects new reservations and does not drain starts already in flight.

Persistent Android provenance failure (including a missing cmdline-tools installation) returns
`enrichment: { complete: false, missing: ["provenance"], retryable: false, reason }` from
`listDevices`. The booted list remains usable without provenance; clients should address the
reported cause instead of polling. Successful provenance omits `enrichment`.

Hot presence, disconnect and lifecycle-notification resets clear the 2,500 ms resource,
stage and enrichment caches without aborting shared catalog/provenance fetches. Successful
AVD create/delete/provision, system-image install and daemon shutdown use full invalidation:
obsolete catalog reads report `code: "superseded"` with retry hints, rather than a timeout.
Only an actual 30,000 ms hard-cap expiry reports that background timeout; genuine catalog
failures retain `code: "failed"` with the underlying cause.

All ordinary ADB device-list readers share a 10,000 ms subprocess bound. Inventory callers
wait at most 2,000 ms and return incomplete discovery with `code: "timeout"`, `retryable: true`
and `retryAfterMs: 1000`; their timeout leaves the shared read running and able to publish
into the 5,000 ms cache. Bypass readers run a fresh subprocess. Coalesced AVD listings use a
30,000 ms shared cap and independent caller deadlines/signals, so a 2,000 ms waiter cannot
cancel a longer reader's listing.
