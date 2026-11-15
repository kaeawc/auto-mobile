# Device resources: Android controls, snapshots and audio

Part of [device resources](device-resources.md).

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
platform defaults, so audio-dependent workflows can run headless.

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
Only an actual 30,000 ms hard-cap expiry reports that background timeout; real catalog
failures retain `code: "failed"` with the underlying cause.

All ordinary ADB device-list readers share a 10,000 ms subprocess bound. Inventory callers
wait at most 2,000 ms and return incomplete discovery with `code: "timeout"`, `retryable: true`
and `retryAfterMs: 1000`; their timeout leaves the shared read running and able to publish
into the 5,000 ms cache. Bypass readers run a fresh subprocess. Coalesced AVD listings use a
30,000 ms shared cap and independent caller deadlines/signals, so a 2,000 ms waiter cannot
cancel a longer reader's listing.

## Tool preflight: device_service_disabled

A scoped provider checks known disabled services before staging or invoking the
simulator operation. The typed dependency map in
`src/utils/deviceServiceDependencies.ts` registers only shipped tools that use a
catalog resource. The provider enforces the scope; the preflight checks the
registered tool's resources in stable catalog order.

| Tool         | Scope                                        | Resource           | Labels                                                                               | Unavailable                                      |
| ------------ | -------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `putAppFile` | iOS Simulator, `target.domain=media_library` | `mediaTranscoding` | `com.apple.photos.ImageConversionService`, `com.apple.photos.VideoConversionService` | Photo/video media-library import and transcoding |

Any catalog label with the boolean override `true` disables its resource. The
first disabled resource produces an `ActionableError` with this wire payload:

```typescript
{
  code: "device_service_disabled",
  tool: "putAppFile",
  resource: "mediaTranscoding",
  labels: ["com.apple.photos.ImageConversionService", "com.apple.photos.VideoConversionService"],
  disabledLabels: ["com.apple.photos.ImageConversionService"],
  unavailable: "iOS Simulator photo/video media-library import and transcoding",
  howToEnable: "Call setDeviceResources with {resources:{mediaTranscoding:\"enabled\"}} (enable this default-disabled tool with setToolEnabled or --enable-tool setDeviceResources), or provision/start the simulator without {resources:{mediaTranscoding:\"disabled\"}}.",
  retryable: false,
  deviceId: "<simulator UDID>"
}
```

The single source for this fast-path check is the host launchd disabled database,
`/private/var/tmp/com.apple.CoreSimulator.SimDevice.<UDID>/disabled.plist`, read
through `PlistReader.readJsonFile`. Both `launchctl disable` and pre-first-boot
writes feed this per-UDID database, which survives reboot and erase. Application
DB state is unsuitable here: it requires runtime/device-type identity and extra
simctl calls, and may not reflect external changes. Each call reads once without
caching. A missing file means no known disabled labels; other read failures log a
warning and pass. Unknown state never blocks the tool. This check is not a
service-health guarantee. Physical devices, Android devices and unmapped tools
skip the read; cancellation remains cancellation.

A new tool that uses a catalog resource registers a dependency and a scoped
preflight call (for example Siri (#14892), dictation, HealthKit, widgets and
Spotlight lookups).

## Audio capabilities (#13626)

The `capabilityInventory` of a device reports whether it can record or play audio, so a scheduler can
keep audio tests off hosts that can never pass them.

| id                                     | `supported` when                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ios.simulator.audioInput`             | the host's CoreAudio default input has at least one input stream                                  |
| `ios.simulator.audioOutput`            | the host's CoreAudio default output has at least one output stream                                |
| `ios.simulator.audioOutputCapture`     | the default output is virtual or a known loopback driver, so its signal can be read back (#13629) |
| `android.emulator.audioInput`          | `hw.audioInput=yes`, no `-no-audio` (`AUTOMOBILE_EMULATOR_AUDIO=false`), and a host input exists  |
| `android.emulator.audioOutput`         | `hw.audioOutput=yes` and no `-no-audio`                                                           |
| `android.emulator.audioInputInjection` | the supplied emulator gRPC probe result is reachable                                              |
| `android.emulator.audioOutputCapture`  | the supplied emulator gRPC probe result is reachable                                              |

The two Android gRPC entries use source `platform` and are omitted when no probe result is supplied.
A reachable result makes both `available`; unreachable makes both `unavailable` with the probe's
reason; `not_configured` makes both `unsupported` with the supplied reason or a default naming the
missing emulator gRPC port. Blank reasons use a non-empty default. These entries are independent of
the host audio probe, AVD audio settings, and `-no-audio`; the latter still makes the existing
`android.emulator.audioInput` and `android.emulator.audioOutput` entries unsupported.

An unsupported entry carries an actionable `reason`, for example "No host audio input device;
install a virtual loopback device and make it the default input". A supported host entry names the
default device and its transport (`built-in`, `virtual`, `usb`, ...) in its `reason`, so "real mic"
and "virtual loopback" can be told apart.

- **`audio_input_unavailable` (#13627).** `src/utils/audio/audioInputDiagnostic.ts` derives the
  diagnostic from a non-available `*.audioInput` entry, so there is no second detection path. An iOS
  simulator reads the live cached host probe (not an inventory captured at discovery). An Android
  emulator uses its inventory, read from its AVD config by name when the device arrives without one
  (the daemon session path builds a bare device). Physical devices never
  get it. `observe` adds it to its own served copy only, so cached observations reused by action
  tools never carry it; a microphone grant keeps `success` and adds it under `diagnostics`.
- **Probe.** `src/utils/audio/coreAudioHal.ts` reads the CoreAudio HAL through `bun:ffi`
  (`AudioObjectGetPropertyData` on the system object, then the default device's streams, name and
  transport). HAL property queries need no GUI session, so the probe runs the same from a LaunchDaemon
  service user or an SSH session; it never uses `system_profiler` or ScreenCaptureKit.
- **Cache.** The answer is cached for the daemon's lifetime and re-probed whenever either default
  device id changes (one cheap HAL query each per read); `refreshHostAudio()` forces a re-probe.
- **Not probed.** On a host without a probe (Linux; ALSA/PulseAudio/PipeWire is not implemented) iOS
  audio entries are left out and Android input follows the AVD config alone, so the inventory never
  over-claims. Under `bun test` the default probe reports "not probed"; tests inject a fake HAL.
- **Evidence.** The unit tests run the interpretation over a CoreAudio capture from a MacBook Pro
  (`test/fixtures/host-audio/coreaudio-macbook-pro.json`) and an Android `config.ini` capture
  (`test/fixtures/android-avd-audio/config.ini`). A host with no input or a loopback default is a fake
  HAL scenario, not a capture; a LaunchDaemon run with no Aqua session is not yet verified on a
  device (`needs-device-verify`).
