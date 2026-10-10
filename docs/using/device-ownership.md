# Device ownership

A device that a session holds takes calls only from that session. Acquiring a
device with `getAndroid`, `getApple` or `startDevice` creates the session and
returns its `sessionUuid`; the session holds the device until it is released
(idle timeout, lost heartbeat, or an explicit release).

## What is refused

A call that acts on a held device is refused with the typed code
`device_owned_by_other_session` when it:

- carries no `sessionUuid` (a sessionless call, such as a plain `--cli tapOn`),
- names a different session than the holder, or
- is an `input/*` socket frame without the holder's `sessionUuid`
  (see [screen control](screen-control.md)).

A derived `<base>:<label>` session counts as its base session. A device that no
session holds takes calls from anyone.

Reads stay allowed on any device, whichever session holds it, and need no
session (owner decisions 2026-10-09, #10965). Anything that changes visible UI
or starts a device-side process is control. Reads: `observe`, `snapshotOf`,
`hitTest`, `identifyInteractions`, `listApps`, `getDeviceState`,
`getNetworkGraph`, `getPreference`, `listDataStores`, `getDataStore`,
`getAppPermissions`, `getNotificationPolicy`, `getDeepLinks` and
`getNavigationGraph`. Mixed tools are classified per call: `keyboard`
detect/listImes/listProfiles, `clipboard` get, `displayConfig` with no set field,
`accessibility` with no toggle, `prototype` status/inspect, and a single
read-only `sqlQuery` statement are reads; their other forms, `systemTray`,
`videoRecording` and `deviceSnapshot` are control. Viewer video streaming stays
an open read. A read is
never use, not even the holder's own (#10964): it does not extend the session's
idle window. Only control calls do, including a holder's calls that name only
`deviceId`, which run as the holder's session.

## When a session is released

A session is released by an explicit release, a lost owner heartbeat, or the idle
window. Values below are the defaults; the constants live in
`src/daemon/sessionLivenessWindows.ts` and are tuned with the variables in
[Environment variables](environment-variables.md#session-heartbeat-timeout).

- **Lost heartbeat.** The owning connection's heartbeat renews a lease of
  `DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS` (4 s), followed by a suspect grace of
  `SUSPECT_GRACE_MS` (4 s). With the 2 s expiry sweep, a session is released about
  10 s after its owner's last heartbeat. The lease is judged on the owner's own
  heartbeats only: tool calls from other callers do not keep a dead owner alive.
- **Idle.** `DEFAULT_SESSION_IDLE_TIMEOUT_MS` (2 min) after the last control tool
  call ends. The grace does not stretch it: a heartbeating session is released at
  the idle deadline. Heartbeats and reads (`observe`, `listDevices`, `doctor`,
  `recordSteps` status and the other reads listed above) never extend it. A call
  still in flight holds the release, up to a bounded ceiling.
- **`idleReleaseAt`** is the idle deadline as wall-clock epoch milliseconds. The
  daemon computes it (session-clock instants are converted to wall time at the
  daemon boundary), reports it in the session hold diagnostics and the heartbeat
  acknowledgement, and clients should treat it as authoritative rather than
  computing their own deadline.
- **One owning connection per session.** Restoring a session on a connection
  requires that session's owner token (the proxy sends it with the sessions it
  owns), or that no other connected client owns it; otherwise the call is refused
  with `device_owned_by_other_session`. A successful restore moves ownership, so
  the previous connection no longer owns the session.

## One-shot CLI sessions

Each `--cli` call is its own connection, so the daemon treats one-shot CLI
acquisitions as anonymous (#11096):

- A one-shot CLI `getAndroid`, `getApple` or `startDevice` creates an anonymous
  session and may reuse only an anonymous session. A second `--cli getAndroid` for
  the same device reuses it (also by `--avd-name`, #11138). The CLI does not reuse a session an MCP connection holds.
- Acquisition tools drop `--session-uuid` on the CLI. Skip re-acquiring and pass
  `--session-uuid` on the follow-up calls, or free the device with
  `--daemon release-session`.
- A CLI session's idle window runs from tool calls. `--daemon heartbeat` on a
  one-shot CLI session is a successful no-op, so keeper processes are unnecessary.

## Refusals that name the next step

- A call naming a session that is gone for good (`session_ownership_lost`,
  `no_active_device_session`) is refused with `retryable: false` and
  `nextAction: "acquire_new_session"` (`ACQUIRE_NEW_SESSION_NEXT_ACTION` in
  `src/models/deviceSessionRecovery.ts`, #11098). Acquire a new session with
  `getAndroid` or `getApple`; retrying the same UUID cannot succeed.
- Booted-device discovery that did not complete (adb or simctl failed, or a
  running emulator's AVD identity has not resolved) is refused with the retryable
  code `discovery_incomplete` instead of booting or adopting a device blind. Retry
  the acquisition.

## A device that drops off

For Android, the disconnect monitor holds a session on a device adb still lists
but reports `offline` for up to `OFFLINE_DEVICE_DISCONNECT_BUDGET_MS` (60 s,
`src/daemon/disconnectMonitor.ts`, #11090) before treating it as lost. A held
device in that state still appears in `listDevices` with its session and
connection state (#11118). A physical USB device that vanishes from `adb devices`
in every state is released on the first miss; one still listed in a transitional
state (`offline`, `authorizing`, `connecting`, `unauthorized`, `recovery`,
`bootloader`, `sideload`, no permissions) keeps the normal multi-sweep debounce.
When one handset is reachable over both USB and Wi-Fi, the pool treats the
endpoints as aliases of one device only when `ro.serialno` and boot identity prove
it, and two emulators that merely share an AVD name are never merged.

## Daemon restart

The restarted daemon stamps itself as owner of every session it rehydrates (#11114),
so a later peer daemon does not mistake them for a dead predecessor's. Each
rehydrated session gets a fresh idle window; a session already past its deadline
at restart is not rehydrated. A release whose database write had not landed is
recorded first in a crash-safe sidecar (`terminal-release-intents.jsonl` in the
daemon data directory, `src/daemon/terminalReleaseJournal.ts`), and the restarted
daemon finishes it before rehydrating, so a released UUID is never revived.

## Planned: device state between owners

Display and system settings a session changed are not yet reset when a different
session next acquires the device. Resetting them at that acquisition is planned
and tracked in #11145; until it lands, restore settings explicitly before
releasing.

## Passing the session

- **CLI:** `auto-mobile --cli --session-uuid <uuid> tapOn --selector '{"text":"Submit"}'`.
  Use the `sessionUuid` from the `getAndroid`, `getApple` or `startDevice` result.
  The CLI prints the daemon's message and a hint on stderr and exits 1.
- **MCP:** a connection that acquired a device is bound to it, so its calls route
  to the session without repeating it. A different connection passes `sessionUuid`
  in the call arguments.
- **`scripts/mcp-drive.ts`:** a `getAndroid`/`getApple` step captures the session
  and injects it into later steps; `--session <uuid>` reuses an existing one.
- **Scripts that run `--cli` calls:** keep the acquiring call's `sessionUuid` and
  pass `--session-uuid` on every later call (see
  `scripts/android/navigation-graph-sdk-event-integration.sh`).

## Stopping a held device: `killDevice` and `deleteDevice`

Both stop a running device, so the same rule applies: only the holder (or the
MCP connection that owns an autolocked device) may stop it. A booted device
another session holds is refused with `device_owned_by_other_session` unless the
call passes `force: true`, which overrides the refusal and logs a warning naming
the holder. From the CLI: `auto-mobile --cli killDevice --device '{...}' --force true`.

`force` keeps its older meaning too: for a wedged Android emulator it also skips
the AVD-name comparison. Use it only when the device really should be stopped
out from under its holder. Deleting a stopped image is not affected, since no
session can hold it.

## Ownership is cooperative

Ownership is a guard that protects cooperating clients from each other's
mistakes. It is not a security boundary against other local processes (owner
decision 2026-10-09, #10982). Any local client can list every session UUID
(`daemon/activeSessions` with `includeSessions`), release any session
(`daemon/releaseSession` checks no requester), and edit any session's tool
profile (`ide/setSessionToolEnabled`). That is intended, and there is no token
gating.

## Read and control

Owner decisions 2026-10-09 (#10982):

- Read-only access never requires a session.
- No read counts as activity, not even the owner's own (#10964).
- Anything that changes visible UI, or starts a device-side process, is control.
- Viewer streaming is a read.
- A read on a free device may run full readiness. A read on a held device is
  connect-only.
- Reads run in their own lane (#10969).
- A holder's calls that name only a `deviceId` are credited to the MCP connection
  that owns the held session, and admitted as that session. Other connections
  stay read-only watchers.

## Streams need an observer registration, not a session

`subscribe`, `request_observation`, video and WebRTC viewing still require a
lightweight observer registration (owner decision 2026-10-09, #10982). An
observer registration is not a session: tools need nothing, and streams need only
that registration. A viewer keeps streaming when ownership changes (#8902).

## Recordings

Owner decisions 2026-10-09 (#10982):

- A recording stops and finalizes when its session is released, capped at about
  120 seconds (#10957). This also covers an idle release (#10826).
- A recording with no owner stops when a session acquires the device (#10961).
- Recording artifacts stay fetchable by id (#10958).
- Hiding a desktop or IDE window during a recording does not release the device.

## Retryable acquisition refusals

An acquisition the daemon cannot grant yet is refused with a typed, retryable
code (owner decision 2026-10-09, #10982): `device_cleanup_in_progress` while the
device is still being released (#10960), and `device_owned_by_other_daemon` when
another daemon holds it. Clients may wait and retry.

A session UUID whose device is being killed is refused with
`session_terminal_release_in_progress` and `retryable: false` (#11189): the
UUID ends with that release, so retrying under it cannot succeed. Acquire the
device again under a new session. A kill that races the session's own rebind is
refused with `session_rebinding` (`retryable: true`, with `retryAfterMs`), and a
kill naming a device the session has left with `session_no_longer_owns_device`
(`retryable: false`; check who holds the device before killing it).

## Boot capacity

Cold boots are admitted against host capacity (owner decision 2026-10-09,
#11181, #11209). Each
platform has its own limit on booted devices: the smaller of half the host RAM
divided by the measured per-device memory and half the CPU cores, at least 1.
Every booted emulator or simulator counts, including ones started outside
AutoMobile. A boot that would go over the limit is not queued: it fails at once
with the retryable code `capacity_exhausted`, which carries `retryAfterMs`,
`limit`, `booted`, `platform` and, when emulators AutoMobile did not start occupy
slots, `externalDevices` (the message names them and the
`AUTOMOBILE_<PLATFORM>_MAX_BOOTED` / `AUTOMOBILE_BOOT_CAPACITY_GATE=0` escape
hatches). Adopting an emulator or simulator that is already running never fails
this way. `listDevices` reports `capacity` per gated platform as
`{ limit, booted, inFlight }`. See
[environment variables](environment-variables.md#boot-capacity) for the opt-out
and the per-platform overrides.

## Per-session settings

Appearance configuration is per session (owner decision 2026-10-09, #10982).

## Display and system settings between owners

Display and system settings a session changes are not restored when it
releases the device. They are reset when a different session next acquires the
device (owner decision 2026-10-09, #11145):

- Before a session first changes a setting on a device, the daemon records the
  setting's current value as the device default. Later changes keep the first
  recorded value. Changes made with no session holding the device are not
  recorded.
- The covered settings are font scale, display density and night mode
  (`displayConfig`), and the 24-hour format and calendar system
  (`changeLocalization`). The iOS Simulator device-wide locale is also covered.
  Android locale changes are not: on Android 13 and later they apply per app,
  and the older device-wide path needs root and a framework restart.
- When a different session acquires the device, each recorded setting whose
  current value differs from its default is reset, and the record is cleared.
  The same session acquiring the device again resets nothing.
- The reset runs in the background while the new session starts. A setting that
  fails to reset is logged and stays recorded, so the next acquisition by
  another session tries again. A failed reset does not quarantine the device.
- Records are stored in the daemon database, so they survive a daemon restart.

## Related

- [Environment variables](environment-variables.md#session-heartbeat-timeout):
  session release and idle windows.
- [FAQ](../faq.md#what-if-i-have-more-than-one-device).
