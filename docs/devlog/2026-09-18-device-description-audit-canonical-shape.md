# Canonical device description: alias removal and live audit

- Kind: decision
- Date: 2026-09-18
- Source: moved from `how-it-works/device-description-audit.md`; #7229, #7276
- Shaped: [Device-description audit](../how-it-works/device-description-audit.md)

## Context

Device surfaces were built by separate producers (#7229). A read-only live pass on 2026-09-18 found
the cross-surface splits listed below.

## Options

Not recorded.

## Decision

Route every surface through the canonical builder in `src/daemon/deviceDescription.ts`, and in phase 3
(#7276) remove every compatibility alias from every producer. The no-CtrlProxy readiness asymmetry was
not justified by a producer comment, so it was normalized to `unknown` for Android and iOS.

## Consequences

The desktop Kotlin models, live-device acceptance checks, daemon consumer, CLI and tests read the
canonical description. The removals, the live-pass findings and the readiness evidence follow.

### Phase 3 removals

The desktop Kotlin models, live-device acceptance checks, daemon consumer, CLI,
and tests read the canonical description. The following compatibility
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

### Resolved cross-surface disagreements (2026-09-18 live pass, pre-phase-3)

A read-only live pass (`listDevices`, `listDeviceImages`, `automobile:devices/booted`,
`automobile:devices/images`, `automobile:devices/lockStates`; three API 36 emulators,
two iOS 26.5 simulators, all booted and idle) found these producer splits. All were
fixed by routing every surface through the canonical builder; they are the
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
  alias is now nullable, and canonical `formFactor` stays the strict enum (`phone`, `tablet`, `foldable`, `tv`, `watch`, `automotive`, `xr-headset`, `xr-glasses`, `unknown`).
- Canonical `runtime.serviceStatus` lost diagnostics held by its deprecated sibling; it
  now keeps the nullable installed checksum, structured version, and the iOS
  supported-command/feature completeness flags.
- Fresh Android fallback provisioning lost the system-image id; the selected package is
  now carried as `runtimeId` before boot.
- Remaining by-design differences: `locked` is `null` on the booted resource but omitted
  from `devices/lockStates` for iOS (Android `false` on both); iOS has no safe lock read.

#### Readiness evidence for the no-CtrlProxy normalization

From the same `readinessFromServiceStatus` mapping: installed+enabled+compatible but not
running gave `unknown` (inconclusive missing connection); not installed/enabled/compatible
gave `not_ready` (failed check); running simulators gave `ready`. The iOS "installed but
not running" case was not observed, so the `unknown` symmetry is evidenced on Android only.
