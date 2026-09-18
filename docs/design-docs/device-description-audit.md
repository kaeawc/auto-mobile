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

Renames and drops:

- `status` and `lifecycleState` device literals became `lifecycle.state`.
- `isRunning` is derived by the canonical lifecycle mapping and is not emitted.
- `iosVersion`, `osVersion`, and booted-resource string `runtime` became `runtime.osVersion`; runtime identifiers use `runtime.runtimeId`.
- `screenSize` became `display`; density is `display.density`.
- `deviceSessionUuid` was dropped: the pool incarnation is represented only by `identity.connectionId`; `session.sessionUuid` is the session identity.
- Flat `poolStatus`, `assignedSession`, and legacy session detail collapsed into `session`.
- `capabilities.automation` was removed from the booted resource. `serviceStatus` is retained as the sole automation-status sibling because it includes integrity and runner diagnostics.
- Capability inventory entries now use `{ id, state: "supported"|"unsupported"|"unknown", reason, source }`, with explicit nulls.
- iOS configured-image records always carry the static simulator inventory. If an
  upstream discovery record omitted it, the canonical builder supplies the same
  platform inventory (including unsupported DND, network-condition, and
  connectivity controls) before projection.
- Canonical `source` means locality only (`local`, `remote`, or null). `getApple` acquisition is the separate `acquisition` field.

The Simctl discovery expectation includes those three static unsupported entries;
they belong on simulator image inventories, rather than being treated as absent
or as a runtime probe failure.

## Uncertain — not changed without evidence

The no-CtrlProxy readiness asymmetry was not justified by a producer comment. It is
therefore normalized to `unknown` for Android and iOS: a missing observed connection
is inconclusive, while a failed install/enable/compatibility check remains `not_ready`.
