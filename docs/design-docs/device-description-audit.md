# Device-description audit

All device-facing projections are now built by `src/server/deviceDescription.ts`.
Every canonical key is present; an unavailable fact is `null`, not omitted.

| Field group             | configured            | booting               | booted                                 | booted-no-automation | idle-adopted      | rehydrated (awaiting-owner)  |
| ----------------------- | --------------------- | --------------------- | -------------------------------------- | -------------------- | ----------------- | ---------------------------- |
| identity                | configured stable id  | configured stable id  | stable id plus connection id           | same                 | same              | same                         |
| runtime/display         | configuration or null | configuration or null | admitted image, discovery, then config | same                 | same              | same                         |
| lifecycle               | configured            | booting               | booted                                 | booted               | booted            | booted                       |
| readiness               | unknown               | unknown               | ready                                  | unknown              | ready or unknown  | ready or unknown             |
| session                 | nulls                 | nulls                 | assigned session                       | assigned session     | idle/null session | awaiting-owner when restored |
| provenance/capabilities | image facts           | image facts           | retained facts or null                 | same                 | same              | same                         |

Canonical fields and deprecated aliases:

- `status` and `lifecycleState` remain deprecated aliases for `lifecycle.state`.
- `isRunning` remains on `provisionDevice.device` from its raw pre-image model; canonical lifecycle data takes precedence for colliding fields.
- `iosVersion` and `osVersion` remain deprecated aliases for `runtime.osVersion`; runtime identifiers use `runtime.runtimeId`.
- `screenSize` remains a deprecated alias for `display.width` and `display.height`; density is `display.density`.
- `identity.connectionId` is the pool-incarnation epoch, `session.sessionUuid` is the durable MCP device-session id, and `identity.deviceSessionUuid` is the DeviceSessionRegistry per-connection routing key used by desktop stream subscriptions. The routing key is intentionally distinct from both other identities and is omitted when the registry has no live record.
- Flat `poolStatus` and `assignedSession` remain deprecated aliases for `session.poolStatus` and `session.sessionUuid`; the canonical `session` object remains at its existing key.
- `capabilities.automation` is the one intentional exception to the compatibility rule for the booted resource. `serviceStatus` remains the sole automation-status sibling because it includes integrity and runner diagnostics.
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

## Deferred removals

The following compatibility aliases remain until the desktop Kotlin
`DeviceModels.kt`, `scripts/live-device-acceptance.ts`, and CI jq consumers have
migrated to the canonical description:

- Image surfaces (`listDeviceImages` and `automobile:devices/images`): `stableId`,
  `deviceId`, `path`, `target`, `basedOn`, `error`, `state`, `isAvailable`,
  `availabilityError`, `iosVersion`, `deviceType`, `model`, and `architecture`.
- `listDevices`: `deviceId`, `apiLevel`, `osVersion`, and `formFactor`.
- `provisionDevice.device`: the raw pre-image `DeviceInfo`/`BootedDevice` fields,
  including `deviceId`, `isRunning`, runtime/display metadata, availability
  metadata, and capability inventory.
- `startDevice`, `getAndroid`, and `getApple`: `deviceId`, `apiLevel`,
  `osVersion`, `formFactor`, `screenSize`, `sessionUuid`, and `deviceIdentity`.
- `automobile:devices/booted`: `deviceId`, `deviceSessionUuid`, `status`,
  `lifecycleState`, `formFactor`, `poolStatus`, and `assignedSession`.
- The flat image `runtime` string could not be restored verbatim because this
  PR's canonical schema uses `runtime` for an object; the value is available at
  `runtime.runtimeId` (canonical) and `legacyRuntimeId` (alias) instead. The
  same collision applies to `provisionDevice.device`.
- The booted-resource flat `runtime` string had different OS-version semantics;
  it is available at `runtime.osVersion` (canonical) and
  `legacyRuntimeVersion` (alias) instead.

## Uncertain — not changed without evidence

The no-CtrlProxy readiness asymmetry was not justified by a producer comment. It is
therefore normalized to `unknown` for Android and iOS: a missing observed connection
is inconclusive, while a failed install/enable/compatibility check remains `not_ready`.
