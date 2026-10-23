# Device-description audit

All device-facing projections are built by `src/daemon/deviceDescription.ts`.
Phase 3 is complete: public surfaces emit only the canonical
`DeviceDescription` keys, and every canonical key is present. An unavailable
fact is `null`, not omitted.

| Field group        | configured            | booting               | booted                                 | booted-no-automation | idle-adopted     | rehydrated (awaiting-owner)  |
| ------------------ | --------------------- | --------------------- | -------------------------------------- | -------------------- | ---------------- | ---------------------------- |
| identity           | configured stable id  | configured stable id  | configured stable id                   | same                 | same             | same                         |
| runtime/display    | configuration or null | configuration or null | admitted image, discovery, then config | same                 | same             | same                         |
| runtime.lifecycle  | configured            | booting               | booted                                 | booted               | booted           | booted                       |
| runtime.readiness  | unknown               | unknown               | ready                                  | unknown              | ready or unknown | ready or unknown             |
| runtime.session    | null                  | null                  | assigned session                       | assigned session     | null             | awaiting-owner when restored |
| image/capabilities | image facts           | image facts           | retained facts or null                 | same                 | same             | same                         |

Canonical fields after phase 3:

- `identity.stableId` is the durable configured identity. Runtime identifiers
  (`deviceId`, `connectionId`, and `deviceSessionUuid`) live under `runtime`.
- `osVersion`, `apiLevel`, `runtimeId`, `deviceType`, `model`, `architecture`,
  and `formFactor` are top-level static facts.
- `runtime.lifecycle`, `runtime.readiness`, `runtime.poolStatus` (`assigned` also covers a device held by the session broker or another daemon, with `runtime.heldBy` of `session_broker`/`other_daemon`), and
  `runtime.session` describe observed state and ownership.
- A held device its platform still lists in a transitional state is published, never dropped, and
  counted `assigned`: an Android device adb lists outside `device` carries
  `runtime.connection.adbState`; an iOS simulator `simctl` lists `Booting` or `Shutting Down`
  carries the additive `runtime.simulatorState` (`"Booting"`/`"Shutting Down"`) with
  `runtime.lifecycle.state` `booting`/`shutting-down` and `readiness` `not_ready`. An unheld
  simulator in those states stays unlisted. When the held-Android state probe cannot answer, the
  pool counts are refused as retryable `discovery_incomplete` rather than read as zero.
- Image provenance is `image.{path,target,basedOn}`; availability failures use
  top-level `availabilityError`.
- `runtime.serviceStatus` carries automation integrity and runner diagnostics.
  The booted resource also has its documented resource-specific
  `serviceStatus` sibling.
- Capability inventory entries now use `{ id, state: "supported"|"unsupported"|"unknown", reason, source }`, with explicit nulls.
- iOS simulator configured-image records carry the static simulator inventory. If an
  upstream simulator discovery record omitted it, the canonical builder supplies the same
  simulator inventory (including unsupported DND, network-condition, and
  connectivity controls) before projection. Physical iPhones never receive that
  synthesized simulator-only inventory; they retain discovered inventory or `null`.
- Canonical `source` means locality only (`local`, `remote`, or null). `getApple` acquisition is the separate `acquisition` field.

The Simctl discovery expectation includes those three static unsupported entries;
they belong on simulator image inventories, rather than being treated as absent
or as a runtime probe failure.

## Phase 3 removals (complete)

The desktop Kotlin models, live-device acceptance checks, daemon consumer, CLI,
and tests now read the canonical description. The following compatibility
fields were removed from every producer:

- Image surfaces (`listDeviceImages` and `automobile:devices/images`): `stableId`,
  `deviceId`, `path`, `target`, `basedOn`, `error`, `state`, `isAvailable`,
  and `iosVersion`.
  The former raw `state` string is represented by normalized
  `runtime.lifecycle.state`.
- `listDevices`: `deviceId`.
- `provisionDevice.device`: the raw pre-image `DeviceInfo`/`BootedDevice` fields,
  including `deviceId`, `isRunning`, runtime/display metadata, availability
  metadata, and capability inventory.
- `startDevice`, `getAndroid`, and `getApple`: duplicate `deviceIdentity`
  copies of `deviceId`, `apiLevel`, `osVersion`, `formFactor`, `screenSize`,
  and `sessionUuid`; canonical values remain at their top-level or runtime
  locations. The separate `deviceIdentity` diagnostic remains for its unique
  platform diagnostics, not as a description alias.
- `automobile:devices/booted`: `deviceId`, `deviceSessionUuid`, `status`,
  `lifecycleState`, `formFactor`, `poolStatus`, and `assignedSession`.
- The old flat image `runtime` string and `legacyRuntimeId` alias were replaced
  by top-level `runtimeId`.
- The booted-resource `legacyRuntimeVersion` alias was replaced by top-level
  `osVersion`.

## Uncertain — not changed without evidence

The no-CtrlProxy readiness asymmetry was not justified by a producer comment. It is
therefore normalized to `unknown` for Android and iOS: a missing observed connection
is inconclusive, while a failed install/enable/compatibility check remains `not_ready`.

## Resolved cross-surface disagreements (2026-09-18 live pass, pre-phase-3)

A read-only live pass (`listDevices`, `listDeviceImages`, `automobile:devices/booted`,
`automobile:devices/images`, `automobile:devices/lockStates`; three API 36 emulators,
two iOS 26.5 simulators, all booted and idle) found these producer splits. All were
fixed by routing every surface through the canonical builder; they are kept as the
rationale for the current shape.

- **Booted surfaces dropped Android runtime/display facts** (image surfaces had
  `osVersion`, `apiLevel`, size/density, `formFactor`; booted ones had `null`)
  because no admitted image was attached. Booted projections now fall back to the
  completed configured-image inventory after admitted-image and discovery facts,
  keep the booted-to-image `path`/`target`/`basedOn` link, and acquisition results use
  the same enrichment. The fallback also supplies iOS `runtimeId`/`deviceType` and the
  Android AVD `capabilityInventory`.
- `listDeviceImages` emitted `null` Android provenance while the resource populated it
  (the handler called `describeDevice({ kind: "image", image })` without
  `androidProvenance`); the tool now passes the AVD-manager provenance record.
- `listDevices` conditionally omitted alias fields and did not resolve
  `identity.deviceSessionUuid`; it now resolves the same `DeviceSessionRegistry`
  routing key.
- The `iosVersion` alias carried the Android `osVersion` on Android images.
- The booted resource never attached live orientation; it now runs
  `OrientationReader` in the same bounded parallel probe fan-out as service and lock
  state (Android portrait/landscape, iOS `null`: no safe read-only signal).
- `listDevices.formFactor` could be `null` while its output schema rejected null; the
  alias is now nullable, and canonical `formFactor` stays the strict four-value enum.
- Canonical `runtime.serviceStatus` lost diagnostics held by its deprecated sibling; it
  now keeps the nullable installed checksum, structured version, and the iOS
  supported-command/feature completeness flags.
- Fresh Android fallback provisioning lost the system-image id; the selected package is
  now carried as `runtimeId` before boot.
- Remaining by-design differences: `locked` is `null` on the booted resource but omitted
  from `devices/lockStates` for iOS (Android `false` on both); iOS has no safe lock read.

### Readiness evidence for the no-CtrlProxy normalization

From the same `readinessFromServiceStatus` mapping: installed+enabled+compatible but not
running gave `unknown` (inconclusive missing connection); not installed/enabled/compatible
gave `not_ready` (failed check); running simulators gave `ready`. The iOS "installed but
not running" case was not observed, so the `unknown` symmetry is evidenced on Android only.
