# Device ownership

A device that a session holds takes control calls only from that session.
`getAndroid`, `getApple` and `startDevice` acquire a device and return the new
session's `sessionUuid`. The session holds the device until it is released.

For refusals, capacity and dropped devices, see
[Device availability and capacity](device-ownership-availability.md).

## Releasing a session explicitly

`daemon/releaseSession` always succeeds, so releases stay idempotent after a
daemon restart:

| Case                                     | Result                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| This daemon remembers an earlier release | `alreadyReleased:true`, `known:true`                                                                                    |
| Unrecognized session                     | `alreadyReleased:false`, `known:false`; with `requireKnown:true`, refused with `daemon_session_not_found`               |
| Restoration incomplete                   | `cleanup` is `pending` or `failed` (failure takes precedence); inspect the restore reports before relying on the device |
| Restoration complete                     | No `cleanup` field                                                                                                      |

## Passing the session

| Caller          | How the session is passed                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP             | A connection that acquired a device is bound to it, so its calls route to the session without repeating it. A different connection passes `sessionUuid` in the call arguments; while the acquiring connection is still connected, that works for reads only.                                                                                                                                                                       |
| CLI             | Each `--cli` call is its own connection: pass the acquisition's `sessionUuid` on every later call, as in `auto-mobile --cli --session-uuid <uuid> tapOn --selector '{"text":"Submit"}'`. A second `--cli getAndroid` for the same device reuses the anonymous session. Free the device with `--daemon release-session`. `--daemon heartbeat` on a one-shot CLI session is a successful no-op, so keeper processes are unnecessary. |
| Default session | Only `setActiveDevice` or an acquisition changes the session that untargeted calls run on. An explicit `sessionUuid` targets that one call only. A call passing only `platform` runs on the default session when the platform matches.                                                                                                                                                                                             |
| `deviceId`      | `observe` and the app-management tools (`installApp`, `launchApp`, `terminateApp`, `crashApp`, `appLifecycle`, `uninstallApp`, `listApps`, `setAppPermissions`, `getAppPermissions`, `inspectPackageSigning`, `resetKeychain`) take `deviceId` to pick one of several booted devices: an Android serial such as `emulator-5554`, or an iOS UDID.                                                                                   |
| `device`        | Not a device id: it is an `executePlan` device label. A serial passed there is refused with a message that names `deviceId`.                                                                                                                                                                                                                                                                                                       |

If you hold two sessions and the default one ends, a control call that passes the
surviving session's `sessionUuid` or `deviceId` runs on that session. A control
call with only `platform`, an unmatched `deviceId`, or no selector gets
`no_active_device_session`. Call `setActiveDevice` or acquire a new session.

## What is refused

A control call on a held device gets `device_owned_by_other_session` when it:

- carries no `sessionUuid` (a plain `--cli tapOn`, for example);
- names a different session than the holder;
- names the holder's session from another connection while the owner is still
  connected.

Naming a session's UUID never takes it over. Once the owner has disconnected (a
finished `--cli` call, for example), another connection may name the session. A
device that no session holds takes calls from anyone.

Other refusals you may meet, and what to do:

| Code                                                 | Meaning and next step                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ambiguous_session_selector`                         | Several of your sessions match; pass `sessionUuid` or `deviceId`.                                                                                                               |
| `ambiguous_device_target`                            | An unnamed call matched several devices; reads pass `deviceId`, control calls acquire a session and pass `sessionUuid`.                                                         |
| `device_outside_bound_session`                       | The call names a `deviceId` other than the session's device.                                                                                                                    |
| `read_session_not_bound` (not retryable)             | A read named a session another connected client owns. Read on the owning connection, or pass `deviceId` instead of `sessionUuid`.                                               |
| `plan_execution_in_progress` (retryable)             | A plan is running; retry when it finishes. Reads stay allowed.                                                                                                                  |
| `session_ownership_lost`, `no_active_device_session` | The session is gone for good (`retryable: false`, `nextAction: "acquire_new_session"`). Acquire a new session.                                                                  |
| `session_released_during_creation`                   | The session was released before it finished creating. Acquire a new one.                                                                                                        |
| `daemon_session_suspect` (retryable)                 | The owner's heartbeat is late; retry now.                                                                                                                                       |
| `session_held_by_recovery` (retryable)               | Device recovery is in flight; retry after `retryAfterMs`.                                                                                                                       |
| `discovery_incomplete` (retryable)                   | `adb` or `simctl` listing failed, so AutoMobile will not boot or adopt a device blind. Retry.                                                                                   |
| `registry_schema_unsupported` (not retryable)        | A strict ownership read found unknown migrations; `dbPath`, `unknownMigrations` and recorded `writerVersions` identify the registry and builds. Upgrade the daemons sharing it. |
| `device_owned_by_other_daemon` (retryable)           | Another AutoMobile daemon holds the device. Stop it there, wait, or choose another device.                                                                                      |
| `device_assigned_to_binding`                         | A broker binding holds the device; use another device.                                                                                                                          |

Your MCP client may first ask you to resolve `ambiguous_device_target`; see
[Choosing a device](device-ownership-ambiguous-target.md). For other daemons, see
[Several daemons on one host](device-ownership-availability.md#several-daemons-on-one-host).

When a refusal carries `retryAfterMs`, wait that long before retrying.
Refusals do not count as session use and do not extend the session's idle window.

### Reads and control

Read-only calls never need a session and never count as activity, even for the
holder. Anything that changes visible UI or starts a device-side process is
control.

| Kind                        | Calls                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read                        | `observe`, `snapshotOf`, `hitTest`, `identifyInteractions`, `listApps`, `getDeviceState`, `getNetworkGraph`, `getPreference`, `listDataStores`, `getDataStore`, `getAppPermissions`, `getNotificationPolicy`, `getDeepLinks`, `getNavigationGraph` |
| Read (mixed tool, per call) | `keyboard` detect/list, `clipboard` get, `mediaSession` get, `displayConfig` with no set field, `accessibility` with no toggle, `prototype` status/inspect, a single read-only `sqlQuery` statement                                                |
| Control                     | The other forms of those mixed tools, plus `systemTray`, `videoRecording` and `deviceSnapshot`                                                                                                                                                     |

- A sessionless read without `deviceId` uses an already-running device and never
  boots one. If none is running it answers that there is nothing to read. Start
  one with `startDevice` or `provisionDevice`, or pass a `deviceId`.
- A sessionless read that passes `deviceId` may boot that stopped device (an
  Android AVD name or an available iOS simulator UDID). It never creates one, and
  boot capacity limits still apply.
- Ownership is a guard between cooperating clients, not a security boundary
  against other local processes.

A read that passes the `sessionUuid` of a session another connected client owns
gets the non-retryable `read_session_not_bound`, which names the session.
Knowing the UUID is not enough. The exceptions are a broker connection granted
that session and a call that presents the session's owner token.

- Read on the owning connection, or leave `sessionUuid` out and pass `deviceId`
  for a sessionless read.
- Once the owner has disconnected (a finished `--cli` call, for example),
  another connection may read under the session.
- A `sessionUuid` that names no device session (such as an IDE observer session)
  still reads sessionlessly.

## When a session is released

A session ends on an explicit release, a lost owner heartbeat, the idle window,
the owning connection closing, or a killed or lost device. Tune the
windows with the variables in
[Environment variables](environment-variables.md#session-heartbeat-timeout).

- **Lost heartbeat.** A session whose owner stops heartbeating ends after roughly
  ten seconds. Calls from other callers do not keep a dead owner alive.
- **No first heartbeat.** If the owner has never heartbeated, the session ends
  about 20 seconds after creation when it set its own heartbeat timeout (about 5
  seconds on the default timeout). After that it ends once no control call
  arrives within its heartbeat timeout.
- **Idle.** A session ends after 2 minutes (default) with no control call.
  Heartbeats and reads do not extend the window. Neither does a `setToolEnabled`
  call that does not pass the session's `sessionUuid`. A control call still
  running holds the release until it finishes. Every `blePeripheral` action,
  `status` included, is a control call and extends it.
- **Plan labels.** A multi-device plan runs its extra labels on derived
  `<base>:<label>` sessions. They live only as long as the plan run and end with
  the base session. The next plan run mints them again; do not create
  `<base>:<name>` sessions yourself.

### Terminal releases

AutoMobile never revives a released session UUID. A later call naming it gets
`session_ownership_lost`, `retryable: false` and
`nextAction: "acquire_new_session"`. A call still running when its session ends
is cut with the same refusal. Extra fields depend on the release:

| Release                                                              | Extra field                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Idle                                                                 | `idle: true`                                                                                                                   |
| `cli-idle-timeout`                                                   | `idleTimeoutMs`: the `AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS` of the last `--cli` call that used the session, capped at 1 hour |
| Derived plan label session ending with its base's `cli-idle-timeout` | The base's `idleTimeoutMs`, the window that expired                                                                            |

### Daemon and device restarts

A daemon restart is not terminal: the owner reclaims the session under the same
UUID. While the daemon reclaims the binding, calls may get the retryable
`binding_ownership_unconfirmed`; wait `retryAfterMs`. If ownership cannot be
confirmed in about a minute, the session ends and calls get
`session_ownership_lost`.

If the previous daemon crashed or was killed, its sessions wait at most about 8
seconds for their owner to reconnect, whatever their own heartbeat or CLI idle
window. A client that is still running and heartbeating keeps its session;
otherwise the device frees within seconds. A CLI session does not heartbeat, so
its next call gets `session_ownership_lost`; acquire a new session.

When a device restarts, its session can resume under the same UUID for 180
seconds. Meanwhile other sessions cannot take that device: a start naming it gets
a retry hint. If the window passes without a resume, the session ends with
`session_ownership_lost`.

### Device killed or lost

An explicit kill ends the session with `session_ownership_lost`. While the kill
runs, calls get `session_terminal_release_in_progress` (`retryable: false`).
Acquire again under a new session.

With session continuity enabled, a connection loss can instead return
`device_lost` while AutoMobile keeps the session:

| Field                                                  | Meaning                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `deviceId`                                             | The lost serial                                                                   |
| `replacementDeviceId`                                  | When present, the live replacement                                                |
| `retry.sameSession: true`, `requiresNewSession: false` | Retry using the same `sessionUuid`                                                |
| `recovery.status: "pending"`                           | Recovery is still settling, even if a replacement serial is known; wait and retry |
| `recovery.status: "recovered"`                         | Recovery completed                                                                |
| `recovery.attempts`                                    | Recorded attempts; zero when only live-session evidence is available              |

An exhausted or unattempted recovery keeps its reported status. Follow
`sessionState` and `retry` to decide whether to reacquire. Without a retained
session or incident, the response carries no retry guidance.

Verify continuity with the
[binding metadata and liveness notification](environment-variables.md#session-heartbeat-timeout).
The generation counter restarts at zero after a daemon restart. AutoMobile sends `session_device_rebound` at `info`
level, so a client that raised its log level above `info` will not see it; read
`session-info` instead.

### Release reasons

| Reason                                                                                                  | Terminal?  | What the client sees                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `explicit-release`                                                                                      | Yes        | `session_ownership_lost`; acquire a new session.                                                                                                                                                                                                                    |
| `cleanup-expired` (legacy: `lazy-expiry`)                                                               | Yes (idle) | `session_ownership_lost` refusals and session-not-found answers (heartbeat, `daemon/sessionInfo`) carry `idle: true`. Acquire a new session.                                                                                                                        |
| `cli-idle-timeout`                                                                                      | Yes (idle) | `session_ownership_lost` refusals (including the `daemon/registerSession` refusal) and session-not-found answers (heartbeat, `daemon/sessionInfo`) carry `idle: true` and `idleTimeoutMs` for a one-shot CLI session.                                               |
| `heartbeat-timeout`, `missing-first-heartbeat`                                                          | Yes        | `session_ownership_lost`, with the heartbeat age and limit in the message.                                                                                                                                                                                          |
| `rehydration-owner-timeout`                                                                             | Yes        | `session_ownership_lost`: a rehydrated session's owner never reclaimed it.                                                                                                                                                                                          |
| `owner-disconnected`                                                                                    | Yes        | `session_ownership_lost`: the owning connection closed and no other client owns the session.                                                                                                                                                                        |
| `binding-ownership-lost`                                                                                | Yes        | `session_ownership_lost`: another execution took the broker binding and its device; acquire a new session.                                                                                                                                                          |
| `managed-slot-ownership-lost`                                                                           | Yes        | Persisted legacy spelling of `binding-ownership-lost`; existing rows remain terminal.                                                                                                                                                                               |
| `device-killed` (also a sessionless stop of the device a handed-off session was waiting for)            | Yes        | `session_terminal_release_in_progress` while the kill runs, then `session_ownership_lost`.                                                                                                                                                                          |
| `device-disconnected:<device>`                                                                          | Yes        | `session_ownership_lost`: the device was lost.                                                                                                                                                                                                                      |
| `identity-recovery-<reason>`                                                                            | Yes        | `session_ownership_lost` with `recoveryReason` and `deviceId` (and `ownerPid` when another daemon holds the device): restart recovery could not prove the device's identity.                                                                                        |
| `session-creation-cancelled`                                                                            | Yes        | `session_ownership_lost`: the creation was cancelled before the session was handed out.                                                                                                                                                                             |
| `daemon-shutdown`, `daemon-restart`                                                                     | No         | The restarted daemon rehydrates the session; its owner reclaims it under the same UUID.                                                                                                                                                                             |
| `restart-recovery-timeout`                                                                              | Yes        | `session_ownership_lost`, without `idle`: the device-restart recovery window ended without a resume. Acquire a new session.                                                                                                                                         |
| `device-restart:<device>`                                                                               | No         | The owner can resume the same UUID within the fixed 180 s recovery window. If it lapses unresumed, the session ends terminally as `restart-recovery-timeout`; an earlier idle deadline ends it as `expired` with `idle: true`.                                      |
| `superseded`                                                                                            | No         | Nothing: a newer incarnation of the same UUID holds the device.                                                                                                                                                                                                     |
| `plan-auto-release`                                                                                     | No         | The plan freed a device it acquired; caller-held sessions stay held. Naming the same session UUID in a later plan re-issues the session; another client may take the device in between. It is not rehydrated after a daemon restart.                                |
| `session-creation-timeout`, `allocation-rollback`, `device-disconnected-during-session-create:<device>` | No         | The session was never handed out; the UUID may be created again.                                                                                                                                                                                                    |
| `expired`                                                                                               | No         | A non-terminal row past its idle deadline: a control call naming it is refused with `session_ownership_lost`, reason `expired` and `idle: true`; heartbeat and `daemon/sessionInfo` answer `daemon_session_not_found`, `releaseReason: "expired"` and `idle: true`. |

## Stopping a held device: `killDevice` and `deleteDevice`

Only the holder may stop a device it holds. Stopping a booted device another
session holds gets `device_owned_by_other_session`, unless the call passes
`force: true`. Force stops the device and releases the holder. From the CLI:
`auto-mobile --cli killDevice --device '{...}' --force true`. Use it only when
the device really should be stopped out from under its holder.

- Naming the holder's `sessionUuid` from a connection that does not own that
  session is refused, with or without `force`. To force-stop the device, leave
  `sessionUuid` out.
- `force` never overrides another session's device-restart reservation (the
  refusal is retryable with `retryAfterMs`) or a broker binding's device.
- A device another live AutoMobile daemon holds gets
  `device_owned_by_other_daemon`. Stop it through that daemon, wait for it to
  release the device, or pass `force: true`.
- For a wedged Android emulator, `force` also skips the AVD-name comparison.
- `killDevice` stops an Apple Watch simulator too: pass `platform: "watchos"`
  and its UDID. It refuses a UDID that is not a watch simulator, and releases the
  watch's runner.
- A refused `deleteDevice` carries the same typed fields as a refused
  `killDevice`.

`deleteDevice` deletes an Apple Watch simulator with `target.platform: "watchos"`
and the watch's UDID as `target.stableId`. It stops a running watch first,
releasing any session on it. It succeeds once a fresh watch listing no longer
shows the watch.

| Result                       | When                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `already_absent`             | No watch simulator has that UDID; deletes nothing, even if it names another simulator |
| `identity_conflict`          | `target.stableName` differs from the watch's name                                     |
| `watch_delete_failed`        | `simctl delete` failed                                                                |
| `teardown_deadline_exceeded` | The call ran out of `timeoutMs`                                                       |

## Apple simulators

How sessions select, start and release Apple TV, Vision Pro and Apple Watch
simulators is in [Apple simulator sessions](device-ownership-apple.md).

## Streams need an observer registration, not a session

`subscribe`, `request_observation`, video and WebRTC viewing need a lightweight
observer registration, not a session. Tools need nothing, and streams need only
that registration. A viewer keeps streaming when ownership changes.

## Recordings

- A recording stops and finalizes within about 120 seconds of its session's
  release, idle releases included.
- Recording artifacts stay fetchable by id.
- Hiding a desktop or IDE window during a recording does not release the device.
- A video start from the connection holding a device belongs to that session,
  even when the call omits `sessionUuid`.
- Starting a device gesture recording on an unheld device gets
  `no_active_device_session`; acquire a session on that device first.
- An ownerless active recording keeps running when a session acquires its
  device, and that holder adopts it. Before then anyone can stop it; afterwards
  only the holder.

## Display and system settings between owners

AutoMobile does not restore display and system settings when a session releases
the device. It resets them when a different session next acquires the device:

- Before a session first changes a setting, AutoMobile records its current value
  as the device default. It does not record changes made while no session holds
  the device.
- A different session acquiring the device resets each recorded setting whose
  value differs from its default. The same session acquiring it again resets
  nothing. AutoMobile logs a failed reset and retries it at the next acquisition
  by another session.

| Tool                 | Covered settings                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayConfig`      | Font scale (content size category on the iOS Simulator), display density, night mode, increase contrast, reduce motion, bold text and Android display accessibility preferences |
| `changeLocalization` | 24-hour format and calendar system                                                                                                                                              |
| iOS Simulator        | Device-wide locale (Android locale changes are not covered)                                                                                                                     |

On Android, `displayConfig` also sets the runtime screen size, navigation mode
and display-cutout emulation. AutoMobile restores those when the session that
changed them releases the device or rebinds to another one. `displayConfig`
`reset` clears a leftover size override even after a daemon restart.

Appearance configuration is per session.

## Which read tools ready an unheld device

A sessionless read that names a running device nobody holds can set up CtrlProxy
(Android) or the runner (iOS simulator) so the read can answer. **Yes** means the
read does that setup. AutoMobile never readies a device another session or daemon
holds or reserves: reads use what is already installed, and control is refused.

| Tool                    | Android                                     | iOS simulator                               |
| ----------------------- | ------------------------------------------- | ------------------------------------------- |
| `accessibility`         | Yes                                         | Yes                                         |
| `captureAudio`          | No: booted-only verification                | No: booted-only verification                |
| `clipboard`             | Yes                                         | Yes                                         |
| `compareScreenshot`     | Yes                                         | Yes                                         |
| `displayConfig`         | Yes                                         | Yes                                         |
| `getAppPermissions`     | Yes                                         | Yes                                         |
| `getDataStore`          | Yes                                         | Yes                                         |
| `getDeepLinks`          | Yes                                         | Yes                                         |
| `getDeviceState`        | Yes                                         | Yes                                         |
| `getLogs`               | Yes                                         | Yes                                         |
| `getNavigationGraph`    | Yes                                         | Yes                                         |
| `getNetworkGraph`       | Yes                                         | Yes                                         |
| `getNotificationPolicy` | Yes                                         | Yes                                         |
| `getPreference`         | Yes                                         | Yes                                         |
| `hitTest`               | Yes                                         | Yes                                         |
| `identifyInteractions`  | Yes                                         | Yes                                         |
| `inspectPackageSigning` | No: booted-only verification                | No: booted-only verification                |
| `keyboard`              | Yes                                         | Yes                                         |
| `listApps`              | No: booted-only verification                | No: booted-only verification                |
| `listDataStores`        | Yes                                         | Yes                                         |
| `mediaSession`          | No: booted-only verification                | No: booted-only verification                |
| `observe`               | Own path: may start the service (see below) | Own path: may start the service (see below) |
| `prototype`             | Yes                                         | Yes                                         |
| `snapshotOf`            | Yes                                         | Yes                                         |
| `sqlQuery`              | Yes                                         | Yes                                         |
| `statusBar`             | Yes                                         | Yes                                         |

## Related

- [Environment variables](environment-variables.md#session-heartbeat-timeout):
  session release and idle windows.
- [FAQ](../faq.md#what-if-i-have-more-than-one-device).
