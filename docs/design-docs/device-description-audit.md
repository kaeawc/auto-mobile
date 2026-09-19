# Device-description audit

All device-facing projections are built by `src/server/deviceDescription.ts`.
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
- `runtime.lifecycle`, `runtime.readiness`, `runtime.poolStatus`, and
  `runtime.session` describe observed state and ownership.
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
  `availabilityError`, `iosVersion`, `deviceType`, `model`, and `architecture`.
  The former raw `state` string is represented by normalized
  `runtime.lifecycle.state`.
- `listDevices`: `deviceId`, `apiLevel`, `osVersion`, and `formFactor`.
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

## Historical pre-phase-3 live values pass (2026-09-18)

The tables below preserve the phase-1/2 audit evidence. They describe the
superset payload observed before phase 3 and are not the current wire contract;
rows labelled `alias` were removed, and older canonical paths in these tables
were superseded by the shape documented above.

Observed against the shared local daemon. Read-only calls only: `listDevices`,
`listDeviceImages` (both platforms), and the `automobile:devices/booted`,
`automobile:devices/images`, and `automobile:devices/lockStates` resources
(the last is spelled `lockStates`, not `lock-states`). Raw payloads are under
`scratch/values-audit/` (gitignored).

Provenance caveats, so nobody reads more into the table than it supports:

- The daemon that answered was built from `596475d1a`, five commits behind the
  main head this doc lives on (two of them README badge bumps). Two of the
  remaining three touch these surfaces:
  #7238 changed the image `state` alias to the raw discovery token and added
  `session.sessionUuid`/canonical readiness on acquisitions. Values marked
  `(pre-#7238)` below were observed on the older build and are expected to
  differ on current main.
- The `--cli` skew guard restarted the daemon on its own before the first call
  (the previous daemon was the bunx-cache `0.0.75` package build, not a source
  build). No device was started, killed, provisioned, or acquired.
- Fleet at observation time (`adb devices`, `xcrun simctl list devices`):
  Android emulators `emulator-5554` (AVD `am-api36-ga-arm64`), `emulator-5556`
  (`acceptance-pixel-6`), `emulator-5564` (`acceptance-pixel-6-sibling`), all
  API 36; iOS simulators "Acceptance iPhone 17" `4E8A6FF9…` and `740AB8F7…`,
  both iOS 26.5, both Booted. Every configured AVD and every simulator was
  booted, and the pool reported `idle: 5, assigned: 0`.

Lifecycle states that were **not observable** and therefore have no column:
`configured` (not booted) on either platform (all images were booted),
`booting`, `shutting-down`, and `unavailable`. Likewise unobserved on the
session/pool axis (`session.poolStatus`, not a lifecycle state): `assigned`
(no device held a session; none was created). Physical devices: none attached.

Cell legend: value as emitted, `null`, `—` when the surface omits the key
entirely. Long ids are abbreviated (`4E8A6FF9…`). Where the three Android
emulators or the two simulators differ, the cell says so.

### `automobile:devices/booted` (historical canonical description plus removed aliases)

| Field                            | booted Android (no session)                                                                                        | booted iOS (no session)                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| identity.stableId                | AVD name (`am-api36-ga-arm64`)                                                                                     | udid (`4E8A6FF9…`)                                                                                                   |
| identity.deviceId                | `emulator-5554`                                                                                                    | `4E8A6FF9…`                                                                                                          |
| identity.connectionId            | `emulator-5554#1` (`#2`, `#3` for the other two)                                                                   | `4E8A6FF9…#4`, `740AB8F7…#5`                                                                                         |
| identity.deviceSessionUuid       | uuid (`2b27ac06…`)                                                                                                 | uuid (`c410f156…`)                                                                                                   |
| name                             | AVD name                                                                                                           | `Acceptance iPhone 17`                                                                                               |
| platform                         | `android`                                                                                                          | `ios`                                                                                                                |
| isVirtual                        | `true`                                                                                                             | `true`                                                                                                               |
| source                           | `local`                                                                                                            | `local`                                                                                                              |
| runtime.osVersion                | `null`                                                                                                             | `"26.5"`                                                                                                             |
| runtime.apiLevel                 | `null`                                                                                                             | `null`                                                                                                               |
| runtime.runtimeId                | `null`                                                                                                             | `null`                                                                                                               |
| runtime.deviceType               | `null`                                                                                                             | `null`                                                                                                               |
| runtime.architecture             | `null`                                                                                                             | `null`                                                                                                               |
| runtime.model                    | `null`                                                                                                             | `null`                                                                                                               |
| display.width / height / density | `null` / `null` / `null`                                                                                           | `null` / `null` / `null`                                                                                             |
| display.formFactor               | `null`                                                                                                             | `"phone"`                                                                                                            |
| lifecycle.state / known          | `booted` / `true`                                                                                                  | `booted` / `true`                                                                                                    |
| readiness.state                  | `unknown` (5554, 5556: CtrlProxy installed, not running); `not_ready` (5564: not installed)                        | `ready` (runner installed and running)                                                                               |
| session.sessionUuid              | `null`                                                                                                             | `null`                                                                                                               |
| session.ownership                | `null`                                                                                                             | `null`                                                                                                               |
| session.poolStatus               | `idle`                                                                                                             | `idle`                                                                                                               |
| provenance.android               | `{ path: null, target: null, basedOn: null, error: null }`                                                         | `null`                                                                                                               |
| provenance.ios                   | `null`                                                                                                             | `{ isAvailable: null, availabilityError: null }`                                                                     |
| capabilityInventory              | `null`                                                                                                             | 5 entries, `source: "platform"` (biometric supported; nfc, doNotDisturb, networkCondition, connectivity unsupported) |
| alias `deviceId`                 | `emulator-5554`                                                                                                    | `4E8A6FF9…`                                                                                                          |
| alias `status`                   | `booted`                                                                                                           | `booted`                                                                                                             |
| alias `lifecycleState`           | `booted`                                                                                                           | `booted`                                                                                                             |
| alias `legacyRuntimeVersion`     | `null`                                                                                                             | `"26.5"`                                                                                                             |
| alias `formFactor`               | `null`                                                                                                             | `"phone"`                                                                                                            |
| alias `deviceSessionUuid`        | same uuid as identity                                                                                              | same uuid as identity                                                                                                |
| alias `poolStatus`               | `idle`                                                                                                             | `idle`                                                                                                               |
| alias `assignedSession`          | —                                                                                                                  | —                                                                                                                    |
| sibling `serviceStatus`          | `{ installed, enabled, running: false, isCompatible, sha256s, version 0.0.75-SNAPSHOT }`; 5564: `installed: false` | `{ installed, enabled, running: true, isCompatible, version.build 0.0.75, supportedCommandsComplete }`               |
| sibling `locked`                 | `false`                                                                                                            | `null`                                                                                                               |
| sibling `recoveryEligibility`    | `{ eligible: false, reason: "disabled" }`                                                                          | same                                                                                                                 |
| sibling `identityUnresolved`     | `false`                                                                                                            | `false`                                                                                                              |

`automobile:devices/lockStates` for the same devices: Android entries
`{ deviceId, locked: false }`; iOS entries `{ deviceId }` with the `locked`
key omitted (the booted resource says `locked: null` for the same simulators).

### `listDevices` (historical projection plus removed aliases)

| Field                            | booted Android (no session)                  | booted iOS (no session)                 |
| -------------------------------- | -------------------------------------------- | --------------------------------------- |
| identity.stableId                | AVD name                                     | udid                                    |
| identity.deviceId                | `emulator-5554`                              | udid                                    |
| identity.connectionId            | `emulator-5554#1`                            | `4E8A6FF9…#4`                           |
| identity.deviceSessionUuid       | `null`                                       | `null`                                  |
| name / platform / isVirtual      | AVD name / `android` / `true`                | `Acceptance iPhone 17` / `ios` / `true` |
| source                           | —                                            | —                                       |
| runtime.*                        | all `null`                                   | osVersion `"26.5"`, rest `null`         |
| display.formFactor               | `null` (width/height/density —)              | `"phone"`                               |
| lifecycle.state / known          | `booted` / `true`                            | `booted` / `true`                       |
| readiness                        | —                                            | —                                       |
| session.sessionUuid              | `null` (ownership/poolStatus —)              | `null`                                  |
| provenance / capabilityInventory | —                                            | —                                       |
| alias `deviceId`                 | `emulator-5554`                              | udid                                    |
| alias `apiLevel`                 | — (only emitted for non-null Android values) | —                                       |
| alias `osVersion`                | — (only emitted when truthy)                 | `"26.5"`                                |
| alias `formFactor`               | — (only emitted when truthy)                 | `"phone"`                               |

Envelope: `message: "Found 5 booted devices"`, `count: 5`,
`discovery: { complete: true, failedPlatforms: [] }`, plus the resource
pointer `note`.

### Image surfaces: `listDeviceImages` tool and `automobile:devices/images` resource

The two surfaces emit the same 24 keys per image and agree on every value except
Android provenance (called out in the cells). The images were booted, so this is
the image projection of a booted device, not the `configured` state.

| Field                               | Android image (booted AVD)                                                                                             | iOS image (booted simulator)                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| identity.stableId                   | AVD name                                                                                                               | udid                                                              |
| identity.deviceId                   | `null`                                                                                                                 | udid                                                              |
| identity.connectionId               | `null`                                                                                                                 | `null`                                                            |
| identity.deviceSessionUuid          | `null`                                                                                                                 | `null`                                                            |
| name / platform / isVirtual         | AVD name / `android` / `true`                                                                                          | `Acceptance iPhone 17` / `ios` / `true`                           |
| source                              | `local`                                                                                                                | `local`                                                           |
| runtime.osVersion                   | `"16"`                                                                                                                 | `"26.5"`                                                          |
| runtime.apiLevel                    | `36`                                                                                                                   | `null`                                                            |
| runtime.runtimeId                   | `null`                                                                                                                 | `com.apple.CoreSimulator.SimRuntime.iOS-26-5`                     |
| runtime.deviceType                  | `null`                                                                                                                 | `com.apple.CoreSimulator.SimDeviceType.iPhone-17`                 |
| runtime.architecture / model        | `null` / `null`                                                                                                        | `null` / `null`                                                   |
| display.width / height / density    | `1080` / `2400` / `420`                                                                                                | `null` / `null` / `null`                                          |
| display.formFactor                  | `"phone"`                                                                                                              | `"phone"`                                                         |
| lifecycle.state / known             | `booted` / `true`                                                                                                      | `booted` / `true`                                                 |
| readiness / session                 | —                                                                                                                      | —                                                                 |
| provenance.android.path             | tool: `null`; resource: `/Users/…/.android/avd/<avd>.avd`                                                              | `null` (whole `provenance.android` is `null`)                     |
| provenance.android.target           | tool: `null`; resource: `Google APIs (Google Inc.)`                                                                    | —                                                                 |
| provenance.android.basedOn          | tool: `null`; resource: `Android 16.0 ("Baklava") Tag/ABI: google_apis/arm64-v8a`                                      | —                                                                 |
| provenance.android.error            | `null`                                                                                                                 | —                                                                 |
| provenance.ios                      | `null`                                                                                                                 | `{ isAvailable: true, availabilityError: null }`                  |
| capabilityInventory                 | 3 entries, `source: "avd_config"` (camera supported, camera.front unsupported, location.gps supported; `reason: null`) | 5 entries, `source: "platform"` (same set as the booted resource) |
| alias `stableId` / `deviceId`       | AVD name / `null`                                                                                                      | udid / udid                                                       |
| alias `path` / `target` / `basedOn` | tool: `null`; resource: same values as provenance.android                                                              | `null`                                                            |
| alias `error`                       | `null`                                                                                                                 | `null`                                                            |
| alias `state`                       | `"booted"` (pre-#7238; lowercase, equal to lifecycle.state)                                                            | `"booted"` (pre-#7238; simctl itself reports `Booted`)            |
| alias `isAvailable`                 | `true`                                                                                                                 | `true`                                                            |
| alias `availabilityError`           | `null`                                                                                                                 | `null`                                                            |
| alias `iosVersion`                  | `"16"` (carries the Android osVersion)                                                                                 | `"26.5"`                                                          |
| alias `deviceType`                  | `null`                                                                                                                 | `…SimDeviceType.iPhone-17`                                        |
| alias `legacyRuntimeId`             | `null`                                                                                                                 | `…SimRuntime.iOS-26-5`                                            |
| alias `model` / `architecture`      | `null` / `null`                                                                                                        | `null` / `null`                                                   |

Envelopes: tool `message: "Found 3 configured android device images"` /
`"Found 2 configured ios device images"` with
`configuredInventory: { schemaVersion: 1, complete: true, observations }`;
resource `totalCount: 5`, `catalogComplete: true`, `catalogObservations`, the
same `configuredInventory`, and a `provisioningCatalog` (`runtimes`,
`deviceTypes`, `systemImages`, `profiles`).

### Disagreements observed

The phase-1 integration lane closes the remaining B1/B7 producer split: `getAndroid`,
`getApple`, `provisionDevice.device`, `listDevices`, and both device resources now feed
the same configured-image facts through the canonical builder. Display dimensions,
capability inventory, runtime id, and device type therefore agree whenever the backing
image supplies them.

- **Booted vs image surfaces drop every Android runtime/display fact.** For the
  same AVD, the image surfaces say `osVersion "16"`, `apiLevel 36`,
  `1080×2400@420`, `formFactor "phone"`; `listDevices` and `devices/booted`
  say `null` for all of them (and `legacyRuntimeVersion: null`,
  `formFactor: null`). The lifecycle table above promises "admitted image,
  discovery, then config" for booted devices; live data shows none of the three
  emulators had an admitted image attached (all idle, incarnations `#1`–`#3`),
  so the booted projection fell through to nulls. (fixed in this PR: booted
  projections now use the completed configured-image inventory after admitted
  image and discovery facts are unavailable, retain the booted-to-image
  `path`/`target`/`basedOn` link when AVD provenance is available, and route
  acquisition results through that same enrichment.)
- **iOS `runtime.runtimeId` and `runtime.deviceType`** are populated on the
  image surfaces and `null` on both booted surfaces for the same simulator.
  `runtime.osVersion "26.5"` agrees everywhere. (fixed in this PR: the same
  configured-image fallback supplies simulator runtime and device-type ids.)
- **`listDeviceImages` vs `automobile:devices/images` Android provenance.** The
  resource populates `provenance.android.{path,target,basedOn}` (and the
  `path`/`target`/`basedOn` aliases); the tool emits `null` for all six. The
  tool handler calls `describeDevice({ kind: "image", image })` without
  `androidProvenance` (`src/server/deviceTools.ts`, `listDeviceImagesHandler`).
  (fixed in this PR: the tool now passes the AVD-manager provenance record into
  the canonical description.)
- **`listDevices` alias shape differs by platform.** Android entries have no
  `apiLevel`/`osVersion`/`formFactor` keys at all (conditional emission of
  null/falsy values); iOS entries carry `osVersion` and `formFactor`. (fixed in
  this PR: all three aliases are always emitted and nullable on both platforms.)
- **`identity.deviceSessionUuid`** is `null` on `listDevices` but a uuid on
  `devices/booted` for the same device; `listDevices` does not pass the
  registry routing key into `describeDevice`. (fixed in this PR: `listDevices`
  now resolves the same DeviceSessionRegistry routing key.)
- **Image `state` alias is lowercase `"booted"`** on both platforms on this
  build, identical to `lifecycle.state`, while `xcrun simctl` reports `Booted`.
  This is the pre-#7238 behaviour (`state: description.lifecycle.state`); main
  now emits `image.state ?? null`. The raw-token value on main was not observed.
- **`iosVersion` alias on Android images** is `"16"` (the Android
  `runtime.osVersion`), so the alias name does not describe its content. (fixed
  in this PR: Android image aliases now emit `iosVersion: null`.)
- **`locked` for iOS**: `devices/booted` emits `locked: null`; `devices/lockStates`
  omits the key. Android is `false` on both.
- **Readiness spelling**: `devices/booted` emits `unknown`, `not_ready`, and
  `ready`; no other surface carries readiness, so no cross-surface spelling
  clash was observable.
- **`capabilityInventory` for Android**: `null` on `devices/booted`, three
  `avd_config` entries on the image surfaces, for the same AVD. iOS agrees
  across surfaces (five synthesized `platform` entries). (fixed in this PR:
  the configured-image fallback carries the existing AVD capability inventory
  into booted descriptions.)
- **Live orientation was never attached to booted resources.** The booted
  resource now runs the platform `OrientationReader` in the same bounded,
  parallel probe fan-out as service and lock state. Android reports portrait or
  landscape when observed; iOS remains `null` because its reader has no safe
  read-only signal.
- **The `listDevices.formFactor` compatibility alias could be `null` while its
  output schema rejected null.** The alias is now nullable; canonical
  top-level `formFactor` remains the strict four-value enum.
- **Canonical `runtime.serviceStatus` lost diagnostics held by its deprecated
  sibling.** It now preserves the nullable installed checksum, structured
  version identity, and the iOS supported-command and supported-feature
  completeness flags.
- **Fresh Android fallback provisioning lost the system-image id.** The selected
  package is now carried as `runtimeId` on the provisioned image before boot,
  matching the metadata retained for an existing AVD.

### Uncertain items: what the live data shows

- **No-CtrlProxy readiness asymmetry (normalized to `unknown`).** Observed on
  `devices/booted`, all from the same `readinessFromServiceStatus` mapping:
  - `emulator-5554`, `emulator-5556`: `serviceStatus.installed: true`,
    `enabled: true`, `isCompatible: true`, `running: false` →
    `readiness.state: "unknown"`. This is exactly the "missing observed
    connection is inconclusive" case.
  - `emulator-5564`: `installed: false`, `enabled: false`,
    `isCompatible: false` → `readiness.state: "not_ready"`. This is the
    "failed install/enable/compatibility" case.
  - Both simulators: `installed`, `enabled`, `isCompatible`, `running: true` →
    `readiness.state: "ready"`.
  - The iOS "installed but not running" case was **not observed** (both
    simulators had a running runner), so the Android/iOS symmetry of the
    `unknown` outcome is evidenced on Android only.
