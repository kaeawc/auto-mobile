# Device-description audit

All device-facing projections are built by `src/daemon/deviceDescription.ts`.
Public surfaces emit only the canonical `DeviceDescription` keys, and every
canonical key is present. An unavailable fact is `null`, not omitted.

| Field group        | configured            | booting               | booted                                 | booted-no-automation | idle-adopted     | rehydrated (awaiting-owner)  |
| ------------------ | --------------------- | --------------------- | -------------------------------------- | -------------------- | ---------------- | ---------------------------- |
| identity           | configured stable id  | configured stable id  | configured stable id                   | same                 | same             | same                         |
| runtime/display    | configuration or null | configuration or null | admitted image, discovery, then config | same                 | same             | same                         |
| runtime.lifecycle  | configured            | booting               | booted                                 | booted               | booted           | booted                       |
| runtime.readiness  | unknown               | unknown               | ready                                  | unknown              | ready or unknown | ready or unknown             |
| runtime.session    | null                  | null                  | assigned session                       | assigned session     | null             | awaiting-owner when restored |
| image/capabilities | image facts           | image facts           | retained facts or null                 | same                 | same             | same                         |

Canonical fields:

- `identity.stableId` is the durable configured identity. Runtime identifiers
  (`deviceId`, `connectionId`, and `deviceSessionUuid`) live under `runtime`.
- `osVersion`, `apiLevel`, `runtimeId`, `deviceType`, `model`, `architecture`,
  and `formFactor` are top-level static facts.
- `runtime.lifecycle`, `runtime.readiness`, `runtime.poolStatus` (`assigned` also covers a device held by the session broker or another daemon, with `runtime.heldBy` of `session_broker`/`other_daemon`; a broker-bound device the pool dropped, such as a simulator an erase reset shut down or an emulator an ADB server reset detached, reports `poolStatus: null` with `heldBy: "session_broker"` until the next pool refresh re-pools it as `assigned`), and
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
- Capability inventory entries use `{ id, state: "supported"|"unsupported"|"unknown", reason, source }`, with explicit nulls.
- iOS simulator configured-image records carry the static simulator inventory. If an
  upstream simulator discovery record omitted it, the canonical builder supplies the same
  simulator inventory (including unsupported DND, network-condition, and
  connectivity controls) before projection. Physical iPhones never receive that
  synthesized simulator-only inventory; they retain discovered inventory or `null`.
- Canonical `source` means locality only (`local`, `remote`, or null). `getApple` acquisition is the separate `acquisition` field.

The Simctl discovery expectation includes those three static unsupported entries;
they belong on simulator image inventories, rather than being treated as absent
or as a runtime probe failure.

## Readiness without CtrlProxy

Readiness without a CtrlProxy connection is `unknown` for Android and iOS: a missing observed
connection is inconclusive, while a failed install/enable/compatibility check is `not_ready`.
Running simulators are `ready`.

## By-design differences

- `locked` is `null` on the booted resource but omitted from `devices/lockStates` for iOS (Android
  `false` on both); iOS has no safe lock read.
- Live orientation on the booted resource is Android portrait/landscape and iOS `null` (no safe
  read-only signal).
- Canonical `formFactor` is the strict enum (`phone`, `tablet`, `foldable`, `tv`, `watch`,
  `automotive`, `xr-headset`, `xr-glasses`, `unknown`).

## Background

- [Canonical device description: alias removal and live audit](../devlog/2026-09-18-device-description-audit-canonical-shape.md)
