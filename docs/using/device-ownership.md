# Device ownership

A device that a session holds takes control calls only from that session.
Acquiring a device with `getAndroid`, `getApple` or `startDevice` creates the
session and returns its `sessionUuid`; the session holds the device until it is
released (idle timeout, lost heartbeat, or an explicit release).

## Passing the session

- **MCP:** a connection that acquired a device is bound to it, so its calls route
  to the session without repeating it. A different connection passes
  `sessionUuid` in the call arguments; while the acquiring connection is still
  connected, that works for reads only.
- **CLI:** each `--cli` call is its own connection. Use the `sessionUuid` from the
  acquisition result on every later call:
  `auto-mobile --cli --session-uuid <uuid> tapOn --selector '{"text":"Submit"}'`.
  A second `--cli getAndroid` for the same device reuses the anonymous session.
  Free the device with `--daemon release-session`. `--daemon heartbeat` on a
  one-shot CLI session is a successful no-op, so keeper processes are
  unnecessary.
- **Default session:** only `setActiveDevice` or an acquisition changes the
  session that untargeted calls run on. An explicit `sessionUuid` targets that
  one call only. A call passing only `platform` runs on the default session when
  the platform matches.

If you hold two sessions and the default one ends, a control call that passes the
surviving session's `sessionUuid` or `deviceId` runs on that session. A control
call with only `platform`, an unmatched `deviceId`, or no selector is refused
with `no_active_device_session`. Call `setActiveDevice` or acquire a new
session.

## What is refused

A control call on a held device is refused with `device_owned_by_other_session`
when it carries no `sessionUuid` (a plain `--cli tapOn`, for example), names a
different session than the holder, or names the holder's session from another
connection while the owner is still connected. Naming a session's UUID never
takes it over. Once the owner has disconnected (a finished `--cli` call, for
example) another connection may name the session. A device that no session holds
takes calls from anyone.

Other refusals you may meet, and what to do:

| Code                                                 | Meaning and next step                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ambiguous_session_selector`                         | Several of your sessions match; pass `sessionUuid` or `deviceId`.                                                       |
| `ambiguous_device_target`                            | An unnamed call matched several devices; reads pass `deviceId`, control calls acquire a session and pass `sessionUuid`. |
| `device_outside_bound_session`                       | The call names a `deviceId` other than the session's device.                                                            |
| `plan_execution_in_progress` (retryable)             | A plan is running; retry when it finishes. Reads stay allowed.                                                          |
| `session_ownership_lost`, `no_active_device_session` | The session is gone for good (`retryable: false`, `nextAction: "acquire_new_session"`). Acquire a new session.          |
| `session_released_during_creation`                   | The session was released before it finished creating. Acquire a new one.                                                |
| `daemon_session_suspect` (retryable)                 | The owner's heartbeat is late; retry now.                                                                               |
| `session_held_by_recovery` (retryable)               | Device recovery is in flight; retry after `retryAfterMs`.                                                               |
| `discovery_incomplete` (retryable)                   | `adb` or `simctl` listing failed, so AutoMobile will not boot or adopt a device blind. Retry.                           |
| `device_owned_by_other_daemon` (retryable)           | Another AutoMobile daemon holds the device. Stop it there, wait, or choose another device.                              |
| `device_assigned_to_binding`                         | A broker binding holds the device; use another device.                                                                  |

When a refusal carries `retryAfterMs`, wait that long before retrying.
Refusals do not count as session use and do not extend the session's idle window.

### Reads and control

Read-only calls never need a session and never count as activity, even for the
holder. Anything that changes visible UI or starts a device-side process is
control.

- Reads include `observe`, `snapshotOf`, `hitTest`, `identifyInteractions`,
  `listApps`, `getDeviceState`, `getNetworkGraph`, `getPreference`,
  `listDataStores`, `getDataStore`, `getAppPermissions`,
  `getNotificationPolicy`, `getDeepLinks` and `getNavigationGraph`.
- Mixed tools are classified per call: `keyboard` detect/list calls, `clipboard`
  get, `mediaSession` get, `displayConfig` with no set field, `accessibility`
  with no toggle, `prototype` status/inspect and a single read-only `sqlQuery`
  statement are reads. Their other forms, `systemTray`, `videoRecording` and
  `deviceSnapshot` are control.
- A sessionless read without `deviceId` uses an already-running device and never
  boots one. If none is running it answers that there is nothing to read: start
  one with `startDevice` or `provisionDevice`, or pass a `deviceId`.
- A sessionless read that passes `deviceId` may boot that stopped device (an
  Android AVD name or an available iOS simulator UDID) and never creates one.
  Boot capacity limits still apply.
- Ownership is a guard between cooperating clients, not a security boundary
  against other local processes.

## When a session is released

A session is released by an explicit release, a lost owner heartbeat, the idle
window, the owning connection closing, or the device being killed or lost. Tune
the windows with the variables in
[Environment variables](environment-variables.md#session-heartbeat-timeout).

- **Lost heartbeat.** A session whose owner stops heartbeating is released after
  roughly ten seconds. Calls from other callers do not keep a dead owner alive.
- **Idle.** A session is released after 2 minutes (default) with no control call.
  Heartbeats and reads do not extend the window; a control call still running
  holds the release until it finishes.
- **Terminal releases.** A released session UUID is never revived. A later call
  naming it is refused with `session_ownership_lost`, `retryable: false` and
  `nextAction: "acquire_new_session"`. After an idle release the refusal also
  carries `idle: true`. A call still running when its session is released is cut
  with the same refusal.
- **Daemon restart.** A daemon restart is not terminal: the owner reclaims the
  session under the same UUID. While the daemon reclaims the binding, calls may
  receive the retryable `binding_ownership_unconfirmed`; wait `retryAfterMs`.
  If ownership cannot be confirmed in about a minute the session is released and
  calls get `session_ownership_lost`.
- **Device restart.** When a device restarts, its session can resume under the
  same UUID for 180 seconds; other sessions cannot take that device meanwhile
  (a start naming it is refused with a retry hint). If the window passes without
  a resume the session ends with `session_ownership_lost`.
- **Device killed or lost.** The session ends with `session_ownership_lost`;
  while a kill is running, calls get `session_terminal_release_in_progress`
  (`retryable: false`). Acquire the device again under a new session.
- **Plan labels.** A multi-device plan runs its extra labels on derived
  `<base>:<label>` sessions that live only as long as the plan run and end with
  the base session. The next plan run mints them again; do not create
  `<base>:<name>` sessions yourself.

## Stopping a held device: `killDevice` and `deleteDevice`

Only the holder may stop a device it holds. A booted device another session
holds is refused with `device_owned_by_other_session` unless the call passes
`force: true`, which stops the device and releases the holder. From the CLI:
`auto-mobile --cli killDevice --device '{...}' --force true`. Use it only when
the device really should be stopped out from under its holder.

- Naming the holder's `sessionUuid` from a connection that does not own that
  session is refused, with or without `force`. To force-stop the device, leave
  `sessionUuid` out.
- `force` never overrides another session's device-restart reservation (the
  refusal is retryable with `retryAfterMs`) or a broker binding's device.
- A device another live AutoMobile daemon holds is refused with
  `device_owned_by_other_daemon`: stop it through that daemon, wait for it to
  release the device, or pass `force: true`.
- For a wedged Android emulator, `force` also skips the AVD-name comparison.
- A refused `deleteDevice` carries the same typed fields as a refused
  `killDevice`.

## A device that drops off

An Android device that `adb` still lists as `offline` stays held for up to 60
seconds before it counts as lost, and still appears in `listDevices` with its
session and connection state. A physical USB device that vanishes from
`adb devices` entirely is released at once.

A phone reachable over both USB and Wi-Fi is one device: a call may name it by
either endpoint, or an emulator by its `localhost:<port>` address, and is judged
exactly as if it named the canonical id. If a transport cannot be identified and
a held device could be its alias, a control call is refused with
`device_owned_by_other_session`; address the device by its USB serial or
`emulator-NNNN` id. If the `adb devices` listing itself fails, a control call
naming a wireless address AutoMobile has not seen is refused with the retryable
`discovery_incomplete`.

### Transient Android transport failures

An `adb` transport failure on a session-owned device returns
`device_transport_unavailable` with `retryable: true`, `retryAfterMs`, `deviceId`
and `dispatched`.

- `dispatched: false`: `adb` refused the command before dispatch. AutoMobile
  already retried briefly; retrying is safe.
- `dispatched: "unknown"`: the transport dropped after dispatch, so the command
  may have run. Observe before reissuing a non-idempotent action, especially an
  `openLink` with a single-use sign-in link.

## Retryable acquisition refusals

An acquisition AutoMobile cannot grant yet is refused with a typed, retryable
code; wait and retry:

- `device_cleanup_in_progress`: the device is still being released. `retryAfterMs`
  says how long cleanup can take. The CLI and MCP proxy poll this for you.
- `device_owned_by_other_daemon`: another daemon holds the device.
- `device_shutting_down`: the device is stopping.
- `device_offline`: an exact Android device stayed `offline` or `unauthorized`
  after a short wait.
- `session_rebinding`: a kill raced the session's own rebind.
- `device_unhealthy`: a health marker refuses the device. `devices` lists each
  unhealthy candidate with its `deviceId`, `reason` and `recovering` state. While
  `retryable` and `recovering` are true, wait (honouring `retryAfterMs` when
  present). When recovery ends with the marker kept, the refusal is
  non-retryable: replace the device with `killDevice` then `startDevice`.
  Reads stay allowed on marked devices.
- `orphan_recorder_active`: a leftover screen recorder could not be confirmed
  stopped. Retry, or stop it by recording id.
- `setActiveDevice` on a device another request is still preparing is refused
  with a retryable `device_owned_by_other_session` and `retryAfterMs: 2000`.

A kill naming a device the session has already left is refused with
`session_no_longer_owns_device` (`retryable: false`); check who holds the device
before killing it.

## Device status in listings

`listDevices` and the device resources report one status per device. A device
that cannot be lent out is `assigned`, not `idle`: that covers a device with a
session, one that is shutting down or still becoming ready, one held by a broker
binding or another daemon, and an idle device with an unhealthy marker. A device
in error stays `error`. `idle + assigned + error` equals the total.

## Boot capacity

Cold boots are admitted against host capacity. Each platform has its own limit on
booted devices: the smaller of half the host RAM divided by the measured
per-device memory and half the CPU cores, at least 1. Every booted emulator or
simulator counts, including ones started outside AutoMobile. A boot over the
limit is not queued: it fails at once with the retryable `capacity_exhausted`,
which carries `retryAfterMs`, `limit`, `booted`, `platform` and, when relevant,
`externalDevices` (running devices AutoMobile did not start) and `heldDevices`
(iOS simulators held by AutoMobile sessions or bindings; release the session
first rather than shutting them down). Adopting an already-running device never
fails this way. `listDevices` reports `capacity` per platform as
`{ limit, booted, inFlight }`. If the booted count cannot be read, the boot is
refused with `discovery_incomplete`. See
[environment variables](environment-variables.md#boot-capacity) for the opt-out
and per-platform overrides.

### Which read tools ready an unheld device

A sessionless read that names a running device nobody holds can set up CtrlProxy
(Android) or the runner (iOS simulator) so the read can answer. **Yes** means the
read does that setup. A device held or reserved by another session or daemon is
never readied: reads use what is already installed, and control is refused.

| Tool                    | Android                                     | iOS simulator                               |
| ----------------------- | ------------------------------------------- | ------------------------------------------- |
| `accessibility`         | Yes                                         | Yes                                         |
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

## Streams need an observer registration, not a session

`subscribe`, `request_observation`, video and WebRTC viewing need a lightweight
observer registration, not a session. Tools need nothing, and streams need only
that registration. A viewer keeps streaming when ownership changes.

## Recordings

- A recording stops and finalizes when its session is released, including an idle
  release, within about 120 seconds.
- Recording artifacts stay fetchable by id.
- Hiding a desktop or IDE window during a recording does not release the device.
- A video start from the connection holding a device belongs to that session,
  even when the call omits `sessionUuid`.
- Starting a device gesture recording on an unheld device is refused with
  `no_active_device_session`; acquire a session on that device first.
- An active recording with no owner keeps running when a session acquires its
  device: the acquiring holder adopts it. Until then it can be stopped
  sessionless; afterwards only the holder can stop it.

## Display and system settings between owners

Display and system settings a session changes are not restored when it releases
the device. They are reset when a different session next acquires the device:

- Before a session first changes a setting, AutoMobile records its current value
  as the device default. Changes made with no session holding the device are not
  recorded.
- Covered settings: font scale (content size category on the iOS Simulator),
  display density, night mode, the increase contrast, reduce motion, bold text
  and Android display accessibility preferences (`displayConfig`), the 24-hour
  format and calendar system (`changeLocalization`), and the iOS Simulator
  device-wide locale. Android locale changes are not covered.
- A different session acquiring the device resets each recorded setting whose
  value differs from its default. The same session acquiring it again resets
  nothing. A failed reset is logged and retried at the next acquisition by
  another session.

The runtime screen size, navigation mode and display-cutout emulation that
`displayConfig` sets on Android are restored when the session that changed them
releases the device or rebinds to another one. `displayConfig` `reset` clears a
leftover size override even after a daemon restart.

Appearance configuration is per session.

## Related

- [Environment variables](environment-variables.md#session-heartbeat-timeout):
  session release and idle windows.
- [FAQ](../faq.md#what-if-i-have-more-than-one-device).
