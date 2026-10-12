# Device ownership

A device that a session holds takes calls only from that session. Acquiring a
device with `getAndroid`, `getApple` or `startDevice` creates the session and
returns its `sessionUuid`; the session holds the device until it is released
(idle timeout, lost heartbeat, or an explicit release).

## What is refused

A call that acts on a held device is refused with the typed code
`device_owned_by_other_session` when it:

- carries no `sessionUuid` (a sessionless call, such as a plain `--cli tapOn`),
- names a different session than the holder,
- is a tool call that names the holder's session while another connected client
  owns that session (#11344), or
- is an `input/*` socket frame without the holder's `sessionUuid`
  (see [screen control](screen-control.md)).

Bind and selection refusals stay non-retryable while an ordinary live owner holds
its device. When the daemon has armed an owner-disconnect release, the owner's
lease is suspect, or release is already in flight, the refusal is retryable and
includes `retryAfterMs`: the remaining grace or a short poll hint while cleanup
runs, bounded to the owner lease plus suspect grace. Refusal does not renew the
holder's clocks or delay release (#11920).

A derived `<base>:<label>` session counts as its base session, for the holder
check and for the owning connection alike: while the base's owner is connected,
another connection's control call naming the derived session, or reaching one of
the owner's devices through a `device` label, is refused (#11542). The same holds
wherever ownership is recorded: restoring a derived session is restoring its
base, so it is refused while another connection owns the base, and it never
takes a label away from the base's owner (#11586). A heartbeat that
claims liveness ownership of a derived session is judged against the base's
liveness owner as well: another token cannot claim or adopt a label while the
base owner's lease is live or in its grace, the owner holding the base is never
refused on its label, and a label's current owner is never refused its own
re-claim. A refused claim reports the hold it was refused for, the base owner's
when the label's own owner holds nothing. The label keeps its own liveness
record, so a token
claimed on a label proves nothing about its base (#11602). A connection bound to
the base session, or to one of its labels, may name any live session of that
plan directly as `sessionUuid`; a name the base has not published, or a label
that is not allocated, is still refused as a different session. A connection
seeded with the base is judged the same way. A proxy started with
`--initial-session-uuid <base>` has no label map, so it forwards a
`<base>:<name>` call for the daemon to judge like any explicitly named session:
by issued-session admission and the owner rule, not by the proxy's binding.
None of these judgements holds, extends or releases a session, and neither does
any other lookup that goes from a label to its base, the one a device tool call
naming only `<base>:<name>` makes to route itself and pick its tools included
(#11640). A base past its idle deadline that the scan has not reached yet
publishes no labels, and is released by the scan or by a call that names it,
never by a lookup about its label. The base's end ends its labels (#11640): see
[Plan label sessions](#plan-label-sessions). A device that no session holds
takes calls from anyone.

A session's owner is the connection that acquired it, or that restored it after
a reconnect. Ownership is cooperative: naming a session's UUID never takes it over.
A proxy's bound-session marker is honoured for another connected owner's session
only with its recorded liveness owner token; tokenless sessions retain the existing
bound-session behaviour (#11555 item 3). The token is stored with the session and survives a daemon
restart; the Android JUnit runner sends one on tool calls and HTTP heartbeats. While the owner is connected, a control call from any
other connection that names the session is refused, with autolock on or off, and
that connection is never bound to the session. The rule covers control tools
that take no device routing too (`killDevice`, `deleteDevice`, `exportPlan`,
`recordToolCalls` start and stop): the refused call does not run and does not extend the session's
idle window (#11542). A plan step, or a tool another tool calls, is judged by the
same rule as a direct call from the connection that started it (#11469, #11555).
`setToolEnabled` is not refused (see
[Ownership is cooperative](#ownership-is-cooperative)), but naming a session is
never use of it: while the owner is connected, no call from another connection
extends the session's idle window, counts as its liveness, or binds that
connection to it (#11555). The rule judges the session a call names. A proxy
started with `--initial-session-uuid` declares that session as its own binding
and its calls then name none, so they are not judged by this rule; its claim is
governed by liveness ownership instead (see
[environment variables](environment-variables.md)). Once the owner has disconnected
(a finished `--cli` call, for example) another connection may name the session.

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
`deviceId`, which run as the holder's session. A control call that is refused
before it runs is not use either: a call that names a `deviceId` other than its
session's device (`device_outside_bound_session`), or whose device cannot be
driven (lost, recovering, shutting down), leaves the idle window where it was
(#11558).

When a platform-only control call matches several known sessions this MCP
connection holds, `ambiguous_session_selector` lists those sessions and asks for
`sessionUuid` or `deviceId`. This non-retryable refusal leaves their idle windows
unchanged; read-only tools and device-binding calls (such as `setActiveDevice`) keep their usual routing.

## When a session is released

A session is released by an explicit release, a lost owner heartbeat, or the idle
window, among the other reasons in [Release reasons](#release-reasons). Values
below are the defaults; the constants live in
`src/daemon/sessionLivenessWindows.ts` and are tuned with the variables in
[Environment variables](environment-variables.md#session-heartbeat-timeout).

- **Lost heartbeat.** The owning connection's heartbeat renews a lease of
  `DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS` (4 s), followed by a suspect grace of
  `SUSPECT_GRACE_MS` (4 s). With the 2 s expiry sweep, a session is released about
  10 s after its owner's last heartbeat. The lease is judged on the owner's own
  heartbeats only: tool calls from other callers do not keep a dead owner alive.
  The release is terminal: the client then sees `session_ownership_lost` with
  `retryable: false` and `nextAction: "acquire_new_session"` (#11315, #11372).
  A control call that arrives after the lease and grace have lapsed but before the
  expiry sweep runs is refused with that terminal refusal at once, and the session
  is released. A control call in the suspect grace gets the retryable
  `daemon_session_suspect` refusal instead: retry it now.
- **Reads and a lapsing session.** A read is never refused, not even in the
  suspect window, and it never holds a session: for a lost heartbeat, a missing
  first heartbeat, any idle release or an owner-disconnect release, a read in flight
  neither holds nor extends the release (#11372, #11381). The same release cuts
  a read still running and answers it with the typed terminal refusal (#11384).
- **Idle.** `DEFAULT_SESSION_IDLE_TIMEOUT_MS` (2 min) after the last control tool
  call ends. An idle release is terminal: the session UUID ends with it. The
  grace does not stretch it: a heartbeating session is released at the idle
  deadline. Heartbeats and reads (`observe`, `listDevices`, `doctor`,
  `recordToolCalls` status and the other reads listed above) never extend it. Only a control
  call still in flight holds the release, until its request deadline plus 10 s
  (or the 30 min ceiling without a deadline). A read in flight never holds it;
  the release cuts the read with the typed terminal refusal `session_ownership_lost`.
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

### Release reasons

Every release records one reason. The daemon classifies them in one table,
`src/daemon/releaseReasons.ts` (#11258). A terminal release ends the session
UUID for good: it is recorded in the crash-safe journal before its database row,
it is never rehydrated after a restart, and a later call naming the UUID is
refused with `session_ownership_lost`, `retryable: false` and `nextAction:
"acquire_new_session"`. A live idle release is terminal, whatever the session's
liveness policy (heartbeat, one-shot CLI or managed execution; owner decision
2026-10-09).

| Reason                                                                                                  | Terminal?  | What the client sees                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `explicit-release`                                                                                      | Yes        | `session_ownership_lost`; acquire a new session.                                                                                                                                                                                                                    |
| `cleanup-expired` (legacy: `lazy-expiry`)                                                               | Yes (idle) | `session_ownership_lost` refusals and session-not-found answers (heartbeat, `daemon/sessionInfo`) carry `idle: true`. Acquire a new session.                                                                                                                        |
| `cli-idle-timeout`                                                                                      | Yes (idle) | `session_ownership_lost` refusals and session-not-found answers (heartbeat, `daemon/sessionInfo`) carry `idle: true` for a one-shot CLI session.                                                                                                                    |
| `heartbeat-timeout`, `missing-first-heartbeat`                                                          | Yes        | `session_ownership_lost`, with the heartbeat age and limit in the message.                                                                                                                                                                                          |
| `rehydration-owner-timeout`                                                                             | Yes        | `session_ownership_lost`: a rehydrated session's owner never reclaimed it.                                                                                                                                                                                          |
| `owner-disconnected`                                                                                    | Yes        | `session_ownership_lost`: the owning connection closed and no other client owns the session.                                                                                                                                                                        |
| `device-killed` (also a sessionless stop of the device a handed-off session was waiting for)            | Yes        | `session_terminal_release_in_progress` while the kill runs, then `session_ownership_lost`.                                                                                                                                                                          |
| `device-disconnected:<device>`                                                                          | Yes        | `session_ownership_lost`: the device was lost.                                                                                                                                                                                                                      |
| `identity-recovery-<reason>`                                                                            | Yes        | `session_ownership_lost` with `recoveryReason` and `deviceId` (and `ownerPid` when another daemon holds the device): restart recovery could not prove the device's identity (#11414).                                                                               |
| `session-creation-cancelled`                                                                            | Yes        | `session_ownership_lost`: the creation was cancelled before the session was handed out.                                                                                                                                                                             |
| `daemon-shutdown`, `daemon-restart`                                                                     | No         | The restarted daemon rehydrates the session; its owner reclaims it under the same UUID.                                                                                                                                                                             |
| `restart-recovery-timeout`                                                                              | Yes        | `session_ownership_lost`, without `idle`: the device-restart recovery window ended without a resume. Acquire a new session.                                                                                                                                         |
| `device-restart:<device>`                                                                               | No         | The owner can resume the same UUID within the fixed 180 s recovery window. If it lapses unresumed, the session ends terminally as `restart-recovery-timeout`; an earlier idle deadline ends it as `expired` with `idle: true`.                                      |
| `superseded`                                                                                            | No         | Nothing: a newer incarnation of the same UUID holds the device.                                                                                                                                                                                                     |
| `plan-auto-release`                                                                                     | No         | The plan freed the device. Naming the same session UUID in a later plan re-issues the session; another client may take the device in between. It is not rehydrated after a daemon restart.                                                                          |
| `session-creation-timeout`, `allocation-rollback`, `device-disconnected-during-session-create:<device>` | No         | The session was never handed out; the UUID may be created again.                                                                                                                                                                                                    |
| `expired`                                                                                               | No         | A non-terminal row past its idle deadline: a control call naming it is refused with `session_ownership_lost`, reason `expired` and `idle: true`; heartbeat and `daemon/sessionInfo` answer `daemon_session_not_found`, `releaseReason: "expired"` and `idle: true`. |

`idle` sits beside the reason it qualifies: `error.reason`/`error.idle` in an MCP envelope
(including `no_active_device_session` and `managed_execution_ended`),
`details.reason`/`details.idle` in a typed failure frame, or top-level `releaseReason`/`idle`
on a not-found answer. It also sits beside `executionEnded.reason` as `executionEnded.idle`
in the managed-slots resource, beside `boundSessionLoss.reason` as `boundSessionLoss.idle`
in a failed daemon-socket response, and beside `reason` as `idle` in the
`notifications/session/released` push. It is only ever `true` and is absent otherwise; a heartbeat lapse
(`heartbeat-timeout`, `missing-first-heartbeat`) never carries `idle`. For `expired`, `idle: true`
means the row's idle deadline passed with no daemon holding the session: time the daemon was
down counts toward the window, and no heartbeat was judged during it.

The proxy also retires its own idle binding. A daemon-confirmed idle end uses
`cleanup-expired`. An end known only from the proxy's clock uses `replay-lease-expired`
with `idle: true`. The proxy’s clock is the only judge for a session this connection named
in a call but does not heartbeat, or a daemon that has not reported an idle-release instant for it.
This reason is proxy-local: the daemon session may still be live or
have ended otherwise. The daemon's reason replaces it when a session-released notification arrives.

A call still running when its session is released (heartbeat reap, idle sweep,
owner disconnect or explicit release) is cut and answered with
`session_ownership_lost`, `retryable: false` and `nextAction:
"acquire_new_session"`, carrying its own session id (#11384, #11429). The
requester of an explicit release is not cut. A derived `<base>:<label>` session
released alone does not tell its live base session's call that it lost
ownership: that call gets a plain cancellation (#11386). Heartbeat reap and owner-disconnect releases also cut calls that reached the session through autolock.

### Plan label sessions

A multi-device plan runs each label other than its primary on a derived
`<base>:<label>` session that its allocation mints. That session lives only as
long as the plan run (#11572), whichever reason ended it:

- The next plan run under the same base mints the label again, also after the
  label's device was lost or killed mid-plan (a terminal release) and after a
  daemon restart.
- Nothing else does. A call that names a label session that is not live (a late
  call of the finished run, or a client naming `<base>:<label>` itself) is
  refused with `session_ownership_lost` and takes no device, where a base
  session released with `plan-auto-release` would be re-issued by name.
- The rule is applied where a session is created, so it covers every caller
  (#11602): while `<base>` is live, nothing but its plan's allocation creates a
  session named `<base>:<anything>`. A `setActiveDevice` or other bind naming
  one, with or without a connection identity and by the base's own owner too, is
  refused the same way, holds no device and leaves no fence, whether or not the
  base published that label.
- A session id that merely contains `:` is a session of its own when the part
  before the `:` is not a live session, and it stays one if that prefix is
  acquired as a session later. A plan never takes such a session as a label: an
  `executePlan` whose label would be a live session no plan run created is
  refused with `device_owned_by_other_session` before it publishes or allocates
  anything. Release that session or rename the label.
- It is never rehydrated after a daemon restart, whether its row was live,
  released by `daemon-shutdown` or waiting out a `device-restart:<device>`: its
  device is free at once. The `executePlan` the shutdown cut answers with its
  own result, `success: false` with `code: "daemon_shutting_down"` and
  `retryable: true` (steps may already have run, as `executedSteps` reports),
  and the caller runs the plan again. While the plan is still running in the
  same daemon, a label session waiting out a device restart is recovered like
  any other.

The daemon recognizes these rows by `device_sessions.source = 'plan-label'`.

#### The base's end ends its labels

A label session is usable only while its base is live (#11640). Once the base
has ended for a terminal reason, is being released for one, or is past its idle
deadline and not yet scanned, its labels admit no control or liveness request,
even from the base's owner, whatever the label's own idle window says. Holder
lookups still see the label until its own release starts:
its device stays held until the release cascade frees it.

- A control call naming the label (a tool call, an `input/*` frame for its
  device, a plan step) is refused with `session_ownership_lost`, `retryable:
  false` and `nextAction: "acquire_new_session"`, carrying the label's id and
  the base's release reason: the recorded one, or the one its expiry is about to
  record (`cleanup-expired`, or `heartbeat-timeout` when the owner's lease lapsed).
  The lookup and sweep record the same idle reason. `lazy-expiry` is no longer
  produced; older daemon rows and wire answers may still carry it and mean the
  same idle end. Legacy values are not rewritten.
  A heartbeat or liveness claim for the label is answered "session not found"
  with that same reason, and claims nothing.
- A read naming the label is never refused. It is answered without a session,
  as a read on any session past its idle deadline is.
- Deciding this releases nothing: it is a read of the base's state, and a
  lookup about a label still never releases its base. A refused control call is
  not a lookup. It names a session of the ended plan, so it ends the base the
  way a call naming the base does, through the base's lazy expiry, and the
  base's release takes every label with it at once rather than at the next
  scan. A refused read releases nothing and leaves that to the scan.
- A base whose owner's heartbeat lease lapsed and that the monitor has not
  scanned yet answers a control call on its label as it answers one on itself:
  the base is released with `heartbeat-timeout` and the call gets that terminal
  refusal, unless a control call still in flight keeps the base, in which case
  the call gets the retryable `daemon_session_suspect` naming the base.
- Ending the base ends every live label with the base's own reason (explicit
  release, idle expiry, heartbeat lapse, owner disconnect, device loss): each
  label's release is announced under the label's id with that reason, a call
  still running under the label is cut with `session_ownership_lost` naming the
  label, and its device is freed once. A base released for a reason that leaves
  its UUID usable (`plan-auto-release`, a `daemon-shutdown` or
  `device-restart:<device>` handoff) releases its labels with
  `plan-auto-release`, as before.
- A plan whose step is refused because its base ended fails with that end, not
  with "label is not allocated": the `executePlan` result has `success: false`,
  `code: "session_ownership_lost"`, `retryable: false`, `nextAction:
  "acquire_new_session"` and `details.reason` set to the base's release reason,
  and its failed step's error names that reason. An unrelated step failure keeps
  its own error without those terminal fields. Building the result releases
  nothing.

How long a plan can run on its labels: a step on a label restarts only the
label's idle window, never the base's. The base's idle window is restarted by
the start and the end of the `executePlan` call, by each step that runs on the
plan's primary device, and by any other control call naming the base. What
keeps the base through a long run of label-only steps is the `executePlan` call
itself: a call in flight holds its session past the idle deadline until the
call's request deadline plus 10 seconds (30 minutes past the idle deadline for a
call with no deadline). So a plan runs on its labels for as long as its own
request deadline allows (at least 600 seconds for `executePlan`, at most 1800),
and its base idles out only if the plan is still running after that deadline
with no step on the primary device in the last idle window.

When two releases of one session race, a terminal reason replaces a
non-terminal one, and any other terminal reason replaces an idle one, so the
recorded reason is the most specific.

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
  `src/models/deviceSessionRecovery.ts`, #11098), with `idle: true` beside the
  release reason after an idle release. Acquire a new session with
  `getAndroid` or `getApple`; retrying the same UUID cannot succeed.
- A managed connection (a proxy launched with `--managed-slot-config`) never
  acquires devices, so after its execution's session is released it answers
  `managed_execution_ended` instead: `retryable: false`,
  `nextAction: "relaunch_execution"`, the release `reason`, `idle: true` after an idle release,
  and the slot's `slotIndex` and `assignmentGeneration`. It names no recovery tools; the
  runner decides whether to relaunch the execution (#11341).
- Booted-device discovery that did not complete (adb or simctl failed, or a
  running emulator's AVD identity has not resolved) is refused with the retryable
  code `discovery_incomplete` instead of booting or adopting a device blind. Retry
  the acquisition. `setActiveDevice` answers it for a device it cannot find only
  when the discovery that could have listed that device failed, and names that
  platform: an iOS UDID while simctl failed is iOS discovery, and an id whose
  shape names no platform takes whichever discovery failed. If only the other
  platform's discovery failed, the device is reported as not found (#11586).

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

For direct `input/*`, device-mutating `ide/*` frames and device-aware control tools,
an Android transport the pool cannot identify (`isAndroidTransportAssignable` is false) is refused only
while a held Android device could be its alias. Held devices are every
Android device still in the session holder map, including expired sessions and
releases in progress until their ownership is removed, plus one unknown hold if
the fresh managed-slot snapshot contains Android stable ids not represented by
those sessions. Control frames and tools reuse that snapshot for at most one second.

The pool can positively distinguish the target from a held device only when its
current folded alias group identifies another canonical device, its proven
physical serial differs from a held USB serial or physical alias group, or its
loopback adb port identifies a different emulator console. An emulator proven by
its current connection's probe is also told apart from a held physical phone
(a USB serial or physical alias group), without becoming assignable. Matching physical
serials or alias-group keys still could alias. A loopback port cannot distinguish
a phone or an unknown device; an unknown managed-slot hold could alias unless
the target's current folded group identifies another device.

If no held device could alias the transport, control is allowed. If every
possible alias belongs to the requester's own session (including derived label
sessions), control keeps the untyped “no proven identity” refusal. Otherwise
it fails with `device_owned_by_other_session` and `retryable: false`, naming the
transport the caller targeted; an unknown managed-slot hold uses
`device_assigned_to_managed_slot` when its registry entry is available. Address
the device by its USB serial or `emulator-NNNN` id. Refusal sends nothing and does
not restart a holder's idle window. A target already held under its very id goes
through the normal holder check. Identifiable Android targets and iOS targets
keep their existing behavior; screenshot, hierarchy and observe reads never
pass this control check. A managed connection still controls only its own slot
devices; the existing connection and ownership checks still apply.

A tool call may name such a device by either endpoint (#11618). The `deviceId` is
resolved to the pool's one id for the device before any ownership, managed-slot
or routing check, so a call naming the Wi-Fi id of a held handset is refused or
admitted exactly as one naming its USB serial, runs on the same per-device queue,
and the tool sees the pool's id. The same holds for an emulator's loopback adb
address (`localhost:5555` for `emulator-5554`), and for every tool that takes a
device id on every path: `setActiveDevice`, `killDevice`'s `device.deviceId`, a
`getAndroid`, `getApple` or `startDevice` `deviceId`, plan steps, and a client
that calls the daemon's MCP endpoint directly. A wireless id a read or control
call names before the pool has seen it is identified first (one adb probe, not repeated per
call). The probe only reads discovery and identity and updates the pool fold; it
never readies the device. Already folded aliases need no probe.

A failed `adb devices` listing is never read as "no such device". If the listing
fails while the pool tracks an Android device, a control call naming a wireless
or TCP address the pool has not seen is refused with the retryable
`discovery_incomplete`: the address may be a second route to a device a session
holds. Nothing is sent and the refusal is not use; the next call asks adb again.
The holder is not affected: a call naming the device by the id `listDevices`
reports never depends on that listing, and reads still answer. A machine whose
pool tracks no Android device is refused nothing.

An Android transport the pool cannot identify at all (a wireless phone
reporting a generic serial, an emulator on a non-loopback `adb connect` address)
uses the same could-alias-a-held-device rule for device-aware control tools and
direct frames. A sessionless read that could alias a held device stays on the
read-only path without readiness; a proven alias reads the canonical device,
and an unproven or unplaced transport reads the id as sent. Reads never refuse
identity or ownership and never hold, bind or extend a session.

## Daemon restart

The restarted daemon stamps itself as owner of every session it rehydrates (#11114),
so a later peer daemon does not mistake them for a dead predecessor's. Each
rehydrated session's idle window starts together with its owner-reconnect window
(#11404), so it cannot expire before its owner can reconnect; a session already
past its deadline at restart is not rehydrated. At the start of recovery the
device of every persisted session is reserved, so no other caller takes it while
rows are recovered one by one. A reservation is released when its row fails to
recover, or when the 15 s recovery deadline passes with the row unstarted (#11372).
A managed slot wins over a reservation: a reservation never blocks a slot that
takes the device. A session lost to identity loss at restart is answered as
`session_ownership_lost` (see the reasons table). A release whose database write had not landed is
recorded first in a crash-safe sidecar (`terminal-release-intents.jsonl` in the
daemon data directory, `src/daemon/terminalReleaseJournal.ts`), and the restarted
daemon finishes it before rehydrating, so a released UUID is never revived.

A device-restart handoff reserves the recorded platform and stable device identity for
its session throughout the recovery window, even while the device is absent and no
call is waiting. Other sessions' start selectors skip both its stopped image and its
running device. An exact start by `avdName`, `deviceId`, or iOS UDID is refused before
boot or preparation, with a retry hint for the remaining hold; it does not stop a
running reserved device. A `startDevice.name` substring selector skips reserved targets
owned by other sessions; its owner resumes only when the selected device is that target.
Binding rechecks the reservation if it changed during startup.
The reserving session's own start can boot the device and resume the same session UUID.
Ownership comes from its routing session (including labels resolved through live base
state) or the MCP connection that owned it at handoff, including a later connection of
the same client once it proves the session's liveness owner token (a stdio proxy reconnects
after the handoff). Naming the session UUID alone is not proof. An anonymous or one-shot CLI
caller without that routing session cannot claim the hold. Reads remain available.
The hold ends on successful recovery, any terminal session
release, the three-minute window ending, or daemon shutdown. When the fixed 180 s
window lapses without a resume or an in-flight recovery call, the session ends terminally
with `restart-recovery-timeout`, even if its idle deadline is later. Heartbeat and
`daemon/sessionInfo` answer `daemon_session_not_found` with that `releaseReason` and no
`idle`. An earlier idle deadline ends the hold as `expired` with `idle: true`; the first
deadline determines the reason even if the daemon was down through both deadlines.
Tool activity extends only the idle deadline;
the hold never outlasts the fixed three-minute window from device loss. A call in flight
can retain the hold only within that window. An owner's `killDevice` or `deleteDevice`
drops the device-restart hold after a confirmed stop (including an already-stopped outcome),
or after successfully destroying a stopped image. The session remains resumable. Ownership
comes from the routing session, including labels resolved through live base state, or the
connection that owned the session at handoff. Naming the holder from another recorded
connection is refused even with `force: true`; the existing session-only rule applies when
no connection identity or owner snapshot is available.

Stop protection and sessionless completion match restart reservations by daemon-confirmed identity (the runtime AVD name or iOS UDID); a caller-supplied name is never trusted. `force: true` never skips this confirmation. If identity cannot be confirmed and the target might be reserved (its serial or supplied label matches a restart hold), the stop returns retryable `discovery_incomplete` without touching the device or reservation, except for the owner acting on its own hold.
A different session's stop or destroy is refused with `device_owned_by_other_session`,
`retryable: true` and `retryAfterMs` equal to the remaining recovery hold. `force: true` does
not override it. A label whose handed-off base no longer has live label state counts as a
different session. A connection holding another live device session also counts as a
different session, even when the call carries no routing session.

A sessionless caller, including a CLI call or an MCP connection that holds no device session
and names none, may stop or destroy the reserved device. Once confirmed, the reservation
ends and its waiting session ends terminally with `device-killed`; heartbeat and
`daemon/sessionInfo` report that release reason, and calls naming the session receive
`session_ownership_lost`. The terminal row write is awaited and conditional on the handoff's
generation and daemon owner. If persistence fails or the row has moved on, the stop succeeds,
a warning is logged and the captured hold is dropped without overwriting the newer row.
Failed, cancelled or unconfirmed stops retain the hold, timer, deadline and persisted row.

An owner's stop ends only the device-restart source; the daemon-restart batch releases its
own source independently. A terminal release, including a sessionless confirmed stop or
`restart-recovery-timeout`, ends both sources. Managed slots still
win, and the reservation does not extend the owner's heartbeat lease. A wiped or
re-imaged device returning under the same AVD name or UDID remains an identity gap.

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
  in the call arguments; while the acquiring connection is still connected, that
  works for reads only (see [What is refused](#what-is-refused)).
- **A connection's default session:** only `setActiveDevice` or an acquisition
  (`getAndroid`, `getApple`, `startDevice`) changes the session a connection's
  untargeted calls run on. An explicit `sessionUuid` targets that one call: the
  next call without one still runs on the default (#11347). A connection that has
  no default yet adopts the first session it names. A call passing only `platform`
  matching the default session's device runs on the default when no other session
  the connection still holds has that platform or an unknown platform. `deviceId`
  names the target device; a `platform` other than the default's does not use the
  default.
- **`scripts/mcp-drive.ts`:** a `getAndroid`/`getApple` step captures the session
  and injects it into later steps; `--session <uuid>` reuses an existing one.
  For persistent proxy executions, raw frames and observer sockets, use the
  [manual-test harness](manual-test-harness.md).
- **Scripts that run `--cli` calls:** keep the acquiring call's `sessionUuid` and
  pass `--session-uuid` on every later call (see
  `scripts/android/navigation-graph-sdk-event-integration.sh`).

If an agent holds two sessions and its default session ends, a control call
that passes the surviving session's `sessionUuid` or `deviceId` runs on that
session and does not change the default. A control call with only `platform`,
a `deviceId` that no surviving session holds (or that the proxy cannot match to
exactly one surviving session), or no selector is refused with
`no_active_device_session`, `nextAction: "acquire_new_session"` and the release
reason (`idle: true` beside it after an idle release). To continue without naming
the surviving session or its device each time, call `setActiveDevice` for that device or acquire a new session with
`getAndroid` or `getApple`.

## Stopping a held device: `killDevice` and `deleteDevice`

Both use the same ownership policy for stop and destroy, including stopped reserved images. For a live-held device, only the holder (or the
MCP connection that owns an autolocked device) may stop it. A booted device
another session holds is refused with `device_owned_by_other_session` unless the
call passes `force: true`, which overrides the refusal and logs a warning naming
the holder. From the CLI: `auto-mobile --cli killDevice --device '{...}' --force true`.

Naming the holder's `sessionUuid` makes a call the holder's only for the
connection that owns that session, or once that owner has disconnected. From any
other connection the call is refused, with or without `force` (#11542): to
force-stop the device, leave `sessionUuid` out. The refusal of a call that
carried `force: true` says so (#11555).

A device another live AutoMobile daemon holds (two daemons sharing one adb server
or simulator set) is refused the same way, with `device_owned_by_other_daemon`:
stop it through the daemon that holds it, wait for that daemon to release it, or
pass `force: true`. While a stop runs, the stopping daemon claims the device, so
the other daemon cannot bind it mid-kill.

`force` keeps its older meaning too: for a wedged Android emulator it also skips
the AVD-name comparison. Use it only when the device really should be stopped
out from under its holder. Deleting a stopped reserved image follows the reservation
policy below. A refused `deleteDevice` carries the same typed fields as a
refused `killDevice` (`code`, `retryable` and the rest of the refusal's evidence,
#11419).

| Device state                       | owner                                                                                                                                                             | different session                                                                                                                                                                                          | sessionless                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unheld, unreserved                 | n/a                                                                                                                                                               | stops                                                                                                                                                                                                      | stops                                                                                                                                                                      |
| Held by me (live)                  | stops; session released `device-killed`                                                                                                                           | n/a                                                                                                                                                                                                        | n/a                                                                                                                                                                        |
| Held by another live session       | n/a                                                                                                                                                               | refused `device_owned_by_other_session`, `retryable: false`; `force: true` stops and releases the holder `device-killed`. Naming the holder from a non-owning connection is refused with or without force. | refused `device_owned_by_other_session`, `retryable: false`; `force: true` stops and releases the holder `device-killed`                                                   |
| Reserved for me (restart recovery) | stops; confirmed stop drops the hold and keeps the session resumable. Naming R from a connection that did not own it at handoff is refused with or without force. | n/a                                                                                                                                                                                                        | n/a                                                                                                                                                                        |
| Reserved for another session R     | n/a                                                                                                                                                               | refused `device_owned_by_other_session`, message names R, `retryable: true`, `retryAfterMs` = remaining hold; force never overrides. Device, hold, timer and row stay untouched.                           | stops with or without force; confirmed stop or destroy drops R's reservation and ends R terminally `device-killed`. Failed, cancelled or unconfirmed stops change nothing. |
| Managed slot's device              | the slot's execution only                                                                                                                                         | refused `device_assigned_to_managed_slot`; force never overrides                                                                                                                                           | same refusal                                                                                                                                                               |

`force: true` overrides another live holder's refusal, but never the connection fence
on naming a holder, another session's restart reservation, or a managed slot assignment.
An unheld device and an owner's or sessionless caller's reserved-device stop need no force;
their outcomes are the same with or without it. Its separate Android identity escape
still skips the AVD-name comparison while retaining shutdown confirmation.

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
- A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
  A sessionless read that names a running device nobody holds may ready it in order to answer: on Android it may
  install the CtrlProxy APK, write the accessibility settings, and force-stop and rebind the service; on an iOS
  simulator it may install and launch the runner. The exception never applies to a device held, slot-assigned or
  reserved by another session: those reads use what is already installed and never run readiness.
  (Owner decision 2026-10-12, #11964.) It skips appearance sync, preference writes,
  and selecting or pinning the current device. The only settings it may write are
  the accessibility settings that enable CtrlProxy. A later control call still
  performs appearance sync and current-device selection or pinning.
- A sessionless read boots a stopped device only when the call explicitly passes
  its `deviceId` (owner decision 2026-10-11, follow-up to #11641). Every device-aware
  read tool, including `observe`, accepts a running device's serial or iOS UDID,
  or its exact AVD/simulator name. An exact device ID wins over a name; a name
  matching multiple running devices is ambiguous and lists their IDs. The requested
  platform, if supplied, limits the match. A stopped device is named only by its
  Android AVD name or available iOS simulator UDID, never by an emulator serial
  or stopped iOS simulator name. It boots only that image and never creates a
  simulator. Existing boot capacity and admission rules apply. Unknown IDs get
  the same not-found answer from every read tool. Ownership is checked on the ID
  as given before discovery, then again on a running match's serial/UDID after
  discovery, then again after image listing immediately before a read boot. If held or
  reserved for device-restart recovery, a running target uses the read-only path; a stopped
  reserved target answers retryable `device_owned_by_other_session`, even to its owner.
  A transient failure in read listing retries briefly, then answers retryable `discovery_incomplete`
  instead of not-found or readiness work (#11918).
- A read without `deviceId` uses an already-running device and never boots or
  creates one. A `platform` argument alone is not an explicit ID. A stopped
  device selected earlier with `setActiveDevice`, or cached as the current device,
  is not named by the call and cannot be booted by that read. A device named only
  by a session binding follows the existing session readiness path instead of
  the sessionless read path.
- If no suitable device is running, a read without `deviceId` answers that there
  is nothing to read: start one with `startDevice` or `provisionDevice`, or pass a
  `deviceId`. This is an ordinary actionable no-device error, not an ownership
  refusal. With `platform: "either"`, an unnamed read can give that answer when
  at least one platform's discovery completed. An explicit platform still needs
  its own completed scan. A named stopped device needs completed discovery on
  its platform; absent tooling on the other platform does not block that match.
  Incomplete discovery that prevents these decisions remains a retryable
  `discovery_incomplete` error. Control calls keep their existing device selection
  and boot behavior.
- Reads run in their own lane (#10969).
- A holder's calls that name only a `deviceId` are credited to the MCP connection
  that owns the held session, and admitted as that session. Other connections
  stay read-only watchers.

### Which read tools ready an unheld device

For a sessionless call naming an unheld running device whose service is not ready,
the **Yes/No** classifications refer to registry readiness: `ensureDeviceReady`
with `intent: "read"`. **Yes** means the platform manager performs CtrlProxy/runner
setup through that path. These are the exact sets pinned
by `test/server/readToolsExplicitDeviceIdRule.test.ts`: 18 of 21 tools on each platform.
The handlers are stubbed in that test; platform-specific feature support is separate
from target resolution and readiness.

| Tool                    | Android                                     | iOS simulator                               |
| ----------------------- | ------------------------------------------- | ------------------------------------------- |
| `accessibility`         | Yes                                         | Yes                                         |
| `clipboard`             | Yes                                         | Yes                                         |
| `displayConfig`         | Yes                                         | Yes                                         |
| `getAppPermissions`     | Yes                                         | Yes                                         |
| `getDataStore`          | Yes                                         | Yes                                         |
| `getDeepLinks`          | Yes                                         | Yes                                         |
| `getDeviceState`        | Yes                                         | Yes                                         |
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
| `observe`               | Own path: may start the service (see below) | Own path: may start the service (see below) |
| `prototype`             | Yes                                         | Yes                                         |
| `snapshotOf`            | Yes                                         | Yes                                         |
| `sqlQuery`              | Yes                                         | Yes                                         |

`listApps` and `inspectPackageSigning` declare `deviceReadiness: "booted"` and
verify the device without CtrlProxy/runner setup. `observe {deviceId}` bypasses
`ensureDeviceReady`; its own read path may start the hierarchy service on an
unheld, idle, pooled device through `ObservationReadServiceStart`, as described in
[Reading a device you do not own](../tools.md#reading-a-device-you-do-not-own-deviceid).

On Android, registry readiness for the 18 **Yes** tools uses
`DeviceSessionManager.ensureAndroidCtrlProxyReady`: `CtrlProxyManager.setup` may
install or upgrade the CtrlProxy APK, and `enable` writes
`enabled_accessibility_services` (preserving other services) and
`accessibility_enabled`. Setup/enable do not directly force-stop or rebind;
however, repeated connection failures on the singleton CtrlProxy client can
trigger recovery that removes CtrlProxy from `enabled_accessibility_services`,
force-stops its process, and re-adds it. `observe`'s own service start uses the
session acquisition setup through `RunnerReadinessService`: it may perform the
same APK installation and accessibility enablement, and its readiness recovery
explicitly calls `rebindIfUnhealthy` or `forceRestartProcess`. Those calls use
`CtrlProxyManager.rebindOrRestartInternal` to remove/re-add the service entry and
force-stop the process. On an iOS simulator, both registry readiness and
`observe`'s service start use `RunnerReadinessService` and `IOSCtrlProxyManager`
to install and launch the runner as needed via `xcodebuild test-without-building`.

Held, slot-assigned and restart-reserved running targets run neither registry
readiness nor observer service setup.

A physical iPhone is never readied by a sessionless read: automation readiness
throws without a session; booted-only verification does no runner setup.

## Streams need an observer registration, not a session

`subscribe`, `request_observation`, video and WebRTC viewing still require a
lightweight observer registration (owner decision 2026-10-09, #10982). An
observer registration is not a session: tools need nothing, and streams need only
that registration. A viewer keeps streaming when ownership changes (#8902).

## Recordings

Owner decisions 2026-10-09 (#10982):

- A recording stops and finalizes when its session is released, capped at about
  120 seconds (#10957). This also covers an idle release (#10826).
- Recording artifacts stay fetchable by id (#10958).
- Hiding a desktop or IDE window during a recording does not release the device.

A video start from the connection holding a device belongs to that holding session,
even when the call omits `sessionUuid`. Starting a device gesture recording on an unheld device
is refused with `no_active_device_session`; acquire a session on that device first.

An active recording with no owner keeps running when a session acquires its device:
the acquiring holder adopts it (owner decision 2026-10-11, #11665, replacing #10961).
Until acquisition it remains stoppable sessionless; afterwards only the holder or
the connection that acquired its session may stop it. This includes segmented video
and device gesture recordings. Release finalizes adopted recordings within the existing cap,
announces their recording ids, and keeps their artifacts fetchable by id (#10958).

An undelivered `setActiveDevice` rebind moves its existing session back to the device
it held (#11593, #11689). Keep-awake, biometric enrollment, network condition, clock,
rotation and screen-reader restores are deferred until delivery; undo cancels them and
retains their cache records. Network TTL deadlines and iOS per-app lease renewal survive
undo. The old device stays quarantined until undo holds it again or all delivered
restores settle. If undo cannot bind back, it restores the old device before releasing
quarantine and leaves the session and its replacement-device overrides on the replacement.

Deferral uses the existing 40-second session creation/release-finalization wait. An
orphaned receipt starts restores at that bound; a later rebind, session release, device
shutdown/removal or daemon cleanup drain also flushes them once. Callers without a
receipt restore inline. If undo arrives after restores started, it waits boundedly for
its cleanup before binding back and leaves reverted overrides absent from the cache.
If another session acquired the original device, the session stays on the replacement
and no further restore touches the other holder's device.

## Retryable acquisition refusals

An acquisition the daemon cannot grant yet is refused with a typed, retryable
code (owner decision 2026-10-09, #10982): `device_cleanup_in_progress` while the
device is still being released (#10960), and `device_owned_by_other_daemon` when
another daemon holds it. Clients may wait and retry.

An exact Android acquisition also waits up to 5 s when adb still lists its
transport as `offline` or `unauthorized` (#11713). If it stays transitional,
`device_offline` carries `retryable: true`, `deviceId`, and a 1 s `retryAfterMs`
hint. The refusal is retryable, and any existing pool entry is left untouched.

Each refusal carries a `retryAfterMs` hint. For `device_cleanup_in_progress` it
is the time the cleanup can still take (#11360): the rest of a release's bounded
teardown, or the rest of a recording finalize's cap (120 s plus a 5 s grace),
whether that finalize started at its session's release or when a session
acquired a device with an owner-less recording on it (#11616). Cleanup with no
cap of its own advertises a 1 s polling hint. `device_shutting_down` always
advertises 2 s: a shutdown reservation is held across several separately bounded
steps (stop, wait for the device to disappear, restart handoff) and records no
deadline of its own, so there is no remaining time to report. The test runners
wait `max(30 s, min(waited + retryAfterMs, 150 s))` in total, so a hint without a
bound gets their 30 s floor, which is one shutdown step's own timeout.
The MCP proxy (and the CLI through it) re-polls a `device_cleanup_in_progress`
bind on a short growing backoff within its 150 s wait budget, treating the hint
as an upper bound on each step so early cleanup is noticed on the next poll (#11900).

A `setActiveDevice` on a device another request is still preparing (booted or
picked, runner not ready, no session bound yet) is refused with
`device_owned_by_other_session`, `retryable: true` and `retryAfterMs: 2000`
(#11651, owner decision 2026-10-11). It clears when that request binds (then the
device is held and the same code is `retryable: false`) or fails. `retryAfterMs`
is a poll interval, not a bound: the reservation lasts through that request's
preparation and cleanup, which can be long when a failed boot's emulator cannot
be stopped. A second `startDevice`/`provisionDevice` for the same device waits on
the device's lifecycle lease instead. Reads (`listDevices`, observation) are
never refused.

A session UUID whose device is being killed is refused with
`session_terminal_release_in_progress`, `retryable: false` and `nextAction:
"acquire_new_session"` (#11189, #11231): the UUID ends with that release, so
retrying under it cannot succeed. Acquire the device again under a new session. A kill that races the session's own rebind is
refused with `session_rebinding` (`retryable: true`, with `retryAfterMs`), and a
kill naming a device the session has left with `session_no_longer_owns_device`
(`retryable: false`, no `nextAction`; check who holds the device before killing
it, a new session would not help).

## Device status in listings

`listDevices`, the `automobile:devices/booted` resources, `daemon/availableDevices`
(`--daemon available-devices`) and the pool stats report one status per device
(#11317, #11401). A device that allocation cannot lend is `assigned`, not
`idle`: that covers a device with a session, a reserved device (shutting down or
still becoming ready), a device held by a managed slot or by another daemon, and
an idle device carrying an unhealthy marker. A device in error stays `error`.
Every device is in exactly one bucket, so `idle + assigned + error` equals the
total. A per-platform booted resource (`automobile:devices/booted/ios`) counts
only that platform's devices (#11415).

## Boot capacity

Cold boots are admitted against host capacity (owner decision 2026-10-09,
#11181, #11209). Each
platform has its own limit on booted devices: the smaller of half the host RAM
divided by the measured per-device memory and half the CPU cores, at least 1.
Every booted emulator or simulator counts, including ones started outside
AutoMobile; on iOS, simulators that are Booting or Shutting Down count too
(#11318). If the booted count cannot be read (simctl or adb failed), the boot is
refused with the retryable `discovery_incomplete` instead of counting zero. A
failed `ps` read no longer lowers the iOS limit: the limit still derives from host
RAM and cores (#11396). A boot that would go over the limit is not queued: it fails at once
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

For assignment-based ownership (scoped device slots that outlive a session), see
[Managed device slots](managed-slots.md).
