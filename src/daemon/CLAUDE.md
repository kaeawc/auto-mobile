# Daemon Socket Servers

This directory contains Unix domain socket servers that communicate with IDE plugins and other clients.

## Socket Server Patterns

All socket servers MUST extend one of the base classes in `socketServer/`:

### Request-Response Pattern

For servers that handle discrete requests with responses:

```typescript
import { RequestResponseSocketServer } from "./socketServer/index";

class MySocketServer extends RequestResponseSocketServer<MyRequest, MyResponse> {
  protected async handleRequest(request: MyRequest): Promise<MyResponse> {
    // Handle request and return response
  }
}
```

**Examples:** `videoRecordingSocketServer`, `deviceSnapshotSocketServer`, `testRecordingSocketServer`, `appearanceSocketServer`, `performanceStreamSocketServer`, `failuresStreamSocketServer`

Requests are sequential per socket unless a subclass explicitly opts a safe control request out of the chain, such as WebRTC `stop` or appearance's read-only `get_appearance_config`.

### Push Subscription Pattern

For servers that maintain subscribers and push updates:

```typescript
import { PushSubscriptionSocketServer } from "./socketServer/index";

class MySocketServer extends PushSubscriptionSocketServer<MyFilter, MyPushData> {
  protected parseSubscriptionFilter(request: Record<string, unknown>): MyFilter {
    // Extract filter from subscription request
  }

  protected matchesFilter(filter: MyFilter, data: MyPushData): boolean {
    // Return true if data should be sent to this subscriber
  }

  protected createPushMessage(data: MyPushData): unknown {
    // Create the push message to send
  }

  // Call this to push data to subscribers:
  // this.pushToSubscribers(data);
}
```

**Examples:** `performancePushSocketServer`, `deviceDataStreamSocketServer`

`parseSubscriptionFilter` MUST validate wire values rather than casting them. JSON
parsing does no runtime checking, so a bare `(request.x as string) ?? null` lets a
blank or non-string key become a filter that matches nothing while the subscribe
call still acks `success: true` — an inert subscription the client cannot detect
(#6676). Use the base class's `parseDeviceSessionUuid()` for the shared
`deviceSessionUuid` key; a throw from `parseSubscriptionFilter` is answered with
the standard `{ type: "error", success: false, error }` envelope and no
subscription is created.

## Key Benefits of Base Classes

1. **Timer injection** - Use `this.timer` for testable time-dependent code (via `FakeTimer` in tests)
2. **Consistent line protocol** - JSON-over-newline handled automatically
3. **Keepalive handling** - Automatic ping/pong and dead subscriber cleanup (push servers)
4. **Socket lifecycle** - Start/stop/cleanup managed consistently
5. **Reduced duplication** - ~200 lines saved per server

## Adding a New Socket Server

1. Determine the pattern: request-response or push subscription
2. Extend the appropriate base class
3. Implement the required abstract methods
4. Use `getSocketPath()` with `SocketServerConfig` for consistent path handling
5. Add singleton management functions (`getXxxServer`, `startXxxSocketServer`, `stopXxxSocketServer`)

## Testing

Use `FakeTimer` from `test/fakes/FakeTimer.ts` to control time in tests:

```typescript
const fakeTimer = new FakeTimer();
const server = new MySocketServer(socketPath, fakeTimer);
// Advance time without waiting
fakeTimer.advance(10000);
```

## Outbound write bound

RPC sockets cap the bytes queued BEHIND the frame at the head of the outbound
queue at 16 MiB (`src/daemon/outboundWriteGuard.ts`); the head frame is never
counted while it drains, so a response over 1 MiB (a base64 screenshot) does not
make the next heartbeat reply or notification destroy a reading client. A frame
onto an empty queue is always admitted; a write that would push the bytes behind
the head over the cap is rejected. The bound is bytes-only: bytes measure memory.
Rejection calls `onFlushed` once with `DaemonSocketQueueOverflowError`
(`reason: "queue_overflow"`, `queuedBytes`, `limitBytes`), then destroys the
socket. A stall watchdog on the injected timer (armed above 1 MiB queued) destroys
a reader whose queue freed no bytes for 60 s, logging the reason; progress is seen
per completed frame, so it must outlast one large frame's drain. Once a write
returns false, inbound data, `drain`, or a successful write callback leaving
`writableLength` zero refreshes idle; write calls do not.

## Device health marker

Biometric/network restoration abandoned after bounded retries sets a device health marker; clock restoration sets it on its first failed attempt. Successful restoration/background recovery, device removal, or an incarnation change clears it. Idle selection skips marked devices, and exact-id requests refuse them with an actionable error naming the device and reason; pool status surfaces optional `unhealthy`. There is no automatic erase/reboot: the owner decides whether to use `killDevice`/`startDevice`. Markers do not persist across daemon restart and dirty state is not re-detected.

The `app-cleanup` reason is set by `executePlan` when a plan's `cleanupAppId` cleanup (terminate / clear data / physical-iOS reinstall) did not complete on a device (`markDeviceNeedsAppCleanup`). Recovery re-runs the cleanup three times (1s/2s/4s backoff) once the device is idle; each retry gets its own deadline (`PLAN_APP_CLEANUP_RETRY_DEADLINE_MS`, the cleanup's 20s cap plus a margin), not the 1s a settings restore gets. A cleanup that can never succeed (for example `pm clear` always refused) has no automatic exit: after the third attempt the marker is held for the device's incarnation, by design. The allocation error then names `app-cleanup` and the exact recovery: `killDevice` with the device's `{ name, deviceId, platform }`, then `startDevice`. A timed-out retry is never overlapped by another.

## Registration-only sessions

`daemon/registerSession { sessionId, clientName }` validates a client UUID and a
non-blank client name (128-character caps). It returns the usual success envelope
with `{ accepted, heartbeatTimeoutMs, expiresAtMs }`, or `success: false, error`
with an actionable quota message. It stays on the per-socket request queue;
`daemon/heartbeat` retains its existing out-of-band dispatch.
Registration waits up to the shared 5,000ms release drain timeout for an in-flight
release of that UUID to settle, then rechecks whether to accept the device session
or register an observer. If release is still in progress, it returns a typed failure
asking the client to retry registration; unrelated UUIDs do not wait for that release.

`ObserverSessionRegistry` is a separate in-memory registry, never a `Session`
and never persisted. Defaults pending owner confirmation: cap 32
(`MAX_OBSERVER_SESSIONS`), the default heartbeat timeout plus the suspect grace
(8 seconds; the timeout keeps its environment override). `canObserveDevice`
(`observerMaySeeDeviceOwner`, unowned devices only) is not consulted by any socket
path; watching follows the read-only viewer grant below. Every registry operation lazily purges expiry using
the injected Timer; there are no background timers. `dispose()` closes and clears
it. Registration is idempotent and refreshes TTL; expired entries free quota.
Heartbeat and release consult it only when no device session exists, without
assigning or releasing a pool device. Device-session publication removes the
observer entry synchronously before publishing, including rehydration. Releasing
that device session does not restore an observer entry. Device-tool admission
continues to consult SessionManager alone.

Read-only viewer grant (#10698): a registered observer, like any live device
session, may watch any device through video relay subscribe and WebRTC start, as
a read-only viewer. The grant does not depend on holding an unrelated device.
The observation socket's on-demand reads (`request_observation`,
`request_navigation_graph`, `subscribe_storage`/`unsubscribe_storage`) take the
same grant (#10830), matching its passive `subscribe`, which is not device-scoped
at all; they still require a live identity. `input/*` follows ownership instead: a held device
takes input only from a frame whose `sessionUuid` names its holder (typed code
`device_owned_by_other_session`); an unowned device takes input from anyone.
Device-aware `tools/call` follows the same rule (`assertToolCallerHoldsDevice` in
`src/server/toolRegistry.ts`): on a held device, a call from another session or
with no session is refused with the same code before admission or device work,
unless the tool is registered `deviceReadOnly` (watching). A call
without a deviceId is checked against the device readiness would select (the
`setActiveDevice` pin, the current device, or the only candidate) before
`ensureDeviceReady` runs, so a refused call never readies, pins or configures the
holder's device (#10828). A sessionless `deviceReadOnly` call whose target (its
deviceId, or that predicted device) is held runs on the read-only device path
instead (#10830): the device is resolved from the booted list
(`sessionlessDeviceReadFor`), with no readiness, current-device pin, settings,
navigation recording or audit, and handlers see `isSessionlessDeviceRead()`
(observe and snapshotOf then use the observer capture, connect-only on a held
device). The observation socket's `request_observation` follows the same rule: a requester
whose session does not hold a held device gets that connect-only observer read, never the
session observe pipeline's service rebind or CtrlProxy setup (#10967). Socket-forwarded
tools/calls serialize per `device:<id>`; a `deviceReadOnly` call from a caller that does not
hold a held device runs on that device's read lane (`device:<id>:read`) instead, so a watcher
never waits behind the holder's in-flight control call (#10969). Reads serialize among
themselves; control calls, the holder's own reads and reads of a free device (which may run
readiness) stay on the control lane.
A `deviceReadOnly` call whose `sessionUuid` names no device session this
daemon issued (the IDE injects its observer session UUID into every call) is
handled as sessionless rather than refused as unissued (#10968). Read-only tools
(owner decisions 2026-10-09, #10965: anything that changes visible UI or starts a
device-side process is control; read-only access never requires a session):
`observe`, `snapshotOf`, `hitTest`, `identifyInteractions`, `listApps`,
`getDeviceState`, `getNetworkGraph`, `getPreference`, `listDataStores`,
`getDataStore`, `getAppPermissions`, `getNotificationPolicy`, `getDeepLinks`,
`getNavigationGraph`; per call, `keyboard` detect/listImes/listProfiles,
`clipboard` get, `displayConfig` with no set field, `accessibility` with no
toggle, `prototype` status/inspect, and `sqlQuery` when `isReadOnlySqlQuery`
accepts the statement (a write, or anything the classifier cannot prove
read-only, needs the holder). The classifier lexes the query first
(`src/features/database/sqlLexer.ts`), so a `)` or `;` inside a string literal,
quoted identifier or comment cannot end a CTE or a statement (#10966).
`systemTray`, `videoRecording` and `deviceSnapshot` stay control. On the
read-only device path `hitTest` and `identifyInteractions` read through the
observer capture (`executeDeviceRead`), not the holder's session pipeline or
cache. `test/lint/toolReadControlClassification.test.ts` enumerates every
registered device-aware tool against its declared classification. An autolocked device keeps autolock's
own refusal. Plain lifecycle tools that stop a running device (`killDevice`, and
`deleteDevice` on a booted target) never reach that resolver, so they apply the
same code through `assertLifecycleCallerHoldsDevice`
(`src/server/lifecycleDeviceOwnership.ts`); the autolocking MCP connection counts
as the holder, and the user's `force: true` overrides with a logged warning.
Acquisition (`getAndroid`, `getApple`, `startDevice` on a running device) is
guarded by the pool's own owner check instead.

Owner decisions 2026-10-08 (#10730) settle the viewing question: watching is
allowed on any device, whichever session owns it, and watching is not use.
Owner decision 2026-10-09 (#10964) extends that to the owner: no read counts as
activity. A `deviceReadOnly` call naming a live session is admitted with
`access: "read-only"` (no refresh, no `markSessionAdmitted`), so only control
calls move `lastUsedAt`/`expiresAt`.
Desktop input is use. The desktop and IDE clients register an observer session
that allocates nothing, allocate a device with `setActiveDevice` on the first
`input/*` to it, and send input under that session, so each input restarts the
idle window. After an idle release, a daemon restart, or an expiry, the client
rotates to a fresh observer session and does not re-send the bind; the next
input allocates the device again. `test/fixtures/desktop-wire/` records these
exchanges against the real handlers.

Viewer stream rule (owner decision 2026-10-09, #8902): a video-relay or WebRTC/WHEP
subscription keeps streaming when device ownership changes (another session acquires,
releases, or idle-releases the device). An owner subscription whose session lost the
device is downgraded to a read-only viewer; viewers are never revoked by an ownership
change. Only input requires ownership. A stream ends only when its own subscribing
identity ends (`session_ended`), the viewer disconnects, or the device goes away
(`device_removed`, `device_restored`, `identity_quarantined`, `daemon_shutdown`), each
delivered as a typed reason, and the shared capture (including the shared iOS capture)
keeps running for the remaining subscribers. Recordings are a separate concern and stop
on release. Policy lives in `src/daemon/streamSubscriptionPolicy.ts`; tests in
`test/daemon/*StreamSocketServer.viewerSubscription.test.ts`.

Observer scope and cooperative ownership (owner decisions 2026-10-09, #10982):
streams (`subscribe`, `request_observation`, video and WebRTC viewing) keep
requiring the lightweight observer registration above, which is never a session;
tools need nothing for read-only work. Ownership is a cooperative guard, not a
local security boundary: `daemon/activeSessions` (`includeSessions`),
`daemon/releaseSession` and `ide/setSessionToolEnabled` take no requester check on
purpose, and no token gating is to be added. Reads are not activity, not even the
owner's (#10964); a read on a held device is connect-only, on its own lane (#10969).
A recording stops and finalizes on its session's release, capped near 120 s (#10957),
and an owner-less one stops on acquisition (#10961). Acquisition refusals that can
clear on their own are typed and retryable: `device_cleanup_in_progress` (#10960)
`device_owned_by_other_daemon`, and `device_shutting_down` (#11088). A session UUID
under a kill's terminal release is refused as `session_terminal_release_in_progress`
with `retryable: false` (#11189). See `docs/using/device-ownership.md`.

Open owner question: is non-persistence acceptable? Clients must register again
after daemon restart. (Resolved question: watching is allowed on any device and
control stays with the owner, per the 2026-10-08 decision above; the viewer grant
and the `input/*` ownership check above implement it.)

The follow-up enforcement lane must make stream authentication consult
`resolveObserverScope`, enforce it on observation-stream/push sockets, rebase on
PR #8649's `onSubscribed` hook, and re-verify per-device scoping with coalesced
fan-out. Desktop startup must call `registerSession` with a null device binding
and re-register on heartbeat failure. This prerequisite wires neither stream
enforcement nor desktop composition.

## Daemon namespace ownership

Lifecycle ownership requires positive evidence for the configured namespace: a live PID with matching generation in its PID record, an argv socket marker, or the daemon answering on that socket. Unmarked processes from the machine-wide process table are never presumed to belong to this namespace. Revalidate both ownership and generation before every signal, including SIGKILL; a live PID missing from the scan is inconclusive, and must be authenticated through the namespace socket or rejected without signalling. Never signal a PID not verified as this namespace's.

Tests must stub process discovery through the `DaemonProcessFinder` constructor seam, never by spying on `findAllDaemonProcesses`/`findLiveDaemonProcesses`; lifecycle discovery does not route through those methods.

## Session lifetime summary

User-facing statement of the release model (lease and grace, exact idle release,
`idleReleaseAt` wall clock, one-shot CLI anonymity, terminal-session refusals,
offline budget, restart recovery): `docs/using/device-ownership.md`. Change it in
the same PR as any constant in `src/daemon/sessionLivenessWindows.ts` or
`OFFLINE_DEVICE_DISCONNECT_BUDGET_MS`.
